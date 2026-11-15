# zproxy — Architecture & Engineering Specification (`AGENTS.md`)

`zproxy` is a single-binary, cross-platform encrypted full-duplex Zstd HTTP acceleration proxy written in **F# (.NET)**. Following the single-binary client/server philosophy of `~/syncmount`, one executable serves both roles (`zproxy client` and `zproxy server`).

It replaces the legacy `BUN_OPTIONS=--preload zstd-preload.js` + custom Caddy `request-decompressor` stack with a language-agnostic local HTTP endpoint and a zero-configuration remote gateway.

---

## 1. Core Goals & Non-Goals

### 1.1 Goals
1. **Zero Client Code Modification**: Local applications (`omp`, OpenAI/Anthropic SDKs, CLI tools) require no preload scripts, no custom TLS CAs, and no code changes. Setting the provider endpoint to `http://127.0.0.1:<port>/https://<target-host>/<path>` routes all requests through `zproxy`.
2. **Zero Server Route Configuration**: The server dynamically proxies arbitrary target URLs encoded in the request envelope (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`), requiring no per-provider static routing rules.
3. **Master Password IS Auth & Key**: A single shared master password derives all session encryption and authentication keys via `Argon2id` + `HKDF-SHA256`. Any unauthenticated or tampered packet fails AEAD tag verification on the first frame and is rejected without side effects.
4. **Cross-Border HTTP/1.1 Keep-Alive Full-Duplex Streaming Zstd**: Client and server communicate over port `:80` HTTP/1.1 persistent connections carrying full-duplex streaming Zstd (`Flush` per frame) and AEAD-sealed frames, preserving a shared sliding compression window across consecutive LLM turns.
5. **Upstream HTTP/3 First with Automatic Fallback**: The server connects to target origins using **HTTP/3 (QUIC)** first and automatically falls back to **HTTP/2** and **HTTP/1.1** (`HttpVersion.Version30` + `HttpVersionPolicy.RequestVersionOrLower`).

### 1.2 Non-Goals
- **Not a TLS-intercepting CA MITM**: `omp` talks plaintext `http://` to `127.0.0.1:<port>` with the target `https://...` URL embedded in the request path. `zproxy` unwraps the outer path and initiates standard TLS/QUIC to the target origin on the server side; no forged X.509 certificates or local root CAs are ever used.
- **Not a multi-tenant public relay**: All clients sharing the master password belong to the same trust domain.

---

## 2. System Topology & Data Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Local Workstation                                                          │
│                                                                            │
│  ┌───────────┐   Plain HTTP/1.1 (:18080)    ┌───────────────────────────┐  │
│  │    omp    │ ───────────────────────────► │       zproxy client       │  │
│  │ (or SDK)  │   POST /https://api.mistral  │  - Extracts raw target    │  │
│  └───────────┘        .ai/v1/chat/...       │  - Multiplexes streams    │  │
│                                             │  - Streaming Zstd (Flush) │  │
│                                             │  - AEAD Seal (PSK)        │  │
│                                             └─────────────┬─────────────┘  │
└───────────────────────────────────────────────────────────┼────────────────┘
                                                            │
                                 Port :80 HTTP/1.1 Keep-Alive Full-Duplex Pipe
                                 (0-RTT AEAD + Cross-Request Zstd Window)
                                                            │
┌───────────────────────────────────────────────────────────┼────────────────┐
│ Remote Edge Server (e.g. cdg0v4.kw92.cyou :80, bound to lo + eth0)         │
│                                                           ▼                │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        zproxy server (:80)                           │  │
│  │  - Verifies timestamp/salt + AEAD Open                               │  │
│  │  - Streaming Zstd Decompress                                         │  │
│  │  - SocketsHttpHandler: HTTP/3 preferred -> HTTP/2 -> HTTP/1.1        │  │
│  └──────────────────┬───────────────────────────────────┬───────────────┘  │
└─────────────────────┼───────────────────────────────────┼──────────────────┘
                      │ HTTP/3 (QUIC) / HTTP/2            │ HTTP/3 (QUIC) / HTTP/2
                      ▼                                   ▼
        ┌───────────────────────────┐       ┌────────────────────────────────┐
        │   https://api.mistral.ai  │       │ https://daily-cloudcode-pa.    │
        │                           │       │         googleapis.com         │
        └───────────────────────────┘       └────────────────────────────────┘
```

---

## 3. URL Addressing & Routing Contract

### 3.1 Local Client Ingress (`127.0.0.1:<port>`)
When `omp` is configured with:
```yaml
baseUrl: http://127.0.0.1:18080/https://api.mistral.ai/v1
```
and invokes `/chat/completions?stream=true`, the local HTTP request arriving at `zproxy client` has:
- Request line target: `/https://api.mistral.ai/v1/chat/completions?stream=true`

`zproxy client` MUST support two target URL path formats on ingress:
1. **Direct Prefix URL (Primary)**:
   - Path begins with `/https://` or `/http://` (after stripping the leading `/`).
   - **CRITICAL INVARIANT**: The client MUST read the raw, un-normalized request target (`IHttpRequestFeature.RawTarget` in Kestrel/ASP.NET Core, or raw HTTP/1.1 request-line parser). Never use normalized `HttpRequest.Path`, which collapses `https://` into `https:/`.
2. **Hex-Encoded URL Prefix (Explicit / Direct Server Format)**:
   - Path begins with `/{hex}` or `/{hex}/<subpath>[?<query>]`, where `{hex}` is an even-length hexadecimal string (ASCII `0-9a-fA-F`) that UTF-8 decodes to a valid `http://` or `https://` URL.
   - If a trailing `<subpath>` or `?<query>` is present after `/{hex}`, it is appended to the decoded base URL.

### 3.2 Outer Server Ingress (`:80`)
On the cross-border link between `zproxy client` and `zproxy server` (`:80`):
1. **Multiplexed Pipe Mode (Default)**:
   - Client opens a persistent HTTP/1.1 Keep-Alive full-duplex stream (`POST /<hex-session-token>` or `Connection: Upgrade` / chunked duplex stream) to `:80`.
   - The target URL is transmitted **inside** the Zstd-compressed, AEAD-encrypted `OpenRequest` frame so intermediate DPI on port `:80` cannot inspect target domains or hit URI length limits.
2. **Single-Request Hex URL Mode (Direct Compatibility)**:
   - The server ALSO accepts direct encrypted requests to `/{hex-encoded-target-url}` where the request headers/body and response headers/body are framed with the same AEAD + Zstd stream format, and the path itself is authenticated via AEAD Associated Data (AAD).

---

## 4. Cryptography & Authentication Specification

`zproxy` follows `~/syncmount`'s cryptographic discipline: **the master password is both the credential and the key root**.

### 4.1 Master Key Derivation
Given the UTF-8 master password $P$:
- Derive a 32-byte `MasterKey` using **Argon2id** (`m = 64 MiB`, `t = 3`, `p = 1`, fixed domain salt `SHA256("zproxy-v1-master-salt")` = 32 bytes, output = 32 bytes).
- Cache `MasterKey` in memory at process startup; zeroize password buffers immediately after derivation.

### 4.2 Per-Connection Session Key Derivation (0-RTT + Replay Protection)
When initiating a cross-border HTTP/1.1 pipe (or single request), the client sends a **32-byte Plaintext Preamble**:
```
┌──────────────────────────────────────────┬──────────────────────────┐
│            RandomSalt (24 B)             │  TimestampUnixMs (8 B)   │
└──────────────────────────────────────────┴──────────────────────────┘
```
- `RandomSalt`: 24 bytes from `RandomNumberGenerator.Fill`.
- `TimestampUnixMs`: Big-endian `int64` UTC Unix timestamp in milliseconds.

Both peers derive directional keys and Zstd dictionary/session bindings via `HKDF-SHA256`:
- `PRK = HKDF-Extract(salt = Preamble[0..32], ikm = MasterKey)`
- `Key_C2S = HKDF-Expand(PRK, info = "zproxy-v1-key-c2s", len = 32)`
- `Key_S2C = HKDF-Expand(PRK, info = "zproxy-v1-key-s2c", len = 32)`
- `Auth_Path_Key = HKDF-Expand(PRK, info = "zproxy-v1-path-mac", len = 32)`

**Server Anti-Replay & Auth Gate**:
1. Verify $\left|\text{Now}_{\text{ms}} - \text{TimestampUnixMs}\right| \le 60\,000\text{ ms}$.
2. Check that `RandomSalt` has not been seen within the active 120-second sliding window (`ConcurrentDictionary` with periodic eviction).
3. Decrypt the first AEAD chunk (`Seq = 0`, `AAD = Preamble[0..32]`).
4. If timestamp, salt uniqueness, or AEAD authentication fails, immediately return a generic `HTTP/1.1 404 Not Found` (`Content-Length: 0`, `Connection: close`) without logging sensitive material or leaking oracle timing.

### 4.3 AEAD Chunk Wire Format
All bytes after the 32-byte preamble in both directions (`C2S` and `S2C`) are sequence-numbered AEAD chunks using **`ChaCha20-Poly1305`** (or **`AES-256-GCM`** when hardware AES-NI/ARMv8 Crypto is negotiated; default `ChaCha20-Poly1305` for universal constant-time safety):

```
┌─────────────────────────┬───────────────────────────────────────────┬─────────────────────┐
│ PlaintextLen (uint24 BE)│        Ciphertext (PlaintextLen B)        │ Poly1305 Tag (16 B) │
└─────────────────────────┴───────────────────────────────────────────┴─────────────────────┘
```
- `PlaintextLen`: 3-byte big-endian unsigned integer ($1 \le \text{PlaintextLen} \le 65\,536$). Max chunk plaintext is **64 KiB**.
- `Nonce` (12 bytes):
  - Byte `0..3`: Direction tag (`0x43, 0x32, 0x53, 0x00` for C2S; `0x53, 0x32, 0x43, 0x00` for S2C).
  - Byte `4..11`: Strictly monotonic `uint64` big-endian chunk counter ($0, 1, 2, \dots$), incremented per chunk.
- `AAD` (Associated Data):
  - For chunk `0`: `Preamble[0..32] || PlaintextLen[0..3]`.
  - For chunk $n > 0$: `PlaintextLen[0..3]`.

---

## 5. Full-Duplex Streaming Zstd & Multiplex Framing

### 5.1 Why Multiplexed Framing Inside HTTP/1.1 Keep-Alive Beats Raw HTTP/1.1 Pipelining
RFC 9112 §9.3.2 requires classic HTTP/1.1 pipelined servers to send responses in **strict FIFO order**. In `omp`, a 60-second streaming SSE response on request #1 would head-of-line block a 200 ms subagent or title-generation response on request #2, and aborting request #1 would force tearing down the entire TCP connection.

Instead, `zproxy` runs **full-duplex HTTP/1.1 persistent streams** with a lightweight 8-byte inner multiplex frame header compressed by a **single long-lived `ZstandardStream` per direction**:

```
Application Streams (Concurrent Requests / SSE Responses)
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ 1. Inner Multiplex Frames                                     │
│    [StreamId: u32 BE][FrameType: u8][Flags: u8][Len: u16 BE]  │
│    + Frame Payload (<= 65535 B)                               │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│ 2. Long-Lived Streaming Zstd (Level 3, 8 MiB Window)          │
│    zstdStream.WriteAsync(frame) + zstdStream.FlushAsync()     │
│    -> Preserves dictionary/history across consecutive turns!  │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│ 3. AEAD Chunk Sealer (<= 64 KiB chunks + 16 B Tag)            │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│ 4. Port :80 HTTP/1.1 Keep-Alive / Upgrade Duplex Socket       │
└───────────────────────────────────────────────────────────────┘
```

> **Cross-Turn Compression Gain**: Because `omp` uses `appendOnlyContext: "on"`, turn $N+1$ repeats 95–99% of turn $N$'s JSON prompt. A persistent Zstd stream flushed with `ZSTD_e_flush` (`ZstandardStream.FlushAsync`) keeps up to 8 MiB of prior requests in its sliding window, compressing repeated 100 KB context prefixes into **dozens of bytes** of LZ77 back-references while maintaining zero buffering delay.

### 5.2 Inner Frame Specification
Every inner frame begins with an **8-byte header**:
```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        StreamId (uint32 BE)                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| FrameType (u8)|   Flags (u8)  |       PayloadLen (uint16 BE)  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     Payload (PayloadLen bytes)                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| `FrameType` | Name | `StreamId` | Direction | Payload Layout & Semantics |
| :--- | :--- | :--- | :--- | :--- |
| `0x01` | `OpenRequest` | Client-assigned odd `u32` ($1, 3, 5\dots$) | C $\rightarrow$ S | `[MethodLen: u8][Method][UrlLen: u16 BE][TargetUrl][HeaderCount: u16 BE]( [NameLen: u16 BE][Name][ValLen: u16 BE][Val] )*`. `Flags & 0x01 != 0` (`END_STREAM`) if request has no body (`GET`/`HEAD`). |
| `0x02` | `ResponseHeaders` | Matching `StreamId` | S $\rightarrow$ C | `[StatusCode: u16 BE][ProtoVersion: u8 (11/20/30)][HeaderCount: u16 BE]( [NameLen: u16 BE][Name][ValLen: u16 BE][Val] )*`. `Flags & 0x01 != 0` if response has no body. |
| `0x03` | `Data` | Matching `StreamId` | Both | Raw request or response body chunk ($1 \le \text{PayloadLen} \le 65\,535$). `Flags & 0x01 != 0` (`END_STREAM`) marks final body chunk simultaneously. |
| `0x04` | `EndStream` | Matching `StreamId` | Both | Empty payload (`PayloadLen = 0`). Cleanly closes the write half of `StreamId`. |
| `0x05` | `CancelStream` | Matching `StreamId` | Both | `[ErrorCode: u32 BE][ReasonUTF8]`. Immediately aborts `StreamId`. When sent C $\rightarrow$ S, server cancels the upstream `CancellationTokenSource` to stop H3/H2 upstream generation. |
| `0x06` | `Ping` | `0` | Both | `8-byte opaque payload`. Keep-alive heartbeat. |
| `0x07` | `Pong` | `0` | Both | Echoes the 8-byte `Ping` payload. |

### 5.3 Writer Serialization & Flush Discipline
- Because all multiplexed streams on a single pipe share one directional `ZstandardStream` + AEAD counter, a single writer actor / `Channel<Frame>` serializes outbound frames per pipe.
- **Batching without Latency**: The writer loop drains all immediately available frames from the `ChannelReader` (`TryRead`) up to 64 KiB, writes them into the `ZstandardStream`, calls `FlushAsync()` **once per drained batch**, seals the resulting compressed bytes into an AEAD chunk, and flushes the socket. When only a single SSE token frame is ready, it flushes immediately with **zero artificial timer delay**.

---

## 6. Upstream Proxy Rules (`zproxy server` $\rightarrow$ Target Origin)

### 6.1 HTTP/3 First with Automatic Fallback
`zproxy server` maintains a shared, singleton `HttpMessageInvoker` / `HttpClient` backed by `SocketsHttpHandler`:
```fsharp
let handler =
    new SocketsHttpHandler(
        AutomaticDecompression = DecompressionMethods.None, // Preserve or stream as-is; Zstd pipe handles link compression
        UseCookies = false,
        AllowAutoRedirect = false, // Pass 3xx redirects back to caller transparently
        PooledConnectionLifetime = TimeSpan.FromMinutes(10.0),
        PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2.0),
        MaxConnectionsPerServer = 256,
        EnableMultipleHttp2Connections = true,
        EnableMultipleHttp3Connections = true,
        ConnectTimeout = TimeSpan.FromSeconds(5.0)
    )
