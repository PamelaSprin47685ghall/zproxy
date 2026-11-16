namespace ZProxy.Tests

open System
open System.IO
open System.Text
open System.Threading
open System.Threading.Channels
open System.Threading.Tasks
open Xunit
open ZProxy

module HttpWireTests =
    type private FragmentedStream(bytes: byte[], fragmentSize: int) =
        inherit MemoryStream(bytes, false)

        override this.ReadAsync(target: Memory<byte>, ct) =
            base.ReadAsync(target.Slice(0, min target.Length fragmentSize), ct)

    // Each endpoint has one input queue and one output queue.
    type private DuplexStream(input: ChannelReader<byte[]>, output: ChannelWriter<byte[]>) =
        inherit Stream()
        let mutable current = Array.empty<byte>
        let mutable offset = 0
        let mutable ended = false

        let read (target: Memory<byte>) (ct: CancellationToken) = task {
            if target.Length = 0 then
                return 0
            else
                while offset = current.Length && not ended do
                    let! available = input.WaitToReadAsync(ct)

                    if available then
                        let mutable next = Unchecked.defaultof<byte[]>

                        if input.TryRead(&next) then
                            current <- next
                            offset <- 0
                    else
                        ended <- true

                let size = min target.Length (current.Length - offset)
                current.AsMemory(offset, size).CopyTo(target)
                offset <- offset + size
                return size
        }

        override _.CanRead = true
        override _.CanWrite = true
        override _.CanSeek = false
        override _.Length = raise (NotSupportedException())
        override _.Position
            with get () = raise (NotSupportedException())
            and set _ = raise (NotSupportedException())
        override _.Seek(_, _) = raise (NotSupportedException())
        override _.SetLength(_) = raise (NotSupportedException())
        override _.Read(buffer, offset, count) =
            (read (Memory<byte>(buffer, offset, count)) CancellationToken.None).GetAwaiter().GetResult()
        override _.ReadAsync(target: Memory<byte>, ct) = ValueTask<int>(read target ct)
        override _.Write(buffer, offset, count) =
            output.WriteAsync(buffer.AsSpan(offset, count).ToArray()).AsTask().GetAwaiter().GetResult()
        override _.WriteAsync(source: ReadOnlyMemory<byte>, ct) = output.WriteAsync(source.ToArray(), ct)
        override _.Flush() = ()
        override _.FlushAsync(ct) =
            ct.ThrowIfCancellationRequested()
            Task.CompletedTask
        override _.Dispose(disposing) =
            if disposing then output.TryComplete() |> ignore

        static member CreatePair() =
            let options = BoundedChannelOptions(8, SingleReader = true, SingleWriter = true)
            let first = Channel.CreateBounded<byte[]>(options)
            let second = Channel.CreateBounded<byte[]>(options)
            new DuplexStream(first.Reader, second.Writer), new DuplexStream(second.Reader, first.Writer)

    type private FlushStream() =
        inherit MemoryStream()
        let mutable flushCount = 0
        member _.FlushCount = flushCount
        override _.FlushAsync(ct) =
            ct.ThrowIfCancellationRequested()
            flushCount <- flushCount + 1
            Task.CompletedTask

    let private request: HttpWire.Head =
        { StartLine = "POST /tunnel HTTP/1.1"
          Headers = [ "Host", "localhost"; "Transfer-Encoding", "chunked"; "Connection", "keep-alive" ] }

    let private response: HttpWire.Head =
        { StartLine = "HTTP/1.1 200 OK"
          Headers = [ "Transfer-Encoding", "chunked"; "Connection", "keep-alive" ] }

    let private headText = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"

    let private readText (stream: Stream) length (ct: CancellationToken) = task {
        let bytes = Array.zeroCreate<byte> length
        do! stream.ReadExactlyAsync(bytes.AsMemory(), ct)
        return Encoding.UTF8.GetString(bytes)
    }

    let private readAll (stream: Stream) (ct: CancellationToken) = task {
        use output = new MemoryStream()
        do! stream.CopyToAsync(output, ct)
        return Encoding.UTF8.GetString(output.ToArray())
    }

    [<Fact>]
    let ``Response flows before the request body ends on one duplex connection`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5.0))
        let ct = timeout.Token
        let first, second = DuplexStream.CreatePair()
        use clientStream = first
        use serverStream = second
        use client = new HttpWire.Connection(clientStream, leaveOpen = true)
        use server = new HttpWire.Connection(serverStream, leaveOpen = true)

        let serve = task {
            let! head = server.ReadHeadAsync(ct)
            Assert.Equal(request.StartLine, head.StartLine)
            let! firstPart = readText server.Body 5 ct
            Assert.Equal("first", firstPart)
            do! server.WriteHeadAsync(response, ct)
            do! server.Body.WriteAsync(ReadOnlyMemory<byte>("reply"B), ct)
            do! server.Body.FlushAsync(ct)

            // The client sends this part only after it reads the response.
            let! lastPart = readText server.Body 4 ct
            Assert.Equal("last", lastPart)
            let! endRead = server.Body.ReadAsync(Memory<byte>(Array.zeroCreate 1), ct)
            Assert.Equal(0, endRead)
            do! server.CompleteWritesAsync(ct)
        }

        do! client.WriteHeadAsync(request, ct)
        do! client.Body.WriteAsync(ReadOnlyMemory<byte>("first"B), ct)
        do! client.Body.FlushAsync(ct)
        let! head = client.ReadHeadAsync(ct)
        Assert.Equal(response.StartLine, head.StartLine)
        let! reply = readText client.Body 5 ct
        Assert.Equal("reply", reply)
        do! client.Body.WriteAsync(ReadOnlyMemory<byte>("last"B), ct)
        do! client.CompleteWritesAsync(ct)
        let! endRead = client.Body.ReadAsync(Memory<byte>(Array.zeroCreate 1), ct)
        Assert.Equal(0, endRead)
        do! serve
    }

    [<Theory>]
    [<InlineData(1)>]
    [<InlineData(3)>]
    [<InlineData(8192)>]
    let ``Headers and chunks survive arbitrary read fragments`` fragmentSize = task {
        let bytes = Encoding.ASCII.GetBytes(headText + "3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n")
        use stream = new FragmentedStream(bytes, fragmentSize)
        use wire = new HttpWire.Connection(stream)
        let! head = wire.ReadHeadAsync(CancellationToken.None)
        Assert.Equal(response.StartLine, head.StartLine)
        let! text = readAll wire.Body CancellationToken.None
        Assert.Equal("abcde", text)
    }

    [<Fact>]
    let ``Chunk extensions and trailers do not become body data`` () = task {
        let bytes = Encoding.ASCII.GetBytes(headText + "3; name=token; note=\"a b\"\r\nabc\r\n0\r\nX-Result: done\r\n\r\n")
        use stream = new FragmentedStream(bytes, 2)
        use wire = new HttpWire.Connection(stream)
        let! _ = wire.ReadHeadAsync(CancellationToken.None)
        let! text = readAll wire.Body CancellationToken.None
        Assert.Equal("abc", text)
    }

    [<Fact>]
    let ``Empty writes preserve the body and completion is sent once`` () = task {
        use stream = new FlushStream()
        use wire = new HttpWire.Connection(stream, leaveOpen = true)
        let ct = CancellationToken.None
        do! wire.WriteHeadAsync(response, ct)
        let headLength = stream.Length
        do! wire.Body.WriteAsync(ReadOnlyMemory<byte>.Empty, ct)
        Assert.Equal(headLength, stream.Length)
        do! wire.Body.WriteAsync(ReadOnlyMemory<byte>("abc"B), ct)
        let flushes = stream.FlushCount
        do! wire.Body.FlushAsync(ct)
        Assert.Equal(flushes + 1, stream.FlushCount)
        do! wire.CompleteWritesAsync(ct)
        let completeLength = stream.Length
        do! wire.CompleteWritesAsync(ct)
        Assert.Equal(completeLength, stream.Length)
        let encoded = Encoding.ASCII.GetString(stream.ToArray())
        Assert.EndsWith("3\r\nabc\r\n0\r\n\r\n", encoded)
        let! _ = Assert.ThrowsAsync<InvalidOperationException>(fun () ->
            wire.Body.WriteAsync(ReadOnlyMemory<byte>("x"B), ct).AsTask())
        return ()
    }

    [<Theory>]
    [<InlineData("3\r\nab")>]
    [<InlineData("3\r\nabc")>]
    [<InlineData("0\r\n")>]
    let ``Truncated chunked bodies fail instead of reporting a clean end`` body = task {
        use stream = new MemoryStream(Encoding.ASCII.GetBytes(headText + body))
        use wire = new HttpWire.Connection(stream)
        let! _ = wire.ReadHeadAsync(CancellationToken.None)
        let! _ = Assert.ThrowsAsync<EndOfStreamException>(fun () -> readAll wire.Body CancellationToken.None :> Task)
        return ()
    }

    [<Theory>]
    [<InlineData("z\r\n")>]
    [<InlineData("1\r\na!\r\n")>]
    [<InlineData("8000000000000000\r\n")>]
    let ``Invalid chunk framing fails clearly`` body = task {
        use stream = new MemoryStream(Encoding.ASCII.GetBytes(headText + body))
        use wire = new HttpWire.Connection(stream)
        let! _ = wire.ReadHeadAsync(CancellationToken.None)
        let! _ = Assert.ThrowsAsync<InvalidDataException>(fun () -> readAll wire.Body CancellationToken.None :> Task)
        return ()
    }

    [<Fact>]
    let ``Head limits bound each line the field count and total bytes`` () = task {
        let heads =
            [ "HTTP/1.1 200 OK\r\nX-Large: " + String.replicate 8192 "x" + "\r\n\r\n"
              "HTTP/1.1 200 OK\r\n" + String.replicate 129 "X-Field: value\r\n" + "\r\n"
              "HTTP/1.1 200 OK\r\n" + String.replicate 5 ("X-Large: " + String.replicate 7000 "x" + "\r\n") + "\r\n" ]

        for head in heads do
            use stream = new MemoryStream(Encoding.ASCII.GetBytes(head))
            use wire = new HttpWire.Connection(stream)
            let! _ = Assert.ThrowsAsync<InvalidDataException>(fun () -> wire.ReadHeadAsync(CancellationToken.None) :> Task)
            ()
    }

    [<Fact>]
    let ``A head cannot specify both length and transfer encoding`` () = task {
        use stream = new MemoryStream()
        use wire = new HttpWire.Connection(stream)
        let head = { response with Headers = [ "Content-Length", "0"; "Transfer-Encoding", "chunked" ] }
        let! _ = Assert.ThrowsAsync<InvalidDataException>(fun () -> wire.WriteHeadAsync(head, CancellationToken.None))
        Assert.Equal(0L, stream.Length)
    }

    [<Fact>]
    let ``Disposal follows stream ownership`` () =
        use owned = new MemoryStream()
        let first = new HttpWire.Connection(owned)
        (first :> IDisposable).Dispose()
        Assert.False(owned.CanRead)
        use borrowed = new MemoryStream()
        let second = new HttpWire.Connection(borrowed, leaveOpen = true)
        (second :> IDisposable).Dispose()
        Assert.True(borrowed.CanRead)
