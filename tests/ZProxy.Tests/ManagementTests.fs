namespace ZProxy.Tests

open System
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

module ManagementTests =
    let private masterPassword = "management-test-master-password"

    type private Running(directory: string, endpoint: IPEndPoint, users: Users.Store,
                         statistics: Statistics.Store, source: CancellationTokenSource, work: Task) =
        let mutable disposed = 0
        member _.BaseUri = Uri($"http://127.0.0.1:{endpoint.Port}")
        member _.Users = users
        member _.Statistics = statistics
        member _.Token = source.Token
        interface IAsyncDisposable with
            member _.DisposeAsync() = ValueTask(task {
                if Interlocked.Exchange(&disposed, 1) = 0 then
                    try
                        source.Cancel()
                        do! work.WaitAsync(TimeSpan.FromSeconds(5.0))
                    finally
                        (statistics :> IDisposable).Dispose()
                        (users :> IDisposable).Dispose()
                        source.Dispose()
                        Directory.Delete(directory, true)
            })

    let private startWith (routing: (CancellationToken -> Task<string option>) option) = task {
        let directory = Path.Combine(Path.GetTempPath(), "zproxy-management-test-" + Guid.NewGuid().ToString("N"))
        let users = new Users.Store(directory)
        let statistics = new Statistics.Store(directory, users.List)
        let source = new CancellationTokenSource(TimeSpan.FromSeconds(30.0))
        use reservation = new TcpListener(IPAddress.Loopback, 0)
        reservation.Start()
        let endpoint = reservation.LocalEndpoint :?> IPEndPoint
        reservation.Stop()
        let work = Management.run(endpoint, masterPassword, users, statistics, routing, source.Token)
        let running = new Running(directory, endpoint, users, statistics, source, work)
        try
            let mutable ready = false
            while not ready do
                if work.IsCompleted then
                    do! work
                    failwith "The management listener stopped before it was ready."
                use probe = new TcpClient()
                try
                    do! probe.ConnectAsync(endpoint.Address, endpoint.Port, source.Token)
                    ready <- true
                with :? SocketException -> do! Task.Delay(10, source.Token)
            return running
        with error ->
            do! (running :> IAsyncDisposable).DisposeAsync()
            return raise error
    }

    let private start () = startWith None

    let private newClient () =
        let handler = new SocketsHttpHandler(UseProxy = false, UseCookies = true, AllowAutoRedirect = false)
        new HttpClient(handler, true, Timeout = TimeSpan.FromSeconds(10.0))

    let private jsonString (name: string) (value: string) =
        use body = new MemoryStream()
        use writer = new Utf8JsonWriter(body)
        writer.WriteStartObject()
        writer.WriteString(name, value)
        writer.WriteEndObject()
        writer.Flush()
        Encoding.UTF8.GetString(body.ToArray())

    let private request (running: Running) (client: HttpClient) (method: HttpMethod) (path: string)
                        (body: string option) (origin: string option) = task {
        use message = new HttpRequestMessage(method, Uri(running.BaseUri, path))
        match body with
        | Some value -> message.Content <- new StringContent(value, Encoding.UTF8, "application/json")
        | None -> ()
        match origin with
        | Some value -> message.Headers.TryAddWithoutValidation("Origin", value) |> ignore
        | None -> ()
        return! client.SendAsync(message, running.Token)
    }

    let private mutate running client method path body =
        request running client method path body (Some (running.BaseUri.GetLeftPart(UriPartial.Authority)))

    let private login running client password =
        mutate running client HttpMethod.Post "/admin/login" (Some(jsonString "password" password))

    let private text (running: Running) (response: HttpResponseMessage) = response.Content.ReadAsStringAsync(running.Token)

    let private issued (body: string) =
        use document = JsonDocument.Parse(body)
        document.RootElement.GetProperty("user").GetProperty("id").GetString(), document.RootElement.GetProperty("uuid").GetString()

    [<Fact>]
    let ``Routing statistics require a session and never replace a failed read with zeros`` () = task {
        // The bridge answers one shape in every state, so the page can render a
        // reason instead of a number. A refusal is not an empty report.
        let summary = """{"schemaVersion":1,"available":true,"reason":null,"metrics":[],"aggregate":{}}"""
        let calls = ref 0
        let read (_: CancellationToken) = task {
            calls.Value <- calls.Value + 1
            return Some summary }
        use! running = startWith (Some read)
        use anonymous = newClient ()
        use admin = newClient ()

        use! unauthorized = request running anonymous HttpMethod.Get "/admin/api/routing" None None
        Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode)
        Assert.Equal(0, calls.Value)

        use! unlocked = login running admin masterPassword
        Assert.Equal(HttpStatusCode.OK, unlocked.StatusCode)

        // A successful read is forwarded verbatim, with a JSON content type.
        use! forwarded = request running admin HttpMethod.Get "/admin/api/routing" None None
        Assert.Equal(HttpStatusCode.OK, forwarded.StatusCode)
        Assert.Equal("application/json", forwarded.Content.Headers.ContentType.MediaType)
        let! body = text running forwarded
        Assert.Equal(summary, body)
        Assert.Equal(1, calls.Value)

        // A failed read is a stated unavailability, never an empty snapshot.
        use! failing = startWith (Some(fun _ -> task { return (None: string option) }))
        use failingAdmin = newClient ()
        use! failingUnlock = login failing failingAdmin masterPassword
        Assert.Equal(HttpStatusCode.OK, failingUnlock.StatusCode)
        use! unavailable = request failing failingAdmin HttpMethod.Get "/admin/api/routing" None None
        Assert.Equal(HttpStatusCode.OK, unavailable.StatusCode)
        let! unavailableBody = text failing unavailable
        use document = JsonDocument.Parse(unavailableBody)
        Assert.False(document.RootElement.GetProperty("available").GetBoolean())
        Assert.False(String.IsNullOrWhiteSpace(document.RootElement.GetProperty("reason").GetString()))
    }

    [<Fact>]
    let ``Admin creates and rotates UUIDs while public reports contain only nickname counters`` () = task {
        use! running = start ()
        use admin = newClient ()
        use anonymous = newClient ()
        use! denied = mutate running anonymous HttpMethod.Post "/admin/api/users" (Some(jsonString "nickname" "no access"))
        Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode)

        use! unlocked = login running admin masterPassword
        Assert.Equal(HttpStatusCode.OK, unlocked.StatusCode)
        let cookie = unlocked.Headers.GetValues("Set-Cookie") |> Seq.exactlyOne
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("samesite=strict", cookie, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("path=/admin", cookie, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("max-age=1800", cookie, StringComparison.OrdinalIgnoreCase)

        let nickname = "小林 <b>测试</b>"
        use! created = mutate running admin HttpMethod.Post "/admin/api/users" (Some(jsonString "nickname" nickname))
        Assert.Equal(HttpStatusCode.Created, created.StatusCode)
        let! createdBody = text running created
        let id, uuid = issued createdBody
        Assert.True(Guid.TryParseExact(uuid, "D") |> fst)
        let info = running.Users.List() |> Array.exactlyOne
        Assert.Equal(id, info.Id)
        use activity = running.Statistics.Begin({ Id = id; Nickname = nickname })
        activity.Finish(Statistics.Succeeded, 17L, 29L, 101L)

        use! report = anonymous.GetAsync(Uri(running.BaseUri, "/api/reports"), running.Token)
        Assert.Equal(HttpStatusCode.OK, report.StatusCode)
        let! publicBody = text running report
        use document = JsonDocument.Parse(publicBody)
        // Storage health is a process-wide fact, not a user measurement.
        let store = document.RootElement.GetProperty("store")
        Assert.True(store.GetProperty("available").GetBoolean())
        Assert.Equal("file", store.GetProperty("mode").GetString())
        Assert.Equal(24L, int64 (store.GetProperty("keepHours").GetInt32()))
        let row = document.RootElement.GetProperty("users")[0]
        Assert.Equal(nickname, row.GetProperty("nickname").GetString())
        Assert.Equal(1L, row.GetProperty("requests").GetInt64())
        Assert.Equal(29L, row.GetProperty("responseBytes").GetInt64())
        let fields = row.EnumerateObject() |> Seq.map (fun field -> field.Name) |> Seq.sort |> Seq.toArray
        Assert.Equal<string>(
            [| "active"; "buffered"; "canceled"; "durationMs"; "failed"; "headersLatency"; "kinds";
               "lastSeen"; "latency"; "nickname"; "peakActive"; "requestBytes"; "requests";
               "responseBytes"; "series"; "statusBuckets"; "streamed"; "succeeded" |], fields)
        let buckets = row.GetProperty("statusBuckets")
        Assert.Equal(1L, buckets.GetProperty("2xx").GetInt64())
        Assert.Equal(0L, buckets.GetProperty("noResponse").GetInt64())
        Assert.Equal(1L, row.GetProperty("kinds").GetProperty("chat").GetInt64())
        Assert.Equal(1L, row.GetProperty("buffered").GetInt64())
        Assert.Equal(0L, row.GetProperty("streamed").GetInt64())
        Assert.Equal(1L, row.GetProperty("peakActive").GetInt64())
        Assert.False(row.GetProperty("lastSeen").ValueKind = JsonValueKind.Null)
        let credential = Crypto.deriveUserCredential uuid
        for secret in [ uuid; id; masterPassword; Convert.ToHexString(credential.Selector); Convert.ToBase64String(credential.Key) ] do
            Assert.DoesNotContain(secret, publicBody, StringComparison.Ordinal)

        use! page = anonymous.GetAsync(Uri(running.BaseUri, "/reports"), running.Token)
        let! html = text running page
        Assert.DoesNotContain(nickname, html, StringComparison.Ordinal)
        Assert.DoesNotContain(uuid, html, StringComparison.Ordinal)
        Assert.DoesNotContain(id, html, StringComparison.Ordinal)
        Assert.DoesNotContain("innerHTML", html, StringComparison.Ordinal)
        Assert.Contains("/assets/", html, StringComparison.Ordinal)
        // The shell CSP has no unsafe-inline: an inline style would be dropped silently.
        // The skip link and its focus target must survive, because CSP forbids styling them inline.
        Assert.DoesNotContain("style=", html, StringComparison.Ordinal)
        Assert.Contains("class=\"skip-link\"", html, StringComparison.Ordinal)
        Assert.Contains("id=\"main-content\"", html, StringComparison.Ordinal)
        let start = html.IndexOf("/assets/", StringComparison.Ordinal)
        let finish = html.IndexOf('"', start)
        let asset = html.Substring(start, finish - start)
        use! script = anonymous.GetAsync(Uri(running.BaseUri, asset), running.Token)
        Assert.Equal(HttpStatusCode.OK, script.StatusCode)
        Assert.Contains("immutable", script.Headers.CacheControl.ToString(), StringComparison.Ordinal)
        Assert.True(page.Headers.Contains("Content-Security-Policy"))

        use! listed = admin.GetAsync(Uri(running.BaseUri, "/admin/api/users"), running.Token)
        let! listBody = text running listed
        Assert.DoesNotContain(uuid, listBody, StringComparison.Ordinal)

        use! userCannotUnlock = login running anonymous uuid
        Assert.Equal(HttpStatusCode.Unauthorized, userCannotUnlock.StatusCode)
        use! stillLocked = anonymous.GetAsync(Uri(running.BaseUri, "/admin/api/users"), running.Token)
        Assert.Equal(HttpStatusCode.Unauthorized, stillLocked.StatusCode)

        use! rotated = mutate running admin HttpMethod.Post ($"/admin/api/users/{id}/rotate") None
        Assert.Equal(HttpStatusCode.OK, rotated.StatusCode)
        let! rotatedBody = text running rotated
        let nextId, nextUuid = issued rotatedBody
        Assert.Equal(id, nextId)
        Assert.NotEqual<string>(uuid, nextUuid)
        Assert.Equal(1L, running.Statistics.Snapshot().[0].Requests)

        use! revoked = mutate running admin HttpMethod.Delete ($"/admin/api/users/{id}") None
        Assert.Equal(HttpStatusCode.NoContent, revoked.StatusCode)
        Assert.False(running.Users.List().[0].Enabled)
        use! locked = mutate running admin HttpMethod.Post "/admin/logout" None
        Assert.Equal(HttpStatusCode.NoContent, locked.StatusCode)
        use! afterLogout = admin.GetAsync(Uri(running.BaseUri, "/admin/api/users"), running.Token)
        Assert.Equal(HttpStatusCode.Unauthorized, afterLogout.StatusCode)
    }

    [<Fact>]
    let ``Admin mutations require the page origin and bounded JSON`` () = task {
        use! running = start ()
        use admin = newClient ()
        let password = Some(jsonString "password" masterPassword)
        use! missing = request running admin HttpMethod.Post "/admin/login" password None
        Assert.Equal(HttpStatusCode.Forbidden, missing.StatusCode)
        use! wrong = request running admin HttpMethod.Post "/admin/login" password (Some "https://other.test")
        Assert.Equal(HttpStatusCode.Forbidden, wrong.StatusCode)
        use! unlocked = login running admin masterPassword
        Assert.Equal(HttpStatusCode.OK, unlocked.StatusCode)
        use! crossOrigin = request running admin HttpMethod.Post "/admin/api/users" (Some(jsonString "nickname" "not created")) (Some "https://other.test")
        Assert.Equal(HttpStatusCode.Forbidden, crossOrigin.StatusCode)
        Assert.Empty(running.Users.List())

        use! tooLarge = mutate running admin HttpMethod.Post "/admin/api/users" (Some(jsonString "nickname" (String('x', 5000))))
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooLarge.StatusCode)
        use! duplicate = mutate running admin HttpMethod.Post "/admin/login" (Some "{\"password\":\"one\",\"password\":\"two\"}")
        Assert.Equal(HttpStatusCode.BadRequest, duplicate.StatusCode)
        let! error = text running duplicate
        Assert.DoesNotContain(masterPassword, error, StringComparison.Ordinal)
        Assert.True(duplicate.Headers.CacheControl.NoStore)
        Assert.Empty(running.Users.List())
    }

    [<Fact>]
    let ``Failed admin login is rate limited and cannot create a session`` () = task {
        use! running = start ()
        use client = newClient ()
        for _ in 1 .. 8 do
            use! wrong = login running client "wrong-master-password"
            Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode)
        use! limited = login running client masterPassword
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode)
        Assert.True(limited.Headers.Contains("Retry-After"))
        use! privatePage = client.GetAsync(Uri(running.BaseUri, "/admin/api/users"), running.Token)
        Assert.Equal(HttpStatusCode.Unauthorized, privatePage.StatusCode)
        use! report = client.GetAsync(Uri(running.BaseUri, "/api/reports"), running.Token)
        Assert.Equal(HttpStatusCode.OK, report.StatusCode)
    }

    [<Fact>]
    let ``Trusted loopback HTTPS termination issues a secure admin cookie`` () = task {
        use! running = start ()
        use client = newClient ()
        use clearPage = new HttpRequestMessage(HttpMethod.Get, Uri(running.BaseUri, "/admin"))
        clearPage.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "http") |> ignore
        use! page = client.SendAsync(clearPage, running.Token)
        Assert.Equal(HttpStatusCode.Forbidden, page.StatusCode)
        let! pageBody = text running page
        Assert.DoesNotContain("<form", pageBody, StringComparison.Ordinal)
        Assert.Contains("HTTPS", pageBody, StringComparison.Ordinal)
        use clearRequest = new HttpRequestMessage(HttpMethod.Post, Uri(running.BaseUri, "/admin/login"))
        clearRequest.Headers.TryAddWithoutValidation("Origin", running.BaseUri.GetLeftPart(UriPartial.Authority)) |> ignore
        clearRequest.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "http") |> ignore
        clearRequest.Content <- new StringContent(jsonString "password" masterPassword, Encoding.UTF8, "application/json")
        use! rejected = client.SendAsync(clearRequest, running.Token)
        Assert.Equal(HttpStatusCode.Forbidden, rejected.StatusCode)
        use request = new HttpRequestMessage(HttpMethod.Post, Uri(running.BaseUri, "/admin/login"))
        request.Headers.TryAddWithoutValidation("Origin", $"https://127.0.0.1:{running.BaseUri.Port}") |> ignore
        request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "https") |> ignore
        request.Content <- new StringContent(jsonString "password" masterPassword, Encoding.UTF8, "application/json")
        use! response = client.SendAsync(request, running.Token)
        Assert.Equal(HttpStatusCode.OK, response.StatusCode)
        let cookie = response.Headers.GetValues("Set-Cookie") |> Seq.exactlyOne
        Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase)
    }

    [<Fact>]
    let ``Shutdown cancels an unfinished admin request body`` () = task {
        use! running = start ()
        use peer = new TcpClient()
        do! peer.ConnectAsync(IPAddress.Loopback, running.BaseUri.Port, running.Token)
        use wire = peer.GetStream()
        let head =
            $"POST /admin/login HTTP/1.1\r\nHost: {running.BaseUri.Authority}\r\nOrigin: {running.BaseUri.GetLeftPart(UriPartial.Authority)}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n"
        do! wire.WriteAsync(Encoding.ASCII.GetBytes(head).AsMemory(), running.Token)
        let block = Array.zeroCreate<byte> 1
        let response = StringBuilder()
        while not (response.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal)) do
            let! count = wire.ReadAsync(block.AsMemory(), running.Token)
            Assert.Equal(1, count)
            response.Append(char block[0]) |> ignore
            Assert.True(response.Length <= 256)
        Assert.StartsWith("HTTP/1.1 100 Continue", response.ToString(), StringComparison.Ordinal)
        do! (running :> IAsyncDisposable).DisposeAsync()
    }
