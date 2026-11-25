# zproxy

zproxy 把 OpenAI completions 请求和响应压缩、加密，通过一条 HTTP/1.1 长连接传输。F# / .NET 10 NativeAOT 本体提供 `client` 和 `server` 两个角色。可选 OMP 重插件把账户、路由留在远端，把支持的上游响应解析和 OpenAI 输出转换放到本机。

当前实现使用 **v4 协议**，两端必须一起升级。v3 的用户和统计数据文件可继续使用，不必重新发 UUID。每位用户使用独立 UUID；管理主密码和上游凭据留在服务器。完整传输格式见 [PROTOCOL.md](docs/PROTOCOL.md)。

## 数据与职责

| 部分 | 当前职责 |
| --- | --- |
| 本机 client | 提供两个 completion 入口，维护一条按需建立的隧道；启用 OMP 时调用本地官方响应解析器和 OpenAI 编码器 |
| 远端 server | 认证用户、限制连接、记录统计，调用固定网关或同机 OMP worker |
| 远端 OMP | 持有上游账户凭据，负责账号选择、刷新、模型路由、重试和共享健康信息；交接原始下行及受限的解析说明 |

应用使用 `http://127.0.0.1:18080/v1` 作为 base URL。本地只接受 `POST /v1/chat/completions` 和 `POST /v1/completions`，不接受查询参数、其他方法或其他路径；例如 `/v1/models` 不在本次接口范围内。

client 与 server 之间是一个 `POST /tunnel` 和一个长时间保持的 `200` 响应，两边的 chunked body 同时流动。多个逻辑请求用流编号共享这一 HTTP 交换。没有 WebSocket、HTTP Upgrade、CONNECT 或 HTTPS 证书拦截。外层使用 HTTP，正文中的请求帧和响应帧经过 Zstd 压缩与 ChaCha20-Poly1305 加密。

每个方向保留自己的 Zstd 历史，直到隧道关闭。本体不解析 `model`、`messages` 或 SSE 事件中的模型语义。默认 `--gateway` 模式把请求发给已有的 OpenAI 兼容网关，共享一个 HTTP 连接池；允许 HTTP/3，并按平台、目标服务和协商结果回落到 HTTP/2 或 HTTP/1.1。

两种运行方式如下：

| 方式 | server 参数 | client 参数 | 下行转换 |
| --- | --- | --- | --- |
| 本体直通，默认方式 | `--gateway URL` | 不加 `--omp` | 网关必须已经提供 OpenAI completions；本体传输原字节 |
| 可选 OMP 重插件 | `--omp --omp-config FILE` | `--omp` | 支持的上游 SSE 在本机由官方 OMP 解析；特殊传输保留官方远端处理 |

重插件使用**独立 Bun 进程**，通过权限受限的 Unix socket 与 F# 通信。它不嵌入 JS 引擎，也不依赖 `libbun`。本机 worker 没有远端账户库、认证参数或真实上游 URL；它只接收原请求、原始响应和固定字段的解析说明。未启用插件时不启动 Bun 或 OMP。逐项 shim 去留与特殊传输范围见 [OMP_PARITY.md](docs/OMP_PARITY.md)。

## 构建

[global.json](global.json) 选择 .NET 10.0.404 SDK，并允许同一功能版本内的后续补丁。Linux NativeAOT 构建需要本地编译工具和 Zstd 库。以 Debian / Ubuntu 为例：

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends -y clang libzstd-dev zlib1g-dev libssl-dev
# 状态页产物已入库；改过 frontend/ 后先重建，用 --check 在 CI 校验是否过期。
python3 scripts/build-status-page.py
dotnet restore zproxy.slnx
dotnet test zproxy.slnx --configuration Release --no-restore
dotnet publish src/ZProxy/ZProxy.fsproj --configuration Release \
  --runtime linux-x64 --self-contained true -p:PublishAot=true \
  --output artifacts/linux-x64
