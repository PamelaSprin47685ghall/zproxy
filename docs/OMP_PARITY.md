# OMP 兼容功能盘查与迁移边界

本次把 zproxy 作为主程序，OMP 作为选配的 Bun 工作进程。远端运行真实的官方 OMP gateway，负责模型目录、请求构造、账户选择、刷新、共享健康状态和发请求。本地运行官方 OMP provider 的响应适配器，负责把上游原始流转换为 OpenAI 响应。旧 `omp-shims` 的整个 preload/runtime 不再加载。

这不是把 13 个旧功能全部判定为“官方已经支持”。已经有官方实现的部分直接复用；仍然需要的策略留在相应边界；与加速目标冲突的旧行为明确退出，见下面逐项说明。

## 审计基线

| 项目 | 固定版本 | 依据 |
| --- | --- | --- |
| OMP | `18.20.3`，`67ef5342de6c24587fc59a6dbd3a2ab918510541` | [官方源代码](https://github.com/can1357/oh-my-pi/tree/67ef5342de6c24587fc59a6dbd3a2ab918510541) |
| omp-shims | `2.0.0`，`34189f420516f5ceeb8373998cc31896553c57ea` | [13 项功能及默认配置](https://github.com/PamelaSprin47685ghall/omp-shims/blob/34189f420516f5ceeb8373998cc31896553c57ea/lib/config.mjs) |
| Bun | `1.4.4` | [构建锁文件](../plugins/omp/upstream.lock.json) |

构建下载固定提交，检查版本和摘要，再应用两处有前后摘要检查的 gateway 交接补丁。上游源文件变化时，构建失败，不能把旧补丁盲目应用到新版 OMP。补丁只增加交接接口和调用位置，不复制 provider 解析器。[补丁实现](../plugins/omp/patch-upstream.mjs)

## 13 项旧功能逐一处理

| 旧功能 | 最新官方能力与仍存在的差别 | 本次处理 |
| --- | --- | --- |
| `gateway-compat` | 官方 OpenAI gateway 仍先按请求 schema 校验。可选顶层 `tools: null`、`metadata: null` 与“省略字段”并不等价。 | **保留小型入口规范化。** 只删除这两个顶层空值，保留消息里的合法 `content: null`，不遍历修改工具参数。见 `contract.mjs`。 |
| `sse-heartbeat` | 官方 `openai-chat-server.encodeStream` 已每 15 秒输出 SSE 注释，并在完成或取消时停止计时器。 | **删除旧 shim，直接使用官方编码器。** 隧道保活与 SSE 注释属于不同层，不能互相代替。 |
| `reasoning-order` | 官方保留 provider 的事件次序，不保证所有 reasoning 都先于可见文本。旧 shim 为保证这一点，会把文本和工具调用一直扣留到完成。 | **保留为本地显式选项。** 默认按官方顺序立即输出。客户端 `--omp-reasoning-order` 开启严格 reasoning 在前，缓冲上限 16 MiB，超限返回流错误。不会为了这一偏好使所有请求默认失去文本流式输出。 |
| `tool-id-hash` | 官方已有 provider 对应的 ID 长度、字符和重复值规范化；这些处理不等于“对完整原 ID 做稳定哈希，并恢复调用方 ID”。 | **保留必要语义，移除旧共享 SQLite 映射。** 请求中规定的 `tool_calls[].id` 和 `tool_call_id` 使用完整原值的 SHA-256 派生 ID。本地用当前原请求建立恢复表。参数中的同名字符串保持不变。新 ID 长度为 34 个 ASCII 字符，映射跨重启稳定。只恢复当前请求中有依据的 ID，不猜测历史全局映射。 |
| `antigravity` | 官方已有模型 wire profile、thinking 档位、CCA schema 规范化、流错误处理及带 `continuationToken` 的续传。旧“只有思考就追加提示”“工具调用畸形就自动重新提示”、把 system 改成 user、固定 Ultra/Pro 排空顺序，并非这些官方能力的同义实现。 | **拆分处理。** 使用官方请求构造与账户策略；保留协议规定的显式续传，远端用原凭据接续，本地只看到拼接的原始流。退出旧语义重提示、system 身份改写及第二套直接读写凭据的账户路由。已经交付的输出不自动重放；需要新生成时由调用方重试。这些是有意的行为变化，不声称完全等价。 |
| `copilot-auto` | 官方提供 Copilot 凭据、请求头和协议适配；本次固定版本未提供旧 shim 的 `/auto` 会话协商行为。 | **保留远端功能。** Auto 请求先使用可解析的 bootstrap 模型，在真实上游请求的认证上下文内协商，使用官方请求构造器重新生成选中协议的请求。会话 token 留在远端；安全 recipe 描述实际返回的模型和协议。固定模型只在收到 `model_not_supported` 后协商。 |
| `lazy-router` | 官方账户轮换、限额和健康信息解决账户选择；旧虚拟模型计划、排序、亲和性、容量和模型间候选选择是另外一层策略。 | **保留真实的旧策略模块在远端。** 通过官方 AuthStorage 适配器和账户限制租约调用真实 gateway。所有用户共享模型健康与容量信息，凭据仍由远端解析。旧独立管理页面由 zproxy 的主密码管理与昵称统计页面取代，不再暴露旧页面里的账户详情。 |
| `cline-pin-upstream` | 官方可以表达 OpenRouter/Vercel gateway 路由字段，但不会替用户选择旧 Cline 配置里的每模型固定频道。 | **保留远端纯请求变换。** 复用旧 `rewriteClineBody`，写入两种频道字段，尊重已有显式 pin。认证头来自官方 OMP，不另建凭据读取或刷新机制。 |
| `ipv6-first` | 旧实现把域名改成 IP，再维护 Host/SNI 和顺序回退；它不是模型协议能力。 | **退出旧 IP 改写层。** 使用 Bun/系统正常网络栈和证书校验。地址选择次序可能与旧实现不同，不承诺严格“所有 IPv6 都试完再试 IPv4”。局部网络调优应在部署层解决。 |
| `plugin-bridge` | 最新 `ModelRegistry.registerProvider` 已注册 OAuth 和自定义 API；stock gateway 仍不会自动加载用户安装的 provider 插件。 | **保留远端插件主机，移除 registry prototype 补丁。** 复用旧插件发现、最小 host 与包名兼容模块，直接调用官方注册接口。自定义 transport 走官方远端转换回退，不假定插件一定遵守 fetch 交接接口。交互式 UI 扩展仍不属于 gateway 能力。 |
| `models-bridge` | stock auth-gateway 特意使用 `ignoreLocalModelConfig: true`，避免客户端本地配置覆盖 broker；本项目的 models.yml 明确由服务端管理员控制。 | **不再需要旧猴子补丁。** 远端直接以指定 models.yml 创建官方 ModelRegistry。URL、API key、header 和 OAuth 配置均留在服务端。这个替代来自部署边界改变，而不是声称 stock gateway 已自动启用该文件。 |
| `traffic-log` | 新的按用户计数可以说明请求数、字节量、耗时和结果；它不等于旧的完整请求正文诊断日志。 | **退出旧正文流量日志。** 公开页面只显示昵称和计数，不记录或公开 prompt、工具正文、UUID、账户或 token。完整正文留存不是完成模型请求所必需的功能，也会增加远端开销。 |
| `kiro-credential-sync` | 官方 AuthStorage 已主动采用共享 OMP 数据库的外部变化；这不等于监视 `kiro-cli` 自己的另一个数据库。 | **保留远端外部来源同步。** 只读 CLI 的 token 行，校验后通过官方 `storage.credentials.upsert` 更新已存在的 OAuth 身份。观察数据库及 WAL 变化；多账户无法可靠匹配时不猜测，不复制给客户端，也不沿用旧 shim 对 OMP 表结构的直接 SQL 更新。 |

上述仍需保留的远端兼容功能通过远端配置的 `shimsConfig` 读取固定的 v2 配置。没有 `shimsConfig` 时不会加载这些可选策略。旧配置中的 Antigravity 重提示、IPv6 IP 改写和正文日志开关不再启用对应旧实现；迁移时应删除这些已退出的配置，避免把旧开关当作仍然有效。[远端兼容主机](../plugins/omp/remote-features.mjs)

官方实现依据：

- [OpenAI 入口校验、SSE 心跳和响应编码](https://github.com/can1357/oh-my-pi/blob/67ef5342de6c24587fc59a6dbd3a2ab918510541/packages/ai/src/providers/openai-chat-server.ts)
- [stock gateway 的模型目录边界](https://github.com/can1357/oh-my-pi/blob/67ef5342de6c24587fc59a6dbd3a2ab918510541/packages/coding-agent/src/cli/auth-gateway-cli.ts)
- [官方 provider/OAuth/custom API 注册](https://github.com/can1357/oh-my-pi/blob/67ef5342de6c24587fc59a6dbd3a2ab918510541/packages/coding-agent/src/config/model-registry.ts)
- [共享凭据数据库变化的采用](https://github.com/can1357/oh-my-pi/blob/67ef5342de6c24587fc59a6dbd3a2ab918510541/packages/ai/src/auth/pool.ts)与[账户优先级、保留配额和限制租约](https://github.com/can1357/oh-my-pi/blob/67ef5342de6c24587fc59a6dbd3a2ab918510541/packages/ai/src/auth/types.ts)
- [Antigravity/CCA 请求、wire profile、显式续传与响应处理](https://github.com/can1357/oh-my-pi/blob/67ef5342de6c24587fc59a6dbd3a2ab918510541/packages/ai/src/providers/google-gemini-cli.ts)及[Google schema 规范化](https://github.com/can1357/oh-my-pi/blob/67ef5342de6c24587fc59a6dbd3a2ab918510541/packages/ai/src/utils/schema/normalize.ts)
- [官方 OpenAI 路由字段应用](https://github.com/can1357/oh-my-pi/blob/67ef5342de6c24587fc59a6dbd3a2ab918510541/packages/ai/src/providers/openai-shared.ts)与[Copilot 请求认证头](https://github.com/can1357/oh-my-pi/blob/67ef5342de6c24587fc59a6dbd3a2ab918510541/packages/ai/src/providers/github-copilot-headers.ts)

## 哪些上游真的移到本地解析

| 官方上游 API | 交接方式 | 本地实际解析器 |
| --- | --- | --- |
| `passthroughProviders` 明确选中的自定义同协议 OpenAI provider | 服务端解析地址与凭据后直接透传 OpenAI 响应 | 不运行 provider 响应转换；仅适用于符合直通条件的 Chat 请求 |
| `openai-completions` | 成功的原始 SSE | 官方 `streamOpenAICompletions` |
| `openai-responses`、`openai-codex-responses`、`azure-openai-responses` | 原始 Responses SSE | 官方 `streamOpenAIResponses` |
| `openrouter` | 按实际请求/协商协议选择 | 上述官方 Chat 或 Responses 解析器 |
| `anthropic-messages` | 原始 Messages SSE | 官方 `streamAnthropic` |
| `google-generative-ai`、`google-vertex` | 原始 Google SSE | 官方 `streamGoogle` |
| `google-gemini-cli` | 原始 CCA 封装 SSE | 官方 `streamGoogleGeminiCli` |
| Bedrock、Cursor、Ollama、CLI/ACP、Apple 等其他 API | 保留官方远端完整处理 | 本地直接透传官方 OpenAI 结果 |
| 插件自定义 transport，包括覆盖标准 API 名称的实现 | 保留官方远端完整处理 | 不假定其网络请求可被 fetch 接口拦截 |

回退维持上游可用性，但对应请求的解析 CPU 和内存仍在远端。它不构成“所有 provider 都已卸载到本地”的承诺。官方自己明确说明 Bedrock AWS SDK、Cursor HTTP/2 等 transport 不经过 `StreamOptions.fetch`。[官方 fetch 接口说明](https://github.com/can1357/oh-my-pi/blob/67ef5342de6c24587fc59a6dbd3a2ab918510541/packages/ai/src/types.ts)

同协议直通由管理员在 `passthroughProviders` 显式列出 `models.yml` 自定义 provider。模型必须使用 `openai-completions`，以 API key 认证或明确配置 `auth: "none"`。它跳过模型响应的语义转换，仍保留服务端凭据解析、认证重试、usage 观察和统计。请求保留原 tool-call ID，响应保留原字节和上游 `model` 值，不改成公开别名。内建 provider 定义、OAuth 账户池、自定义插件 transport 以及旧文本 completions 不走这条捷径，避免绕过它们需要的官方请求处理。[同协议直通](../plugins/omp/remote-passthrough.mjs)

本地解析使用一次性的 Response 回放接口：官方解析器只可消费提供的这一份响应。它拿不到上游地址和凭据，不能发起重试，也不能访问网络。调用方原请求只用于 OpenAI 选项、工具定义、请求模型别名和工具 ID 恢复；供官方请求构造器运行的占位内容不会发到任何上游。[本地解析实现](../plugins/omp/local-codec.mjs)

Google 的 `CONTINUATION` 属于协议控制，需要服务端凭据继续请求。远端保留原 URL 和请求上下文，只解释该控制信息并完成续传，然后把结果作为一个流交给本地。远端还进行有限的首事件错误检查和 usage 记录检查。因此，远端是**减少响应语义处理**，并非完全不看任何 JSON 字节。[远端交接](../plugins/omp/remote-handoff.mjs)、[Google 控制续传](../plugins/omp/remote-google.mjs)

## 客户端协议范围

仅接受 OpenAI `/v1/chat/completions` 和 `/v1/completions`。不对外提供 Anthropic Messages、Responses、模型管理或任意目标代理接口。

Chat 的 streaming 与非 streaming 都使用官方 OpenAI 编码器，保留文本、reasoning、工具调用和参数、Google thought signature、finish reason、错误和 usage。非 streaming 请求仍可在远端请求原始 SSE，由本地汇总最终 JSON。

旧 `/v1/completions` 接受一个文本 prompt，或只含一个文本的数组，`n` 为 1。它经官方 Chat 请求/响应适配后输出 `text_completion`。批量 prompt、token ID prompt、`echo`、`suffix`、`logprobs`、`best_of > 1` 和 `n > 1` 不做不可靠模拟，明确拒绝。只提供 Chat 的上游不天然具有旧文本补全接口的所有能力。[入口与限制](../plugins/omp/contract.mjs)

## 凭据边界、资源上限与可验证事项

安全 recipe 只包含固定 API 枚举、公开 provider/model 名、输入类型、模型容量和少数已列举的解析兼容开关。F# 与 JS 两端拒绝未知字段、重复字段、控制字符和越界值。禁止 URL、header、API key、OAuth token、credential ID、账户快照和任意 options 包。recipe 最多 8 KiB，私有 IPC 的上下文 envelope 最多 64 KiB。[契约](../plugins/omp/contract.mjs)、[F# 校验](../src/ZProxy/OmpMetadata.fs)

原请求最多 64 MiB，由本地 F# 保存到私有临时文件；关闭响应或取消请求会清理。Bun 本地工作进程最多同时解析 4 个响应，每个原始响应最多 128 MiB。选配的 reasoning 排序另有 16 MiB 上限。OMP 的官方事件对象和最终 message 仍需要内存；这些限制不等于常数内存，也不代表已经测得某个固定的内存下降比例。

验证包括五类官方响应解析器的实际 wire fixture、reasoning 与工具参数、原 ID 恢复、Google signature、usage、错误与截断、取消、字节上限、严格 recipe、Copilot 跨协议工具历史、Kiro 官方存储调用、真实插件导入及初始化超时清理。私有 Unix HTTP 测试要求请求体尚未 EOF 时已经收到响应；`smoke-omp.py` 则用本地假上游启动真实 NativeAOT server/client 与两个 Bun worker，检查转换后的内容提前到达、并发请求、远端认证头、公开昵称统计、原始字节统计和子进程退出。

这些测试只访问自建内存或 loopback fixture。没有用真实 provider 账号验证所有模型。受限开发执行器不允许监听 Unix socket 时，应将该项标记为 CI 待验证，而不是跳过 CI 或声称已经实测通过。发布门禁还在解包后的 AppImage 上运行同一完整烟测。[解析测试](../plugins/omp/local.test.mjs)、[远端兼容测试](../plugins/omp/remote-features.test.mjs)、[完整烟测](../scripts/smoke-omp.py)
