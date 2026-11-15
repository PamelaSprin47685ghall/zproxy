namespace ZProxy

open System
open System.IO
open System.Runtime.InteropServices

module Zstd =

    [<Struct>]
    [<StructLayout(LayoutKind.Sequential)>]
    type ZstdBuffer =
        val mutable Dst: nativeint
        val mutable Size: unativeint
        val mutable Pos: unativeint
        new(dst, size, pos) = { Dst = dst; Size = size; Pos = pos }

    [<Struct>]
    [<StructLayout(LayoutKind.Sequential)>]
    type ZstdInBuffer =
        val mutable Src: nativeint
        val mutable Size: unativeint
        val mutable Pos: unativeint
        new(src, size, pos) = { Src = src; Size = size; Pos = pos }

    type ZstdEndDirective =
        | ZstdEContinue = 0
        | ZstdEFlush = 1
        | ZstdEEnd = 2

    type ZstdCParameter =
        | ZstdCCompressionLevel = 100
        | ZstdCWindowLog = 101
        | ZstdCHashLog = 102
        | ZstdCChainLog = 103

    type ZstdDParameter =
        | ZstdDWindowLogMax = 100

    module Native =
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_createCStream")>]
        extern nativeint ZSTD_createCStream()

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_freeCStream")>]
        extern unativeint ZSTD_freeCStream(nativeint cstream)

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_initCStream")>]
        extern unativeint ZSTD_initCStream(nativeint cstream, int compressionLevel)

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_CCtx_setParameter")>]
        extern unativeint ZSTD_CCtx_setParameter(nativeint cctx, ZstdCParameter param, int value)

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_compressStream2")>]
        extern unativeint ZSTD_compressStream2(nativeint cstream, ZstdBuffer& output, ZstdInBuffer& input, ZstdEndDirective endOp)

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_createDStream")>]
        extern nativeint ZSTD_createDStream()

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_freeDStream")>]
        extern unativeint ZSTD_freeDStream(nativeint dstream)

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_initDStream")>]
        extern unativeint ZSTD_initDStream(nativeint dstream)

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_DCtx_setParameter")>]
        extern unativeint ZSTD_DCtx_setParameter(nativeint dctx, ZstdDParameter param, int value)

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_decompressStream")>]
        extern unativeint ZSTD_decompressStream(nativeint dstream, ZstdBuffer& output, ZstdInBuffer& input)

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_isError")>]
        extern uint32 ZSTD_isError(unativeint code)

        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_getErrorName")>]
        extern nativeint ZSTD_getErrorName(unativeint code)

    let private checkError (code: unativeint) =
        if Native.ZSTD_isError(code) <> 0u then
            let ptr = Native.ZSTD_getErrorName(code)
            let msg = Marshal.PtrToStringAnsi(ptr)
            failwithf "ZSTD error: %s" msg

    /// Massive rolling dictionary window (default 256 MiB = 2^28) for preserving multi-agent prompt prefix caches
    let DefaultWindowLog = 28 // 256 MiB sliding window

    /// Stateful streaming compressor keeping rolling dictionary/sliding-window across calls.
    type StreamingCompressor(level: int, ?windowLog: int) =
        let cstream = Native.ZSTD_createCStream()
        let wLog = defaultArg windowLog DefaultWindowLog
        do
            if cstream = 0n then failwith "Failed to allocate ZSTD CStream"
            Native.ZSTD_initCStream(cstream, level) |> checkError
            // Set massive 256 MiB sliding window
            Native.ZSTD_CCtx_setParameter(cstream, ZstdCParameter.ZstdCWindowLog, wLog) |> checkError

        member _.CompressChunk(data: ReadOnlySpan<byte>, flush: bool) : byte[] =
            use ms = new MemoryStream()
            let outChunk = Array.zeroCreate<byte> 65536
            let mutable inHandle = GCHandle()
            let mutable outHandle = GCHandle()
            try
                let dataArr = data.ToArray()
                inHandle <- GCHandle.Alloc(dataArr, GCHandleType.Pinned)
                outHandle <- GCHandle.Alloc(outChunk, GCHandleType.Pinned)
                let mutable input = ZstdInBuffer(inHandle.AddrOfPinnedObject(), unativeint dataArr.Length, 0un)
                let endOp = if flush then ZstdEndDirective.ZstdEFlush else ZstdEndDirective.ZstdEContinue

                let mutable loop = true
                while loop do
                    let mutable output = ZstdBuffer(outHandle.AddrOfPinnedObject(), unativeint outChunk.Length, 0un)
                    let remaining = Native.ZSTD_compressStream2(cstream, &output, &input, endOp)
                    checkError remaining
                    let produced = int output.Pos
                    if produced > 0 then
                        ms.Write(outChunk, 0, produced)
                    if input.Pos >= input.Size && (not flush || remaining = 0un) then
                        loop <- false
            finally
                if inHandle.IsAllocated then inHandle.Free()
                if outHandle.IsAllocated then outHandle.Free()
            ms.ToArray()

        interface IDisposable with
            member _.Dispose() =
                if cstream <> 0n then
                    Native.ZSTD_freeCStream(cstream) |> ignore

    /// Stateful streaming decompressor keeping rolling dictionary/sliding-window across calls.
    type StreamingDecompressor(?maxWindowLog: int) =
        let dstream = Native.ZSTD_createDStream()
        let wLogMax = defaultArg maxWindowLog 29 // Allow up to 512 MiB window
        do
            if dstream = 0n then failwith "Failed to allocate ZSTD DStream"
            Native.ZSTD_initDStream(dstream) |> checkError
            Native.ZSTD_DCtx_setParameter(dstream, ZstdDParameter.ZstdDWindowLogMax, wLogMax) |> checkError

        member _.DecompressChunk(compressed: ReadOnlySpan<byte>) : byte[] =
            use ms = new MemoryStream()
            let outChunk = Array.zeroCreate<byte> 65536
            let mutable inHandle = GCHandle()
            let mutable outHandle = GCHandle()
            try
                let compArr = compressed.ToArray()
                inHandle <- GCHandle.Alloc(compArr, GCHandleType.Pinned)
                outHandle <- GCHandle.Alloc(outChunk, GCHandleType.Pinned)
                let mutable input = ZstdInBuffer(inHandle.AddrOfPinnedObject(), unativeint compArr.Length, 0un)

                while input.Pos < input.Size do
                    let mutable output = ZstdBuffer(outHandle.AddrOfPinnedObject(), unativeint outChunk.Length, 0un)
                    let remaining = Native.ZSTD_decompressStream(dstream, &output, &input)
                    checkError remaining
                    let produced = int output.Pos
                    if produced > 0 then
                        ms.Write(outChunk, 0, produced)
                    elif input.Pos = 0un && produced = 0 then
                        failwith "ZSTD decompressor made no progress"
            finally
                if inHandle.IsAllocated then inHandle.Free()
                if outHandle.IsAllocated then outHandle.Free()
            ms.ToArray()

        interface IDisposable with
            member _.Dispose() =
                if dstream <> 0n then
                    Native.ZSTD_freeDStream(dstream) |> ignore