python3 scripts/smoke-native.py --binary artifacts/linux-x64/ZProxy
```

输出程序为 `artifacts/linux-x64/ZProxy`。这个小型产物不要求另装 .NET 运行时，但仍动态使用 **`libzstd.so.1`**，HTTPS 还需要系统 OpenSSL。当前目标是 Linux x64；主机须满足产物的系统库兼容要求，见 [.NET NativeAOT 部署说明](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)。这些库不被静态塞入核心可执行文件。

### 可选 OMP 与 AppImage

重插件不固定上游版本：每次准备构建时，`scripts/prepare-omp.py` 与 `scripts/prepare-ag2api.py` 取样 OMP、Antigravity2API 的默认分支最新提交，并从各自官方源取最新的 Bun、Go、native addon 与 AppImage 工具。路由引擎与宿主桥接（`plugins/omp/router`、`plugins/omp/shim`）由本仓库维护，来源与许可见 [NOTICE-shims.md](plugins/omp/NOTICE-shims.md)。交接补丁按唯一精确锚点幂等应用，上游一移动就重新校验语义，不会默默套用失效补丁。npm 依赖树随取样源码重新解析，`bun.lock` 在构建时重生成。没有下载摘要固定表；产物把本次实际的 OMP commit、AG2API commit、Bun 版本、worker 与 addon 摘要写入随包的 `bundle.json`，供事后追溯。同一份源码重跑构建结果不变，不同日期取样得到不同上游版本，这是预期行为。

在已有 NativeAOT 产物基础上，使用 Python 3.11 或更新版本：

```sh
sudo apt-get install --no-install-recommends -y desktop-file-utils
python3 scripts/prepare-omp.py
python3 scripts/prepare-ag2api.py
plugins/omp/bin/bun run --cwd plugins/omp test
python3 scripts/smoke-omp.py --binary artifacts/linux-x64/ZProxy --omp-dir plugins/omp
python3 scripts/smoke-omp.py --binary artifacts/linux-x64/ZProxy --omp-dir plugins/omp --antigravity2api
python3 scripts/build-appimage.py --binary artifacts/linux-x64/ZProxy
python3 scripts/smoke-appimage.py --image artifacts/zproxy-omp-linux-x64.AppImage
```

AppImage 包含本体、Bun、OMP 运行所需源码和 production npm 包、native addon、静态 AG 协议 worker、Zstd/OpenSSL 及非 glibc 动态依赖。它不要求主机安装 Bun、Go 或 .NET；主机仍提供 Linux 内核、glibc 和 CA 信任根。构建用 `readelf` 计算所需 GLIBC 符号下限，并把结果与二进制 hash、源版本、库版本写入随包的 `bundle.json`。Ubuntu 24.04 是构建基线，实际 ABI 下限以该次产物的 manifest 为准。产物不承诺在任意 Linux 发行版上运行。

安装 FUSE 时可以直接执行 AppImage；也可以解包运行：

```sh
chmod +x zproxy-omp-linux-x64.AppImage
./zproxy-omp-linux-x64.AppImage --appimage-extract
./squashfs-root/AppRun --help
```

使用较大的 AppImage 仍须显式加 `--omp` 才启动重插件。镜像不包含用户账户、上游凭据或服务器配置。完整构建布局、许可证和验证方式见 [packaging/README.md](packaging/README.md)。

### macOS arm64 OMP 客户端

在 Apple Silicon Mac 上安装 Python 3.12 或更新版本、.NET 10 SDK 和 Homebrew `zstd`。准备脚本会选择 Darwin Bun 与官方 `pi-natives-darwin-arm64` addon，也可用 `--bun` 指定已有的兼容版本。从仓库根目录构建：

```sh
python3 scripts/prepare-omp.py
dotnet publish src/ZProxy/ZProxy.fsproj --configuration Release \
  --runtime osx-arm64 --self-contained false --output artifacts/osx-arm64
export DYLD_LIBRARY_PATH="$(brew --prefix zstd)/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
```

按下文设置 `ZPROXY_USER_UUID`，然后启动客户端：

```sh
./artifacts/osx-arm64/ZProxy client --listen 127.0.0.1:18080 \
  --server http://relay.example:8080 --omp --omp-dir ./plugins/omp
