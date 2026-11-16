namespace ZProxy.Tests

open System
open System.Net
open Xunit
open ZProxy

module CommandTests =
    let private userUuid = "7f5b2e70-203e-4a8e-b820-67676d0d1eb0"

    let private clientArgs args =
        Array.append [| "client"; "--server"; "http://example.test:8080" |] args

    let private serverArgs args =
        Array.append [| "server"; "--gateway"; "http://gateway.test:9000" |] args

    let private parse args =
        match Program.parse args with
        | Ok command -> command
        | Error message -> failwith message

    let private client args =
        match parse (clientArgs args) with
        | Program.StartClient options -> options
        | _ -> failwith "Expected a client command."

    let private server args =
        match parse (serverArgs args) with
        | Program.StartServer options -> options
        | _ -> failwith "Expected a server command."

    let private bind readEnvironment options =
        match Program.bindEnvironment readEnvironment options with
        | Ok value -> value
        | Error message -> failwith message

    let private error args =
        match Program.parse args with
        | Error message -> message
        | Ok _ -> failwith "Expected an invalid command."

    [<Fact>]
    let ``Client defaults require a user UUID and use the fixed tunnel path`` () =
        let pending = client [||]
        let options = pending.Create userUuid None
        Assert.Equal("ZPROXY_USER_UUID", pending.SecretEnvironment)
        Assert.True(pending.TokenEnvironment.IsNone)
        Assert.Equal(userUuid, options.UserUuid)
        Assert.Equal(IPEndPoint(IPAddress.Loopback, 18080), options.Listen)
        Assert.Equal("http://example.test:8080/tunnel", options.Server.AbsoluteUri)
        Assert.Equal(Options.defaults, options.Limits)
        Assert.Equal(TimeSpan.FromSeconds(15.0), options.ConnectTimeout)

    [<Fact>]
    let ``A client reads only its selected UUID variable`` () =
        let pending = client [| "--uuid-env"; "MY_USER_UUID"; "--connect-timeout-seconds"; "3.5" |]
        let requested = ResizeArray<string>()
        let options =
            bind (fun name ->
                requested.Add(name)
                if name <> "MY_USER_UUID" then failwith "The client requested a server secret."
                userUuid) pending
        Assert.Equal<string>([| "MY_USER_UUID" |], requested.ToArray())
        Assert.Equal(userUuid, options.UserUuid)
        Assert.Equal(TimeSpan.FromSeconds(3.5), options.ConnectTimeout)

    [<Fact>]
    let ``Server defaults keep the master password and gateway separate from user UUIDs`` () =
        let pending = server [||]
        let requested = ResizeArray<string>()
        let options = bind (fun name -> requested.Add(name); " exact master password ") pending
        Assert.Equal("ZPROXY_ADMIN_PASSWORD", pending.SecretEnvironment)
        Assert.True(pending.TokenEnvironment.IsNone)
        Assert.Equal<string>([| "ZPROXY_ADMIN_PASSWORD" |], requested.ToArray())
        Assert.Equal(" exact master password ", options.AdminPassword)
        Assert.Equal(IPEndPoint(IPAddress.Any, 80), options.Listen)
        Assert.Equal(IPEndPoint(IPAddress.Loopback, 18081), options.WebListen)
        Assert.Equal("data", options.DataDirectory)
        Assert.Equal(Some(Uri("http://gateway.test:9000")), options.Gateway)
        Assert.True(options.GatewayToken.IsNone)
        Assert.Equal(16, options.MaxTunnels)
        Assert.Equal(2, options.MaxUserTunnels)

    [<Fact>]
    let ``Only a server reads the optional gateway token`` () =
        let pending = server [| "--admin-password-env"; "MY_ADMIN_SECRET"; "--gateway-token-env"; "MY_GATEWAY_TOKEN" |]
        let requested = ResizeArray<string>()
        let options =
            bind (fun name ->
                requested.Add(name)
                match name with
                | "MY_ADMIN_SECRET" -> " exact admin secret "
                | "MY_GATEWAY_TOKEN" -> "opaque-gateway-token"
                | _ -> failwith "The server requested a user UUID.") pending
        Assert.Equal<string>([| "MY_ADMIN_SECRET"; "MY_GATEWAY_TOKEN" |], requested.ToArray())
        Assert.Equal(" exact admin secret ", options.AdminPassword)
        Assert.Equal(Some "opaque-gateway-token", options.GatewayToken)

    [<Fact>]
    let ``Server listener storage and resource options are applied`` () =
        let pending =
            server [| "--listen"; "[::1]:8081"; "--web-listen"; "127.0.0.1:8082"
                      "--data-dir"; "private-data"; "--max-tunnels"; "32"; "--max-user-tunnels"; "3"
                      "--upload-window-log"; "22"; "--download-window-log"; "18"
                      "--max-streams"; "8"; "--stream-window-bytes"; "65536"
                      "--handshake-timeout-seconds"; "2.5" |]
        let options = pending.Create "test-master" None
        Assert.Equal(IPEndPoint(IPAddress.IPv6Loopback, 8081), options.Listen)
        Assert.Equal(IPEndPoint(IPAddress.Loopback, 8082), options.WebListen)
        Assert.Equal("private-data", options.DataDirectory)
        Assert.Equal(32, options.MaxTunnels)
        Assert.Equal(3, options.MaxUserTunnels)
        Assert.Equal(22, options.Limits.UploadWindowLog)
        Assert.Equal(18, options.Limits.DownloadWindowLog)
        Assert.Equal(8, options.Limits.MaxStreams)
        Assert.Equal(65536, options.Limits.StreamWindowBytes)
        Assert.Equal(TimeSpan.FromSeconds(2.5), options.HandshakeTimeout)

    [<Theory>]
    [<InlineData(null)>]
    [<InlineData("")>]
    [<InlineData("   ")>]
    [<InlineData("\t\r\n")>]
    let ``Blank secrets are rejected for each role and for a selected gateway token`` (value: string) =
        Assert.True(Program.bindEnvironment (fun _ -> value) (client [||]) |> Result.isError)
        Assert.True(Program.bindEnvironment (fun _ -> value) (server [||]) |> Result.isError)
        let pending = server [| "--gateway-token-env"; "MY_GATEWAY_TOKEN" |]
        let result = Program.bindEnvironment (fun name -> if name = "MY_GATEWAY_TOKEN" then value else "test-master") pending
        Assert.True(Result.isError result)

    [<Theory>]
    [<InlineData("not-a-uuid")>]
    [<InlineData("7f5b2e70-203e-1a8e-b820-67676d0d1eb0")>]
    [<InlineData("7f5b2e70-203e-4a8e-1820-67676d0d1eb0")>]
    [<InlineData("{7f5b2e70-203e-4a8e-b820-67676d0d1eb0}")>]
    [<InlineData("7f5b2e70203e4a8eb82067676d0d1eb0")>]
    [<InlineData(" 7f5b2e70-203e-4a8e-b820-67676d0d1eb0 ")>]
    let ``Invalid UUID secrets fail without being printed`` (value: string) =
        match Program.bindEnvironment (fun _ -> value) (client [||]) with
        | Error message -> Assert.DoesNotContain(value, message)
        | Ok _ -> failwith "Expected an invalid user UUID."

    [<Theory>]
    [<InlineData("")>]
    [<InlineData("--help")>]
    [<InlineData("-h")>]
    [<InlineData("client --help")>]
    [<InlineData("server -h")>]
    let ``Help does not require an endpoint or secret`` (command: string) =
        match parse (command.Split(' ', StringSplitOptions.RemoveEmptyEntries)) with
        | Program.Help -> ()
        | _ -> failwith "Expected help."

    [<Theory>]
    [<InlineData("unknown")>]
    [<InlineData("client")>]
    [<InlineData("server")>]
    [<InlineData("server --unknown value")>]
    [<InlineData("server --listen")>]
    [<InlineData("server --listen --max-tunnels 2")>]
    [<InlineData("server --max-tunnels 1 --max-tunnels 2")>]
    [<InlineData("server --server http://example.test")>]
    [<InlineData("server --connect-timeout-seconds 3")>]
    [<InlineData("server --uuid-env USER_UUID")>]
    [<InlineData("client --server http://example.test --max-tunnels 2")>]
    [<InlineData("client --server http://example.test --max-user-tunnels 2")>]
    [<InlineData("client --server http://example.test --handshake-timeout-seconds 3")>]
    [<InlineData("client --server http://example.test --gateway http://gateway.test")>]
    [<InlineData("client --server http://example.test --gateway-token-env TOKEN")>]
    [<InlineData("client --server http://example.test --admin-password-env MASTER")>]
    [<InlineData("client --server http://example.test --data-dir private")>]
    [<InlineData("client --server http://example.test --web-listen 127.0.0.1:8081")>]
    [<InlineData("server extra")>]
    [<InlineData("server --help --help")>]
    let ``Unknown duplicate missing and wrong role arguments are rejected`` (command: string) =
        Assert.NotEmpty(error (command.Split(' ', StringSplitOptions.RemoveEmptyEntries)))

    [<Theory>]
    [<InlineData("https://example.test")>]
    [<InlineData("http://example.test/other")>]
    [<InlineData("http://example.test/tunnel?token=secret")>]
    [<InlineData("http://example.test/#fragment")>]
    [<InlineData("http://user:secret@example.test")>]
    [<InlineData("http://example.test:0")>]
    [<InlineData("example.test")>]
    let ``The server URL must name the HTTP tunnel endpoint`` value =
        Assert.NotEmpty(error [| "client"; "--server"; value |])

    [<Theory>]
    [<InlineData("http://example.test")>]
    [<InlineData("http://example.test/")>]
    [<InlineData("http://example.test/tunnel")>]
    [<InlineData("http://[::1]:8080/tunnel")>]
    let ``Both authority and tunnel URLs use the fixed endpoint`` value =
        match parse [| "client"; "--server"; value |] with
        | Program.StartClient pending -> Assert.Equal("/tunnel", (pending.Create userUuid None).Server.AbsolutePath)
        | _ -> failwith "Expected client options."

    [<Theory>]
    [<InlineData("http://gateway.test:9000")>]
    [<InlineData("https://gateway.test/")>]
    [<InlineData("http://[::1]:9000/")>]
    let ``The gateway accepts a fixed HTTP or HTTPS authority`` value =
        match parse [| "server"; "--gateway"; value |] with
        | Program.StartServer pending -> Assert.Equal(Some(Uri(value)), (pending.Create "master" None).Gateway)
        | _ -> failwith "Expected server options."

    [<Theory>]
    [<InlineData("http://gateway.test/v1")>]
    [<InlineData("http://gateway.test/tunnel")>]
    [<InlineData("http://gateway.test/?token=secret")>]
    [<InlineData("http://gateway.test/#fragment")>]
    [<InlineData("http://user:secret@gateway.test")>]
    [<InlineData("http://gateway.test:0")>]
    [<InlineData("ftp://gateway.test")>]
    [<InlineData("gateway.test")>]
    let ``The gateway rejects routes credentials and non HTTP authorities`` value =
        Assert.NotEmpty(error [| "server"; "--gateway"; value |])

    [<Theory>]
    [<InlineData("localhost:8080")>]
    [<InlineData("::1:8080")>]
    [<InlineData("[::1]")>]
    [<InlineData("[127.0.0.1]:8080")>]
    [<InlineData("127.0.0.1:0")>]
    [<InlineData("127.0.0.1:65536")>]
    [<InlineData("127.0.0.1:abc")>]
    let ``Invalid tunnel and web listener addresses are rejected`` value =
        Assert.NotEmpty(error (serverArgs [| "--listen"; value |]))
        Assert.NotEmpty(error (serverArgs [| "--web-listen"; value |]))

    [<Theory>]
    [<InlineData("--max-tunnels", "0")>]
    [<InlineData("--max-tunnels", "1025")>]
    [<InlineData("--max-user-tunnels", "0")>]
    [<InlineData("--max-user-tunnels", "17")>]
    [<InlineData("--max-streams", "257")>]
    [<InlineData("--max-streams", "-1")>]
    [<InlineData("--upload-window-log", "24")>]
    [<InlineData("--download-window-log", "9")>]
    [<InlineData("--stream-window-bytes", "16383")>]
    [<InlineData("--handshake-timeout-seconds", "NaN")>]
    [<InlineData("--handshake-timeout-seconds", "0")>]
    [<InlineData("--handshake-timeout-seconds", "3601")>]
    [<InlineData("--handshake-timeout-seconds", "1e-100")>]
    [<InlineData("--data-dir", " ")>]
    let ``Invalid server option values are rejected`` name value =
        Assert.NotEmpty(error (serverArgs [| name; value |]))

    [<Theory>]
    [<InlineData("")>]
    [<InlineData("NAME=value")>]
    [<InlineData("NAME\000VALUE")>]
    let ``All secret options require valid environment names`` value =
        Assert.NotEmpty(error (clientArgs [| "--uuid-env"; value |]))
        Assert.NotEmpty(error (serverArgs [| "--admin-password-env"; value |]))
        Assert.NotEmpty(error (serverArgs [| "--gateway-token-env"; value |]))

    [<Fact>]
    let ``The per user tunnel limit cannot exceed the global limit`` () =
        let options = (server [| "--max-tunnels"; "1" |]).Create "master" None
        Assert.Equal(1, options.MaxUserTunnels)
        Assert.NotEmpty(error (serverArgs [| "--max-tunnels"; "1"; "--max-user-tunnels"; "2" |]))

    [<Fact>]
    let ``The tunnel and web listeners require different ports`` () =
        Assert.NotEmpty(error (serverArgs [| "--listen"; "127.0.0.1:18081" |]))
        Assert.NotEmpty(error (serverArgs [| "--listen"; "0.0.0.0:8080"; "--web-listen"; "127.0.0.1:8080" |]))

    [<Fact>]
    let ``Stream limits must fit the session body budget`` () =
        Assert.NotEmpty(error (serverArgs [| "--max-streams"; "256"; "--stream-window-bytes"; "4194304" |]))

    [<Fact>]
    let ``Old password options are rejected without printing their values`` () =
        for role in [ "client"; "server" ] do
            for option in [ [| "--password"; "never-log-this" |]
                            [| "--password-env"; "never-log-this" |]
                            [| "--password=never-log-this" |] ] do
                let message = error (Array.append [| role |] option)
                Assert.DoesNotContain("never-log-this", message)

    [<Theory>]
    [<InlineData("client", "--uuid=never-log-this")>]
    [<InlineData("server", "--gateway-token=never-log-this")>]
    let ``Unknown inline options do not expose credentials`` role option =
        let message = error [| role; option |]
        Assert.DoesNotContain("never-log-this", message)
        Assert.DoesNotContain(option, message)
