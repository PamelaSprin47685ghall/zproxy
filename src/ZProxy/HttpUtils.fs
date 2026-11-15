namespace ZProxy

open System
open System.Collections.Generic
open System.Text

module HttpUtils =

    let HopByHopHeaders =
        HashSet<string>(
            [| "connection"
               "keep-alive"
               "proxy-authenticate"
               "proxy-authorization"
               "te"
               "trailer"
               "transfer-encoding"
               "upgrade"
               "host"
               "via"
               "x-forwarded-for"
               "x-forwarded-host"
               "x-forwarded-proto"
               "forwarded" |],
            StringComparer.OrdinalIgnoreCase
        )

    /// Parse hex string into UTF-8 decoded string
    let tryDecodeHex (hex: string) : string option =
        if hex.Length % 2 <> 0 then None
        else
            try
                let bytes = Convert.FromHexString(hex)
                let s = Encoding.UTF8.GetString(bytes)
                if s.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                   s.StartsWith("https://", StringComparison.OrdinalIgnoreCase) then
                    Some s
                else
                    None
            with _ ->
                None

    /// Extract target URL from raw request target (e.g. /https://api.mistral.ai/v1/chat or /{hex}/v1/chat)
    let parseTargetUrl (rawTarget: string) : Result<Uri, string> =
        let trimmed = if rawTarget.StartsWith("/") then rawTarget.Substring(1) else rawTarget
        if trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
           trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase) then
            match Uri.TryCreate(trimmed, UriKind.Absolute) with
            | true, uri when not (isNull (box uri)) -> Ok uri
            | _ -> Error (sprintf "Invalid target URL: %s" trimmed)
        else
            // Check for hex prefix before next slash or query
            let slashIdx = trimmed.IndexOf('/')
            let qIdx = trimmed.IndexOf('?')
            let splitIdx =
                match slashIdx, qIdx with
                | -1, -1 -> trimmed.Length
                | -1, q -> q
                | s, -1 -> s
                | s, q -> min s q
            let hexPart = trimmed.Substring(0, splitIdx)
            match tryDecodeHex hexPart with
            | Some baseUrl ->
                let rest = trimmed.Substring(splitIdx)
                let full =
                    if baseUrl.EndsWith("/") && rest.StartsWith("/") then
                        baseUrl + rest.Substring(1)
                    elif not (baseUrl.EndsWith("/")) && not (rest.StartsWith("/")) && rest.Length > 0 && not (rest.StartsWith("?")) then
                        baseUrl + "/" + rest
                    else
                        baseUrl + rest
                match Uri.TryCreate(full, UriKind.Absolute) with
                | true, uri when not (isNull (box uri)) -> Ok uri
                | _ -> Error (sprintf "Invalid decoded URL: %s" full)
            | None ->
                Error (sprintf "Path does not begin with http(s):// or valid hex-encoded URL: %s" rawTarget)

    /// Filter headers, removing hop-by-hop and proxy artifacts
    let filterHeaders (headers: seq<string * string>) : (string * string) list =
        headers
        |> Seq.filter (fun (k, _) -> not (HopByHopHeaders.Contains(k)))
        |> Seq.toList