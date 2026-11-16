namespace ZProxy

open System
open System.Buffers.Binary
open System.IO
open System.Security.Cryptography
open System.Threading
open System.Threading.Tasks

module Handshake =
    let private encode (limits: Options.Limits) =
        let bytes = Array.zeroCreate<byte> 12
        "ZPX4"B.CopyTo(bytes, 0)
        bytes[4] <- byte limits.UploadWindowLog
        bytes[5] <- byte limits.DownloadWindowLog
        BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(6, 2), uint16 limits.MaxStreams)
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(8, 4), limits.StreamWindowBytes)
        bytes

    let private decode (bytes: byte[]) =
        if bytes.Length <> 12 || not (bytes.AsSpan(0, 4).SequenceEqual("ZPX4"B)) then
            raise (InvalidDataException("Unsupported tunnel handshake."))
        Options.validate
            { UploadWindowLog = int bytes[4]
              DownloadWindowLog = int bytes[5]
              MaxStreams = int (BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(6, 2)))
              StreamWindowBytes = BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(8, 4)) }

    let private readHello (stream: Stream) key direction preamble ct = task {
        let length = Array.zeroCreate<byte> 3
        do! stream.ReadExactlyAsync(length.AsMemory(), ct)
        if length <> [| 0uy; 0uy; 12uy |] then
            raise (InvalidDataException("Invalid handshake length."))
        let payload = Array.zeroCreate<byte> 28
        do! stream.ReadExactlyAsync(payload.AsMemory(), ct)
        use aead = new ChaCha20Poly1305(key: byte[])
        match Crypto.openChunk aead direction 0UL preamble length (ReadOnlySpan(payload)) with
        | Ok plain -> return decode plain
        | Error error -> return raise (InvalidDataException(error))
    }

    let private writeHello (stream: Stream) key direction preamble limits ct = task {
        use aead = new ChaCha20Poly1305(key: byte[])
        let bytes = Crypto.sealChunk aead direction 0UL preamble (ReadOnlySpan(encode limits))
        do! stream.WriteAsync(bytes.AsMemory(), ct)
        do! stream.FlushAsync(ct)
    }

    let private headerValues name (head: HttpWire.Head) =
        head.Headers
        |> List.choose (fun (key, value) ->
            if key.Equals(name, StringComparison.OrdinalIgnoreCase) then Some value else None)

    let private requireChunked head =
        match headerValues "transfer-encoding" head with
        | [ value ] when value.Equals("chunked", StringComparison.OrdinalIgnoreCase) -> ()
        | _ -> raise (InvalidDataException("The tunnel requires a chunked HTTP/1.1 body."))
        if not (List.isEmpty (headerValues "content-length" head)) then
            raise (InvalidDataException("A tunnel cannot have a fixed content length."))

    let private zeroKeys (keys: Crypto.SessionKeys) =
        CryptographicOperations.ZeroMemory(keys.KeyC2S.AsSpan())
        CryptographicOperations.ZeroMemory(keys.KeyS2C.AsSpan())

    let connect (wire: HttpWire.Connection) (server: Uri) (credential: Crypto.UserCredential) limits ct = task {
        Options.validate limits |> ignore
        if isNull (box credential) || isNull credential.Selector || credential.Selector.Length <> 32
           || isNull credential.Key || credential.Key.Length <> 32 then
            invalidArg "credential" "Invalid user credential."
        let preamble, _ = Crypto.createPreamble ()
        let keys = Crypto.deriveSessionKeys credential.Key preamble
        try
            do! wire.WriteHeadAsync(
                { StartLine = "POST /tunnel HTTP/1.1"
                  Headers = [ "Host", server.Authority; "Content-Type", "application/octet-stream"
                              "Transfer-Encoding", "chunked"; "Connection", "keep-alive" ] }, ct)
            do! wire.Body.WriteAsync(credential.Selector.AsMemory(), ct)
            do! wire.Body.WriteAsync(preamble.AsMemory(), ct)
            do! writeHello wire.Body keys.KeyC2S Crypto.DirC2S preamble limits ct
            let! response = wire.ReadHeadAsync(ct)
            if not (response.StartLine.StartsWith("HTTP/1.1 200 ", StringComparison.Ordinal)) then
                raise (IOException("The tunnel server rejected the connection."))
            requireChunked response
            let! agreed = readHello wire.Body keys.KeyS2C Crypto.DirS2C preamble ct
            if Options.negotiate agreed limits <> agreed then
                raise (InvalidDataException("The server exceeded the offered limits."))
            return keys, preamble, agreed
        with error ->
            zeroKeys keys
            return raise error
    }

    let accept (wire: HttpWire.Connection) (resolve: byte[] -> Users.AuthEntry option)
               allowed (replay: Crypto.ReplayFilter) (ct: CancellationToken) = task {
        let! request = wire.ReadHeadAsync(ct)
        if request.StartLine <> "POST /tunnel HTTP/1.1" then
            raise (InvalidDataException("Unknown tunnel route."))
        requireChunked request
        match headerValues "host" request with
        | [ host ] when not (String.IsNullOrWhiteSpace(host)) -> ()
        | _ -> raise (InvalidDataException("The tunnel requires one Host field."))
        let selector = Array.zeroCreate<byte> 32
        do! wire.Body.ReadExactlyAsync(selector.AsMemory(), ct)
        let entry =
            match resolve selector with
            | Some entry -> entry
            | None -> raise (InvalidDataException("The tunnel credentials were rejected."))
        try
            if entry.Revoked.IsCancellationRequested then
                raise (InvalidDataException("The tunnel credentials were rejected."))
            use active = CancellationTokenSource.CreateLinkedTokenSource(ct, entry.Revoked)
            let preamble = Array.zeroCreate<byte> 32
            do! wire.Body.ReadExactlyAsync(preamble.AsMemory(), active.Token)
            let parsed =
                match Crypto.parsePreamble (ReadOnlySpan(preamble)) with
                | Ok value -> value
                | Error error -> raise (InvalidDataException(error))
            let keys = Crypto.deriveSessionKeys entry.Key preamble
            CryptographicOperations.ZeroMemory(entry.Key.AsSpan())
            try
                let! offered = readHello wire.Body keys.KeyC2S Crypto.DirC2S preamble active.Token
                if entry.Revoked.IsCancellationRequested then
                    raise (InvalidDataException("The tunnel credentials were rejected."))
                // Only authenticated users can occupy the replay table.
                if not (replay.Validate(parsed)) then
                    raise (InvalidDataException("The handshake expired or was already used."))
                let agreed = Options.negotiate offered allowed
                do! wire.WriteHeadAsync(
                    { StartLine = "HTTP/1.1 200 OK"
                      Headers = [ "Content-Type", "application/octet-stream"
                                  "Transfer-Encoding", "chunked"; "Connection", "keep-alive"
                                  "Cache-Control", "no-store" ] }, active.Token)
                do! writeHello wire.Body keys.KeyS2C Crypto.DirS2C preamble agreed active.Token
                active.Token.ThrowIfCancellationRequested()
                return entry, keys, preamble, agreed
            with error ->
                zeroKeys keys
                return raise error
        finally
            CryptographicOperations.ZeroMemory(entry.Key.AsSpan())
    }
