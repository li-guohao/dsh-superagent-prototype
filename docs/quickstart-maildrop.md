# Maildrop 快速上手：从零到一条端到端回信

目标：往 `inbox` 放一个 JSON，**不做任何手动触发**，由 poll loop 自己完成
`Source → orchestrator 评估/路由 → LLM → outbox 回信`。

本文所有 `<...>` 都是占位符，不含任何本机绝对路径或真实凭据。

---

## 1. bundle 必须装进 **Web** profile

本 bundle 的 `package.json` 声明了 `dsh.client.platform: "web"`，并注入一组 client UI 插件
（`dsh-client-ui-*`，用于 panel）。headless profile 没有 client host，bundle 装进去后不会激活，
所以要用 Web 模板建 profile：

```bash
dsh profile create smoke --template web      # 名字自选，别用日常工作 profile
dsh plugin --profile smoke add file:<repo 路径>
dsh --profile smoke --dump-config | grep -A2 dsh-superagent   # 能查到即装配成功
```

## 2. 准备三个目录

```
<MAILDROP_DIR>/inbox      # 投递入口，只放 *.json
<MAILDROP_DIR>/outbox     # 回信出口
<STATE_DIR>               # 必须显式配置，且路径要稳定
```

`stateDir` 必填的原因：运行时把 `orchestrator.sqlite`（trigger/disposition/thread/effect/decision/ticket/outbox）、
锁文件、以及 master Session 的身份都落在这里。换路径 = 换一个 orchestrator Session，历史 cursor 和 thread 全部作废。

## 3. profile patch

复制 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 到
`$DSH_HOME/profiles/smoke/cordis.patch.yml`，替换占位符。关键四行配置：

| 行 id | 必填字段 | 作用 |
|-------|----------|------|
| `dsh-superagent` | `stateDir` | 状态根目录（稳定绝对路径） |
| `dsh-superagent-maildrop` | `inbox` / `outbox` / `pollSeconds` | 文件邮箱 Source 与轮询间隔 |
| `llm-pi-ai` | `providers.<name>.api` `baseURL` `apiKeyEnv` | LLM provider |
| `agent-default-model` | `provider` / `model` | 主 Session 用哪个模型 |

真实 DeepSeek 不用 `llm-pi-ai` 的 `api` 字段，而是 `llm-deepseek` 行（无 `api:`），切换方法与凭据语义见 §10。

只用 maildrop、机器上也没有 `gh` 时，**显式声明无仓库模式**，否则 setup 会停在「缺仓库 / 缺 GitHub CLI」面板：

```yaml
- id: dsh-superagent
  config:
    stateDir: <绝对路径>
    repositoryMode: no-repository
```

`repositoryMode` 默认 `required`（要求仓库 + `gh`）。设为 `no-repository` 时，解析出来的 Deployment **不携带** `repository` 与 `github` 字段（不是空字符串占位），`gh` 垫片会直接失败而不是转发给真实 `gh`，worker 的 gitconfig 也不写 credential helper。名字里的 `no-repository` 是唯一判据；不声明它就必须配仓库，二者没有中间状态。

当前 `no-repository` 的支持边界（Round 19 修复后实测）：

- **能跑**：maildrop 触发 → orchestrator 首 turn 正常装配提示词 → `orchestrator_route` 的 accept/route 决策 → ticket 创建 → acknowledgement 出站。提示词里的 `DSH_SUPERAGENT_GITHUB_*` 变量会以空值列出；GitHub Source 的变量只在有仓库时有意义。
- **不能跑**：GitHub Source 的仓库相关能力（轮询、链接、PR 上下文）在无仓库形态下不可用；worker 内的 `gh` 垫片会直接失败。**worker 执行仍未验证**：本轮真跑中 worker 在隔离工作目录写出了文件，但最后一步以 `turn/end=max-tokens` 结束，没有回到 DONE。

## 4. 启动假 LLM 端点

```bash
python examples/fake_model_endpoint.py --port 18787 --reply "FULL_CHAIN_OK | {user_text}"
```

三个必须知道的点：

