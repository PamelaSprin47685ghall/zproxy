namespace ZProxy.Tests

open System
open System.Collections.Concurrent
open System.IO
open System.Net
open System.Net.Http
open System.Security.Cryptography
open System.Text
open System.Threading
open System.Threading.Channels
open System.Threading.Tasks
open Xunit
open ZProxy

module SessionTests =
    let private userUuid = "6f63a515-50d0-4c3c-9c17-3a10ed9ec1f7"
    let private credential = Crypto.deriveUserCredential userUuid
    let private user: Users.Identity = { Id = "test-user"; Nickname = "integration" }
    let private metadata = Contracts.identity("integration-request", true)
    type private RemoteHandler = HttpRequestMessage -> CancellationToken -> Task<Contracts.RemoteReply>

    type private DuplexStream(incoming: Channel<byte[]>, outgoing: Channel<byte[]>, ?capture: MemoryStream) =
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
        let write (buffer: ReadOnlyMemory<byte>) token =
            let bytes = buffer.ToArray()
            match capture with
            | Some stream -> lock stream (fun () -> stream.Write(bytes))
            | None -> ()
            outgoing.Writer.WriteAsync(bytes, token)
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
            (write (ReadOnlyMemory(buffer, offset, count)) CancellationToken.None).AsTask().GetAwaiter().GetResult()
        override _.WriteAsync(buffer: ReadOnlyMemory<byte>, token) = write buffer token
        override _.Dispose(disposing) =
            if disposing && Interlocked.Exchange(&disposed, 1) = 0 then
                incoming.Writer.TryComplete() |> ignore
                outgoing.Writer.TryComplete() |> ignore
            base.Dispose(disposing)
        static member Pair(?clientCapture: MemoryStream) =
            let options = BoundedChannelOptions(8, SingleReader = true, SingleWriter = true)
            let first = Channel.CreateBounded<byte[]>(options)
            let second = Channel.CreateBounded<byte[]>(options)
            new DuplexStream(first, second, ?capture = clientCapture), new DuplexStream(second, first)

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

    let private resolve (selector: byte[]) : Users.AuthEntry option =
        if CryptographicOperations.FixedTimeEquals(selector, credential.Selector) then
            Some { Identity = user; Key = Array.copy credential.Key; Revoked = CancellationToken.None }
        else None

    let private connect (handler: RemoteHandler) offered allowed (token: CancellationToken) = task {
        let first, second = DuplexStream.Pair()
        let clientWire = new HttpWire.Connection(first)
        let serverWire = new HttpWire.Connection(second)
        try
            let accepting = Handshake.accept serverWire resolve allowed (Crypto.ReplayFilter(60000L)) token
            let! clientKeys, clientPreamble, clientLimits =
                Handshake.connect clientWire (Uri("http://gateway.test/")) credential offered token
            let! entry, serverKeys, serverPreamble, serverLimits = accepting
            Assert.Equal(user, entry.Identity)
            Assert.All<byte>(entry.Key, fun value -> Assert.Equal(0uy, value))
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

    let private reply (content: HttpContent) : Contracts.RemoteReply =
        let response = new HttpResponseMessage(HttpStatusCode.OK)
        response.Version <- HttpVersion.Version20
        response.Content <- content
        { Response = response; Metadata = metadata }

    let private request (label: string) =
        let message = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/chat/completions")
        message.Content <- new StringContent(label)
        message

    let private requestName (message: HttpRequestMessage) token =
        message.Content.ReadAsStringAsync(token)

    let private send (session: Session.ProxySession) request token = task {
        let! remote = session.SendAsync(request, token)
        Assert.Equal(metadata, remote.Metadata)
        return remote.Response
    }

    let private payload length seed =
        let bytes = Array.zeroCreate<byte> length
        Random(seed).NextBytes(bytes)
        bytes

    let private clearKeys (keys: Crypto.SessionKeys) =
        CryptographicOperations.ZeroMemory(keys.KeyC2S.AsSpan())
        CryptographicOperations.ZeroMemory(keys.KeyS2C.AsSpan())

    [<Fact>]
    let ``Handshake carries a public selector and authenticates a user without the UUID`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10.0))
        use capture = new MemoryStream()
        let first, second = DuplexStream.Pair(clientCapture = capture)
        use clientWire = new HttpWire.Connection(first)
        use serverWire = new HttpWire.Connection(second)
        let before = Array.copy credential.Key
        let accepting = Handshake.accept serverWire resolve Options.defaults (Crypto.ReplayFilter(60000L)) timeout.Token
        let! clientKeys, clientPreamble, _ =
            Handshake.connect clientWire (Uri("http://gateway.test/")) credential Options.defaults timeout.Token
        let! entry, serverKeys, serverPreamble, _ = accepting
        try
            Assert.Equal(user, entry.Identity)
            Assert.All<byte>(entry.Key, fun value -> Assert.Equal(0uy, value))
            Assert.Equal<byte>(before, credential.Key)
            Assert.Equal<byte>(clientPreamble, serverPreamble)
            Assert.Equal<byte>(clientKeys.KeyC2S, serverKeys.KeyC2S)
            Assert.Equal<byte>(clientKeys.KeyS2C, serverKeys.KeyS2C)
            let bytes = capture.ToArray()
            let text = Encoding.ASCII.GetString(bytes)
            Assert.DoesNotContain(userUuid, text)
            Assert.DoesNotContain(userUuid.ToUpperInvariant(), text)
            Assert.Equal(-1, bytes.AsSpan().IndexOf(ReadOnlySpan<byte>(credential.Key)))
            use captured = new HttpWire.Connection(new MemoryStream(bytes, false))
            let! head = captured.ReadHeadAsync(timeout.Token)
            Assert.Equal("POST /tunnel HTTP/1.1", head.StartLine)
            let selector = Array.zeroCreate<byte> 32
            do! captured.Body.ReadExactlyAsync(selector.AsMemory(), timeout.Token)
            Assert.Equal<byte>(credential.Selector, selector)
        finally
            clearKeys clientKeys
            clearKeys serverKeys
    }

    [<Fact>]
    let ``Unknown revoked and swapped user keys fail without occupying replay entries`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15.0))
        let secondCredential = Crypto.deriveUserCredential "ebd98813-833b-4ea0-94e0-d57a26bb40af"
        let replay = Crypto.ReplayFilter(60000L, maxEntries = 1)
        let cases =
            [ { credential with Key = secondCredential.Key }, false
              { secondCredential with Key = credential.Key }, false
              { credential with Selector = Array.zeroCreate 32 }, false
              credential, true ]
        for offered, revoked in cases do
            let first, second = DuplexStream.Pair()
            use clientWire = new HttpWire.Connection(first)
            use serverWire = new HttpWire.Connection(second)
            let copies = ResizeArray<byte[]>()
            let lookup (selector: byte[]) : Users.AuthEntry option =
                let matched =
                    if CryptographicOperations.FixedTimeEquals(selector, credential.Selector) then Some credential
                    elif CryptographicOperations.FixedTimeEquals(selector, secondCredential.Selector) then Some secondCredential
                    else None
                matched |> Option.map (fun found ->
                    let key = Array.copy found.Key
                    copies.Add(key)
                    { Identity = user; Key = key; Revoked = CancellationToken(revoked) })
            let accepting = Handshake.accept serverWire lookup Options.defaults replay timeout.Token
            let connecting = Handshake.connect clientWire (Uri("http://gateway.test/")) offered Options.defaults timeout.Token
            let! error = Assert.ThrowsAsync<InvalidDataException>(fun () -> accepting :> Task)
            Assert.DoesNotContain(userUuid, error.Message)
            (serverWire :> IDisposable).Dispose()
            let! _ = Assert.ThrowsAnyAsync<Exception>(fun () -> connecting :> Task)
            for key in copies do Assert.All<byte>(key, fun value -> Assert.Equal(0uy, value))
        Assert.True(credential.Key |> Array.exists (fun value -> value <> 0uy))
        Assert.True(secondCredential.Key |> Array.exists (fun value -> value <> 0uy))
        let first, second = DuplexStream.Pair()
        use clientWire = new HttpWire.Connection(first)
        use serverWire = new HttpWire.Connection(second)
        let accepting = Handshake.accept serverWire resolve Options.defaults replay timeout.Token
        let! clientKeys, _, _ = Handshake.connect clientWire (Uri("http://gateway.test/")) credential Options.defaults timeout.Token
        let! _, serverKeys, _, _ = accepting
        clearKeys clientKeys
        clearKeys serverKeys
        CryptographicOperations.ZeroMemory(secondCredential.Key.AsSpan())
    }

    [<Fact>]
    let ``User revocation stops a pending handshake and clears its key copy`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10.0))
        use revoked = new CancellationTokenSource()
        let selected = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
        let key = Array.copy credential.Key
        let lookup _ : Users.AuthEntry option =
            selected.TrySetResult(()) |> ignore
            Some { Identity = user; Key = key; Revoked = revoked.Token }
        let first, second = DuplexStream.Pair()
        use clientWire = new HttpWire.Connection(first)
        use serverWire = new HttpWire.Connection(second)
        let accepting = Handshake.accept serverWire lookup Options.defaults (Crypto.ReplayFilter(60000L)) timeout.Token
        do! clientWire.WriteHeadAsync(
            { StartLine = "POST /tunnel HTTP/1.1"
              Headers = [ "Host", "gateway.test"; "Transfer-Encoding", "chunked" ] }, timeout.Token)
        do! clientWire.Body.WriteAsync(credential.Selector.AsMemory(), timeout.Token)
        do! selected.Task.WaitAsync(timeout.Token)
        revoked.Cancel()
        let! _ = Assert.ThrowsAnyAsync<OperationCanceledException>(fun () -> accepting :> Task)
        Assert.All<byte>(key, fun value -> Assert.Equal(0uy, value))
    }

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
        let handler: RemoteHandler = fun request token -> task {
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
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/chat/completions")
        request.Content <- new ByteArrayContent(upload)
        use! response = send pair.Client request token
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
        let handler: RemoteHandler = fun request upstreamToken -> task {
            let! label = requestName request upstreamToken
            if label = "slow" then
                return reply (new StreamContent(source))
            else return reply (new StringContent("independent response"))
        }
        use! pair = connect handler limits limits token
        use slowRequest = request "slow"
        use! slow = send pair.Client slowRequest token
        do! full.Task.WaitAsync(token)
        use fastRequest = request "fast"
        use! fast = send pair.Client fastRequest token
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
        let handler: RemoteHandler = fun request upstreamToken -> task {
            let! label = requestName request upstreamToken
            if label = "fast" then return reply (new StringContent("alive"))
            else
                let full = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
                let source = new CountedStream(bytes, limits.StreamWindowBytes, full, closed[label])
                return reply (new StreamContent(source))
        }
        use! pair = connect handler limits limits token
        for index in 1 .. 16 do
            let label = "cancel-" + string index
            let ended = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
            closed[label] <- ended
            use caller = CancellationTokenSource.CreateLinkedTokenSource(token)
            use message = request label
            use! response = send pair.Client message caller.Token
            if index % 2 = 0 then response.Dispose()
            else caller.Cancel()
            use fastRequest = request "fast"
            use! fast = send pair.Client fastRequest token
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
        let handler: RemoteHandler = fun request upstreamToken -> task {
            let! label = requestName request upstreamToken
            if label = "fast" then
                return reply (new StringContent("ready"))
            else
                do! Task.Delay(Timeout.Infinite, upstreamToken)
                return raise (InvalidOperationException("The test origin must be canceled"))
        }
        use! pair = connect handler limits limits token
        for batch in 1 .. 4 do
            for index in 1 .. 8 do
                use caller = CancellationTokenSource.CreateLinkedTokenSource(token)
                use request = request ("wait-" + string batch + "-" + string index)
                let pending = pair.Client.SendAsync(request, caller.Token)
                caller.Cancel()
                let! _ = Assert.ThrowsAnyAsync<OperationCanceledException>(fun () -> pending :> Task)
                ()
            use request = request "fast"
            use! response = send pair.Client request token
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
        let handler: RemoteHandler = fun request upstreamToken -> task {
            let! body = request.Content.ReadAsByteArrayAsync(upstreamToken)
            received.TrySetResult(body) |> ignore
            return reply (new StreamContent(new ShortFirstReadStream(download)))
        }
        use! pair = connect handler limits limits token
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/chat/completions")
        request.Content <- new StreamContent(new ShortFirstReadStream(upload))
        use! response = send pair.Client request token
        let! body = response.Content.ReadAsByteArrayAsync(token)
        let! submitted = received.Task.WaitAsync(token)
        Assert.Equal<byte>(upload, submitted)
        Assert.Equal<byte>(download, body)
        Assert.True(pair.Client.IsAlive)
        Assert.True(pair.Server.IsAlive)
        do! pair.StopAsync()
    }