```
Per outgoing `HttpRequestMessage`:
```fsharp
req.Version <- HttpVersion.Version30
req.VersionPolicy <- HttpVersionPolicy.RequestVersionOrLower
```
- **Why `AutomaticDecompression = DecompressionMethods.None` (or conditional)**:
  - If the client sends `Accept-Encoding: gzip, deflate, br, zstd` and the upstream returns `br`-compressed JSON, passing the compressed bytes through (or letting `zproxy` strip `Accept-Encoding` on request and compress everything uniformly with the cross-turn Zstd stream) must be deliberate:
  - **Recommended Default**: Strip `Accept-Encoding` on the upstream request (or set `Accept-Encoding: identity`) for `application/json` / `text/event-stream` so the upstream sends uncompressed UTF-8 text into `zproxy server`, allowing `zproxy server`'s long-lived Zstd stream to compress it with cross-turn dictionary sharing, and delivering clean uncompressed bytes to `omp` on `127.0.0.1`. If the client explicitly sets `X-Zproxy-Pass-Encoding: 1`, preserve original `Accept-Encoding`.

### 6.2 Header Sanitization (MITM / Reverse-Proxy Unwrapping)
Before forwarding to the target URL:
1. Rewrite `Host` authority to match the target URI's `Host:Port`.
2. Strip all hop-by-hop and proxy-identifying headers:
   - `Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`
   - `Via`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded`
