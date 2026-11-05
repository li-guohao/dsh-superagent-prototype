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

只用 maildrop、机器上也没有 `gh` 时，**显式声明无仓库模式**，否则 setup 会停在「缺仓库 / 缺 GitHub CLI」面板：

```yaml
- id: dsh-superagent
  config:
    stateDir: <绝对路径>
    repositoryMode: no-repository
```

`repositoryMode` 默认 `required`（要求仓库 + `gh`）。设为 `no-repository` 时，解析出来的 Deployment **不携带** `repository` 与 `github` 字段（不是空字符串占位），`gh` 垫片会直接失败而不是转发给真实 `gh`，worker 的 gitconfig 也不写 credential helper。名字里的 `no-repository` 是唯一判据；不声明它就必须配仓库，二者没有中间状态。

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
- 出现 `receive returned duplicate for <file>` → 见 §8 第 2 条。

投递一个文件（文件名会被字典序排序，cursor 是**文件名字符串**，新文件名必须大于旧 cursor）：

```json
{"id":"chain-10","from":"dev@acme.com","thread":"r10-thread",
 "text":"reply with FULL_CHAIN_OK and nothing else","at":"2026-11-03T18:05:00+08:00"}
```

## 7. 验收（三条同时成立才算通）

1. `outbox/` 出现 `<hash>.json`，`kind=acknowledgement`，`text` 是模型给的回复。
2. `examples/requests.jsonl` 新增行，且 `Authorization: Bearer <你的占位 key>`、`model` 与 patch 一致。
3. `<STATE_DIR>/orchestrator.sqlite` 里 `decision.kind=accept`、`ticketId` 非空、`outbox.status=sent`。

## 8. 常见故障

| 现象 | 原因 | 处理 |
|------|------|------|
| `Lock file is already being held` | 上一个 dsh 被强杀，proper-lockfile 未释放（stale 阈值 30s） | 删掉 `<STATE_DIR>.lock` 再启动，或等 30s |
| `receive returned duplicate for <file>` | 旧版本的 `maildropTrigger` 用无参 `key()` → 所有邮件共享同一个常量 trigger id，同一 stateDir 下只有第一条有效。**本分支已修复**：trigger id 现在是 `key('maildrop', <邮件 id>)`，稳定且逐条唯一 | 旧 stateDir 里那条历史记录不迁移（cursor 已越过其文件名，不会重收）；升级后投新文件即正常 |
| `Stream ended without finish_reason` | 端点没按 `stream: true` 回 SSE | 见 §4.1 |
| `Connection error` / `TRANSPORT` | SSE 无 `Content-Length`；或端点处理异常导致请求线程崩溃 | 见 §4.2；同时检查端点 stderr 有没有 traceback |
| `This is an explicit request, which is routed instead of assessed` | 用了 `orchestrator_eval_decide` | 见 §4.3 |
| `no credential for provider route ...` | 环境变量没随进程注入 | 见 §5 |
| outbox 空但 requests.jsonl 有行 | 模型只回了文本，没调用工具 → 没有决策/工单 | 确认端点确实返回 `tool_calls` 且 `finish_reason=tool_calls` |

## 9. 清理

停掉 dsh 后删除 `<MAILDROP_DIR>` 与 `<STATE_DIR>` 即可；
Session 记录在 `$DSH_HOME/sessions/<cwd hash>/<session id>/session.v4.jsonl.zstd`（zstd 压缩 JSONL，
是排查 `turn/end` 失败原因的权威证据）。
