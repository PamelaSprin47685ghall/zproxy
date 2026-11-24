# Antigravity2API 协议插件

AG 适配属于可选 OMP 重插件。`remote.json` 的 `antigravity2api: true` 让最终选中的 `google-antigravity` 模型使用固定版本 Antigravity2API 的协议处理；其他 provider 保持原路径。客户端仍只提供 `/v1/chat/completions` 和 `/v1/completions`。

## 为什么使用薄 Go worker

固定源为 [Antigravity2API 0.1.10 / d9614e9](https://github.com/Mag1cFall/Antigravity2API/tree/d9614e93633dd48f595fdcc90f7fe9ede0086626)，使用 MIT 许可。原 `serve` 程序会创建自己的账户存储、令牌刷新、账号调度、管理服务和数据库；指定账户也仍会经过其并发、冷却与重试策略。其生成客户端还会在远端解码并保存响应。这些行为与本项目的远端共享账户、本地解析边界不同。

我们将 [ag2api](../plugins/omp/ag2api) 中的适配文件加入固定上游模块，复用它现有的请求解析、请求组合、官方网络客户端、输出规则与响应解码器。这些包是 Go `internal` 包，因此适配文件必须在该模块内编译，且不能用未经适配的官方可执行文件直接替换。源码中的原文件不被覆盖；账户选择和凭据刷新仍由 OMP 完成，不启动上游的账户池或管理服务。[构建脚本](../scripts/prepare-ag2api.py)

新 worker 只监听私有 Unix socket；由 OMP worker 管理生命周期。`CGO_ENABLED=0` 产出静态可执行文件，不需要主机 Go 运行时。请求准备与本地解码可并发处理，没有每账户信号量或独立待执行队列。F# 主程序继续使用 NativeAOT，未改为嵌入 Go 或 Bun。

## 两端分工

| 环节 | 执行位置 | 具体责任 |
| --- | --- | --- |
| 用户认证与报告 | 远端 F# | UUID 认证、昵称统计；AG 不增加第二套用户体系 |
| 路由和账户 | 远端 OMP | 使用现有共享路由与官方 AuthStorage；选择模型和账户、刷新凭据、记录健康和配额 |
| 请求准备与发送 | 远端 Go | 经私有 Unix socket 接收选中账户的短期 access token、设备资料及请求；使用官方客户端与账户目录生成并发送请求，不持久化 token |
| 控制续传 | 远端 OMP | 有限首段错误检查、usage 与协议 CONTINUATION；每个续传段由远端 Go 使用同一账户和请求信封发送，交接原始响应 |
| 下行解析与编码 | 本地 Go | 解析 AG SSE，应用原项目的输出规则，输出 OpenAI JSON/SSE；没有账号库、token、project 或实际上游 URL |
| 多轮签名 | 本地 Go → 远端 Go | 本地保存匹配历史所需的 thought signature；下一轮经加密隧道交回，远端检查后填入模型历史 |

远端使用官方账户解析和 refresh。401 可刷新本次选定的同一账户；切换账户由外层路由负责。启用 `shimsConfig` 的 `lazy-router` 时，直接指定的 AG 模型也经过账户候选调度：优先尝试目录认可且令牌仍有效的账户，失败后只在同一模型内切换账户。未启用该路由时，直接请求不会使用这套候选重试。已经交接给本地的响应不会自动重放。Go worker 不维护第二套账户重试。[远端适配](../plugins/omp/remote-antigravity.mjs)

官方 OMP 将该 provider 默认暂停，并提示 Google 不允许第三方工具使用 Antigravity 登录且曾暂停相关账号。启用本插件是管理员的显式选择；403 也可能有其他原因，不能单凭一次拒绝认定账号永久失效。不要把账号令牌输出到日志或对话中。

启用 AG 也通过 OMP 的官方 opt-in 配置打开当前默认暂停的 provider。用于保存既有设置的只读 getter 与交接补丁一样受固定源码摘要检查；关闭最后一个使用方时只撤销本插件加入的项。此设置不改变 OAuth 规则、证书校验或上游返回的错误。[官方补丁](../plugins/omp/patch-upstream.mjs)

## 行为与资源边界

只有远端 AG worker 从 [上游规则源](https://api.github.com/repos/Mag1cFall/Antigravity2API/contents/rules/rejected.txt?ref=main)同步 `rejected.txt`。启动后立即检查，此后每小时检查；GET 不带账号凭据或请求内容。更新经官方解析器校验，最大 1 MiB，不接受降版；成功后原子写入远端 `antigravity/rejected.txt` 并交给官方组合器。失败时沿用最后一份有效规则，首次离线则用内置规则。本地解码 worker 不联网同步。

AG 模型的公开选择、可用档位和 wire profile 来自选中账户的 OMP 目录；远端 Go 客户端还读取该账户的官方目录并校验选中的模型。不会用另一个账户的 profile；路由仍由 OMP 负责。设备资料保存在远端私有 `ag-devices.json`，官方客户端会话状态保存在同目录的 `antigravity` 子目录。工具定义、历史、参数、工具名称修复、stop、JSON/schema 输出、usage 和 finish reason 复用固定上游规则。`reasoning_effort: "none"` 对必须思考的模型隐藏思考输出；只有 OMP 目录明确允许关闭的模型才设置零思考预算和关闭输出思考。

上游把 `systemInstruction` 当 user 角色读取。客户端身份句放在这里时，上游会以不带 `reason` 的 429 拒绝整个请求；本机官方实例的 `requests.db` 记录了它在同一份请求上收到同样的 429。因此适配层不再把调用方 system 拼进官方系统提示：`system` 是官方 full 档模板的原样渲染（与官方客户端一致），调用方 system 移到历史最前的一个 user 轮，并包在 `<additional-system-prompt>` 中。官方组合器其余部分仍逐字复用固定上游实现，`dropBilling` 与 user 轮的 `userRejected` 过滤照旧生效。

AG 的 provider、模型和账户不再使用旧路由中的固定 `maxInFlight` 限额，本地 AG 解码也不进入普通 OMP 解析器的 4 路上限。整个隧道仍受 `--max-streams` 和每流字节额度控制，默认一条隧道最多 16 路，可配置 1–256 路。这是共享传输的资源预算。上游配额和真实限流不会因此消失；其他 provider 的并发配置保持原行为。[路由组合](../plugins/omp/remote-routing.mjs)

账户可见性有两个层次，二者都由路由层在选择账号时决定，`ag-devices.json` 或解码器都不参与。第一层是模型可见性：目录中的 `accountAccess` 说明哪个账号能服务哪个模型，`google-antigravity` 的候选池按它过滤，因此一个只在部分账号上存在的模型不会被没有它的账号浪费一次请求。第二层是账号级封禁：上游可能拒绝整个账号（TOS 或需要验证），这类 403 由 Go worker 以私有头分类，Bun 侧把该账号在路由层冷却 30 分钟；冷却期间该账号的所有模型都不再被选择，期满自动回到候选池。模型级配额或限流只冷却该模型，不会连坐同账号的其他模型。

私有 Go HTTP 请求、响应同时流动，并通过读写背压衔接。取消会关闭上传与下载、终止解码并回收读取任务；不为慢消费者积累无界事件队列。每次原请求最多 64 MiB，原始下行最多 128 MiB，累计解码内容最多 16 MiB。显式 `--omp-reasoning-order` 的可见输出缓冲另限 16 MiB。非流式结果和原库的输出状态仍会占内存，这不是常数 RSS 的承诺。

本地沿用原输出层的 120 秒事件等待期限：只收到 SSE 注释心跳而没有新的模型事件，不会重置这项期限。它独立于远端按原始字节计时的 `idleTimeoutMs`；调高远端设置不会延长本地这项等待。

同一个续传段内，后续用量帧省略的计数沿用该段已报告的值，然后再汇总各段。这样，末帧只更新输出用量时，不会把已报告的缓存命中数抹掉。流式客户端须使用 `stream_options.include_usage: true` 才会收到 `usage.prompt_tokens_details.cached_tokens`；这个字段只报告上游提供的命中数，不代表代理能保证缓存命中。

签名缓存最多 256 条、4 MiB，每条 30 分钟过期，进程结束后清空。匹配项包含原模型名、工具、已有消息前缀和回答指纹；不按账号猜测或跨不相关历史补签。原生工具签名继续保留，私有 `_zproxy_ag` 仅携带匹配的正文/工具签名；远端重新校验引用、内容指纹与 provider family 后使用。普通 provider 的请求会删除这个私有字段。客户端丢弃历史、重写工具 ID、跨客户端继续对话或本地进程重启后，不能保证恢复之前只存在缓存中的签名。[本地签名缓存](../plugins/omp/ag2api/internal/api/zproxy_signatures.go)

数据 URL 内联媒体可交给原协议构造器；普通远程媒体 URL 须由调用方先内联。适配层不下载任意 URL。上游本来可表示的 YouTube 引用保持引用，不在 worker 下载。没有接入原项目的管理 UI、图片/视频专用 API、账户导入、自动更新或独立记录库。仍只支持本项目的两个 OpenAI completion 入口；旧文本补全的单 prompt、单结果等限制不变。

## 启用与验证

在现有远端私有配置加入：

```json
"antigravity2api": true
```

如需多账户、模型回退和共享健康策略，继续配置原来的 `shimsConfig` / `lazy-router`。选中 `google-antigravity` 后才进入 Go 适配。客户端收到受限的 codec recipe 后自动启动本地 Go worker。第一次收到 AG 响应后，请求插件启用本地签名补全；未使用 AG 的 client 不会为此增加每请求 IPC。

构建普通 OMP 依赖后执行：

```sh
python3 scripts/prepare-ag2api.py
python3 scripts/smoke-ag2api.py --binary plugins/omp/bin/zproxy-ag
python3 scripts/smoke-omp.py --binary artifacts/linux-x64/ZProxy \
  --omp-dir plugins/omp --antigravity2api
```

构建固定 Go 1.27.4，验证上游提交、模块文件摘要、`go.sum` 与许可证，再测试新增的 API、service、worker 三个包。AppImage 包含 worker 与实际链接模块的许可，不包含 Go SDK、构建缓存或原项目完整程序。`bundle.json` 记录上游、适配文件、工具链和二进制摘要。[来源锁定](../plugins/omp/upstream.lock.json)、[打包说明](../packaging/README.md)

测试使用自有内存和 loopback 上游，覆盖工具与正文签名、provider 隔离、真实 OMP 账户限制、错误/取消、上下行双工、流式和非流式响应。NativeAOT smoke 在主 chat 流尚未结束时让六个 legacy 请求同时到达上游，并继续验证下一轮正文签名、原始字节统计和全部子进程退出。CI 在实际 AppImage 解包后再次运行这条流程，隐藏主机 Bun、Go 和 .NET 命令。

AG 的完整烟测需要 Linux 用户、网络和挂载命名空间，以及 `unshare`、`ip`、`mount`、`openssl`。它在隔离命名空间内使用临时证书和自有 HTTPS 服务，不修改宿主机的 hosts 文件或信任存储；命名空间不可用时明确失败，不跳过。

这些验证证明固定版本间的协议组合与生命周期；没有使用真实 AG 账号验证所有模型，也没有据此发布吞吐、首字延迟或 RSS 提升百分比。真实 provider 的行为和配额仍须在部署环境观察。
