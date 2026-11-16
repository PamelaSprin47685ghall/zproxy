namespace ZProxy

open System
open System.Collections.Concurrent
open System.Net
open System.Net.Sockets
open System.Security.Cryptography
open System.Threading
open System.Threading.Tasks

module Server =
    let run (options: Options.ServerOptions) (ct: CancellationToken) = task {
        Options.validate options.Limits |> ignore
        if String.IsNullOrWhiteSpace(options.Password) then invalidArg "options" "A password is required."
        if options.MaxTunnels < 1 || options.MaxTunnels > 1024 then invalidArg "options" "Invalid tunnel limit."
        use lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct)
        let token = lifetime.Token
        let master = Crypto.deriveMasterKey options.Password
        use upstream = new Upstream.UpstreamClient()
        use slots = new SemaphoreSlim(options.MaxTunnels, options.MaxTunnels)
        let replay = Crypto.ReplayFilter(300000L)
        let listener = new TcpListener(options.Listen)
        let connections = ConcurrentDictionary<int, Task>()
        let mutable sequence = 0

        let serve (tcp: TcpClient) = task {
            use owned = tcp
            use wire = new HttpWire.Connection(tcp.GetStream())
            try
                tcp.NoDelay <- true
                let! keys, preamble, agreed = task {
                    use deadline = CancellationTokenSource.CreateLinkedTokenSource(token)
                    deadline.CancelAfter(options.HandshakeTimeout)
                    return! Handshake.accept wire master options.Limits replay deadline.Token
                }
                let tunnel =
                    try
                        new Tunnel.EncryptedZstdTunnel(wire.Body, keys, preamble, false,
                            agreed.DownloadWindowLog, agreed.UploadWindowLog, token)
                    finally
                        CryptographicOperations.ZeroMemory(keys.KeyC2S.AsSpan())
                        CryptographicOperations.ZeroMemory(keys.KeyS2C.AsSpan())
                let send request token = upstream.SendAsync(request, token)
                use session = new Session.ProxySession(tunnel, agreed, false, Some send, tcp.Dispose, token)
                do! session.Completion
            with _ -> () // Invalid or interrupted sessions close without origin work.
        }

        let mutable failure: exn option = None
        try
            try
                listener.Start()
                while not token.IsCancellationRequested do
                    let! tcp = listener.AcceptTcpClientAsync(token)
                    if slots.Wait(0) then
                        let id = Interlocked.Increment(&sequence)
                        let work = task {
                            try do! serve tcp
                            finally slots.Release() |> ignore
                        }
                        connections[id] <- work
                        work.ContinueWith(
                            (fun (_: Task) -> connections.TryRemove(id) |> ignore),
                            TaskScheduler.Default) |> ignore
                    else tcp.Dispose()
            with
            | :? OperationCanceledException when token.IsCancellationRequested -> ()
            | error -> failure <- Some error
        finally
            lifetime.Cancel()
            listener.Stop()
        try
            do! Task.WhenAll(connections.Values |> Seq.toArray)
        finally
            CryptographicOperations.ZeroMemory(master.AsSpan())
        match failure with Some error -> return raise error | None -> return ()
    }
