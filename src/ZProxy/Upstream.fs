namespace ZProxy

open System
open System.Net
open System.Net.Http
open System.Net.Http.Headers
open System.Threading

module Upstream =
    /// One pool is shared by all authenticated sessions on this server.
    type UpstreamClient(gateway: Uri, gatewayToken: string option) =
        do if not (HttpUtils.validGateway gateway) then invalidArg "gateway" "The gateway must be a fixed HTTP or HTTPS authority."
        let handler =
            new SocketsHttpHandler(
                AutomaticDecompression = DecompressionMethods.None,
                UseProxy = false,
                UseCookies = false,
                AllowAutoRedirect = false,
                PooledConnectionLifetime = TimeSpan.FromMinutes(10.0),
                PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2.0),
                MaxConnectionsPerServer = 64,
                EnableMultipleHttp2Connections = true,
                ConnectTimeout = TimeSpan.FromSeconds(10.0))
        let client = new HttpClient(handler, disposeHandler = true)
        do client.Timeout <- Timeout.InfiniteTimeSpan

        member _.SendAsync(request: HttpRequestMessage, ct: CancellationToken) = task {
            let path = Contracts.requestPath request
            let headers = HttpUtils.requestHeaders request
            request.RequestUri <- Uri(gateway, path)
            request.Headers.Clear()
            if request.Content <> null then request.Content.Headers.Clear()
            HttpUtils.addRequestHeaders request headers
            gatewayToken |> Option.iter (fun token -> request.Headers.Authorization <- AuthenticationHeaderValue("Bearer", token))
            request.Version <- HttpVersion.Version30
            request.VersionPolicy <- HttpVersionPolicy.RequestVersionOrLower
            request.Headers.Host <- request.RequestUri.Authority
            let! response = client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
            let streaming =
                response.Content.Headers.ContentType <> null
                && response.Content.Headers.ContentType.MediaType = "text/event-stream"
            return
                ({ Response = response
                   Metadata = Contracts.identity(Guid.NewGuid().ToString("N"), streaming) } : Contracts.RemoteReply)
        }

        interface IDisposable with
            member _.Dispose() = client.Dispose()
