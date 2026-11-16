namespace ZProxy.Tests

open System
open System.IO
open System.Security.Cryptography
open System.Text
open System.Threading
open System.Threading.Channels
open System.Threading.Tasks
open Xunit
open ZProxy

module ProtocolTests =

    let private unwrap result =
        match result with
        | Ok value -> value
        | Error message -> failwith message

    let private metadata = Contracts.identity("request-1", true)

    [<Fact>]
    let ``Frames round trip with exact lengths and byte credit`` () =
        let frames =
            [ Frame.OpenRequest(1u, "POST", "/v1/chat/completions", [ "Content-Type", "application/json" ], false)
              Frame.ResponseHeaders(1u, 200, 2uy, [ "Content-Type", "text/event-stream" ], metadata, false)
              Frame.Data(1u, "token"B, true)
              Frame.EndStream 3u
              Frame.CancelStream(3u, "caller closed")
              Frame.Ping "12345678"B
              Frame.Pong "87654321"B
              Frame.WindowUpdate(1u, 16384) ]
        for frame in frames do
            let encoded = Frame.encode frame
            Assert.Equal(frame, Frame.decode encoded |> unwrap)
            Assert.True((Frame.decode (Array.append encoded [| 0uy |])).IsError)
            Assert.True((Frame.decode encoded[0 .. encoded.Length - 2]).IsError)

    [<Fact>]
    let ``Frame reader rejects malformed fields without index errors`` () =
        let encoded = Frame.encode (Frame.OpenRequest(1u, "POST", "/v1/chat/completions", [], false))
        for count in 0 .. encoded.Length - 1 do
            Assert.True((Frame.decode encoded[0 .. count - 1]).IsError)
        let badFlags = Array.copy encoded
        badFlags[5] <- 2uy
        Assert.True((Frame.decode badFlags).IsError)
        let badId = Array.copy encoded
        badId[3] <- 2uy
        Assert.True((Frame.decode badId).IsError)
        let badUtf8 = Array.copy encoded
        badUtf8[9] <- 0xffuy
        Assert.True((Frame.decode badUtf8).IsError)
        let badLength = Array.copy encoded
        badLength[8] <- 255uy
        Assert.True((Frame.decode badLength).IsError)
        let badCredit = Frame.encode (Frame.WindowUpdate(1u, 1))
        Array.Clear(badCredit, 8, 4)
        Assert.True((Frame.decode badCredit).IsError)
        Assert.Throws<InvalidDataException>(fun () -> Frame.encode (Frame.Data(1u, Array.empty, false)) |> ignore) |> ignore
        Assert.Throws<InvalidDataException>(fun () -> Frame.encode (Frame.Data(1u, Array.zeroCreate 16385, false)) |> ignore) |> ignore
        Assert.Throws<InvalidDataException>(fun () -> Frame.encode (Frame.Ping [| 0uy |]) |> ignore) |> ignore
        Assert.Throws<InvalidDataException>(fun () -> Frame.encode (Frame.ResponseHeaders(1u, 200, 11uy, [], metadata, true)) |> ignore) |> ignore

    [<Fact>]
    let ``Response metadata has fixed fields and bounded UTF-8 lengths`` () =
        let boundary =
            { metadata with Decoder = String('d', 64); Version = 65535; ModelAlias = String('m', 128)
                            RequestId = String('r', 64); Attempt = 65535; Recipe = String('x', 8192) }
        let frame value = Frame.ResponseHeaders(1u, 200, 2uy, [], value, false)
        Assert.Equal(frame boundary, Frame.decode (Frame.encode (frame boundary)) |> unwrap)
        let rejected =
            [ { metadata with Decoder = "" }
              { metadata with Decoder = "invalid/decoder" }
              { metadata with Decoder = String('d', 65) }
              { metadata with Version = 0 }
              { metadata with Version = 65536 }
              { metadata with ModelAlias = String('m', 129) }
              { metadata with ModelAlias = String('\u754c', 43) }
              { metadata with ModelAlias = "name\r\nextra" }
              { metadata with RequestId = String('r', 65) }
              { metadata with RequestId = null }
              { metadata with Attempt = 0 }
              { metadata with Attempt = 65536 }
              { metadata with Recipe = null }
              { metadata with Recipe = "recipe\ncontrol" }
              { metadata with Recipe = String('x', 8193) }
              { metadata with Recipe = String('\u754c', 2731) } ]
        for value in rejected do
            Assert.Throws<InvalidDataException>(fun () -> Frame.encode (frame value) |> ignore) |> ignore
        let encoded = Frame.encode (frame metadata)
        for offset, value in [ 13, 3uy; 16, 0xffuy; encoded.Length - 3, 2uy ] do
            let bad = Array.copy encoded
            bad[offset] <- value
            Assert.True((Frame.decode bad).IsError)
        let badDecoderLength = Array.copy encoded
        badDecoderLength[15] <- 65uy
        Assert.True((Frame.decode badDecoderLength).IsError)
        let badVersion = Array.copy encoded
        Array.Clear(badVersion, 16 + Encoding.UTF8.GetByteCount(metadata.Decoder), 2)
        Assert.True((Frame.decode badVersion).IsError)
        let badAttempt = Array.copy encoded
        Array.Clear(badAttempt, badAttempt.Length - 5, 2)
        Assert.True((Frame.decode badAttempt).IsError)

    [<Fact>]
    let ``Response headers and metadata share the frame payload limit`` () =
        let frame value = Frame.ResponseHeaders(1u, 200, 2uy, [ "x-large", value ], metadata, false)
        let overhead = (Frame.encode (frame "")).Length - 8
        let largest = frame (String('a', Frame.MaxPayloadBytes - overhead))
        let encoded = Frame.encode largest
        Assert.Equal(Frame.MaxPayloadBytes + 8, encoded.Length)
        Assert.Equal(largest, Frame.decode encoded |> unwrap)
        Assert.Throws<InvalidDataException>(fun () ->
            Frame.encode (frame (String('a', Frame.MaxPayloadBytes - overhead + 1))) |> ignore) |> ignore

    [<Fact>]
    let ``User UUID credentials have separate selectors and keys`` () =
        let uuid = "6f63a515-50d0-4c3c-9c17-3a10ed9ec1f7"
        let first = Crypto.deriveUserCredential uuid
        let upper = Crypto.deriveUserCredential (uuid.ToUpperInvariant())
        let second = Crypto.deriveUserCredential "ebd98813-833b-4ea0-94e0-d57a26bb40af"
        Assert.Equal(32, first.Selector.Length)
        Assert.Equal(32, first.Key.Length)
        Assert.Equal<byte>(SHA256.HashData(Encoding.ASCII.GetBytes("zproxy-v3-user-selector\000" + uuid)), first.Selector)
        Assert.Equal<byte>(SHA256.HashData(Encoding.ASCII.GetBytes("zproxy-v3-user-key\000" + uuid)), first.Key)
        Assert.Equal<byte>(first.Selector, upper.Selector)
        Assert.Equal<byte>(first.Key, upper.Key)
        Assert.NotEqual<byte>(first.Selector, first.Key)
        Assert.NotEqual<byte>(first.Selector, second.Selector)
        Assert.NotEqual<byte>(first.Key, second.Key)
        for invalid in
            [ null; ""; uuid.Replace("-", ""); "{" + uuid + "}"; uuid + " "
              "6f63a515-50d0-1c3c-9c17-3a10ed9ec1f7"; "6f63a515-50d0-4c3c-1c17-3a10ed9ec1f7" ] do
            let error = Assert.Throws<ArgumentException>(fun () -> Crypto.deriveUserCredential invalid |> ignore)
            if not (String.IsNullOrEmpty(invalid)) then Assert.DoesNotContain(invalid, error.Message)

    [<Fact>]
    let ``Preamble replay table is bounded and handles extreme timestamps`` () =
        let bytes, preamble = Crypto.createPreamble()
        Assert.Equal(preamble, Crypto.parsePreamble(ReadOnlySpan<byte>(bytes)) |> unwrap)
        Assert.True((Crypto.parsePreamble(ReadOnlySpan<byte>(Array.append bytes [| 0uy |]))).IsError)
        let filter = Crypto.ReplayFilter(60000L, maxEntries = 1)
        Assert.True(filter.Validate(preamble))
        Assert.False(filter.Validate(preamble))
        Assert.False(filter.Validate(snd (Crypto.createPreamble())))
        Assert.False(filter.Validate({ preamble with TimestampMs = Int64.MinValue }))
        Assert.False(filter.Validate({ preamble with TimestampMs = Int64.MaxValue }))

    [<Fact>]
    let ``Record authentication binds length direction sequence and first preamble`` () =
        let preamble, _ = Crypto.createPreamble()
        let keys = Crypto.deriveSessionKeys (Array.create 32 7uy) preamble
        Assert.NotEqual<byte>(keys.KeyC2S, keys.KeyS2C)
        use cipher = new ChaCha20Poly1305(keys.KeyC2S)
        let payload = "authenticated record"B
        let sealedBytes = Crypto.sealChunk cipher Crypto.DirC2S 0UL preamble (ReadOnlySpan<byte>(payload))
        let header = sealedBytes[0 .. 2]
        let body = sealedBytes[3 ..]
        let decode direction sequence start length (bytes: byte[]) =
            Crypto.openChunk cipher direction sequence start length (ReadOnlySpan<byte>(bytes))
        Assert.Equal<byte>(payload, decode Crypto.DirC2S 0UL preamble header body |> unwrap)
        Assert.True((decode Crypto.DirC2S 1UL preamble header body).IsError)
        Assert.True((decode Crypto.DirS2C 0UL preamble header body).IsError)
        let otherPreamble = Array.copy preamble
        otherPreamble[0] <- otherPreamble[0] ^^^ 1uy
        Assert.True((decode Crypto.DirC2S 0UL otherPreamble header body).IsError)
        let otherHeader = Array.copy header
        otherHeader[2] <- otherHeader[2] + 1uy
        Assert.True((decode Crypto.DirC2S 0UL preamble otherHeader body).IsError)
        body[body.Length - 1] <- body[body.Length - 1] ^^^ 1uy
        Assert.True((decode Crypto.DirC2S 0UL preamble header body).IsError)
        Assert.Throws<ArgumentException>(fun () -> Crypto.sealChunk cipher Crypto.DirC2S 0UL preamble ReadOnlySpan<byte>.Empty |> ignore) |> ignore

    [<Fact>]
    let ``Streaming Zstd keeps history between turns`` () =
        use compressor = new Zstd.StreamingCompressor(3)
        use decompressor = new Zstd.StreamingDecompressor()
        let prompt = Array.zeroCreate<byte> 16000
        Random(517).NextBytes(prompt)
        let first = compressor.CompressChunk(ReadOnlySpan<byte>(prompt), flush = true)
        let firstPlain = decompressor.DecompressChunk(ReadOnlySpan<byte>(first))
        Assert.Equal<byte>(prompt, firstPlain)
        let second = compressor.CompressChunk(ReadOnlySpan<byte>(prompt), flush = true)
        let secondPlain = decompressor.DecompressChunk(ReadOnlySpan<byte>(second))
        Assert.Equal<byte>(prompt, secondPlain)
        Assert.True(second.Length < first.Length / 10)

    [<Fact>]
    let ``Zstd output and window limits reject excess allocation`` () =
        let prompt = Array.create 32768 65uy
        use compressor = new Zstd.StreamingCompressor(3, windowLog = 23)
        let compressed = compressor.CompressChunk(ReadOnlySpan<byte>(prompt), flush = true)
        use smallWindow = new Zstd.StreamingDecompressor(maxWindowLog = 10)
        Assert.Throws<InvalidDataException>(fun () -> smallWindow.DecompressChunk(ReadOnlySpan<byte>(compressed)) |> ignore) |> ignore
        use smallOutput = new Zstd.StreamingDecompressor()
        Assert.Throws<InvalidDataException>(fun () -> smallOutput.DecompressChunk(ReadOnlySpan<byte>(compressed), maxOutputBytes = 1024) |> ignore) |> ignore
        (smallOutput :> IDisposable).Dispose()
        (smallOutput :> IDisposable).Dispose()
        (compressor :> IDisposable).Dispose()
        (compressor :> IDisposable).Dispose()

    /// Each endpoint has one incoming queue. Reads deliberately split writes.
    type private MemoryDuplex(incoming: Channel<byte[]>, outgoing: Channel<byte[]>, ?writeGate: Task, ?writeStarted: TaskCompletionSource<unit>) =
        inherit Stream()
        let mutable pending = Array.empty<byte>
        let mutable offset = 0
        let mutable disposed = 0
        override _.CanRead = true
        override _.CanWrite = true
        override _.CanSeek = false
        override _.Length = raise (NotSupportedException())
        override _.Position with get() = raise (NotSupportedException()) and set _ = raise (NotSupportedException())
        override _.Seek(_, _) = raise (NotSupportedException())
        override _.SetLength(_) = raise (NotSupportedException())
        override _.Flush() = ()
        override _.FlushAsync(_) = Task.CompletedTask
        override _.Read(_, _, _) = raise (NotSupportedException())
        override _.Write(_, _, _) = raise (NotSupportedException())
        override _.ReadAsync(buffer: Memory<byte>, token: CancellationToken) =
            ValueTask<int>(task {
                if buffer.Length = 0 then return 0
                else
                    if offset = pending.Length then
                        let! more = incoming.Reader.WaitToReadAsync(token)
                        if more then
                            let! bytes = incoming.Reader.ReadAsync(token)
                            pending <- bytes
                            offset <- 0
                    if offset = pending.Length then return 0
                    else
                        let count = min 37 (min buffer.Length (pending.Length - offset))
                        pending.AsMemory(offset, count).CopyTo(buffer)
                        offset <- offset + count
                        return count
            })
        override _.WriteAsync(buffer: ReadOnlyMemory<byte>, token: CancellationToken) =
            ValueTask(task {
                match writeStarted with Some started -> started.TrySetResult(()) |> ignore | None -> ()
                match writeGate with
                | Some gate -> do! gate.WaitAsync(token)
                | None -> ()
                do! outgoing.Writer.WriteAsync(buffer.ToArray(), token)
            })
        override _.Dispose(disposing) =
            if disposing && Interlocked.Exchange(&disposed, 1) = 0 then
                incoming.Writer.TryComplete() |> ignore
                outgoing.Writer.TryComplete() |> ignore
            base.Dispose(disposing)

    let private pair () =
        let left = Channel.CreateUnbounded<byte[]>()
        let right = Channel.CreateUnbounded<byte[]>()
        new MemoryDuplex(left, right), new MemoryDuplex(right, left)

    [<Fact>]
    let ``Tunnel sends both directions with frame and record boundaries independent`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10.0))
        let leftEndpoint, rightEndpoint = pair()
        use left = leftEndpoint
        use right = rightEndpoint
        let preamble, _ = Crypto.createPreamble()
        let keys = Crypto.deriveSessionKeys (Array.create 32 19uy) preamble
        use client = new Tunnel.EncryptedZstdTunnel(left, keys, preamble, true, 23, 23, timeout.Token)
        use server = new Tunnel.EncryptedZstdTunnel(right, keys, preamble, false, 23, 23, timeout.Token)
        CryptographicOperations.ZeroMemory(keys.KeyC2S.AsSpan())
        CryptographicOperations.ZeroMemory(keys.KeyS2C.AsSpan())
        let header value = Frame.ResponseHeaders(1u, 200, 2uy, [ "x-large", value ], metadata, false)
        let overhead = (Frame.encode (header "")).Length - 8
        let largeHeader = header (String('a', Frame.MaxPayloadBytes - overhead))
        let frames = [ Frame.OpenRequest(1u, "POST", "/v1/chat/completions", [], false)
                       Frame.Data(1u, Array.create 16384 66uy, false)
                       Frame.Data(1u, Array.create 16384 67uy, false)
                       Frame.EndStream 1u ]
        let receiveRequest = task {
            for expected in frames do
                let! actual = server.ReceiveAsync(timeout.Token)
                Assert.Equal(Some expected, actual)
        }
        let receiveResponse = task {
            let! actual = client.ReceiveAsync(timeout.Token)
            Assert.Equal(Some largeHeader, actual)
        }
        let sendRequest = task {
            for frame in frames do do! client.SendAsync(frame, timeout.Token)
        }
        do! server.SendAsync(largeHeader, timeout.Token)
        let! _ = Task.WhenAll(receiveRequest, receiveResponse, sendRequest)
        server.PostControl(Frame.WindowUpdate(1u, 32768))
        let! credit = client.ReceiveAsync(timeout.Token)
        Assert.Equal(Some (Frame.WindowUpdate(1u, 32768)), credit)
    }

    [<Fact>]
    let ``Tunnel authentication failure aborts the session`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10.0))
        let leftEndpoint, rightEndpoint = pair()
        use left = leftEndpoint
        use right = rightEndpoint
        let preamble, _ = Crypto.createPreamble()
        let keys = Crypto.deriveSessionKeys (Array.create 32 1uy) preamble
        let otherKeys = Crypto.deriveSessionKeys (Array.create 32 2uy) preamble
        use client = new Tunnel.EncryptedZstdTunnel(left, keys, preamble, true, 23, 23, timeout.Token)
        use server = new Tunnel.EncryptedZstdTunnel(right, otherKeys, preamble, false, 23, 23, timeout.Token)
        do! client.SendAsync(Frame.Ping "12345678"B, timeout.Token)
        let! _ = Assert.ThrowsAsync<InvalidDataException>(fun () -> server.ReceiveAsync(timeout.Token) :> Task)
        let! _ = Assert.ThrowsAsync<InvalidDataException>(fun () -> server.Completion)
        Assert.True(server.Completion.IsFaulted)
        ()
    }

    [<Fact>]
    let ``Credit bursts merge while network writes are blocked`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10.0))
        let leftInput = Channel.CreateUnbounded<byte[]>()
        let rightInput = Channel.CreateUnbounded<byte[]>()
        let gate = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
        let started = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
        use left = new MemoryDuplex(leftInput, rightInput, writeGate = gate.Task, writeStarted = started)
        use right = new MemoryDuplex(rightInput, leftInput)
        let preamble, _ = Crypto.createPreamble()
        let keys = Crypto.deriveSessionKeys (Array.create 32 71uy) preamble
        use client = new Tunnel.EncryptedZstdTunnel(left, keys, preamble, true, 23, 23, timeout.Token)
        use server = new Tunnel.EncryptedZstdTunnel(right, keys, preamble, false, 23, 23, timeout.Token)
        client.PostControl(Frame.Ping "12345678"B)
        do! started.Task.WaitAsync(timeout.Token)
        for _ in 1 .. 500 do client.PostControl(Frame.WindowUpdate(1u, 1))
        for id in 1 .. 255 do client.PostControl(Frame.WindowUpdate(uint32 (id * 2 + 1), 1))
        Assert.False(client.Completion.IsCompleted)
        gate.SetResult(())
        let! ping = server.ReceiveAsync(timeout.Token)
        Assert.Equal(Some (Frame.Ping "12345678"B), ping)
        let mutable returned = 0
        for _ in 1 .. 256 do
            let! frame = server.ReceiveAsync(timeout.Token)
            match frame with
            | Some (Frame.WindowUpdate(id, credit)) ->
                Assert.Equal((if id = 1u then 500 else 1), credit)
                returned <- returned + credit
            | other -> Assert.Fail(sprintf "Unexpected credit frame: %A" other)
        Assert.Equal(755, returned)
    }

    [<Fact>]
    let ``Writer failure wakes a pending receive`` () = task {
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10.0))
        let incoming = Channel.CreateUnbounded<byte[]>()
        let outgoing = Channel.CreateUnbounded<byte[]>()
        outgoing.Writer.TryComplete(IOException("Closed test peer")) |> ignore
        use endpoint = new MemoryDuplex(incoming, outgoing)
        let preamble, _ = Crypto.createPreamble()
        let keys = Crypto.deriveSessionKeys (Array.create 32 37uy) preamble
        use tunnel = new Tunnel.EncryptedZstdTunnel(endpoint, keys, preamble, true, 23, 23, timeout.Token)
        let receive = tunnel.ReceiveAsync(timeout.Token)
        do! tunnel.SendAsync(Frame.Ping "12345678"B, timeout.Token)
        let! _ = Assert.ThrowsAnyAsync<Exception>(fun () -> receive :> Task)
        let! _ = Assert.ThrowsAnyAsync<Exception>(fun () -> tunnel.Completion)
        Assert.True(tunnel.Completion.IsFaulted)
        (tunnel :> IDisposable).Dispose()
        (tunnel :> IDisposable).Dispose()
    }

    [<Fact>]
    let ``An already canceled tunnel completes resource cleanup`` () = task {
        let first, second = pair()
        use left = first
        use right = second
        let preamble, _ = Crypto.createPreamble()
        let keys = Crypto.deriveSessionKeys (Array.create 32 13uy) preamble
        use canceled = new CancellationTokenSource()
        canceled.Cancel()
        use tunnel = new Tunnel.EncryptedZstdTunnel(left, keys, preamble, true, 23, 23, canceled.Token)
        let! _ = Assert.ThrowsAnyAsync<OperationCanceledException>(fun () ->
            tunnel.Completion.WaitAsync(TimeSpan.FromSeconds(5.0)))
        Assert.True(tunnel.Completion.IsCanceled)
        (tunnel :> IDisposable).Dispose()
        (tunnel :> IDisposable).Dispose()
    }
