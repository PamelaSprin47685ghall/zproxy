# zproxy maintenance guide

## Product boundary

zproxy is a streaming completion proxy written in F# for .NET 10 and NativeAOT.
The local process accepts only POST `/v1/chat/completions` and POST
`/v1/completions`, with exact paths and no query. It owns optional request
plugins and downstream decoders. It cannot select an origin authority.

The remote process owns user authentication, connection limits, statistics,
and a shared pool for its fixed `--gateway`. Upstream credentials, account
refresh, routing, retry decisions, and shared health belong to the remote
gateway or a remote adapter. Never copy account state into the local decoder.

The local-to-remote transport uses one HTTP/1.1 connection, one long chunked
POST to `/tunnel`, and one long chunked 200 response. Both bodies flow at once.
Do not add HTTP Upgrade, WebSocket, a second transport connection, or the old
client-selected origin routes. The current wire version is v3; do not keep a
parallel legacy protocol or shared-password transport.

The default gateway already returns OpenAI completions. Its identity decoder
does not move OMP parsing work off the server. Heavy OMP integration, the
remote handoff before response parsing, JS runtimes, and AppImage bundling
remain outside this change. NativeAOT plugins are linked at build time. A
plugin may own a local process; the core must work without it when disabled.

## Code responsibilities

- `HttpWire` owns bounded HTTP head and chunk parsing and concurrent body I/O.
- `Users` owns UUID issuance, private derived credentials, revocation, and the
  exclusive data-directory lock.
- `Handshake` resolves a public selector, authenticates the hello, checks
  replay state, and negotiates resource limits.
- `Crypto`, `Zstd`, and `Frame` each own one binary responsibility.
- `Contracts` owns exact completion paths and the response metadata whitelist.
- `Plugins` composes local request wrappers and versioned response decoders.
- `Tunnel` owns one writer and one reader, persistent compression history,
  authenticated records, bounded queues, and priority control messages.
- `Flow` owns byte credit and bounded receive bodies.
- `Session` owns multiplexed requests, cancellation, and connection failure.
- `Client` owns the local HTTP server and one live remote session.
- `Upstream` sends to a fixed authority and adds only server-owned credentials.
- `Metering` counts server-read bodies for the authenticated user identity.
- `Statistics` stores completed aggregates and projects public nickname rows.
- `Management` owns bounded admin sessions and public reports.
- `Server` composes global and per-user limits, stores, management, and dispatch.
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
  an origin connection. Users have random UUIDv4 secrets with domain-separated
  SHA-256 selectors and keys. Selectors are public and linkable, not proof of
  authorization. Never send the raw UUID in the tunnel or persist it. Treat
  stored derived keys as equivalent secrets and clear temporary key material.
- Keep the admin password separate from user credentials and server gateway
  tokens. Read secrets through named environment variables, not CLI values.
- Keep `users.json`, `stats.json`, and `users.lock` private. One server owns a
  data directory. User changes persist before publication; statistics flush
  every 5 seconds and on clean shutdown. These counters are not billing data.
- Public reports expose only nicknames and counters. Do not expose internal
  user IDs, UUIDs, selectors, keys, account state, or secrets in JSON or the DOM.
- Admin writes require a session and matching Origin; login requires Origin
  and the master password. Require HTTPS or direct loopback. Trust forwarded
  HTTPS only from loopback. Do not serve a password form over remote plain HTTP.
- Close a failed session and cancel all its origin work. Never automatically
  replay a request. A later new request may open a fresh session.
- Preserve content encoding metadata unless the bytes are actually decoded.
  Apply the request and response header whitelists after removing hop-by-hop
  fields and fields nominated by `Connection`. Never forward caller credentials.
- Origin TLS uses normal certificate validation. HTTP/3 is preferred with
  normal HTTP/2 and HTTP/1.1 fallback.
- Keep metadata fixed, bounded, and versioned. It may describe decoding but
  cannot contain account snapshots or credentials. Fail unknown decoders.
- The caller owns the final response. A decoder must close the raw response
  or transfer its lifetime to the returned stream, including failure cleanup.
  Upload bodies are single-pass; request plugins must save needed parse context
  before forwarding. The core does not buffer or replay uploads for decoders.
- A 2xx response read to upstream EOF is a server success, not proof of client
  delivery or successful local decoding. Local short circuits are not metered
  by the server. Keep the remote core free of model parsing and runtime loaders.

## Verification

Use the SDK pinned by `global.json`.

```sh
dotnet build zproxy.slnx
dotnet test zproxy.slnx --configuration Release
dotnet publish src/ZProxy/ZProxy.fsproj --configuration Release \
  --runtime linux-x64 -p:PublishAot=true --output artifacts/linux-x64
python3 scripts/smoke-native.py --binary artifacts/linux-x64/ZProxy
```

Linux needs `libzstd.so.1`; NativeAOT builds also need the native toolchain.
CI runs the full test suite and publishes a Linux NativeAOT artifact.

Keep tests for actual behavior: overlapping HTTP request and response bodies,
fragmented framing, authentication, bounded decompression, credit, cancellation,
independent streams, chunked uploads, SSE, reconnect without replay, plugin
short circuits, decoder ownership, credential boundaries, revocation, admin
access, public-report isolation, and persistence. Test owned loopback or
in-memory peers. Do not use live model services or third-party accounts.
Distinguish actual managed and native runs from checks that only compiled.

Describe wire or CLI breaks in the README and protocol document. Do not claim
latency, memory, or compression gains without measurements of that workload.
