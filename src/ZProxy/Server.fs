namespace ZProxy

open System
open System.Collections.Concurrent
open System.IO
open System.Net
open System.Net.Sockets
open System.Text
open System.Threading
open System.Threading.Channels
open System.Threading.Tasks

module Server =

    let private findHeaderEnd (buf: byte[]) (len: int) : int =
        let mutable i = 0
        let mutable found = -1
        while i <= len - 4 && found = -1 do
            if buf.[i] = 0x0Duy && buf.[i+1] = 0x0Auy && buf.[i+2] = 0x0Duy && buf.[i+3] = 0x0Auy then
                found <- i + 4
            else
                i <- i + 1
        found

    let private handleHttpConnection (tcpClient: TcpClient) (masterKey: byte[]) (upstream: Upstream.UpstreamClient) (replayFilter: Crypto.ReplayFilter) (rootCt: CancellationToken) =
        task {
            use _tcp = tcpClient
            let stream = tcpClient.GetStream()

            // 1. Read outer HTTP/1.1 Request Header per AGENTS.md 3.2
            use headerMs = new MemoryStream()
            let readBuf = Array.zeroCreate<byte> 4096
            let mutable headerEndIdx = -1
            let mutable clientEof = false

            while headerEndIdx = -1 && not clientEof do
                let! r = stream.ReadAsync(readBuf.AsMemory(), rootCt)
                if r = 0 then clientEof <- true
                else
                    headerMs.Write(readBuf, 0, r)
                    let fullArr = headerMs.ToArray()
                    let idx = findHeaderEnd fullArr fullArr.Length
                    if idx <> -1 then headerEndIdx <- idx

            if headerEndIdx <> -1 then
                let allBytes = headerMs.ToArray()
                let headerString = Encoding.UTF8.GetString(allBytes, 0, headerEndIdx)
                let leftover = allBytes.AsMemory(headerEndIdx, allBytes.Length - headerEndIdx)
                let lines = headerString.Split("\r\n", StringSplitOptions.RemoveEmptyEntries)
                let reqLine = lines.[0]
                let parts = reqLine.Split(' ')

                if parts.Length >= 2 then
                    let method = parts.[0].ToUpperInvariant()
                    let targetPath = parts.[1]

                    let mutable upgrade = ""
                    let mutable preambleHeader = ""
                    for i in 1 .. lines.Length - 1 do
                        let line = lines.[i]
                        let colonIdx = line.IndexOf(':')
                        if colonIdx > 0 then
                            let k = line.Substring(0, colonIdx).Trim()
                            let v = line.Substring(colonIdx + 1).Trim()
                            if k.Equals("upgrade", StringComparison.OrdinalIgnoreCase) then upgrade <- v
                            elif k.Equals("x-zproxy-preamble", StringComparison.OrdinalIgnoreCase) then preambleHeader <- v

                    // --- Branch A: Persistent HTTP/1.1 Upgrade Tunnel (AGENTS.md 3.2 Mode 1) ---
                    if targetPath.StartsWith("/api/v1/stream") && upgrade.Equals("zproxy-v1", StringComparison.OrdinalIgnoreCase) then
                        let preambleBytes =
                            if not (String.IsNullOrEmpty(preambleHeader)) then
                                try
                                    let padded = preambleHeader.Replace("-", "+").Replace("_", "/")
                                    let padLen = (4 - (padded.Length % 4)) % 4
                                    Convert.FromBase64String(padded + String.replicate padLen "=")
                                with _ -> Array.empty
                            else
                                // Fallback: read 32 bytes from body if not in header
                                if leftover.Length >= 32 then leftover.Slice(0, 32).ToArray()
                                else Array.empty

                        match Crypto.parsePreamble (ReadOnlySpan<byte>(preambleBytes)) with
                        | Error _ ->
                            let errResp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"B
                            do! stream.WriteAsync(errResp.AsMemory(), rootCt)
                        | Ok preamble ->
                            if not (replayFilter.Validate(preamble)) then
                                let errResp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"B
                                do! stream.WriteAsync(errResp.AsMemory(), rootCt)
                            else
                                // Send standard HTTP/1.1 101 Switching Protocols response
                                let upgradeResp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: zproxy-v1\r\nConnection: Upgrade\r\n\r\n"B
                                do! stream.WriteAsync(upgradeResp.AsMemory(), rootCt)
                                do! stream.FlushAsync(rootCt)

                                let sessionKeys = Crypto.deriveSessionKeys masterKey preambleBytes
                                use tunnel = new Tunnel.EncryptedZstdTunnel(stream, sessionKeys, preambleBytes, isClient = false)
                                let activeStreams = ConcurrentDictionary<uint32, ChannelWriter<byte[]> * CancellationTokenSource>()

                                let mutable active = true
                                while active && not rootCt.IsCancellationRequested do
                                    try
                                        let! frameOpt = tunnel.ReceiveFrameAsync(rootCt)
                                        match frameOpt with
                                        | None -> active <- false
                                        | Some frame ->
                                            match frame with
                                            | Frame.Frame.OpenRequest (sid, reqMethod, url, headers, hasEndStream) ->
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
                                                            let! resp = upstream.SendAsync(reqMethod, targetUri, headers, bodyChannel.Reader, streamCts.Token)
                                                            let statusCode = int resp.StatusCode
                                                            let protoByte =
                                                                if resp.Version = HttpVersion.Version30 then 30uy
                                                                elif resp.Version = HttpVersion.Version20 then 20uy
                                                                else 11uy

                                                            let respHeaders =
                                                                [ for kv in resp.Headers do
                                                                    for v in kv.Value do yield (kv.Key, v)
                                                                  if resp.Content <> null then
                                                                    for kv in resp.Content.Headers do
                                                                        for v in kv.Value do yield (kv.Key, v) ]

                                                            let hasNoBody = resp.Content = null
                                                            do! tunnel.SendFrameAsync(Frame.Frame.ResponseHeaders(sid, statusCode, protoByte, respHeaders, hasNoBody), rootCt)

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

                    // --- Branch B: Direct Single-Request Hex URL Mode (AGENTS.md 3.2 Mode 2) ---
                    else
                        match HttpUtils.parseTargetUrl targetPath with
                        | Ok targetUri ->
                            // Proxy single request directly to upstream
                            try
                                let emptyReader = Channel.CreateUnbounded<byte[]>().Reader
                                let! resp = upstream.SendAsync(method, targetUri, [], emptyReader, rootCt)
                                let sb = StringBuilder()
                                sb.AppendFormat("HTTP/1.1 {0} OK\r\n", int resp.StatusCode) |> ignore
                                for kv in resp.Headers do
                                    for v in kv.Value do sb.AppendFormat("{0}: {1}\r\n", kv.Key, v) |> ignore
                                if resp.Content <> null then
                                    for kv in resp.Content.Headers do
                                        for v in kv.Value do sb.AppendFormat("{0}: {1}\r\n", kv.Key, v) |> ignore
                                sb.Append("\r\n") |> ignore
                                let headBytes = Encoding.UTF8.GetBytes(sb.ToString())
                                do! stream.WriteAsync(headBytes.AsMemory(), rootCt)
                                if resp.Content <> null then
                                    use s = resp.Content.ReadAsStream(rootCt)
                                    do! s.CopyToAsync(stream, rootCt)
                            with _ ->
                                let errResp = "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"B
                                do! stream.WriteAsync(errResp.AsMemory(), rootCt)
                        | Error _ ->
                            let errResp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"B
                            do! stream.WriteAsync(errResp.AsMemory(), rootCt)
        }

    let start (listenHost: string) (listenPort: int) (masterPassword: string) (ct: CancellationToken) =
        task {
            let masterKey = Crypto.deriveMasterKey masterPassword
            let replayFilter = Crypto.ReplayFilter(60_000L)
            use upstream = new Upstream.UpstreamClient()
            let ip = IPAddress.Parse(listenHost)
            let listener = new TcpListener(ip, listenPort)
            listener.Start()
            printfn "[zproxy server] Listening on %s:%d (HTTP/1.1 Upgrade + Hex Proxy)" listenHost listenPort
            use _reg = ct.Register(fun () -> listener.Stop())

            while not ct.IsCancellationRequested do
                try
                    let! client = listener.AcceptTcpClientAsync(ct)
                    Task.Run(Func<Task>(fun () -> handleHttpConnection client masterKey upstream replayFilter ct :> Task)) |> ignore
                with _ -> ()
        }