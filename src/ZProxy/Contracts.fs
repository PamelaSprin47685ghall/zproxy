namespace ZProxy

open System
open System.Net.Http

module Contracts =
    /// This whitelist describes decoding. It must not contain account state.
    type DecodeMetadata =
        { Decoder: string
          Version: int
          ModelAlias: string
          RequestId: string
          Attempt: int
          IsStreaming: bool }

    let identity (requestId: string, isStreaming: bool) =
        { Decoder = "openai-completions"
          Version = 1
          ModelAlias = ""
          RequestId = requestId
          Attempt = 1
          IsStreaming = isStreaming }

    type RemoteReply =
        { Response: HttpResponseMessage
          Metadata: DecodeMetadata }

    let isCompletionPath path =
        path = "/v1/chat/completions" || path = "/v1/completions"

    let logicalUri path =
        if not (isCompletionPath path) then invalidArg "path" "Unknown completion endpoint."
        Uri("http://zproxy.internal" + path)

    let requestPath (request: HttpRequestMessage) =
        if request.Method <> HttpMethod.Post || request.RequestUri = null || not request.RequestUri.IsAbsoluteUri
           || request.RequestUri.Query <> "" || request.RequestUri.Fragment <> ""
           || not (isCompletionPath request.RequestUri.AbsolutePath) then
            invalidArg "request" "Only POST completion endpoints are accepted."
        request.RequestUri.AbsolutePath
