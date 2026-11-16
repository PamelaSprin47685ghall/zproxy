namespace ZProxy.Tests

open System
open System.IO
open System.Threading
open System.Threading.Tasks
open Xunit
open ZProxy

module FlowTests =
    let private read (body: Stream) count = task {
        let bytes = Array.zeroCreate<byte> count
        let! received = body.ReadAsync(bytes.AsMemory())
        return received, bytes.AsSpan(0, received).ToArray()
    }

    [<Fact>]
    let ``Credit follows consumed bytes and is combined at half a window`` () = task {
        let credits = ResizeArray<int>()
        use body = new Flow.ReceiveBody(8, credits.Add, ignore)
        do! body.AcceptAsync([| 1uy .. 8uy |])
        Assert.Empty(credits)

        for expected in 1uy .. 3uy do
            let! count, bytes = read body 1
            Assert.Equal(1, count)
            Assert.Equal(expected, bytes.[0])
            Assert.Empty(credits)

        let! count, bytes = read body 1
        Assert.Equal(1, count)
        Assert.Equal(4uy, bytes.[0])
        Assert.Equal<int>([| 4 |], credits)
        let! count, bytes = read body 4
        Assert.Equal(4, count)
        Assert.Equal<byte>([| 5uy .. 8uy |], bytes)
        Assert.Equal<int>([| 4; 4 |], credits)
    }

    [<Fact>]
    let ``Credit counts actual consumption across frame boundaries`` () = task {
        let credits = ResizeArray<int>()
        use body = new Flow.ReceiveBody(8, credits.Add, ignore)

        for value in 1uy .. 8uy do
            do! body.AcceptAsync([| value |])

        let! first, _ = read body 3
        Assert.Equal(3, first)
        Assert.Empty(credits)
        let! second, _ = read body 2
        Assert.Equal(2, second)
        Assert.Equal<int>([| 5 |], credits)
        do! body.AcceptAsync([| 9uy .. 13uy |])
        let! count, bytes = read body 8
        Assert.Equal(8, count)
        Assert.Equal<byte>([| 6uy .. 13uy |], bytes)
        Assert.Equal<int>([| 5; 8 |], credits)
    }

    [<Fact>]
    let ``Unsent credit does not extend the peer receive budget`` () = task {
        let credits = ResizeArray<int>()
        use body = new Flow.ReceiveBody(8, credits.Add, ignore)
        do! body.AcceptAsync(Array.zeroCreate 8)
        let! _ = read body 3
        let! _ = Assert.ThrowsAsync<InvalidDataException>(fun () -> body.AcceptAsync([| 1uy |]) :> Task)
        Assert.Empty(credits)
        let! _ = read body 1
        Assert.Equal<int>([| 4 |], credits)
        do! body.AcceptAsync(Array.zeroCreate 4)
        let! _ = Assert.ThrowsAsync<InvalidDataException>(fun () -> body.AcceptAsync([| 1uy |]) :> Task)
        return ()
    }

    [<Fact>]
    let ``A sender waits until enough byte credit is returned`` () = task {
        let window = Flow.SendWindow(8)
        do! window.TakeAsync(8, CancellationToken.None)
        let waiting = window.TakeAsync(4, CancellationToken.None)
        Assert.False(waiting.IsCompleted)
        window.Add(3)
        Assert.False(waiting.IsCompleted)
        window.Add(1)
        do! waiting.WaitAsync(TimeSpan.FromSeconds(5.0))
        window.Add(8)
        Assert.Throws<InvalidDataException>(fun () -> window.Add(1)) |> ignore
    }

    [<Fact>]
    let ``Partial reservations use available credit and wait only at zero`` () = task {
        let window = Flow.SendWindow(8)
        do! window.TakeAsync(1, CancellationToken.None)
        let! first = window.TakeUpToAsync(8, CancellationToken.None)
        Assert.Equal(7, first)
        let waiting = window.TakeUpToAsync(8, CancellationToken.None)
        Assert.False(waiting.IsCompleted)
        window.Add(3)
        let! second = waiting.WaitAsync(TimeSpan.FromSeconds(5.0))
        Assert.Equal(3, second)
        window.Add(8)
        let! bounded = window.TakeUpToAsync(16, CancellationToken.None)
        Assert.Equal(8, bounded)
    }

    [<Fact>]
    let ``A one byte prefix cannot stall the next full frame`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5.0))
        let ct = timeout.Token
        let capacity = 16384
        let window = Flow.SendWindow(capacity)
        let credits = ResizeArray<int>()
        use body = new Flow.ReceiveBody(capacity, (fun count -> credits.Add(count); window.Add(count)), ignore)
        do! window.TakeAsync(1, ct)
        do! body.AcceptAsync([| 255uy |])
        let! prefix, bytes = read body 1
        Assert.Equal(1, prefix)
        Assert.Equal(255uy, bytes.[0])
        Assert.Empty(credits)

        let payload = Array.init capacity (fun index -> byte (index % 251))
        let firstPart = TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously)
        let sending = task {
            let mutable offset = 0
            while offset < payload.Length do
                let! count = window.TakeUpToAsync(payload.Length - offset, ct)
                do! body.AcceptAsync(payload.AsSpan(offset, count).ToArray())
                if offset = 0 then firstPart.SetResult(count)
                offset <- offset + count
        }

        let! firstCount = firstPart.Task.WaitAsync(ct)
        Assert.Equal(capacity - 1, firstCount)
        Assert.False(sending.IsCompleted)
        let buffer = Array.zeroCreate<byte> capacity
        let! received = body.ReadAsync(buffer.AsMemory(), ct)
        Assert.Equal(capacity - 1, received)
        Assert.Equal<byte>(payload.AsSpan(0, received).ToArray(), buffer.AsSpan(0, received).ToArray())
        Assert.Equal<int>([| capacity |], credits)
        do! sending.WaitAsync(ct)
        let! last = body.ReadAsync(buffer.AsMemory(0, 1), ct)
        Assert.Equal(1, last)
        Assert.Equal(payload.[capacity - 1], buffer.[0])
    }

    [<Fact>]
    let ``Partial credit waiters also wake on cancellation and failure`` () = task {
        let window = Flow.SendWindow(8)
        do! window.TakeAsync(8, CancellationToken.None)
        use canceled = new CancellationTokenSource()
        let waiting = window.TakeUpToAsync(8, canceled.Token)
        canceled.Cancel()
        let! _ = Assert.ThrowsAnyAsync<OperationCanceledException>(fun () -> waiting :> Task)
        let failed = window.TakeUpToAsync(8, CancellationToken.None)
        let error = IOException("The stream closed.")
        window.Fail(error)
        let! actual = Assert.ThrowsAsync<IOException>(fun () -> failed :> Task)
        Assert.Same(error, actual)
    }

    [<Fact>]
    let ``One exhausted stream does not block another stream`` () = task {
        let slowWindow = Flow.SendWindow(8)
        let fastWindow = Flow.SendWindow(8)
        use slowBody = new Flow.ReceiveBody(8, slowWindow.Add, ignore)
        use fastBody = new Flow.ReceiveBody(8, fastWindow.Add, ignore)
        do! slowWindow.TakeAsync(8, CancellationToken.None)
        do! slowBody.AcceptAsync(Array.zeroCreate 8)
        let blocked = slowWindow.TakeAsync(4, CancellationToken.None)
        do! fastWindow.TakeAsync(8, CancellationToken.None)
        do! fastBody.AcceptAsync([| 1uy .. 8uy |])
        let! count, _ = read fastBody 8
        Assert.Equal(8, count)
        do! fastWindow.TakeAsync(8, CancellationToken.None)
        Assert.False(blocked.IsCompleted)
        slowWindow.Fail(OperationCanceledException())
        let! _ = Assert.ThrowsAnyAsync<OperationCanceledException>(fun () -> blocked :> Task)
        return ()
    }

    [<Fact>]
    let ``Canceled credit waiters do not consume future credit`` () = task {
        let window = Flow.SendWindow(8)
        do! window.TakeAsync(8, CancellationToken.None)
        use canceled = new CancellationTokenSource()
        let waiting = window.TakeAsync(4, canceled.Token)
        Assert.False(waiting.IsCompleted)
        canceled.Cancel()
        let! _ = Assert.ThrowsAnyAsync<OperationCanceledException>(fun () -> waiting :> Task)
        window.Add(8)
        do! window.TakeAsync(8, CancellationToken.None)
    }

    [<Fact>]
    let ``Closing a send window wakes all waiters and ignores late credit`` () = task {
        let window = Flow.SendWindow(8)
        do! window.TakeAsync(8, CancellationToken.None)
        let first = window.TakeAsync(4, CancellationToken.None)
        let second = window.TakeAsync(1, CancellationToken.None)
        let error = IOException("The stream closed.")
        window.Fail(error)
        window.Fail(OperationCanceledException())
        let! firstError = Assert.ThrowsAsync<IOException>(fun () -> first :> Task)
        let! secondError = Assert.ThrowsAsync<IOException>(fun () -> second :> Task)
        Assert.Same(error, firstError)
        Assert.Same(error, secondError)
        window.Add(8)
        let! nextError = Assert.ThrowsAsync<IOException>(fun () -> window.TakeAsync(1, CancellationToken.None) :> Task)
        Assert.Same(error, nextError)
    }

    [<Fact>]
    let ``A canceled body read can be followed by a new read`` () = task {
        use body = new Flow.ReceiveBody(8, ignore, ignore)
        use canceled = new CancellationTokenSource()
        let waiting = body.ReadAsync(Memory<byte>(Array.zeroCreate 4), canceled.Token).AsTask()
        Assert.False(waiting.IsCompleted)
        canceled.Cancel()
        let! _ = Assert.ThrowsAnyAsync<OperationCanceledException>(fun () -> waiting :> Task)
        do! body.AcceptAsync([| 1uy .. 4uy |])
        let! count, bytes = read body 4
        Assert.Equal(4, count)
        Assert.Equal<byte>([| 1uy .. 4uy |], bytes)
    }

    [<Fact>]
    let ``Disposal wakes a pending read and accepts no further data`` () = task {
        let mutable closes = 0
        let credits = ResizeArray<int>()
        use body = new Flow.ReceiveBody(8, credits.Add, fun () -> Interlocked.Increment(&closes) |> ignore)
        let waiting = body.ReadAsync(Memory<byte>(Array.zeroCreate 4)).AsTask()
        Assert.False(waiting.IsCompleted)
        body.Dispose()
        let! _ = Assert.ThrowsAsync<ObjectDisposedException>(fun () -> waiting :> Task)
        Assert.False(body.HasEnded)
        do! body.AcceptAsync([| 1uy |])
        body.Finish(None)
        body.Dispose()
        Assert.True(body.IsClosed)
        Assert.False(body.CanRead)
        Assert.Empty(credits)
        Assert.Equal(1, closes)
    }

    [<Fact>]
    let ``Data and disposal can race without failing the connection reader`` () = task {
        for _ in 1 .. 64 do
            let mutable closes = 0
            use body = new Flow.ReceiveBody(8, ignore, fun () -> Interlocked.Increment(&closes) |> ignore)
            let reading = body.ReadAsync(Memory<byte>(Array.zeroCreate 8)).AsTask()
            let start = TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)
            let receiving = Task.Run(Func<Task>(fun () -> task {
                do! start.Task
                do! body.AcceptAsync([| 1uy .. 8uy |])
            }))
            let closing = Task.Run(Func<Task>(fun () -> task {
                do! start.Task
                body.Dispose()
            }))
            start.SetResult()
            do! Task.WhenAll(receiving, closing).WaitAsync(TimeSpan.FromSeconds(5.0))

            try
                let! count = reading.WaitAsync(TimeSpan.FromSeconds(5.0))
                Assert.Equal(8, count)
            with :? ObjectDisposedException -> ()

            do! body.AcceptAsync([| 9uy |])
            Assert.Equal(1, closes)
    }

    [<Fact>]
    let ``Normal completion drains buffered bytes without returning obsolete credit`` () = task {
        let credits = ResizeArray<int>()
        use body = new Flow.ReceiveBody(8, credits.Add, ignore)
        do! body.AcceptAsync([| 1uy .. 8uy |])
        body.Finish(None)
        Assert.True(body.HasEnded)
        let! count, bytes = read body 8
        Assert.Equal(8, count)
        Assert.Equal<byte>([| 1uy .. 8uy |], bytes)
        let! count, _ = read body 1
        Assert.Equal(0, count)
        Assert.Empty(credits)
        let! _ = Assert.ThrowsAsync<InvalidDataException>(fun () -> body.AcceptAsync([| 9uy |]) :> Task)
        return ()
    }

    [<Fact>]
    let ``An aborted body wakes its reader and ignores data already in flight`` () = task {
        use body = new Flow.ReceiveBody(8, ignore, ignore)
        let waiting = body.ReadAsync(Memory<byte>(Array.zeroCreate 4)).AsTask()
        let error = IOException("The request was canceled.")
        body.Finish(Some error)
        let! actual = Assert.ThrowsAsync<IOException>(fun () -> waiting :> Task)
        Assert.Same(error, actual)
        do! body.AcceptAsync([| 1uy |])
        Assert.True(body.IsClosed)
        Assert.False(body.HasEnded)
    }

    [<Fact>]
    let ``Local disposal does not report a peer end to the close callback`` () =
        let mutable body: Flow.ReceiveBody option = None
        let mutable peerEnded = true
        use stream = new Flow.ReceiveBody(8, ignore, fun () -> peerEnded <- body.Value.HasEnded)
        body <- Some stream
        stream.Dispose()
        Assert.False(peerEnded)

    [<Fact>]
    let ``A close callback can finish and dispose its own body`` () =
        let mutable body: Flow.ReceiveBody option = None
        let mutable closes = 0
        use stream = new Flow.ReceiveBody(8, ignore, fun () ->
            closes <- closes + 1
            body.Value.Finish(Some (OperationCanceledException()))
            body.Value.Dispose())
        body <- Some stream
        stream.Dispose()
        Assert.Equal(1, closes)

    [<Fact>]
    let ``Windows reject a nonpositive capacity`` () =
        Assert.Throws<ArgumentException>(fun () -> Flow.SendWindow(0) |> ignore) |> ignore
        Assert.Throws<ArgumentException>(fun () -> new Flow.ReceiveBody(0, ignore, ignore) |> ignore) |> ignore
