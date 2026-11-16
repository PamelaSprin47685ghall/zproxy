namespace ZProxy

open System
open System.Collections.Generic
open System.Net.Http

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

    let validGateway (uri: Uri) =
        uri.IsAbsoluteUri
        && (uri.Scheme = "http" || uri.Scheme = "https")
        && uri.UserInfo = "" && uri.Fragment = "" && uri.Host <> ""
        && uri.Query = "" && uri.AbsolutePath = "/" && uri.Port > 0

    let private requestFields =
        HashSet<string>([ "content-type"; "content-length"; "accept"; "accept-encoding" ], StringComparer.OrdinalIgnoreCase)

    let private responseFields =
        HashSet<string>([ "content-type"; "content-length"; "content-encoding"; "cache-control"; "retry-after" ], StringComparer.OrdinalIgnoreCase)

    let safeRequestHeaders headers =
        filterHeaders headers |> List.filter (fun (name, _) -> requestFields.Contains(name))

    let safeResponseHeaders headers =
        filterHeaders headers |> List.filter (fun (name, _) -> responseFields.Contains(name))

    let requestHeaders (request: HttpRequestMessage) =
        [ for header in request.Headers do
              for value in header.Value do yield header.Key, value
          if request.Content <> null then
              for header in request.Content.Headers do
                  for value in header.Value do yield header.Key, value ]
        |> safeRequestHeaders

    let responseHeaders (response: HttpResponseMessage) =
        [ for header in response.Headers do
              for value in header.Value do yield header.Key, value
          for header in response.Content.Headers do
              for value in header.Value do yield header.Key, value ]
        |> safeResponseHeaders

    let addRequestHeaders (request: HttpRequestMessage) headers =
        for name, value in safeRequestHeaders headers do
            if not (request.Headers.TryAddWithoutValidation(name, value)) then
                if request.Content <> null then
                    request.Content.Headers.TryAddWithoutValidation(name, value) |> ignore

    let addResponseHeaders (response: HttpResponseMessage) headers =
        for name, value in safeResponseHeaders headers do
            if not (response.Headers.TryAddWithoutValidation(name, value)) then
                response.Content.Headers.TryAddWithoutValidation(name, value) |> ignore

    let protocolByte (version: Version) = byte (max 1 (min 3 version.Major))

    let protocolVersion value =
        match value with
        | 1uy -> Version(1, 1)
        | 2uy -> Version(2, 0)
        | 3uy -> Version(3, 0)
        | _ -> invalidArg "value" "Unknown HTTP version."
