namespace ZProxy

open System
open System.Buffers.Binary
open System.IO
open System.Net.Http
open System.Text
open System.Threading
open System.Threading.Tasks

/// Compose the optional workers. Ordinary proxy requests do not load Bun or OMP.
module Omp =
    [<Literal>]
    let MaxRequestBytes = 64L * 1024L * 1024L

    type private Capture(source: Stream, folder: string) =
        inherit Stream()
        let path = Path.Combine(folder, "request-" + Guid.NewGuid().ToString("N"))
        let options = FileStreamOptions(Mode = FileMode.CreateNew, Access = FileAccess.Write,
                                         Share = (FileShare.Read ||| FileShare.Delete),
                                         Options = (FileOptions.Asynchronous ||| FileOptions.DeleteOnClose),
                                         UnixCreateMode = Nullable(UnixFileMode.UserRead ||| UnixFileMode.UserWrite))
        let file = new FileStream(path, options)
        let ready = TaskCompletionSource<int64>(TaskCreationOptions.RunContinuationsAsynchronously)
        let mutable length = 0L
        let mutable disposed = 0
        member _.WaitAsync(ct: CancellationToken) = ready.Task.WaitAsync(ct)
        member _.OpenRead() =
            new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite ||| FileShare.Delete, 16384, FileOptions.Asynchronous)
        override _.CanRead = true
        override _.CanWrite = false
        override _.CanSeek = false
        override _.Length = raise (NotSupportedException())
        override _.Position with get () = raise (NotSupportedException()) and set _ = raise (NotSupportedException())
        override _.Flush() = ()
        override _.Seek(_, _) = raise (NotSupportedException())
        override _.SetLength(_) = raise (NotSupportedException())
        override _.Write(_, _, _) = raise (NotSupportedException())
        override this.Read(buffer, offset, count) = this.ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult()
        override this.ReadAsync(buffer, offset, count, ct) = this.ReadAsync(buffer.AsMemory(offset, count), ct).AsTask()
        override _.ReadAsync(buffer: Memory<byte>, ct: CancellationToken) = ValueTask<int>(task {
            try
                let! count = source.ReadAsync(buffer, ct)
                if count > 0 then
                    if length + int64 count > MaxRequestBytes then
                        raise (InvalidDataException("The OMP request exceeds 64 MiB."))
                    do! file.WriteAsync(buffer.Slice(0, count), ct)
                    length <- length + int64 count
                elif buffer.Length > 0 then
                    do! file.FlushAsync(ct)
                    ready.TrySetResult(length) |> ignore
                return count
            with error ->
                ready.TrySetException(error) |> ignore
                return raise error
        })
        override _.Dispose(disposing) =
            if disposing && Interlocked.Exchange(&disposed, 1) = 0 then
                ready.TrySetCanceled() |> ignore
                file.Dispose()
            base.Dispose(disposing)

    type private OwnedBody(source: Stream, close: unit -> unit) =
        inherit Stream()
        let mutable disposed = 0
        override _.CanRead = true
        override _.CanWrite = false
        override _.CanSeek = false
        override _.Length = raise (NotSupportedException())
        override _.Position with get () = raise (NotSupportedException()) and set _ = raise (NotSupportedException())
        override _.Flush() = ()
        override _.Seek(_, _) = raise (NotSupportedException())
        override _.SetLength(_) = raise (NotSupportedException())
        override _.Write(_, _, _) = raise (NotSupportedException())
        override _.Read(buffer, offset, count) = source.Read(buffer, offset, count)
        override _.ReadAsync(buffer, offset, count, ct) = source.ReadAsync(buffer, offset, count, ct)
        override _.ReadAsync(buffer: Memory<byte>, ct: CancellationToken) = source.ReadAsync(buffer, ct)
        override _.Dispose(disposing) =
            if disposing && Interlocked.Exchange(&disposed, 1) = 0 then close ()
            base.Dispose(disposing)

    let private own (response: HttpResponseMessage) close ct = task {
        let original = response.Content
        let! source = original.ReadAsStreamAsync(ct)
        let content = new StreamContent(new OwnedBody(source, fun () -> try original.Dispose() finally close ()))
        for header in original.Headers do content.Headers.TryAddWithoutValidation(header.Key, header.Value) |> ignore
        response.Content <- content
        return response
    }

    let private captureKey = HttpRequestOptionsKey<Capture>("zproxy.omp.request")

    let private requestPlugin (worker: OmpWorker.Worker) =
        { new IProxyPlugin with
            member _.Wrap(next) = fun request ct -> task {
                let original = request.Content
                if original = null then return! next request ct
                else
                    if original.Headers.ContentLength.HasValue && original.Headers.ContentLength.Value > MaxRequestBytes then
                        raise (InvalidDataException("The OMP request exceeds 64 MiB."))
                    let! source = original.ReadAsStreamAsync(ct)
                    let capture = new Capture(source, worker.Folder)
                    let content = new StreamContent(new Flow.BorrowedStream(capture))
                    for header in original.Headers do content.Headers.TryAddWithoutValidation(header.Key, header.Value) |> ignore
                    request.Content <- content
                    request.Options.Set(captureKey, capture)
                    try
                        let! response = next request ct
                        try return! own response (fun () -> capture.Dispose(); original.Dispose()) ct
                        with error ->
                            response.Dispose()
                            return raise error
                    with error ->
                        capture.Dispose()
                        original.Dispose()
                        return raise error
            } }

    let private decoder (worker: OmpWorker.Worker) =
        { new IResponseDecoder with
            member _.Id = "omp-response"
            member _.Version = 1
            member _.Decode(request, metadata, raw, ct) = task {
                let capture =
                    match request.Options.TryGetValue(captureKey) with
                    | true, value -> value
                    | _ -> raise (InvalidDataException("The OMP decoder has no request context."))
                try
                    let! length = capture.WaitAsync(ct)
                    let envelope = OmpMetadata.envelope (Contracts.requestPath request) length metadata raw
                    let write (stream: Stream) (token: CancellationToken) : Task = task {
                        let prefix = Array.zeroCreate<byte> 4
                        BinaryPrimitives.WriteUInt32BigEndian(prefix.AsSpan(), uint32 envelope.Length)
                        do! stream.WriteAsync(prefix.AsMemory(), token)
                        do! stream.WriteAsync(envelope.AsMemory(), token)
                        use input = capture.OpenRead()
                        do! input.CopyToAsync(stream, 16384, token)
                        do! raw.Content.CopyToAsync(stream, token)
                    }
                    let! response, _ = worker.SendAsync("/decode", [ "Content-Type", "application/octet-stream" ], write, ct)
                    try return! own response raw.Dispose ct
                    with error ->
                        response.Dispose()
                        return raise error
                with error ->
                    raw.Dispose()
                    return raise error
            } }

    let private remoteHandler (worker: OmpWorker.Worker) : RemoteHandler =
        fun identity request ct -> task {
            let nickname = Convert.ToBase64String(Encoding.UTF8.GetBytes(identity.Nickname)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
            let headers = HttpUtils.requestHeaders request @
                          [ "X-Zproxy-User-Id", identity.Id; "X-Zproxy-User-Nickname", nickname ]
            let write (stream: Stream) (token: CancellationToken) =
                if request.Content = null then Task.CompletedTask
                else request.Content.CopyToAsync(stream, token)
            let! response, received = worker.SendAsync(Contracts.requestPath request, headers, write, ct)
            try
                let markers = received |> List.filter (fun (name, _) -> name.Equals("X-Zproxy-Decode", StringComparison.OrdinalIgnoreCase))
                let! metadata = task {
                    match markers with
                    | [] ->
                        let streaming = response.Content.Headers.ContentType <> null && response.Content.Headers.ContentType.MediaType = "text/event-stream"
                        return Contracts.identity(Guid.NewGuid().ToString("N"), streaming)
                    | [ _, "1" ] ->
                        let! body = response.Content.ReadAsStreamAsync(ct)
                        return! OmpMetadata.readPrefix body ct
                    | _ -> return raise (InvalidDataException("Invalid OMP response marker."))
                }
                return ({ Response = response; Metadata = metadata }: Contracts.RemoteReply)
            with error ->
                response.Dispose()
                return raise error
        }

    let private runWorker (options: Options.OmpOptions) role (run: OmpWorker.Worker -> CancellationToken -> Task) (ct: CancellationToken) = task {
        let environment name fallback =
            let value = Environment.GetEnvironmentVariable(name)
            if String.IsNullOrWhiteSpace(value) then fallback else value
        let directory =
            if options.Directory <> "" then options.Directory
            else environment "ZPROXY_OMP_DIR" (Path.Combine(AppContext.BaseDirectory, "omp"))
        let bun =
            if options.Bun <> "" then options.Bun
            else environment "ZPROXY_BUN" (Path.Combine(directory, "bin", "bun"))
        use worker = new OmpWorker.Worker({ options with Directory = directory; Bun = bun }, role)
        do! worker.StartAsync(ct)
        use lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct)
        let work = run worker lifetime.Token
        let! first = Task.WhenAny(work, worker.Completion)
        let failed = not ct.IsCancellationRequested && not (obj.ReferenceEquals(first, work))
        if failed then lifetime.Cancel()
        do! work
        if failed then raise (IOException("The OMP worker stopped unexpectedly."))
    }

    let runClient (options: Options.ClientOptions) ct =
        match options.Omp with
        | None -> Client.run options [] ct :> Task
        | Some plugin -> runWorker plugin "local" (fun worker token ->
            Client.runWithDecoders options [ requestPlugin worker ] [ decoder worker ] token :> Task) ct

    let runServer (options: Options.ServerOptions) ct =
        match options.Omp with
        | None -> Server.run options ct :> Task
        | Some plugin -> runWorker plugin "remote" (fun worker token ->
            Server.runWithHandler options (remoteHandler worker) token :> Task) ct
