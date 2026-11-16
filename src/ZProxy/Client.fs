namespace ZProxy

open System
open System.IO
open System.Net
open System.Net.Http
open System.Net.Sockets
open System.Security.Cryptography
open System.Threading
open System.Threading.Tasks
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Http
open Microsoft.AspNetCore.Http.Features
open Microsoft.AspNetCore.Hosting
open Microsoft.AspNetCore.Server.Kestrel.Core
open Microsoft.Extensions.Hosting
open Microsoft.Extensions.Logging

module Client =
    /// One local process uses one live tunnel. Failed requests are never retried here.
    type private ConnectionOwner(options: Options.ClientOptions, ct: CancellationToken) =
        let credential = Crypto.deriveUserCredential options.UserUuid
        let lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct)
        let gate = new SemaphoreSlim(1, 1)
        let mutable current: Session.ProxySession option = None

        let connect callerToken = task {
            use deadline = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, callerToken)
            deadline.CancelAfter(options.ConnectTimeout)
            let tcp = new TcpClient()
            try
                tcp.NoDelay <- true
                do! tcp.ConnectAsync(options.Server.DnsSafeHost, options.Server.Port, deadline.Token)
                let wire = new HttpWire.Connection(tcp.GetStream())
                try
                    let! keys, preamble, agreed = Handshake.connect wire options.Server credential options.Limits deadline.Token
                    let tunnel =
                        try
                            new Tunnel.EncryptedZstdTunnel(wire.Body, keys, preamble, true,
                                agreed.UploadWindowLog, agreed.DownloadWindowLog, lifetime.Token)
                        finally
                            CryptographicOperations.ZeroMemory(keys.KeyC2S.AsSpan())
                            CryptographicOperations.ZeroMemory(keys.KeyS2C.AsSpan())
                    let close () = (wire :> IDisposable).Dispose(); tcp.Dispose()
                    return new Session.ProxySession(tunnel, agreed, true, None, close, lifetime.Token)
                with error ->
                    (wire :> IDisposable).Dispose()
                    return raise error
            with error ->
                tcp.Dispose()
                return raise error
        }

        let getSession callerToken = task {
            use wait = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, callerToken)
            do! gate.WaitAsync(wait.Token)
            try
                match current with
                | Some session when session.IsAlive -> return session
                | old ->
                    match old with
                    | Some session ->
                        (session :> IDisposable).Dispose()
                        do! session.Completion
                    | None -> ()
                    current <- None
                    let! session = connect callerToken
                    current <- Some session
                    return session
            finally
                gate.Release() |> ignore
        }

        member _.SendAsync request token = task {
            let! session = getSession token
            return! session.SendAsync(request, token)
        }

        member _.CloseAsync() = task {
            lifetime.Cancel()
            do! gate.WaitAsync()
            try
                match current with
                | Some session ->
                    (session :> IDisposable).Dispose()
                    do! session.Completion
                | None -> ()
                current <- None
            finally
                CryptographicOperations.ZeroMemory(credential.Key.AsSpan())
                gate.Release() |> ignore
        }

        interface IDisposable with
            member _.Dispose() =
                lifetime.Cancel()
                current |> Option.iter (fun session -> (session :> IDisposable).Dispose())
                CryptographicOperations.ZeroMemory(credential.Key.AsSpan())
                lifetime.Dispose()

    let private proxy (handler: ProxyHandler) (context: HttpContext) = task {
        let token = context.RequestAborted
        try
            let raw = context.Features.Get<IHttpRequestFeature>().RawTarget
            if context.Request.Method <> "POST" || not (Contracts.isCompletionPath raw) then
                context.Response.StatusCode <- StatusCodes.Status404NotFound
                do! context.Response.WriteAsync("Use a POST completion endpoint.", token)
            else
                let target = Contracts.logicalUri raw
                use request = new HttpRequestMessage(HttpMethod(context.Request.Method), target)
                let headers =
                    [ for header in context.Request.Headers do
                          for value in header.Value do yield header.Key, value ]
                let detection = context.Features.Get<IHttpRequestBodyDetectionFeature>()
                if detection.CanHaveBody then
                    request.Content <- new StreamContent(new Flow.BorrowedStream(context.Request.Body))
                elif headers |> List.exists (fun (name, _) -> name.StartsWith("Content-", StringComparison.OrdinalIgnoreCase)) then
                    request.Content <- new ByteArrayContent(Array.empty)
                HttpUtils.addRequestHeaders request headers
                let passEncoding = headers |> List.exists (fun (name, value) ->
                    name.Equals("X-Zproxy-Pass-Encoding", StringComparison.OrdinalIgnoreCase) && value = "1")
                if not passEncoding then
                    request.Headers.AcceptEncoding.Clear()
                    request.Headers.AcceptEncoding.ParseAdd("identity")
                let! reply = handler request token
                use response = reply
                context.Response.StatusCode <- int response.StatusCode
                for name, value in HttpUtils.responseHeaders response do
                    context.Response.Headers.Append(name, value)
                do! context.Response.StartAsync(token)
                let! body = response.Content.ReadAsStreamAsync(token)
                let buffer = Array.zeroCreate<byte> 16384
                let mutable reading = true
                while reading do
                    let! count = body.ReadAsync(buffer.AsMemory(), token)
                    if count = 0 then reading <- false
                    else
                        do! context.Response.Body.WriteAsync(buffer.AsMemory(0, count), token)
                        do! context.Response.Body.FlushAsync(token)
        with
        | :? OperationCanceledException when token.IsCancellationRequested -> context.Abort()
        | _ ->
            if context.Response.HasStarted then context.Abort()
            else
                context.Response.Clear()
                context.Response.StatusCode <- StatusCodes.Status502BadGateway
                do! context.Response.WriteAsync("The proxy request failed. It was not replayed.", token)
    }

    let runWithDecoders (options: Options.ClientOptions) (plugins: IProxyPlugin list)
                        (decoders: IResponseDecoder list) (ct: CancellationToken) = task {
        Options.validate options.Limits |> ignore
        if String.IsNullOrWhiteSpace(options.UserUuid) then invalidArg "options" "A user UUID is required."
        if not options.Server.IsAbsoluteUri || options.Server.Scheme <> "http"
           || options.Server.UserInfo <> "" || options.Server.Query <> "" || options.Server.Fragment <> ""
           || options.Server.Port < 1
           || (options.Server.AbsolutePath <> "/" && options.Server.AbsolutePath <> "/tunnel") then
            invalidArg "options" "The tunnel server must name an HTTP authority or /tunnel endpoint."
        use connection = new ConnectionOwner(options, ct)
        let send request token = task {
            let! reply = connection.SendAsync request token
            return! Plugins.decode decoders request reply token
        }
        let handler = Plugins.compose plugins send
        let builder = WebApplication.CreateSlimBuilder([||])
        builder.Logging.ClearProviders() |> ignore
        builder.WebHost.ConfigureKestrel(fun server ->
            server.AddServerHeader <- false
            server.Limits.MaxConcurrentConnections <- Nullable(int64 (max 32 (options.Limits.MaxStreams * 4)))
            server.Limits.MaxRequestBodySize <- Nullable()
            server.Limits.MaxRequestHeaderCount <- 128
            server.Limits.MaxRequestHeadersTotalSize <- 32768
            server.Limits.MaxRequestLineSize <- 16384
            server.Limits.MinRequestBodyDataRate <- null
            server.Limits.MinResponseDataRate <- null
            server.Listen(options.Listen.Address, options.Listen.Port, fun endpoint -> endpoint.Protocols <- HttpProtocols.Http1)) |> ignore
        let app = builder.Build()
        app.Run(RequestDelegate(fun context -> proxy handler context :> Task))
        let mutable failure: exn option = None
        try do! (app :> IHost).RunAsync(ct)
        with error -> failure <- Some error
        do! connection.CloseAsync()
        match failure with Some error -> return raise error | None -> return ()
    }

    let run options plugins ct = runWithDecoders options plugins [] ct