```

运行框架依赖产物的机器需要 .NET 10 ASP.NET Core Runtime。可以用 `python3 scripts/smoke-omp.py --binary artifacts/osx-arm64/ZProxy --omp-dir plugins/omp` 验证普通 OMP 解码链路。AppImage 和可选的 Antigravity2API Go codec 使用 Linux x64 构建流程。

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

网关不需要 token 时，省略 `--gateway-token-env`。此方式必须给出 `--gateway`，且只能是固定 HTTP/HTTPS authority，如 `https://gateway.example:443`；不能带账户信息、业务路径、查询或片段。server 把允许的 `/v1/...` 路径拼到该地址，客户端不能指定其他目标。已有网关由部署者启动。若需要 zproxy 自动启动 OMP 并交接原始下行，使用下方的重插件方式。

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

## 启用 OMP 重插件

主密码、UUID 和管理页面的使用方式不变。以下方式替代 server 的 `--gateway` 配置，并要求 client 同时开启 `--omp`。

### 远端配置

先用官方 OMP 在服务器完成账户登录，或准备服务器上的官方 `models.yml`。把 `authDatabase` 指向该 OMP 使用的 `agent.db`。可修改的配置示例见 [remote.example.json](plugins/omp/remote.example.json)。例如，在远端保存 `remote.json`：

```json
{
  "version": 1,
  "authDatabase": "./omp-state/agent.db",
  "modelsFile": "./omp-state/models.yml",
  "discovery": "online-if-uncached",
  "aliases": {
    "main": "provider/model-id"
  }
}
```

把 `provider/model-id` 换成实际模型；不需要别名时可删掉 `aliases`。所有文件路径相对于 `remote.json` 所在目录解析。`models.yml` 直接交给当前官方 `ModelRegistry` 读取，保留官方格式、凭据解析和模型发现行为；无需再将它变成网关注入脚本。`modelsFile` 默认是账户库同目录的 `models.yml`，`modelCache` 默认是同目录的 `models.db`。模型发现可选 `offline`、`online` 或默认的 `online-if-uncached`，刷新间隔默认 5 分钟。

账户库、`models.yml` 中的密钥、环境凭据以及 `remote.json` 都留在服务器。客户端不需要这些文件。官方账户选择、刷新、配额和重试仍由远端 OMP 处理；本地仅持有自己的隧道 UUID。

已在两端准备 `plugins/omp` 时：

```sh
./artifacts/linux-x64/ZProxy server \
  --listen 0.0.0.0:8080 \
  --omp --omp-dir ./plugins/omp --omp-config ./remote.json \
  --web-listen 127.0.0.1:18081 --data-dir ./data

./artifacts/linux-x64/ZProxy client \
  --listen 127.0.0.1:18080 --server http://relay.example:8080 \
  --omp --omp-dir ./plugins/omp
```

AppImage 已自带目录和 Bun 路径，可以省略 `--omp-dir`：

```sh
./zproxy-omp-linux-x64.AppImage server \
  --listen 0.0.0.0:8080 --omp --omp-config ./remote.json \
  --web-listen 127.0.0.1:18081 --data-dir ./data

./zproxy-omp-linux-x64.AppImage client \
  --listen 127.0.0.1:18080 --server http://relay.example:8080 --omp
```

server 与 client 命令分别在远端和本机执行，且沿用前文各自的密码/UUID 环境变量。server 的 `--omp` 与 `--gateway`、`--gateway-token-env` 互斥。进程随本体启动，退出时一起清理；worker 意外退出会结束对应服务，使故障可见。

### 复用原路由策略

如需共享路由，在 `remote.json` 加入 `"shimsConfig": "./shims.json"`，指向现有 v2 配置。该配置启用 `lazy-router` 后，远端使用本仓库 `router/` 中的策略、健康、亲和、并发、速度和状态存储组件；实际凭据操作接回当前官方 OMP。多个用户共享远端的路由信息，用户隧道身份仍各自独立。

