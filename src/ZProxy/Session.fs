namespace ZProxy

open System
open System.Collections.Generic
open System.IO
open System.Net
open System.Net.Http
open System.Threading
open System.Threading.Tasks

module Session =
    type private Exchange(id, window, post, parentToken: CancellationToken,
                          callerToken: CancellationToken, onClose) =
        let lifetime = CancellationTokenSource.CreateLinkedTokenSource(parentToken, callerToken)
        let token = lifetime.Token
        let headers = TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously)
        let credit = Flow.SendWindow(window)
        let body = new Flow.ReceiveBody(window, (fun count -> post (Frame.WindowUpdate(id, count))), onClose)
        let gate = obj ()
        let mutable closed = false
        let mutable cancellation: CancellationTokenRegistration option = None
        let mutable openQueued = false
        let mutable cancelSent = 0
        let mutable sentEnd = false
        let mutable receivedHeaders = false

        member _.Id = id
        member _.Token = token
        member _.Headers = headers
        member _.Credit = credit
        member _.Body = body
        member _.IsClosed = lock gate (fun () -> closed)
        member _.OpenQueued with get () = Volatile.Read(&openQueued) and set value = Volatile.Write(&openQueued, value)
        member _.TryNotifyCancel() = Interlocked.Exchange(&cancelSent, 1) = 0
        member _.SentEnd with get () = sentEnd and set value = sentEnd <- value
        member _.ReceivedHeaders with get () = receivedHeaders and set value = receivedHeaders <- value

        member _.WatchCancellation(callback: unit -> unit) =
            let registration = callerToken.Register(Action(callback))
            let release = lock gate (fun () ->
                if closed then true
                else cancellation <- Some registration; false)
            if release then registration.Dispose()

        member _.Stop(error: exn) =
            let cleanup = lock gate (fun () ->
                if closed then None
                else closed <- true; Some cancellation)
            match cleanup with
            | None -> ()
            | Some registration ->
                credit.Fail(error)
                body.Finish(Some error)
                headers.TrySetException(error) |> ignore
                lifetime.Cancel()
                body.Dispose()
                registration |> Option.iter (fun value -> value.Dispose())
                lifetime.Dispose()

    /// Own one connection and all requests that use its compression history.
    type ProxySession(tunnel: Tunnel.EncryptedZstdTunnel, limits: Options.Limits,
                      isClient: bool, upstream: ProxyHandler option,
                      closeConnection: unit -> unit, ct: CancellationToken) =
        let gate = obj ()
        let streams = Dictionary<uint32, Exchange>()
        let workers = Dictionary<uint32, Task>()
        let canceledBeforeOpen = HashSet<uint32>()
        let lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct)
        let token = lifetime.Token
        let slots = new SemaphoreSlim(limits.MaxStreams, limits.MaxStreams)
        let openGate = new SemaphoreSlim(1, 1)
        let mutable stopped = false
        let mutable nextId = 1u
        let mutable lastPeerId = 0u
        let mutable lastRead = Environment.TickCount64

        let find id = lock gate (fun () -> match streams.TryGetValue(id) with true, value -> Some value | _ -> None)
        let alive () = lock gate (fun () -> not stopped)
        let requirePastStream id =
            let known = lock gate (fun () -> if isClient then id < nextId else id <= lastPeerId)
            if not known then raise (InvalidDataException("A frame referenced an unopened stream."))

        let closeStream id (error: exn option) notifyPeer =
            let removed =
                lock gate (fun () ->
                    match streams.TryGetValue(id) with
                    | true, value -> streams.Remove(id) |> ignore; Some value
                    | _ -> None)
            match removed with
            | None -> ()
            | Some state ->
                if notifyPeer && (not isClient || state.OpenQueued)
                   && (not state.SentEnd || not state.Body.HasEnded) && state.TryNotifyCancel() then
                    tunnel.PostControl(Frame.CancelStream(id, "Stream closed"))
                state.Stop(defaultArg error (OperationCanceledException("Stream closed")))
                if isClient then slots.Release() |> ignore

        let stop (error: exn) =
            let removed =
                lock gate (fun () ->
                    if stopped then None
                    else
                        stopped <- true
                        let values = streams.Values |> Seq.toArray
                        streams.Clear()
                        Some values)
            match removed with
            | None -> ()
            | Some values ->
                lifetime.Cancel()
                tunnel.Abort(error)
                closeConnection ()
                for state in values do
                    state.Stop(error)
                    if isClient then slots.Release() |> ignore

        let create id caller =
            Exchange(id, limits.StreamWindowBytes, tunnel.PostControl, token, caller,
                     fun () -> closeStream id None true)

        let sendBody (state: Exchange) (body: Stream) = task {
            let buffer = Array.zeroCreate<byte> 16384
            let mutable ended = false
            while not ended do
                let! count = body.ReadAsync(buffer.AsMemory(), state.Token)
                if count = 0 then ended <- true
                else
                    let mutable offset = 0
                    while offset < count do
                        let! take = state.Credit.TakeUpToAsync(count - offset, state.Token)
                        do! tunnel.SendAsync(Frame.Data(state.Id, buffer.AsSpan(offset, take).ToArray(), false), state.Token)
                        offset <- offset + take
            do! tunnel.SendAsync(Frame.EndStream(state.Id), state.Token)
            state.SentEnd <- true
        }

        let track id (run: unit -> Task) =
            lock gate (fun () ->
                if not stopped then
                    let work = task {
                        do! Task.Yield()
                        try do! run ()
                        with error -> closeStream id (Some error) true
                    }
                    workers[id] <- work
                    work.ContinueWith(
                        (fun (_: Task) -> lock gate (fun () -> workers.Remove(id) |> ignore)),
                        TaskScheduler.Default) |> ignore)

        let serve (state: Exchange) method target headers hasEnd = task {
            try
                let uri = Uri(target, UriKind.Absolute)
                if not (HttpUtils.validTarget uri) then
                    raise (InvalidDataException("Unsupported origin URL."))
                use request = new HttpRequestMessage(HttpMethod(method), uri)
                if not hasEnd || List.exists (fun (name: string, _) -> name.StartsWith("content-", StringComparison.OrdinalIgnoreCase)) headers then
                    request.Content <- new StreamContent(new Flow.BorrowedStream(state.Body))
                HttpUtils.addRequestHeaders request headers
                let! reply = upstream.Value request state.Token
                use response = reply
                do! tunnel.SendAsync(
                    Frame.ResponseHeaders(state.Id, int response.StatusCode, HttpUtils.protocolByte response.Version,
                                          HttpUtils.responseHeaders response, false), state.Token)
                let! body = response.Content.ReadAsStreamAsync(state.Token)
                do! sendBody state body
                closeStream state.Id None false
            with error ->
                if not state.Token.IsCancellationRequested then
                    // A failed origin request has no replay. The caller decides what to do next.
                    if not state.SentEnd then
                        tunnel.PostControl(Frame.CancelStream(state.Id, "Origin request failed"))
                    closeStream state.Id (Some error) false
        }

        let receive frame = task {
            Interlocked.Exchange(&lastRead, Environment.TickCount64) |> ignore
            match frame with
            | Frame.OpenRequest(id, method, target, headers, hasEnd) ->
                if isClient then raise (InvalidDataException("Unexpected request frame."))
                let state =
                    lock gate (fun () ->
                        if id <= lastPeerId then raise (InvalidDataException("Stream identifiers must increase."))
                        lastPeerId <- id
                        let canceled = canceledBeforeOpen.Remove(id)
                        canceledBeforeOpen.RemoveWhere(fun value -> value < id) |> ignore
                        if stopped || canceled then None
                        else
                            if streams.Count >= limits.MaxStreams then
                                raise (InvalidDataException("Too many concurrent streams."))
                            let value = create id CancellationToken.None
                            streams.Add(id, value)
                            Some value)
                match state with
                | Some value ->
                    if hasEnd then value.Body.Finish(None)
                    track id (fun () -> serve value method target headers hasEnd)
                | None -> ()
            | Frame.ResponseHeaders(id, status, version, headers, hasEnd) ->
                if not isClient then raise (InvalidDataException("Unexpected response frame."))
                match find id with
                | None -> requirePastStream id
                | Some state ->
                    if state.ReceivedHeaders then raise (InvalidDataException("Duplicate response headers."))
                    state.ReceivedHeaders <- true
                    let response = new HttpResponseMessage(enum<HttpStatusCode> status)
                    response.Version <- HttpUtils.protocolVersion version
                    response.Content <- new StreamContent(state.Body)
                    HttpUtils.addResponseHeaders response headers
                    if hasEnd then state.Body.Finish(None)
                    if not (state.Headers.TrySetResult(response)) then response.Dispose()
            | Frame.Data(id, bytes, hasEnd) ->
                match find id with
                | None -> requirePastStream id // Data queued before cancellation can still arrive.
                | Some state ->
                    if isClient && not state.ReceivedHeaders then
                        raise (InvalidDataException("Response data arrived before its headers."))
                    try
                        do! state.Body.AcceptAsync(bytes)
                        if hasEnd then state.Body.Finish(None)
                    with _ when state.IsClosed -> ()
            | Frame.EndStream id ->
                match find id with
                | Some state ->
                    try
                        if isClient && not state.ReceivedHeaders then
                            raise (InvalidDataException("Response ended before its headers."))
                        if not state.IsClosed then
                            if state.Body.HasEnded then raise (InvalidDataException("Duplicate stream end."))
                            state.Body.Finish(None)
                    with _ when state.IsClosed -> ()
                | None -> requirePastStream id
            | Frame.WindowUpdate(id, credit) ->
                match find id with
                | Some state ->
                    try state.Credit.Add(credit)
                    with _ when state.IsClosed -> ()
                | None -> requirePastStream id
            | Frame.CancelStream(id, _) ->
                closeStream id (Some (IOException("The peer canceled this request."))) false
                if isClient then requirePastStream id
                else
                    lock gate (fun () ->
                        if id > lastPeerId then
                            if canceledBeforeOpen.Count >= 64 then
                                raise (InvalidDataException("Too many pending cancellations."))
                            canceledBeforeOpen.Add(id) |> ignore)
            | Frame.Ping bytes -> tunnel.PostControl(Frame.Pong bytes)
            | Frame.Pong _ -> ()
        }

        let heartbeat = task {
            try
                while not token.IsCancellationRequested do
                    do! Task.Delay(TimeSpan.FromSeconds(20.0), token)
                    if Environment.TickCount64 - Interlocked.Read(&lastRead) > 60000L then
                        stop (TimeoutException("The tunnel peer stopped responding."))
                    else
                        tunnel.PostControl(Frame.Ping(BitConverter.GetBytes(Environment.TickCount64)))
            with :? OperationCanceledException -> ()
        }

        let completion = task {
            let mutable error: exn = EndOfStreamException("The tunnel closed. Active requests were not replayed.")
            try
                let mutable reading = true
                while reading && not token.IsCancellationRequested do
                    let! frame = tunnel.ReceiveAsync(token)
                    match frame with
                    | Some value -> do! receive value
                    | None -> reading <- false
            with failure -> error <- failure
            stop error
            do! heartbeat
            let pending = lock gate (fun () -> workers.Values |> Seq.toArray)
            do! Task.WhenAll(pending)
            try do! tunnel.Completion with _ -> ()
            (tunnel :> IDisposable).Dispose()
            lifetime.Dispose()
        }

        member _.IsAlive = alive ()
        member _.Completion: Task = completion

        member _.SendAsync(request: HttpRequestMessage, callerToken: CancellationToken) = task {
            if not isClient then invalidOp "Only a client opens requests."
            if not (HttpUtils.validTarget request.RequestUri) then invalidArg "request" "Invalid origin URL."
            use wait = CancellationTokenSource.CreateLinkedTokenSource(token, callerToken)
            do! slots.WaitAsync(wait.Token)
            let mutable registered = false
            let mutable id = 0u
            try
                do! openGate.WaitAsync(wait.Token)
                let mutable state = Unchecked.defaultof<Exchange>
                try
                    state <-
                        lock gate (fun () ->
                            if stopped then raise (IOException("The tunnel is closed."))
                            if nextId > UInt32.MaxValue - 2u then
                                raise (IOException("The tunnel stream identifiers are exhausted."))
                            id <- nextId
                            nextId <- nextId + 2u
                            let value = create id callerToken
                            streams.Add(id, value)
                            registered <- true
                            value)
                    let hasEnd = request.Content = null || request.Content.Headers.ContentLength = Nullable 0L
                    state.WatchCancellation(fun () ->
                        closeStream id (Some (OperationCanceledException(callerToken))) true)
                    do! tunnel.SendAsync(
                        Frame.OpenRequest(id, request.Method.Method, request.RequestUri.OriginalString,
                                          HttpUtils.requestHeaders request, hasEnd), wait.Token)
                    state.OpenQueued <- true
                    // Cancellation can run between enqueueing Open and marking it queued.
                    if state.IsClosed && state.TryNotifyCancel() then
                        tunnel.PostControl(Frame.CancelStream(id, "Stream closed"))
                    if hasEnd then state.SentEnd <- true
                    else
                        track id (fun () -> task {
                            let! body = request.Content.ReadAsStreamAsync(state.Token)
                            do! sendBody state body
                        })
                finally
                    openGate.Release() |> ignore
                return! state.Headers.Task.WaitAsync(wait.Token)
            with error ->
                if registered then closeStream id (Some error) true
                else slots.Release() |> ignore
                return raise error
        }

        interface IDisposable with
            member _.Dispose() = stop (OperationCanceledException("Session disposed"))
