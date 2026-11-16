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

module Client =

    type InflightStream =
        { OutgoingBodyChannel: ChannelWriter<byte[]>
          ResponseHeadersTask: TaskCompletionSource<int * byte * (string * string) list * bool>
          ResponseBodyChannel: Channel<byte[] * bool>
          Cts: CancellationTokenSource }

    type TunnelManager(serverUri: Uri, masterPassword: string) =
        let masterKey = Crypto.deriveMasterKey masterPassword
        let mutable currentTunnel : Tunnel.EncryptedZstdTunnel option = None
        let mutable currentTcp : TcpClient option = None
        let mutable nextStreamId = 1u
        let inflight = ConcurrentDictionary<uint32, InflightStream>()
        let connLock = new SemaphoreSlim(1, 1)

        let rec readLoop (tunnel: Tunnel.EncryptedZstdTunnel) (tcp: TcpClient) =
            task {
                try
                    let mutable active = true
                    while active do
                        let! frameOpt = tunnel.ReceiveFrameAsync(CancellationToken.None)
                        match frameOpt with
                        | None -> active <- false
                        | Some frame ->
                            match frame with
                            | Frame.Frame.ResponseHeaders (sid, status, protoVer, hdrs, es) ->
                                match inflight.TryGetValue(sid) with
                                | true, s -> s.ResponseHeadersTask.TrySetResult((status, protoVer, hdrs, es)) |> ignore
                                | _ -> ()

                            | Frame.Frame.Data (sid, data, es) ->
                                match inflight.TryGetValue(sid) with
                                | true, s ->
                                    s.ResponseBodyChannel.Writer.TryWrite((data, es)) |> ignore
                                    if es then
                                        s.ResponseBodyChannel.Writer.TryComplete() |> ignore
                                        inflight.TryRemove(sid) |> ignore
                                | _ -> ()

                            | Frame.Frame.EndStream sid ->
                                match inflight.TryGetValue(sid) with
                                | true, s ->
                                    s.ResponseBodyChannel.Writer.TryComplete() |> ignore
                                    inflight.TryRemove(sid) |> ignore
                                | _ -> ()

                            | Frame.Frame.CancelStream (sid, reason) ->
                                match inflight.TryRemove(sid) with
                                | true, s ->
                                    s.ResponseHeadersTask.TrySetException(Exception("Stream cancelled by remote: " + reason)) |> ignore
                                    s.Cts.Cancel()
                                    s.ResponseBodyChannel.Writer.TryComplete() |> ignore
                                | _ -> ()

                            | Frame.Frame.Ping p ->
                                do! tunnel.SendFrameAsync(Frame.Frame.Pong p, CancellationToken.None)

                            | _ -> ()
                with _ ->
                    ()
                for kv in inflight do
                    kv.Value.ResponseHeadersTask.TrySetException(Exception("Tunnel disconnected")) |> ignore
                    kv.Value.ResponseBodyChannel.Writer.TryComplete() |> ignore
                inflight.Clear()
            }

        member this.GetTunnelAsync(ct: CancellationToken) : Task<Tunnel.EncryptedZstdTunnel> =
            task {
                do! connLock.WaitAsync(ct)
                try
                    match currentTunnel, currentTcp with
                    | Some t, Some tcp when tcp.Connected ->
                        return t
                    | _ ->
                        let tcp = new TcpClient()
                        do! tcp.ConnectAsync(serverUri.Host, serverUri.Port, ct)
                        let ns = tcp.GetStream()

                        // Send standard HTTP/1.1 Upgrade request per AGENTS.md 3.2
                        let preambleBytes, preamble = Crypto.createPreamble ()
                        let preambleB64 = Convert.ToBase64String(preambleBytes).Replace("+", "-").Replace("/", "_").TrimEnd('=')
                        let upgradeReq =
                            sprintf "POST /api/v1/stream HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: zproxy-v1\r\nX-Zproxy-Preamble: %s\r\n\r\n"
                                serverUri.Authority preambleB64
                        let reqBytes = Encoding.ASCII.GetBytes(upgradeReq)
                        do! ns.WriteAsync(reqBytes.AsMemory(), ct)
                        do! ns.FlushAsync(ct)

                        // Read HTTP/1.1 101 Switching Protocols response
                        let headerBuf = Array.zeroCreate<byte> 1024
                        let mutable hRead = 0
                        let mutable endOfHeader = -1
                        while endOfHeader = -1 do
                            let! r = ns.ReadAsync(headerBuf.AsMemory(hRead, headerBuf.Length - hRead), ct)
                            if r = 0 then failwith "Server closed connection during HTTP/1.1 Upgrade handshake"
                            hRead <- hRead + r
                            for i in 0 .. hRead - 4 do
                                if headerBuf.[i] = 0x0Duy && headerBuf.[i+1] = 0x0Auy && headerBuf.[i+2] = 0x0Duy && headerBuf.[i+3] = 0x0Auy then
                                    endOfHeader <- i + 4

                        let respLine = Encoding.ASCII.GetString(headerBuf, 0, min hRead 32)
                        if not (respLine.StartsWith("HTTP/1.1 101")) then
                            failwithf "Server rejected HTTP/1.1 Upgrade: %s" respLine

                        let sessionKeys = Crypto.deriveSessionKeys masterKey preambleBytes
                        let tunnel = new Tunnel.EncryptedZstdTunnel(ns, sessionKeys, preambleBytes, isClient = true)
                        currentTunnel <- Some tunnel
                        currentTcp <- Some tcp
                        Task.Run(Func<Task>(fun () -> readLoop tunnel tcp :> Task)) |> ignore
                        return tunnel
                finally
                    connLock.Release() |> ignore
            }

        member this.CreateStream() : uint32 * InflightStream =
            let sid = Interlocked.Add(&nextStreamId, 2u) - 2u // Odd numbers: 1, 3, 5...
            let outBody = Channel.CreateUnbounded<byte[]>()
            let inBody = Channel.CreateUnbounded<byte[] * bool>()
            let tcs = TaskCompletionSource<int * byte * (string * string) list * bool>()
            let cts = new CancellationTokenSource()
            let stream =
                { OutgoingBodyChannel = outBody.Writer
                  ResponseHeadersTask = tcs
                  ResponseBodyChannel = inBody
                  Cts = cts }
            inflight.[sid] <- stream
            sid, stream

        member this.CancelStream(sid: uint32) =
            match inflight.TryRemove(sid) with
            | true, s ->
                s.Cts.Cancel()
                s.ResponseBodyChannel.Writer.TryComplete() |> ignore
                match currentTunnel with
                | Some t ->
                    Task.Run(Func<Task>(fun () -> t.SendFrameAsync(Frame.Frame.CancelStream(sid, "local client closed"), CancellationToken.None) :> Task)) |> ignore
                | None -> ()
            | false, _ -> ()

    let private findHeaderEnd (buf: byte[]) (len: int) : int =
        let mutable i = 0
        let mutable found = -1
        while i <= len - 4 && found = -1 do
            if buf.[i] = 0x0Duy && buf.[i+1] = 0x0Auy && buf.[i+2] = 0x0Duy && buf.[i+3] = 0x0Auy then
                found <- i + 4
            else
                i <- i + 1
        found

    let private handleLocalConnection (tcpClient: TcpClient) (manager: TunnelManager) (rootCt: CancellationToken) =
        task {
            use _tcp = tcpClient
            let stream = tcpClient.GetStream()

            let mutable keepAlive = true
            while keepAlive && not rootCt.IsCancellationRequested do
                use headerMs = new MemoryStream()
                let readBuf = Array.zeroCreate<byte> 4096
                let mutable headerEndIdx = -1
                let mutable clientEof = false

                while headerEndIdx = -1 && not clientEof do
                    let! r = stream.ReadAsync(readBuf.AsMemory(), rootCt)
                    if r = 0 then
                        clientEof <- true
                    else
                        let prevLen = int headerMs.Length
                        headerMs.Write(readBuf, 0, r)
                        let fullArr = headerMs.ToArray()
                        let idx = findHeaderEnd fullArr fullArr.Length
                        if idx <> -1 then
                            headerEndIdx <- idx

                if clientEof && headerMs.Length = 0L then
                    keepAlive <- false
                elif headerEndIdx = -1 then
                    keepAlive <- false
                else
                    let allBytes = headerMs.ToArray()
                    let headerString = Encoding.UTF8.GetString(allBytes, 0, headerEndIdx)
                    let leftoverBody = allBytes.AsMemory(headerEndIdx, allBytes.Length - headerEndIdx)

                    let lines = headerString.Split("\r\n", StringSplitOptions.RemoveEmptyEntries)
                    let reqLine = lines.[0]
                    let parts = reqLine.Split(' ')
                    let method = parts.[0].ToUpperInvariant()
                    let rawTarget = parts.[1]

                    let mutable headers = []
                    let mutable contentLength = 0L
                    let mutable isChunked = false
                    for i in 1 .. lines.Length - 1 do
                        let line = lines.[i]
                        let colonIdx = line.IndexOf(':')
                        if colonIdx > 0 then
                            let k = line.Substring(0, colonIdx).Trim()
                            let v = line.Substring(colonIdx + 1).Trim()
                            headers <- (k, v) :: headers
                            if k.Equals("content-length", StringComparison.OrdinalIgnoreCase) then
                                Int64.TryParse(v, &contentLength) |> ignore
                            elif k.Equals("transfer-encoding", StringComparison.OrdinalIgnoreCase) && v.Contains("chunked") then
                                isChunked <- true

                    match HttpUtils.parseTargetUrl rawTarget with
                    | Error err ->
                        let resp = sprintf "HTTP/1.1 400 Bad Request\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" err.Length err
                        let b = Encoding.UTF8.GetBytes(resp)
                        do! stream.WriteAsync(b.AsMemory(), rootCt)
                        keepAlive <- false
                    | Ok targetUri ->
                        let sid, streamState = manager.CreateStream()
                        try
                            let! tunnel = manager.GetTunnelAsync(rootCt)
                            let hasNoBody = method = "GET" || method = "HEAD" || (contentLength = 0L && not isChunked && leftoverBody.Length = 0)

                            do! tunnel.SendFrameAsync(Frame.Frame.OpenRequest(sid, method, targetUri.ToString(), headers, hasNoBody), rootCt)

                            if not hasNoBody then
                                Task.Run(Func<Task>(fun () ->
                                    task {
                                        try
                                            let mutable remaining = contentLength
                                            if leftoverBody.Length > 0 then
                                                let count = int (min (int64 leftoverBody.Length) remaining)
                                                remaining <- remaining - int64 count
                                                let isEnd = (remaining = 0L && not isChunked)
                                                let slice = leftoverBody.Slice(0, count).ToArray()
                                                do! tunnel.SendFrameAsync(Frame.Frame.Data(sid, slice, isEnd), rootCt)

                                            let buf = Array.zeroCreate<byte> 16384
                                            while remaining > 0L do
                                                let toRead = int (min (int64 buf.Length) remaining)
                                                let! r = stream.ReadAsync(buf.AsMemory(0, toRead), rootCt)
                                                if r = 0 then remaining <- 0L
                                                else
                                                    remaining <- remaining - int64 r
                                                    let isEnd = remaining = 0L
                                                    let slice = Array.zeroCreate<byte> r
                                                    Array.Copy(buf, 0, slice, 0, r)
                                                    do! tunnel.SendFrameAsync(Frame.Frame.Data(sid, slice, isEnd), rootCt)

                                            if isChunked then
                                                do! tunnel.SendFrameAsync(Frame.Frame.EndStream(sid), rootCt)
                                        with _ ->
                                            manager.CancelStream(sid)
                                    } :> Task
                                )) |> ignore

                            let! status, protoVer, respHeaders, respHasEnd = streamState.ResponseHeadersTask.Task
                            let sb = StringBuilder()
                            sb.AppendFormat("HTTP/1.1 {0} OK\r\n", status) |> ignore
                            let mutable hasChunked = false
                            for (k, v) in respHeaders do
                                if not (k.Equals("connection", StringComparison.OrdinalIgnoreCase)) then
                                    sb.AppendFormat("{0}: {1}\r\n", k, v) |> ignore
                                    if k.Equals("transfer-encoding", StringComparison.OrdinalIgnoreCase) && v.Contains("chunked") then
                                        hasChunked <- true
                            let protoStr = if protoVer = 30uy then "HTTP/3.0" elif protoVer = 20uy then "HTTP/2.0" else "HTTP/1.1"
                            sb.AppendFormat("X-Upstream-Proto: {0}\r\n", protoStr) |> ignore

                            if not hasChunked && not (List.exists (fun (k: string, _) -> k.Equals("content-length", StringComparison.OrdinalIgnoreCase)) respHeaders) then
                                sb.Append("Transfer-Encoding: chunked\r\n") |> ignore
                                hasChunked <- true
                            sb.Append("\r\n") |> ignore

                            let headBytes = Encoding.UTF8.GetBytes(sb.ToString())
                            do! stream.WriteAsync(headBytes.AsMemory(), rootCt)
                            do! stream.FlushAsync(rootCt)

                            if not respHasEnd then
                                    let mutable bodyLoop = true
                                    while bodyLoop do
                                        let! more = streamState.ResponseBodyChannel.Reader.WaitToReadAsync(rootCt)
                                        if more then
                                            let mutable item = (Array.empty, false)
                                            while streamState.ResponseBodyChannel.Reader.TryRead(&item) do
                                                let (data, isEnd) = item
                                                if data.Length > 0 then
                                                    if hasChunked then
                                                        let chunkHeader = Encoding.ASCII.GetBytes(sprintf "%x\r\n" data.Length)
                                                        do! stream.WriteAsync(chunkHeader.AsMemory(), rootCt)
                                                        do! stream.WriteAsync(data.AsMemory(), rootCt)
                                                        do! stream.WriteAsync("\r\n"B.AsMemory(), rootCt)
                                                    else
                                                        do! stream.WriteAsync(data.AsMemory(), rootCt)
                                                    do! stream.FlushAsync(rootCt)
                                                if isEnd then bodyLoop <- false
                                        else
                                            bodyLoop <- false

                                    if hasChunked then
                                        do! stream.WriteAsync("0\r\n\r\n"B.AsMemory(), rootCt)
                                        do! stream.FlushAsync(rootCt)
                        with ex ->
                            manager.CancelStream(sid)
                            let errResp = sprintf "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: %d\r\n\r\n%s" ex.Message.Length ex.Message
                            let b = Encoding.UTF8.GetBytes(errResp)
                            do! stream.WriteAsync(b.AsMemory(), rootCt)
                            keepAlive <- false
        }

    let start (listenHost: string) (listenPort: int) (serverUri: Uri) (masterPassword: string) (ct: CancellationToken) =
        task {
            let manager = new TunnelManager(serverUri, masterPassword)
            let ip = IPAddress.Parse(listenHost)
            let listener = new TcpListener(ip, listenPort)
            listener.Start()
            printfn "[zproxy client] Listening on %s:%d -> %O" listenHost listenPort serverUri
            use _reg = ct.Register(fun () -> listener.Stop())

            while not ct.IsCancellationRequested do
                try
                    let! client = listener.AcceptTcpClientAsync(ct)
                    Task.Run(Func<Task>(fun () -> handleLocalConnection client manager ct :> Task)) |> ignore
                with _ -> ()
        }