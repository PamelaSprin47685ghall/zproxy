namespace ZProxy.Tests

open System
open System.Collections.Concurrent
open System.IO
open System.Net
open System.Net.Http
open System.Net.Sockets
open System.Text
open System.Threading
open System.Threading.Tasks
open Xunit
open ZProxy

module EndToEndTests =
    type private Deadline() =
        let source = new CancellationTokenSource(TimeSpan.FromSeconds(45.0))
        member _.Token = source.Token
        interface IDisposable with
            member _.Dispose() =
                source.Cancel()
                source.Dispose()

    let private signal () = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)

    let private waitForSignal (ready: Task) (work: Task) (ct: CancellationToken) = task {
        let! completed = Task.WhenAny(ready, work).WaitAsync(ct)

        if obj.ReferenceEquals(completed, work) then
            do! work
            failwith "The origin stopped before the expected event."

        do! ready.WaitAsync(ct)
    }

    let private waitForListener (endpoint: IPEndPoint) (running: Task) (ct: CancellationToken) = task {
        let mutable ready = false

        while not ready do
            ct.ThrowIfCancellationRequested()

            if running.IsCompleted then
                do! running
                failwith "The listener stopped before it became ready."

            use probe = new TcpClient()

            try
                do! probe.ConnectAsync(endpoint.Address, endpoint.Port, ct)
                ready <- true
            with :? SocketException ->
                do! Task.Delay(10, ct)
    }

    // The relay counts tunnel sockets and can cut an established connection.
    type private Relay(target: IPEndPoint, ct: CancellationToken) =
        let listener = new TcpListener(IPAddress.Loopback, 0)
        let peers = ConcurrentDictionary<int, TcpClient * TcpClient>()
        let jobs = ConcurrentBag<Task>()
        let mutable count = 0
        do listener.Start()

        let closePeers () =
            for KeyValue(_, (first, second)) in peers do
                first.Dispose()
                second.Dispose()

        let copyConnection (incoming: TcpClient) = task {
            use incoming = incoming
            use outgoing = new TcpClient()
            let id = Interlocked.Increment(&count)
            peers.[id] <- incoming, outgoing

            try
                do! outgoing.ConnectAsync(target.Address, target.Port, ct)
                incoming.NoDelay <- true
                outgoing.NoDelay <- true
                let upstream = incoming.GetStream().CopyToAsync(outgoing.GetStream(), ct)
                let downstream = outgoing.GetStream().CopyToAsync(incoming.GetStream(), ct)
                let! _ = Task.WhenAny(upstream, downstream)
                incoming.Dispose()
                outgoing.Dispose()

                try
                    do! Task.WhenAll(upstream, downstream)
                with _ -> ()
            with _ -> ()

            peers.TryRemove(id) |> ignore
        }

        let running = task {
            try
                while not ct.IsCancellationRequested do
                    let! incoming = listener.AcceptTcpClientAsync(ct)
                    jobs.Add(copyConnection incoming)
            with
            | :? OperationCanceledException -> ()
            | :? SocketException when ct.IsCancellationRequested -> ()
            | :? ObjectDisposedException when ct.IsCancellationRequested -> ()
        }

        member _.Endpoint = listener.LocalEndpoint :?> IPEndPoint
        member _.Count = Volatile.Read(&count)
        member _.CutConnections() = closePeers ()
        member _.StopAsync() = task {
            listener.Stop()
            closePeers ()
            do! running
            do! Task.WhenAll(jobs.ToArray())
        }

    type private RunningProxy(endpoint: IPEndPoint, relay: Relay option, source: CancellationTokenSource, tasks: Task[]) =
        member _.Endpoint = endpoint
        member _.TunnelCount = relay |> Option.map (fun value -> value.Count) |> Option.defaultValue 0
        member _.CutTunnel() = relay.Value.CutConnections()
        member _.Url(origin: IPEndPoint, path: string) =
            Uri(sprintf "http://127.0.0.1:%d/http://127.0.0.1:%d%s" endpoint.Port origin.Port path)

        interface IAsyncDisposable with
            member _.DisposeAsync() = ValueTask(task {
                source.Cancel()

                try
                    match relay with
                    | Some value -> do! value.StopAsync()
                    | None -> ()
                    do! Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(5.0))
                with _ -> ()

                source.Dispose()
            })

    let private startProxy limits serverPassword clientPassword plugins (ct: CancellationToken) = task {
        use serverPort = new TcpListener(IPAddress.Loopback, 0)
        use clientPort = new TcpListener(IPAddress.Loopback, 0)
        serverPort.Start()
        clientPort.Start()
        let serverEndpoint = serverPort.LocalEndpoint :?> IPEndPoint
        let clientEndpoint = clientPort.LocalEndpoint :?> IPEndPoint
        let source = CancellationTokenSource.CreateLinkedTokenSource(ct)
        let serverOptions = { Options.server serverEndpoint serverPassword with Limits = limits }
        serverPort.Stop()
        let serverTask = Server.run serverOptions source.Token

        try
            do! waitForListener serverEndpoint serverTask source.Token
            let relay = new Relay(serverEndpoint, source.Token)
            let serverUri = Uri(sprintf "http://127.0.0.1:%d" relay.Endpoint.Port)
            let clientOptions = { Options.client clientEndpoint serverUri clientPassword with Limits = limits }
            clientPort.Stop()
            let clientTask = Client.run clientOptions plugins source.Token
            let proxy = new RunningProxy(clientEndpoint, Some relay, source, [| serverTask; clientTask |])

            try
                do! waitForListener clientEndpoint clientTask source.Token
                return proxy
            with error ->
                do! (proxy :> IAsyncDisposable).DisposeAsync()
                return raise error
        with error ->
            if not source.IsCancellationRequested then source.Cancel()
            source.Dispose()
            return raise error
    }

    let private startLocalOnly plugins (ct: CancellationToken) = task {
        use clientPort = new TcpListener(IPAddress.Loopback, 0)
        use unusedServer = new TcpListener(IPAddress.Loopback, 0)
        clientPort.Start()
        unusedServer.Start()
        let endpoint = clientPort.LocalEndpoint :?> IPEndPoint
        let serverEndpoint = unusedServer.LocalEndpoint :?> IPEndPoint
        let source = CancellationTokenSource.CreateLinkedTokenSource(ct)
        let serverUri = Uri(sprintf "http://127.0.0.1:%d" serverEndpoint.Port)
        let options = Options.client endpoint serverUri "local-plugin-test"
        clientPort.Stop()
        unusedServer.Stop()
        let running = Client.run options plugins source.Token
        let proxy = new RunningProxy(endpoint, None, source, [| running |])

        try
            do! waitForListener endpoint running source.Token
            return proxy
        with error ->
            do! (proxy :> IAsyncDisposable).DisposeAsync()
            return raise error
    }

    type private PiecesContent(parts: string list) =
        inherit HttpContent()

        let send (stream: Stream) (ct: CancellationToken) = task {
            for part in parts do
                do! stream.WriteAsync(Encoding.UTF8.GetBytes(part).AsMemory(), ct)
                do! stream.FlushAsync(ct)
        }

        override _.TryComputeLength(length: byref<int64>) =
            length <- 0L
            false
        override _.SerializeToStreamAsync(stream, _) = send stream CancellationToken.None :> Task
        override _.SerializeToStreamAsync(stream, _, ct) = send stream ct :> Task

    let private readAll (stream: Stream) (ct: CancellationToken) = task {
        use output = new MemoryStream()
        do! stream.CopyToAsync(output, ct)
        return Encoding.UTF8.GetString(output.ToArray())
    }

    let private readText (stream: Stream) length (ct: CancellationToken) = task {
        let bytes = Array.zeroCreate<byte> length
        do! stream.ReadExactlyAsync(bytes.AsMemory(), ct)
        return Encoding.UTF8.GetString(bytes)
    }

    let private responseHead contentType: HttpWire.Head =
        { StartLine = "HTTP/1.1 200 OK"
          Headers = [ "Content-Type", contentType; "Transfer-Encoding", "chunked"; "Connection", "close" ] }

    let private reply (wire: HttpWire.Connection) (text: string) (ct: CancellationToken) = task {
        do! wire.WriteHeadAsync(responseHead "text/plain", ct)
        do! wire.Body.WriteAsync(Encoding.UTF8.GetBytes(text).AsMemory(), ct)
        do! wire.CompleteWritesAsync(ct)
    }

    let private waitForPeerClose (stream: Stream) (ct: CancellationToken) = task {
        try
            let buffer = Array.zeroCreate<byte> 1
            let! count = stream.ReadAsync(buffer.AsMemory(), ct)
            Assert.Equal(0, count)
        with :? IOException -> ()
    }

    let private newHttpClient () =
        let handler = new SocketsHttpHandler(UseProxy = false, AllowAutoRedirect = false)
        new HttpClient(handler, true, Timeout = Timeout.InfiniteTimeSpan)

    [<Fact>]
    let ``Chunked upload reaches the origin and SSE arrives before completion`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        use origin = new TcpListener(IPAddress.Loopback, 0)
        origin.Start()
        let endpoint = origin.LocalEndpoint :?> IPEndPoint
        let release = signal ()
        let firstEvent = "data: first\n\n"

        let serve = task {
            use! socket = origin.AcceptTcpClientAsync(ct)
            use wire = new HttpWire.Connection(socket.GetStream())
            let! head = wire.ReadHeadAsync(ct)
            Assert.Contains(head.Headers, fun (name, value) -> name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase) && value = "chunked")
            let! body = readAll wire.Body ct
            Assert.Equal("{\"prompt\":\"hello\"}", body)
            do! wire.WriteHeadAsync(responseHead "text/event-stream", ct)
            do! wire.Body.WriteAsync(Encoding.UTF8.GetBytes(firstEvent).AsMemory(), ct)
            do! wire.Body.FlushAsync(ct)
            do! release.Task.WaitAsync(ct)
            do! wire.Body.WriteAsync(ReadOnlyMemory<byte>("data: last\n\n"B), ct)
            do! wire.CompleteWritesAsync(ct)
        }

        use! proxy = startProxy Options.defaults "stream-password" "stream-password" [] ct
        use http = newHttpClient ()
        use request = new HttpRequestMessage(HttpMethod.Post, proxy.Url(endpoint, "/v1/chat/completions"))
        request.Content <- new PiecesContent([ "{\"prompt\":"; "\"hello\"}" ])
        use! response = http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
        Assert.Equal(HttpStatusCode.OK, response.StatusCode)
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType.MediaType)
        use! body = response.Content.ReadAsStreamAsync(ct)
        let! first = readText body firstEvent.Length ct
        Assert.Equal(firstEvent, first)
        Assert.False(serve.IsCompleted)
        release.SetResult(())
        let! rest = readAll body ct
        Assert.Equal("data: last\n\n", rest)
        do! serve
        Assert.Equal(1, proxy.TunnelCount)
    }

    [<Fact>]
    let ``A long response does not block another request in the same tunnel`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        use origin = new TcpListener(IPAddress.Loopback, 0)
        origin.Start()
        let endpoint = origin.LocalEndpoint :?> IPEndPoint
        let release = signal ()

        let serve = task {
            use! slowSocket = origin.AcceptTcpClientAsync(ct)
            use slow = new HttpWire.Connection(slowSocket.GetStream())
            let! head = slow.ReadHeadAsync(ct)
            Assert.Contains("/slow ", head.StartLine)
            do! slow.WriteHeadAsync(responseHead "text/event-stream", ct)
            do! slow.Body.WriteAsync(ReadOnlyMemory<byte>("data: waiting\n\n"B), ct)
            do! slow.Body.FlushAsync(ct)
            use! fastSocket = origin.AcceptTcpClientAsync(ct)
            use fast = new HttpWire.Connection(fastSocket.GetStream())
            let! head = fast.ReadHeadAsync(ct)
            Assert.Contains("/fast ", head.StartLine)
            do! reply fast "fast result" ct
            do! release.Task.WaitAsync(ct)
            do! slow.CompleteWritesAsync(ct)
        }

        use! proxy = startProxy Options.defaults "parallel-password" "parallel-password" [] ct
        use http = newHttpClient ()
        use! slowResponse = http.GetAsync(proxy.Url(endpoint, "/slow"), HttpCompletionOption.ResponseHeadersRead, ct)
        use! slowBody = slowResponse.Content.ReadAsStreamAsync(ct)
        let! first = readText slowBody "data: waiting\n\n".Length ct
        Assert.Equal("data: waiting\n\n", first)
        use! fastResponse = http.GetAsync(proxy.Url(endpoint, "/fast"), ct)
        Assert.Equal(HttpStatusCode.OK, fastResponse.StatusCode)
        let! fastBody = fastResponse.Content.ReadAsStringAsync(ct)
        Assert.Equal("fast result", fastBody)
        Assert.Equal(1, proxy.TunnelCount)
        release.SetResult(())
        let! rest = readAll slowBody ct
        Assert.Equal("", rest)
        do! serve
    }

    [<Fact>]
    let ``Local cancellation closes the upstream and releases the stream slot`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        use origin = new TcpListener(IPAddress.Loopback, 0)
        origin.Start()
        let endpoint = origin.LocalEndpoint :?> IPEndPoint
        let closed = signal ()

        let serve = task {
            use! firstSocket = origin.AcceptTcpClientAsync(ct)
            use first = new HttpWire.Connection(firstSocket.GetStream(), leaveOpen = true)
            let! _ = first.ReadHeadAsync(ct)
            do! first.WriteHeadAsync(responseHead "text/event-stream", ct)
            do! first.Body.WriteAsync(ReadOnlyMemory<byte>("data: open\n\n"B), ct)
            do! first.Body.FlushAsync(ct)
            do! waitForPeerClose (firstSocket.GetStream()) ct
            closed.SetResult(())
            use! nextSocket = origin.AcceptTcpClientAsync(ct)
            use next = new HttpWire.Connection(nextSocket.GetStream())
            let! _ = next.ReadHeadAsync(ct)
            do! reply next "slot reused" ct
        }

        let limits = { Options.defaults with MaxStreams = 1; StreamWindowBytes = 16384 }
        use! proxy = startProxy limits "cancel-password" "cancel-password" [] ct
        use local = new TcpClient()
        do! local.ConnectAsync(proxy.Endpoint.Address, proxy.Endpoint.Port, ct)
        use wire = new HttpWire.Connection(local.GetStream(), leaveOpen = true)
        let head: HttpWire.Head =
            { StartLine = sprintf "GET /http://127.0.0.1:%d/cancel HTTP/1.1" endpoint.Port
              Headers = [ "Host", sprintf "127.0.0.1:%d" proxy.Endpoint.Port; "Connection", "close" ] }
        do! wire.WriteHeadAsync(head, ct)
        let! head = wire.ReadHeadAsync(ct)
        Assert.Equal("HTTP/1.1 200 OK", head.StartLine)
        let! first = readText wire.Body "data: open\n\n".Length ct
        Assert.Equal("data: open\n\n", first)
        local.Client.LingerState <- LingerOption(true, 0)
        local.Dispose()
        do! waitForSignal closed.Task serve ct
        use http = newHttpClient ()
        use! response = http.GetAsync(proxy.Url(endpoint, "/after-cancel"), ct)
        Assert.Equal(HttpStatusCode.OK, response.StatusCode)
        let! text = response.Content.ReadAsStringAsync(ct)
        Assert.Equal("slot reused", text)
        Assert.Equal(1, proxy.TunnelCount)
        do! serve
    }

    [<Fact>]
    let ``A dropped tunnel fails the old POST and reconnects only for a new request`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        use origin = new TcpListener(IPAddress.Loopback, 0)
        origin.Start()
        let endpoint = origin.LocalEndpoint :?> IPEndPoint
        let received = signal ()
        let closed = signal ()

        let serve = task {
            use! firstSocket = origin.AcceptTcpClientAsync(ct)
            use first = new HttpWire.Connection(firstSocket.GetStream(), leaveOpen = true)
            let! _ = first.ReadHeadAsync(ct)
            let! body = readAll first.Body ct
            Assert.Equal("old POST", body)
            received.SetResult(())
            do! waitForPeerClose (firstSocket.GetStream()) ct
            closed.SetResult(())
            use! nextSocket = origin.AcceptTcpClientAsync(ct)
            use next = new HttpWire.Connection(nextSocket.GetStream())
            let! _ = next.ReadHeadAsync(ct)
            let! body = readAll next.Body ct
            Assert.Equal("new POST", body)
            do! reply next "fresh result" ct
        }

        use! proxy = startProxy Options.defaults "reconnect-password" "reconnect-password" [] ct
        use http = newHttpClient ()
        use oldRequest = new HttpRequestMessage(HttpMethod.Post, proxy.Url(endpoint, "/request"))
        oldRequest.Content <- new PiecesContent([ "old POST" ])
        let oldResponse = http.SendAsync(oldRequest, HttpCompletionOption.ResponseHeadersRead, ct)
        do! waitForSignal received.Task serve ct
        proxy.CutTunnel()

        try
            use! response = oldResponse
            Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode)
        with :? HttpRequestException -> ()

        do! waitForSignal closed.Task serve ct
        use nextRequest = new HttpRequestMessage(HttpMethod.Post, proxy.Url(endpoint, "/request"))
        nextRequest.Content <- new PiecesContent([ "new POST" ])
        use! nextResponse = http.SendAsync(nextRequest, ct)
        Assert.Equal(HttpStatusCode.OK, nextResponse.StatusCode)
        let! body = nextResponse.Content.ReadAsStringAsync(ct)
        Assert.Equal("fresh result", body)
        Assert.Equal(2, proxy.TunnelCount)
        do! serve
        Assert.False(origin.Pending())
    }

    [<Fact>]
    let ``A wrong password cannot connect to the origin`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        use origin = new TcpListener(IPAddress.Loopback, 0)
        origin.Start()
        let endpoint = origin.LocalEndpoint :?> IPEndPoint
        use! proxy = startProxy Options.defaults "correct-password" "wrong-password" [] ct
        use http = newHttpClient ()
        use! response = http.GetAsync(proxy.Url(endpoint, "/private"), ct)
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode)
        Assert.False(origin.Pending())
    }

    [<Fact>]
    let ``A plugin can return a response while the remote server is stopped`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        let mutable calls = 0
        let plugin =
            { new IProxyPlugin with
                member _.Wrap(_) = fun request token ->
                    token.ThrowIfCancellationRequested()
                    Assert.Equal("/local", request.RequestUri.AbsolutePath)
                    Interlocked.Increment(&calls) |> ignore
                    let response = new HttpResponseMessage(HttpStatusCode.OK)
                    response.Content <- new StringContent("local plugin result")
                    Task.FromResult(response) }

        use! proxy = startLocalOnly [ plugin ] ct
        use http = newHttpClient ()
        let target = IPEndPoint(IPAddress.Loopback, 1)
        use! response = http.GetAsync(proxy.Url(target, "/local"), ct)
        Assert.Equal(HttpStatusCode.OK, response.StatusCode)
        let! body = response.Content.ReadAsStringAsync(ct)
        Assert.Equal("local plugin result", body)
        Assert.Equal(1, calls)
    }
