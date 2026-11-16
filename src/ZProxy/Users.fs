namespace ZProxy

open System
open System.Collections.Generic
open System.IO
open System.Security.Cryptography
open System.Text
open System.Text.Json
open System.Threading

module internal PrivateFiles =
    let private fileMode = UnixFileMode.UserRead ||| UnixFileMode.UserWrite
    let private directoryMode = fileMode ||| UnixFileMode.UserExecute

    let prepare (directory: string) =
        if OperatingSystem.IsWindows() then Directory.CreateDirectory(directory) |> ignore
        else Directory.CreateDirectory(directory, directoryMode) |> ignore

    let read (path: string) =
        let info = FileInfo(path)
        if info.Length > 8L * 1024L * 1024L || info.Attributes.HasFlag(FileAttributes.ReparsePoint) then
            raise (InvalidDataException("The private data file exceeds its limit or is a link."))
        if not (OperatingSystem.IsWindows()) then File.SetUnixFileMode(path, fileMode)
        use stream = File.OpenRead(path)
        JsonDocument.Parse(stream, JsonDocumentOptions(MaxDepth = 8))

    let acquire (directory: string) =
        let path = Path.Combine(directory, "users.lock")
        let options = FileStreamOptions(Mode = FileMode.OpenOrCreate, Access = FileAccess.ReadWrite, Share = FileShare.None)
        if not (OperatingSystem.IsWindows()) then options.UnixCreateMode <- Nullable fileMode
        let stream =
            try new FileStream(path, options)
            with :? IOException as error ->
                raise (IOException("The data directory is already in use or is not writable.", error))
        try
            if not (OperatingSystem.IsWindows()) then File.SetUnixFileMode(path, fileMode)
            stream
        with error ->
            stream.Dispose()
            raise error

    let write (path: string) (writeJson: Utf8JsonWriter -> unit) =
        let temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp"
        try
            let options = FileStreamOptions(Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None)
            if not (OperatingSystem.IsWindows()) then options.UnixCreateMode <- Nullable fileMode
            do
                use stream = new FileStream(temporary, options)
                use writer = new Utf8JsonWriter(stream)
                writeJson writer
                writer.Flush()
                stream.Flush(true)
            File.Move(temporary, path, true)
        finally
            if File.Exists(temporary) then File.Delete(temporary)

    let fields (allowed: string list) (value: JsonElement) =
        if value.ValueKind <> JsonValueKind.Object then
            raise (InvalidDataException("A private data record must be an object."))
        let names = HashSet<string>(StringComparer.Ordinal)
        for property in value.EnumerateObject() do
            if not (List.contains property.Name allowed) || not (names.Add(property.Name)) then
                raise (InvalidDataException("A private data record has an invalid field."))
        if names.Count <> allowed.Length then
            raise (InvalidDataException("A private data record is incomplete."))

    let identifier (value: string) =
        match Guid.TryParseExact(value, "N") with
        | true, parsed when parsed.ToString("N") = value -> value
        | _ -> raise (InvalidDataException("A private data identifier is invalid."))

