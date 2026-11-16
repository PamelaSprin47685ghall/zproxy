namespace ZProxy

open System
open System.Collections.Concurrent
open System.Collections.Generic
open System.IO
open System.Net.Sockets
open System.Security.Cryptography
open System.Threading
open System.Threading.Tasks

module Server =
    let runWithHandler (options: Options.ServerOptions) (handler: RemoteHandler) (ct: CancellationToken) = task {
        Options.validate options.Limits |> ignore
        if String.IsNullOrWhiteSpace(options.AdminPassword) then invalidArg "options" "An admin password is required."
        if options.MaxTunnels < 1 || options.MaxTunnels > 1024
           || options.MaxUserTunnels < 1 || options.MaxUserTunnels > options.MaxTunnels then
            invalidArg "options" "Invalid tunnel limits."
        use lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct)
        let token = lifetime.Token
        use users = new Users.Store(options.DataDirectory)
        use statistics = new Statistics.Store(options.DataDirectory, users.List)
        let dispatch = Metering.wrap statistics handler
        use slots = new SemaphoreSlim(options.MaxTunnels, options.MaxTunnels)
        let userGate = obj ()
        let userCounts = Dictionary<string, int>(StringComparer.Ordinal)
        let acquireUser id = lock userGate (fun () ->
            let count = match userCounts.TryGetValue(id) with true, value -> value | _ -> 0
            if count >= options.MaxUserTunnels then false
            else userCounts[id] <- count + 1; true)
        let releaseUser id = lock userGate (fun () ->
            let count = userCounts[id]
            if count = 1 then userCounts.Remove(id) |> ignore
            else userCounts[id] <- count - 1)
        let replay = Crypto.ReplayFilter(300000L)
        let listener = new TcpListener(options.Listen)
        let connections = ConcurrentDictionary<int, Task>()
        let mutable sequence = 0

        let serve (tcp: TcpClient) = task {
            use owned = tcp
            use wire = new HttpWire.Connection(tcp.GetStream())
            try
                tcp.NoDelay <- true
                let! user, keys, preamble, agreed = task {
                    use deadline = CancellationTokenSource.CreateLinkedTokenSource(token)
                    deadline.CancelAfter(options.HandshakeTimeout)
                    return! Handshake.accept wire users.Resolve options.Limits replay deadline.Token
                }
                let acquired = acquireUser user.Identity.Id
                try
                    if not acquired then raise (IOException("The user's tunnel limit was reached."))
                    use sessionLifetime = CancellationTokenSource.CreateLinkedTokenSource(token, user.Revoked)
                    sessionLifetime.Token.ThrowIfCancellationRequested()
                    let tunnel = new Tunnel.EncryptedZstdTunnel(wire.Body, keys, preamble, false,
                                     agreed.DownloadWindowLog, agreed.UploadWindowLog, sessionLifetime.Token)
                    CryptographicOperations.ZeroMemory(keys.KeyC2S.AsSpan())
                    CryptographicOperations.ZeroMemory(keys.KeyS2C.AsSpan())
                    let send request requestToken = dispatch user.Identity request requestToken
                    use session = new Session.ProxySession(tunnel, agreed, false, Some send, tcp.Dispose, sessionLifetime.Token)
                    do! session.Completion
                finally
                    CryptographicOperations.ZeroMemory(keys.KeyC2S.AsSpan())
                    CryptographicOperations.ZeroMemory(keys.KeyS2C.AsSpan())
                    if acquired then releaseUser user.Identity.Id
            with _ -> ()
        }

        let accept = task {
            listener.Start()
            try
                while not token.IsCancellationRequested do
                    let! tcp = listener.AcceptTcpClientAsync(token)
                    if slots.Wait(0) then
                        let id = Interlocked.Increment(&sequence)
                        let work = task {
                            try do! serve tcp
                            finally slots.Release() |> ignore
                        }
                        connections[id] <- work
                        work.ContinueWith((fun (_: Task) -> connections.TryRemove(id) |> ignore), TaskScheduler.Default) |> ignore
                    else tcp.Dispose()
            with :? OperationCanceledException when token.IsCancellationRequested -> ()
        }
        let web = Management.run(options.WebListen, options.AdminPassword, users, statistics, token)
        let save = task {
            use timer = new PeriodicTimer(TimeSpan.FromSeconds(5.0))
            try
                let mutable running = true
                while running do
                    let! tick = timer.WaitForNextTickAsync(token)
                    running <- tick
                    if tick then statistics.Flush()
            with :? OperationCanceledException when token.IsCancellationRequested -> ()
        }
        let mutable failure: exn option = None
        try
            try
                let! first = Task.WhenAny(accept, web, save)
                do! first
                if not token.IsCancellationRequested then
                    raise (IOException("A server component stopped unexpectedly."))
            with error -> failure <- Some error
        finally
            lifetime.Cancel()
            listener.Stop()
        for work in [| accept :> Task; web; save :> Task |] do
            try do! work with error -> if failure.IsNone && not ct.IsCancellationRequested then failure <- Some error
        do! Task.WhenAll(connections.Values |> Seq.toArray)
        statistics.Flush()
        match failure with Some error when not ct.IsCancellationRequested -> return raise error | _ -> return ()
    }

    let run (options: Options.ServerOptions) ct = task {
        let gateway = options.Gateway |> Option.defaultWith (fun () -> invalidArg "options" "A remote gateway is required.")
        use upstream = new Upstream.UpstreamClient(gateway, options.GatewayToken)
        let handler: RemoteHandler = fun _ request token -> upstream.SendAsync(request, token)
        return! runWithHandler options handler ct
    }
