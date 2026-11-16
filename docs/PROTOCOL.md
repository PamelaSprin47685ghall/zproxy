# zproxy v4 传输协议

本文描述当前实现的用户认证、HTTP 外层、加密记录、请求帧和下行元数据。源码入口为 [Crypto.fs](../src/ZProxy/Crypto.fs)、[Users.fs](../src/ZProxy/Users.fs)、[HttpWire.fs](../src/ZProxy/HttpWire.fs)、[Handshake.fs](../src/ZProxy/Handshake.fs)、[Frame.fs](../src/ZProxy/Frame.fs)、[Contracts.fs](../src/ZProxy/Contracts.fs)、[Tunnel.fs](../src/ZProxy/Tunnel.fs) 和 [Session.fs](../src/ZProxy/Session.fs)。

## 1. 版本与连接范围

**v4 与旧传输不兼容，必须同时升级两端。** 本版更新 hello、会话 HKDF 标签和响应元数据，增加受限的 OMP 解码配方。UUID 的持久密钥派生保留 v3 的标签，因此已有 users.json、用户 UUID 和统计可以继续使用。远端隧道监听器只接受 `POST /tunnel HTTP/1.1`，没有旧协议回退或 Upgrade 协商。

本地入口只接受 `POST /v1/chat/completions` 和 `POST /v1/completions`，方法和原始路径必须精确匹配，不接受查询参数。请求不携带目标服务地址。server 使用自己的 `--gateway` 配置选择固定 HTTP/HTTPS authority，或通过 `--omp --omp-config` 启动远端 OMP 插件；上游凭据、账号状态、模型路由与共享健康决策由远端持有。

一个 client 进程按需建立一条隧道。一个 TCP 连接只运行一次外层 HTTP 请求/响应交换；其请求体和响应体持续承载所有内层请求。连接断开时，压缩历史和所有活动请求一起结束。新请求可建立新连接，旧请求不重放。

## 2. 外层 HTTP/1.1

client 发送以下请求头，行末使用 CRLF：

```http
POST /tunnel HTTP/1.1
Host: relay.example:8080
Content-Type: application/octet-stream
Transfer-Encoding: chunked
Connection: keep-alive

```

请求体按顺序发送 **32 字节用户 selector、32 字节前导、一个加密 hello**。selector 和前导未加密。server 先按 selector 找到启用的用户认证密钥，再验证 hello、重放状态与资源限制，随后发送响应头和自己的加密 hello：

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Transfer-Encoding: chunked
Connection: keep-alive
Cache-Control: no-store

