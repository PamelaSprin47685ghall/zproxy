namespace ZProxy.Tests

open System
open System.Collections.Concurrent
open System.IO
open System.Net
open System.Net.Http
open System.Security.Cryptography
open System.Threading
open System.Threading.Channels
open System.Threading.Tasks
open Xunit
open ZProxy

module SessionTests =
    // All tests share one real Argon2id derivation. Each handshake has fresh session keys.
    let private masterKey = lazy (Crypto.deriveMasterKey "session-integration-test-password")

    type private DuplexStream(incoming: Channel<byte[]>, outgoing: Channel<byte[]>) =
        inherit Stream()
        let mutable pending = Array.empty<byte>
        let mutable offset = 0
        let mutable disposed = 0
        let read (buffer: Memory<byte>) (token: CancellationToken) = task {
            if buffer.Length = 0 then return 0
            else
                if offset = pending.Length then
                    let! available = incoming.Reader.WaitToReadAsync(token)
                    if available then
                        let! bytes = incoming.Reader.ReadAsync(token)
                        pending <- bytes
                        offset <- 0
                let count = min 4093 (min buffer.Length (pending.Length - offset))
                pending.AsMemory(offset, count).CopyTo(buffer)
                offset <- offset + count
                return count
        }
        override _.CanRead = true
        override _.CanWrite = true
        override _.CanSeek = false
        override _.Length = raise (NotSupportedException())
        override _.Position with get() = raise (NotSupportedException()) and set _ = raise (NotSupportedException())
        override _.Seek(_, _) = raise (NotSupportedException())
        override _.SetLength(_) = raise (NotSupportedException())
        override _.Flush() = ()
        override _.FlushAsync(token) =
            token.ThrowIfCancellationRequested()
            Task.CompletedTask
        override _.Read(buffer, offset, count) =
            (read (buffer.AsMemory(offset, count)) CancellationToken.None).GetAwaiter().GetResult()
        override _.ReadAsync(buffer: Memory<byte>, token) = ValueTask<int>(read buffer token)
        override _.Write(buffer, offset, count) =
            outgoing.Writer.WriteAsync(buffer.AsSpan(offset, count).ToArray()).AsTask().GetAwaiter().GetResult()
        override _.WriteAsync(buffer: ReadOnlyMemory<byte>, token) = outgoing.Writer.WriteAsync(buffer.ToArray(), token)
        override _.Dispose(disposing) =
            if disposing && Interlocked.Exchange(&disposed, 1) = 0 then
                incoming.Writer.TryComplete() |> ignore
                outgoing.Writer.TryComplete() |> ignore
            base.Dispose(disposing)
        static member Pair() =
            let options = BoundedChannelOptions(8, SingleReader = true, SingleWriter = true)
            let first = Channel.CreateBounded<byte[]>(options)
            let second = Channel.CreateBounded<byte[]>(options)
            new DuplexStream(first, second), new DuplexStream(second, first)

    type private SessionPair(client: Session.ProxySession, server: Session.ProxySession,
                             clientWire: HttpWire.Connection, serverWire: HttpWire.Connection,
                             agreed: Options.Limits) =
        member _.Client = client
        member _.Server = server
        member _.Limits = agreed
        member _.StopAsync() = task {
            (client :> IDisposable).Dispose()
            (server :> IDisposable).Dispose()
            do! Task.WhenAll(client.Completion, server.Completion).WaitAsync(TimeSpan.FromSeconds(5.0))
        }
        interface IDisposable with
            member _.Dispose() =
                (client :> IDisposable).Dispose()
                (server :> IDisposable).Dispose()
                (clientWire :> IDisposable).Dispose()
                (serverWire :> IDisposable).Dispose()

    let private connect (handler: ProxyHandler) offered allowed (token: CancellationToken) = task {
        let first, second = DuplexStream.Pair()
        let clientWire = new HttpWire.Connection(first)
        let serverWire = new HttpWire.Connection(second)
        try
            let master = masterKey.Value
            Assert.Equal(32, master.Length)
            let accepting = Handshake.accept serverWire master allowed (Crypto.ReplayFilter(60000L)) token
            let! clientKeys, clientPreamble, clientLimits =
                Handshake.connect clientWire (Uri("http://gateway.test/")) master offered token
            let! serverKeys, serverPreamble, serverLimits = accepting
            Assert.Equal(clientLimits, serverLimits)
            Assert.Equal<byte>(clientPreamble, serverPreamble)
            Assert.Equal<byte>(clientKeys.KeyC2S, serverKeys.KeyC2S)
            Assert.Equal<byte>(clientKeys.KeyS2C, serverKeys.KeyS2C)
            let clientTunnel =
                new Tunnel.EncryptedZstdTunnel(clientWire.Body, clientKeys, clientPreamble, true,
                                              clientLimits.UploadWindowLog, clientLimits.DownloadWindowLog, token)
            let serverTunnel =
                new Tunnel.EncryptedZstdTunnel(serverWire.Body, serverKeys, serverPreamble, false,
                                              serverLimits.DownloadWindowLog, serverLimits.UploadWindowLog, token)
            for keys in [ clientKeys; serverKeys ] do
                CryptographicOperations.ZeroMemory(keys.KeyC2S.AsSpan())
                CryptographicOperations.ZeroMemory(keys.KeyS2C.AsSpan())
            let server = new Session.ProxySession(serverTunnel, serverLimits, false, Some handler,
                                                  (fun () -> (serverWire :> IDisposable).Dispose()), token)
            let client = new Session.ProxySession(clientTunnel, clientLimits, true, None,
                                                  (fun () -> (clientWire :> IDisposable).Dispose()), token)
            return new SessionPair(client, server, clientWire, serverWire, clientLimits)
        with error ->
            (clientWire :> IDisposable).Dispose()
            (serverWire :> IDisposable).Dispose()
            return raise error
    }

    let private reply (content: HttpContent) =
        let response = new HttpResponseMessage(HttpStatusCode.OK)
        response.Version <- HttpVersion.Version20
        response.Content <- content
        response

    let private payload length seed =
        let bytes = Array.zeroCreate<byte> length
        Random(seed).NextBytes(bytes)
        bytes

    /// One read beyond the window proves that the producer now waits for credit.
    type private CountedStream(bytes: byte[], window: int, full: TaskCompletionSource<unit>, closed: TaskCompletionSource<unit>) =
        inherit Stream()
        let mutable offset = 0
        let mutable disposed = 0
        let read (target: Memory<byte>) (token: CancellationToken) =
            token.ThrowIfCancellationRequested()
            let start = Volatile.Read(&offset)
            let count = min target.Length (bytes.Length - start)
            bytes.AsMemory(start, count).CopyTo(target)
            let total = Interlocked.Add(&offset, count)
            if total > window then full.TrySetResult(()) |> ignore
            count
        member _.ReadCount = Volatile.Read(&offset)
        override _.CanRead = true
        override _.CanSeek = false
        override _.CanWrite = false
        override _.Length = raise (NotSupportedException())
        override _.Position with get() = raise (NotSupportedException()) and set _ = raise (NotSupportedException())
        override _.Seek(_, _) = raise (NotSupportedException())
        override _.SetLength(_) = raise (NotSupportedException())
        override _.Flush() = ()
        override _.Write(_, _, _) = raise (NotSupportedException())
        override _.Read(buffer, offset, count) = read (buffer.AsMemory(offset, count)) CancellationToken.None
        override _.ReadAsync(buffer: Memory<byte>, token) = ValueTask<int>(read buffer token)
        override _.Dispose(disposing) =
            if disposing && Interlocked.Exchange(&disposed, 1) = 0 then closed.TrySetResult(()) |> ignore
            base.Dispose(disposing)

    type private ShortFirstReadStream(bytes: byte[]) =
        inherit MemoryStream(bytes, false)
        let mutable firstRead = true
        override this.ReadAsync(buffer: Memory<byte>, token: CancellationToken) =
            if firstRead && buffer.Length > 0 then
                firstRead <- false
                base.ReadAsync(buffer.Slice(0, 1), token)
            else base.ReadAsync(buffer, token)

    [<Fact>]
    let ``Authenticated HTTP handshake negotiates down and transfers bodies across windows`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30.0))
        let token = timeout.Token
        let upload = payload (3 * 256 * 1024 + 137) 201
        let download = payload (2 * 256 * 1024 + 791) 712
        let received = TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously)
        let handler: ProxyHandler = fun request token -> task {
            let! bytes = request.Content.ReadAsByteArrayAsync(token)
            received.TrySetResult(bytes) |> ignore
            return reply (new ByteArrayContent(download))
        }
        let offered =
            { Options.defaults with UploadWindowLog = 23; DownloadWindowLog = 23
                                    MaxStreams = 8; StreamWindowBytes = 512 * 1024 }
        let allowed =
            { Options.defaults with UploadWindowLog = 20; DownloadWindowLog = 19
                                    MaxStreams = 4; StreamWindowBytes = 256 * 1024 }
        use! pair = connect handler offered allowed token
        Assert.Equal(allowed, pair.Limits)
        use request = new HttpRequestMessage(HttpMethod.Post, "https://origin.test/v1/chat/completions")
        request.Content <- new ByteArrayContent(upload)
        use! response = pair.Client.SendAsync(request, token)
        let! body = response.Content.ReadAsByteArrayAsync(token)
        let! submitted = received.Task.WaitAsync(token)
        Assert.Equal<byte>(upload, submitted)
        Assert.Equal<byte>(download, body)
        Assert.Equal(HttpVersion.Version20, response.Version)
        Assert.True(pair.Client.IsAlive)
        Assert.True(pair.Server.IsAlive)
        do! pair.StopAsync()
    }

    [<Fact>]
    let ``A full stream window does not block another request`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30.0))
        let token = timeout.Token
        let limits = { Options.defaults with MaxStreams = 4 }
        let full = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
        let closed = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
        use source = new CountedStream(payload (limits.StreamWindowBytes * 4) 144, limits.StreamWindowBytes, full, closed)
        let handler: ProxyHandler = fun request _ -> task {
            if request.RequestUri.AbsolutePath = "/slow" then
                return reply (new StreamContent(source))
            else return reply (new StringContent("independent response"))
        }
        use! pair = connect handler limits limits token
        use slowRequest = new HttpRequestMessage(HttpMethod.Get, "https://origin.test/slow")
        use! slow = pair.Client.SendAsync(slowRequest, token)
        do! full.Task.WaitAsync(token)
        use fastRequest = new HttpRequestMessage(HttpMethod.Get, "https://origin.test/fast")
        use! fast = pair.Client.SendAsync(fastRequest, token)
        let! body = fast.Content.ReadAsStringAsync(token)
        Assert.Equal("independent response", body)
        Assert.Equal(limits.StreamWindowBytes + Frame.MaxDataBytes, source.ReadCount)
        Assert.True(pair.Client.IsAlive)
        Assert.True(pair.Server.IsAlive)
        slow.Dispose()
        do! closed.Task.WaitAsync(token)
        Assert.True(pair.Client.IsAlive)
        Assert.True(pair.Server.IsAlive)
        do! pair.StopAsync()
    }

    [<Fact>]
    let ``Response disposal and caller cancellation leave other streams alive`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30.0))
        let token = timeout.Token
        let limits = { Options.defaults with MaxStreams = 4 }
        let bytes = payload (limits.StreamWindowBytes * 4) 49
        let closed = ConcurrentDictionary<string, TaskCompletionSource<unit>>()
        let handler: ProxyHandler = fun request _ -> task {
            let path = request.RequestUri.AbsolutePath
            if path = "/fast" then return reply (new StringContent("alive"))
            else
                let full = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
                let source = new CountedStream(bytes, limits.StreamWindowBytes, full, closed[path])
                return reply (new StreamContent(source))
        }
        use! pair = connect handler limits limits token
        for index in 1 .. 16 do
            let path = "/cancel/" + string index
            let ended = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
            closed[path] <- ended
            use caller = CancellationTokenSource.CreateLinkedTokenSource(token)
            use request = new HttpRequestMessage(HttpMethod.Get, "https://origin.test" + path)
            use! response = pair.Client.SendAsync(request, caller.Token)
            if index % 2 = 0 then response.Dispose()
            else caller.Cancel()
            use fastRequest = new HttpRequestMessage(HttpMethod.Get, "https://origin.test/fast")
            use! fast = pair.Client.SendAsync(fastRequest, token)
            let! body = fast.Content.ReadAsStringAsync(token)
            Assert.Equal("alive", body)
            do! ended.Task.WaitAsync(token)
            Assert.True(pair.Client.IsAlive)
            Assert.True(pair.Server.IsAlive)
        do! pair.StopAsync()
    }

    [<Fact>]
    let ``Cancellation before response headers does not leave pending opens`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30.0))
        let token = timeout.Token
        let limits = { Options.defaults with MaxStreams = 4 }
        let handler: ProxyHandler = fun request upstreamToken -> task {
            if request.RequestUri.AbsolutePath = "/fast" then
                return reply (new StringContent("ready"))
            else
                do! Task.Delay(Timeout.Infinite, upstreamToken)
                return raise (InvalidOperationException("The test origin must be canceled"))
        }
        use! pair = connect handler limits limits token
        for batch in 1 .. 4 do
            for index in 1 .. 8 do
                use caller = CancellationTokenSource.CreateLinkedTokenSource(token)
                use request = new HttpRequestMessage(HttpMethod.Get, "https://origin.test/wait/" + string batch + "/" + string index)
                let pending = pair.Client.SendAsync(request, caller.Token)
                caller.Cancel()
                let! _ = Assert.ThrowsAnyAsync<OperationCanceledException>(fun () -> pending :> Task)
                ()
            use request = new HttpRequestMessage(HttpMethod.Get, "https://origin.test/fast")
            use! response = pair.Client.SendAsync(request, token)
            let! body = response.Content.ReadAsStringAsync(token)
            Assert.Equal("ready", body)
            Assert.True(pair.Client.IsAlive)
            Assert.True(pair.Server.IsAlive)
        do! pair.StopAsync()
    }

    [<Fact>]
    let ``A short first read crosses the minimum window in both directions`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20.0))
        let token = timeout.Token
        let limits = { Options.defaults with StreamWindowBytes = 16384; MaxStreams = 2 }
        let upload = payload (1 + 16384 + 73) 375
        let download = payload (1 + 16384 + 73) 917
        let received = TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously)
        let handler: ProxyHandler = fun request upstreamToken -> task {
            let! body = request.Content.ReadAsByteArrayAsync(upstreamToken)
            received.TrySetResult(body) |> ignore
            return reply (new StreamContent(new ShortFirstReadStream(download)))
        }
        use! pair = connect handler limits limits token
        use request = new HttpRequestMessage(HttpMethod.Post, "https://origin.test/v1/chat/completions")
        request.Content <- new StreamContent(new ShortFirstReadStream(upload))
        use! response = pair.Client.SendAsync(request, token)
        let! body = response.Content.ReadAsByteArrayAsync(token)
        let! submitted = received.Task.WaitAsync(token)
        Assert.Equal<byte>(upload, submitted)
        Assert.Equal<byte>(download, body)
        Assert.True(pair.Client.IsAlive)
        Assert.True(pair.Server.IsAlive)
        do! pair.StopAsync()
    }
