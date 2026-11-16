namespace ZProxy

open System
open System.Buffers.Binary
open System.IO
open System.Text

module Frame =

    [<Literal>]
    let MaxDataBytes = 16384
    [<Literal>]
    let MaxPayloadBytes = 32768
    [<Literal>]
    let MaxHeaderCount = 128

    type FrameType =
        | OpenRequest = 0x01uy
        | ResponseHeaders = 0x02uy
        | Data = 0x03uy
        | EndStream = 0x04uy
        | CancelStream = 0x05uy
        | Ping = 0x06uy
        | Pong = 0x07uy
        | WindowUpdate = 0x08uy

    [<Flags>]
    type FrameFlags =
        | None = 0x00uy
        | EndStream = 0x01uy

    type HeaderPair = string * string

    type Frame =
        | OpenRequest of streamId: uint32 * method: string * targetUrl: string * headers: HeaderPair list * hasEndStream: bool
        | ResponseHeaders of streamId: uint32 * statusCode: int * protoVersion: byte * headers: HeaderPair list * metadata: Contracts.DecodeMetadata * hasEndStream: bool
        | Data of streamId: uint32 * payload: byte[] * hasEndStream: bool
        | EndStream of streamId: uint32
        | CancelStream of streamId: uint32 * reason: string
        | Ping of payload: byte[]
        | Pong of payload: byte[]
        | WindowUpdate of streamId: uint32 * credit: int

    let private utf8 = UTF8Encoding(false, true)

    let private require condition message =
        if not condition then raise (InvalidDataException(message))

    let private token (text: string) =
        not (String.IsNullOrEmpty(text))
        && (text |> Seq.forall (fun c ->
            (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
            || "!#$%&'*+-.^_`|~".IndexOf(c) >= 0))

    let private textLength (text: string) =
        require (not (isNull text)) "Text must not be null"
        let length = utf8.GetByteCount(text)
        require (length <= MaxPayloadBytes) "Text exceeds the frame limit"
        length

    let private headerLength (headers: HeaderPair list) =
        require (not (isNull (box headers)) && headers.Length <= MaxHeaderCount) "Too many headers"
        let mutable length = 2
        for name, value in headers do
            require (token name) "Invalid header name"
            require (not (isNull value) && (value |> Seq.forall (fun c -> c = '\t' || (c >= ' ' && c <> '\u007f'))))
                "Invalid header value"
            length <- length + 4 + textLength name + textLength value
            require (length <= MaxPayloadBytes) "Headers exceed the frame limit"
        length

    let private metadataLength (metadata: Contracts.DecodeMetadata) =
        require (not (isNull (box metadata))) "Missing response metadata"
        require (token metadata.Decoder && metadata.Decoder.Length <= 64) "Invalid response decoder"
        require (metadata.Version >= 1 && metadata.Version <= 65535) "Invalid decoder version"
        require (metadata.Attempt >= 1 && metadata.Attempt <= 65535) "Invalid response attempt"
        let boundedText limit (value: string) =
            let length = textLength value
            require (length <= limit && (value |> Seq.forall (Char.IsControl >> not))) "Invalid response metadata text"
            length
        12 + boundedText 64 metadata.Decoder + boundedText 128 metadata.ModelAlias + boundedText 64 metadata.RequestId

    let private validate (frame: Frame) =
        let streamId, kind, flags, length =
            match frame with
            | OpenRequest(id, method, target, headers, ended) ->
                require (token method && method.Length <= 255) "Invalid HTTP method"
                require (not (String.IsNullOrEmpty(target)) && (target |> Seq.forall (fun c -> c > ' ' && c <> '\u007f')))
                    "Invalid target URL"
                id, FrameType.OpenRequest, ended, 1 + textLength method + 2 + textLength target + headerLength headers
            | ResponseHeaders(id, status, protocol, headers, metadata, ended) ->
                require (status >= 100 && status <= 599) "Invalid response status"
                require (protocol = 1uy || protocol = 2uy || protocol = 3uy) "Invalid HTTP version"
                id, FrameType.ResponseHeaders, ended, 3 + headerLength headers + metadataLength metadata
            | Data(id, payload, ended) ->
                require (not (isNull payload) && payload.Length >= 1 && payload.Length <= MaxDataBytes)
                    "Data length must be between 1 and 16384 bytes"
                id, FrameType.Data, ended, payload.Length
            | EndStream id -> id, FrameType.EndStream, false, 0
            | CancelStream(id, reason) ->
                let length = textLength reason
                require (length <= 1024) "Cancel reason exceeds 1024 bytes"
                id, FrameType.CancelStream, false, 2 + length
            | Ping payload | Pong payload ->
                require (not (isNull payload) && payload.Length = 8) "Heartbeat must contain eight bytes"
                let kind = match frame with Ping _ -> FrameType.Ping | _ -> FrameType.Pong
                0u, kind, false, 8
            | WindowUpdate(id, credit) ->
                require (credit > 0) "Window credit must be positive"
                id, FrameType.WindowUpdate, false, 4
        match frame with
        | Ping _ | Pong _ -> ()
        | _ -> require (streamId > 0u && (streamId &&& 1u) = 1u) "Stream ID must be a nonzero odd number"
        require (length <= MaxPayloadBytes) "Payload exceeds 32768 bytes"
        streamId, kind, flags, length

    let encode (frame: Frame) : byte[] =
        let id, kind, ended, length = validate frame
        let bytes = Array.zeroCreate<byte> (8 + length)
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(0, 4), id)
        bytes[4] <- LanguagePrimitives.EnumToValue kind
        bytes[5] <- if ended then 1uy else 0uy
        BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(6, 2), uint16 length)
        let mutable offset = 8
        let writeByte value =
            bytes[offset] <- value
            offset <- offset + 1
        let write16 value =
            BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(offset, 2), uint16 value)
            offset <- offset + 2
        let writeText (text: string) =
            let length = utf8.GetByteCount(text)
            write16 length
            offset <- offset + utf8.GetBytes(text, 0, text.Length, bytes, offset)
        let writeHeaders headers =
            write16 (List.length headers)
            for name, value in headers do
                writeText name
                writeText value
        match frame with
        | OpenRequest(_, method, target, headers, _) ->
            writeByte (byte method.Length)
            offset <- offset + utf8.GetBytes(method, 0, method.Length, bytes, offset)
            writeText target
            writeHeaders headers
        | ResponseHeaders(_, status, protocol, headers, metadata, _) ->
            write16 status
            writeByte protocol
            writeHeaders headers
            writeByte 1uy
            writeText metadata.Decoder
            write16 metadata.Version
            writeText metadata.ModelAlias
            writeText metadata.RequestId
            write16 metadata.Attempt
            writeByte (if metadata.IsStreaming then 1uy else 0uy)
        | Data(_, payload, _) | Ping payload | Pong payload -> payload.CopyTo(bytes, offset)
        | EndStream _ -> ()
        | CancelStream(_, reason) -> writeText reason
        | WindowUpdate(_, credit) -> BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(offset, 4), uint32 credit)
        bytes

    type private Reader(bytes: byte[]) =
        let mutable offset = 8
        member private _.Take(count: int) =
            require (count >= 0 && count <= bytes.Length - offset) "Truncated frame field"
            let start = offset
            offset <- offset + count
            start
        member this.Byte() = bytes[this.Take(1)]
        member this.UInt16() = int (BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(this.Take(2), 2)))
        member this.UInt32() = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(this.Take(4), 4))
        member this.Text(count: int) = utf8.GetString(bytes, this.Take(count), count)
        member this.Text16() = this.Text(this.UInt16())
        member this.BoundedText16(limit: int) =
            let count = this.UInt16()
            require (count <= limit) "Response metadata exceeds its field limit"
            this.Text(count)
        member this.Bytes(count: int) = bytes.AsSpan(this.Take(count), count).ToArray()
        member this.Headers() =
            let count = this.UInt16()
            require (count <= MaxHeaderCount) "Too many headers"
            [ for _ in 1 .. count do
                let name = this.Text16()
                let value = this.Text16()
                yield name, value ]
        member this.Metadata() : Contracts.DecodeMetadata =
            require (this.Byte() = 1uy) "Unsupported response metadata schema"
            let decoder = this.BoundedText16(64)
            let version = this.UInt16()
            let modelAlias = this.BoundedText16(128)
            let requestId = this.BoundedText16(64)
            let attempt = this.UInt16()
            let streaming = this.Byte()
            require (streaming <= 1uy) "Invalid response streaming flag"
            { Decoder = decoder; Version = version; ModelAlias = modelAlias
              RequestId = requestId; Attempt = attempt; IsStreaming = streaming = 1uy }
        member _.Finish() = require (offset = bytes.Length) "Trailing frame data"

    let decode (bytes: byte[]) : Result<Frame, string> =
        try
            require (not (isNull bytes) && bytes.Length >= 8) "Truncated frame header"
            let id = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(0, 4))
            let kind = bytes[4]
            let flags = bytes[5]
            let length = int (BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(6, 2)))
            require (length <= MaxPayloadBytes && bytes.Length = 8 + length) "Invalid frame length"
            require ((flags &&& 0xfeuy) = 0uy) "Unknown frame flags"
            require (flags = 0uy || kind = 1uy || kind = 2uy || kind = 3uy) "Unexpected end flag"
            let ended = flags = 1uy
            let reader = Reader(bytes)
            let frame =
                match kind with
                | 1uy ->
                    let method = reader.Text(int (reader.Byte()))
                    let target = reader.Text16()
                    OpenRequest(id, method, target, reader.Headers(), ended)
                | 2uy ->
                    let status = reader.UInt16()
                    let protocol = reader.Byte()
                    let headers = reader.Headers()
                    ResponseHeaders(id, status, protocol, headers, reader.Metadata(), ended)
                | 3uy -> Data(id, reader.Bytes(length), ended)
                | 4uy -> EndStream id
                | 5uy -> CancelStream(id, reader.Text16())
                | 6uy | 7uy ->
                    require (id = 0u) "Heartbeat stream ID must be zero"
                    let payload = reader.Bytes(length)
                    if kind = 6uy then Ping payload else Pong payload
                | 8uy ->
                    let credit = reader.UInt32()
                    require (credit <= uint32 Int32.MaxValue) "Window credit exceeds the limit"
                    WindowUpdate(id, int credit)
                | _ -> raise (InvalidDataException("Unknown frame type"))
            reader.Finish()
            validate frame |> ignore
            Ok frame
        with
        | :? InvalidDataException as error -> Error error.Message
        | :? ArgumentException -> Error "Invalid UTF-8 field"
