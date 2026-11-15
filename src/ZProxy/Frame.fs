namespace ZProxy

open System
open System.Buffers.Binary
open System.IO
open System.Text

module Frame =

    type FrameType =
        | OpenRequest = 0x01uy
        | ResponseHeaders = 0x02uy
        | Data = 0x03uy
        | EndStream = 0x04uy
        | CancelStream = 0x05uy
        | Ping = 0x06uy
        | Pong = 0x07uy

    [<Flags>]
    type FrameFlags =
        | None = 0x00uy
        | EndStream = 0x01uy

    type HeaderPair = string * string

    type Frame =
        | OpenRequest of streamId: uint32 * method: string * targetUrl: string * headers: HeaderPair list * hasEndStream: bool
        | ResponseHeaders of streamId: uint32 * statusCode: int * headers: HeaderPair list * hasEndStream: bool
        | Data of streamId: uint32 * payload: byte[] * hasEndStream: bool
        | EndStream of streamId: uint32
        | CancelStream of streamId: uint32 * reason: string
        | Ping of payload: byte[]
        | Pong of payload: byte[]

    let private writeStringWithLen16 (bw: BinaryWriter) (s: string) =
        let bytes = Encoding.UTF8.GetBytes(s)
        let lenBuf = Array.zeroCreate<byte> 2
        BinaryPrimitives.WriteUInt16BigEndian(Span<byte>(lenBuf), uint16 bytes.Length)
        bw.Write(lenBuf)
        bw.Write(bytes)

    let private readStringWithLen16 (br: BinaryReader) : string =
        let lenBytes = br.ReadBytes(2)
        let len = int (BinaryPrimitives.ReadUInt16BigEndian(ReadOnlySpan<byte>(lenBytes)))
        let strBytes = br.ReadBytes(len)
        Encoding.UTF8.GetString(strBytes)

    let private writeHeaders (bw: BinaryWriter) (headers: HeaderPair list) =
        let countBuf = Array.zeroCreate<byte> 2
        BinaryPrimitives.WriteUInt16BigEndian(Span<byte>(countBuf), uint16 headers.Length)
        bw.Write(countBuf)
        for (k, v) in headers do
            writeStringWithLen16 bw k
            writeStringWithLen16 bw v

    let private readHeaders (br: BinaryReader) : HeaderPair list =
        let countBytes = br.ReadBytes(2)
        let count = int (BinaryPrimitives.ReadUInt16BigEndian(ReadOnlySpan<byte>(countBytes)))
        let mutable acc = []
        for _ in 1 .. count do
            let k = readStringWithLen16 br
            let v = readStringWithLen16 br
            acc <- (k, v) :: acc
        List.rev acc

    /// Encode logical Frame into [8-byte header][Payload]
    let encode (frame: Frame) : byte[] =
        use ms = new MemoryStream()
        use bw = new BinaryWriter(ms, Encoding.UTF8, leaveOpen = true)
        ms.Position <- 8L

        let mutable streamId = 0u
        let mutable fType = FrameType.OpenRequest
        let mutable flags = FrameFlags.None

        match frame with
        | Frame.OpenRequest (sid, m, url, hdrs, es) ->
            streamId <- sid
            fType <- FrameType.OpenRequest
            if es then flags <- flags ||| FrameFlags.EndStream
            bw.Write(byte m.Length)
            let mBytes = Encoding.UTF8.GetBytes(m)
            bw.Write(mBytes)
            writeStringWithLen16 bw url
            writeHeaders bw hdrs

        | Frame.ResponseHeaders (sid, status, hdrs, es) ->
            streamId <- sid
            fType <- FrameType.ResponseHeaders
            if es then flags <- flags ||| FrameFlags.EndStream
            let statusBuf = Array.zeroCreate<byte> 2
            BinaryPrimitives.WriteUInt16BigEndian(Span<byte>(statusBuf), uint16 status)
            bw.Write(statusBuf)
            writeHeaders bw hdrs

        | Frame.Data (sid, payload, es) ->
            streamId <- sid
            fType <- FrameType.Data
            if es then flags <- flags ||| FrameFlags.EndStream
            bw.Write(payload)

        | Frame.EndStream sid ->
            streamId <- sid
            fType <- FrameType.EndStream

        | Frame.CancelStream (sid, reason) ->
            streamId <- sid
            fType <- FrameType.CancelStream
            writeStringWithLen16 bw reason

        | Frame.Ping p ->
            streamId <- 0u
            fType <- FrameType.Ping
            bw.Write(p)

        | Frame.Pong p ->
            streamId <- 0u
            fType <- FrameType.Pong
            bw.Write(p)

        bw.Flush()
        let payloadLen = int (ms.Length - 8L)
        if payloadLen > 65535 then failwith "Frame payload exceeds 65535 bytes"

        let buf = ms.ToArray()
        BinaryPrimitives.WriteUInt32BigEndian(Span<byte>(buf, 0, 4), streamId)
        buf.[4] <- LanguagePrimitives.EnumToValue fType
        buf.[5] <- LanguagePrimitives.EnumToValue flags
        BinaryPrimitives.WriteUInt16BigEndian(Span<byte>(buf, 6, 2), uint16 payloadLen)
        buf

    /// Decode logical Frame from raw bytes
    let decode (bytes: byte[]) : Result<Frame, string> =
        if bytes.Length < 8 then
            Error "Header too short"
        else
            let streamId = BinaryPrimitives.ReadUInt32BigEndian(ReadOnlySpan<byte>(bytes, 0, 4))
            let fType : FrameType = LanguagePrimitives.EnumOfValue bytes.[4]
            let flags : FrameFlags = LanguagePrimitives.EnumOfValue bytes.[5]
            let hasEndStream = (flags &&& FrameFlags.EndStream) <> FrameFlags.None
            let payloadLen = int (BinaryPrimitives.ReadUInt16BigEndian(ReadOnlySpan<byte>(bytes, 6, 2)))
            if bytes.Length < 8 + payloadLen then
                Error "Payload truncated"
            else
                use ms = new MemoryStream(bytes, 8, payloadLen, writable = false)
                use br = new BinaryReader(ms, Encoding.UTF8, leaveOpen = true)
                match fType with
                | FrameType.OpenRequest ->
                    if payloadLen < 1 then Error "Empty OpenRequest payload"
                    else
                        let mLen = int (br.ReadByte())
                        let mBytes = br.ReadBytes(mLen)
                        let method = Encoding.UTF8.GetString(mBytes)
                        let url = readStringWithLen16 br
                        let headers = readHeaders br
                        Ok (Frame.OpenRequest (streamId, method, url, headers, hasEndStream))

                | FrameType.ResponseHeaders ->
                    if payloadLen < 2 then Error "Empty ResponseHeaders payload"
                    else
                        let statusBytes = br.ReadBytes(2)
                        let status = int (BinaryPrimitives.ReadUInt16BigEndian(ReadOnlySpan<byte>(statusBytes)))
                        let headers = readHeaders br
                        Ok (Frame.ResponseHeaders (streamId, status, headers, hasEndStream))

                | FrameType.Data ->
                    let data = br.ReadBytes(payloadLen)
                    Ok (Frame.Data (streamId, data, hasEndStream))

                | FrameType.EndStream ->
                    Ok (Frame.EndStream streamId)

                | FrameType.CancelStream ->
                    let reason = readStringWithLen16 br
                    Ok (Frame.CancelStream (streamId, reason))

                | FrameType.Ping ->
                    let p = br.ReadBytes(payloadLen)
                    Ok (Frame.Ping p)

                | FrameType.Pong ->
                    let p = br.ReadBytes(payloadLen)
                    Ok (Frame.Pong p)

                | _ ->
                    Error (sprintf "Unknown frame type: %d" (int fType))