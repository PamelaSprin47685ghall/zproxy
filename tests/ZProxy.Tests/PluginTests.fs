namespace ZProxy.Tests

open System.IO
open System.Net
open System.Net.Http
open System.Threading
open System.Threading.Tasks
open Xunit
open ZProxy

module PluginTests =
    type private TrackedContent() =
        inherit ByteArrayContent("raw provider bytes"B)
        let mutable closed = false
        member _.Closed = closed
        override this.Dispose(disposing) =
            closed <- true
            base.Dispose(disposing)

    let private reply metadata =
        let content = new TrackedContent()
        let response = new HttpResponseMessage(HttpStatusCode.OK, Content = content)
        ({ Response = response; Metadata = metadata }: Contracts.RemoteReply), content

    [<Fact>]
    let ``OpenAI responses stream without a semantic decoder`` () = task {
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/completions")
        let raw, content = reply (Contracts.identity("request-1", false))
        use! response = Plugins.decode [] request raw CancellationToken.None
        Assert.Same(raw.Response, response)
        Assert.False(content.Closed)
        let! text = response.Content.ReadAsStringAsync()
        Assert.Equal("raw provider bytes", text)
    }

    [<Fact>]
    let ``Decoder receives the typed metadata and original request`` () = task {
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/chat/completions")
        let metadata = { Contracts.identity("request-2", true) with Decoder = "omp-test"; ModelAlias = "public-model" }
        let raw, content = reply metadata
        use stop = new CancellationTokenSource()
        let decoder =
            { new IResponseDecoder with
                member _.Id = "omp-test"
                member _.Version = 1
                member _.Decode(input, info, response, ct) =
                    Assert.Same(request, input)
                    Assert.Equal(metadata, info)
                    Assert.Equal(stop.Token, ct)
                    Assert.Same(raw.Response, response)
                    response.Dispose()
                    Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK, Content = new StringContent("decoded"))) }
        use! response = Plugins.decode [ decoder ] request raw stop.Token
        Assert.True(content.Closed)
        let! text = response.Content.ReadAsStringAsync()
        Assert.Equal("decoded", text)
    }

    [<Theory>]
    [<InlineData("missing", 1)>]
    [<InlineData("omp-test", 2)>]
    [<InlineData("openai-completions", 2)>]
    let ``Unavailable decoders fail before raw provider data reaches the application`` name version = task {
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/chat/completions")
        let metadata = { Contracts.identity("request-3", true) with Decoder = name; Version = version }
        let raw, content = reply metadata
        let decoder =
            { new IResponseDecoder with
                member _.Id = "omp-test"
                member _.Version = 1
                member _.Decode(_, _, _, _) = failwith "This decoder must not run." }
        let! _ = Assert.ThrowsAsync<InvalidDataException>(fun () -> Plugins.decode [ decoder ] request raw CancellationToken.None :> Task)
        Assert.True(content.Closed)
    }

    [<Fact>]
    let ``Decoder failure closes the raw response`` () = task {
        use request = new HttpRequestMessage(HttpMethod.Post, Contracts.logicalUri "/v1/completions")
        let raw, content = reply { Contracts.identity("request-4", false) with Decoder = "omp-test" }
        let decoder =
            { new IResponseDecoder with
                member _.Id = "omp-test"
                member _.Version = 1
                member _.Decode(_, _, _, _) = Task.FromException<HttpResponseMessage>(InvalidDataException("Invalid provider response.")) }
        let! _ = Assert.ThrowsAsync<InvalidDataException>(fun () -> Plugins.decode [ decoder ] request raw CancellationToken.None :> Task)
        Assert.True(content.Closed)
    }
