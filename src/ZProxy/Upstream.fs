namespace ZProxy

open System
open System.Net
open System.Net.Http
open System.Threading

module Upstream =
    /// One pool is shared by all authenticated sessions on this server.
    type UpstreamClient() =
        let handler =
            new SocketsHttpHandler(
                AutomaticDecompression = DecompressionMethods.None,
                UseCookies = false,
                AllowAutoRedirect = false,
                PooledConnectionLifetime = TimeSpan.FromMinutes(10.0),
                PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2.0),
                MaxConnectionsPerServer = 64,
                EnableMultipleHttp2Connections = true,
                ConnectTimeout = TimeSpan.FromSeconds(10.0))
        let client = new HttpClient(handler, disposeHandler = true)
        do client.Timeout <- Timeout.InfiniteTimeSpan

        member _.SendAsync(request: HttpRequestMessage, ct: CancellationToken) =
            request.Version <- HttpVersion.Version30
            request.VersionPolicy <- HttpVersionPolicy.RequestVersionOrLower
            request.Headers.Host <- request.RequestUri.Authority
            client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)

        interface IDisposable with
            member _.Dispose() = client.Dispose()
