namespace ZProxy

open System
open System.Collections.Generic
open System.IO
open System.Text.Json
open System.Threading

module Statistics =
    type Outcome = Succeeded | Failed | Canceled

    /// The class of the response the caller received. `NoResponse` means the
    /// request ended before any response head arrived.
    type StatusClass = Success | Redirect | ClientError | ServerError | NoResponse

    /// The two completion endpoints the proxy accepts. This is a route, not a model.
    type RequestKind = ChatCompletions | LegacyCompletions

    /// One recent hour of counters. Hours are keyed by the UTC epoch hour, not by a local zone.
    type HourBucket =
        { Hour: int64
          Requests: int64
          Succeeded: int64
          Failed: int64
          Canceled: int64
          RequestBytes: int64
          ResponseBytes: int64
          DurationMs: int64 }

    /// Bounded histogram: <100 ms, <500 ms, <1 s, <5 s, <30 s, and 30 s or more.
    /// The same bounds describe the completed-request duration and the header wait.
    [<Literal>]
    let LatencyBuckets = 6

    [<Literal>]
    let StatusClasses = 5

    [<Literal>]
    let RequestKinds = 2

    /// Everything one finished request contributes. All fields are observed by the
    /// local proxy; none of them requires parsing a response body.
    type Completion =
        { Outcome: Outcome
          RequestBytes: int64
          ResponseBytes: int64
          DurationMs: int64
          /// Time from request start to the response head. Zero when no head arrived.
          HeadersMs: int64
          Status: StatusClass
          Kind: RequestKind
          Streaming: bool }

    type ReportRow =
        { Nickname: string
          Requests: int64
          Succeeded: int64
          Failed: int64
          Canceled: int64
          Active: int64
          RequestBytes: int64
          ResponseBytes: int64
          DurationMs: int64
          /// Most recent complete hours, oldest first. At most `KeepHours` entries.
          Series: HourBucket[]
          /// Six counters aligned with `LatencyBuckets`, oldest hour dropped first.
          Latency: int64[]
          /// Six counters of header wait, aligned with the same bounds as `Latency`.
          HeadersLatency: int64[]
          /// Five counters ordered 2xx, 3xx, 4xx, 5xx, no response.
          Statuses: int64[]
          /// Two counters ordered chat completions, legacy completions.
          Kinds: int64[]
          /// Responses sent with a streaming body, and responses with a buffered body.
          Streamed: int64
          Buffered: int64
          /// Highest number of concurrently active requests ever observed.
          PeakActive: int64
          /// Unix seconds of the most recent finished request; zero means never.
          LastSeen: int64 }

    type private Hour =
        { mutable Requests: int64
          mutable Succeeded: int64
          mutable Failed: int64
          mutable Canceled: int64
          mutable RequestBytes: int64
          mutable ResponseBytes: int64
          mutable DurationMs: int64 }

    type private Totals =
        { mutable Requests: int64
          mutable Succeeded: int64
          mutable Failed: int64
          mutable Canceled: int64
          mutable Active: int64
          mutable PeakActive: int64
          mutable LastSeen: int64
          mutable RequestBytes: int64
          mutable ResponseBytes: int64
          mutable DurationMs: int64
          mutable Streamed: int64
          mutable Buffered: int64
          Hours: Dictionary<int64, Hour>
          Latency: int64[]
          Headers: int64[]
          Statuses: int64[]
          Kinds: int64[] }

    /// Retained hourly window. 24 hours keeps the report small while a full day stays visible.
    [<Literal>]
    let KeepHours = 24

    let private hourOf (now: DateTimeOffset) = now.ToUnixTimeSeconds() / 3600L

    /// Oldest hour a snapshot may report: a window of `KeepHours` hours ending at `current`.
    let private windowStart (current: int64) = current - int64 KeepHours + 1L

    /// Drop buckets outside the window ending at `current`, including hours stamped in its future.
    /// Returns how many buckets were removed so a caller can mark the store dirty.
    let private trim (current: int64) (hours: Dictionary<int64, Hour>) =
        let stale =
            hours.Keys
            |> Seq.filter (fun key -> key < windowStart current || key > current)
            |> Seq.toArray
        for key in stale do hours.Remove key |> ignore
        stale.Length

    /// Bucket index for a duration in milliseconds. Shared by duration and header wait.
    let latencyIndex (durationMs: int64) =
        if durationMs < 100L then 0
        elif durationMs < 500L then 1
        elif durationMs < 1000L then 2
        elif durationMs < 5000L then 3
        elif durationMs < 30000L then 4
        else 5

    let private statusIndex status =
        match status with
        | Success -> 0
        | Redirect -> 1
        | ClientError -> 2
        | ServerError -> 3
        | NoResponse -> 4

    let private kindIndex kind =
        match kind with
        | ChatCompletions -> 0
        | LegacyCompletions -> 1

    let private empty () =
        { Requests = 0L; Succeeded = 0L; Failed = 0L; Canceled = 0L; Active = 0L; PeakActive = 0L
          LastSeen = 0L; RequestBytes = 0L; ResponseBytes = 0L; DurationMs = 0L
          Streamed = 0L; Buffered = 0L
          Hours = Dictionary<int64, Hour>(8)
          Latency = Array.zeroCreate LatencyBuckets
          Headers = Array.zeroCreate LatencyBuckets
          Statuses = Array.zeroCreate StatusClasses
          Kinds = Array.zeroCreate RequestKinds }

    let private add first second =
        if second > Int64.MaxValue - first then Int64.MaxValue else first + second

    let private bump (counters: int64[]) index =
        if index >= 0 && index < counters.Length then counters[index] <- add counters[index] 1L

    let private hourCounters () =
        { Requests = 0L; Succeeded = 0L; Failed = 0L; Canceled = 0L
          RequestBytes = 0L; ResponseBytes = 0L; DurationMs = 0L }

    type Activity internal (finish: Completion -> unit) =
        let mutable completed = 0

        member _.Finish(completion: Completion) =
            if completion.RequestBytes < 0L || completion.ResponseBytes < 0L
               || completion.DurationMs < 0L || completion.HeadersMs < 0L then
                invalidArg "completion" "Statistics counters cannot be negative."
            if Interlocked.Exchange(&completed, 1) = 0 then finish completion

        /// Compatibility shim for callers that do not classify a response. It is
        /// not used by the proxy path, which always passes a full `Completion`.
        member this.Finish(outcome, requestBytes, responseBytes, durationMs) =
            this.Finish
                { Outcome = outcome
                  RequestBytes = requestBytes
                  ResponseBytes = responseBytes
                  DurationMs = durationMs
                  HeadersMs = 0L
                  Status = (if outcome = Succeeded then Success else NoResponse)
                  Kind = ChatCompletions
                  Streaming = false }

        interface IDisposable with
            member this.Dispose() = this.Finish(Canceled, 0L, 0L, 0L)

    /// Store aggregates only. Public rows contain nicknames and counters, never keys or IDs.
    /// The optional clock exists so a test can advance the hourly window.
    type Store(directory: string, users: unit -> Users.UserInfo[], ?clock: unit -> DateTimeOffset) =
        let now = match clock with Some source -> source | None -> (fun () -> DateTimeOffset.UtcNow)
        let gate = obj ()
        let path = Path.Combine(directory, "stats.json")
        let totals = Dictionary<string, Totals>(StringComparer.Ordinal)
        let mutable disposed = false
        let mutable dirty = false
        let mutable taken = now ()

        let ensureOpen () = ObjectDisposedException.ThrowIf(disposed, "Statistics.Store")

        let writeHours (writer: Utf8JsonWriter) (hours: Dictionary<int64, Hour>) =
            writer.WriteStartArray("hours")
            for pair in hours |> Seq.sortBy (fun pair -> pair.Key) do
                let value = pair.Value
                writer.WriteStartObject()
                writer.WriteNumber("hour", pair.Key)
                writer.WriteNumber("requests", value.Requests)
                writer.WriteNumber("succeeded", value.Succeeded)
                writer.WriteNumber("failed", value.Failed)
                writer.WriteNumber("canceled", value.Canceled)
                writer.WriteNumber("requestBytes", value.RequestBytes)
                writer.WriteNumber("responseBytes", value.ResponseBytes)
                writer.WriteNumber("durationMs", value.DurationMs)
                writer.WriteEndObject()
            writer.WriteEndArray()

        let writeCounters (writer: Utf8JsonWriter) (name: string) (counters: int64[]) =
            writer.WriteStartArray(name)
            for count in counters do writer.WriteNumberValue count
            writer.WriteEndArray()

        let persist () =
            if dirty then
                PrivateFiles.write path (fun writer ->
                    writer.WriteStartObject()
                    writer.WriteNumber("version", 3)
                    writer.WriteStartArray("users")
                    for pair in totals |> Seq.sortBy (fun pair -> pair.Key) do
                        let value = pair.Value
                        writer.WriteStartObject()
                        writer.WriteString("id", pair.Key)
                        writer.WriteNumber("requests", value.Requests)
                        writer.WriteNumber("succeeded", value.Succeeded)
                        writer.WriteNumber("failed", value.Failed)
                        writer.WriteNumber("canceled", value.Canceled)
                        writer.WriteNumber("requestBytes", value.RequestBytes)
                        writer.WriteNumber("responseBytes", value.ResponseBytes)
                        writer.WriteNumber("durationMs", value.DurationMs)
                        writeCounters writer "latency" value.Latency
                        writeCounters writer "headersLatency" value.Headers
                        writeCounters writer "statuses" value.Statuses
                        writeCounters writer "kinds" value.Kinds
                        writer.WriteNumber("streamed", value.Streamed)
                        writer.WriteNumber("buffered", value.Buffered)
                        writer.WriteNumber("peakActive", value.PeakActive)
                        writer.WriteNumber("lastSeen", value.LastSeen)
                        writeHours writer value.Hours
                        writer.WriteEndObject()
                    writer.WriteEndArray()
                    writer.WriteEndObject())
                dirty <- false

        let readCounters (item: JsonElement) =
            let count name =
                let number = item.GetProperty(name: string).GetInt64()
                if number < 0L then raise (InvalidDataException("A statistics counter is negative."))
                number
            count "requests", count "succeeded", count "failed", count "canceled",
            count "requestBytes", count "responseBytes", count "durationMs"

        let readArray (item: JsonElement) name length =
            let element = item.GetProperty(name: string)
            if element.ValueKind <> JsonValueKind.Array || element.GetArrayLength() <> length then
                raise (InvalidDataException("A statistics histogram has the wrong shape."))
            let counters = Array.zeroCreate length
            for index in 0 .. length - 1 do
                let number = element[index].GetInt64()
                if number < 0L then raise (InvalidDataException("A histogram counter is negative."))
                counters[index] <- number
            counters

        let readHours (item: JsonElement) =
            let hours = Dictionary<int64, Hour>(8)
            let entries = item.GetProperty("hours")
            if entries.ValueKind <> JsonValueKind.Array || entries.GetArrayLength() > KeepHours then
                raise (InvalidDataException("The hourly series exceeds its limit."))
            for entry in entries.EnumerateArray() do
                PrivateFiles.fields [ "hour"; "requests"; "succeeded"; "failed"; "canceled"
                                      "requestBytes"; "responseBytes"; "durationMs" ] entry
                let hour = entry.GetProperty("hour").GetInt64()
                if hour < 0L || hours.ContainsKey(hour) then
                    raise (InvalidDataException("The hourly series is not ordered or not unique."))
                let hRequests, hSucceeded, hFailed, hCanceled, hRequestBytes, hResponseBytes, hDurationMs =
                    readCounters entry
                if hSucceeded > hRequests || hFailed > hRequests - hSucceeded
                   || hCanceled <> hRequests - hSucceeded - hFailed then
                    raise (InvalidDataException("The hourly outcomes do not match the request count."))
                hours.Add(hour, { Requests = hRequests; Succeeded = hSucceeded; Failed = hFailed
                                  Canceled = hCanceled; RequestBytes = hRequestBytes
                                  ResponseBytes = hResponseBytes; DurationMs = hDurationMs })
            hours

        let readOutcomes (known: HashSet<string>) (item: JsonElement) =
            let id = item.GetProperty("id").GetString() |> PrivateFiles.identifier
            if not (known.Contains(id)) || totals.ContainsKey(id) then
                raise (InvalidDataException("The statistics contain an unknown or duplicate user."))
            let requests, succeeded, failed, canceled, requestBytes, responseBytes, durationMs = readCounters item
            if succeeded > requests || failed > requests - succeeded
               || canceled <> requests - succeeded - failed then
                raise (InvalidDataException("The statistics outcomes do not match the request count."))
            id, { empty () with
                    Requests = requests; Succeeded = succeeded; Failed = failed; Canceled = canceled
                    RequestBytes = requestBytes; ResponseBytes = responseBytes; DurationMs = durationMs }

        let loadV1 (known: HashSet<string>) (records: JsonElement) =
            for item in records.EnumerateArray() do
                PrivateFiles.fields [ "id"; "requests"; "succeeded"; "failed"; "canceled"
                                      "requestBytes"; "responseBytes"; "durationMs" ] item
                let id, value = readOutcomes known item
                totals.Add(id, value)

        let loadV2 (known: HashSet<string>) (records: JsonElement) =
            for item in records.EnumerateArray() do
                PrivateFiles.fields [ "id"; "requests"; "succeeded"; "failed"; "canceled"
                                      "requestBytes"; "responseBytes"; "durationMs"; "latency"; "hours" ] item
                let id, value = readOutcomes known item
                totals.Add(id, { value with Latency = readArray item "latency" LatencyBuckets
                                            Hours = readHours item })

        let loadV3 (known: HashSet<string>) (records: JsonElement) =
            for item in records.EnumerateArray() do
                PrivateFiles.fields [ "id"; "requests"; "succeeded"; "failed"; "canceled"
                                      "requestBytes"; "responseBytes"; "durationMs"; "latency"; "headersLatency"
                                      "statuses"; "kinds"; "streamed"; "buffered"; "peakActive"; "lastSeen"; "hours" ] item
                let id, value = readOutcomes known item
                let number name =
                    let value = item.GetProperty(name: string).GetInt64()
                    if value < 0L then raise (InvalidDataException("A statistics counter is negative."))
                    value
                totals.Add(id, { value with
                                   Latency = readArray item "latency" LatencyBuckets
                                   Headers = readArray item "headersLatency" LatencyBuckets
                                   Statuses = readArray item "statuses" StatusClasses
                                   Kinds = readArray item "kinds" RequestKinds
                                   Streamed = number "streamed"
                                   Buffered = number "buffered"
                                   PeakActive = number "peakActive"
                                   LastSeen = number "lastSeen"
                                   Hours = readHours item })

        let load () =
            try
                use document = PrivateFiles.read path
                let root = document.RootElement
                PrivateFiles.fields [ "version"; "users" ] root
                let version = root.GetProperty("version").GetInt32()
                if version < 1 || version > 3 then
                    raise (InvalidDataException("The statistics version is unsupported."))
                let known = users () |> Seq.map (fun user -> user.Id) |> HashSet<string>
                let records = root.GetProperty("users")
                if records.ValueKind <> JsonValueKind.Array || records.GetArrayLength() > 10000 then
                    raise (InvalidDataException("The statistics store exceeds its limit."))
                match version with
                | 1 -> loadV1 known records
                | 2 -> loadV2 known records
                | _ -> loadV3 known records
            with error -> raise (InvalidDataException("The statistics store is not valid.", error))

        do
            PrivateFiles.prepare directory
            if File.Exists(path) then load ()

        member _.Begin(identity: Users.Identity) =
            let alreadyKnown = lock gate (fun () -> ensureOpen (); totals.ContainsKey(identity.Id))
            if not alreadyKnown && not (users () |> Array.exists (fun user -> user.Id = identity.Id)) then
                invalidArg "identity" "The statistics user does not exist."
            let value =
                lock gate (fun () ->
                    ensureOpen ()
                    let value =
                        match totals.TryGetValue(identity.Id) with
                        | true, current -> current
                        | _ ->
                            if totals.Count >= 10000 then invalidOp "The statistics user limit has been reached."
                            let current = empty ()
                            totals.Add(identity.Id, current)
                            current
                    value.Active <- add value.Active 1L
                    if value.Active > value.PeakActive then value.PeakActive <- value.Active
                    value)
            new Activity(fun completion ->
                lock gate (fun () ->
                    if not disposed then
                        value.Active <- max 0L (value.Active - 1L)
                        if value.Requests < Int64.MaxValue then
                            value.Requests <- value.Requests + 1L
                            match completion.Outcome with
                            | Succeeded -> value.Succeeded <- value.Succeeded + 1L
                            | Failed -> value.Failed <- value.Failed + 1L
                            | Canceled -> value.Canceled <- value.Canceled + 1L
                            bump value.Latency (latencyIndex completion.DurationMs)
                            if completion.Status <> NoResponse then
                                bump value.Headers (latencyIndex completion.HeadersMs)
                            bump value.Statuses (statusIndex completion.Status)
                            bump value.Kinds (kindIndex completion.Kind)
                            // A request that ended before any response head was neither
                            // streamed nor buffered: no body existed. Counting it as
                            // buffered would report a transport failure as a body type.
                            if completion.Status <> NoResponse then
                                if completion.Streaming then value.Streamed <- add value.Streamed 1L
                                else value.Buffered <- add value.Buffered 1L
                            let stamp = (now ()).ToUnixTimeSeconds()
                            value.LastSeen <- max value.LastSeen stamp
                            let key = hourOf (now ())
                            let hour =
                                match value.Hours.TryGetValue(key) with
                                | true, current -> current
                                | _ ->
                                    let created = hourCounters ()
                                    value.Hours.Add(key, created)
                                    if value.Hours.Count > KeepHours then
                                        let oldest = value.Hours |> Seq.map (fun pair -> pair.Key) |> Seq.min
                                        value.Hours.Remove(oldest) |> ignore
                                    created
                            hour.Requests <- add hour.Requests 1L
                            match completion.Outcome with
                            | Succeeded -> hour.Succeeded <- add hour.Succeeded 1L
                            | Failed -> hour.Failed <- add hour.Failed 1L
                            | Canceled -> hour.Canceled <- add hour.Canceled 1L
                            hour.RequestBytes <- add hour.RequestBytes completion.RequestBytes
                            hour.ResponseBytes <- add hour.ResponseBytes completion.ResponseBytes
                            hour.DurationMs <- add hour.DurationMs completion.DurationMs
                        value.RequestBytes <- add value.RequestBytes completion.RequestBytes
                        value.ResponseBytes <- add value.ResponseBytes completion.ResponseBytes
                        value.DurationMs <- add value.DurationMs completion.DurationMs
                        dirty <- true))

        /// One consistent read: the stamp is the instant used to trim the hourly window.
        member _.SnapshotWithTime() : struct (ReportRow[] * DateTimeOffset) =
            let known = users ()
            let at = now ()
            let current = hourOf at
            let rows =
                lock gate (fun () ->
                    ensureOpen ()
                    taken <- at
                    known |> Array.map (fun user ->
                        let value = match totals.TryGetValue(user.Id) with true, current -> current | _ -> empty ()
                        if value.Hours.Count > 0 && trim current value.Hours > 0 then dirty <- true
                        { Nickname = user.Nickname; Requests = add value.Requests value.Active
                          Succeeded = value.Succeeded; Failed = value.Failed; Canceled = value.Canceled; Active = value.Active
                          RequestBytes = value.RequestBytes; ResponseBytes = value.ResponseBytes; DurationMs = value.DurationMs
                          Series =
                            value.Hours
                            |> Seq.sortBy (fun pair -> pair.Key)
                            |> Seq.map (fun pair ->
                                { Hour = pair.Key; Requests = pair.Value.Requests; Succeeded = pair.Value.Succeeded
                                  Failed = pair.Value.Failed; Canceled = pair.Value.Canceled
                                  RequestBytes = pair.Value.RequestBytes; ResponseBytes = pair.Value.ResponseBytes
                                  DurationMs = pair.Value.DurationMs })
                            |> Seq.toArray
                          Latency = Array.copy value.Latency
                          HeadersLatency = Array.copy value.Headers
                          Statuses = Array.copy value.Statuses
                          Kinds = Array.copy value.Kinds
                          Streamed = value.Streamed
                          Buffered = value.Buffered
                          PeakActive = value.PeakActive
                          LastSeen = value.LastSeen }))
            struct (rows, at)

        member this.Snapshot() : ReportRow[] =
            let struct (rows, _) = this.SnapshotWithTime()
            rows

        /// UTC instant of the most recent snapshot; the report is consistent with this stamp.
        member _.SnapshotTime = taken

        member _.Flush() = lock gate (fun () -> if not disposed then persist ())

        interface IDisposable with
            member _.Dispose() =
                lock gate (fun () ->
                    if not disposed then
                        persist ()
                        disposed <- true)
