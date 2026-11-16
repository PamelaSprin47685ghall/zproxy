# zproxy

zproxy 把 OpenAI completions 请求和响应压缩、加密，通过一条 HTTP/1.1 长连接传输。一个 F# / .NET 10 程序提供 `client` 和 `server` 两个角色，支持发布为 Linux x64 NativeAOT 程序。

当前实现使用 **v3 协议**，两端必须一起升级。每位用户使用独立 UUID；管理主密码和上游凭据留在服务器。旧的共享口令配置和在本地路径中嵌入目标地址的用法已删除。完整传输格式见 [PROTOCOL.md](docs/PROTOCOL.md)。

## 数据与职责

| 部分 | 当前职责 |
| --- | --- |
| 本机 client | 提供两个 completion 入口，维护一条按需建立的隧道，组合可选的本地插件和下行解码器 |
| 远端 server | 认证用户、限制连接、记录统计，将请求发给配置好的固定网关 |
| 远端 OMP 或兼容网关 | 持有上游账户凭据，负责账号选择、刷新、模型路由、重试决策和共享健康信息 |

应用使用 `http://127.0.0.1:18080/v1` 作为 base URL。本地只接受 `POST /v1/chat/completions` 和 `POST /v1/completions`，不接受查询参数、其他方法或其他路径；例如 `/v1/models` 不在本次接口范围内。

client 与 server 之间是一个 `POST /tunnel` 和一个长时间保持的 `200` 响应，两边的 chunked body 同时流动。多个逻辑请求用流编号共享这一 HTTP 交换。没有 WebSocket、HTTP Upgrade、CONNECT 或 HTTPS 证书拦截。外层使用 HTTP，正文中的请求帧和响应帧经过 Zstd 压缩与 ChaCha20-Poly1305 加密。

每个方向保留自己的 Zstd 历史，直到隧道关闭。本体不解析 `model`、`messages` 或 SSE 事件中的模型语义。服务器到固定网关使用普通 HTTP 或 HTTPS，共享一个 HTTP 连接池；允许 HTTP/3，并按平台、目标服务和协商结果回落到 HTTP/2 或 HTTP/1.1。

**默认网关必须已经提供 OpenAI completions 响应。** 当前内建的 `openai-completions` v1 解码器直接返回这些字节，因此尚未把 OMP 的解析、转换 CPU 工作移到本机。原始下行加元数据的接口已经预留，OMP 重插件、对应的远端接入补丁、Bun/JS 运行时与 AppImage 打包仍未实现。

## 构建

[global.json](global.json) 选择 .NET 10.0.404 SDK，并允许同一功能版本内的后续补丁。Linux NativeAOT 构建需要本地编译工具和 Zstd 库。以 Debian / Ubuntu 为例：

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends -y clang libzstd-dev zlib1g-dev
dotnet restore zproxy.slnx
dotnet test zproxy.slnx --configuration Release --no-restore
dotnet publish src/ZProxy/ZProxy.fsproj --configuration Release \
  --runtime linux-x64 --self-contained true -p:PublishAot=true \
  --output artifacts/linux-x64
python3 scripts/smoke-native.py --binary artifacts/linux-x64/ZProxy
```

输出程序为 `artifacts/linux-x64/ZProxy`。NativeAOT 产物不要求另装 .NET 运行时，但仍动态使用 **`libzstd.so.1`**；Debian / Ubuntu 运行机器需要 `libzstd1`。当前绑定使用 Linux 库名，CI 发布目标为 Linux x64。运行系统还需满足产物的系统库兼容要求，见 [.NET NativeAOT 部署说明](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)。发布流程不把这些系统库打包进可执行文件。

## 启动与生成用户

### 1. 在远端设置管理主密码

以下 Bash 命令从终端读取密码，不把密码放进命令参数：

```sh
read -rsp 'Admin password: ' ZPROXY_ADMIN_PASSWORD
printf '\n'
export ZPROXY_ADMIN_PASSWORD
```

主密码只用于管理页面，不是用户隧道密钥。默认读取 `ZPROXY_ADMIN_PASSWORD`，也可用 `--admin-password-env NAME` 指定变量。没有默认密码；空值和全空白值被拒绝，UTF-8 长度最多 1024 字节。

若固定网关需要 bearer token，在**远端**读取另一个环境变量：

```sh
read -rsp 'Gateway token: ' ZPROXY_GATEWAY_TOKEN
printf '\n'
export ZPROXY_GATEWAY_TOKEN
```

### 2. 启动远端 server

假设远端已有网关监听 `127.0.0.1:3000`：

```sh
./artifacts/linux-x64/ZProxy server \
  --listen 0.0.0.0:8080 \
  --gateway http://127.0.0.1:3000 \
  --gateway-token-env ZPROXY_GATEWAY_TOKEN \
  --web-listen 127.0.0.1:18081 \
  --data-dir ./data
