namespace ZProxy

open System.Net.Http
open System.Threading
open System.Threading.Tasks

/// The caller owns the returned response and disposes it after use.
type ProxyHandler = HttpRequestMessage -> CancellationToken -> Task<HttpResponseMessage>

/// Plugins are composed at build time. They can wrap or replace a request.
type IProxyPlugin =
    abstract Wrap: next: ProxyHandler -> ProxyHandler

/// Only the server supplies this identity. A request cannot override it.
type RemoteHandler = Users.Identity -> HttpRequestMessage -> CancellationToken -> Task<Contracts.RemoteReply>

/// The decoder must close the raw response or transfer its lifetime to the returned response.
/// The upload can be consumed. A request plugin can keep local decode state in request.Options.
type IResponseDecoder =
    abstract Id: string
    abstract Version: int
    abstract Decode: request: HttpRequestMessage * metadata: Contracts.DecodeMetadata *
                     response: HttpResponseMessage * cancellationToken: CancellationToken -> Task<HttpResponseMessage>

module Plugins =
    let compose (plugins: IProxyPlugin list) (handler: ProxyHandler) =
        List.foldBack (fun (plugin: IProxyPlugin) next -> plugin.Wrap(next)) plugins handler

    let decode (decoders: IResponseDecoder list) request (reply: Contracts.RemoteReply) ct = task {
        let metadata = reply.Metadata
        if metadata.Decoder = "openai-completions" && metadata.Version = 1 then
            return reply.Response
        else
            match decoders |> List.tryFind (fun decoder -> decoder.Id = metadata.Decoder && decoder.Version = metadata.Version) with
            | Some decoder ->
                try return! decoder.Decode(request, metadata, reply.Response, ct)
                with error ->
                    reply.Response.Dispose()
                    return raise error
            | None ->
                reply.Response.Dispose()
                return raise (System.IO.InvalidDataException("The response decoder is unavailable or incompatible."))
    }
