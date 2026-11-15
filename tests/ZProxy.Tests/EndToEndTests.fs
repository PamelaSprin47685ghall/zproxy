namespace ZProxy.Tests

open System
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

    let private getFreePort () =
        let l = new TcpListener(IPAddress.Loopback, 0)
        l.Start()
        let port = (l.LocalEndpoint :?> IPEndPoint).Port
        l.Stop()
        port

    [<Fact>]
    let ``E2E: Client to Server encrypted streaming Zstd proxy with SSE response`` () =
        task {
            let mockPort = getFreePort ()
            let serverPort = getFreePort ()
            let clientPort = getFreePort ()
            let password = "E2E-Secure-Password-456"

            use cts = new CancellationTokenSource(TimeSpan.FromSeconds(15.0))

            // 1. Mock Upstream HTTP Server using TcpListener
            let mockListener = new TcpListener(IPAddress.Loopback, mockPort)
            mockListener.Start()

            let _mockTask =
                Task.Run(Func<Task>(fun () ->
                    task {
                        use! client = mockListener.AcceptTcpClientAsync(cts.Token)
                        let stream = client.GetStream()
                        use reader = new StreamReader(stream, Encoding.UTF8, false, 4096, leaveOpen = true)
                        // Read request headers
                        let mutable line = "start"
                        while not (String.IsNullOrEmpty(line)) do
                            let! l = reader.ReadLineAsync(cts.Token)
                            line <- l

                        // Send chunked SSE response
                        let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"B
                        do! stream.WriteAsync(headers.AsMemory(), cts.Token)

                        for i in 1 .. 5 do
                            let chunkText = sprintf "data: {\"chunk\": %d, \"text\": \"hello from mock upstream\"}\n\n" i
                            let chunkBytes = Encoding.UTF8.GetBytes(chunkText)
                            let header = Encoding.ASCII.GetBytes(sprintf "%x\r\n" chunkBytes.Length)
                            do! stream.WriteAsync(header.AsMemory(), cts.Token)
                            do! stream.WriteAsync(chunkBytes.AsMemory(), cts.Token)
                            do! stream.WriteAsync("\r\n"B.AsMemory(), cts.Token)
                            do! stream.FlushAsync(cts.Token)
                            do! Task.Delay(20)

                        do! stream.WriteAsync("0\r\n\r\n"B.AsMemory(), cts.Token)
                        do! stream.FlushAsync(cts.Token)
                    } :> Task
                ))

            // 2. Start zproxy server
            let _serverTask = Server.start "127.0.0.1" serverPort password cts.Token

            // 3. Start zproxy client
            let serverUri = Uri(sprintf "http://127.0.0.1:%d" serverPort)
            let _clientTask = Client.start "127.0.0.1" clientPort serverUri password cts.Token

            do! Task.Delay(200) // Allow listeners to bind

            // 4. Send request via local zproxy client
            use http = new HttpClient()
            let fullProxyUrl = sprintf "http://127.0.0.1:%d/http://127.0.0.1:%d/v1/chat/completions" clientPort mockPort

            let req = new HttpRequestMessage(HttpMethod.Post, fullProxyUrl)
            req.Content <- new StringContent("{\"prompt\":\"test e2e\"}", Encoding.UTF8, "application/json")
            let! resp = http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token)

            Assert.Equal(HttpStatusCode.OK, resp.StatusCode)
            Assert.Equal("text/event-stream", resp.Content.Headers.ContentType.MediaType)

            use s = resp.Content.ReadAsStream(cts.Token)
            use sr = new StreamReader(s, Encoding.UTF8)
            let! body = sr.ReadToEndAsync(cts.Token)

            Assert.Contains("\"chunk\": 1", body)
            Assert.Contains("\"chunk\": 5", body)
            Assert.Contains("hello from mock upstream", body)

            cts.Cancel()
            mockListener.Stop()
        }

    [<Fact>]
    let ``E2E: Tampered or invalid password client is rejected with 502 Bad Gateway`` () =
        task {
            let serverPort = getFreePort ()
            let clientPort = getFreePort ()
            let rightPassword = "CorrectPassword123"
            let wrongPassword = "WrongPassword999"

            use cts = new CancellationTokenSource(TimeSpan.FromSeconds(10.0))

            let _serverTask = Server.start "127.0.0.1" serverPort rightPassword cts.Token
            let serverUri = Uri(sprintf "http://127.0.0.1:%d" serverPort)
            let _clientTask = Client.start "127.0.0.1" clientPort serverUri wrongPassword cts.Token

            do! Task.Delay(200)

            use http = new HttpClient()
            let proxyUrl = sprintf "http://127.0.0.1:%d/https://api.mistral.ai/v1/models" clientPort
            let! resp = http.GetAsync(proxyUrl, cts.Token)

            Assert.Equal(HttpStatusCode.BadGateway, resp.StatusCode)

            cts.Cancel()
        }