```

网关不需要 token 时，省略 `--gateway-token-env`。`--gateway` 必填，只能是固定 HTTP/HTTPS authority，如 `https://gateway.example:443`；不能带账户信息、业务路径、查询或片段。server 把允许的 `/v1/...` 路径拼到该地址，客户端不能指定其他目标。zproxy 不负责启动 OMP。

示例隧道端口是 8080；server 默认隧道监听地址为 `0.0.0.0:80`。管理与报告使用独立监听器，默认是 `127.0.0.1:18081`。

### 3. 从管理页面生成 UUID

在服务器本机访问 `http://127.0.0.1:18081/admin`，输入主密码，填写昵称，生成用户 UUID。管理机也可以通过 SSH 本地端口转发访问这个 loopback 页面。

昵称去除首尾空白后为 1..64 个字符，不能含控制字符；不区分大小写检查重名。最多保存 10000 个用户记录，停用记录仍占用该数量。UUID 使用随机 UUIDv4，只在创建或更新时显示一次；列表不会再次返回原值。把它单独交给对应用户，不要交付主密码或网关 token。

更新 UUID 会立即取消旧凭据对应的连接；停用用户也会取消其连接。更新保留用户身份和历史统计，并重新启用该用户；停用保留昵称和历史统计。

### 4. 在本机启动 client

```sh
read -rsp 'User UUID: ' ZPROXY_USER_UUID
printf '\n'
export ZPROXY_USER_UUID

./artifacts/linux-x64/ZProxy client \
  --listen 127.0.0.1:18080 \
  --server http://relay.example:8080
```

把 `relay.example` 替换为服务器地址。默认读取 `ZPROXY_USER_UUID`，也可用 `--uuid-env NAME` 指定。UUID 必须是带连字符的 UUIDv4；大小写输入会归一化。`--server` 只接受 `http://host[:port]` 或 `http://host[:port]/tunnel`，实际请求路径固定为 `/tunnel`。

应用的 base URL 设置为 `http://127.0.0.1:18080/v1`：

