namespace ZProxy

open System
open System.Buffers
open System.IO
open System.IO.Pipelines
open System.Threading
open System.Threading.Tasks

module Flow =
    /// Wait before enqueueing data, so one slow stream cannot block the writer.
    type SendWindow(capacity: int) =
        do if capacity <= 0 then invalidArg "capacity" "The window must be positive."
        let gate = obj ()
        let mutable available = capacity
        let mutable failure: exn option = None
        let mutable changed = TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)

        let take count requireFull (ct: CancellationToken) = task {
            let mutable taken = 0
            while taken = 0 do
                ct.ThrowIfCancellationRequested()
                let wait =
                    lock gate (fun () ->
                        match failure with
                        | Some error -> raise error
                        | None ->
                            if available > 0 && (not requireFull || available >= count) then
                                taken <- min available count
                                available <- available - taken
                            changed.Task)
                if taken = 0 then do! wait.WaitAsync(ct)
            return taken
        }

        member _.TakeAsync(count: int, ct: CancellationToken) = task {
            if count <= 0 || count > capacity then invalidArg "count" "Invalid credit request."
            let! _ = take count true ct
            return ()
        }

        member _.TakeUpToAsync(maxCount: int, ct: CancellationToken) = task {
            if maxCount <= 0 then invalidArg "maxCount" "The requested credit must be positive."
            return! take maxCount false ct
        }

        member _.Add(count: int) =
            lock gate (fun () ->
                match failure with
                | Some _ -> ()
                | None ->
                    if count <= 0 || count > capacity - available then
                        raise (InvalidDataException("Invalid stream credit."))
                    available <- available + count
                    let previous = changed
                    changed <- TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)
                    previous.TrySetResult() |> ignore)

        member _.Fail(error: exn) =
            lock gate (fun () ->
                if failure.IsNone then failure <- Some error
                changed.TrySetResult() |> ignore)

    /// The peer's byte credit bounds this pipe. Small frames share pipe segments.
    type ReceiveBody(capacity: int, returnCredit: int -> unit, onClose: unit -> unit) =
        inherit Stream()
        do if capacity <= 0 then invalidArg "capacity" "The window must be positive."
        let gate = obj ()
        let pipe = Pipe(PipeOptions(pauseWriterThreshold = 0L, resumeWriterThreshold = 0L))
        let threshold = max 1 (capacity / 2)
        let mutable available = capacity
        let mutable pendingCredit = 0
        let mutable writerCompleted = false
        let mutable peerEnded = false
        let mutable closed = false
        let mutable disposed = false
        let mutable reading = false
        let mutable readerCompleted = false

        let completeReader () =
            if disposed && not reading && not readerCompleted then
                readerCompleted <- true
                pipe.Reader.Complete()

        let consumed count =
            if count > 0 then
                let credit =
                    lock gate (fun () ->
                        if writerCompleted || closed then 0
                        else
                            pendingCredit <- pendingCredit + count
                            if pendingCredit < threshold then 0
                            else
                                let credit = pendingCredit
                                pendingCredit <- 0
                                available <- available + credit
                                credit)
                if credit > 0 then returnCredit credit

        member _.AcceptAsync(data: byte[]) = task {
            if isNull data || data.Length = 0 then invalidArg "data" "Body data must not be empty."
            let flush =
                lock gate (fun () ->
                    if closed then ValueNone
                    else
                        if writerCompleted then raise (InvalidDataException("Data arrived after the body ended."))
                        if data.Length > available then
                            raise (InvalidDataException("The peer exceeded its stream window."))
                        available <- available - data.Length
                        data.AsSpan().CopyTo(pipe.Writer.GetSpan(data.Length))
                        pipe.Writer.Advance(data.Length)
                        ValueSome(pipe.Writer.FlushAsync()))
            match flush with
            | ValueNone -> ()
            | ValueSome pending ->
                let! result = pending
                if result.IsCanceled && not (lock gate (fun () -> closed)) then
                    raise (OperationCanceledException())
        }

        member _.Finish(error: exn option) =
            lock gate (fun () ->
                if error.IsSome then closed <- true
                elif not closed then peerEnded <- true
                if not writerCompleted then
                    writerCompleted <- true
                    pipe.Writer.Complete(defaultArg error null))

        member _.HasEnded = lock gate (fun () -> peerEnded)
        member _.IsClosed = lock gate (fun () -> closed)
        override _.CanRead = lock gate (fun () -> not disposed)
        override _.CanSeek = false
        override _.CanWrite = false
        override _.Length = raise (NotSupportedException())
        override _.Position with get () = raise (NotSupportedException()) and set _ = raise (NotSupportedException())
        override _.Flush() = ()
        override _.Seek(_, _) = raise (NotSupportedException())
        override _.SetLength(_) = raise (NotSupportedException())
        override _.Write(_, _, _) = raise (NotSupportedException())
        override this.Read(buffer, offset, count) =
            this.ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult()
        override this.ReadAsync(buffer, offset, count, ct) =
            this.ReadAsync(buffer.AsMemory(offset, count), ct).AsTask()
        override _.ReadAsync(buffer: Memory<byte>, ct: CancellationToken) =
            ValueTask<int>(task {
                lock gate (fun () ->
                    ObjectDisposedException.ThrowIf(disposed, "ReceiveBody")
                    if reading then invalidOp "Only one body read may run at a time."
                    reading <- true)
                try
                    ct.ThrowIfCancellationRequested()
                    if buffer.Length = 0 then return 0
                    else
                        let mutable count = 0
                        let mutable complete = false
                        while not complete do
                            let! result = pipe.Reader.ReadAsync(ct)
                            let bytes = result.Buffer
                            if result.IsCanceled then
                                pipe.Reader.AdvanceTo(bytes.Start)
                                ObjectDisposedException.ThrowIf(lock gate (fun () -> disposed), "ReceiveBody")
                                raise (OperationCanceledException(ct))
                            count <- int (min (int64 buffer.Length) bytes.Length)
                            bytes.Slice(0L, int64 count).CopyTo(buffer.Span)
                            pipe.Reader.AdvanceTo(bytes.GetPosition(int64 count))
                            complete <- count > 0 || result.IsCompleted
                        consumed count
                        return count
                finally
                    lock gate (fun () ->
                        reading <- false
                        completeReader ())
            })
        override _.Dispose(disposing) =
            if disposing then
                let notify =
                    lock gate (fun () ->
                        if disposed then false
                        else
                            disposed <- true
                            closed <- true
                            if not writerCompleted then
                                writerCompleted <- true
                                pipe.Writer.Complete(ObjectDisposedException("ReceiveBody"))
                            pipe.Reader.CancelPendingRead()
                            completeReader ()
                            true)
                if notify then onClose ()
            base.Dispose(disposing)

    /// The message owns this view, but its HTTP server owns the source stream.
    type BorrowedStream(source: Stream) =
        inherit Stream()
        override _.CanRead = source.CanRead
        override _.CanSeek = false
        override _.CanWrite = false
        override _.Length = raise (NotSupportedException())
        override _.Position with get () = raise (NotSupportedException()) and set _ = raise (NotSupportedException())
        override _.Flush() = ()
        override _.Seek(_, _) = raise (NotSupportedException())
        override _.SetLength(_) = raise (NotSupportedException())
        override _.Write(_, _, _) = raise (NotSupportedException())
        override _.Read(buffer, offset, count) = source.Read(buffer, offset, count)
        override _.ReadAsync(buffer, offset, count, ct) = source.ReadAsync(buffer, offset, count, ct)
        override _.ReadAsync(buffer: Memory<byte>, ct: CancellationToken) = source.ReadAsync(buffer, ct)
