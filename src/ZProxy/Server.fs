namespace ZProxy

open System
open System.Collections.Concurrent
open System.IO
open System.Net
open System.Net.Sockets
open System.Threading
open System.Threading.Channels
open System.Threading.Tasks

module Server =

    let private handleTunnelConnection (tcpClient: TcpClient) (masterKey: byte[]) (upstream: Upstream.UpstreamClient) (replayFilter: Crypto.ReplayFilter) (rootCt: CancellationToken) =
        task {
            use _tcp = tcpClient
            let stream = tcpClient.GetStream()

            // 1. Read 32-byte preamble
            let preambleBytes = Array.zeroCreate<byte> 32
            let mutable totalRead = 0
            while totalRead < 32 do
                let! r = stream.ReadAsync(preambleBytes.AsMemory(totalRead, 32 - totalRead), rootCt)
                if r = 0 then failwith "Client disconnected before preamble"
                totalRead <- totalRead + r

            match Crypto.parsePreamble (ReadOnlySpan<byte>(preambleBytes)) with
            | Error _ ->
                let errResp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"B
                do! stream.WriteAsync(errResp.AsMemory(), rootCt)
            | Ok preamble ->
                if not (replayFilter.Validate(preamble)) then
                    let errResp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"B
                    do! stream.WriteAsync(errResp.AsMemory(), rootCt)
                else
                    let sessionKeys = Crypto.deriveSessionKeys masterKey preambleBytes
                    use tunnel = new Tunnel.EncryptedZstdTunnel(stream, sessionKeys, isClient = false)
                    let activeStreams = ConcurrentDictionary<uint32, ChannelWriter<byte[]> * CancellationTokenSource>()

                    let mutable active = true
                    while active && not rootCt.IsCancellationRequested do
                        try
                            let! frameOpt = tunnel.ReceiveFrameAsync(rootCt)
                            match frameOpt with
                            | None -> active <- false
                            | Some frame ->
                                match frame with
                                | Frame.Frame.OpenRequest (sid, method, url, headers, hasEndStream) ->
                                    let bodyChannel = Channel.CreateUnbounded<byte[]>()
                                    let streamCts = CancellationTokenSource.CreateLinkedTokenSource(rootCt)
                                    activeStreams.[sid] <- (bodyChannel.Writer, streamCts)

                                    Task.Run(fun () ->
                                        task {
                                            use _cleanup =
                                                { new IDisposable with
                                                    member _.Dispose() = activeStreams.TryRemove(sid) |> ignore }
                                            try
                                                let targetUri = Uri(url)
                                                let! resp = upstream.SendAsync(method, targetUri, headers, bodyChannel.Reader, streamCts.Token)
                                                let statusCode = int resp.StatusCode
                                                let respHeaders =
                                                    [ for kv in resp.Headers do
                                                        for v in kv.Value do
                                                            yield (kv.Key, v)
                                                      if resp.Content <> null then
                                                        for kv in resp.Content.Headers do
                                                            for v in kv.Value do
                                                                yield (kv.Key, v)
                                                      yield ("X-Upstream-Proto", (if resp.Version = HttpVersion.Version30 then "HTTP/3.0" elif resp.Version = HttpVersion.Version20 then "HTTP/2.0" else "HTTP/1.1")) ]

                                                let hasNoBody = resp.Content = null
                                                do! tunnel.SendFrameAsync(Frame.Frame.ResponseHeaders(sid, statusCode, respHeaders, hasNoBody), rootCt)

                                                if not hasNoBody then
                                                    use respStream = resp.Content.ReadAsStream(streamCts.Token)
                                                    let buf = Array.zeroCreate<byte> 16384
                                                    let mutable reading = true
                                                    while reading && not streamCts.IsCancellationRequested do
                                                        let! r = respStream.ReadAsync(buf.AsMemory(0, buf.Length), streamCts.Token)
                                                        if r = 0 then
                                                            reading <- false
                                                            do! tunnel.SendFrameAsync(Frame.Frame.EndStream(sid), rootCt)
                                                        else
                                                            let chunk = Array.zeroCreate<byte> r
                                                            Array.Copy(buf, 0, chunk, 0, r)
                                                            do! tunnel.SendFrameAsync(Frame.Frame.Data(sid, chunk, false), rootCt)
                                            with ex ->
                                                let _ = tunnel.SendFrameAsync(Frame.Frame.CancelStream(sid, ex.Message), CancellationToken.None)
                                                ()
                                        } :> Task
                                    ) |> ignore

                                | Frame.Frame.Data (sid, data, isEnd) ->
                                    match activeStreams.TryGetValue(sid) with
                                    | true, (writer, _) ->
                                        writer.TryWrite(data) |> ignore
                                        if isEnd then writer.TryComplete() |> ignore
                                    | _ -> ()

                                | Frame.Frame.EndStream sid ->
                                    match activeStreams.TryGetValue(sid) with
                                    | true, (writer, _) -> writer.TryComplete() |> ignore
                                    | _ -> ()

                                | Frame.Frame.CancelStream (sid, _) ->
                                    match activeStreams.TryRemove(sid) with
                                    | true, (writer, cts) ->
                                        cts.Cancel()
                                        writer.TryComplete() |> ignore
                                    | _ -> ()

                                | Frame.Frame.Ping p ->
                                    do! tunnel.SendFrameAsync(Frame.Frame.Pong p, rootCt)

                                | _ -> ()
                        with _ ->
                            active <- false
        }

    let start (listenHost: string) (listenPort: int) (masterPassword: string) (ct: CancellationToken) =
        task {
            let masterKey = Crypto.deriveMasterKey masterPassword
            let replayFilter = Crypto.ReplayFilter(60_000L)
            use upstream = new Upstream.UpstreamClient()
            let ip = IPAddress.Parse(listenHost)
            let listener = new TcpListener(ip, listenPort)
            listener.Start()
            printfn "[zproxy server] Listening on %s:%d" listenHost listenPort
            use _reg = ct.Register(fun () -> listener.Stop())

            while not ct.IsCancellationRequested do
                try
                    let! client = listener.AcceptTcpClientAsync(ct)
                    Task.Run(fun () -> handleTunnelConnection client masterKey upstream replayFilter ct :> Task) |> ignore
                with _ -> ()
        }