module Users =
    type Identity = { Id: string; Nickname: string }

    type UserInfo =
        { Id: string
          Nickname: string
          Enabled: bool
          CreatedAt: DateTimeOffset }

    type AuthEntry =
        { Identity: Identity
          Key: byte[]
          Revoked: CancellationToken }

    type IssuedUser = { User: UserInfo; Uuid: string }

    type private Entry =
        { Info: UserInfo
          Selector: byte[]
          Key: byte[]
          Lifetime: CancellationTokenSource }

    let private nickname (value: string) =
        if isNull value then invalidArg "nickname" "A nickname is required."
        let trimmed = value.Trim()
        if trimmed.Length < 1 || trimmed.Length > 64 || Seq.exists Char.IsControl value then
            invalidArg "nickname" "A nickname must have 1 to 64 characters without control characters."
        try UTF8Encoding(false, true).GetByteCount(trimmed) |> ignore
        with :? EncoderFallbackException -> invalidArg "nickname" "The nickname contains invalid text."
        trimmed

    let private clear (entry: Entry) =
        try
            try entry.Lifetime.Cancel()
            with
            | :? AggregateException -> ()
            | :? ObjectDisposedException -> ()
        finally
            entry.Lifetime.Dispose()
            CryptographicOperations.ZeroMemory(entry.Key.AsSpan())

    /// UUIDs are shown once. The file stores derived keys and a separate stable identity.
    type Store(directory: string) =
        let gate = obj ()
        let path = Path.Combine(directory, "users.json")
        let users = Dictionary<string, Entry>(StringComparer.Ordinal)
        let selectors = Dictionary<string, Entry>(StringComparer.Ordinal)
        let names = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let mutable disposed = false
        let ownership =
            PrivateFiles.prepare directory
            PrivateFiles.acquire directory

        let ensureOpen () = ObjectDisposedException.ThrowIf(disposed, "Users.Store")

        let persist (entries: seq<Entry>) =
            PrivateFiles.write path (fun writer ->
                writer.WriteStartObject()
                writer.WriteNumber("version", 1)
                writer.WriteStartArray("users")
                for entry in entries |> Seq.sortBy (fun value -> value.Info.Id) do
                    writer.WriteStartObject()
                    writer.WriteString("id", entry.Info.Id)
                    writer.WriteString("nickname", entry.Info.Nickname)
                    writer.WriteBoolean("enabled", entry.Info.Enabled)
                    writer.WriteString("createdAt", entry.Info.CreatedAt)
                    writer.WriteString("selector", Convert.ToHexString(entry.Selector))
                    writer.WriteString("key", Convert.ToBase64String(entry.Key))
                    writer.WriteEndObject()
                writer.WriteEndArray()
                writer.WriteEndObject())

        let load () =
            try
                use document = PrivateFiles.read path
                let root = document.RootElement
                PrivateFiles.fields [ "version"; "users" ] root
                if root.GetProperty("version").GetInt32() <> 1 then
                    raise (InvalidDataException("The user data version is unsupported."))
                let records = root.GetProperty("users")
                if records.ValueKind <> JsonValueKind.Array || records.GetArrayLength() > 10000 then
                    raise (InvalidDataException("The user store exceeds its limit."))
                for value in records.EnumerateArray() do
                    PrivateFiles.fields [ "id"; "nickname"; "enabled"; "createdAt"; "selector"; "key" ] value
                    let id = value.GetProperty("id").GetString() |> PrivateFiles.identifier
                    let name = value.GetProperty("nickname").GetString()
                    if nickname name <> name then raise (InvalidDataException("The stored nickname is not normalized."))
                    let enabled = value.GetProperty("enabled").GetBoolean()
                    let created = value.GetProperty("createdAt").GetDateTimeOffset()
                    let selectorText = value.GetProperty("selector").GetString()
                    let keyText = value.GetProperty("key").GetString()
                    let expectedSelectorLength, expectedKeyLength = if enabled then 64, 44 else 0, 0
                    if isNull selectorText || isNull keyText
                       || selectorText.Length <> expectedSelectorLength || keyText.Length <> expectedKeyLength then
                        raise (InvalidDataException("The stored credential has an invalid length."))
                    let selector = Convert.FromHexString(selectorText)
                    let key = Convert.FromBase64String(keyText)
                    if (enabled && (selector.Length <> 32 || key.Length <> 32))
                       || users.ContainsKey(id) || names.Contains(name)
                       || (enabled && selectors.ContainsKey(Convert.ToHexString(selector))) then
                        CryptographicOperations.ZeroMemory(key.AsSpan())
                        raise (InvalidDataException("The user store has an invalid or duplicate record."))
                    let entry =
                        { Info = { Id = id; Nickname = name; Enabled = enabled; CreatedAt = created }
                          Selector = selector; Key = key; Lifetime = new CancellationTokenSource() }
                    users.Add(id, entry)
                    names.Add(name) |> ignore
                    if enabled then selectors.Add(Convert.ToHexString(selector), entry)
            with error ->
                for entry in users.Values do clear entry
                raise (InvalidDataException("The user store is not valid.", error))

        do
            try
                if File.Exists(path) then load ()
            with error ->
                ownership.Dispose()
                raise error

        member _.Create(value: string) =
            let name = nickname value
            let uuid = Guid.NewGuid().ToString("D")
            let credential = Crypto.deriveUserCredential uuid
            let entry =
                { Info = { Id = Guid.NewGuid().ToString("N"); Nickname = name; Enabled = true; CreatedAt = DateTimeOffset.UtcNow }
                  Selector = credential.Selector; Key = credential.Key; Lifetime = new CancellationTokenSource() }
            try
                lock gate (fun () ->
                    ensureOpen ()
                    if users.Count >= 10000 then invalidOp "The user limit has been reached."
                    if names.Contains(name) then invalidArg "nickname" "This nickname is already in use."
                    if users.ContainsKey(entry.Info.Id) || selectors.ContainsKey(Convert.ToHexString(entry.Selector)) then
                        invalidOp "Generate a new user credential."
                    persist (Seq.append users.Values [ entry ])
                    users.Add(entry.Info.Id, entry)
                    selectors.Add(Convert.ToHexString(entry.Selector), entry)
                    names.Add(name) |> ignore
                    { User = entry.Info; Uuid = uuid })
            with error ->
                clear entry
                raise error

        member _.List() =
            lock gate (fun () ->
                ensureOpen ()
                users.Values
                |> Seq.map (fun entry -> entry.Info)
                |> Seq.sortWith (fun first second -> StringComparer.OrdinalIgnoreCase.Compare(first.Nickname, second.Nickname))
                |> Seq.toArray)

        member _.Resolve(selector: byte[]) =
            lock gate (fun () ->
                ensureOpen ()
                if isNull selector || selector.Length <> 32 then None
                else
                    match selectors.TryGetValue(Convert.ToHexString(selector)) with
                    | true, entry when entry.Info.Enabled ->
                        Some { Identity = { Id = entry.Info.Id; Nickname = entry.Info.Nickname }
                               Key = Array.copy entry.Key
                               Revoked = entry.Lifetime.Token }
                    | _ -> None)

        member _.Rotate(id: string) =
            let uuid = Guid.NewGuid().ToString("D")
            let credential = Crypto.deriveUserCredential uuid
            let source = new CancellationTokenSource()
            let mutable replacement: Entry option = None
            try
                let previous, issued =
                    lock gate (fun () ->
                        ensureOpen ()
                        let old =
                            match users.TryGetValue(id) with
                            | true, entry -> entry
                            | _ -> raise (KeyNotFoundException("The user does not exist."))
                        let next =
                            { Info = { old.Info with Enabled = true }
                              Selector = credential.Selector; Key = credential.Key; Lifetime = source }
                        if selectors.ContainsKey(Convert.ToHexString(next.Selector)) then invalidOp "Generate a new user credential."
                        persist (users.Values |> Seq.map (fun entry -> if entry.Info.Id = id then next else entry))
                        users[id] <- next
                        if old.Info.Enabled then selectors.Remove(Convert.ToHexString(old.Selector)) |> ignore
                        selectors.Add(Convert.ToHexString(next.Selector), next)
                        replacement <- Some next
                        old, { User = next.Info; Uuid = uuid })
                clear previous
                issued
            with error ->
                if replacement.IsNone then
                    source.Dispose()
                    CryptographicOperations.ZeroMemory(credential.Key.AsSpan())
                raise error

        member _.Revoke(id: string) =
            let revoked =
                lock gate (fun () ->
                    ensureOpen ()
                    match users.TryGetValue(id) with
                    | true, old when old.Info.Enabled ->
                        let next = { old with Info = { old.Info with Enabled = false }; Selector = Array.empty; Key = Array.empty }
                        persist (users.Values |> Seq.map (fun entry -> if entry.Info.Id = id then next else entry))
                        users[id] <- next
                        selectors.Remove(Convert.ToHexString(old.Selector)) |> ignore
                        Some old
                    | _ -> None)
            match revoked with
            | None -> false
            | Some entry ->
                // The disabled entry shares this token but no longer exposes it.
                try entry.Lifetime.Cancel()
                with
                | :? AggregateException -> ()
                | :? ObjectDisposedException -> ()
                CryptographicOperations.ZeroMemory(entry.Key.AsSpan())
                true

        interface IDisposable with
            member _.Dispose() =
                let entries =
                    lock gate (fun () ->
                        if disposed then None
                        else
                            disposed <- true
                            let entries = users.Values |> Seq.toArray
                            users.Clear()
                            selectors.Clear()
                            names.Clear()
                            Some entries)
                match entries with
                | None -> ()
                | Some entries ->
                    try
                        for entry in entries do clear entry
                    finally
                        ownership.Dispose()
