namespace ZProxy

open System
open System.Threading

module Program =

    [<EntryPoint>]
    let main args =
        let cts = new CancellationTokenSource()
        Console.CancelKeyPress.Add(fun e ->
            e.Cancel <- true
            cts.Cancel()
        )

        let getArg name defVal =
            match args |> Array.tryFindIndex (fun a -> a = name) with
            | Some idx when idx + 1 < args.Length -> args.[idx + 1]
            | _ -> defVal

        let getEnvOrArg argName envName defVal =
            match Environment.GetEnvironmentVariable(envName) with
            | s when not (String.IsNullOrEmpty(s)) -> s
            | _ -> getArg argName defVal

        if args.Length = 0 || args.[0] = "--help" || args.[0] = "-h" then
            printfn "zproxy - Single-binary encrypted full-duplex Zstd HTTP proxy"
            printfn "Usage:"
            printfn "  zproxy client [--listen 127.0.0.1:18080] [--server http://host:80] [--password-env ZPROXY_PASSWORD]"
            printfn "  zproxy server [--listen 0.0.0.0:80] [--password-env ZPROXY_PASSWORD]"
            0
        else
            let mode = args.[0].ToLowerInvariant()
            let password = getEnvOrArg "--password" "ZPROXY_PASSWORD" "zproxy-default-key-change-me"
            match mode with
            | "server" ->
                let listen = getArg "--listen" "0.0.0.0:80"
                let parts = listen.Split(':')
                let host = parts.[0]
                let port = int parts.[1]
                (Server.start host port password cts.Token).Wait()
                0
            | "client" ->
                let listen = getArg "--listen" "127.0.0.1:18080"
                let server = getArg "--server" "http://127.0.0.1:80"
                let parts = listen.Split(':')
                let host = parts.[0]
                let port = int parts.[1]
                let serverUri = Uri(server)
                (Client.start host port serverUri password cts.Token).Wait()
                0
            | _ ->
                eprintfn "Unknown mode: %s. Use 'client' or 'server'." mode
                1