1. **必须支持 SSE 分块。** pi-ai 一律以 `stream: true` 请求；端点要回 `Content-Type: text/event-stream`
   的 `data:` 分块，并在最后一帧带 `finish_reason`。返回普通 JSON 会报
   `Stream ended without finish_reason`。
2. **SSE 响应必须自带长度定界。** 既没有 `Content-Length` 也没有 chunked 时，客户端会以
   `Connection error`（`TRANSPORT`）中断。示例脚本先缓冲整段 SSE 再带 `Content-Length` 发送。
3. **显式请求要走 route。** 评估轮示例脚本返回 `tool_call: orchestrator_route`（`kind=accept`）。
   用 `orchestrator_eval_decide` 会被拒绝：
   `This is an explicit request, which is routed instead of assessed`。

启动时脚本会清空 `examples/requests.jsonl`，之后每次请求追加一行 —— 这就是 replay log。

**跑 `pnpm check` 之前，必须让这个端点常驻。** `tests/maildrop-e2e.spec.ts` 会直连
`127.0.0.1:18787/v1/chat/completions`（可用环境变量 `FAKE_LLM_URL` 覆盖）。端点没起来时，
其中两条 e2e 用例必然报 `TypeError: fetch failed`，`Caused by: connect ECONNREFUSED 127.0.0.1:18787`
—— 这是环境没就绪，不是代码回归。

```bash
python examples/fake_model_endpoint.py --port 18787 &   # 先起端点
pnpm check                                              # 再跑全量检查
```

PowerShell 里用 `Start-Process python -ArgumentList "fake_model_endpoint.py","--port","18787" -WindowStyle Hidden`（工作目录 `examples/`）。

端口被占用时（启动报 `Address already in use`，或不确定是谁占着）：

- Windows：`Get-NetTCPConnection -LocalPort 18787 | Select-Object OwningProcess`，再 `Stop-Process -Id <pid>`；
- 不想动占用进程，就换端口：`python examples/fake_model_endpoint.py --port 18788`，并在同一个 shell 里
  设 `FAKE_LLM_URL=http://127.0.0.1:18788/v1/chat/completions`（PowerShell：`$env:FAKE_LLM_URL = '...'`）后再跑 `pnpm check`。

## 5. 启动 dsh（环境变量注入是唯一的硬坑）

`apiKeyEnv: FAKE_LLM_KEY` 读的是 **进程环境**，不是配置文件，也不是 shell 里随便 `set` 过的变量。
必须在启动同一个进程时注入：

```powershell
$env:FAKE_LLM_KEY = 'sk-dummy-fake'        # 占位假值，不要用真实 key
node <npm prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile smoke --no-open
```

```bash
FAKE_LLM_KEY=sk-dummy-fake dsh --profile smoke --no-open
```

缺失时不是 401，而是在 0ms 内拒绝构建请求，报错原文：

```
turn/end reason={"kind":"error","error":{"message":"llm-pi-ai: no credential for provider route
\"fake-local\"; its profile resolves FAKE_LLM_KEY, which is not set — store FAKE_LLM_KEY through the
credentials service (the web Models page writes it) or export it, and remove apiKeyEnv"}}
```

`turn/end` 是 Session persistence 的事件，不在 dsh 控制台日志里；日志里只表现为"turn 结束了但 outbox 没动静"。

## 6. 确认 poll loop 在跑（不要手动触发）

启动后 `<STATE_DIR>` 的 stdout 每 2 秒出现一组：

```
[maildrop] pollMaildrop: found 1 inbox files, cursor=""
[maildrop] pollMaildrop: calling source.receive for 0001.json id=<trigger id>
[maildrop] pollMaildrop: receive returned stored for 0001.json
[maildrop] pollMaildrop: done, stored=1
```

判读方式：

- 持续只有 `done, stored=0` → loop 活着，但没有新文件（正常空转）。
- 出现 `found N inbox files, cursor="..."` 且 cursor 在变 → cursor 在推进，ingest 生效。
- 出现 `receive returned duplicate for <file>` → 见 §9 第 2 条。

投递一个文件（文件名会被字典序排序，cursor 是**文件名字符串**，新文件名必须大于旧 cursor）：

