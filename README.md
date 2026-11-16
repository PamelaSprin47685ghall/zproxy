# zproxy

zproxy 把 HTTP 请求和响应压缩、加密，再通过一条 HTTP/1.1 长连接传输。一个 F# / .NET 10 程序提供 `client` 和 `server` 两个角色；支持发布为 Linux x64 NativeAOT 程序。

本次实现是 **v2 协议**。升级时需要同时更新两端。协议细节见 [PROTOCOL.md](docs/PROTOCOL.md)。

## 数据怎样走

| 路段 | 传输方式 | 内容 |
| --- | --- | --- |
| 应用到本机 client | HTTP/1.1 | 原始 HTTP 请求；默认只监听 `127.0.0.1:18080` |
| client 到远端 server | HTTP/1.1 `POST /tunnel`，双向 chunked body | 经过 Zstd 压缩和 ChaCha20-Poly1305 加密的请求与响应帧 |
| server 到目标服务 | 普通 HTTP 或 HTTPS | .NET 连接池允许 HTTP/3，并按平台、目标服务与协商结果回落到 HTTP/2 或 HTTP/1.1 |

隧道的请求体和响应体可以同时持续流动。没有 WebSocket 握手或 HTTP Upgrade。多个应用请求用各自的流编号共享这个 HTTP 交换，长响应期间仍可发送其他请求。

同一方向的 Zstd 历史保留到隧道关闭，因此连续请求中的重复字节可以复用历史。本体按 HTTP 字节转发，不解析 `model`、`messages` 或其他 LLM JSON 字段。OMP 语义插件、Bun、JS 运行时及 AppImage 打包尚未加入。

## 构建与运行

项目通过 [global.json](global.json) 选择 .NET 10.0.404 SDK，并允许同一功能版本内的后续补丁。Linux 构建需要 C 编译工具和 Zstd 库。以 Debian / Ubuntu 为例：

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends -y clang libzstd-dev zlib1g-dev
dotnet restore zproxy.slnx
dotnet test zproxy.slnx --configuration Release --no-restore
dotnet publish src/ZProxy/ZProxy.fsproj --configuration Release \
  --runtime linux-x64 --self-contained true -p:PublishAot=true \
  --output artifacts/linux-x64
```

输出程序名为 `artifacts/linux-x64/ZProxy`。NativeAOT 产物不要求另装 .NET 运行时，但仍动态使用 **`libzstd.so.1`**；Debian / Ubuntu 的运行机器需要 `libzstd1`。当前 Zstd 绑定使用 Linux 库名，CI 只验证 Linux x64。运行系统还需要满足构建产物的系统库兼容要求，见 [.NET NativeAOT 部署说明](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)。当前发布流程不把这些系统库打包进可执行文件。

### 1. 设置共享口令

在两台机器上设置同一个非空环境变量。下面的 Bash 命令从终端读取口令：

```sh
read -rsp 'zproxy password: ' ZPROXY_PASSWORD
printf '\n'
export ZPROXY_PASSWORD
```

没有默认口令，也不接受 `--password` 明文参数。默认读取 `ZPROXY_PASSWORD`；`--password-env NAME` 可以选择另一个变量。空值和全空白值会被拒绝。

### 2. 启动远端 server

```sh
./artifacts/linux-x64/ZProxy server --listen 0.0.0.0:8080
```

示例使用 8080 端口。省略 `--listen` 时，server 默认监听 `0.0.0.0:80`。

### 3. 启动本机 client

```sh
./artifacts/linux-x64/ZProxy client \
  --listen 127.0.0.1:18080 \
  --server http://relay.example:8080
```

把 `relay.example` 替换为远端地址。`--server` 必填，只接受 `http://host[:port]` 或 `http://host[:port]/tunnel`，实际请求路径固定为 `/tunnel`。带用户信息、查询参数、片段或其他路径的 URL 会被拒绝。

### 4. 设置应用的 base URL

例如，原来的 OpenAI 兼容 base URL 为：

```text
https://api.example.com/v1
```

改为：

```text
http://127.0.0.1:18080/https://api.example.com/v1
```

应用请求 `/chat/completions` 时，本地路径就包含完整的目标 URL：

```sh
curl --no-buffer \
  'http://127.0.0.1:18080/https://api.example.com/v1/chat/completions' \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data-raw '{"model":"your-model","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

这是 base URL 转发接口；当前没有 CONNECT 接口或 HTTPS 证书拦截。client 使用原始请求目标读取 URL，保留其中的 `https://` 和百分号编码。已有的 `/{hex-encoded-base-url}/path` 形式仍可在**本地入口**使用；远端仅接受新的 `/tunnel` 协议。

## 配置与内存边界

两个角色都可设置下面四项限制。握手时逐项取 client 提议与 server 上限的较小值。

| 参数 | 默认值 | 允许范围与含义 |
| --- | --- | --- |
| `--upload-window-log` | `23` | `10..23`；上行 Zstd 窗口为 `2^N` 字节，默认 8 MiB |
| `--download-window-log` | `20` | `10..23`；下行 Zstd 窗口为 `2^N` 字节，默认 1 MiB |
| `--max-streams` | `16` | `1..256`；每条隧道的同时请求数 |
| `--stream-window-bytes` | `262144` | `16384..4194304`；每条流、每个接收方向可尚未消费的正文额度 |

