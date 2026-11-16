namespace ZProxy

open System
open System.Buffers.Binary
open System.Collections.Generic
open System.IO
open System.Security.Cryptography
open System.Threading
open System.Threading.Channels
open System.Threading.Tasks

module Tunnel =

    /// A single writer owns compression and encryption. A single caller owns receive.
    type EncryptedZstdTunnel(stream: Stream, keys: Crypto.SessionKeys, preamble: byte[], isClient: bool,
                             sendWindowLog: int, receiveWindowLog: int, ct: CancellationToken) =
        let sendDirection = if isClient then Crypto.DirC2S else Crypto.DirS2C
        let receiveDirection = if isClient then Crypto.DirS2C else Crypto.DirC2S
        let encrypt = new ChaCha20Poly1305(if isClient then keys.KeyC2S else keys.KeyS2C)
        let decrypt = new ChaCha20Poly1305(if isClient then keys.KeyS2C else keys.KeyC2S)
        let compressor = new Zstd.StreamingCompressor(3, windowLog = sendWindowLog)
        let decompressor = new Zstd.StreamingDecompressor(maxWindowLog = receiveWindowLog)
        let lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct)
        let lifetimeToken = lifetime.Token
        let stateGate = obj()
        let creditGate = obj()
        let credits = Dictionary<uint32, int>()
        let data = Channel.CreateBounded<byte[]>(BoundedChannelOptions(16, SingleReader = true, FullMode = BoundedChannelFullMode.Wait))
        let control = Channel.CreateBounded<byte[]>(BoundedChannelOptions(64, SingleReader = true, FullMode = BoundedChannelFullMode.Wait))
        let wake = Channel.CreateBounded<unit>(BoundedChannelOptions(1, SingleReader = true, FullMode = BoundedChannelFullMode.DropWrite))
        let completion = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
        let mutable stopped = false
        let mutable stopError: exn option = None
        let mutable readerActive = false
        let mutable writerDone = false
        let mutable released = false
        let mutable sendSequence = 1UL
        let mutable receiveSequence = 1UL
        let frameBytes = Array.zeroCreate<byte> (Frame.MaxPayloadBytes + 8)
        let mutable frameCount = 0
        let mutable frameLength = 8
        let mutable decodedBytes = Array.empty<byte>
        let mutable decodedOffset = 0
        let recordLength = Array.zeroCreate<byte> 3
        let ciphertext = Array.zeroCreate<byte> (Crypto.MaxChunkBytes + 16)

        let release () =
            let cleanup =
                lock stateGate (fun () ->
                    if stopped && writerDone && not readerActive && not released then
                        released <- true
                        Some stopError
                    else None)
            match cleanup with
            | None -> ()
            | Some reason ->
                let mutable failure = reason
                try
                    try decrypt.Dispose()
                    finally
                        try (decompressor :> IDisposable).Dispose()
                        finally lifetime.Dispose()
                with error -> failure <- Some error
                match failure with
                | None -> completion.TrySetResult(()) |> ignore
                | Some (:? OperationCanceledException) -> completion.TrySetCanceled() |> ignore
                | Some cause -> completion.TrySetException(cause) |> ignore

        let stop (error: exn option) =
            let first =
                lock stateGate (fun () ->
                    if stopped then false
                    else
                        stopped <- true
                        stopError <- error
                        true)
            if first then
                let reason = defaultArg error (OperationCanceledException("Tunnel closed"))
                data.Writer.TryComplete(reason) |> ignore
                control.Writer.TryComplete(reason) |> ignore
                wake.Writer.TryComplete(reason) |> ignore
                try lifetime.Cancel() with :? ObjectDisposedException -> ()
                lock creditGate (fun () -> credits.Clear())
                try stream.Dispose() with _ -> ()
                release()

        let signal () = wake.Writer.TryWrite(()) |> ignore

        let takeCredit () =
            lock creditGate (fun () ->
                if credits.Count = 0 then None
                else
                    use mutable entries = credits.GetEnumerator()
                    entries.MoveNext() |> ignore
                    let entry = entries.Current
                    credits.Remove(entry.Key) |> ignore
                    Some (Frame.encode (Frame.WindowUpdate(entry.Key, entry.Value))))

        let writer =
            task {
                try
                    try
                        let batch = Array.zeroCreate<byte> 32768
                        let mutable pending = Array.empty<byte>
                        let mutable pendingOffset = 0
                        while not lifetimeToken.IsCancellationRequested do
                            let mutable count = 0
                            let mutable available = true
                            while count < batch.Length && available do
                                if pendingOffset = pending.Length then
                                    let mutable next = Unchecked.defaultof<byte[]>
                                    if control.Reader.TryRead(&next) then
                                        pending <- next
                                        pendingOffset <- 0
                                    else
                                        match takeCredit() with
                                        | Some bytes ->
                                            pending <- bytes
                                            pendingOffset <- 0
                                        | None when data.Reader.TryRead(&next) ->
                                            pending <- next
                                            pendingOffset <- 0
                                        | None -> available <- false
                                if available then
                                    let take = min (batch.Length - count) (pending.Length - pendingOffset)
                                    Buffer.BlockCopy(pending, pendingOffset, batch, count, take)
                                    pendingOffset <- pendingOffset + take
                                    count <- count + take
                            if count = 0 then
                                let! _ = wake.Reader.ReadAsync(lifetimeToken)
                                ()
                            else
                                let compressed = compressor.CompressChunk(batch.AsSpan(0, count), flush = true)
                                let mutable offset = 0
                                while offset < compressed.Length do
                                    if sendSequence = UInt64.MaxValue then
                                        raise (InvalidDataException("Tunnel record counter is exhausted"))
                                    let take = min Crypto.MaxChunkBytes (compressed.Length - offset)
                                    let record = Crypto.sealChunk encrypt sendDirection sendSequence preamble (ReadOnlySpan<byte>(compressed, offset, take))
                                    sendSequence <- sendSequence + 1UL
                                    do! stream.WriteAsync(record.AsMemory(), lifetimeToken)
                                    offset <- offset + take
                                do! stream.FlushAsync(lifetimeToken)
                        stop (Some (OperationCanceledException(lifetimeToken)))
                    with error ->
                        stop (Some error)
                finally
                    encrypt.Dispose()
                    (compressor :> IDisposable).Dispose()
                    lock stateGate (fun () -> writerDone <- true)
                    release()
            }

        let readExact (buffer: byte[]) count allowEof token =
            task {
                let mutable offset = 0
                let mutable eof = false
                while offset < count && not eof do
                    let! read = stream.ReadAsync(buffer.AsMemory(offset, count - offset), token)
                    if read = 0 then eof <- true
                    else offset <- offset + read
                if eof && (offset > 0 || not allowEof) then
                    raise (EndOfStreamException("Tunnel record is truncated"))
                return not eof
            }

        let beginReceive () =
            lock stateGate (fun () ->
                if readerActive then invalidOp "Only one tunnel receive may run at a time"
                if stopped then
                    match stopError with Some error -> raise error | None -> false
                else
                    readerActive <- true
                    true)

        do
            // Keep the writer task rooted until its final cleanup.
            writer.ContinueWith((fun (_: Task) -> ()), TaskScheduler.Default) |> ignore

        member _.Completion: Task = completion.Task

        member _.SendAsync(frame: Frame.Frame, token: CancellationToken): Task =
            task {
                token.ThrowIfCancellationRequested()
                let bytes = Frame.encode frame
                do! data.Writer.WriteAsync(bytes, token)
                signal()
            }

        /// Control frames cannot wait for the data queue or the peer's receive window.
        member _.PostControl(frame: Frame.Frame): unit =
            match frame with
            | Frame.WindowUpdate(id, credit) ->
                // Keep one pending credit per stream while network writes are blocked.
                if id = 0u || (id &&& 1u) = 0u || credit <= 0 then
                    invalidArg "frame" "Window credit requires an odd stream ID and positive byte count"
                let accepted =
                    lock creditGate (fun () ->
                        if lifetimeToken.IsCancellationRequested then true
                        else
                            match credits.TryGetValue(id) with
                            | true, previous when credit <= Int32.MaxValue - previous ->
                                credits[id] <- previous + credit
                                true
                            | false, _ when credits.Count < 256 ->
                                credits.Add(id, credit)
                                true
                            | _ -> false)
                if accepted then signal()
                else stop (Some (IOException("Tunnel credit queue exceeds its limit")))
            | Frame.CancelStream _ | Frame.Ping _ | Frame.Pong _ ->
                let bytes = Frame.encode frame
                if control.Writer.TryWrite(bytes) then signal()
                elif not (lock stateGate (fun () -> stopped)) then
                    stop (Some (IOException("Tunnel control queue is full")))
            | _ -> invalidArg "frame" "Only cancel, credit, and heartbeat frames use the control queue"

        member _.ReceiveAsync(token: CancellationToken): Task<Frame.Frame option> =
            task {
                if not (beginReceive()) then return None
                else
                    try
                        try
                            use readLifetime = CancellationTokenSource.CreateLinkedTokenSource(lifetimeToken, token)
                            let readToken = readLifetime.Token
                            let mutable result = None
                            let mutable eof = false
                            while result.IsNone && not eof do
                                if decodedOffset < decodedBytes.Length then
                                    let take = min (frameLength - frameCount) (decodedBytes.Length - decodedOffset)
                                    Buffer.BlockCopy(decodedBytes, decodedOffset, frameBytes, frameCount, take)
                                    decodedOffset <- decodedOffset + take
                                    frameCount <- frameCount + take
                                    if frameCount = 8 && frameLength = 8 then
                                        let payloadLength = int (BinaryPrimitives.ReadUInt16BigEndian(frameBytes.AsSpan(6, 2)))
                                        if payloadLength > Frame.MaxPayloadBytes then
                                            raise (InvalidDataException("Tunnel frame exceeds 32768 bytes"))
                                        frameLength <- 8 + payloadLength
                                    if frameCount = frameLength then
                                        match Frame.decode (frameBytes.AsSpan(0, frameLength).ToArray()) with
                                        | Error message -> raise (InvalidDataException(message))
                                        | Ok frame -> result <- Some frame
                                        frameCount <- 0
                                        frameLength <- 8
                                    if decodedOffset = decodedBytes.Length then
                                        decodedBytes <- Array.empty
                                        decodedOffset <- 0
                                else
                                    let! hasRecord = readExact recordLength 3 true readToken
                                    if not hasRecord then
                                        if frameCount <> 0 then raise (EndOfStreamException("Tunnel frame is truncated"))
                                        eof <- true
                                        stop None
                                    else
                                        let length = (int recordLength[0] <<< 16) ||| (int recordLength[1] <<< 8) ||| int recordLength[2]
                                        if length < 1 || length > Crypto.MaxChunkBytes then
                                            raise (InvalidDataException("Invalid tunnel record length"))
                                        let! _ = readExact ciphertext (length + 16) false readToken
                                        if receiveSequence = UInt64.MaxValue then
                                            raise (InvalidDataException("Tunnel record counter is exhausted"))
                                        match Crypto.openChunk decrypt receiveDirection receiveSequence preamble recordLength (ReadOnlySpan<byte>(ciphertext, 0, length + 16)) with
                                        | Error message -> raise (InvalidDataException(message))
                                        | Ok compressed ->
                                            receiveSequence <- receiveSequence + 1UL
                                            decodedBytes <- decompressor.DecompressChunk(compressed.AsSpan(), maxOutputBytes = Crypto.MaxChunkBytes)
                                            decodedOffset <- 0
                            return result
                        with error ->
                            stop (Some error)
                            return raise error
                    finally
                        lock stateGate (fun () -> readerActive <- false)
                        release()
            }

        member _.Abort(error: exn): unit = stop (Some error)

        interface IDisposable with
            member _.Dispose() = stop (Some (OperationCanceledException("Tunnel disposed")))