3. Preserve all application headers (`Authorization`, `Content-Type`, `Accept`, `User-Agent`, `X-Stainless-*`, Anthropic/OpenAI/Google headers) verbatim.
4. Inject `X-Client-Proto` / `X-Upstream-Proto` response diagnostic headers (`HTTP/3.0`, `HTTP/2.0`, `HTTP/1.1`) so the local caller can verify upstream protocol selection.

---

## 7. F# (.NET 9 / 10) Project Layout & Implementation Rules

### 7.1 Directory Structure (`~/zproxy`)
```
zproxy/
├── AGENTS.md
├── zproxy.sln
├── src/
│   └── ZProxy/
│       ├── ZProxy.fsproj
│       ├── Config.fs          // CLI args, env vars, defaults
│       ├── Crypto.fs          // Argon2id/HKDF key derivation, ChaCha20Poly1305/AesGcm chunk sealer/opener, replay window
│       ├── Frame.fs           // Sans-IO 8-byte multiplex frame encode/decode & Discriminated Unions
│       ├── ZstdPipe.fs        // Full-duplex ZstandardStream (Flush-per-batch) + AEAD pipe reader/writer
│       ├── UrlRoute.fs        // RawTarget parser: /https://... and /{hex-url} extractor & validator
│       ├── Upstream.fs        // SocketsHttpHandler (H3 -> H2 -> H1.1), header sanitizer, streaming body bridge
│       ├── TunnelClient.fs    // Persistent HTTP/1.1 :80 pool, auto-reconnect, stream multiplexer
│       ├── LocalServer.fs     // 127.0.0.1:<port> HTTP/1.1 listener for omp / SDKs
│       ├── RemoteServer.fs    // :80 HTTP/1.1 listener, auth gate, multiplex dispatcher, direct /{hex} handler
│       └── Program.fs         // Entrypoint: `zproxy client ...` and `zproxy server ...`
└── tests/
    └── ZProxy.Tests/
        ├── ZProxy.Tests.fsproj
        ├── CryptoTests.fs     // Key derivation, tamper rejection, replay window tests
        ├── FrameTests.fs      // Round-trip property tests for all Frame DU cases
        ├── UrlRouteTests.fs   // Raw path /https://... and /{hex} edge cases (queries, double slashes)
        └── EndToEndTests.fs   // Full client <-> server <-> mock H2/H3 upstream streaming SSE & cancellation tests
```

