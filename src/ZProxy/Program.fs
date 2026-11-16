namespace ZProxy

open System
open System.Globalization
open System.Net
open System.Net.Sockets
open System.Runtime.InteropServices
open System.Threading
open System.Threading.Tasks

module Program =
    type PendingOptions<'T> =
        { PasswordEnvironment: string
          Create: string -> 'T }

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
                        set [ "--listen"; "--password-env"; "--upload-window-log"; "--download-window-log"
                              "--max-streams"; "--stream-window-bytes" ]
                    let allowed =
                        if role = "client" then
                            Set.union common (set [ "--server"; "--connect-timeout-seconds" ])
                        else
                            Set.union common (set [ "--max-tunnels"; "--handshake-timeout-seconds" ])
                    let mutable values = Map.empty
                    let mutable index = 1
                    while index < args.Length do
                        let name = args[index]
                        if not (allowed.Contains(name)) then
                            if name.StartsWith("--password", StringComparison.Ordinal) then
                                reject "Use --password-env NAME to select the password variable."
                            reject $"Option '{name}' is not supported for {role}."
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
                    let passwordEnvironment = value "--password-env" "ZPROXY_PASSWORD"
                    if String.IsNullOrWhiteSpace(passwordEnvironment)
                       || passwordEnvironment.IndexOfAny([| '='; '\000' |]) >= 0 then
                        reject "--password-env must name an environment variable."
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
                            { PasswordEnvironment = passwordEnvironment
                              Create = fun password ->
                                  { Options.client listen server password with
                                      Limits = limits
                                      ConnectTimeout = timeout } }
                        Ok (StartClient options)
                    else
                        let maxTunnels = number "--max-tunnels" 16 1 1024
                        let timeout = value "--handshake-timeout-seconds" "15" |> seconds "--handshake-timeout-seconds"
                        let options =
                            { PasswordEnvironment = passwordEnvironment
                              Create = fun password ->
                                  { Options.server listen password with
                                      Limits = limits
                                      MaxTunnels = maxTunnels
                                      HandshakeTimeout = timeout } }
                        Ok (StartServer options)
        with :? ArgumentException as error -> Error error.Message

    let bindPassword (readEnvironment: string -> string) options =
        let password = readEnvironment options.PasswordEnvironment
        if String.IsNullOrWhiteSpace(password) then
            Error $"Environment variable '{options.PasswordEnvironment}' must contain a password."
        else
            Ok (options.Create password)

    let private help = """zproxy - Encrypted HTTP/1.1 streaming proxy
Usage:
  zproxy client --server http://host[:port] [options]
  zproxy server [options]

Common options:
  --listen IP:port                  Client: 127.0.0.1:18080; server: 0.0.0.0:80
  --password-env NAME               Required password variable; default: ZPROXY_PASSWORD
  --upload-window-log N             10..23; default: 23
  --download-window-log N           10..23; default: 20
  --max-streams N                   1..256; default: 16
  --stream-window-bytes N           16384..4194304; default: 262144
Client options:
  --connect-timeout-seconds N       Greater than 0, at most 3600; default: 15
Server options:
  --max-tunnels N                   1..1024; default: 16
  --handshake-timeout-seconds N     Greater than 0, at most 3600; default: 15

Use [IPv6]:port for an IPv6 listener. The server URL uses the fixed /tunnel path.
Stream count times stream window bytes must not exceed 64 MiB.
The password must be set in the selected environment variable."""

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
                        match bindPassword Environment.GetEnvironmentVariable options with
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
