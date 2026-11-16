namespace ZProxy

open System.Net.Http
open System.Threading
open System.Threading.Tasks

/// A handler owns the returned response. The caller disposes it after use.
type ProxyHandler = HttpRequestMessage -> CancellationToken -> Task<HttpResponseMessage>

/// Plugins are composed at build time. They can wrap or replace a request.
type IProxyPlugin =
    abstract Wrap: next: ProxyHandler -> ProxyHandler

module Plugins =
    let compose (plugins: IProxyPlugin list) (handler: ProxyHandler) =
        List.foldBack (fun (plugin: IProxyPlugin) next -> plugin.Wrap(next)) plugins handler