```

此时请求体尚未结束。两端随后同时读取对方的 body、写入自己的 body。正常 HTTP chunk 结构为十六进制长度、CRLF、该数量的数据字节、CRLF；body 完成标志为零长度 chunk。详见 [RFC 9112 §7.1](https://www.rfc-editor.org/rfc/rfc9112.html#section-7.1)。

这里的 keep-alive 表示持续使用该连接，不是在同一连接上排列多个外层 HTTP 请求。不会把 HTTP 头写完后直接切换为无 chunk 边界的裸 TCP。没有 `Upgrade`、`101`、WebSocket 帧或 CONNECT。

HTTP chunk、AEAD 记录和内层请求帧的边界互相独立。读取头和正文共享同一个缓冲读取器，已预读到的 body 字节必须保留。外层解析器的限制如下：

| 项目 | 限制或行为 |
| --- | --- |
| 一行 HTTP 文本 | 最多 8 KiB |
| 一个完整 HTTP head | 最多 32 KiB、128 个字段 |
| 握手的正文分帧 | 恰好一个 `Transfer-Encoding: chunked`；不得出现 `Content-Length` |
| 请求 Host | 恰好一个非空字段 |
| 重复 Content-Length 或同时出现长度与传输编码 | 拒绝 |
| chunk extension | 校验语法后忽略 |
| trailer | 读完但不交给加密层；拒绝改变正文分帧或路由的关键字段 |
| chunk 中途 EOF、缺失 CRLF、截断记录或帧 | 失败并关闭会话 |

握手错误关闭连接，不触发上游请求。该行为不依赖伪造的 HTTP 错误页。

外层 HTTP 头、连接地址、selector、前导、流量长度和时序可见。逻辑请求路径、白名单内的 HTTP 头、正文与下行元数据位于加密记录中。兼容这一格式不等于保证中间设备支持同时上传和下载；部署时需验证实际链路。

## 3. 用户密钥、selector 与前导

服务端为每位用户生成随机 UUIDv4，并单独保存稳定的内部用户 ID。输入 UUID 采用带连字符的 36 字符 `D` 格式，允许大小写，但必须是版本 4、RFC variant；派生前统一为小写规范形式 `uuid`。以下 `\0` 表示一个 NUL 字节，不是反斜杠和数字字符：

| 派生结果 | 算法 | 长度与用途 |
| --- | --- | --- |
| `selector` | `SHA256(ASCII("zproxy-v3-user-selector\0" + uuid))` | 32 字节；公开的用户密钥查找标识 |
| `userKey` | `SHA256(ASCII("zproxy-v3-user-key\0" + uuid))` | 32 字节；认证和会话密钥派生 |

UUID 原文不进入隧道握手，也不写入服务器用户文件；它只在管理创建或更新响应中返回一次，由管理员交给用户。server 保存 selector 和 userKey。userKey 足以完成该用户的认证，必须像原 UUID 一样保密，不能把它当成可公开的验证摘要。管理主密码独立用于管理会话，不参与隧道密钥派生，也不交给 client。

同一 UUID 的 selector 固定且公开，因此旁观者可以关联它的不同连接；知道 selector 本身不能通过 hello 认证。更新 UUID 同时更换 selector 和 userKey，取消旧凭据的现有连接。稳定内部 ID 不变，历史统计保留。停用用户也会取消现有连接，移除可用于新握手的凭据。

HTTP chunk 解码后的请求体起始布局为：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 32 | 用户 selector |
| 32 | 32 | 本次连接的前导 |
| 64 | 31 | client hello 记录：3 字节长度、12 字节密文、16 字节 tag |
| 95 起 | 不定 | client 到 server 的普通加密记录 |

前导每次重新生成，其内部布局为：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 24 | 随机盐 |
| 24 | 8 | Unix 毫秒时间戳，带符号 64 位大端整数 |

HKDF-SHA256 以 `userKey` 为 IKM、完整 32 字节前导为 salt。两个方向分别使用 ASCII `zproxy-v4-key-c2s` 和 `zproxy-v4-key-s2c` 作为 Expand 的 info，派生各自的 32 字节会话密钥。服务端响应体直接从自己的 31 字节 hello 记录开始，不重复 selector 或前导。

server 先验证 client hello 的 AEAD，再登记重放状态。默认接受距当前时间正负 300000 ms 内的前导；已接受的盐保留 600000 ms。重放表最多 65536 项，表满时拒绝新会话。该表只在内存中，重启会清空。两端需要有足够接近的时钟。

未知或停用的 selector 在 hello 解密前被拒绝。用户认证成功并通过连接配额检查后，才分配会话的压缩上下文；上游请求还要等待有效 OpenRequest。每用户连接配额在握手认证后检查，超出时关闭连接。这个 PSK 方案没有前向保密：userKey 泄漏后，已捕获的公开前导足以派生该用户对应的历史会话密钥。

## 4. Hello 与额度协商

两个方向各发送一个未经过 Zstd 压缩的加密 hello。它占用各自方向的 AEAD 序号 **0**，解密后的内容固定为 12 字节：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 4 | ASCII `ZPX4` |
| 4 | 1 | 上行 Zstd window log |
| 5 | 1 | 下行 Zstd window log |
| 6 | 2 | 最大同时流数，uint16 大端 |
| 8 | 4 | 每流每方向的正文额度，正数 int32 大端 |

client 发提议，server 按四项各自取最小值回复。两端校验窗口 log 为 `10..23`、流数为 `1..256`、正文额度为 `16384..4194304`，并校验流数乘正文额度不超过 64 MiB。client 同时拒绝超出自己提议的回复。

完成 hello 后，普通记录从序号 **1** 开始。上行指 client 到 server，下行指 server 到 client；两端据此选择压缩器窗口及解压器允许的最大窗口。

## 5. AEAD 记录与 Zstd

所有记录使用 ChaCha20-Poly1305。没有算法协商，也没有 AES 分支。

| 字段 | 长度 | 内容 |
| --- | --- | --- |
| 明文长度 | 3 字节 | uint24 大端，范围 `1..65536` |
| 密文 | 等于明文长度 | hello 或 Zstd 输出的加密字节 |
| 认证标签 | 16 字节 | Poly1305 tag |

nonce 为 12 字节：前四字节是 ASCII `C2S` 加零字节，或 `S2C` 加零字节；后八字节是该方向严格递增的 uint64 大端序号。序号由接收端维护，不在记录中另行发送。

序号 0 的 AAD 是完整 32 字节前导加 3 字节长度字段。后续记录的 AAD 是 3 字节长度字段。方向密钥和 nonce 分开，序号耗尽时拒绝继续使用。长度、方向、顺序或认证标签不正确都使会话失败。

hello 后的内层帧先序列化，再进入该方向唯一的长寿命 Zstd 上下文，最后加密。压缩等级为 3；每批立即可用的帧数据最多 32 KiB，使用 `ZSTD_e_flush` 刷新，不重建上下文。写者不会为凑满批次增加计时等待。

解压在认证成功后进行。每个输入记录最多 64 KiB 压缩字节，每次解压输出也限制为 64 KiB；解压器同时拒绝超出协商值的 Zstd 窗口。帧可以跨记录，记录可以含多个帧；接收端据内层长度重新组装。

## 6. 内层帧

所有多字节数值均为大端序。每帧头固定为 8 字节：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 4 | stream ID，uint32 |
| 4 | 1 | 帧类型 |
| 5 | 1 | flags；仅 bit 0 表示该方向正文结束 |
| 6 | 2 | payload 长度，uint16 |

client 分配递增、非零的奇数 stream ID，同一会话不重用。ID 0 只用于 Ping/Pong。普通 payload 最多 32768 字节，Data payload 最多 16384 字节。未知类型、未知 flags、错误长度、无效 UTF-8 或多余尾部字节均被拒绝。

本文中的 `text16` 表示一个 uint16 字节长度和随后的严格 UTF-8 字节。`headers` 表示 uint16 字段数，加重复的 `text16(name), text16(value)`；最多 128 个字段。字段名必须是 HTTP token，字段值不得包含换行或其他被禁止的控制字符。整个 payload 共用 32 KiB 上限。

| 类型 | 名称 | payload | 方向与作用 |
| --- | --- | --- | --- |
| `0x01` | OpenRequest | uint8 方法长度、方法字节、`text16(path)`、`headers` | client 开启请求；业务层只接受 POST 和两个 completion 路径；可带结束 flag |
| `0x02` | ResponseHeaders | uint16 状态码、uint8 HTTP 版本、`headers`、`metadata` | server 返回状态、头和下行解码信息；HTTP 版本为 `1`、`2`、`3`；可带结束 flag |
| `0x03` | Data | 1..16384 字节正文 | 任一方向；可带结束 flag |
| `0x04` | EndStream | 空 | 结束发送方的正文；flags 必须为零 |
| `0x05` | CancelStream | `text16(reason)`；reason 最多 1024 字节 | 取消整条逻辑请求 |
| `0x06` | Ping | 8 字节不透明数据 | stream ID 0 |
| `0x07` | Pong | 原样回送 Ping 数据 | stream ID 0 |
| `0x08` | WindowUpdate | uint32 正数正文额度，最多 Int32.MaxValue | 归还已消费的正文字节额度 |

只有 OpenRequest、ResponseHeaders、Data 可以设置结束 flag。状态码范围为 100..599。正文到达前必须已有对应的请求或响应头；重复响应头等错误状态会关闭会话。取消后可能仍到达的已排队帧不会重新创建请求。

### ResponseHeaders 的 metadata

元数据紧接 `headers`，不单独用 JSON 编码。顺序固定如下；全部字段和 HTTP headers 一起受帧的 32 KiB payload 上限约束：

| 顺序 | 编码 | 含义与限制 |
| --- | --- | --- |
| 1 | uint8 | 元数据 schema，固定为 `2` |
| 2 | `text16` | `Decoder`，HTTP token，1..64 ASCII 字节 |
| 3 | uint16 | 解码器 `Version`，`1..65535` |
| 4 | `text16` | `ModelAlias`，最多 128 UTF-8 字节，可为空 |
| 5 | `text16` | `RequestId`，最多 64 UTF-8 字节，可为空 |
| 6 | uint16 | `Attempt`，`1..65535` |
| 7 | uint8 | `IsStreaming`，只能为 `0` 或 `1` |
| 8 | `text16` | `Recipe`，最多 8192 UTF-8 字节；identity 模式为空，OMP 模式为严格受限的 JSON 字符串 |

文本必须是严格 UTF-8，元数据字符串不能含控制字符。schema 不认识、字段超限、枚举值非法或出现多余尾部字节都会拒绝该帧。schema 版本与解码器版本是两个不同字段。

白名单描述的是如何解码本次响应，不能包含账户快照、UUID、selector、内部用户 ID、token、Cookie、Authorization 或完整上游请求头；字段值的来源也必须满足这条边界。没有可放入任意账户对象的扩展字典。

默认固定网关返回 `Decoder="openai-completions"`、`Version=1`、空 ModelAlias 和 Recipe、server 新建的请求标识、`Attempt=1`；`IsStreaming` 按网关 Content-Type 是否为 `text/event-stream` 设置。本体不会解析 model JSON，也不会用 Attempt 自动重试。内建解码器原样返回该响应；其他 `(Decoder, Version)` 必须有显式注册的本地解码器，否则释放原始响应并让该请求失败。

OMP 插件使用 `Decoder="omp-response"`、`Version=1`。配方只允许 api、provider、id、reasoning、input、contextWindow、maxTokens、compat 八个字段；compat 只允许解析器所需的八个已知选项。禁止附加 URL、headers、apiKey、账户、路由配置和任意扩展字段；重复键也被拒绝。准确字段和枚举由 [OmpMetadata.fs](../src/ZProxy/OmpMetadata.fs) 与 [contract.mjs](../plugins/omp/contract.mjs) 共同约束。它是解析配方，不是能够重新发起上游请求的配置。

## 7. 正文流控与队列

每条流的每个方向初始发送额度都是协商的 `stream-window-bytes`。发送 Data 前扣除正文长度；发送块可以按当前剩余额度继续分割，不必等到凑足原来的读缓冲大小。没有额度时，该流的生产者等待，尚未进入公共写队列。接收端读取正文后累积已消费字节，达到窗口容量的一半时用 WindowUpdate 归还，不能把窗口增加到初始容量以上。正文已经结束时不再为它发送额度更新。

这个额度按未压缩正文计算，与 HTTP chunk 长度和压缩比无关。接收端如果收到超额正文，会关闭会话，而不是让该流无限占用内存。

隧道只有一个写者。取消、心跳和额度更新可以先于普通数据发送，避免数据队列已满时无法取消或归还额度。

| 资源 | 当前边界 |
| --- | --- |
| 普通出站帧队列 | 16 帧；满时生产者等待 |
| 取消/心跳控制队列 | 64 帧；满时关闭会话 |
| 待发送的 WindowUpdate | 按 stream ID 合并，最多 256 项 |
| 先于 OpenRequest 到达的取消标识 | 最多 64 项 |
| 写批次 | 最多 32 KiB 未压缩帧字节 |
| 每帧 payload | 最多 32 KiB；Data 最多 16 KiB |
| 每流每方向未消费正文 | 协商值，默认 256 KiB |
| 每会话每接收方向正文总预算 | 默认 4 MiB，配置上限 64 MiB |
| server 同时接受的连接/握手 | 默认 16，可配置到 1024 |
| 单用户同时隧道 | 默认 2；不超过 server 总连接上限，认证后检查 |

这些边界不能相加后当作 RSS：Zstd 的本地上下文、管道内存分段、在执行的生产者、HTTP/TLS 缓冲和对象开销都另占内存。server 的连接数会成倍增加会话相关开销。

默认上行窗口为 8 MiB、下行窗口为 1 MiB。对应地，client 持有上行压缩器与下行解压器，server 持有上行解压器与下行压缩器。这是两个方向的资源配置，不是速度或峰值内存测量结果。

## 8. 请求生命周期、取消与重连

OpenRequest 建立一个逻辑请求。隧道的请求体和响应体独立传输，传输层允许请求体尚未结束时返回响应。这只描述隧道能力：普通上游 `HttpClient` 的 HTTP/1.1 请求可能等待上传完成后才把响应交给调用者，不能据此假定任意上游都支持无限双工。

EndStream 结束一个方向，CancelStream 取消整条请求。本地 HTTP 服务可观测到的取消、明确的连接中止和代理内部响应正文的释放都会参与流资源清理，并传递给上游 HTTP 工作。TCP FIN 可以是合法的发送半关闭，本身不等于取消。

client 的请求槽位限制同时在途请求数。等待槽位也受请求取消约束。server 对超过协商数量的开启请求视为协议错误。

每隔 20 秒发送心跳；超过 60 秒没有收到任何帧时，下一次心跳检查会关闭会话。TCP EOF、认证错误、无法恢复的队列错误和协议错误也会结束会话，并唤醒等待正文、额度或响应头的任务。

失败不会自动重放已发出的请求。即使还没有收到 ResponseHeaders，server 也可能已经把请求交给目标服务。已有请求失败后，由新的应用请求触发重连；新会话使用新的盐、密钥、计数器和 Zstd 历史。

本地 HTTP 响应头尚未发送时，代理失败返回 502。响应已经开始时关闭该响应，不把错误文本插入 SSE 或其他正文。

## 9. HTTP 适配与插件边界

本地入口通过 Kestrel 原始 request target 校验两个允许的 completion 路径，内层 OpenRequest 传递逻辑路径。server 不使用客户端指定的 authority；默认 `UpstreamClient` 按自身 `--gateway` 构造请求。网关地址不能带用户信息、业务路径、查询或片段。

请求头白名单为 Content-Type、Content-Length、Accept、Accept-Encoding；响应头白名单为 Content-Type、Content-Length、Content-Encoding、Cache-Control、Retry-After。两个方向都先移除逐跳头、`Connection` 点名字段及转发标识。server 重建 Host，可从 `--gateway-token-env` 指定的服务器环境变量加入 bearer token。客户端的 Authorization、Cookie、API key 不转发，网关的 Set-Cookie、账户标识等响应头也不转发。过滤不解析或删改正文。

本地默认用 `Accept-Encoding: identity` 请求网关。`X-Zproxy-Pass-Encoding: 1` 可保留调用者的原始编码协商，此控制头随后移除。上游连接不自动解压，不跟随重定向，也不维护 Cookie jar。Content-Encoding 与未解码正文保持一致。响应使用 `ResponseHeadersRead`，正文逐块回到本地并刷新。

`IProxyPlugin.Wrap` 在 client 的 HTTP handler 链上组合；第一个注册的插件位于最外层。插件可自己返回响应，在没有远端连接时完成短路。`IResponseDecoder` 根据第 6 节的版本化元数据处理原始下行。分别通过 `Client.run options plugins ct` 和 `Client.runWithDecoders options plugins decoders ct` 显式组合。命令行 `--omp` 注册已编译的桥接器并管理随包 Bun 子进程；未启用时不启动或加载 OMP。NativeAOT 不提供运行时程序集扫描或插件发现协议。

`RemoteHandler` 接收服务器认证得到的 `Users.Identity`，返回原始 `HttpResponseMessage` 和元数据。身份不来自请求正文或客户端 HTTP 头。OMP 插件在官方网关完成账户和路由选择之后，截获成功的上游 HTTP/SSE Response，使远端的 provider 解析器不开始消费成功正文。本地复用相同版本的官方解析器与 OpenAI 编码器。远端继续做有限的首段错误检查、usage 采样，以及 Google continuation 所需的后续认证请求。

没有可截获 fetch/Response 的特殊传输继续运行官方远端语义流程，再使用 identity 解码器返回；这类路径保留可用性，但没有获得下行计算转移。固定网关适配器同样要求响应已经是 OpenAI completions。具体支持矩阵和旧 shim 处置见 [OMP_PARITY.md](OMP_PARITY.md)。

handler 的调用者持有输入请求，并负责在最终响应使用完后释放它。请求插件借用输入请求，丢弃下层响应时须释放它。解码器接管原始响应：可以原样返回，或把原始响应的生命周期交给返回的正文流，也可以在不再使用它时关闭；失败和取消仍须清理。不能在返回流仍依赖原始响应时提前释放。解码器得到原始本地请求对象，但正文可能已经读完；请求插件需要的解析上下文应在转发前保留，例如放入 `request.Options`，本体不会缓存或重放上传供解码器读取。插件自建的请求、进程、任务和实例由其创建者管理，client 不自动销毁插件实例。

### OMP 私有进程接口

每个 F# 角色拥有一个 Bun 子进程和一个 0700 临时目录，IPC 使用其中的 Unix socket。子进程先输出 `READY`，F# 随后启动服务；子进程异常退出会取消服务。关停先发送 `/shutdown`，超时后结束进程树并清理临时文件。IPC 也是 HTTP/1.1 chunked，上传与下载由独立任务同时进行，不经过可能等待上传完成的 HttpClient。

远端私有请求中，F# 生成内部用户 ID 和 base64url 编码的昵称。成功原始响应使用私有 `X-Zproxy-Decode: 1` 标记，正文为 `uint32(metadataBytes)`、最多 16 KiB 元数据 JSON、原始上游字节。F# 在计量正文前取走前缀；前缀不会计入上游 responseBytes。其余响应为 identity 模式。

本地 `/decode` 请求为 `uint32(envelopeBytes)`、最多 64 KiB envelope JSON、原应用请求正文、原始上游正文。envelope 明确给出 requestBytes、原入口路径、元数据、状态和安全响应头。原应用请求在上传时写入受限的 0600 临时文件，最大 64 MiB；F# 不再保留完整内存副本。文件随最终响应释放而删除。Bun 本地解析器需要构建受限的原请求上下文，并流式读取后续原始响应；不用等待原始响应 EOF 才返回 SSE。

本地子进程继承的环境经过白名单筛选，独立的 OMP 目录位于临时目录中。解码 fetch 是只能消费传入 Response 一次的函数；禁止发起真正网络请求、刷新账户或重试。远端配置和凭据文件没有传入本地进程。

## 10. 管理与统计边界

管理服务是独立的 HTTP 监听器，默认 `127.0.0.1:18081`，不走 `/tunnel`。其主密码默认来自 `ZPROXY_ADMIN_PASSWORD`；client 的 UUID 默认来自 `ZPROXY_USER_UUID`。两者不能互相替代。

| 路径 | 方法 | 访问条件与结果 |
| --- | --- | --- |
| `/`、`/reports` | GET | 公开报告页面 |
| `/api/reports` | GET | 公开 `{ "users": [...] }`，只含昵称和计数 |
| `/admin`、`/admin/` | GET | 登录及用户管理页面；只允许私有传输条件 |
| `/admin/login` | POST | JSON `{ "password": "..." }`，验证主密码后设置会话 Cookie |
| `/admin/logout` | POST | 管理会话，删除会话和 Cookie |
| `/admin/api/users` | GET | 管理会话，返回内部 ID、昵称、启用状态和创建时间，不返回 UUID |
| `/admin/api/users` | POST | 管理会话，JSON `{ "nickname": "..." }`，返回用户信息及一次性 UUID |
| `/admin/api/users/{id}/rotate` | POST | 管理会话，更新凭据并返回一次性 UUID，保留身份和统计 |
| `/admin/api/users/{id}` | DELETE | 管理会话，停用用户并终止旧连接，保留历史 |

所有写操作包括登录都要求一个与当前页面 scheme、host、port 一致的 Origin。JSON 正文最多 4 KiB，要求精确字段和类型。会话 token 为 32 字节随机数，服务端存其摘要；最多 64 个会话，绝对有效期 30 分钟，登录最多 8 次/分钟且最多一个同时执行的验证。Cookie 为 HttpOnly、SameSite=Strict、Path=/admin，HTTPS 下为 Secure。响应使用 no-store；页面不使用浏览器持久存储，昵称通过 textContent 显示。

私有传输允许直接 loopback HTTP，或 HTTPS。部署通过 loopback 反向代理终止 HTTPS 时，代理须保留外部 Host 并设置单值 `X-Forwarded-Proto: https`；只有 loopback 来源才信任该声明。带转发标记的明文代理请求不视为直接本机请求，任意远端来源不能靠伪造转发头取得信任。远端明文 HTTP 下连管理密码表单也不会输出，公开报告仍可读取。

服务端身份绑定统计，公开行只包含 nickname、requests、succeeded、failed、canceled、active、requestBytes、responseBytes、durationMs。内部 ID、selector 和认证材料不进入公共 JSON、HTML 或 DOM。统计只保存汇总，不解析模型 token。

requestBytes 统计远端实际读取的请求正文，responseBytes 统计远端实际读取的网关响应正文；按请求结束时汇总，包含失败或取消前已读的部分。二者都是隧道压缩前的正文计数，不是线上的总字节。成功表示远端读到完整 2xx 响应 EOF，不能证明客户端已消费、解码或展示；durationMs 也不是客户端端到端耗时。本地短路请求没有远端记录。

私有目录含 users.json、stats.json、users.lock。users.json 保存派生认证密钥而非 UUID 原文，但派生密钥仍是等价秘密；stats.json 用内部 ID 保存已结束请求汇总；users.lock 限制同一目录只有一个 server 进程。新建目录使用 Unix 0700，数据和锁文件使用 0600；已有目录本身和父目录的权限由部署保持私有。用户变更同步写入，统计变更每 5 秒刷新并在正常关停时刷新。活动请求不持久化，异常退出可能丢失未落盘统计，不能据此精确计费。

## 11. 连接与兼容边界

所有逻辑流共享一条 TCP 字节流。应用层流控可以隔开慢消费者，但不能消除 TCP 丢包恢复对其他逻辑流的共同等待。

这一实现控制隧道的两端。缓冲请求体的反向代理、把最终响应解释为停止上传的 HTTP 客户端，以及限制长请求的中间设备，都可能破坏预期的同时读写。应使用项目的实际双工测试验证部署链路，不能仅凭 HTTP/1.1 外观判断 QoS 是否放行。

每位用户有独立认证密钥和连接配额，每条隧道有独立会话密钥、压缩历史与流预算。固定网关限制了目标 authority，当前没有按用户划分的模型授权、token 配额或计费系统，也没有持久重放表。NativeAOT 发布不改变这些协议边界，也不消除对运行系统 `libzstd.so.1` 的依赖。
