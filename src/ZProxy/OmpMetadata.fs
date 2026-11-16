namespace ZProxy

open System
open System.Buffers.Binary
open System.IO
open System.Net.Http
open System.Text
open System.Text.Json
open System.Threading

/// The plugin boundary accepts a decoding recipe, never a provider account object.
module OmpMetadata =
    let private fail () = raise (InvalidDataException("Invalid OMP decoding metadata."))

    let private fields required allowed (value: JsonElement) =
        if value.ValueKind <> JsonValueKind.Object then fail ()
        let names = Collections.Generic.HashSet<string>(StringComparer.Ordinal)
        for property in value.EnumerateObject() do
            if not (List.contains property.Name allowed) || not (names.Add(property.Name)) then fail ()
        if required |> List.exists (names.Contains >> not) then fail ()

    let private text limit (value: JsonElement) =
        if value.ValueKind <> JsonValueKind.String then fail ()
        let result = value.GetString()
        if Encoding.UTF8.GetByteCount(result) > limit || Seq.exists Char.IsControl result then fail ()
        result

    let private positive maximum (value: JsonElement) =
        match value.TryGetInt32() with
        | true, number when number >= 1 && number <= maximum -> number
        | _ -> fail ()

    let private boolean (value: JsonElement) =
        if value.ValueKind <> JsonValueKind.True && value.ValueKind <> JsonValueKind.False then fail ()
        value.GetBoolean()

    let validateRecipe (recipe: string) =
        if isNull recipe || Encoding.UTF8.GetByteCount(recipe) > 8192 then fail ()
        use document = JsonDocument.Parse(recipe, JsonDocumentOptions(MaxDepth = 4))
        let value = document.RootElement
        let keys = [ "api"; "provider"; "id"; "reasoning"; "input"; "contextWindow"; "maxTokens"; "compat" ]
        fields keys keys value
        let api = text 64 (value.GetProperty("api"))
        if not (List.contains api [ "openai-completions"; "openai-responses"; "anthropic-messages";
                                   "google-generative-ai"; "google-gemini-cli"; "antigravity2api" ]) then fail ()
        if text 128 (value.GetProperty("provider")) = "" || text 256 (value.GetProperty("id")) = "" then fail ()
        boolean (value.GetProperty("reasoning")) |> ignore
        positive Int32.MaxValue (value.GetProperty("contextWindow")) |> ignore
        positive Int32.MaxValue (value.GetProperty("maxTokens")) |> ignore
        let input = value.GetProperty("input")
        if input.ValueKind <> JsonValueKind.Array || input.GetArrayLength() < 1 || input.GetArrayLength() > 2 then fail ()
        let kinds = input.EnumerateArray() |> Seq.map (text 8) |> Seq.toArray
        if kinds |> Array.exists (fun kind -> kind <> "text" && kind <> "image") then fail ()
        if (Array.distinct kinds).Length <> kinds.Length then fail ()
        let compat = value.GetProperty("compat")
        let flags = [ "mistralReasoningContentParts"; "stripDeepseekSpecialTokens"; "reasoningDeltasMayBeCumulative";
                      "emptyLengthFinishIsContextError"; "escapeBuiltinToolNames"; "flashStreamLeakWorkaround" ]
        fields [] (flags @ [ "streamMarkupHealingPattern"; "toolNamePrefix"; "agProvider" ]) compat
        for property in compat.EnumerateObject() do
            if List.contains property.Name flags then boolean property.Value |> ignore
            elif property.Name = "toolNamePrefix" then text 64 property.Value |> ignore
            elif property.Name = "agProvider" then
                if not (List.contains (text 16 property.Value) [ "google"; "anthropic"; "openai" ]) then fail ()
            elif property.Value.ValueKind <> JsonValueKind.Null then
                if not (List.contains (text 16 property.Value) [ "thinking"; "kimi"; "dsml"; "qwen" ]) then fail ()
        let hasFamily, _ = compat.TryGetProperty("agProvider")
        if api = "antigravity2api" then
            if not hasFamily || text 128 (value.GetProperty("provider")) <> "google-antigravity" then fail ()
        elif hasFamily then fail ()

    let needsRequestPreparation (recipe: string) =
        validateRecipe recipe
        use document = JsonDocument.Parse(recipe)
        document.RootElement.GetProperty("api").GetString() = "antigravity2api"

    let read (bytes: byte[]) : Contracts.DecodeMetadata =
        try
            if bytes.Length > 16384 then fail ()
            use document = JsonDocument.Parse(ReadOnlyMemory<byte>(bytes), JsonDocumentOptions(MaxDepth = 4))
            let value = document.RootElement
            let keys = [ "decoder"; "version"; "modelAlias"; "requestId"; "attempt"; "isStreaming"; "recipe" ]
            fields keys keys value
            let result: Contracts.DecodeMetadata =
                { Decoder = text 64 (value.GetProperty("decoder"))
                  Version = positive 65535 (value.GetProperty("version"))
                  ModelAlias = text 128 (value.GetProperty("modelAlias"))
                  RequestId = text 64 (value.GetProperty("requestId"))
                  Attempt = positive 65535 (value.GetProperty("attempt"))
                  IsStreaming = boolean (value.GetProperty("isStreaming"))
                  Recipe = text 8192 (value.GetProperty("recipe")) }
            if result.Decoder <> "omp-response" || result.Version <> 1 then fail ()
            validateRecipe result.Recipe
            result
        with
        | :? InvalidDataException -> fail ()
        | :? JsonException -> fail ()
        | :? InvalidOperationException -> fail ()
        | :? Collections.Generic.KeyNotFoundException -> fail ()

    let readPrefix (body: Stream) (ct: CancellationToken) = task {
        let prefix = Array.zeroCreate<byte> 4
        do! body.ReadExactlyAsync(prefix.AsMemory(), ct)
        let length = BinaryPrimitives.ReadUInt32BigEndian(prefix.AsSpan())
        if length < 1u || length > 16384u then fail ()
        let bytes = Array.zeroCreate<byte> (int length)
        do! body.ReadExactlyAsync(bytes.AsMemory(), ct)
        return read bytes
    }

    let envelope (path: string) (requestBytes: int64) (metadata: Contracts.DecodeMetadata) (response: HttpResponseMessage) =
        validateRecipe metadata.Recipe
        use buffer = new MemoryStream()
        use writer = new Utf8JsonWriter(buffer)
        writer.WriteStartObject()
        writer.WriteNumber("version", 1)
        writer.WriteString("path", path)
        writer.WriteNumber("requestBytes", requestBytes)
        writer.WriteNumber("status", int response.StatusCode)
        writer.WriteStartArray("headers")
        for name, value in HttpUtils.responseHeaders response do
            writer.WriteStartArray()
            writer.WriteStringValue(name)
            writer.WriteStringValue(value)
            writer.WriteEndArray()
        writer.WriteEndArray()
        writer.WriteStartObject("metadata")
        writer.WriteString("decoder", metadata.Decoder)
        writer.WriteNumber("version", metadata.Version)
        writer.WriteString("modelAlias", metadata.ModelAlias)
        writer.WriteString("requestId", metadata.RequestId)
        writer.WriteNumber("attempt", metadata.Attempt)
        writer.WriteBoolean("isStreaming", metadata.IsStreaming)
        writer.WriteString("recipe", metadata.Recipe)
        writer.WriteEndObject()
        writer.WriteEndObject()
        writer.Flush()
        let bytes = buffer.ToArray()
        if bytes.Length > 65536 then fail ()
        bytes
