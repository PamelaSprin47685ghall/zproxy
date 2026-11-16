namespace ZProxy.Tests

open System
open System.Collections.Concurrent
open System.IO
open System.Net
open System.Net.Http
open System.Net.Sockets
open System.Text
open System.Text.Json
open System.Threading
open System.Threading.Tasks
open Xunit
open ZProxy

module EndToEndTests =
    let private adminPassword = "end-to-end-admin-password"
    let private gatewayToken = "server-only-gateway-token"

    type private Deadline() =
        let source = new CancellationTokenSource(TimeSpan.FromSeconds(45.0))
        member _.Token = source.Token
        interface IDisposable with
            member _.Dispose() =
                source.Cancel()
                source.Dispose()

    let private signal () = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
    let private authority (endpoint: IPEndPoint) = Uri($"http://127.0.0.1:{endpoint.Port}")

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
            with :? SocketException -> do! Task.Delay(10, ct)
    }

    // Count tunnel sockets and allow the test to cut an established connection.
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
            peers[id] <- incoming, outgoing
            try
                do! outgoing.ConnectAsync(target.Address, target.Port, ct)
                incoming.NoDelay <- true
                outgoing.NoDelay <- true
                let upstream = incoming.GetStream().CopyToAsync(outgoing.GetStream(), ct)
                let downstream = outgoing.GetStream().CopyToAsync(incoming.GetStream(), ct)
                let! _ = Task.WhenAny(upstream, downstream)
                incoming.Dispose()
                outgoing.Dispose()
                try do! Task.WhenAll(upstream, downstream) with _ -> ()
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

    type private RunningServer(directory: string, web: IPEndPoint, users: Users.IssuedUser[],
                               relay: Relay, source: CancellationTokenSource, work: Task) =
        let mutable stopped = 0
        member _.Directory = directory
        member _.Users = users
        member _.TunnelUri = authority relay.Endpoint
        member _.WebUri = authority web
        member _.TunnelCount = relay.Count
        member _.CutTunnel() = relay.CutConnections()
        member _.StopAsync() = task {
            if Interlocked.Exchange(&stopped, 1) = 0 then
                source.Cancel()
                do! relay.StopAsync()
                do! work.WaitAsync(TimeSpan.FromSeconds(5.0))
        }
        interface IAsyncDisposable with
            member this.DisposeAsync() = ValueTask(task {
                try do! this.StopAsync()
                finally
                    source.Dispose()
                    if Directory.Exists(directory) then Directory.Delete(directory, true)
            })

    type private RunningClient(endpoint: IPEndPoint, source: CancellationTokenSource, work: Task) =
        let mutable stopped = 0
        member _.Endpoint = endpoint
        member _.Url(path: string) = Uri(authority endpoint, path)
        member _.StopAsync() = task {
            if Interlocked.Exchange(&stopped, 1) = 0 then
                source.Cancel()
                do! work.WaitAsync(TimeSpan.FromSeconds(5.0))
        }
        interface IAsyncDisposable with
            member this.DisposeAsync() = ValueTask(task {
                try do! this.StopAsync()
                finally source.Dispose()
            })

    let private startServer (gateway: IPEndPoint option) limits nicknames
                            (handler: RemoteHandler option) (ct: CancellationToken) = task {
        let directory = Path.Combine(Path.GetTempPath(), "zproxy-end-to-end-" + Guid.NewGuid().ToString("N"))
        let users =
            use store = new Users.Store(directory)
            nicknames |> List.map store.Create |> List.toArray
        use tunnelPort = new TcpListener(IPAddress.Loopback, 0)
        use webPort = new TcpListener(IPAddress.Loopback, 0)
        tunnelPort.Start()
        webPort.Start()
        let endpoint = tunnelPort.LocalEndpoint :?> IPEndPoint
        let web = webPort.LocalEndpoint :?> IPEndPoint
        let source = CancellationTokenSource.CreateLinkedTokenSource(ct)
        let options =
            { Options.server endpoint adminPassword with
                Limits = limits; DataDirectory = directory; WebListen = web
                Gateway = gateway |> Option.map authority; GatewayToken = Some gatewayToken }
        tunnelPort.Stop()
        webPort.Stop()
        let work =
            match handler with
            | Some value -> Server.runWithHandler options value source.Token
            | None -> Server.run options source.Token
        try
            do! waitForListener endpoint work source.Token
            do! waitForListener web work source.Token
            let relay = new Relay(endpoint, source.Token)
            return new RunningServer(directory, web, users, relay, source, work)
        with error ->
            source.Cancel()
            try do! work.WaitAsync(TimeSpan.FromSeconds(5.0)) with _ -> ()
            source.Dispose()
            if Directory.Exists(directory) then Directory.Delete(directory, true)
            return raise error
    }

    let private startClient server uuid limits plugins decoders (ct: CancellationToken) = task {
        use port = new TcpListener(IPAddress.Loopback, 0)
        port.Start()
        let endpoint = port.LocalEndpoint :?> IPEndPoint
        let source = CancellationTokenSource.CreateLinkedTokenSource(ct)
        let options = { Options.client endpoint server uuid with Limits = limits }
        port.Stop()
        let work = Client.runWithDecoders options plugins decoders source.Token
        let running = new RunningClient(endpoint, source, work)
        try
            do! waitForListener endpoint work source.Token
            return running
        with error ->
            do! (running :> IAsyncDisposable).DisposeAsync()
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

    let private newHttpClient useCookies =
        let handler = new SocketsHttpHandler(UseProxy = false, UseCookies = useCookies, AllowAutoRedirect = false)
        new HttpClient(handler, true, Timeout = Timeout.InfiniteTimeSpan)

    let private post (http: HttpClient) (url: Uri) (body: string) (completion: HttpCompletionOption) (ct: CancellationToken) = task {
        use request = new HttpRequestMessage(HttpMethod.Post, url)
        request.Content <- new PiecesContent([ body ])
        return! http.SendAsync(request, completion, ct)
    }

    let private jsonString (name: string) (value: string) =
        use buffer = new MemoryStream()
        use writer = new Utf8JsonWriter(buffer)
        writer.WriteStartObject()
        writer.WriteString(name, value)
        writer.WriteEndObject()
        writer.Flush()
        Encoding.UTF8.GetString(buffer.ToArray())

    let private mutate (server: RunningServer) (http: HttpClient) (method: HttpMethod) (path: string)
                       (body: string option) (ct: CancellationToken) = task {
        use request = new HttpRequestMessage(method, Uri(server.WebUri, path))
        request.Headers.Add("Origin", server.WebUri.GetLeftPart(UriPartial.Authority))
        match body with
        | Some value -> request.Content <- new StringContent(value, Encoding.UTF8, "application/json")
        | None -> ()
        return! http.SendAsync(request, ct)
    }

    let private publicReport (server: RunningServer) (http: HttpClient)
                             (expected: (string * int64) list) (ct: CancellationToken) = task {
        let mutable result = ""
        while result = "" do
            use! response = http.GetAsync(Uri(server.WebUri, "/api/reports"), ct)
            Assert.Equal(HttpStatusCode.OK, response.StatusCode)
            let! body = response.Content.ReadAsStringAsync(ct)
            use document = JsonDocument.Parse(body)
            let rows = document.RootElement.GetProperty("users").EnumerateArray() |> Seq.toArray
            Assert.Equal(expected.Length, rows.Length)
            for nickname, requests in expected do
                let row = rows |> Array.find (fun row -> row.GetProperty("nickname").GetString() = nickname)
                Assert.Equal(requests, row.GetProperty("requests").GetInt64())
            let complete = rows |> Array.forall (fun row -> row.GetProperty("active").GetInt64() = 0L)
            if complete then result <- body
        return result
    }

    [<Fact>]
    let ``Chunked upload reaches the gateway and SSE arrives before completion`` () = task {
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
            Assert.Equal("POST /v1/chat/completions HTTP/1.1", head.StartLine)
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
        use! server = startServer (Some endpoint) Options.defaults [ "stream" ] None ct
        use! client = startClient server.TunnelUri server.Users[0].Uuid Options.defaults [] [] ct
        use http = newHttpClient false
        use request = new HttpRequestMessage(HttpMethod.Post, client.Url("/v1/chat/completions"))
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
        Assert.Equal(1, server.TunnelCount)
    }

    [<Fact>]
    let ``A long response does not block another completion in the same tunnel`` () = task {
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
            Assert.Equal("POST /v1/chat/completions HTTP/1.1", head.StartLine)
            let! body = readAll slow.Body ct
            Assert.Equal("slow", body)
            do! slow.WriteHeadAsync(responseHead "text/event-stream", ct)
            do! slow.Body.WriteAsync(ReadOnlyMemory<byte>("data: waiting\n\n"B), ct)
            do! slow.Body.FlushAsync(ct)
            use! fastSocket = origin.AcceptTcpClientAsync(ct)
            use fast = new HttpWire.Connection(fastSocket.GetStream())
            let! head = fast.ReadHeadAsync(ct)
            Assert.Equal("POST /v1/completions HTTP/1.1", head.StartLine)
            let! body = readAll fast.Body ct
            Assert.Equal("fast", body)
            do! reply fast "fast result" ct
            do! release.Task.WaitAsync(ct)
            do! slow.CompleteWritesAsync(ct)
        }
        use! server = startServer (Some endpoint) Options.defaults [ "parallel" ] None ct
        use! client = startClient server.TunnelUri server.Users[0].Uuid Options.defaults [] [] ct
        use http = newHttpClient false
        use! slowResponse = post http (client.Url("/v1/chat/completions")) "slow" HttpCompletionOption.ResponseHeadersRead ct
        Assert.Equal(HttpStatusCode.OK, slowResponse.StatusCode)
        use! slowBody = slowResponse.Content.ReadAsStreamAsync(ct)
        let! first = readText slowBody "data: waiting\n\n".Length ct
        Assert.Equal("data: waiting\n\n", first)
        use! fastResponse = post http (client.Url("/v1/completions")) "fast" HttpCompletionOption.ResponseContentRead ct
        Assert.Equal(HttpStatusCode.OK, fastResponse.StatusCode)
        let! fastBody = fastResponse.Content.ReadAsStringAsync(ct)
        Assert.Equal("fast result", fastBody)
        Assert.Equal(1, server.TunnelCount)
        release.SetResult(())
        let! rest = readAll slowBody ct
        Assert.Equal("", rest)
        do! serve
    }

    [<Fact>]
    let ``Local cancellation closes the upstream and releases the only stream slot`` () = task {
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
            let! body = readAll first.Body ct
            Assert.Equal("cancel", body)
            do! first.WriteHeadAsync(responseHead "text/event-stream", ct)
            do! first.Body.WriteAsync(ReadOnlyMemory<byte>("data: open\n\n"B), ct)
            do! first.Body.FlushAsync(ct)
            do! waitForPeerClose (firstSocket.GetStream()) ct
            closed.SetResult(())
            use! nextSocket = origin.AcceptTcpClientAsync(ct)
            use next = new HttpWire.Connection(nextSocket.GetStream())
            let! _ = next.ReadHeadAsync(ct)
            let! body = readAll next.Body ct
            Assert.Equal("after cancel", body)
            do! reply next "slot reused" ct
        }
        let limits = { Options.defaults with MaxStreams = 1; StreamWindowBytes = 16384 }
        use! server = startServer (Some endpoint) limits [ "cancel" ] None ct
        use! client = startClient server.TunnelUri server.Users[0].Uuid limits [] [] ct
        use local = new TcpClient()
        do! local.ConnectAsync(client.Endpoint.Address, client.Endpoint.Port, ct)
        use wire = new HttpWire.Connection(local.GetStream(), leaveOpen = true)
        do! wire.WriteHeadAsync(
            { StartLine = "POST /v1/chat/completions HTTP/1.1"
              Headers = [ "Host", $"127.0.0.1:{client.Endpoint.Port}"; "Transfer-Encoding", "chunked"; "Connection", "close" ] }, ct)
        do! wire.Body.WriteAsync(ReadOnlyMemory<byte>("cancel"B), ct)
        do! wire.CompleteWritesAsync(ct)
        let! head = wire.ReadHeadAsync(ct)
        Assert.Equal("HTTP/1.1 200 OK", head.StartLine)
        let! first = readText wire.Body "data: open\n\n".Length ct
        Assert.Equal("data: open\n\n", first)
        local.Client.LingerState <- LingerOption(true, 0)
        local.Dispose()
        do! waitForSignal closed.Task serve ct
        use http = newHttpClient false
        use! response = post http (client.Url("/v1/chat/completions")) "after cancel" HttpCompletionOption.ResponseContentRead ct
        Assert.Equal(HttpStatusCode.OK, response.StatusCode)
        let! text = response.Content.ReadAsStringAsync(ct)
        Assert.Equal("slot reused", text)
        Assert.Equal(1, server.TunnelCount)
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
        use! server = startServer (Some endpoint) Options.defaults [ "reconnect" ] None ct
        use! client = startClient server.TunnelUri server.Users[0].Uuid Options.defaults [] [] ct
        use http = newHttpClient false
        let oldResponse = post http (client.Url("/v1/chat/completions")) "old POST" HttpCompletionOption.ResponseHeadersRead ct
        do! waitForSignal received.Task serve ct
        server.CutTunnel()
        try
            use! response = oldResponse
            Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode)
        with :? HttpRequestException -> ()
        do! waitForSignal closed.Task serve ct
        use! nextResponse = post http (client.Url("/v1/chat/completions")) "new POST" HttpCompletionOption.ResponseContentRead ct
        Assert.Equal(HttpStatusCode.OK, nextResponse.StatusCode)
        let! body = nextResponse.Content.ReadAsStringAsync(ct)
        Assert.Equal("fresh result", body)
        Assert.Equal(2, server.TunnelCount)
        do! serve
        Assert.False(origin.Pending())
    }

    [<Fact>]
    let ``An unknown user UUID cannot send a request to the gateway`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        use origin = new TcpListener(IPAddress.Loopback, 0)
        origin.Start()
        let endpoint = origin.LocalEndpoint :?> IPEndPoint
        use! server = startServer (Some endpoint) Options.defaults [ "known" ] None ct
        use! client = startClient server.TunnelUri (Guid.NewGuid().ToString("D")) Options.defaults [] [] ct
        use http = newHttpClient false
        use! response = post http (client.Url("/v1/chat/completions")) "not authorized" HttpCompletionOption.ResponseContentRead ct
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode)
        Assert.False(origin.Pending())
        let! body = publicReport server http [ "known", 0L ] ct
        use document = JsonDocument.Parse(body)
        let row = document.RootElement.GetProperty("users").[0]
        Assert.Equal(0L, row.GetProperty("requests").GetInt64())
    }

    [<Fact>]
    let ``A plugin can return a completion while the remote server is stopped`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        let mutable calls = 0
        let plugin =
            { new IProxyPlugin with
                member _.Wrap(_) = fun request token ->
                    token.ThrowIfCancellationRequested()
                    Assert.Equal("/v1/chat/completions", request.RequestUri.AbsolutePath)
                    Interlocked.Increment(&calls) |> ignore
                    let response = new HttpResponseMessage(HttpStatusCode.OK)
                    response.Content <- new StringContent("local plugin result")
                    Task.FromResult(response) }
        use unused = new TcpListener(IPAddress.Loopback, 0)
        unused.Start()
        let serverUri = authority (unused.LocalEndpoint :?> IPEndPoint)
        unused.Stop()
        use! client = startClient serverUri (Guid.NewGuid().ToString("D")) Options.defaults [ plugin ] [] ct
        use http = newHttpClient false
        use! response = post http (client.Url("/v1/chat/completions")) "local" HttpCompletionOption.ResponseContentRead ct
        Assert.Equal(HttpStatusCode.OK, response.StatusCode)
        let! body = response.Content.ReadAsStringAsync(ct)
        Assert.Equal("local plugin result", body)
        Assert.Equal(1, calls)
    }

    [<Fact>]
    let ``Only server credentials reach the gateway and secret response headers stay remote`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        use origin = new TcpListener(IPAddress.Loopback, 0)
        origin.Start()
        let endpoint = origin.LocalEndpoint :?> IPEndPoint
        let blocked = [ "Proxy-Authorization"; "Cookie"; "X-User"; "X-User-Id"; "X-Zproxy-User"; "X-Zproxy-Metadata" ]
        let serve = task {
            use! socket = origin.AcceptTcpClientAsync(ct)
            use wire = new HttpWire.Connection(socket.GetStream())
            let! head = wire.ReadHeadAsync(ct)
            Assert.Equal("POST /v1/chat/completions HTTP/1.1", head.StartLine)
            let authorization = head.Headers |> List.filter (fun (name, _) -> name.Equals("Authorization", StringComparison.OrdinalIgnoreCase))
            Assert.Equal<string>([| "Bearer " + gatewayToken |], authorization |> List.map snd |> List.toArray)
            for name in blocked do
                Assert.DoesNotContain(head.Headers, fun (key, _) -> key.Equals(name, StringComparison.OrdinalIgnoreCase))
            let! body = readAll wire.Body ct
            Assert.Equal("ordinary request", body)
            let headers =
                [ "Authorization", "Bearer upstream-account-secret"
                  "Set-Cookie", "upstream-session=private"
                  "X-Zproxy-Decoder", "unregistered-decoder"
                  "X-Zproxy-Metadata", "upstream-account-secret" ]
            do! wire.WriteHeadAsync({ responseHead "application/json" with Headers = (responseHead "application/json").Headers @ headers }, ct)
            do! wire.Body.WriteAsync(ReadOnlyMemory<byte>("{\"result\":\"safe\"}"B), ct)
            do! wire.CompleteWritesAsync(ct)
        }
        use! server = startServer (Some endpoint) Options.defaults [ "headers" ] None ct
        use! client = startClient server.TunnelUri server.Users[0].Uuid Options.defaults [] [] ct
        use http = newHttpClient false
        use request = new HttpRequestMessage(HttpMethod.Post, client.Url("/v1/chat/completions"))
        request.Content <- new PiecesContent([ "ordinary request" ])
        request.Headers.TryAddWithoutValidation("Authorization", "Bearer caller-supplied-token") |> ignore
        for name in blocked do request.Headers.TryAddWithoutValidation(name, "forged-user-or-token") |> ignore
        use! response = http.SendAsync(request, ct)
        Assert.Equal(HttpStatusCode.OK, response.StatusCode)
        let returnedHeaders = Seq.append response.Headers response.Content.Headers |> Seq.map (fun field -> field.Key) |> Seq.toArray
        for name in [ "Authorization"; "Set-Cookie"; "X-Zproxy-Decoder"; "X-Zproxy-Metadata" ] do
            Assert.DoesNotContain(returnedHeaders, fun value -> value.Equals(name, StringComparison.OrdinalIgnoreCase))
        let! body = response.Content.ReadAsStringAsync(ct)
        Assert.Equal("{\"result\":\"safe\"}", body)
        Assert.DoesNotContain(gatewayToken, body)
        do! serve
    }

    [<Fact>]
    let ``Shared handlers use handshake identities and public reports separate users by nickname`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        let observed = ConcurrentQueue<Users.Identity * string>()
        let handler: RemoteHandler = fun identity request token -> task {
            Assert.False(request.Headers.Contains("Authorization"))
            Assert.False(request.Headers.Contains("X-User"))
            Assert.False(request.Headers.Contains("X-User-Id"))
            let! body = request.Content.ReadAsStringAsync(token)
            observed.Enqueue((identity, body))
            let response = new HttpResponseMessage(HttpStatusCode.OK)
            response.Content <- new StringContent("reply:" + body)
            return ({ Response = response; Metadata = Contracts.identity(Guid.NewGuid().ToString("N"), false) } : Contracts.RemoteReply)
        }
        use! server = startServer None Options.defaults [ "小林"; "Morgan" ] (Some handler) ct
        let first = server.Users[0]
        let second = server.Users[1]
        use! firstClient = startClient server.TunnelUri first.Uuid Options.defaults [] [] ct
        use! secondClient = startClient server.TunnelUri second.Uuid Options.defaults [] [] ct
        use http = newHttpClient false
        let submit (client: RunningClient) (pretend: Users.IssuedUser) text = task {
            use request = new HttpRequestMessage(HttpMethod.Post, client.Url("/v1/chat/completions"))
            request.Content <- new PiecesContent([ text ])
            request.Headers.Add("Authorization", "Bearer " + pretend.Uuid)
            request.Headers.Add("X-User", pretend.User.Id)
            request.Headers.Add("X-User-Id", pretend.User.Id)
            use! response = http.SendAsync(request, ct)
            Assert.Equal(HttpStatusCode.OK, response.StatusCode)
            let! body = response.Content.ReadAsStringAsync(ct)
            Assert.Equal("reply:" + text, body)
        }
        do! submit firstClient second "alpha-one"
        do! submit secondClient first "beta-one"
        do! submit firstClient second "alpha-two"
        let records = observed.ToArray()
        Assert.Equal(3, records.Length)
        for identity, body in records do
            let expected = if body.StartsWith("alpha", StringComparison.Ordinal) then first.User else second.User
            Assert.Equal(expected.Id, identity.Id)
            Assert.Equal(expected.Nickname, identity.Nickname)
        Assert.Equal(2, server.TunnelCount)
        let! body = publicReport server http [ first.User.Nickname, 2L; second.User.Nickname, 1L ] ct
        use document = JsonDocument.Parse(body)
        for row in document.RootElement.GetProperty("users").EnumerateArray() do
            let expected = if row.GetProperty("nickname").GetString() = first.User.Nickname then 2L else 1L
            Assert.Equal(expected, row.GetProperty("requests").GetInt64())
            Assert.Equal(expected, row.GetProperty("succeeded").GetInt64())
            Assert.Equal(0L, row.GetProperty("failed").GetInt64())
            Assert.Equal(0L, row.GetProperty("canceled").GetInt64())
            Assert.Equal((if expected = 2L then 18L else 8L), row.GetProperty("requestBytes").GetInt64())
            Assert.Equal((if expected = 2L then 30L else 14L), row.GetProperty("responseBytes").GetInt64())
            let fields = row.EnumerateObject() |> Seq.map (fun property -> property.Name) |> Seq.sort |> Seq.toArray
            Assert.Equal<string>(
                [| "active"; "canceled"; "durationMs"; "failed"; "nickname"; "requestBytes"; "requests"; "responseBytes"; "succeeded" |], fields)
        for issued in server.Users do
            let credential = Crypto.deriveUserCredential issued.Uuid
            for secret in [ issued.Uuid; issued.User.Id; Convert.ToHexString(credential.Selector)
                            Convert.ToBase64String(credential.Selector); Convert.ToBase64String(credential.Key) ] do
                Assert.DoesNotContain(secret, body, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain(adminPassword, body)
        Assert.DoesNotContain(gatewayToken, body)
        do! firstClient.StopAsync()
        do! secondClient.StopAsync()
        do! server.StopAsync()
        use users = new Users.Store(server.Directory)
        use statistics = new Statistics.Store(server.Directory, users.List)
        let saved = statistics.Snapshot() |> Array.map (fun row -> row.Nickname, row.Requests, row.Succeeded) |> Array.sort
        Assert.Equal<string * int64 * int64>([| first.User.Nickname, 2L, 2L; second.User.Nickname, 1L, 1L |] |> Array.sort, saved)
    }

    [<Fact>]
    let ``A local decoder receives typed metadata and converts raw provider bytes across the tunnel`` () = task {
        use deadline = new Deadline()
        let ct = deadline.Token
        let rawBody = "{\"providerText\":\"hello\"}"
        let openAiBody = "{\"choices\":[{\"text\":\"hello\"}],\"usage\":{\"total_tokens\":2}}"
        let metadata: Contracts.DecodeMetadata =
            { Decoder = "fixture-provider"; Version = 7; ModelAlias = "shared-public-model"
              RequestId = "decoder-request"; Attempt = 2; IsStreaming = false; Recipe = "" }
        let mutable remoteCalls = 0
        let mutable localCalls = 0
        let handler: RemoteHandler = fun identity request token -> task {
            Assert.Equal("decoder", identity.Nickname)
            let! submitted = request.Content.ReadAsStringAsync(token)
            Assert.Equal("decode this", submitted)
            Interlocked.Increment(&remoteCalls) |> ignore
            let response = new HttpResponseMessage(HttpStatusCode.Accepted)
            response.Content <- new StringContent(rawBody, Encoding.UTF8, "application/octet-stream")
            return ({ Response = response; Metadata = metadata } : Contracts.RemoteReply)
        }
        let decoder =
            { new IResponseDecoder with
                member _.Id = metadata.Decoder
                member _.Version = metadata.Version
                member _.Decode(request, received, response, token) = task {
                    use raw = response
                    Assert.Equal("/v1/completions", request.RequestUri.AbsolutePath)
                    Assert.Equal(metadata, received)
                    Assert.Equal(HttpStatusCode.Accepted, raw.StatusCode)
                    let! body = raw.Content.ReadAsStringAsync(token)
                    Assert.Equal(rawBody, body)
                    Interlocked.Increment(&localCalls) |> ignore
                    let converted = new HttpResponseMessage(HttpStatusCode.OK)
                    converted.Content <- new StringContent(openAiBody, Encoding.UTF8, "application/json")
                    return converted
                } }
        use! server = startServer None Options.defaults [ "decoder" ] (Some handler) ct
        use! client = startClient server.TunnelUri server.Users[0].Uuid Options.defaults [] [ decoder ] ct
        use http = newHttpClient false
        use! response = post http (client.Url("/v1/completions")) "decode this" HttpCompletionOption.ResponseContentRead ct
        Assert.Equal(HttpStatusCode.OK, response.StatusCode)
        Assert.Equal("application/json", response.Content.Headers.ContentType.MediaType)
        let! body = response.Content.ReadAsStringAsync(ct)
        Assert.Equal(openAiBody, body)
        Assert.DoesNotContain("providerText", body)
        Assert.Equal(1, remoteCalls)
        Assert.Equal(1, localCalls)
        let! report = publicReport server http [ "decoder", 1L ] ct
        use document = JsonDocument.Parse(report)
        let row = document.RootElement.GetProperty("users").[0]
        Assert.Equal(int64 (Encoding.UTF8.GetByteCount(rawBody)), row.GetProperty("responseBytes").GetInt64())
    }

    [<Fact>]
    let ``Admin UUID rotation ends active sessions and only the new credential can resume`` () = task {
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
            let! body = readAll first.Body ct
            Assert.Equal("active old credential", body)
            do! first.WriteHeadAsync(responseHead "text/event-stream", ct)
            do! first.Body.WriteAsync(ReadOnlyMemory<byte>("data: active\n\n"B), ct)
            do! first.Body.FlushAsync(ct)
            do! waitForPeerClose (firstSocket.GetStream()) ct
            closed.SetResult(())
            use! nextSocket = origin.AcceptTcpClientAsync(ct)
            use next = new HttpWire.Connection(nextSocket.GetStream())
            let! _ = next.ReadHeadAsync(ct)
            let! body = readAll next.Body ct
            Assert.Equal("new credential", body)
            do! reply next "new credential accepted" ct
        }
        use! server = startServer (Some endpoint) Options.defaults [ "rotated" ] None ct
        let user = server.Users[0]
        use! oldClient = startClient server.TunnelUri user.Uuid Options.defaults [] [] ct
        use http = newHttpClient false
        use! active = post http (oldClient.Url("/v1/chat/completions")) "active old credential" HttpCompletionOption.ResponseHeadersRead ct
        Assert.Equal(HttpStatusCode.OK, active.StatusCode)
        use! activeBody = active.Content.ReadAsStreamAsync(ct)
        let! first = readText activeBody "data: active\n\n".Length ct
        Assert.Equal("data: active\n\n", first)
        use admin = newHttpClient true
        use! login = mutate server admin HttpMethod.Post "/admin/login" (Some(jsonString "password" adminPassword)) ct
        Assert.Equal(HttpStatusCode.OK, login.StatusCode)
        Assert.True(login.Headers.Contains("Set-Cookie"))
        use! rotated = mutate server admin HttpMethod.Post ($"/admin/api/users/{user.User.Id}/rotate") None ct
        Assert.Equal(HttpStatusCode.OK, rotated.StatusCode)
        let! rotation = rotated.Content.ReadAsStringAsync(ct)
        use document = JsonDocument.Parse(rotation)
        let uuid = document.RootElement.GetProperty("uuid").GetString()
        Assert.NotEqual<string>(user.Uuid, uuid)
        Assert.Equal(user.User.Id, document.RootElement.GetProperty("user").GetProperty("id").GetString())
        do! waitForSignal closed.Task serve ct
        let! _ = Assert.ThrowsAnyAsync<IOException>(fun () -> readAll activeBody ct :> Task)
        use! denied = post http (oldClient.Url("/v1/chat/completions")) "old credential after rotation" HttpCompletionOption.ResponseContentRead ct
        Assert.Equal(HttpStatusCode.BadGateway, denied.StatusCode)
        use! nextClient = startClient server.TunnelUri uuid Options.defaults [] [] ct
        use! resumed = post http (nextClient.Url("/v1/chat/completions")) "new credential" HttpCompletionOption.ResponseContentRead ct
        Assert.Equal(HttpStatusCode.OK, resumed.StatusCode)
        let! body = resumed.Content.ReadAsStringAsync(ct)
        Assert.Equal("new credential accepted", body)
        do! serve
        Assert.False(origin.Pending())
        let! report = publicReport server http [ user.User.Nickname, 2L ] ct
        use totals = JsonDocument.Parse(report)
        let row = totals.RootElement.GetProperty("users")[0]
        Assert.Equal(1L, row.GetProperty("succeeded").GetInt64())
        Assert.Equal(1L, row.GetProperty("canceled").GetInt64())
        Assert.DoesNotContain(user.Uuid, report)
        Assert.DoesNotContain(uuid, report)
        Assert.DoesNotContain(user.User.Id, report)
    }
