namespace ZProxy

open System
open System.Collections.Concurrent
open System.Diagnostics
open System.IO
open System.Net
open System.Net.Http
open System.Net.Sockets
open System.Runtime.InteropServices
open System.Threading
open System.Threading.Tasks

/// Own one optional Bun worker and its private duplex HTTP connections.
module OmpWorker =
    let private logLock = obj()

    /// Replace long secret-like runs before a worker line reaches the process log.
    let private redact (line: string) =
        let out = System.Text.StringBuilder(line.Length)
        let isToken (c: char) = Char.IsLetterOrDigit c || c = '_' || c = '-' || c = '.'
        let mutable runStart = -1
        let mutable i = 0
        while i < line.Length do
            if isToken line[i] then
                if runStart < 0 then runStart <- i
            else
                if runStart >= 0 then
                    let len = i - runStart
                    if len >= 40 then out.Append("<redacted>") |> ignore
                    else out.Append(line, runStart, len) |> ignore
                    runStart <- -1
                out.Append(line[i]) |> ignore
            i <- i + 1
        if runStart >= 0 then
            let len = line.Length - runStart
            if len >= 40 then out.Append("<redacted>") |> ignore
            else out.Append(line, runStart, len) |> ignore
        out.ToString()

    let private logWorker (role: string) (stream: string) (line: string) =
        if not (String.IsNullOrWhiteSpace line) then
            let masked = redact line
            let text = if masked.Length > 4000 then masked.Substring(0, 4000) + "..." else masked
            lock logLock (fun () -> eprintfn "zproxy: omp[%s/%s] %s" role stream text)

    type private ResponseBody(source: Stream, close: unit -> unit) =
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

    type Worker(options: Options.OmpOptions, role: string) =
        let folder = Path.Combine(Path.GetTempPath(), "zpx-" + Guid.NewGuid().ToString("N").Substring(0, 12))
        let socketPath = Path.Combine(folder, "worker.sock")
        let stop = new CancellationTokenSource()
        let child = new Process()
        let writers = ConcurrentDictionary<int, Task>()
        let mutable nextCall = 0
        let mutable disposed = 0
        let mutable prepareRequests = 0
        let mutable started = false
        let mutable output = Task.CompletedTask
        let mutable errors = Task.CompletedTask

        let drain (reader: StreamReader) (stream: string) = task {
            try
                let mutable active = true
                while active do
                    let! line = reader.ReadLineAsync()
                    if isNull line then active <- false
                    else logWorker role stream line
            with
            | :? OperationCanceledException -> ()
            | :? ObjectDisposedException -> ()
            | :? IOException -> ()
        }

        member _.Folder = folder
        member _.PrepareRequests = Volatile.Read(&prepareRequests) <> 0
        member _.EnableRequestPreparation() = Interlocked.Exchange(&prepareRequests, 1) |> ignore
        member _.Completion: Task = child.WaitForExitAsync()

        member _.StartAsync(ct: CancellationToken) = task {
            let supportedPlatform =
                OperatingSystem.IsLinux()
                || (OperatingSystem.IsMacOS() && RuntimeInformation.ProcessArchitecture = Architecture.Arm64)
            if not supportedPlatform then
                invalidOp "The OMP worker requires Linux or macOS arm64."
            if role <> "local" && role <> "remote" then invalidArg "role" "Unknown OMP worker role."
            let entry = Path.Combine(Path.GetFullPath(options.Directory), role + ".mjs")
            if not (File.Exists(entry)) || not (File.Exists(options.Bun)) then
                invalidArg "options" "The OMP bundle or its Bun executable is missing."
            Directory.CreateDirectory(folder, UnixFileMode.UserRead ||| UnixFileMode.UserWrite ||| UnixFileMode.UserExecute) |> ignore
            let info = ProcessStartInfo(Path.GetFullPath(options.Bun))
            info.UseShellExecute <- false
            info.RedirectStandardInput <- true
            info.RedirectStandardOutput <- true
            info.RedirectStandardError <- true
            info.WorkingDirectory <- Path.GetFullPath(options.Directory)
            if role = "local" then
                let environment =
                    [ "PATH"; "LD_LIBRARY_PATH"; "TMPDIR"; "TEMP"; "LANG"; "LC_ALL"; "TZ" ]
                    |> List.choose (fun key -> match info.Environment.TryGetValue(key) with true, value -> Some(key, value) | _ -> None)
                info.Environment.Clear()
                for key, value in environment do info.Environment[key] <- value
                info.Environment["PI_CODING_AGENT_DIR"] <- folder
            info.Environment.Remove("BUN_OPTIONS") |> ignore
            info.Environment.Remove("NODE_OPTIONS") |> ignore
            info.ArgumentList.Add(entry)
            info.ArgumentList.Add("--socket")
            info.ArgumentList.Add(socketPath)
            if role = "local" && options.ReasoningOrder then info.ArgumentList.Add("--reasoning-order")
            options.Config |> Option.iter (fun path ->
                info.ArgumentList.Add("--config")
                info.ArgumentList.Add(Path.GetFullPath(path)))
            child.StartInfo <- info
            if not (child.Start()) then raise (IOException("The OMP worker did not start."))
            started <- true
            child.StandardInput.Close()
            errors <- drain child.StandardError "stderr"
            use deadline = CancellationTokenSource.CreateLinkedTokenSource(ct)
            deadline.CancelAfter(TimeSpan.FromSeconds(60.0))
            let! ready = child.StandardOutput.ReadLineAsync(deadline.Token)
            if ready <> "READY" || child.HasExited then
                raise (IOException("The OMP worker did not become ready. Check its bundle and server configuration."))
            output <- drain child.StandardOutput "stdout"
        }

        member this.SendAsync(path: string, headers: (string * string) list,
                              writeBody: Stream -> CancellationToken -> Task, ct: CancellationToken) =
            this.SendAsync("POST", path, headers, writeBody, ct)

        /// One request over the private socket. A bodyless method sends an explicit
        /// zero length instead of a chunked body, so a read-only endpoint sees a
        /// plain GET.
        member _.SendAsync(method: string, path: string, headers: (string * string) list,
                           writeBody: Stream -> CancellationToken -> Task, ct: CancellationToken) = task {
            let lifetime = CancellationTokenSource.CreateLinkedTokenSource(stop.Token, ct)
            let token = lifetime.Token
            let socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
            let mutable wire: HttpWire.Connection option = None
            let mutable registration = Unchecked.defaultof<CancellationTokenRegistration>
            let mutable closed = 0
            let close () =
                if Interlocked.Exchange(&closed, 1) = 0 then
                    lifetime.Cancel()
                    registration.Dispose()
                    wire |> Option.iter (fun value -> (value :> IDisposable).Dispose())
                    socket.Dispose()
                    lifetime.Dispose()
            try
                do! socket.ConnectAsync(UnixDomainSocketEndPoint(socketPath), token)
                let connection = new HttpWire.Connection(new NetworkStream(socket, ownsSocket = true))
                wire <- Some connection
                registration <- token.Register(fun () -> (connection :> IDisposable).Dispose())
                let fields =
                    headers |> List.filter (fun (name, _) ->
                        not (List.exists (fun key -> name.Equals(key, StringComparison.OrdinalIgnoreCase))
                            [ "Content-Length"; "Transfer-Encoding"; "Host"; "Connection" ]))
                let bodyless = method = "GET" || method = "HEAD"
                do! connection.WriteHeadAsync(
                    { StartLine = method + " " + path + " HTTP/1.1"
                      Headers = [ "Host", "localhost" ]
                                @ (if bodyless then [ "Content-Length", "0" ]
                                   else [ "Transfer-Encoding", "chunked" ])
                                @ [ "Connection", "close" ] @ fields }, token)
                let id = Interlocked.Increment(&nextCall)
                let writing = task {
                    try
                        if not bodyless then do! writeBody connection.Body token
                        do! connection.CompleteWritesAsync(token)
                    with _ -> (connection :> IDisposable).Dispose()
                }
                writers[id] <- writing
                writing.ContinueWith((fun (_: Task) -> writers.TryRemove(id) |> ignore), TaskScheduler.Default) |> ignore
                let! head = connection.ReadHeadAsync(token)
                let parts = head.StartLine.Split(' ', 3)
                let status =
                    match parts with
                    | [| "HTTP/1.1"; value; _ |] ->
                        match Int32.TryParse(value) with true, code when code >= 200 && code <= 599 -> code | _ -> 0
                    | _ -> 0
                if status = 0 then raise (InvalidDataException("Invalid OMP response status."))
                let framing = head.Headers |> List.filter (fun (name, _) -> name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase))
                if framing.Length <> 1 || not ((snd framing.Head).Equals("chunked", StringComparison.OrdinalIgnoreCase)) then
                    raise (InvalidDataException("The OMP worker must stream a chunked response."))
                let response = new HttpResponseMessage(enum<HttpStatusCode> status)
                response.Content <- new StreamContent(new ResponseBody(connection.Body, close))
                HttpUtils.addResponseHeaders response head.Headers
                return response, head.Headers
            with error ->
                close ()
                return raise error
        }

        interface IAsyncDisposable with
            member this.DisposeAsync() = ValueTask(task {
                if Interlocked.Exchange(&disposed, 1) = 0 then
                    try
                        if started && not child.HasExited then
                            try
                                use deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3.0))
                                let! response, _ = this.SendAsync("/shutdown", [], (fun _ _ -> Task.CompletedTask), deadline.Token)
                                response.Dispose()
                                do! child.WaitForExitAsync(deadline.Token)
                            with _ ->
                                if not child.HasExited then child.Kill(entireProcessTree = true)
                        stop.Cancel()
                        if started then do! child.WaitForExitAsync()
                        do! Task.WhenAll(writers.Values |> Seq.toArray)
                        do! Task.WhenAll(output, errors)
                    finally
                        stop.Dispose()
                        child.Dispose()
                        if Directory.Exists(folder) then Directory.Delete(folder, true)
            })
