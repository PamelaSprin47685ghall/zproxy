namespace ZProxy.Tests

open System
open System.Buffers.Binary
open System.IO
open System.Net
open System.Net.Http
open System.Text
open System.Text.Json
open System.Threading
open Xunit
open ZProxy

module OmpMetadataTests =
    let private recipe = """{"api":"openai-completions","provider":"example","id":"model","reasoning":true,"input":["text"],"contextWindow":8192,"maxTokens":1024,"compat":{}}"""

    let private metadata value =
        let encoded = JsonSerializer.Serialize<string>(value)
        Encoding.UTF8.GetBytes("""{"decoder":"omp-response","version":1,"modelAlias":"public","requestId":"request","attempt":1,"isStreaming":true,"recipe":""" + encoded + "}")

    [<Fact>]
    let ``A recipe permits only parser settings and no account state`` () =
        let result = OmpMetadata.read (metadata recipe)
        Assert.Equal("omp-response", result.Decoder)
        Assert.Equal(recipe, result.Recipe)
        for field in [ "apiKey"; "baseUrl"; "headers"; "authorization"; "credentials"; "account"; "routing" ] do
            let unsafeRecipe = recipe.Substring(0, recipe.Length - 1) + ",\"" + field + "\":\"secret\"}"
            Assert.Throws<InvalidDataException>(fun () -> OmpMetadata.read (metadata unsafeRecipe) |> ignore) |> ignore

    [<Fact>]
    let ``Antigravity codec metadata carries only a known model family`` () =
        let ag = recipe.Replace("openai-completions", "antigravity2api").Replace("example", "google-antigravity")
        for family in [ "google"; "anthropic"; "openai" ] do
            let value = ag.Replace("\"compat\":{}", "\"compat\":{\"agProvider\":\"" + family + "\"}")
            Assert.True(OmpMetadata.needsRequestPreparation value)
            Assert.Equal(value, (OmpMetadata.read (metadata value)).Recipe)
        for value in [ ag
                       ag.Replace("\"compat\":{}", "\"compat\":{\"agProvider\":\"unknown\"}")
                       recipe.Replace("\"compat\":{}", "\"compat\":{\"agProvider\":\"google\"}") ] do
            Assert.Throws<InvalidDataException>(fun () -> OmpMetadata.read (metadata value) |> ignore) |> ignore
        Assert.False(OmpMetadata.needsRequestPreparation recipe)

    [<Theory>]
    [<InlineData("\"api\":\"openai-completions\"", "\"api\":\"unknown\"")>]
    [<InlineData("\"provider\":\"example\"", "\"provider\":\"\"")>]
    [<InlineData("\"contextWindow\":8192", "\"contextWindow\":0")>]
    [<InlineData("\"maxTokens\":1024", "\"maxTokens\":2147483648")>]
    [<InlineData("\"reasoning\":true", "\"reasoning\":1")>]
    [<InlineData("\"input\":[\"text\"]", "\"input\":[\"text\",\"text\"]")>]
    [<InlineData("\"compat\":{}", "\"compat\":{\"apiKey\":\"secret\"}")>]
    [<InlineData("\"compat\":{}", "\"compat\":{\"toolNamePrefix\":\"prefix\\nheader\"}")>]
    [<InlineData("\"compat\":{}", "\"compat\":{\"streamMarkupHealingPattern\":\"code\"}")>]
    [<InlineData("\"compat\":{}", "\"compat\":{\"flashStreamLeakWorkaround\":true,\"flashStreamLeakWorkaround\":false}")>]
    let ``Invalid parser recipes fail at the remote boundary`` (before: string) after =
        Assert.Throws<InvalidDataException>(fun () -> OmpMetadata.read (metadata (recipe.Replace(before, after))) |> ignore) |> ignore

    [<Fact>]
    let ``Metadata rejects unknown duplicate or oversized fields`` () =
        let valid = Encoding.UTF8.GetString(metadata recipe)
        for text in [ valid.Replace("\"version\":1", "\"version\":2")
                      valid.Replace("\"attempt\":1", "\"attempt\":0")
                      valid.Replace("\"decoder\":", "\"account\":\"secret\",\"decoder\":")
                      valid.Replace("\"attempt\":1", "\"attempt\":1,\"attempt\":1")
                      String(' ', 16385) ] do
            Assert.Throws<InvalidDataException>(fun () -> OmpMetadata.read (Encoding.UTF8.GetBytes(text)) |> ignore) |> ignore

    [<Fact>]
    let ``Reading the metadata prefix leaves all raw body bytes untouched`` () = task {
        let bytes = metadata recipe
        let prefix = Array.zeroCreate<byte> 4
        BinaryPrimitives.WriteUInt32BigEndian(prefix.AsSpan(), uint32 bytes.Length)
        use body = new MemoryStream(Array.concat [ prefix; bytes; "raw-upstream-body"B ])
        let! value = OmpMetadata.readPrefix body CancellationToken.None
        Assert.Equal(recipe, value.Recipe)
        use remaining = new StreamReader(body)
        let! text = remaining.ReadToEndAsync()
        Assert.Equal("raw-upstream-body", text)
    }

    [<Fact>]
    let ``The decoder envelope contains safe headers and exact request length`` () =
        use response = new HttpResponseMessage(HttpStatusCode.OK)
        response.Content <- new StringContent("")
        response.Content.Headers.ContentType <- Headers.MediaTypeHeaderValue("text/event-stream")
        response.Headers.TryAddWithoutValidation("Authorization", "provider-secret") |> ignore
        response.Headers.TryAddWithoutValidation("Set-Cookie", "account-secret") |> ignore
        let bytes = OmpMetadata.envelope "/v1/chat/completions" 123L (OmpMetadata.read (metadata recipe)) response
        use document = JsonDocument.Parse(ReadOnlyMemory<byte>(bytes))
        Assert.Equal(123L, document.RootElement.GetProperty("requestBytes").GetInt64())
        Assert.Equal(200, document.RootElement.GetProperty("status").GetInt32())
        let text = Encoding.UTF8.GetString(bytes)
        Assert.DoesNotContain("provider-secret", text)
        Assert.DoesNotContain("account-secret", text)
        Assert.Contains("text/event-stream", text)
