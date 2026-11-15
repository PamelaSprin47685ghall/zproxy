namespace ZProxy

open System
open System.IO
open System.Net
open System.Net.Http
open System.Threading
open System.Threading.Channels
open System.Threading.Tasks

module Upstream =

    let private createHandler () =
        new SocketsHttpHandler(
            AutomaticDecompression = DecompressionMethods.None,
            UseCookies = false,
            AllowAutoRedirect = false,
            PooledConnectionLifetime = TimeSpan.FromMinutes(10.0),
            PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2.0),
            MaxConnectionsPerServer = 256,
            EnableMultipleHttp2Connections = true,
            EnableMultipleHttp3Connections = true,
            ConnectTimeout = TimeSpan.FromSeconds(5.0)
        )

    type UpstreamClient() =
        let handler = createHandler ()
        let httpClient = new HttpMessageInvoker(handler)

        /// Execute HTTP request to origin with HTTP/3 first, fallback to HTTP/2/1.1
        member _.SendAsync
            (
                method: string,
                targetUri: Uri,
                headers: (string * string) list,
                bodyReader: ChannelReader<byte[]>,
                ct: CancellationToken
            ) : Task<HttpResponseMessage> =
            task {
                let req = new HttpRequestMessage(HttpMethod(method), targetUri)
                req.Version <- HttpVersion.Version30
                req.VersionPolicy <- HttpVersionPolicy.RequestVersionOrLower

                // Rewrite Host
                req.Headers.Host <- targetUri.Authority

                // Apply sanitized headers
                let filtered = HttpUtils.filterHeaders headers
                for (k, v) in filtered do
                    if not (req.Headers.TryAddWithoutValidation(k, v)) then
                        if req.Content <> null then
                            req.Content.Headers.TryAddWithoutValidation(k, v) |> ignore

                // Set stream body if request can have body
                if method <> "GET" && method <> "HEAD" then
                    let streamContent =
                        new CustomStreamContent(fun outStream streamCt ->
                            task {
                                let mutable loop = true
                                while loop do
                                    let! more = bodyReader.WaitToReadAsync(streamCt)
                                    if more then
                                        let mutable item = Array.empty
                                        while bodyReader.TryRead(&item) do
                                            if item.Length > 0 then
                                                do! outStream.WriteAsync(item.AsMemory(), streamCt)
                                    else
                                        loop <- false
                            } :> Task
                        )
                    for (k, v) in filtered do
                        if k.StartsWith("content-", StringComparison.OrdinalIgnoreCase) then
                            streamContent.Headers.TryAddWithoutValidation(k, v) |> ignore
                    req.Content <- streamContent

                return! httpClient.SendAsync(req, ct)
            }

        interface IDisposable with
            member _.Dispose() =
                httpClient.Dispose()
                handler.Dispose()

    and private CustomStreamContent(writer: Stream -> CancellationToken -> Task) =
        inherit HttpContent()

        override _.SerializeToStreamAsync(stream: Stream, context: TransportContext) : Task =
            writer stream CancellationToken.None

        override _.SerializeToStreamAsync(stream: Stream, context: TransportContext, ct: CancellationToken) : Task =
            writer stream ct

        override _.TryComputeLength(length: byref<int64>) =
            length <- -1L
            false