```json
{"id":"chain-10","from":"dev@acme.com","thread":"r10-thread",
 "text":"reply with FULL_CHAIN_OK and nothing else","at":"2026-11-03T18:05:00+08:00"}
```

## 7. 验收（三条同时成立才算通）

1. `outbox/` 出现 `<hash>.json`，`kind=acknowledgement`，`text` 是模型给的回复。
2. `examples/requests.jsonl` 新增行，且 `Authorization: Bearer <你的占位 key>`、`model` 与 patch 一致。
3. `<STATE_DIR>/orchestrator.sqlite` 里 `decision.kind=accept`、`ticketId` 非空、`outbox.status=sent`。

## 8. 同一 thread 的后续消息怎么处理

maildrop 的 thread 由消息里的 `thread` 字段决定（缺省时用消息 `id`），所以**同一个 `thread` 投第二条消息，并不会被当成重复丢弃**，但也不一定开新一轮。判据只有一条：这个 Trigger 有没有被某个 ticket 拥有。三种状态分别处理：

| 该 thread 的状态 | 第二条消息的归属 | 是否产生新 candidate |
|------------------|------------------|----------------------|
| 有进行中的 Eval（上一条还没被评估完） | 进入 `thread.pending`，等这个 Eval 结束后并入下一批 | 当前不产生；Eval 结束后才产生 |
| 有 live ticket（在跑或等待报告） | 直接作为该 ticket 的 input，由它的 worker 决定 | 不产生（`orchestrator.followup` 事件，不进 Eval） |
| ticket 已结束且不是被人工 stop | 立刻 resume 同一个 ticket，沿用原 Mandate | 不产生（无新 Eval、无新 ticket） |
| 没有 ticket 拥有它（从未 accept、被 ignore、被 stop、被 handback） | 排队进 Eval | 产生 |

三条容易踩的预期偏差：

1. **一个 thread 同时只跑一个 Eval。** 这是刻意的串行语义（`docs/001-domain.md`：*At most one Eval runs on it at a time*），后续消息是**排队合并**，不是丢弃，也不是并发评估。
2. **ticket 已结束时走 resume，不走 Eval。** resume 只投递输入，**不产生 acknowledgement**，所以 outbox 不会自动多一封回信；如果 worker 没有主动回信，日志里看起来就"没反应"。这不是消息被吞。
3. **要真正开新一轮评估**，有三条正路：换一个 `thread`（等于新话题）；先 `stop` 掉现有 ticket（stop 之后的消息按"没有 ticket 拥有"走 Eval）；或从面板把这条消息送 Eval。原地重复发同 thread 消息只会进 ticket 或排队。

另外注意 trigger id 是 `key('maildrop', <消息 id>)`：**同一 thread 用不同的 `id` 才是新消息**；复用同一个 `id` 会被判 `duplicate` 静默跳过（见 §9）。

## 9. 常见故障

| 现象 | 原因 | 处理 |
|------|------|------|
| `Lock file is already being held` | 上一个 dsh 被强杀，proper-lockfile 未释放（stale 阈值 30s） | 删掉 `<STATE_DIR>.lock` 再启动，或等 30s |
| `receive returned duplicate for <file>` | 旧版本的 `maildropTrigger` 用无参 `key()` → 所有邮件共享同一个常量 trigger id，同一 stateDir 下只有第一条有效。**本分支已修复**：trigger id 现在是 `key('maildrop', <邮件 id>)`，稳定且逐条唯一 | 旧 stateDir 里那条历史记录不迁移（cursor 已越过其文件名，不会重收）；升级后投新文件即正常 |
| `Stream ended without finish_reason` | 端点没按 `stream: true` 回 SSE | 见 §4.1 |
| `Connection error` / `TRANSPORT` | SSE 无 `Content-Length`；或端点处理异常导致请求线程崩溃 | 见 §4.2；同时检查端点 stderr 有没有 traceback |
| `This is an explicit request, which is routed instead of assessed` | 用了 `orchestrator_eval_decide` | 见 §4.3 |
| `no credential for provider route ...` | 环境变量没随进程注入 | 见 §5 |
| `pnpm check` 里两条 e2e 报 `ECONNREFUSED 127.0.0.1:18787` | 跑测试前没起假端点（`tests/maildrop-e2e.spec.ts` 直连 18787） | 先起端点再跑，见 §4 末段 |
| outbox 空但 requests.jsonl 有行 | 模型只回了文本，没调用工具 → 没有决策/工单 | 确认端点确实返回 `tool_calls` 且 `finish_reason=tool_calls` |

