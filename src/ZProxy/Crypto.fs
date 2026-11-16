namespace ZProxy

open System
open System.Buffers.Binary
open System.Collections.Generic
open System.Security.Cryptography
open System.Text

module Crypto =

    [<Literal>]
    let MaxChunkBytes = 65536

    let InfoKeyC2S = "zproxy-v4-key-c2s"B
    let InfoKeyS2C = "zproxy-v4-key-s2c"B
    let DirC2S = [| 0x43uy; 0x32uy; 0x53uy; 0uy |]
    let DirS2C = [| 0x53uy; 0x32uy; 0x43uy; 0uy |]

    type UserCredential =
        { Selector: byte[]
          Key: byte[] }

    /// UUIDs are random secrets. Keep public selectors separate from authentication keys.
    let deriveUserCredential (uuid: string) : UserCredential =
        let valid, parsed = Guid.TryParseExact(uuid, "D")
        if not valid || isNull uuid || uuid.Length <> 36 then
            invalidArg "uuid" "The user credential must be a version 4 UUID."
        let canonical = parsed.ToString("D")
        if not (uuid.Equals(canonical, StringComparison.OrdinalIgnoreCase))
           || canonical[14] <> '4' || "89ab".IndexOf(canonical[19]) < 0 then
            invalidArg "uuid" "The user credential must be a version 4 UUID."
        let secret = Encoding.ASCII.GetBytes(canonical)
        let derive (domain: byte[]) =
            let input = Array.zeroCreate<byte> (domain.Length + secret.Length)
            try
                domain.CopyTo(input, 0)
                secret.CopyTo(input, domain.Length)
                SHA256.HashData(input)
            finally
                CryptographicOperations.ZeroMemory(input.AsSpan())
        try
            { Selector = derive "zproxy-v3-user-selector\000"B
              Key = derive "zproxy-v3-user-key\000"B }
        finally
            CryptographicOperations.ZeroMemory(secret.AsSpan())

    [<Struct>]
    type Preamble =
        { Salt: byte[]
          TimestampMs: int64 }

    let createPreamble () : byte[] * Preamble =
        let bytes = Array.zeroCreate<byte> 32
        RandomNumberGenerator.Fill(bytes.AsSpan(0, 24))
        let now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        BinaryPrimitives.WriteInt64BigEndian(bytes.AsSpan(24, 8), now)
        bytes, { Salt = bytes.AsSpan(0, 24).ToArray(); TimestampMs = now }

    let parsePreamble (bytes: ReadOnlySpan<byte>) : Result<Preamble, string> =
        if bytes.Length <> 32 then
            Error "Preamble must contain 32 bytes"
        else
            Ok { Salt = bytes.Slice(0, 24).ToArray()
                 TimestampMs = BinaryPrimitives.ReadInt64BigEndian(bytes.Slice(24, 8)) }

    /// Keep accepted salts for the complete validity interval. A full table rejects new sessions.
    type ReplayFilter(maxAgeMs: int64, ?maxEntries: int) =
        let capacity = defaultArg maxEntries 65536
        let gate = obj()
        let seen = HashSet<string>(StringComparer.Ordinal)
        let expiry = Queue<string * int64>()
        do
            if maxAgeMs < 1L || maxAgeMs > 86_400_000L then
                invalidArg "maxAgeMs" "Replay age must be between 1 ms and one day"
            if capacity < 1 then invalidArg "maxEntries" "Replay capacity must be positive"

        member _.Validate(preamble: Preamble) : bool =
            let now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            if isNull preamble.Salt || preamble.Salt.Length <> 24
               || preamble.TimestampMs < now - maxAgeMs
               || preamble.TimestampMs > now + maxAgeMs then
                false
            else
                lock gate (fun () ->
                    while expiry.Count > 0 && snd (expiry.Peek()) < now do
                        let salt, _ = expiry.Dequeue()
                        seen.Remove(salt) |> ignore
                    let salt = Convert.ToHexString(preamble.Salt)
                    if seen.Count >= capacity || not (seen.Add(salt)) then
                        false
                    else
                        expiry.Enqueue(salt, now + 2L * maxAgeMs)
                        true)

    type SessionKeys =
        { KeyC2S: byte[]
          KeyS2C: byte[] }

    let deriveSessionKeys (userKey: byte[]) (preambleBytes: byte[]) : SessionKeys =
        if isNull userKey || userKey.Length <> 32 then
            invalidArg "userKey" "User key must contain 32 bytes"
        if isNull preambleBytes || preambleBytes.Length <> 32 then
            invalidArg "preambleBytes" "Preamble must contain 32 bytes"
        let prk = HKDF.Extract(HashAlgorithmName.SHA256, userKey, preambleBytes)
        try
            { KeyC2S = HKDF.Expand(HashAlgorithmName.SHA256, prk, 32, InfoKeyC2S)
              KeyS2C = HKDF.Expand(HashAlgorithmName.SHA256, prk, 32, InfoKeyS2C) }
        finally
            CryptographicOperations.ZeroMemory(prk.AsSpan())

    let makeNonce (direction: byte[]) (sequence: uint64) : byte[] =
        if isNull direction || direction.Length <> 4 then
            invalidArg "direction" "Direction must contain four bytes"
        let nonce = Array.zeroCreate<byte> 12
        direction.CopyTo(nonce, 0)
        BinaryPrimitives.WriteUInt64BigEndian(nonce.AsSpan(4, 8), sequence)
        nonce

    let makeAad (preambleBytes: byte[]) (sequence: uint64) (lengthBytes: byte[]) : byte[] =
        if isNull preambleBytes || preambleBytes.Length <> 32 then
            invalidArg "preambleBytes" "Preamble must contain 32 bytes"
        if isNull lengthBytes || lengthBytes.Length <> 3 then
            invalidArg "lengthBytes" "Record length must contain three bytes"
        if sequence = 0UL then
            let aad = Array.zeroCreate<byte> 35
            preambleBytes.CopyTo(aad, 0)
            lengthBytes.CopyTo(aad, 32)
            aad
        else
            lengthBytes

    let sealChunk (aead: ChaCha20Poly1305) (direction: byte[]) (sequence: uint64)
                  (preambleBytes: byte[]) (plaintext: ReadOnlySpan<byte>) : byte[] =
        let length = plaintext.Length
        if length < 1 || length > MaxChunkBytes then
            invalidArg "plaintext" "Record length must be between 1 and 65536 bytes"
        let lengthBytes = [| byte (length >>> 16); byte (length >>> 8); byte length |]
        let bytes = Array.zeroCreate<byte> (3 + length + 16)
        lengthBytes.CopyTo(bytes, 0)
        let nonce = makeNonce direction sequence
        let aad = makeAad preambleBytes sequence lengthBytes
        aead.Encrypt(nonce, plaintext, bytes.AsSpan(3, length), bytes.AsSpan(3 + length, 16), aad)
        bytes

    let openChunk (aead: ChaCha20Poly1305) (direction: byte[]) (sequence: uint64)
                  (preambleBytes: byte[]) (lengthBytes: byte[])
                  (ciphertextWithTag: ReadOnlySpan<byte>) : Result<byte[], string> =
        if isNull lengthBytes || lengthBytes.Length <> 3 then
            Error "Record length must contain three bytes"
        elif isNull direction || direction.Length <> 4
             || isNull preambleBytes || preambleBytes.Length <> 32 then
            Error "Invalid record context"
        else
            let length = (int lengthBytes[0] <<< 16) ||| (int lengthBytes[1] <<< 8) ||| int lengthBytes[2]
            if length < 1 || length > MaxChunkBytes || ciphertextWithTag.Length <> length + 16 then
                Error "Invalid record length"
            else
                let plaintext = Array.zeroCreate<byte> length
                try
                    let nonce = makeNonce direction sequence
                    let aad = makeAad preambleBytes sequence lengthBytes
                    aead.Decrypt(nonce, ciphertextWithTag.Slice(0, length),
                                 ciphertextWithTag.Slice(length, 16), plaintext, aad)
                    Ok plaintext
                with :? CryptographicException ->
                    CryptographicOperations.ZeroMemory(plaintext.AsSpan())
                    Error "Record authentication failed"
