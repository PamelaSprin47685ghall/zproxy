namespace ZProxy.Tests

open System
open System.Security.Cryptography
open System.Text
open Xunit
open ZProxy

module BaseTests =

    [<Fact>]
    let ``Crypto: Argon2id master key and session derivation with spec AAD`` () =
        let pwd = "SuperSecretMasterPassword123"
        let mKey = Crypto.deriveMasterKey pwd
        Assert.Equal(32, mKey.Length)

        let preambleBytes, preamble = Crypto.createPreamble ()
        Assert.Equal(32, preambleBytes.Length)
        let parsedRes = Crypto.parsePreamble (ReadOnlySpan<byte>(preambleBytes))
        match parsedRes with
        | Ok parsed ->
            Assert.Equal<byte>(preamble.Salt, parsed.Salt)
            Assert.Equal(preamble.TimestampMs, parsed.TimestampMs)
        | Error err ->
            Assert.Fail(err)

        let filter = Crypto.ReplayFilter(60_000L)
        Assert.True(filter.Validate(preamble))
        Assert.False(filter.Validate(preamble)) // Replay must fail

        let keys = Crypto.deriveSessionKeys mKey preambleBytes
        Assert.Equal(32, keys.KeyC2S.Length)
        Assert.Equal(32, keys.KeyS2C.Length)

        // Seal and open with specification AAD
        use aeadC = new ChaCha20Poly1305(keys.KeyC2S)
        use aeadS = new ChaCha20Poly1305(keys.KeyC2S)
        let plain = "Hello, spec compliant full-duplex zproxy!"B
        let sealedChunk = Crypto.sealChunk aeadC Crypto.DirC2S 0UL preambleBytes (ReadOnlySpan<byte>(plain))
        let lenHeader = [| sealedChunk.[0]; sealedChunk.[1]; sealedChunk.[2] |]
        let opened = Crypto.openChunk aeadS Crypto.DirC2S 0UL preambleBytes lenHeader (ReadOnlySpan<byte>(sealedChunk, 3, sealedChunk.Length - 3))
        match opened with
        | Ok pt -> Assert.Equal<byte>(plain, pt)
        | Error e -> Assert.Fail(e)

        // Tamper test
        sealedChunk.[sealedChunk.Length - 1] <- sealedChunk.[sealedChunk.Length - 1] ^^^ 0xFFuy
        let tampered = Crypto.openChunk aeadS Crypto.DirC2S 0UL preambleBytes lenHeader (ReadOnlySpan<byte>(sealedChunk, 3, sealedChunk.Length - 3))
        Assert.True(tampered.IsError)

    [<Fact>]
    let ``Zstd: 256MB window streaming compressor and decompressor`` () =
        use comp = new Zstd.StreamingCompressor(3, windowLog = 28)
        use decomp = new Zstd.StreamingDecompressor(maxWindowLog = 29)

        let text1 = "Turn 1: Repeating prompt prefix for LLM multi-turn conversation test. " + String.replicate 50 "Alpha Beta Gamma "
        let bytes1 = Encoding.UTF8.GetBytes(text1)
        let c1 = comp.CompressChunk(ReadOnlySpan<byte>(bytes1), flush = true)
        let d1 = decomp.DecompressChunk(ReadOnlySpan<byte>(c1))
        Assert.Equal(text1, Encoding.UTF8.GetString(d1))

        let text2 = text1 + "Turn 2: delta user message."
        let bytes2 = Encoding.UTF8.GetBytes(text2)
        let c2 = comp.CompressChunk(ReadOnlySpan<byte>(bytes2), flush = true)
        let d2 = decomp.DecompressChunk(ReadOnlySpan<byte>(c2))
        Assert.Equal(text2, Encoding.UTF8.GetString(d2))

    [<Fact>]
    let ``Frame: Encode and decode round-trip with ProtoVersion`` () =
        let fOpen = Frame.Frame.OpenRequest (1u, "POST", "https://api.mistral.ai/v1/chat/completions?alt=sse", [ "Authorization", "Bearer xyz"; "Content-Type", "application/json" ], false)
        let fOpenEnc = Frame.encode fOpen
        match Frame.decode fOpenEnc with
        | Ok (Frame.Frame.OpenRequest (sid, m, u, hdrs, es)) ->
            Assert.Equal(1u, sid)
            Assert.Equal("POST", m)
            Assert.Equal("https://api.mistral.ai/v1/chat/completions?alt=sse", u)
            Assert.Equal(2, hdrs.Length)
            Assert.False(es)
        | res -> Assert.Fail(sprintf "Expected OpenRequest, got %A" res)

        // ResponseHeaders with protoVersion = 30uy (HTTP/3)
        let fResp = Frame.Frame.ResponseHeaders (1u, 200, 30uy, [ "Content-Type", "text/event-stream" ], false)
        let fRespEnc = Frame.encode fResp
        match Frame.decode fRespEnc with
        | Ok (Frame.Frame.ResponseHeaders (sid, status, protoVer, hdrs, es)) ->
            Assert.Equal(1u, sid)
            Assert.Equal(200, status)
            Assert.Equal(30uy, protoVer)
            Assert.Equal(1, hdrs.Length)
            Assert.False(es)
        | res -> Assert.Fail(sprintf "Expected ResponseHeaders, got %A" res)

    [<Fact>]
    let ``HttpUtils: parseTargetUrl with direct and hex encoded URLs`` () =
        match HttpUtils.parseTargetUrl "/https://api.mistral.ai/v1/models" with
        | Ok u -> Assert.Equal("https://api.mistral.ai/v1/models", u.ToString())
        | Error e -> Assert.Fail(e)

        match HttpUtils.parseTargetUrl "/https://daily-cloudcode-pa.googleapis.com/v1:stream?alt=sse" with
        | Ok u -> Assert.Equal("https://daily-cloudcode-pa.googleapis.com/v1:stream?alt=sse", u.ToString())
        | Error e -> Assert.Fail(e)

        let baseHex = Convert.ToHexString(Encoding.UTF8.GetBytes("https://api.mistral.ai"))
        match HttpUtils.parseTargetUrl (sprintf "/%s/v1/chat" baseHex) with
        | Ok u -> Assert.Equal("https://api.mistral.ai/v1/chat", u.ToString())
        | Error e -> Assert.Fail(e)