## 10. 接真模型（可选）

假端点验证完链路后，把主模型换成官方 DeepSeek 只改两行。注意：**这个适配器没有 `api:` 字段**。
`dsh-base` 已经挂了 `@deepseek-ai/dsh-llm-deepseek`（route `deepseek-official`，Messages 线格式，
默认 `baseURL` 为 `https://api.deepseek.com/anthropic`），所以配置只是给它一个凭据引用：

```yaml
- id: llm-deepseek
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
```

[examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 里这段是注释掉的，取消注释即可切换。
模型 id 直接透传到 wire：不写 `models` 时默认广告 `deepseek-flash`（文本+图像）与 `deepseek-v4-pro`（纯文本）；
写 `models` 会**整体替换**默认列表。

`apiKeyEnv` 的语义：它只是一个**引用名**，不是值。适配器每次请求时按以下顺序解析：

1. 当前 endpoint 对应的 DeepSeek 账号凭据（`$DSH_HOME/.credentials.yaml` 里的 account token）；
2. credentials service 里以该引用名存储的条目（Web 的 Models 页写的就是这里）；
3. 启动 dsh 的**进程环境变量**同名项。

所以「环境变量里没有 key」不等于「没凭据」——先在 Models 页或 credentials service 里查一遍。真实 key
**不要**写进 `cordis.patch.yml`，也不要提交到仓库。

### 缺凭据时的真实报错（已实测）

用一个故意不存在的引用名 `DSH_R16_MISSING_KEY`、并把 `baseURL` 指到非 DeepSeek 源（让账号凭据不适用）
启动一次，`dsh headless` 的 stderr 原文：

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DSH_R16_MISSING_KEY through the credentials service (the web Models page writes it), or export DSH_R16_MISSING_KEY in the launching environment
```

可诊断性结论：报错同时给出**错误码**（`MISSING_CREDENTIAL`）、**适配器行 id**（`llm-deepseek`）、
**provider route**（`deepseek-official`）和**具体引用名**（`DSH_R16_MISSING_KEY`，即你的 `apiKeyEnv` 值），
并给出两条修复路径。定位到具体 provider/变量不需要改代码。

排查顺序：报错里的引用名是不是你在 `llm-deepseek` 行写的 `apiKeyEnv`？→ 这个引用名是否真的存在于
credentials service 或**启动进程的环境**（不是另一个 shell 里 `set` 过的）？→ 若用 `baseURL` 指向第三方
Messages 网关，账号凭据不适用，必须提供 API key。

### 最小成本真跑（已验证）

```bash
dsh headless --patch <overlay.yml> "Reply with REAL_OK only."
```

overlay 里把 `reasoningEffort` 设为 `off`、`maxTokens` 压到 16。**若不关 thinking**，16 token 会被
reasoning 吃光，`turn/end` 的 reason 是 `max-tokens` 且没有可见文本；这只是输出上限太小，不是链路故障。

注意 `maxTokens` 是**每个会话的输出上限**。要跑 maildrop → orchestrator 的路线决策，建议
`maxTokens ≥ 256`（本轮实测 320 可用）：128 会在 `orchestrator_route` 的 tool-call JSON 中途截断，
`turn/end` 的 reason 为 `max-tokens`，这一轮调用拿不到决策。16 只适合“只回一句”的连通性探针。
同一上限也作用于 worker——320 够完成 route，但本轮 worker 的最后一步仍被 320 截断。

## 11. 清理

停掉 dsh 后删除 `<MAILDROP_DIR>` 与 `<STATE_DIR>` 即可；
Session 记录在 `$DSH_HOME/sessions/<cwd hash>/<session id>/session.v4.jsonl.zstd`（zstd 压缩 JSONL，
是排查 `turn/end` 失败原因的权威证据）。
