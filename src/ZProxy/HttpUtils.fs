namespace ZProxy

open System
open System.Collections.Generic
open System.Net.Http
open System.Text

module HttpUtils =
    let private fixedHopHeaders =
        [ "connection"; "keep-alive"; "proxy-authenticate"; "proxy-authorization"
          "te"; "trailer"; "transfer-encoding"; "upgrade"; "host"
          "via"; "forwarded"; "x-forwarded-for"; "x-forwarded-host"; "x-forwarded-proto"
          "x-zproxy-pass-encoding" ]

    let filterHeaders (headers: (string * string) list) =
        let excluded = HashSet<string>(fixedHopHeaders, StringComparer.OrdinalIgnoreCase)
        for name, value in headers do
            if name.Equals("connection", StringComparison.OrdinalIgnoreCase) then
                for token in value.Split(',') do
                    excluded.Add(token.Trim()) |> ignore
        headers |> List.filter (fun (name, _) -> not (excluded.Contains(name)))

    let validTarget (uri: Uri) =
        uri.IsAbsoluteUri
        && (uri.Scheme = "http" || uri.Scheme = "https")
        && uri.UserInfo = "" && uri.Fragment = "" && uri.Host <> ""

    /// Read the raw request target. Do not decode the origin path twice.
    let parseTargetUrl (rawTarget: string) : Result<Uri, string> =
        try
            let text = rawTarget.TrimStart('/')
            let target =
                if text.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                   || text.StartsWith("https://", StringComparison.OrdinalIgnoreCase) then text
                else
                    let boundary = text.IndexOfAny([| '/'; '?' |])
                    let encoded, suffix =
                        if boundary < 0 then text, ""
                        else text.Substring(0, boundary), text.Substring(boundary)
                    let prefix = Encoding.UTF8.GetString(Convert.FromHexString(encoded))
                    if prefix.EndsWith('/') && suffix.StartsWith('/') then prefix + suffix.Substring(1)
                    else prefix + suffix
            match Uri.TryCreate(target, UriKind.Absolute) with
            | true, uri when validTarget uri -> Ok uri
            | _ -> Error "The request path must contain an HTTP or HTTPS origin URL."
        with :? FormatException -> Error "The encoded origin URL is not valid hexadecimal."

    let requestHeaders (request: HttpRequestMessage) =
        [ for header in request.Headers do
              for value in header.Value do yield header.Key, value
          if request.Content <> null then
              for header in request.Content.Headers do
                  for value in header.Value do yield header.Key, value ]
        |> filterHeaders

    let responseHeaders (response: HttpResponseMessage) =
        [ for header in response.Headers do
              for value in header.Value do yield header.Key, value
          for header in response.Content.Headers do
              for value in header.Value do yield header.Key, value ]
        |> filterHeaders

    let addRequestHeaders (request: HttpRequestMessage) headers =
        for name, value in filterHeaders headers do
            if not (request.Headers.TryAddWithoutValidation(name, value)) then
                if request.Content <> null then
                    request.Content.Headers.TryAddWithoutValidation(name, value) |> ignore

    let addResponseHeaders (response: HttpResponseMessage) headers =
        for name, value in filterHeaders headers do
            if not (response.Headers.TryAddWithoutValidation(name, value)) then
                response.Content.Headers.TryAddWithoutValidation(name, value) |> ignore

    let protocolByte (version: Version) = byte (max 1 (min 3 version.Major))

    let protocolVersion value =
        match value with
        | 1uy -> Version(1, 1)
        | 2uy -> Version(2, 0)
        | 3uy -> Version(3, 0)
        | _ -> invalidArg "value" "Unknown HTTP version."