`rating` 节点按候选的能力先验、相对成本、实测延迟和前缀亲和性评分，并按配置温度探索；`features["lazy-router"].routing` 中的权重会传入评分。路由图中未设置 `intelligence` 或 `cost` 时使用上游默认值 50 和 1，不代表对模型能力或实际账单的测量。内置路由的候选使用这些相同默认值，因此仅改变能力或成本权重不会区分它们；需要区分时，应在路由图中配置候选值。

`routesFile` 和日志路径按 `shims.json` 所在目录解析。`stateDbPath` 由原配置模块处理；建议使用明确的服务器私有绝对路径。`shimsConfig` 不是把所有旧猴子补丁无条件重新装上：已由官方功能接管的 shim 删除，必须保留的部分在对应边界实现。每项处理和限制见 [OMP_PARITY.md](docs/OMP_PARITY.md)。原路由事件日志属于远端私有诊断；公开 `/reports` 仍只显示昵称及聚合计数。

### Antigravity 使用 Go 协议适配

在远端 `remote.json` 加入以下字段，令路由最终选中的 `google-antigravity` 模型使用 Antigravity2API 的请求与响应规则：

```json
"antigravity2api": true
```

默认关闭。启用后，远端仍由现有 OMP 账户库和共享路由选择账户、解析模型、刷新凭据并发起 HTTP 请求；Go 只准备请求正文。原始下行通过原隧道到本机，交给本地 Go worker 解析并输出 OpenAI chat / text completions。客户端从受限的 `antigravity2api` recipe 自动选择该 codec，无需取得服务器配置。两个 Go worker 均按需启动，随所属 OMP worker 关闭。

这条路径不启动 Antigravity2API 自带的账号池、管理服务、数据库或调度器。AG 的模型、provider、账户容量不再套旧路由的固定并发上限，本地 Go 解析也不套普通 OMP 解析器的 4 路限制。zproxy 的每隧道 `--max-streams`、内存额度、取消和背压仍然有效，上游实际返回的 429 和配额状态仍由远端路由处理。它不会把上游拒绝解释成无限重试。

本地缓存匹配当前对话的 thought signature，下一轮把所需签名作为私有请求上下文交回远端。缓存上限 256 条 / 4 MiB、有效期 30 分钟，进程退出即清空；它不含账户凭据。已有工具签名会保留。`reasoning_effort: "none"` 对必须思考的模型只隐藏输出思考；只有目录明确支持关闭的模型才按其 off 路由关闭。完整边界、构建方式和验证见 [AG2API.md](docs/AG2API.md)。

### 同接口提供方直接通过

对服务器 `models.yml` 中已经提供相同 OpenAI chat 接口的自定义提供方，可在 `remote.json` 显式加入：

```json
"passthroughProviders": ["internal-openai"]
```

这里填写 provider 名称，默认列表为空。仅当实际模型使用 `openai-completions`、采用静态 API key 或无需认证、且没有内建特殊 provider 定义、自定义插件 transport 或 OAuth 账户池时，`/v1/chat/completions` 才走此捷径。远端仍用官方目录解析模型和凭据，并保留路由的健康、并发和用量状态；请求不再变成 OMP 中间消息，响应直接送回调用方，不进入本地 OMP 解析器。请求中的原 tool-call ID 保持不变。

此路径保留上游响应中的 `model`，不会将它改成公开别名或虚拟路由名。`/v1/completions`、OAuth 及特殊 transport 仍走原 gateway 适配路径。这是服务器管理员对已确认兼容提供方的显式选择，不会根据模型名称自动猜测兼容性。

### 下行范围和限制

当前本地解析覆盖 OpenAI chat、Responses（含适配到该线格式的 Codex/Azure）、Anthropic、Google（含 Vertex）与 Gemini CLI 的受支持 SSE 路径。远端先检查有界的首段事件以保留前置错误和重试机会，再交接原字节；随后只保留有界的用量、健康、时序及必要的流续接处理。它不会在成功交接后重新组装整段 OMP 消息再序列化。

