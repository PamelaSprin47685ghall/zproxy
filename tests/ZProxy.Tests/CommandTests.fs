namespace ZProxy.Tests

open System
open System.Net
open Xunit
open ZProxy

module CommandTests =
    let private parse args =
        match Program.parse args with
        | Ok command -> command
        | Error message -> failwith message

    let private client args =
        match parse (Array.append [| "client"; "--server"; "http://example.test:8080" |] args) with
        | Program.StartClient options -> options
        | _ -> failwith "Expected a client command."

    let private server args =
        match parse (Array.append [| "server" |] args) with
        | Program.StartServer options -> options
        | _ -> failwith "Expected a server command."

    let private error args =
        match Program.parse args with
        | Error message -> message
        | Ok _ -> failwith "Expected an invalid command."

    [<Fact>]
    let ``Client defaults use the fixed tunnel path and require a password variable`` () =
        let pending = client [||]
        let options = pending.Create "test-password"
        Assert.Equal("ZPROXY_PASSWORD", pending.PasswordEnvironment)
        Assert.Equal(IPEndPoint(IPAddress.Loopback, 18080), options.Listen)
        Assert.Equal("http://example.test:8080/tunnel", options.Server.AbsoluteUri)
        Assert.Equal(Options.defaults, options.Limits)
        Assert.Equal(TimeSpan.FromSeconds(15.0), options.ConnectTimeout)
        Assert.True(Program.bindPassword (fun _ -> null) pending |> Result.isError)

    [<Fact>]
    let ``Server defaults and explicit limits produce server options`` () =
        let defaults = (server [||]).Create "test-password"
        Assert.Equal(IPEndPoint(IPAddress.Any, 80), defaults.Listen)
        Assert.Equal(16, defaults.MaxTunnels)
        let pending =
            server [| "--listen"; "[::1]:8081"; "--max-tunnels"; "32"
                      "--upload-window-log"; "22"; "--download-window-log"; "18"
                      "--max-streams"; "8"; "--stream-window-bytes"; "65536"
                      "--handshake-timeout-seconds"; "2.5" |]
        let options = pending.Create "test-password"
        Assert.Equal(IPEndPoint(IPAddress.IPv6Loopback, 8081), options.Listen)
        Assert.Equal(32, options.MaxTunnels)
        Assert.Equal(22, options.Limits.UploadWindowLog)
        Assert.Equal(18, options.Limits.DownloadWindowLog)
        Assert.Equal(8, options.Limits.MaxStreams)
        Assert.Equal(65536, options.Limits.StreamWindowBytes)
        Assert.Equal(TimeSpan.FromSeconds(2.5), options.HandshakeTimeout)

    [<Fact>]
    let ``Client settings and password resolution preserve the supplied password`` () =
        let pending = client [| "--password-env"; "MY_PROXY_PASSWORD"; "--connect-timeout-seconds"; "3.5" |]
        let mutable requestedName = ""
        let options =
            match Program.bindPassword (fun name -> requestedName <- name; " exact password ") pending with
            | Ok options -> options
            | Error message -> failwith message
        Assert.Equal("MY_PROXY_PASSWORD", requestedName)
        Assert.Equal(" exact password ", options.Password)
        Assert.Equal(TimeSpan.FromSeconds(3.5), options.ConnectTimeout)

    [<Theory>]
    [<InlineData("")>]
    [<InlineData("   ")>]
    [<InlineData("\t\r\n")>]
    let ``A blank password is rejected`` value =
        let pending = server [||]
        Assert.True(Program.bindPassword (fun _ -> value) pending |> Result.isError)

    [<Theory>]
    [<InlineData("")>]
    [<InlineData("--help")>]
    [<InlineData("-h")>]
    [<InlineData("client --help")>]
    [<InlineData("server -h")>]
    let ``Help does not require a server or password`` (command: string) =
        let args = command.Split(' ', StringSplitOptions.RemoveEmptyEntries)
        match parse args with
        | Program.Help -> ()
        | _ -> failwith "Expected help."

    [<Theory>]
    [<InlineData("unknown")>]
    [<InlineData("client")>]
    [<InlineData("server --unknown value")>]
    [<InlineData("server --listen")>]
    [<InlineData("server --listen --max-tunnels 2")>]
    [<InlineData("server --max-tunnels 1 --max-tunnels 2")>]
    [<InlineData("server --server http://example.test")>]
    [<InlineData("server --connect-timeout-seconds 3")>]
    [<InlineData("client --server http://example.test --max-tunnels 2")>]
    [<InlineData("client --server http://example.test --handshake-timeout-seconds 3")>]
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
        | Program.StartClient pending -> Assert.Equal("/tunnel", (pending.Create "password").Server.AbsolutePath)
        | _ -> failwith "Expected client options."

    [<Theory>]
    [<InlineData("localhost:8080")>]
    [<InlineData("::1:8080")>]
    [<InlineData("[::1]")>]
    [<InlineData("[127.0.0.1]:8080")>]
    [<InlineData("127.0.0.1:0")>]
    [<InlineData("127.0.0.1:65536")>]
    [<InlineData("127.0.0.1:abc")>]
    let ``Invalid listener addresses are rejected`` value =
        Assert.NotEmpty(error [| "server"; "--listen"; value |])

    [<Theory>]
    [<InlineData("--max-tunnels", "0")>]
    [<InlineData("--max-tunnels", "1025")>]
    [<InlineData("--max-streams", "257")>]
    [<InlineData("--max-streams", "-1")>]
    [<InlineData("--upload-window-log", "24")>]
    [<InlineData("--download-window-log", "9")>]
    [<InlineData("--stream-window-bytes", "16383")>]
    [<InlineData("--handshake-timeout-seconds", "NaN")>]
    [<InlineData("--handshake-timeout-seconds", "0")>]
    [<InlineData("--handshake-timeout-seconds", "3601")>]
    [<InlineData("--handshake-timeout-seconds", "1e-100")>]
    [<InlineData("--password-env", "")>]
    [<InlineData("--password-env", "NAME=value")>]
    let ``Invalid option values are rejected`` name value =
        Assert.NotEmpty(error [| "server"; name; value |])

    [<Fact>]
    let ``Stream limits must fit the session body budget`` () =
        Assert.NotEmpty(error [| "server"; "--max-streams"; "256"; "--stream-window-bytes"; "4194304" |])

    [<Fact>]
    let ``A plaintext password option is rejected without printing the password`` () =
        let message = error [| "server"; "--password"; "never-log-this" |]
        Assert.DoesNotContain("never-log-this", message)
        let inlineMessage = error [| "server"; "--password=never-log-this" |]
        Assert.DoesNotContain("never-log-this", inlineMessage)