### 7.2 CLI Contract (Single Binary)
```bash
# Server mode (listens on :80 by default)
zproxy server \
  --listen 0.0.0.0:80 \
  --password-env ZPROXY_PASSWORD \
  [--bind-interface eth0]

# Client mode (listens on deterministic local high port, e.g. 127.0.0.1:18080)
zproxy client \
  --listen 127.0.0.1:18080 \
  --server http://cdg0v4.kw92.cyou:80 \
  --password-env ZPROXY_PASSWORD \
  [--connections 2]
```

### 7.3 Strict F# Engineering Invariants
1. **Use `task { }` everywhere on hot paths**: Never use legacy F# `async { }` or `MailboxProcessor` on per-frame I/O paths. Use `FSharp.Control.TaskBuilder` (`task { }`), `ValueTask`, `System.Threading.Channels.Channel<'T>`, and `ArrayPool<byte>.Shared`.
2. **Zero Response Buffering for SSE**:
   - Always call `SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)` on `HttpClient`.
   - Always disable response buffering on the local HTTP server (`IHttpResponseBodyFeature.DisableBuffering()`) and flush the response stream after every `Data` frame.
3. **End-to-End Cancellation Propagation**:
   - When `omp` aborts a local request (`HttpContext.RequestAborted`), `zproxy client` MUST immediately enqueue `CancelStream(streamId)` and remove the local stream waiter.
   - When `zproxy server` receives `CancelStream(streamId)`, it MUST cancel the per-stream `CancellationTokenSource` passed to `HttpClient.SendAsync` and response stream copy.
4. **Auto-Heal & Reconnect**:
   - If the cross-border `:80` TCP connection drops or hits a read/write timeout (`Ping`/`Pong` watchdog every 15s), `zproxy client` transparently establishes a fresh HTTP/1.1 pipe on the next request (and retries in-flight requests whose `ResponseHeaders` have not yet arrived).
5. **Linux HTTP/3 & Physical Interface Binding**:
   - On Linux (`Debian 13` / `Manjaro`), ensure `libmsquic` is installed so `.NET`'s `SocketsHttpHandler` enables QUIC/HTTP/3.
   - On `cdg0v4.kw92.cyou`, run `zproxy.service` under user `caddy` (or `zproxy`) with `RestrictNetworkInterfaces=lo eth0` and the `dev eth0` IPv6 policy routing table (`table 195`) so outbound connections never traverse `he-ipv6`.