没有对应本地 codec、没有可拦截 fetch/SSE 边界或使用特殊传输的上游，继续走官方远端转换；具体例外以逐项盘点为准。不能据此声称所有 provider 的下行 CPU 都已迁到本机。一般 chat 流按官方事件顺序直接输出；client 可加 `--omp-reasoning-order`，把晚到的 reasoning 排在可见文字和工具输出之前。该选项会缓冲可见输出，可能显著推迟文字首字到达，最多保留 16 MiB。

OMP 的 `/v1/completions` 是 text prompt 到 chat 的兼容入口：只接受一个字符串 prompt（或单元素字符串数组）、一个结果 `n=1`，不支持 `echo=true`、`suffix`、`logprobs` 或 `best_of` 大于 1。原生 `/v1/chat/completions` 是主要接口。两个端点之外没有开放 OMP 的管理、模型枚举或其他 API。

## 管理、公开报告与数据文件

`/` 和 `/reports` 是无需登录的统计页，`/api/reports` 是同样公开的 JSON API。它们只输出昵称与 `requests`、`succeeded`、`failed`、`canceled`、`active`、`requestBytes`、`responseBytes`、`durationMs`，以及有界的 `latency` 与 `headersLatency` 直方图、`statusBuckets`（`2xx`、`3xx`、`4xx`、`5xx`、`noResponse`）、`kinds`（`chat`、`completions`）、`streamed`/`buffered` 响应形态计数、`peakActive` 并发峰值、`lastSeen` 最近活动时间，和最近 24 个 UTC 小时的 `series` 桶（顶层带 `generatedAt`、`latencyBoundsMs`、`statusClasses`、`requestKinds`），不输出 UUID、内部用户 ID、selector 或派生密钥。这些字段全部来自本地观测：响应状态、响应头到达时刻、请求路径和流式标记，不含模型名、上游账号或路由决策。新用户也有零计数行，停用用户的历史仍可查看。

统计来自认证后的远端用户身份，应用头和正文不能指定记账用户。口径如下：

| 项目 | 含义 |
| --- | --- |
| 请求数 | 已结束请求加当前进行中请求 |
| 成功 | server 完整读到远端响应正文 EOF，且 HTTP 状态为 2xx |
| 失败 / 取消 | 非成功的结束结果；未读完且请求取消时记为取消 |
| 上传 / 下行字节 | server 实际读出的请求 / 远端响应正文字节，在请求结束时汇总；OMP 原始下行模式计原始 provider 正文，不含解析说明、HTTP 头和隧道封装，也不是压缩后的链路流量 |
| 总耗时 | 远端处理开始到请求结束的累计毫秒；页面平均值除以已结束请求数 |

读到远端 EOF **不等于客户端已接收或解析完响应**。公开统计不包含本地解码耗时，也不展示 token 用量。OMP 路由可在自己的远端私有状态中记录有界用量数据，两者口径不同。公开报告用于观察用量，不能作为精确计费记录。本地插件短路而没有到达 server 的请求不会出现在远端报告中。

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

启用 OMP 后还要计算独立 Bun 进程和模型解析器的内存。原请求在本机以私有临时文件保留供解码使用，上限 64 MiB；远端 JSON 请求默认上限 16 MiB，可在配置中调到至多 64 MiB。普通 OMP 本地解析同时最多 4 路，单个原始响应上限 128 MiB；请求和非流式结果仍会在 JS 中形成对象。选配 AG codec 按需增加 Go 进程，不设 AG 固定并发上限；每个原始响应仍限 128 MiB，累计解码内容和排序缓冲分别限 16 MiB。以上是输入和资源边界，不是承诺固定 RSS。

