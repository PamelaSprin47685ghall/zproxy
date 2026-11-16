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

    /// Statistics belong to the authenticated server identity, never a request field.
    let wrap (stats: Statistics.Store) (handler: RemoteHandler) : RemoteHandler =
        fun identity request ct -> task {
            Contracts.requestPath request |> ignore
            let activity = stats.Begin(identity)
            let watch = Stopwatch.StartNew()
            let mutable uploaded = 0L
            let mutable downloaded = 0L
            let finish outcome =
                activity.Finish(outcome, Interlocked.Read(&uploaded), Interlocked.Read(&downloaded), watch.ElapsedMilliseconds)
            try
                if request.Content <> null then
                    let! content = contentView request.Content
                                        (fun count -> Interlocked.Add(&uploaded, int64 count) |> ignore) ignore ct
                    request.Content <- content
                let! reply = handler identity request ct
                try
                    let status = int reply.Response.StatusCode
                    let doneReading complete =
                        let outcome =
                            if complete then
                                if status >= 200 && status < 300 then Statistics.Succeeded else Statistics.Failed
                            elif ct.IsCancellationRequested then Statistics.Canceled
                            else Statistics.Failed
                        finish outcome
                    let! content = contentView reply.Response.Content
                                        (fun count -> Interlocked.Add(&downloaded, int64 count) |> ignore) doneReading ct
                    reply.Response.Content <- content
                    return reply
                with error ->
                    reply.Response.Dispose()
                    return raise error
            with error ->
                finish (if ct.IsCancellationRequested then Statistics.Canceled else Statistics.Failed)
                return raise error
        }
