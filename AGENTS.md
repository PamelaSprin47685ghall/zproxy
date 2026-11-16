# zproxy maintenance guide

## Product boundary

zproxy is a streaming HTTP proxy written in F# for .NET 10 and NativeAOT.
The local process owns routing and optional plugins. The remote process owns
authenticated transport sessions and a shared pool of origin connections.

The local endpoint accepts `/https://origin/path` and `/{hex-origin}/path`.
Read the raw request target. Preserve origin paths, queries, request bodies,
response bodies, and streaming behavior without model-specific parsing.

The local-to-remote transport uses one HTTP/1.1 connection, one long chunked
POST to `/tunnel`, and one long chunked 200 response. Both bodies flow at once.
Do not add HTTP Upgrade, WebSocket, a second transport connection, or the old
unauthenticated remote URL routes. A new wire version replaces the old one;
do not maintain a parallel legacy implementation.

OMP, Bun, model schemas, semantic shims, and AppImage bundling of those
components are outside the core. Leave optional local composition hooks in
`Plugins.fs`. NativeAOT plugins are linked at build time. A plugin may use a
separate local process; the core must not require one when no plugin is enabled.

## Code responsibilities

- `HttpWire` owns bounded HTTP head and chunk parsing and concurrent body I/O.
- `Handshake` authenticates each session and negotiates resource limits.
- `Crypto`, `Zstd`, and `Frame` each own one binary responsibility.
- `Tunnel` owns one writer and one reader, persistent compression history,
  authenticated records, bounded queues, and priority control messages.
- `Flow` owns byte credit and bounded receive bodies.
- `Session` owns multiplexed requests, cancellation, and connection failure.
- `Client` owns the local HTTP server and one live remote session.
- `Server` owns its connection limit and a shared `UpstreamClient`.
- `Program` validates arguments and owns process shutdown.

Keep dependencies flat and compose complete parts explicitly. Use short,
direct English names and comments. Remove superseded code after a cutover.
Do not add a framework for a single use case.

## Invariants

- Never buffer an entire HTTP body. Data frames are at most 16 KiB.
- Bound headers, frames, encrypted records, decompressed output, queues,
  pending cancellations, replay entries, streams, and connections.
- Wait for stream credit before placing data in the shared writer queue.
  Control handling must not wait for an application to consume a slow body.
- Keep independent compression histories for upload and download. Flush
  available output immediately; do not use a delay to collect a larger batch.
- Authenticate a handshake before allocating compression contexts or opening
  an origin connection. Derive the Argon2 process key once and clear temporary
  key material. Do not provide a default or command-line password.
- Close a failed session and cancel all its origin work. Never automatically
  replay a request. A later new request may open a fresh session.
- Preserve content encoding metadata unless the bytes are actually decoded.
  Strip hop-by-hop fields and fields nominated by `Connection`.
- Origin TLS uses normal certificate validation. HTTP/3 is preferred with
  normal HTTP/2 and HTTP/1.1 fallback.
- The remote process has no model semantics or runtime plugin loader.

## Verification

Use the SDK pinned by `global.json`.

```sh
dotnet build zproxy.slnx
dotnet test zproxy.slnx --configuration Release
dotnet publish src/ZProxy/ZProxy.fsproj --configuration Release \
  --runtime linux-x64 -p:PublishAot=true
```

Linux needs `libzstd.so.1`; NativeAOT builds also need the native toolchain.
CI runs the full test suite and publishes a Linux NativeAOT artifact.

Keep tests for actual behavior: overlapping HTTP request and response bodies,
fragmented framing, authentication, bounded decompression, credit, cancellation,
independent streams, chunked uploads, SSE, reconnect without replay, and plugin
short circuits. Test owned loopback or in-memory peers. Do not use live model
services or third-party accounts in tests. Distinguish tests actually run from
tests only compiled when an environment prevents network or native execution.

Describe wire or CLI breaks in the README and protocol document. Do not claim
latency, memory, or compression gains without measurements of that workload.