| 参数 | 角色 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `--listen IP:port` | 两者 | client `127.0.0.1:18080`；server `0.0.0.0:80` | 数据入口；IPv6 使用 `[::1]:18080` |
| `--server URL` | client | 无，必填 | HTTP 隧道地址 |
| `--uuid-env NAME` | client | `ZPROXY_USER_UUID` | 用户 UUID 环境变量 |
| `--connect-timeout-seconds` | client | `15` | 建立 TCP 与完成握手的期限 |
| `--admin-password-env NAME` | server | `ZPROXY_ADMIN_PASSWORD` | 管理主密码环境变量 |
| `--gateway URL` | server | 未启用 OMP 时必填 | 固定的远端 OMP/兼容网关 authority |
| `--gateway-token-env NAME` | server | 不设置 | 远端网关 bearer token 环境变量 |
| `--omp` | 两者 | 关闭 | 启动可选 OMP worker；server 使用时要求 client 也开启 |
| `--omp-dir PATH` | 两者 | `ZPROXY_OMP_DIR`，否则可执行文件旁的 `omp` | 含 worker、OMP 源码和依赖的目录；要求 `--omp` |
| `--bun PATH` | 两者 | `ZPROXY_BUN`，否则插件目录的 `bin/bun` | 独立 Bun 可执行文件；要求 `--omp` |
| `--omp-config PATH` | server | OMP 模式必填 | 远端私有配置；client 不读取 |
| `--omp-reasoning-order` | client | 关闭 | 有界缓冲可见输出，使 reasoning 在前；要求 `--omp` |
| `--data-dir PATH` | server | `data` | 私有用户与统计目录 |
| `--web-listen IP:port` | server | `127.0.0.1:18081` | 管理和公开报告；端口须与隧道监听不同 |
| `--max-tunnels` | server | `16` | `1..1024`；已接受连接和握手槽位，超出时关闭新连接 |
| `--max-user-tunnels` | server | `min(2, max-tunnels)` | `1..max-tunnels`；每位已认证用户的同时隧道上限 |
| `--handshake-timeout-seconds` | server | `15` | 已接受连接完成握手的期限 |

两个超时参数接受大于 0、至多 3600 的秒数，可以为小数。未知、重复、缺值和角色不符的参数都会报错。秘密值通过环境变量读取，命令行只接收变量名。`--help` 显示用法，Ctrl-C 和 SIGTERM 触发退出清理。多个用户共享网关连接池，但会话密钥、压缩历史、流额度和连接配额分别管理。

## HTTP 行为与失败处理

应用请求只透传 `Content-Type`、`Content-Length`、`Accept`、`Accept-Encoding`。默认 `--gateway` 模式按固定网关重建 Host，并在配置了 `--gateway-token-env` 时加入自己的 `Authorization: Bearer ...`。OMP 模式由远端官方 provider 构造请求和认证头。应用的 Authorization、Cookie、自定义 API key 和代理转发头不成为上游凭据。

响应只透传 `Content-Type`、`Content-Length`、`Content-Encoding`、`Cache-Control`、`Retry-After`。Set-Cookie、Authorization、账户标识和其他不在白名单内的响应头不会送到 client。两个方向都先清除逐跳头及 `Connection` 点名的字段。这些头规则不会检查或删改正文内容。

默认 `--gateway` 模式把 `Accept-Encoding` 设为 `identity`。本地请求附带 `X-Zproxy-Pass-Encoding: 1` 时，保留应用自己的编码协商；这个控制头不会发给网关。网关响应不自动解压，Content-Encoding 与原始正文对应。固定网关代理不跟随重定向、不维护 Cookie jar，响应头到达后开始转发并逐块刷新。由于响应头白名单不包含 Location，本地调用方不能依靠代理返回的重定向地址继续跳转。OMP 原始下行模式显式请求 `identity`，本地输出头由解析器重建；特殊上游握手和请求行为遵循对应官方 provider。

本地可观测到的请求取消、连接中止或内部响应正文关闭会清理对应流并取消远端工作。TCP FIN 可以是合法半关闭，不能一律视作取消。隧道断开后已有请求失败，**不会自动重发 POST**；只有后续新请求触发重连。错误发生在本地响应头发出前时返回 502，响应已经开始时中止正文，不把错误文本插入 SSE。

## 可选重插件的边界

[Plugins.fs](src/ZProxy/Plugins.fs) 提供两个本地入口：

| 接口 | 作用 |
| --- | --- |
| `IProxyPlugin.Wrap` | 包装 HTTP handler，调用下一层或直接返回本地响应；第一个注册的插件位于最外层 |
| `IResponseDecoder` | 按远端指定的 `Id` 与 `Version`，把原始下行正文和固定元数据转换为本地 OpenAI 响应 |

