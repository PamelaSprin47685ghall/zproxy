namespace ZProxy

open System
open System.Diagnostics
open System.IO
open System.Net.Http
open System.Threading
open System.Threading.Tasks

module Metering =
    type private ReadView(source: Stream, read: int -> unit, finish: bool -> unit, close: unit -> unit) =
        inherit Stream()
        let mutable disposed = 0
        let mutable complete = false
        let note count =
            if count = 0 then complete <- true
            else read count
        override _.CanRead = true
        override _.CanWrite = false
        override _.CanSeek = false
        override _.Length = raise (NotSupportedException())
        override _.Position with get () = raise (NotSupportedException()) and set _ = raise (NotSupportedException())
        override _.Flush() = ()
        override _.Seek(_, _) = raise (NotSupportedException())
        override _.SetLength(_) = raise (NotSupportedException())
        override _.Write(_, _, _) = raise (NotSupportedException())
        override _.Read(buffer, offset, count) =
            let received = source.Read(buffer, offset, count)
            if count > 0 then note received
            received
        override this.ReadAsync(buffer, offset, count, ct) = this.ReadAsync(buffer.AsMemory(offset, count), ct).AsTask()
        override _.ReadAsync(buffer: Memory<byte>, ct: CancellationToken) = ValueTask<int>(task {
            let! count = source.ReadAsync(buffer, ct)
            if buffer.Length > 0 then note count
            return count
        })
        override _.Dispose(disposing) =
            if disposing && Interlocked.Exchange(&disposed, 1) = 0 then
                try close ()
                finally finish complete
            base.Dispose(disposing)

    let private contentView (original: HttpContent) read finish ct = task {
        let! source = original.ReadAsStreamAsync(ct)
        let content = new StreamContent(new ReadView(source, read, finish, original.Dispose))
        for header in original.Headers do content.Headers.TryAddWithoutValidation(header.Key, header.Value) |> ignore
        return content :> HttpContent
    }

    /// Map a response status to its class. A code outside every range is reported
    /// as `NoResponse` because it carries no usable class.
    let private statusClass (code: int) =
        if code >= 200 && code < 300 then Statistics.Success
        elif code >= 300 && code < 400 then Statistics.Redirect
        elif code >= 400 && code < 500 then Statistics.ClientError
        elif code >= 500 && code < 600 then Statistics.ServerError
        else Statistics.NoResponse

    /// The route, never the model. These are the only two accepted paths.
    let private kindOf (path: string) =
        if path = "/v1/chat/completions" then Statistics.ChatCompletions
        else Statistics.LegacyCompletions

    /// Statistics belong to the authenticated server identity, never a request field.
    let wrap (stats: Statistics.Store) (handler: RemoteHandler) : RemoteHandler =
        fun identity request ct -> task {
            let path = Contracts.requestPath request
            let activity = stats.Begin(identity)
            let watch = Stopwatch.StartNew()
            let mutable uploaded = 0L
            let mutable downloaded = 0L
            let finish status headersMs streaming outcome =
                activity.Finish
                    { Outcome = outcome
                      RequestBytes = Interlocked.Read(&uploaded)
                      ResponseBytes = Interlocked.Read(&downloaded)
                      DurationMs = watch.ElapsedMilliseconds
                      HeadersMs = headersMs
                      Status = status
                      Kind = kindOf path
                      Streaming = streaming }
            /// The request ended before a response head: transport failure, timeout,
            /// or a tunnel that closed. Nothing was observed about the response.
            let failed outcome = finish Statistics.NoResponse 0L false outcome
            try
                if request.Content <> null then
                    let! content = contentView request.Content
                                        (fun count -> Interlocked.Add(&uploaded, int64 count) |> ignore) ignore ct
                    request.Content <- content
                let! reply = handler identity request ct
                // Time from request start to the response head. This is the wait the
                // caller pays before any body byte, so a slow origin shows here even
                // when the body streams immediately afterwards.
                let headersMs = watch.ElapsedMilliseconds
                let status = statusClass (int reply.Response.StatusCode)
                let streaming = reply.Metadata.IsStreaming
                let doneReading complete =
                    let outcome =
                        if complete then
                            if status = Statistics.Success then Statistics.Succeeded else Statistics.Failed
                        elif ct.IsCancellationRequested then Statistics.Canceled
                        else Statistics.Failed
                    finish status headersMs streaming outcome
                try
                    let! content = contentView reply.Response.Content
                                        (fun count -> Interlocked.Add(&downloaded, int64 count) |> ignore) doneReading ct
                    reply.Response.Content <- content
                    return reply
                with error ->
                    reply.Response.Dispose()
                    finish status headersMs streaming
                        (if ct.IsCancellationRequested then Statistics.Canceled else Statistics.Failed)
                    return raise error
            with error ->
                failed (if ct.IsCancellationRequested then Statistics.Canceled else Statistics.Failed)
                return raise error
        }
