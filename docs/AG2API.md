# Antigravity2API 协议插件

AG 适配属于可选 OMP 重插件。`remote.json` 的 `antigravity2api: true` 让最终选中的 `google-antigravity` 模型使用固定版本 Antigravity2API 的协议处理；其他 provider 保持原路径。客户端仍只提供 `/v1/chat/completions` 和 `/v1/completions`。

## 为什么使用薄 Go worker

固定源为 [Antigravity2API 0.1.8 / d36920f](https://github.com/Mag1cFall/Antigravity2API/tree/d36920f3e178eb6d94a49c0b184947cb7df8b3b1)，使用 MIT 许可。原 `serve` 程序会创建自己的账户存储、令牌刷新、账号调度、管理服务和数据库；指定账户也仍会经过其并发、冷却与重试策略。其生成客户端还会在远端解码并保存响应。这些行为与本项目的远端共享账户、本地解析边界不同。

我们将 [ag2api](../plugins/omp/ag2api) 中的少量 Go 文件加入固定上游模块，复用它现有的 `internal/api` 请求解析与 OpenAI 字段映射、`internal/service` 请求准备与输出规则，以及 `internal/antigravity` 的 `BuildEnvelope` / `DecodeStream`。这些包是 Go `internal` 包，因此适配文件必须在该模块内编译。源码中的原文件不被覆盖，worker 也不实例化原项目的网络客户端、账户池或服务主机。[构建脚本](../scripts/prepare-ag2api.py)

新 worker 只监听私有 Unix socket；由 OMP worker 管理生命周期。`CGO_ENABLED=0` 产出静态可执行文件，不需要主机 Go 运行时。请求准备与本地解码可并发处理，没有每账户信号量或独立待执行队列。F# 主程序继续使用 NativeAOT，未改为嵌入 Go 或 Bun。

## 两端分工

| 环节 | 执行位置 | 具体责任 |
| --- | --- | --- |
| 用户认证与报告 | 远端 F# | UUID 认证、昵称统计；AG 不增加第二套用户体系 |
| 路由和账户 | 远端 OMP | 使用现有共享路由与官方 AuthStorage；选择模型和账户、刷新凭据、记录健康和配额 |
| 请求准备 | 远端 Go | 接收 OpenAI 请求、选中模型的公开参数及服务端 project/session，生成 AG 请求正文；不接收 access token 或上游 URL |
| 发请求和控制续传 | 远端 OMP | 带选中账户的凭据发 HTTP 请求；有限首段错误检查、usage、协议 CONTINUATION；交接原始响应 |
| 下行解析与编码 | 本地 Go | 解析 AG SSE，应用原项目的输出规则，输出 OpenAI JSON/SSE；没有账号库、token、project 或实际上游 URL |
| 多轮签名 | 本地 Go → 远端 Go | 本地保存匹配历史所需的 thought signature；下一轮经加密隧道交回，远端检查后填入模型历史 |

远端使用官方账户解析和 refresh。401 可刷新本次选定的同一账户；切换账户由外层路由负责。403、429、配额信息和内容拒绝保留各自语义，不由 Go worker 另起重试。已经交接给本地的响应不会自动重放。[远端适配](../plugins/omp/remote-antigravity.mjs)

启用 AG 也通过 OMP 的官方 opt-in 配置打开当前默认暂停的 provider。用于保存既有设置的只读 getter 与交接补丁一样受固定源码摘要检查；关闭最后一个使用方时只撤销本插件加入的项。此设置不改变 OAuth 规则、证书校验或上游返回的错误。[官方补丁](../plugins/omp/patch-upstream.mjs)

## 行为与资源边界

AG 模型的实际 wire ID、可用档位和 wire profile 来自选中账户的 OMP 目录。不会用另一个账户的 profile，也不会另建一份 Go 模型发现或路由目录。工具定义、历史、参数、工具名称修复、stop、JSON/schema 输出、usage 和 finish reason 复用固定上游规则。`reasoning_effort: "none"` 对必须思考的模型隐藏思考输出；只有 OMP 目录明确允许关闭的模型才设置零思考预算和关闭输出思考。

AG 的 provider、模型和账户不再使用旧路由中的固定 `maxInFlight` 限额，本地 AG 解码也不进入普通 OMP 解析器的 4 路上限。整个隧道仍受 `--max-streams` 和每流字节额度控制，默认一条隧道最多 16 路，可配置 1–256 路。这是共享传输的资源预算。上游配额和真实限流不会因此消失；其他 provider 的并发配置保持原行为。[路由组合](../plugins/omp/remote-routing.mjs)

私有 Go HTTP 请求、响应同时流动，并通过读写背压衔接。取消会关闭上传与下载、终止解码并回收读取任务；不为慢消费者积累无界事件队列。每次原请求最多 64 MiB，原始下行最多 128 MiB，累计解码内容最多 16 MiB。显式 `--omp-reasoning-order` 的可见输出缓冲另限 16 MiB。非流式结果和原库的输出状态仍会占内存，这不是常数 RSS 的承诺。

本地沿用原输出层的 120 秒事件等待期限：只收到 SSE 注释心跳而没有新的模型事件，不会重置这项期限。它独立于远端按原始字节计时的 `idleTimeoutMs`；调高远端设置不会延长本地这项等待。

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

这些验证证明固定版本间的协议组合与生命周期；没有使用真实 AG 账号验证所有模型，也没有据此发布吞吐、首字延迟或 RSS 提升百分比。真实 provider 的行为和配额仍须在部署环境观察。