`max-streams × stream-window-bytes` 必须不超过 **64 MiB**。默认是 `16 × 256 KiB = 4 MiB`，约束的是每条隧道、每个接收方向尚未消费的正文。接收端读走正文才归还额度；发送端额度不足时等待。这样，一个慢消费者不需要让整条隧道的读循环停在它的正文上。

这些数值是窗口和队列限制，**不是进程 RSS 上限**。Zstd 上下文、管道分段、临时缓冲、HTTP 连接池和程序本身都需要额外内存。Argon2id 在进程启动时派生主密钥，使用 64 MiB 工作内存；不会对每条新隧道重新执行 Argon2id。

| 参数 | 角色 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `--listen IP:port` | 两者 | client: `127.0.0.1:18080`；server: `0.0.0.0:80` | 监听地址；IPv6 使用 `[::1]:18080` 形式 |
| `--password-env NAME` | 两者 | `ZPROXY_PASSWORD` | 读取共享口令的环境变量 |
| `--server URL` | client | 无 | 远端 HTTP 隧道地址 |
| `--connect-timeout-seconds` | client | `15` | 建立 TCP 与隧道握手的期限 |
| `--max-tunnels` | server | `16` | `1..1024`；同时占用的连接/握手槽位，超过上限的新连接被关闭 |
| `--handshake-timeout-seconds` | server | `15` | 一条已接受连接完成握手的期限 |

两个超时选项接受大于 0、至多 3600 的秒数，也可用小数。未知参数、重复参数、缺值，以及只属于另一角色的参数都会报错。`--help` 显示用法；Ctrl-C 和 SIGTERM 会触发退出清理。

远端共享一个上游 HTTP 连接池，但每条隧道仍有各自的压缩上下文与正文预算。`--max-tunnels` 是估算远端总负担时必须同时考虑的数量。

## HTTP 行为与失败处理

默认把上游请求的 `Accept-Encoding` 设为 `identity`，让 Zstd 能看到原始文本。需要保留应用原来的编码协商时，向本地入口发送 `X-Zproxy-Pass-Encoding: 1`；这个控制头不会发送给目标服务。上游响应不自动解压缩，`Content-Encoding` 与正文一起透传。

代理清除逐跳头，以及 `Connection` 点名的其他头；按目标地址重建 `Host`。应用的 Authorization、Content-Type、Cookie 等头继续转发。上游重定向直接返回给调用者，不在代理内跟随；代理不维护自己的 Cookie jar。响应头到达后就开始返回正文，并在转发正文块后刷新本地输出，适用于 SSE。

本地 HTTP 服务可观测到请求取消或明确的连接中止时，会取消对应的远端工作并回收流资源；代理内部关闭响应正文也会触发清理。单独的 TCP FIN 可以表示合法的发送半关闭，不能把它一律当成请求取消。隧道断开后，已有请求失败，**不会自动重发 POST，也不会因为尚未收到响应头就重试**。新请求才建立新隧道。失败发生在本地响应头发送前时返回 502；响应已经开始时中止该响应。

这避免代理在不知道上游是否已经处理请求的情况下重复发起工作。应用需要重试时，应由应用结合自己的请求语义决定。

## 插件入口

[Plugins.fs](src/ZProxy/Plugins.fs) 定义了 `IProxyPlugin.Wrap`：插件接收下一个 HTTP handler，返回包装后的 handler。插件既可调用下一层，也可直接返回本地响应。注册顺序中，第一个插件位于最外层。

入口为 `Client.run options plugins cancellationToken`。命令行程序当前传入空列表；要启用插件，需要在构建时显式组合。NativeAOT 路径没有动态程序集扫描或运行时插件加载器。短路请求可以在远端不可用时完成，不建立隧道。

handler 的调用者持有输入请求，并负责在使用完返回响应后释放它。插件借用输入请求，不应提前关闭其正文；如果丢弃或替换下层响应，应释放被丢弃的响应。插件创建的替代请求、后台任务和其他资源由插件管理，不能在返回的流仍被使用时提前释放。`Client.run` 不负责销毁传入的插件实例；实例的创建者应在服务与相关请求结束后释放其资源。

这些钩子为可选的本机重插件预留。OMP gateway 的启动、路由、模型配置和语义处理均未实现。

## 验证范围与限制

运行 `dotnet test zproxy.slnx --configuration Release` 可执行命令解析、HTTP chunked 分段、帧与加密、压缩历史、双工传输、并发请求、取消、断线不重放和插件短路等测试。[CI](.github/workflows/ci.yml) 运行完整测试，发布 Linux x64 NativeAOT 程序，再通过自有 loopback HTTP 服务验证原生程序的 SSE 转发与退出，保存测试结果和可执行文件压缩包。

目前没有发布吞吐、首字延迟或 RSS 的测量结果。窗口变小会减少可利用的历史，不能单凭参数推断速度和压缩比。

一条 TCP 连接里的逻辑请求可以交错发送，但 TCP 丢包恢复仍可能让它们共同等待。HTTP 外壳也不保证任何 QoS 都会放行；中间代理可能缓冲请求体、等待上传结束才转发响应，或限制长请求时间。实际部署需要在目标链路上验证双工行为。

同一共享口令属于同一信任域。当前没有按用户划分的权限、目标 URL 白名单或租户隔离；持有口令的客户端可以请求远端可达的 HTTP/HTTPS 目标。
