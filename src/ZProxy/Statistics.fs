namespace ZProxy

open System
open System.Collections.Generic
open System.IO
open System.Text.Json
open System.Threading

module Statistics =
    type Outcome = Succeeded | Failed | Canceled

    type ReportRow =
        { Nickname: string
          Requests: int64
          Succeeded: int64
          Failed: int64
          Canceled: int64
          Active: int64
          RequestBytes: int64
          ResponseBytes: int64
          DurationMs: int64 }

    type private Totals =
        { mutable Requests: int64
          mutable Succeeded: int64
          mutable Failed: int64
          mutable Canceled: int64
          mutable Active: int64
          mutable RequestBytes: int64
          mutable ResponseBytes: int64
          mutable DurationMs: int64 }

    let private empty () =
        { Requests = 0L; Succeeded = 0L; Failed = 0L; Canceled = 0L; Active = 0L
          RequestBytes = 0L; ResponseBytes = 0L; DurationMs = 0L }

    let private add first second =
        if second > Int64.MaxValue - first then Int64.MaxValue else first + second

    type Activity internal (finish: Outcome -> int64 -> int64 -> int64 -> unit) =
        let mutable completed = 0

        member _.Finish(outcome, requestBytes, responseBytes, durationMs) =
            if requestBytes < 0L || responseBytes < 0L || durationMs < 0L then
                invalidArg "counters" "Statistics counters cannot be negative."
            if Interlocked.Exchange(&completed, 1) = 0 then
                finish outcome requestBytes responseBytes durationMs

        interface IDisposable with
            member this.Dispose() = this.Finish(Canceled, 0L, 0L, 0L)

    /// Store aggregates only. Public rows contain nicknames and counters, never keys or IDs.
    type Store(directory: string, users: unit -> Users.UserInfo[]) =
        let gate = obj ()
        let path = Path.Combine(directory, "stats.json")
        let totals = Dictionary<string, Totals>(StringComparer.Ordinal)
        let mutable disposed = false
        let mutable dirty = false

        let ensureOpen () = ObjectDisposedException.ThrowIf(disposed, "Statistics.Store")

        let persist () =
            if dirty then
                PrivateFiles.write path (fun writer ->
                    writer.WriteStartObject()
                    writer.WriteNumber("version", 1)
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
                        writer.WriteEndObject()
                    writer.WriteEndArray()
                    writer.WriteEndObject())
                dirty <- false

        let load () =
            try
                use document = PrivateFiles.read path
                let root = document.RootElement
                PrivateFiles.fields [ "version"; "users" ] root
                if root.GetProperty("version").GetInt32() <> 1 then
                    raise (InvalidDataException("The statistics version is unsupported."))
                let known = users () |> Seq.map (fun user -> user.Id) |> HashSet<string>
                let records = root.GetProperty("users")
                if records.ValueKind <> JsonValueKind.Array || records.GetArrayLength() > 10000 then
                    raise (InvalidDataException("The statistics store exceeds its limit."))
                for item in records.EnumerateArray() do
                    PrivateFiles.fields [ "id"; "requests"; "succeeded"; "failed"; "canceled"
                                          "requestBytes"; "responseBytes"; "durationMs" ] item
                    let id = item.GetProperty("id").GetString() |> PrivateFiles.identifier
                    if not (known.Contains(id)) || totals.ContainsKey(id) then
                        raise (InvalidDataException("The statistics contain an unknown or duplicate user."))
                    let count name =
                        let number = item.GetProperty(name: string).GetInt64()
                        if number < 0L then raise (InvalidDataException("A statistics counter is negative."))
                        number
                    let value =
                        { Requests = count "requests"; Succeeded = count "succeeded"; Failed = count "failed"
                          Canceled = count "canceled"; Active = 0L; RequestBytes = count "requestBytes"
                          ResponseBytes = count "responseBytes"; DurationMs = count "durationMs" }
                    if value.Succeeded > value.Requests || value.Failed > value.Requests - value.Succeeded
                       || value.Canceled <> value.Requests - value.Succeeded - value.Failed then
                        raise (InvalidDataException("The statistics outcomes do not match the request count."))
                    totals.Add(id, value)
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
                    value)
            new Activity(fun outcome requestBytes responseBytes durationMs ->
                lock gate (fun () ->
                    if not disposed then
                        value.Active <- value.Active - 1L
                        if value.Requests < Int64.MaxValue then
                            value.Requests <- value.Requests + 1L
                            match outcome with
                            | Succeeded -> value.Succeeded <- value.Succeeded + 1L
                            | Failed -> value.Failed <- value.Failed + 1L
                            | Canceled -> value.Canceled <- value.Canceled + 1L
                        value.RequestBytes <- add value.RequestBytes requestBytes
                        value.ResponseBytes <- add value.ResponseBytes responseBytes
                        value.DurationMs <- add value.DurationMs durationMs
                        dirty <- true))

        member _.Snapshot() : ReportRow[] =
            let known = users ()
            lock gate (fun () ->
                ensureOpen ()
                known |> Array.map (fun user ->
                    let value = match totals.TryGetValue(user.Id) with true, current -> current | _ -> empty ()
                    { Nickname = user.Nickname; Requests = add value.Requests value.Active
                      Succeeded = value.Succeeded; Failed = value.Failed; Canceled = value.Canceled; Active = value.Active
                      RequestBytes = value.RequestBytes; ResponseBytes = value.ResponseBytes; DurationMs = value.DurationMs }))

        member _.Flush() = lock gate (fun () -> if not disposed then persist ())

        interface IDisposable with
            member _.Dispose() =
                lock gate (fun () ->
                    if not disposed then
                        persist ()
                        disposed <- true)
