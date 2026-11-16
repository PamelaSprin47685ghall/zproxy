namespace ZProxy.Tests

open System
open System.Net.Http
open System.Text
open Xunit
open ZProxy

module HttpUtilsTests =
    [<Theory>]
    [<InlineData("/https://example.test/v1/a%2Fb?x=a%2Fb&y=%252f", "https://example.test/v1/a%2Fb?x=a%2Fb&y=%252f")>]
    [<InlineData("/http://[::1]:8080/v1?q=1", "http://[::1]:8080/v1?q=1")>]
    let ``Direct target preserves escaped path and query`` path expected =
        match HttpUtils.parseTargetUrl path with
        | Ok uri -> Assert.Equal(expected, uri.OriginalString)
        | Error error -> failwith error

    [<Fact>]
    let ``Hex target preserves origin prefix and suffix`` () =
        let encoded = Convert.ToHexString(Encoding.UTF8.GetBytes("https://example.test/base/"))
        match HttpUtils.parseTargetUrl ("/" + encoded + "/chat?x=%2F") with
        | Ok uri -> Assert.Equal("https://example.test/base/chat?x=%2F", uri.OriginalString)
        | Error error -> failwith error

    [<Theory>]
    [<InlineData("/ftp://example.test/file")>]
    [<InlineData("/https://user:password@example.test/a")>]
    [<InlineData("/https://example.test/a#fragment")>]
    [<InlineData("/xyz")>]
    let ``Unsupported targets are rejected`` path =
        Assert.True(HttpUtils.parseTargetUrl path |> Result.isError)

    [<Fact>]
    let ``Connection tokens are removed with hop fields`` () =
        let source =
            [ "Connection", "keep-alive, X-Private"; "X-Private", "local"
              "Transfer-Encoding", "chunked"; "Host", "localhost"
              "Content-Encoding", "gzip"; "Authorization", "Bearer example" ]
        Assert.Equal<(string * string) list>(
            [ "Content-Encoding", "gzip"; "Authorization", "Bearer example" ],
            HttpUtils.filterHeaders source)

    [<Fact>]
    let ``Content headers and repeated response fields survive forwarding`` () =
        use response = new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        response.Content <- new ByteArrayContent([| 1uy; 2uy |])
        HttpUtils.addResponseHeaders response
            [ "Content-Type", "application/octet-stream"; "Content-Encoding", "gzip"
              "Set-Cookie", "a=1"; "Set-Cookie", "b=2" ]
        let headers = HttpUtils.responseHeaders response
        Assert.Contains(("Content-Encoding", "gzip"), headers)
        Assert.Equal(2, headers |> List.filter (fun (key, _) -> key = "Set-Cookie") |> List.length)
