namespace ZProxy

open System
open System.Collections.Generic
open System.IO
open System.Reflection
open System.Text
open System.Text.Json
open System.Threading.Tasks
open Microsoft.AspNetCore.Http

/// Owns the embedded status page: hashed assets, the document template, and the
/// response headers that let the page run without inline script or style.
module StatusPage =

    /// Assets are packed as `status/<relative path>` by ZProxy.fsproj.
    [<Literal>]
    let private Prefix = "status/"

    type private Asset =
        { Bytes: byte[]
          ContentType: string
          Immutable: bool }

    let private contentType (path: string) =
        match Path.GetExtension(path).ToLowerInvariant() with
        | ".js" -> "text/javascript; charset=utf-8"
        | ".css" -> "text/css; charset=utf-8"
        | ".svg" -> "image/svg+xml"
        | ".woff2" -> "font/woff2"
        | ".woff" -> "font/woff"
        | ".png" -> "image/png"
        | ".webp" -> "image/webp"
        | ".ico" -> "image/x-icon"
        | _ -> "application/octet-stream"

    let private read (assembly: Assembly) =
        let assets = Dictionary<string, Asset>(StringComparer.Ordinal)
        for name in assembly.GetManifestResourceNames() do
            if name.StartsWith(Prefix, StringComparison.Ordinal) then
                use stream = assembly.GetManifestResourceStream name
                if not (isNull stream) then
                    use buffer = new MemoryStream()
                    stream.CopyTo buffer
                    let relative = name.Substring(Prefix.Length)
                    assets["/" + relative] <-
                        { Bytes = buffer.ToArray()
                          ContentType = contentType relative
                          Immutable = relative.StartsWith("assets/", StringComparison.Ordinal) }
        assets

    let private assets = lazy (read typeof<Asset>.Assembly)

    /// The Vite manifest maps the source entry to the hashed file names.
    let private entry () =
        match assets.Value.TryGetValue "/manifest.json" with
        | true, manifest ->
            try
                use document = JsonDocument.Parse(ReadOnlyMemory<byte>(manifest.Bytes))
                match document.RootElement.TryGetProperty "src/main.js" with
                | true, item ->
                    let file = item.GetProperty("file").GetString()
                    let css =
                        match item.TryGetProperty "css" with
                        | true, list when list.ValueKind = JsonValueKind.Array && list.GetArrayLength() > 0 ->
                            Some(list[0].GetString())
                        | _ -> None
                    if String.IsNullOrEmpty file then None else Some(file, css)
                | _ -> None
            with
            | :? JsonException
            | :? KeyNotFoundException
            | :? InvalidOperationException -> None
        | _ -> None

    /// A page shell small enough to read. The data arrives from /api/reports, so
    /// the document carries no per-user value and needs no nonce.
    let private document (title: string) (page: string) (css: string) (js: string) =
        let styles =
            if String.IsNullOrEmpty css then ""
            else "<link rel=\"stylesheet\" href=\"" + css + "\">"
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        + "<meta name=\"color-scheme\" content=\"light dark\">"
        + "<meta name=\"robots\" content=\"noindex\">"
        + "<meta name=\"referrer\" content=\"no-referrer\">"
        + "<title>" + title + "</title>"
        + styles
        + "</head><body data-page=\"" + page + "\"><div id=\"app\"><main class=\"boot\" aria-busy=\"true\">"
        + "<p>正在读取统计…</p></main></div>"
        + "<noscript><p class=\"boot\">这个页面需要 JavaScript 才能显示统计。</p></noscript>"
        + "<script type=\"module\" src=\"" + js + "\"></script>"
        + "</body></html>"

    let private policy =
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        + "font-src 'self' data:; connect-src 'self'; base-uri 'none'; "
        + "frame-ancestors 'none'; form-action 'self'"

    let private shell (title: string) (page: string) (context: HttpContext) = task {
        match entry () with
        | Some(file, css) ->
            context.Response.StatusCode <- 200
            context.Response.Headers.ContentSecurityPolicy <- policy
            context.Response.Headers.CacheControl <- "no-store"
            context.Response.Headers.XContentTypeOptions <- "nosniff"
            context.Response.Headers["Referrer-Policy"] <- "no-referrer"
            context.Response.ContentType <- "text/html; charset=utf-8"
            let styles = match css with Some value -> "/" + value | None -> ""
            do! context.Response.WriteAsync(document title page styles ("/" + file), context.RequestAborted)
        | None ->
            context.Response.StatusCode <- 503
            context.Response.Headers.CacheControl <- "no-store"
            context.Response.ContentType <- "text/plain; charset=utf-8"
            do! context.Response.WriteAsync(
                    "状态页资源未打包。请运行 python3 scripts/build-status-page.py 后重新构建。",
                    context.RequestAborted)
    }

    /// The public statistics document.
    let write (context: HttpContext) = shell "zproxy · 使用统计" "stats" context

    /// The authenticated routing document. The shell is public, but the data it
    /// reads is served only to an admin session, so nothing here is a secret.
    let writeRouting (context: HttpContext) = shell "zproxy · 路由统计" "routing" context

    /// Serves only files named by the manifest; there is no directory listing and
    /// no path resolution, so the request path cannot escape the asset table.
    let serve (context: HttpContext) (path: string) = task {
        match assets.Value.TryGetValue path with
        | true, asset when asset.Immutable ->
            context.Response.StatusCode <- 200
            context.Response.Headers.CacheControl <- "public, max-age=31536000, immutable"
            context.Response.Headers.XContentTypeOptions <- "nosniff"
            context.Response.Headers["Cross-Origin-Resource-Policy"] <- "same-origin"
            context.Response.ContentType <- asset.ContentType
            do! context.Response.Body.WriteAsync(ReadOnlyMemory<byte>(asset.Bytes), context.RequestAborted)
        | _ ->
            context.Response.StatusCode <- 404
            context.Response.Headers.CacheControl <- "no-store"
            context.Response.ContentType <- "text/plain; charset=utf-8"
            do! context.Response.WriteAsync("没有这个资源。", context.RequestAborted)
    }
