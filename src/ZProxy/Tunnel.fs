namespace ZProxy

open System
open System.Buffers.Binary
open System.IO
open System.Security.Cryptography
open System.Threading
open System.Threading.Channels
open System.Threading.Tasks

module Tunnel =

    /// Pipe handles AEAD sealing/opening + streaming Zstd compression/decompression over a duplex Stream
    type EncryptedZstdTunnel(rawStream: Stream, sessionKeys: Crypto.SessionKeys, isClient: bool) =
        let myDir = if isClient then Crypto.DirC2S else Crypto.DirS2C
        let peerDir = if isClient then Crypto.DirS2C else Crypto.DirC2S
        let encKey = if isClient then sessionKeys.KeyC2S else sessionKeys.KeyS2C
        let decKey = if isClient then sessionKeys.KeyS2C else sessionKeys.KeyC2S

        let aeadEnc = new ChaCha20Poly1305(encKey)
        let aeadDec = new ChaCha20Poly1305(decKey)
        let compressor = new Zstd.StreamingCompressor(3)
        let decompressor = new Zstd.StreamingDecompressor()

        let mutable sendSeq = 0UL
        let mutable recvSeq = 0UL

        let sendLock = new SemaphoreSlim(1, 1)
        let decompBuffer = new MemoryStream()

        /// Read exact count of bytes from stream
        let readExact (s: Stream) (count: int) (ct: CancellationToken) : Task<byte[]> =
            task {
                let buf = Array.zeroCreate<byte> count
                let mutable totalRead = 0
                let mutable eof = false
                while totalRead < count && not eof do
                    let! r = s.ReadAsync(buf.AsMemory(totalRead, count - totalRead), ct)
                    if r = 0 then
                        eof <- true
                    else
                        totalRead <- totalRead + r
                if eof && totalRead = 0 then
                    return Array.empty
                elif eof then
                    return failwith "Premature stream termination while reading chunk"
                else
                    return buf
            }

        /// Send logical frame through Zstd flush + AEAD seal
        member this.SendFrameAsync(frame: Frame.Frame, ct: CancellationToken) : Task<unit> =
            task {
                let frameBytes = Frame.encode frame
                do! sendLock.WaitAsync(ct)
                try
                    let compressed = compressor.CompressChunk(ReadOnlySpan<byte>(frameBytes), flush = true)
                    let aad =
                        if sendSeq = 0UL then
                            "zproxy-chunk-0"B
                        else
                            "zproxy-chunk-n"B
                    let sealedChunk = Crypto.sealChunk aeadEnc myDir sendSeq (ReadOnlySpan<byte>(aad)) (ReadOnlySpan<byte>(compressed))
                    sendSeq <- sendSeq + 1UL
                    do! rawStream.WriteAsync(sealedChunk.AsMemory(), ct)
                    do! rawStream.FlushAsync(ct)
                finally
                    sendLock.Release() |> ignore
            }

        /// Receive next logical frame by pulling AEAD chunks and decompressing
        member this.ReceiveFrameAsync(ct: CancellationToken) : Task<Frame.Frame option> =
            task {
                let mutable resultFrame = None
                let mutable streamClosed = false

                while resultFrame.IsNone && not streamClosed do
                    // 1. Check if decompBuffer has a complete frame already
                    if decompBuffer.Length >= 8L then
                        let pos = decompBuffer.Position
                        decompBuffer.Position <- 0L
                        let header = Array.zeroCreate<byte> 8
                        let _ = decompBuffer.Read(header, 0, 8)
                        let payloadLen = int (BinaryPrimitives.ReadUInt16BigEndian(ReadOnlySpan<byte>(header, 6, 2)))
                        let totalFrameLen = 8 + payloadLen
                        if decompBuffer.Length >= int64 totalFrameLen then
                            let frameBytes = Array.zeroCreate<byte> totalFrameLen
                            decompBuffer.Position <- 0L
                            let _ = decompBuffer.Read(frameBytes, 0, totalFrameLen)
                            let remLen = int (decompBuffer.Length - int64 totalFrameLen)
                            let remBytes = Array.zeroCreate<byte> remLen
                            let _ = decompBuffer.Read(remBytes, 0, remLen)
                            decompBuffer.SetLength(0L)
                            if remLen > 0 then
                                decompBuffer.Write(remBytes, 0, remLen)
                            match Frame.decode frameBytes with
                            | Ok f -> resultFrame <- Some f
                            | Error err -> failwithf "Corrupt frame decode: %s" err
                        else
                            decompBuffer.Position <- pos

                    // 2. Need more bytes from network
                    if resultFrame.IsNone then
                        let! lenHeader = readExact rawStream 3 ct
                        if lenHeader.Length = 0 then
                            streamClosed <- true
                        else
                            let ptLen = (int lenHeader.[0] <<< 16) ||| (int lenHeader.[1] <<< 8) ||| (int lenHeader.[2])
                            let! ctWithTag = readExact rawStream (ptLen + 16) ct
                            let aad =
                                if recvSeq = 0UL then "zproxy-chunk-0"B
                                else "zproxy-chunk-n"B
                            match Crypto.openChunk aeadDec peerDir recvSeq (ReadOnlySpan<byte>(aad)) (ReadOnlySpan<byte>(ctWithTag)) with
                            | Error e -> failwithf "AEAD Decrypt error: %s" e
                            | Ok compressed ->
                                recvSeq <- recvSeq + 1UL
                                let decomp = decompressor.DecompressChunk(ReadOnlySpan<byte>(compressed))
                                if decomp.Length > 0 then
                                    let endPos = decompBuffer.Length
                                    decompBuffer.Position <- endPos
                                    decompBuffer.Write(decomp, 0, decomp.Length)
                return resultFrame
            }

        interface IDisposable with
            member _.Dispose() =
                aeadEnc.Dispose()
                aeadDec.Dispose()
                (compressor :> IDisposable).Dispose()
                (decompressor :> IDisposable).Dispose()
                sendLock.Dispose()
                decompBuffer.Dispose()