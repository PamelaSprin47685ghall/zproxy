namespace ZProxy

open System
open System.Buffers.Binary
open System.Collections.Concurrent
open System.Security.Cryptography
open System.Text
open Konscious.Security.Cryptography

module Crypto =

    let MasterDomainSalt = SHA256.HashData("zproxy-v1-master-salt"B) // 32 bytes
    let InfoKeyC2S = "zproxy-v1-key-c2s"B
    let InfoKeyS2C = "zproxy-v1-key-s2c"B
    let DirC2S = [| 0x43uy; 0x32uy; 0x53uy; 0x00uy |] // "C2S\0"
    let DirS2C = [| 0x53uy; 0x32uy; 0x43uy; 0x00uy |] // "S2C\0"

    /// Derive 32-byte master key from password using Argon2id (m = 64 MiB, t = 3, p = 1)
    let deriveMasterKey (password: string) : byte[] =
        let pwdBytes = Encoding.UTF8.GetBytes(password)
        use argon2 = new Argon2id(pwdBytes)
        argon2.Salt <- MasterDomainSalt
        argon2.DegreeOfParallelism <- 1
        argon2.Iterations <- 3
        argon2.MemorySize <- 65536 // 64 MiB in KiB
        argon2.GetBytes(32)

    /// 32-byte connection preamble: 24-byte random salt + 8-byte Unix timestamp ms (BE)
    [<Struct>]
    type Preamble =
        { Salt: byte[]
          TimestampMs: int64 }

    let createPreamble () : byte[] * Preamble =
        let buf = Array.zeroCreate<byte> 32
        RandomNumberGenerator.Fill(Span<byte>(buf, 0, 24))
        let nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        BinaryPrimitives.WriteInt64BigEndian(Span<byte>(buf, 24, 8), nowMs)
        let salt = Array.zeroCreate<byte> 24
        Array.Copy(buf, 0, salt, 0, 24)
        buf, { Salt = salt; TimestampMs = nowMs }

    let parsePreamble (buf: ReadOnlySpan<byte>) : Result<Preamble, string> =
        if buf.Length < 32 then
            Error "Preamble too short"
        else
            let salt = buf.Slice(0, 24).ToArray()
            let ts = BinaryPrimitives.ReadInt64BigEndian(buf.Slice(24, 8))
            Ok { Salt = salt; TimestampMs = ts }

    /// Replay protection tracker
    type ReplayFilter(maxAgeMs: int64) =
        let seen = ConcurrentDictionary<string, int64>()
        let mutable lastPrune = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()

        member this.Validate(preamble: Preamble) : bool =
            let now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            if abs (now - preamble.TimestampMs) > maxAgeMs then
                false
            else
                let key = Convert.ToHexString(preamble.Salt)
                if not (seen.TryAdd(key, preamble.TimestampMs)) then
                    false
                else
                    if now - lastPrune > (maxAgeMs * 2L) then
                        lastPrune <- now
                        let cutoff = now - maxAgeMs
                        for kv in seen do
                            if kv.Value < cutoff then
                                seen.TryRemove(kv.Key) |> ignore
                    true

    /// Session directional keys
    type SessionKeys =
        { KeyC2S: byte[]
          KeyS2C: byte[] }

    let deriveSessionKeys (masterKey: byte[]) (preambleBytes: byte[]) : SessionKeys =
        let prk = HKDF.Extract(HashAlgorithmName.SHA256, masterKey, preambleBytes)
        let keyC2S = Array.zeroCreate<byte> 32
        let keyS2C = Array.zeroCreate<byte> 32
        HKDF.Expand(HashAlgorithmName.SHA256, prk, keyC2S, InfoKeyC2S)
        HKDF.Expand(HashAlgorithmName.SHA256, prk, keyS2C, InfoKeyS2C)
        { KeyC2S = keyC2S; KeyS2C = keyS2C }

    /// Build 12-byte nonce: 4-byte direction + 8-byte big-endian sequence
    let makeNonce (dir: byte[]) (seq: uint64) : byte[] =
        let nonce = Array.zeroCreate<byte> 12
        Array.Copy(dir, 0, nonce, 0, 4)
        BinaryPrimitives.WriteUInt64BigEndian(Span<byte>(nonce, 4, 8), seq)
        nonce

    /// Compute specification AAD: For chunk 0: Preamble (32B) || PlaintextLen (3B BE); For chunk >0: PlaintextLen (3B BE)
    let makeAad (preambleBytes: byte[]) (seq: uint64) (lenBytes: byte[]) : byte[] =
        if seq = 0UL then
            let aad = Array.zeroCreate<byte> (32 + 3)
            Array.Copy(preambleBytes, 0, aad, 0, 32)
            Array.Copy(lenBytes, 0, aad, 32, 3)
            aad
        else
            lenBytes

    /// Seal chunk: [PlaintextLen (3B BE)][Ciphertext][Poly1305 Tag (16B)]
    let sealChunk (aead: ChaCha20Poly1305) (dir: byte[]) (seq: uint64) (preambleBytes: byte[]) (plaintext: ReadOnlySpan<byte>) : byte[] =
        let len = plaintext.Length
        if len > 65536 then invalidArg "plaintext" "Chunk exceeds 64 KiB"
        let lenBytes = [| byte ((len >>> 16) &&& 0xFF); byte ((len >>> 8) &&& 0xFF); byte (len &&& 0xFF) |]
        let outBuf = Array.zeroCreate<byte> (3 + len + 16)
        Array.Copy(lenBytes, 0, outBuf, 0, 3)

        let nonce = makeNonce dir seq
        let aad = makeAad preambleBytes seq lenBytes
        let ctSpan = Span<byte>(outBuf, 3, len)
        let tagSpan = Span<byte>(outBuf, 3 + len, 16)
        aead.Encrypt(ReadOnlySpan<byte>(nonce), plaintext, ctSpan, tagSpan, ReadOnlySpan<byte>(aad))
        outBuf

    /// Open chunk
    let openChunk (aead: ChaCha20Poly1305) (dir: byte[]) (seq: uint64) (preambleBytes: byte[]) (lenBytes: byte[]) (ciphertextWithTag: ReadOnlySpan<byte>) : Result<byte[], string> =
        if ciphertextWithTag.Length < 16 then
            Error "Ciphertext too short for AEAD tag"
        else
            let ptLen = ciphertextWithTag.Length - 16
            let ct = ciphertextWithTag.Slice(0, ptLen)
            let tag = ciphertextWithTag.Slice(ptLen, 16)
            let nonce = makeNonce dir seq
            let aad = makeAad preambleBytes seq lenBytes
            let plaintext = Array.zeroCreate<byte> ptLen
            try
                aead.Decrypt(ReadOnlySpan<byte>(nonce), ct, tag, Span<byte>(plaintext), ReadOnlySpan<byte>(aad))
                Ok plaintext
            with _ ->
                Error "AEAD tag verification failed"