```sh
curl --no-buffer 'http://127.0.0.1:18080/v1/chat/completions' \
  -H 'Content-Type: application/json' \
  --data-raw '{"model":"your-model","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

本地 HTTP 入口不要求 bearer token；UUID 用于 client 到 server 的隧道认证。某些 SDK 要求填写 API key 时可填本地占位值，应用发来的 Authorization 不会被用作上游凭据。将本地监听器绑定到 loopback，使本机应用通过这个已配置的用户身份发请求。

## 管理、公开报告与数据文件

`/` 和 `/reports` 是无需登录的统计页，`/api/reports` 是同样公开的 JSON API。它们只输出昵称与 `requests`、`succeeded`、`failed`、`canceled`、`active`、`requestBytes`、`responseBytes`、`durationMs`，不输出 UUID、内部用户 ID、selector 或派生密钥。新用户也有零计数行，停用用户的历史仍可查看。

统计来自认证后的远端用户身份，应用头和正文不能指定记账用户。口径如下：

| 项目 | 含义 |
| --- | --- |
| 请求数 | 已结束请求加当前进行中请求 |
| 成功 | server 完整读到网关响应正文 EOF，且 HTTP 状态为 2xx |
| 失败 / 取消 | 非成功的结束结果；未读完且请求取消时记为取消 |
| 上传 / 下行字节 | server 实际读出的请求 / 网关响应正文字节，在请求结束时汇总；不含 HTTP 头和隧道封装，也不是压缩后的链路流量 |
| 总耗时 | 远端处理开始到请求结束的累计毫秒；页面平均值除以已结束请求数 |

读到网关 EOF **不等于客户端已接收或解析完响应**。统计不包含本地解码耗时，也不解析 token 用量。它用于观察用量，不能作为精确计费记录。本地插件短路而没有到达 server 的请求不会出现在远端报告中。

管理 API 使用主密码登录后取得的 Cookie；用户 UUID 不能登录管理。接口见 [协议文档的管理部分](docs/PROTOCOL.md#10-管理与统计边界)。所有管理写操作，包括登录，要求与页面一致的 `Origin`；JSON 正文最多 4 KiB。会话有效期 30 分钟，最多 64 个，登录最多 8 次/分钟且限制并发。Cookie 为 HttpOnly、SameSite=Strict，HTTPS 下设置 Secure。响应不缓存，页面没有浏览器持久存储。

对外提供管理页面时，在**服务器本机的反向代理**终止 HTTPS，再转发到 `127.0.0.1:18081`。代理必须保留外部 `Host`，并设置 `X-Forwarded-Proto: https`。程序只信任 loopback 连接上的这个 HTTPS 声明，不信任任意远端转发头。远端明文 HTTP 不能打开管理密码表单或执行管理操作；直接 loopback HTTP 可用。报告接口始终无需登录，是否将该监听器或报告路径对外开放由部署决定。这个 Web 反代配置与双工 `/tunnel` 链路分开。

`--data-dir` 保存三个私有文件：

| 文件 | 内容 |
| --- | --- |
| `users.json` | 昵称、稳定内部身份、状态、创建时间、selector 和派生认证密钥；不保存 UUID 原文 |
| `stats.json` | 按内部身份保存的已结束请求汇总；不保存请求正文、模型响应或凭据 |
| `users.lock` | 保证同一目录只由一个 server 进程持有的独占锁 |

派生认证密钥能完成隧道认证，必须与 UUID 一样保密；不能把 `users.json` 当成可公开的密码哈希表。新建私有目录使用 Unix `0700`，数据文件和锁文件使用 `0600`；已有数据目录及其父目录的权限不会被自动收紧，应由管理员保持私有。用户操作先落盘再生效，统计有变更时每 5 秒写入，正常关停再写入一次。写入通过私有临时文件替换，不能让多个 server 共用同一数据目录。异常退出可能丢失尚未落盘的统计，进行中请求不会持久化。备份和恢复时将用户与统计文件作为一组处理。

## CLI 与资源边界

两端协商以下四项限制，逐项取 client 提议与 server 上限的较小值：

| 参数 | 默认值 | 范围与含义 |
| --- | --- | --- |
| `--upload-window-log` | `23` | `10..23`；上行 Zstd 窗口为 `2^N` 字节，默认 8 MiB |
| `--download-window-log` | `20` | `10..23`；下行 Zstd 窗口默认 1 MiB |
| `--max-streams` | `16` | `1..256`；每条隧道的同时请求数 |
| `--stream-window-bytes` | `262144` | `16384..4194304`；每流每接收方向尚未消费的正文额度 |

`max-streams × stream-window-bytes` 必须不超过 **64 MiB**。默认 `16 × 256 KiB = 4 MiB` 是每条隧道、每个接收方向的正文预算。接收端消费正文后归还额度，发送端没有额度时等待，不先塞入公共数据队列。Data 帧最多 16 KiB，控制消息优先，慢消费者不会占住公共接收循环。

窗口与队列限制不等于进程 RSS 上限。Zstd 上下文、HTTP/TLS 连接池、管道分段及程序本身另占内存；同时隧道数量会增加这些开销。

| 参数 | 角色 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `--listen IP:port` | 两者 | client `127.0.0.1:18080`；server `0.0.0.0:80` | 数据入口；IPv6 使用 `[::1]:18080` |
| `--server URL` | client | 无，必填 | HTTP 隧道地址 |
| `--uuid-env NAME` | client | `ZPROXY_USER_UUID` | 用户 UUID 环境变量 |
| `--connect-timeout-seconds` | client | `15` | 建立 TCP 与完成握手的期限 |
| `--admin-password-env NAME` | server | `ZPROXY_ADMIN_PASSWORD` | 管理主密码环境变量 |
| `--gateway URL` | server | 无，必填 | 固定的远端 OMP/兼容网关 authority |
| `--gateway-token-env NAME` | server | 不设置 | 远端网关 bearer token 环境变量 |
| `--data-dir PATH` | server | `data` | 私有用户与统计目录 |
| `--web-listen IP:port` | server | `127.0.0.1:18081` | 管理和公开报告；端口须与隧道监听不同 |
| `--max-tunnels` | server | `16` | `1..1024`；已接受连接和握手槽位，超出时关闭新连接 |
| `--max-user-tunnels` | server | `min(2, max-tunnels)` | `1..max-tunnels`；每位已认证用户的同时隧道上限 |
| `--handshake-timeout-seconds` | server | `15` | 已接受连接完成握手的期限 |

两个超时参数接受大于 0、至多 3600 的秒数，可以为小数。未知、重复、缺值和角色不符的参数都会报错。秘密值通过环境变量读取，命令行只接收变量名。`--help` 显示用法，Ctrl-C 和 SIGTERM 触发退出清理。多个用户共享网关连接池，但会话密钥、压缩历史、流额度和连接配额分别管理。

## HTTP 行为与失败处理

应用请求只透传 `Content-Type`、`Content-Length`、`Accept`、`Accept-Encoding`。server 按固定网关重建 Host，并在配置了 `--gateway-token-env` 时加入自己的 `Authorization: Bearer ...`。应用的 Authorization、Cookie、自定义 API key 和代理转发头不进入网关请求。

响应只透传 `Content-Type`、`Content-Length`、`Content-Encoding`、`Cache-Control`、`Retry-After`。Set-Cookie、Authorization、账户标识和其他不在白名单内的响应头不会送到 client。两个方向都先清除逐跳头及 `Connection` 点名的字段。这些头规则不会检查或删改正文内容。

默认把 `Accept-Encoding` 设为 `identity`。本地请求附带 `X-Zproxy-Pass-Encoding: 1` 时，保留应用自己的编码协商；这个控制头不会发给网关。网关响应不自动解压，Content-Encoding 与原始正文对应。代理不跟随重定向、不维护 Cookie jar，响应头到达后开始转发并逐块刷新。由于响应头白名单不包含 Location，本地调用方不能依靠代理返回的重定向地址继续跳转。

本地可观测到的请求取消、连接中止或内部响应正文关闭会清理对应流并取消远端工作。TCP FIN 可以是合法半关闭，不能一律视作取消。隧道断开后已有请求失败，**不会自动重发 POST**；只有后续新请求触发重连。错误发生在本地响应头发出前时返回 502，响应已经开始时中止正文，不把错误文本插入 SSE。

## 可选重插件的边界

[Plugins.fs](src/ZProxy/Plugins.fs) 提供两个本地入口：

| 接口 | 作用 |
| --- | --- |
| `IProxyPlugin.Wrap` | 包装 HTTP handler，调用下一层或直接返回本地响应；第一个注册的插件位于最外层 |
| `IResponseDecoder` | 按远端指定的 `Id` 与 `Version`，把原始下行正文和固定元数据转换为本地 OpenAI 响应 |

使用 `Client.run options plugins ct` 组合请求插件，使用 `Client.runWithDecoders options plugins decoders ct` 同时注册下行解码器。命令行当前传入空列表。注册是构建时显式组合，NativeAOT 路径没有程序集扫描或运行时插件加载器。插件可管理独立本机进程，但未启用插件时本体不依赖 OMP/Bun。请求插件可在远端不可用时直接短路，不建立隧道。

远端 `RemoteHandler` 接收服务器认证出的用户身份，返回原始响应和 [Contracts.fs](src/ZProxy/Contracts.fs) 的版本化元数据：解码器名、版本、模型别名、请求标识、尝试序号、流式标记。元数据没有任意扩展字典，不能装入账户快照、用户 UUID、selector、token、Cookie 或完整上游请求头。未知解码器或不兼容版本会使请求失败，不猜测响应格式。

后续 OMP 插件应在**远端完成凭据选择和发请求之后、开始解析上游下行正文之前**交接原始响应，由本地解码器承担繁重解析转换。账户刷新、路由决策、共享健康状态和重试决策仍在远端；本地解码器不接收能还原上游账户的状态。本次仅提供这些边界，尚未实现交接补丁。

handler 的调用者持有输入请求，并在最终响应使用完后释放它。请求插件借用输入请求；丢弃下层响应时须释放它。解码器接管原始响应，可以关闭它，或把生命周期交给返回的正文流；失败和取消仍须清理，返回流仍依赖它时不能提前关闭。解码器收到原始本地请求对象，但上传正文可能已被消费；需要解析上下文的请求插件应在转发前自行保留，例如放入 `request.Options`，本体不会为解码器缓存或重放上传。插件自建请求、进程和任务由插件管理；服务不负责销毁传入的插件实例。

## 验证与部署边界

`dotnet test zproxy.slnx --configuration Release` 覆盖用户凭据、持久化、管理权限和报告隔离，以及 HTTP 分段、帧、加密、压缩历史、双工、额度、并发、取消、断线不重放、插件短路和解码器行为。[CI](.github/workflows/ci.yml) 运行测试、发布 Linux x64 NativeAOT，再用自有 loopback 网关运行 [smoke-native.py](scripts/smoke-native.py)，验证管理生成 UUID、远端凭据、公开统计、chunked 上传、SSE、并发和退出。

目前没有发布吞吐、首字延迟或 RSS 测量结果。缩小窗口会改变可复用的历史，不能单凭参数推断速度和压缩比。一条 TCP 连接中的流可以交错发送，但丢包恢复仍可能让所有流共同等待。

HTTP/1.1 外观不能保证 QoS 放行。中间设备可能缓冲上传、等待请求体结束才转发响应，或限制长请求持续时间。应在实际链路验证同时上传和下载；管理页所用的普通反代也不应未经验证就直接用于 `/tunnel`。
