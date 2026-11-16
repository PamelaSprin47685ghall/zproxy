namespace ZProxy

open System
open System.IO
open System.Runtime.InteropServices
open System.Threading

module Zstd =

    [<Literal>]
    let DefaultWindowLog = 23
    [<Literal>]
    let MaxChunkBytes = 65536

    [<Struct; StructLayout(LayoutKind.Sequential)>]
    type private Buffer =
        val mutable Pointer: nativeint
        val mutable Size: unativeint
        val mutable Position: unativeint
        new(pointer, size) = { Pointer = pointer; Size = unativeint size; Position = 0un }

    // The runtime package must supply this Linux library.
    module private Native =
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_createCStream")>]
        extern nativeint createCompressor()
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_freeCStream")>]
        extern unativeint freeCompressor(nativeint context)
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_initCStream")>]
        extern unativeint initCompressor(nativeint context, int level)
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_CCtx_setParameter")>]
        extern unativeint setCompressor(nativeint context, int parameter, int value)
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_compressStream2")>]
        extern unativeint compress(nativeint context, Buffer& output, Buffer& input, int operation)
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_createDStream")>]
        extern nativeint createDecompressor()
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_freeDStream")>]
        extern unativeint freeDecompressor(nativeint context)
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_initDStream")>]
        extern unativeint initDecompressor(nativeint context)
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_DCtx_setParameter")>]
        extern unativeint setDecompressor(nativeint context, int parameter, int value)
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_decompressStream")>]
        extern unativeint decompress(nativeint context, Buffer& output, Buffer& input)
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_isError")>]
        extern uint32 isError(unativeint code)
        [<DllImport("libzstd.so.1", EntryPoint = "ZSTD_getErrorName")>]
        extern nativeint errorName(unativeint code)

    let private check code =
        if Native.isError(code) <> 0u then
            raise (InvalidDataException("Zstd: " + Marshal.PtrToStringAnsi(Native.errorName(code))))

    let private checkWindow name value =
        if value < 10 || value > 27 then invalidArg name "Window log must be between 10 and 27"

    /// One owner uses each context. Flush retains its compression history.
    type StreamingCompressor(level: int, ?windowLog: int) =
        let gate = obj()
        let window = defaultArg windowLog DefaultWindowLog
        let mutable context = 0n
        let inputBytes = GC.AllocateUninitializedArray<byte>(MaxChunkBytes, pinned = true)
        let outputBytes = GC.AllocateUninitializedArray<byte>(MaxChunkBytes, pinned = true)
        let inputPointer = Marshal.UnsafeAddrOfPinnedArrayElement(inputBytes, 0)
        let outputPointer = Marshal.UnsafeAddrOfPinnedArrayElement(outputBytes, 0)
        let outputStore = new MemoryStream(MaxChunkBytes)
        do
            checkWindow "windowLog" window
            context <- Native.createCompressor()
            if context = 0n then raise (OutOfMemoryException("Cannot create Zstd compressor"))
            try
                Native.initCompressor(context, level) |> check
                Native.setCompressor(context, 101, window) |> check
            with _ ->
                Native.freeCompressor(context) |> ignore
                context <- 0n
                reraise()

        member _.CompressChunk(data: ReadOnlySpan<byte>, flush: bool) : byte[] =
            if data.Length > MaxChunkBytes then invalidArg "data" "Compression input exceeds 65536 bytes"
            Monitor.Enter(gate)
            try
                ObjectDisposedException.ThrowIf((context = 0n), "Zstd compressor")
                data.CopyTo(inputBytes.AsSpan())
                outputStore.SetLength(0L)
                let mutable input = Buffer(inputPointer, data.Length)
                let operation = if flush then 1 else 0
                let mutable doneWriting = false
                while not doneWriting do
                    let before = input.Position
                    let mutable output = Buffer(outputPointer, outputBytes.Length)
                    let remaining = Native.compress(context, &output, &input, operation)
                    check remaining
                    let count = int output.Position
                    outputStore.Write(outputBytes, 0, count)
                    if outputStore.Length > int64 (MaxChunkBytes * 2) then
                        raise (InvalidDataException("Zstd output exceeds the record bound"))
                    doneWriting <- input.Position = input.Size && (not flush || remaining = 0un)
                    if not doneWriting && before = input.Position && count = 0 then
                        raise (InvalidDataException("Zstd compressor made no progress"))
                outputStore.ToArray()
            finally
                GC.KeepAlive(inputBytes)
                GC.KeepAlive(outputBytes)
                Monitor.Exit(gate)

        interface IDisposable with
            member _.Dispose() =
                lock gate (fun () ->
                    if context <> 0n then
                        Native.freeCompressor(context) |> ignore
                        context <- 0n
                        outputStore.Dispose())

    /// Reject large windows before allocation and bound output for each record.
    type StreamingDecompressor(?maxWindowLog: int) =
        let gate = obj()
        let window = defaultArg maxWindowLog DefaultWindowLog
        let mutable context = 0n
        let inputBytes = GC.AllocateUninitializedArray<byte>(MaxChunkBytes, pinned = true)
        let outputBytes = GC.AllocateUninitializedArray<byte>(MaxChunkBytes, pinned = true)
        let inputPointer = Marshal.UnsafeAddrOfPinnedArrayElement(inputBytes, 0)
        let outputPointer = Marshal.UnsafeAddrOfPinnedArrayElement(outputBytes, 0)
        let outputStore = new MemoryStream(MaxChunkBytes)
        do
            checkWindow "maxWindowLog" window
            context <- Native.createDecompressor()
            if context = 0n then raise (OutOfMemoryException("Cannot create Zstd decompressor"))
            try
                Native.initDecompressor(context) |> check
                Native.setDecompressor(context, 100, window) |> check
            with _ ->
                Native.freeDecompressor(context) |> ignore
                context <- 0n
                reraise()

        member _.DecompressChunk(compressed: ReadOnlySpan<byte>, ?maxOutputBytes: int) : byte[] =
            let limit = defaultArg maxOutputBytes MaxChunkBytes
            if compressed.Length > MaxChunkBytes then invalidArg "compressed" "Record exceeds 65536 bytes"
            if limit < 1 || limit > MaxChunkBytes then invalidArg "maxOutputBytes" "Output bound must be between 1 and 65536"
            Monitor.Enter(gate)
            try
                ObjectDisposedException.ThrowIf((context = 0n), "Zstd decompressor")
                compressed.CopyTo(inputBytes.AsSpan())
                outputStore.SetLength(0L)
                let mutable input = Buffer(inputPointer, compressed.Length)
                let mutable readAgain = compressed.Length > 0
                while readAgain do
                    let before = input.Position
                    let capacity = min outputBytes.Length (limit - int outputStore.Length + 1)
                    let mutable output = Buffer(outputPointer, capacity)
                    Native.decompress(context, &output, &input) |> check
                    let count = int output.Position
                    if outputStore.Length + int64 count > int64 limit then
                        raise (InvalidDataException("Zstd output exceeds the record bound"))
                    outputStore.Write(outputBytes, 0, count)
                    readAgain <- input.Position < input.Size || count = capacity
                    if readAgain && before = input.Position && count = 0 then
                        raise (InvalidDataException("Zstd decompressor made no progress"))
                outputStore.ToArray()
            finally
                GC.KeepAlive(inputBytes)
                GC.KeepAlive(outputBytes)
                Monitor.Exit(gate)

        interface IDisposable with
            member _.Dispose() =
                lock gate (fun () ->
                    if context <> 0n then
                        Native.freeDecompressor(context) |> ignore
                        context <- 0n
                        outputStore.Dispose())
