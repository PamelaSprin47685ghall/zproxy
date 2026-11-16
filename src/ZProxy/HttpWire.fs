namespace ZProxy

open System
open System.Globalization
open System.IO
open System.Text
open System.Threading
open System.Threading.Tasks

/// HTTP framing for one request and one response on a duplex stream.
module HttpWire =
    [<Literal>]
    let private MaxHeadBytes = 32 * 1024

    [<Literal>]
    let private MaxLineBytes = 8 * 1024

    [<Literal>]
    let private MaxFields = 128

    type Head =
        { StartLine: string
          Headers: (string * string) list }

    let private invalid message = raise (InvalidDataException(message))

    let private isToken (c: char) =
        Char.IsAsciiLetterOrDigit(c) || "!#$%&'*+-.^_`|~".Contains(c)

    let private validateField (name: string, value: string) =
        if String.IsNullOrEmpty(name) || not (Seq.forall isToken name) then
            invalid "Invalid HTTP field name."

        if isNull value || (value |> Seq.exists (fun c -> c <> '\t' && (c < ' ' || c = '\u007f' || c > '\u00ff'))) then
            invalid "Invalid HTTP field value."

    let private validateFraming fields =
        let count name =
            fields
            |> List.filter (fun (key: string, _) -> key.Equals(name, StringComparison.OrdinalIgnoreCase))
            |> List.length

        let lengths = count "Content-Length"

        if lengths > 1 || (lengths > 0 && count "Transfer-Encoding" > 0) then
            invalid "Ambiguous HTTP body framing."

    let private parseField (line: string) =
        let colon = line.IndexOf(':')

        if colon <= 0 then
            invalid "Invalid HTTP field line."

        let field = line.Substring(0, colon), line.Substring(colon + 1).Trim(' ', '\t')
        validateField field
        field

    let private validateStartLine (line: string) =
        if String.IsNullOrEmpty(line) || (line |> Seq.exists (fun c -> c < ' ' || c > '~')) then
            invalid "Invalid HTTP start line."

    let private encodeHead (head: Head) =
        validateStartLine head.StartLine

        if head.StartLine.Length > MaxLineBytes || head.Headers.Length > MaxFields then
            invalid "HTTP head limit exceeded."

        validateFraming head.Headers
        let text = StringBuilder(head.StartLine).Append("\r\n")

        for name, value in head.Headers do
            validateField (name, value)

            if name.Length + value.Length + 2 > MaxLineBytes then
                invalid "HTTP field line limit exceeded."

            text.Append(name).Append(": ").Append(value).Append("\r\n") |> ignore

            if text.Length + 2 > MaxHeadBytes then
                invalid "HTTP head limit exceeded."

        text.Append("\r\n") |> ignore
        Encoding.Latin1.GetBytes(text.ToString())

    // The same reader owns head bytes and body bytes.
    type private Reader(stream: Stream) =
        let buffer = Array.zeroCreate<byte> MaxLineBytes
        let line = Array.zeroCreate<byte> MaxLineBytes
        let mutable offset = 0
        let mutable count = 0

        member _.ReadLineAsync(ct: CancellationToken) = task {
            ct.ThrowIfCancellationRequested()
            let mutable length = 0
            let mutable carriageReturn = false
            let mutable complete = false

            while not complete do
                if offset = count then
                    let! received = stream.ReadAsync(buffer.AsMemory(), ct)

                    if received = 0 then
                        raise (EndOfStreamException("HTTP line is incomplete."))

                    offset <- 0
                    count <- received

                while offset < count && not complete do
                    let value = buffer.[offset]
                    offset <- offset + 1

                    if carriageReturn then
                        if value <> 10uy then
                            invalid "HTTP lines must end with CRLF."

                        complete <- true
                    elif value = 13uy then
                        carriageReturn <- true
                    elif value = 10uy then
                        invalid "HTTP lines must end with CRLF."
                    else
                        if length = MaxLineBytes then
                            invalid "HTTP line limit exceeded."

                        line.[length] <- value
                        length <- length + 1

            return Encoding.Latin1.GetString(line, 0, length)
        }

        member _.ReadAsync(target: Memory<byte>, ct: CancellationToken) = task {
            ct.ThrowIfCancellationRequested()

            if offset < count then
                let size = min target.Length (count - offset)
                buffer.AsMemory(offset, size).CopyTo(target)
                offset <- offset + size
                return size
            else
                return! stream.ReadAsync(target, ct).AsTask()
        }

    let private readFields (reader: Reader) initialSize (ct: CancellationToken) = task {
        let fields = ResizeArray<string * string>()
        let mutable size = initialSize
        let mutable complete = false

        while not complete do
            let! line = reader.ReadLineAsync(ct)
            size <- size + line.Length + 2

            if size > MaxHeadBytes then
                invalid "HTTP head limit exceeded."

            if line.Length = 0 then
                complete <- true
            else
                if fields.Count = MaxFields then
                    invalid "HTTP field count limit exceeded."

                fields.Add(parseField line)

        let result = List.ofSeq fields
        validateFraming result
        return result
    }

    let private chunkSize (line: string) =
        let mutable index = 0
        let mutable size = 0L
        let mutable readingSize = true

        while index < line.Length && readingSize do
            let c = line.[index]
            let digit =
                if c >= '0' && c <= '9' then int c - int '0'
                elif c >= 'a' && c <= 'f' then int c - int 'a' + 10
                elif c >= 'A' && c <= 'F' then int c - int 'A' + 10
                else -1

            if digit < 0 then
                readingSize <- false
            else
                if size > (Int64.MaxValue - int64 digit) / 16L then
                    invalid "HTTP chunk size is too large."

                size <- size * 16L + int64 digit
                index <- index + 1

        if index = 0 then
            invalid "Invalid HTTP chunk size."

        let skipSpace () =
            while index < line.Length && (line.[index] = ' ' || line.[index] = '\t') do
                index <- index + 1

        let readToken () =
            let start = index

            while index < line.Length && isToken line.[index] do
                index <- index + 1

            if index = start then
                invalid "Invalid HTTP chunk extension."

        while index < line.Length do
            skipSpace ()

            if index = line.Length || line.[index] <> ';' then
                invalid "Invalid HTTP chunk extension."

            index <- index + 1
            skipSpace ()
            readToken ()
            skipSpace ()

            if index < line.Length && line.[index] = '=' then
                index <- index + 1
                skipSpace ()

                if index < line.Length && line.[index] = '"' then
                    index <- index + 1
                    let mutable closed = false

                    while index < line.Length && not closed do
                        let c = line.[index]
                        index <- index + 1

                        if c = '"' then
                            closed <- true
                        else
                            let mutable value = c

                            if c = '\\' then
                                if index = line.Length then
                                    invalid "Invalid HTTP chunk extension."

                                value <- line.[index]
                                index <- index + 1

                            if value <> '\t' && (value < ' ' || value = '\u007f') then
                                invalid "Invalid HTTP chunk extension."

                    if not closed then
                        invalid "Invalid HTTP chunk extension."
                else
                    readToken ()

        size

    type Connection(stream: Stream, ?leaveOpen: bool) =
        let leaveOpen = defaultArg leaveOpen false
        let reader = Reader(stream)
        let writeGate = new SemaphoreSlim(1, 1)
        let lineEnd = "\r\n"B
        let bodyEnd = "0\r\n\r\n"B
        let mutable disposed = 0
        let mutable headRead = false
        let mutable headWritten = false
        let mutable readEnded = false
        let mutable writeEnded = false
        let mutable remaining = 0L
        let mutable needLineEnd = false

        let ensureOpen () =
            ObjectDisposedException.ThrowIf(Volatile.Read(&disposed) <> 0, stream)

        let close () =
            if Interlocked.Exchange(&disposed, 1) = 0 && not leaveOpen then
                stream.Dispose()

        let readBody (target: Memory<byte>) (ct: CancellationToken) = task {
            ensureOpen ()
            ct.ThrowIfCancellationRequested()

            if not headRead then
                invalidOp "Read the HTTP head before its body."

            if target.Length = 0 || readEnded then
                return 0
            else
                if remaining = 0L then
                    if needLineEnd then
                        let! line = reader.ReadLineAsync(ct)

                        if line.Length <> 0 then
                            invalid "Invalid HTTP chunk terminator."

                        needLineEnd <- false

                    let! line = reader.ReadLineAsync(ct)
                    remaining <- chunkSize line

                    if remaining = 0L then
                        let! trailers = readFields reader 0 ct

                        for name, _ in trailers do
                            if List.exists (fun field -> name.Equals(field, StringComparison.OrdinalIgnoreCase))
                                [ "Content-Length"; "Transfer-Encoding"; "Host"; "Connection"; "Trailer"; "Upgrade" ] then
                                invalid "Invalid HTTP trailer field."

                        readEnded <- true

                if readEnded then
                    return 0
                else
                    let size = int (min (int64 target.Length) remaining)
                    let! received = reader.ReadAsync(target.Slice(0, size), ct)

                    if received = 0 then
                        raise (EndOfStreamException("HTTP chunk is incomplete."))

                    remaining <- remaining - int64 received
                    needLineEnd <- remaining = 0L
                    return received
        }

        let writeBody (source: ReadOnlyMemory<byte>) (ct: CancellationToken) = task {
            ensureOpen ()
            do! writeGate.WaitAsync(ct)

            try
                ensureOpen ()

                if not headWritten then
                    invalidOp "Write the HTTP head before its body."

                if writeEnded then
                    invalidOp "The HTTP body is complete."

                if source.Length > 0 then
                    let prefix = Encoding.ASCII.GetBytes(source.Length.ToString("X", CultureInfo.InvariantCulture) + "\r\n")
                    do! stream.WriteAsync(prefix.AsMemory(), ct)
                    do! stream.WriteAsync(source, ct)
                    do! stream.WriteAsync(lineEnd.AsMemory(), ct)
            finally
                writeGate.Release() |> ignore
        }

        let flush (ct: CancellationToken) = task {
            ensureOpen ()
            do! writeGate.WaitAsync(ct)

            try
                ensureOpen ()
                do! stream.FlushAsync(ct)
            finally
                writeGate.Release() |> ignore
        }

        let body =
            { new Stream() with
                override _.CanRead = Volatile.Read(&disposed) = 0
                override _.CanSeek = false
                override _.CanWrite = Volatile.Read(&disposed) = 0 && not writeEnded
                override _.Length = raise (NotSupportedException())
                override _.Position
                    with get () = raise (NotSupportedException())
                    and set _ = raise (NotSupportedException())
                override _.Seek(_, _) = raise (NotSupportedException())
                override _.SetLength(_) = raise (NotSupportedException())
                override _.Read(buffer, offset, count) =
                    (readBody (Memory<byte>(buffer, offset, count)) CancellationToken.None).GetAwaiter().GetResult()
                override _.ReadAsync(buffer: Memory<byte>, ct) =
                    ValueTask<int>(readBody buffer ct)
                override _.ReadAsync(buffer, offset, count, ct) =
                    readBody (Memory<byte>(buffer, offset, count)) ct
                override _.Write(buffer, offset, count) =
                    (writeBody (ReadOnlyMemory<byte>(buffer, offset, count)) CancellationToken.None).GetAwaiter().GetResult()
                override _.WriteAsync(buffer: ReadOnlyMemory<byte>, ct) =
                    ValueTask(writeBody buffer ct)
                override _.WriteAsync(buffer, offset, count, ct) =
                    writeBody (ReadOnlyMemory<byte>(buffer, offset, count)) ct :> Task
                override _.Flush() = (flush CancellationToken.None).GetAwaiter().GetResult()
                override _.FlushAsync(ct) = flush ct :> Task
                override _.Dispose(disposing) =
                    if disposing then close () }

        member _.ReadHeadAsync(ct: CancellationToken) = task {
            ensureOpen ()

            if headRead then
                invalidOp "The HTTP head was already read."

            let! startLine = reader.ReadLineAsync(ct)
            validateStartLine startLine
            let! fields = readFields reader (startLine.Length + 2) ct
            headRead <- true
            return { StartLine = startLine; Headers = fields }
        }

        member _.WriteHeadAsync(head: Head, ct: CancellationToken) : Task = task {
            ensureOpen ()
            let bytes = encodeHead head
            do! writeGate.WaitAsync(ct)

            try
                ensureOpen ()

                if headWritten then
                    invalidOp "The HTTP head was already written."

                headWritten <- true
                do! stream.WriteAsync(bytes.AsMemory(), ct)
                do! stream.FlushAsync(ct)
            finally
                writeGate.Release() |> ignore
        }

        member _.Body: Stream = body

        member _.CompleteWritesAsync(ct: CancellationToken) : Task = task {
            ensureOpen ()
            do! writeGate.WaitAsync(ct)

            try
                ensureOpen ()

                if not headWritten then
                    invalidOp "Write the HTTP head before its body."

                if not writeEnded then
                    writeEnded <- true
                    do! stream.WriteAsync(bodyEnd.AsMemory(), ct)
                    do! stream.FlushAsync(ct)
            finally
                writeGate.Release() |> ignore
        }

        interface IDisposable with
            member _.Dispose() = close ()
