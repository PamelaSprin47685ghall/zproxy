namespace ZProxy.Tests

open System
open System.Net
open System.Net.Http
open Xunit
open ZProxy

module HttpUtilsTests =
    [<Theory>]
    [<InlineData("http://127.0.0.1:3000", true)>]
    [<InlineData("https://gateway.example/", true)>]
    [<InlineData("http://[::1]:3000/", true)>]
    [<InlineData("https://gateway.example/v1", false)>]
    [<InlineData("https://user:password@gateway.example/", false)>]
    [<InlineData("https://gateway.example/?route=other", false)>]
    [<InlineData("https://gateway.example/#fragment", false)>]
    [<InlineData("ftp://gateway.example/", false)>]
    let ``Gateway configuration accepts only a fixed authority`` address expected =
        Assert.Equal(expected, HttpUtils.validGateway (Uri(address)))

    [<Theory>]
    [<InlineData("/v1/chat/completions")>]
    [<InlineData("/v1/completions")>]
    let ``Completion contracts contain only a logical path`` path =
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri path)
        Assert.Equal("zproxy.internal", request.RequestUri.Host)
        Assert.Equal(path, Contracts.requestPath request)

    [<Theory>]
    [<InlineData("GET", "http://zproxy.internal/v1/chat/completions")>]
    [<InlineData("POST", "http://zproxy.internal/v1/models")>]
    [<InlineData("POST", "http://zproxy.internal/v1/chat/completions?target=other")>]
    [<InlineData("POST", "http://zproxy.internal/v1/chat/completions#fragment")>]
    [<InlineData("POST", "http://zproxy.internal/https://other.example/v1/chat/completions")>]
    [<InlineData("POST", "/v1/chat/completions")>]
    let ``Other operations cannot enter the remote request contract`` method address =
        use request = new HttpRequestMessage(HttpMethod(method), Uri(address, UriKind.RelativeOrAbsolute))
        Assert.Throws<ArgumentException>(fun () -> Contracts.requestPath request |> ignore) |> ignore

    [<Fact>]
    let ``Connection tokens remove even allowed fields`` () =
        let source =
            [ "Connection", "keep-alive, Accept-Encoding"; "Accept-Encoding", "gzip"
              "Transfer-Encoding", "chunked"; "Host", "localhost"
              "Content-Type", "application/json"; "Authorization", "Bearer private" ]
        Assert.Equal<(string * string) list>(
            [ "Content-Type", "application/json" ], HttpUtils.safeRequestHeaders source)

    [<Fact>]
    let ``Request forwarding removes credentials and identity claims`` () =
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/completions")
        request.Content <- new ByteArrayContent([| 1uy; 2uy |])
        HttpUtils.addRequestHeaders request
            [ "Content-Type", "application/json"; "Accept", "text/event-stream"
              "Accept-Encoding", "identity"; "Authorization", "Bearer private"
              "Cookie", "session=private"; "X-User-Id", "another-user"
              "X-Api-Key", "private"; "Forwarded", "for=other" ]
        let headers = HttpUtils.requestHeaders request
        Assert.Contains(("Content-Type", "application/json"), headers)
        Assert.Contains(("Accept", "text/event-stream"), headers)
        Assert.Contains(("Accept-Encoding", "identity"), headers)
        for name in [ "Authorization"; "Cookie"; "X-User-Id"; "X-Api-Key"; "Forwarded" ] do
            Assert.DoesNotContain(headers, fun (key, _) -> key.Equals(name, StringComparison.OrdinalIgnoreCase))

    [<Fact>]
    let ``Response forwarding keeps body metadata and removes account state`` () =
        use response = new HttpResponseMessage(HttpStatusCode.OK)
        response.Content <- new ByteArrayContent([| 1uy; 2uy |])
        HttpUtils.addResponseHeaders response
            [ "Content-Type", "application/octet-stream"; "Content-Encoding", "gzip"
              "Cache-Control", "no-store"; "Retry-After", "10"
              "Set-Cookie", "session=private"; "Authorization", "Bearer private"
              "X-Provider-Account", "private"; "X-Decoder", "untrusted" ]
        let headers = HttpUtils.responseHeaders response
        Assert.Contains(("Content-Encoding", "gzip"), headers)
        Assert.Contains(("Cache-Control", "no-store"), headers)
        Assert.Contains(("Retry-After", "10"), headers)
        for name in [ "Set-Cookie"; "Authorization"; "X-Provider-Account"; "X-Decoder" ] do
            Assert.DoesNotContain(headers, fun (key, _) -> key.Equals(name, StringComparison.OrdinalIgnoreCase))
