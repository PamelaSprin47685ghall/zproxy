# zproxy v2 传输协议

本文描述当前实现的 HTTP 外层、握手、加密记录和内层请求帧。源码入口为 [HttpWire.fs](../src/ZProxy/HttpWire.fs)、[Handshake.fs](../src/ZProxy/Handshake.fs)、[Crypto.fs](../src/ZProxy/Crypto.fs)、[Frame.fs](../src/ZProxy/Frame.fs)、[Tunnel.fs](../src/ZProxy/Tunnel.fs) 和 [Session.fs](../src/ZProxy/Session.fs)。

## 1. 版本与连接范围

**v2 与旧实现不兼容，必须同时升级两端。** 主密钥盐、HKDF 标签、握手和帧规则都属于 v2。远端只接受 `POST /tunnel HTTP/1.1`；没有 v1 回退、Upgrade 协商或旧的远端 hex URL 请求模式。本地入口仍接受完整 URL 前缀和 hex URL 前缀。

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

请求体开始于 32 字节前导和一个加密 hello。server 验证 hello、重放状态与资源限制后，立即发送响应头和自己的加密 hello：

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

外层 HTTP 头、连接地址、流量长度和时序可见。目标 URL、应用头与正文位于加密记录中。兼容这一格式不等于保证中间设备支持同时上传和下载；部署时需验证实际链路。

## 3. 主密钥、前导与认证

进程启动时从非空共享口令派生 32 字节主密钥：

| 项目 | 值 |
| --- | --- |
| 密码字节 | UTF-8 |
| 算法 | Argon2id |
| 盐 | `SHA256(UTF8("zproxy-v2-master-salt"))` |
| 内存 | 65536 KiB |
| 迭代次数 | 3 |
| 并行度 | 1 |
| 输出长度 | 32 字节 |

每条连接使用新的 32 字节明文前导：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 24 | 随机盐 |
| 24 | 8 | Unix 毫秒时间戳，带符号 64 位大端整数 |

HKDF-SHA256 以主密钥为 IKM、完整前导为 salt。两个方向分别使用 `zproxy-v2-key-c2s` 和 `zproxy-v2-key-s2c` 作为 Expand 的 info，派生各自的 32 字节会话密钥。

server 先验证 client hello 的 AEAD，再登记重放状态。默认接受距当前时间正负 300000 ms 内的前导；已接受的盐保留 600000 ms。重放表最多 65536 项，表满时拒绝新会话。该表只在内存中，重启会清空。两端需要有足够接近的时钟。

## 4. Hello 与额度协商

两个方向各发送一个未经过 Zstd 压缩的加密 hello。它占用各自方向的 AEAD 序号 **0**，解密后的内容固定为 12 字节：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 4 | ASCII `ZPX2` |
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
| `0x01` | OpenRequest | uint8 方法长度、方法字节、`text16(URL)`、`headers` | client 开启请求；方法为 ASCII token；可带结束 flag |
| `0x02` | ResponseHeaders | uint16 状态码、uint8 HTTP 版本、`headers` | server 返回状态与头；版本为 `1`、`2`、`3`；可带结束 flag |
| `0x03` | Data | 1..16384 字节正文 | 任一方向；可带结束 flag |
| `0x04` | EndStream | 空 | 结束发送方的正文；flags 必须为零 |
| `0x05` | CancelStream | `text16(reason)`；reason 最多 1024 字节 | 取消整条逻辑请求 |
| `0x06` | Ping | 8 字节不透明数据 | stream ID 0 |
| `0x07` | Pong | 原样回送 Ping 数据 | stream ID 0 |
| `0x08` | WindowUpdate | uint32 正数正文额度，最多 Int32.MaxValue | 归还已消费的正文字节额度 |

只有 OpenRequest、ResponseHeaders、Data 可以设置结束 flag。状态码范围为 100..599。正文到达前必须已有对应的请求或响应头；重复响应头等错误状态会关闭会话。取消后可能仍到达的已排队帧不会重新创建请求。

## 7. 正文流控与队列

每条流的每个方向初始发送额度都是协商的 `stream-window-bytes`。发送 Data 前扣除正文长度；发送块可以按当前剩余额度继续分割，不必等到凑足原来的读缓冲大小。没有额度时，该流的生产者等待，尚未进入公共写队列。接收端读取正文后累积已消费字节，达到窗口容量的一半时用 WindowUpdate 归还，不能把窗口增加到初始容量以上。正文已经结束时不再为它发送额度更新。

这个额度按未压缩正文计算，与 HTTP chunk 长度和压缩比无关。接收端如果收到超额正文，会关闭会话，而不是让该流无限占用内存。

隧道只有一个写者。取消、心跳和额度更新可以先于普通数据发送，避免数据队列已满时无法取消或归还额度。

| 资源 | 当前边界 |
| --- | --- |
| 普通出站帧队列 | 16 帧；满时生产者等待 |
| 取消/心跳控制队列 | 64 帧；满时关闭会话 |
| 待发送的 WindowUpdate | 按 stream ID 合并，最多 256 项 |
| 写批次 | 最多 32 KiB 未压缩帧字节 |
| 每帧 payload | 最多 32 KiB；Data 最多 16 KiB |
| 每流每方向未消费正文 | 协商值，默认 256 KiB |
| 每会话每接收方向正文总预算 | 默认 4 MiB，配置上限 64 MiB |
| server 同时接受的连接/握手 | 默认 16，可配置到 1024 |

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

本机入口用 Kestrel 的原始 request target 读取目标 URL。HTTP 的 Host、逐跳头、`Connection` 点名的字段及代理转发标识不进入下一跳；上游 Host 按目标 authority 重建。Content-Type、Authorization 等应用字段通过内层 headers 传输。

本地默认用 `Accept-Encoding: identity` 请求上游。`X-Zproxy-Pass-Encoding: 1` 可保留调用者的原始编码协商，此控制头随后移除。上游连接不自动解压，不跟随重定向，也不维护 Cookie jar。响应使用 `ResponseHeadersRead`，正文逐块回到本地并刷新。

`IProxyPlugin.Wrap` 只在 client 的 HTTP handler 链上组合。插件可包装下一层，或自己返回响应以短路隧道。注册是编译期显式传参；命令行入口当前使用空插件列表。v2 wire 不包含 OMP、模型语义、JS 运行时或插件发现协议。

handler 的调用者持有输入 `HttpRequestMessage`，并在使用完最终返回的 `HttpResponseMessage` 后释放它。插件借用输入请求；丢弃下层响应时应负责释放，被返回的响应及其正文则交给调用者。插件创建的替代请求和其他资源由插件管理，必须维持到其使用结束。handler 链在 client 启动时组合；`Client.run` 不销毁插件实例，实例生命周期由创建者管理。

## 10. 连接与兼容边界

所有逻辑流共享一条 TCP 字节流。应用层流控可以隔开慢消费者，但不能消除 TCP 丢包恢复对其他逻辑流的共同等待。

这一实现控制隧道的两端。缓冲请求体的反向代理、把最终响应解释为停止上传的 HTTP 客户端，以及限制长请求的中间设备，都可能破坏预期的同时读写。应使用项目的实际双工测试验证部署链路，不能仅凭 HTTP/1.1 外观判断 QoS 是否放行。

本实现不提供跨租户密钥、目标 URL 白名单或持久重放表。NativeAOT 发布不改变这些协议边界，也不消除对运行系统 `libzstd.so.1` 的依赖。