使用 `Client.run options plugins ct` 组合请求插件，使用 `Client.runWithDecoders options plugins decoders ct` 同时注册下行解码器。命令行的 `--omp` 显式组合请求上下文保存和 `omp-response` 解码器；未启用时传入空列表。NativeAOT 路径没有程序集扫描或运行时程序集加载器。插件可以管理独立本机进程，请求插件也可直接返回本地响应而不建立隧道。

远端 `RemoteHandler` 接收服务器认证出的用户身份，返回原始响应和 [Contracts.fs](src/ZProxy/Contracts.fs) 的版本化元数据：解码器名、版本、模型别名、请求标识、尝试序号、流式标记及受限 `recipe`。OMP recipe 最多 8 KiB，字段固定为线格式、公开模型属性和所需解析兼容开关。它没有任意请求选项字典，不能装入账户快照、用户 UUID、selector、token、Cookie、上游地址或完整请求头；本体和 worker 分别校验。未知解码器或不兼容版本会使请求失败，不猜测响应格式。

OMP 插件在**远端完成凭据选择、请求构造和首段错误检查之后、官方完整下行解析器开始消费之前**交接成功响应。对官方 OMP 源码的改动放在 [patch-upstream.mjs](plugins/omp/patch-upstream.mjs)：每个补丁位置检查修改前、修改后的 SHA-256，源码漂移时终止准备。路由引擎与宿主桥接是本仓库自己的源码，不再从上游抓取或打补丁。账户刷新、路由和健康状态不搬到本机；已经开始对外输出的请求不会因为隧道断线而重放。

handler 的调用者持有输入请求，并在最终响应使用完后释放它。请求插件借用输入请求；丢弃下层响应时须释放它。解码器接管原始响应，可以关闭它，或把生命周期交给返回的正文流；失败和取消仍须清理，返回流仍依赖它时不能提前关闭。解码器收到原始本地请求对象，但上传正文可能已被消费；需要解析上下文的插件须自行保存。OMP 的实现将原上传写入私有临时文件，随返回正文的生命周期删除；本体通用管道不会擅自缓存或重放上传。自建请求、进程和任务由插件管理。

## 验证与部署边界

`dotnet test zproxy.slnx --configuration Release` 覆盖用户凭据、持久化、管理权限和报告隔离，以及 HTTP 分段、帧、加密、压缩历史、双工、额度、并发、取消、断线不重放、插件短路、recipe 校验和解码器行为。`plugins/omp` 下的 Bun 测试直接使用固定版本官方模块、原路由组件和自有假上游，检查响应交接、格式转换、凭据边界及补丁漂移。

[CI](.github/workflows/ci.yml) 的发布门槛包括：运行 F#、Bun、Go 测试，构建静态 AG worker 并检查私有 Unix HTTP，发布 Linux x64 NativeAOT，运行 [smoke-native.py](scripts/smoke-native.py) 和 [smoke-omp.py](scripts/smoke-omp.py) 的普通 OMP / AG 两种模式，构建真实 AppImage，再通过 [smoke-appimage.py](scripts/smoke-appimage.py) 解包验证。解包测试执行普通转发、OMP 分拆和 AG 全链路；不依赖主机 Bun、Go 或 .NET。AG 测试包括首字提前到达、六个并发文本补全以及下一轮签名恢复。所有上游流量均使用测试自建的 loopback fixture，不使用真实账户。只有这些步骤完成才上传对应产物；当前运行是否通过以 PR 的 CI 结果为准。

目前没有发布吞吐、首字延迟或 RSS 测量结果。缩小窗口会改变可复用的历史，不能单凭参数推断速度和压缩比。一条 TCP 连接中的流可以交错发送，但丢包恢复仍可能让所有流共同等待。

HTTP/1.1 外观不能保证 QoS 放行。中间设备可能缓冲上传、等待请求体结束才转发响应，或限制长请求持续时间。应在实际链路验证同时上传和下载；管理页所用的普通反代也不应未经验证就直接用于 `/tunnel`。
