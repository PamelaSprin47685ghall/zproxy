namespace ZProxy

open System
open System.Globalization
open System.Net
open System.Net.Sockets
open System.Runtime.InteropServices
open System.Security.Cryptography
open System.Threading
open System.Threading.Tasks

module Program =
    type PendingOptions<'T> =
        { SecretEnvironment: string
          TokenEnvironment: string option
          Create: string -> string option -> 'T }

    type Command =
        | Help
        | StartClient of PendingOptions<Options.ClientOptions>
        | StartServer of PendingOptions<Options.ServerOptions>

    let private reject message = raise (ArgumentException(message))

    let private integer name minimum maximum (value: string) =
        match Int32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture) with
        | true, number when number >= minimum && number <= maximum -> number
        | _ -> reject $"{name} must be a whole number from {minimum} to {maximum}."

    let private endpoint (value: string) =
        let host, port, isBracketed =
            if value.StartsWith("[", StringComparison.Ordinal) then
                let close = value.IndexOf(']')
                if close < 2 || close + 1 >= value.Length || value[close + 1] <> ':' then
                    reject "--listen must be IP:port or [IPv6]:port."
                value.Substring(1, close - 1), value.Substring(close + 2), true
            else
                let colon = value.IndexOf(':')
                if colon < 1 || colon <> value.LastIndexOf(':') then
                    reject "--listen must be IP:port or [IPv6]:port."
                value.Substring(0, colon), value.Substring(colon + 1), false

        match IPAddress.TryParse(host) with
        | true, address when (address.AddressFamily = AddressFamily.InterNetworkV6) = isBracketed ->
            IPEndPoint(address, integer "Listen port" 1 65535 port)
        | _ -> reject "--listen must contain an IP address. Use brackets around IPv6 addresses."

    let private serverUri value =
        match Uri.TryCreate(value, UriKind.Absolute) with
        | true, uri when uri.Scheme = Uri.UriSchemeHttp && uri.Host.Length > 0
                         && uri.Port > 0 && uri.UserInfo = "" && uri.Query = "" && uri.Fragment = ""
                         && (uri.AbsolutePath = "/" || uri.AbsolutePath = "/tunnel") ->
            let builder = UriBuilder(uri)
            builder.Path <- "/tunnel"
            builder.Uri
        | _ -> reject "--server must be http://host[:port] or http://host[:port]/tunnel, without credentials, query, or fragment."

    let private seconds name (value: string) =
        match Double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture) with
        | true, number when Double.IsFinite(number) && number > 0.0 && number <= 3600.0 ->
            let timeout = TimeSpan.FromSeconds(number)
            if timeout = TimeSpan.Zero then reject $"{name} is too small."
            timeout
        | _ -> reject $"{name} must be a number greater than 0 and at most 3600."

    let private environmentName option (value: string) =
        if String.IsNullOrWhiteSpace(value) || value.IndexOfAny([| '='; '\000' |]) >= 0 then
            reject $"{option} must name an environment variable."
        value

    /// Parse arguments without reading the environment or starting a listener.
    let parse (args: string array) : Result<Command, string> =
        try
            if args.Length = 0 || args = [| "--help" |] || args = [| "-h" |] then
                Ok Help
            else
                let role = args[0]
                if role <> "client" && role <> "server" then
                    reject "Use 'client' or 'server'. See --help."
                if args.Length = 2 && (args[1] = "--help" || args[1] = "-h") then
                    Ok Help
                else
                    let common =
                        set [ "--listen"; "--upload-window-log"; "--download-window-log"
                              "--max-streams"; "--stream-window-bytes" ]
                    let allowed =
                        if role = "client" then
                            Set.union common (set [ "--server"; "--uuid-env"; "--connect-timeout-seconds" ])
                        else
                            Set.union common (set [ "--max-tunnels"; "--max-user-tunnels"; "--handshake-timeout-seconds";
                                                   "--admin-password-env"; "--gateway"; "--gateway-token-env";
                                                   "--data-dir"; "--web-listen" ])
                    let mutable values = Map.empty
                    let mutable index = 1
                    while index < args.Length do
                        let name = args[index]
                        if not (allowed.Contains(name)) then
                            if name.StartsWith("--password", StringComparison.Ordinal) then
                                reject "Select --uuid-env for clients or --admin-password-env for the server."
                            reject $"Unsupported {role} option. See --help."
                        if values.ContainsKey(name) then
                            reject $"Option '{name}' is repeated."
                        if index + 1 >= args.Length || args[index + 1].StartsWith("--", StringComparison.Ordinal) then
                            reject $"Option '{name}' needs a value."
                        values <- values.Add(name, args[index + 1])
                        index <- index + 2

                    let value name fallback = Map.tryFind name values |> Option.defaultValue fallback
                    let number name fallback minimum maximum =
                        value name (string fallback) |> integer name minimum maximum
                    let listen =
                        value "--listen" (if role = "client" then "127.0.0.1:18080" else "0.0.0.0:80")
                        |> endpoint
                    let limits =
                        { Options.defaults with
                            UploadWindowLog = number "--upload-window-log" Options.defaults.UploadWindowLog 10 23
                            DownloadWindowLog = number "--download-window-log" Options.defaults.DownloadWindowLog 10 23
                            MaxStreams = number "--max-streams" Options.defaults.MaxStreams 1 256
                            StreamWindowBytes = number "--stream-window-bytes" Options.defaults.StreamWindowBytes 16384 (4 * 1024 * 1024) }
                        |> Options.validate

                    if role = "client" then
                        let server =
                            match Map.tryFind "--server" values with
                            | Some value -> serverUri value
                            | None -> reject "The client needs --server http://host[:port]."
                        let timeout = value "--connect-timeout-seconds" "15" |> seconds "--connect-timeout-seconds"
                        let options =
                            { SecretEnvironment = value "--uuid-env" "ZPROXY_USER_UUID" |> environmentName "--uuid-env"
                              TokenEnvironment = None
                              Create = fun uuid _ ->
                                  let credential = Crypto.deriveUserCredential uuid
                                  CryptographicOperations.ZeroMemory(credential.Key.AsSpan())
                                  { Options.client listen server uuid with
                                      Limits = limits
                                      ConnectTimeout = timeout } }
                        Ok (StartClient options)
                    else
                        let maxTunnels = number "--max-tunnels" 16 1 1024
                        let maxUserTunnels = number "--max-user-tunnels" (min 2 maxTunnels) 1 maxTunnels
                        let timeout = value "--handshake-timeout-seconds" "15" |> seconds "--handshake-timeout-seconds"
                        let gateway =
                            match Map.tryFind "--gateway" values with
                            | Some value ->
                                match Uri.TryCreate(value, UriKind.Absolute) with
                                | true, uri when HttpUtils.validGateway uri -> uri
                                | _ -> reject "--gateway must name a fixed HTTP or HTTPS authority without credentials or a path."
                            | None -> reject "The server needs --gateway for its remote OMP or OpenAI gateway."
                        let directory = value "--data-dir" "data"
                        if String.IsNullOrWhiteSpace(directory) then reject "--data-dir must name a private directory."
                        let webListen = value "--web-listen" "127.0.0.1:18081" |> endpoint
                        if webListen.Port = listen.Port then reject "The web and tunnel listeners need different ports."
                        let options =
                            { SecretEnvironment = value "--admin-password-env" "ZPROXY_ADMIN_PASSWORD" |> environmentName "--admin-password-env"
                              TokenEnvironment = Map.tryFind "--gateway-token-env" values |> Option.map (environmentName "--gateway-token-env")
                              Create = fun password gatewayToken ->
                                  { Options.server listen password with
                                      DataDirectory = directory
                                      WebListen = webListen
                                      Gateway = Some gateway
                                      GatewayToken = gatewayToken
                                      Limits = limits
                                      MaxTunnels = maxTunnels
                                      MaxUserTunnels = maxUserTunnels
                                      HandshakeTimeout = timeout } }
                        Ok (StartServer options)
        with :? ArgumentException as error -> Error error.Message

    let bindEnvironment (readEnvironment: string -> string) options =
        try
            let required name =
                let secret = readEnvironment name
                if String.IsNullOrWhiteSpace(secret) then reject $"Environment variable '{name}' must contain a secret."
                secret
            let secret = required options.SecretEnvironment
            let token = options.TokenEnvironment |> Option.map required
            Ok (options.Create secret token)
        with :? ArgumentException as error -> Error error.Message

    let private help = """zproxy - Encrypted HTTP/1.1 streaming proxy
Usage:
  zproxy client --server http://host[:port] [options]
  zproxy server --gateway http://remote-omp:port [options]

Common options:
  --listen IP:port                  Client: 127.0.0.1:18080; server: 0.0.0.0:80
  --upload-window-log N             10..23; default: 23
  --download-window-log N           10..23; default: 20
  --max-streams N                   1..256; default: 16
  --stream-window-bytes N           16384..4194304; default: 262144
Client options:
  --uuid-env NAME                   User UUID variable; default: ZPROXY_USER_UUID
  --connect-timeout-seconds N       Greater than 0, at most 3600; default: 15
Server options:
  --admin-password-env NAME         Admin password variable; default: ZPROXY_ADMIN_PASSWORD
  --gateway URL                    Fixed remote OMP/OpenAI gateway authority; required
  --gateway-token-env NAME          Optional remote-only gateway bearer token variable
  --data-dir PATH                  Private users and statistics; default: data
  --web-listen IP:port              Admin and public reports; default: 127.0.0.1:18081
  --max-tunnels N                   1..1024; default: 16
  --max-user-tunnels N              Per-user connection limit; default: 2
  --handshake-timeout-seconds N     Greater than 0, at most 3600; default: 15

Use [IPv6]:port for an IPv6 listener. The server URL uses the fixed /tunnel path.
Stream count times stream window bytes must not exceed 64 MiB.
Clients use their own UUID. The admin password and gateway credentials stay on the server.
The local API accepts POST /v1/chat/completions and POST /v1/completions.
The web listener exposes public /reports and password-protected /admin."""

    [<EntryPoint>]
    let main args =
        match parse args with
        | Error message ->
            eprintfn "zproxy: %s" message
            2
        | Ok Help ->
            printfn "%s" help
            0
        | Ok command ->
            use stop = new CancellationTokenSource()
            let cancel = ConsoleCancelEventHandler(fun _ event -> event.Cancel <- true; stop.Cancel())
            Console.add_CancelKeyPress cancel
            try
                try
                    use terminate =
                        if OperatingSystem.IsWindows() then null
                        else PosixSignalRegistration.Create(PosixSignal.SIGTERM, fun signal -> signal.Cancel <- true; stop.Cancel())
                    let resolve options =
                        match bindEnvironment Environment.GetEnvironmentVariable options with
                        | Ok value -> value
                        | Error message -> reject message
                    let work =
                        match command with
                        | StartClient options -> Client.run (resolve options) [] stop.Token :> Task
                        | StartServer options -> Server.run (resolve options) stop.Token :> Task
                        | Help -> Task.CompletedTask
                    work.GetAwaiter().GetResult()
                    0
                with
                | :? OperationCanceledException when stop.IsCancellationRequested -> 0
                | error ->
                    eprintfn "zproxy: %s" error.Message
                    1
            finally
                Console.remove_CancelKeyPress cancel
