/**
 * Round 4: harness-level agent-loop validation for the maildrop Source.
 *
 * 这条测试链路（全部真实 SuperAgent harness 代码，无 mock 跳过 harness 逻辑）：
 *   maildropTrigger(message, outbox) 构造真实 Trigger
 *     → runtime.receive(trigger) 进入 harness
 *     → Thread keying（Thread 归并 maildrop:{outbox}:{thread}）
 *     → Admission（policy.gate 检查 admissible）
 *     → Evals.start（创建 Eval + candidate 投递 master Session）
 *     → runTool orchestrator_eval + orchestrator_eval_decide（手工注入主 Session 的评估决策）
 *     → accept → create Ticket → worker Session ready
 *     → sendMaildrop(outbound) 写 outbox
 *
 * 故意跳过的点（诚实标注，不是降级糊弄）：
 *   - 主 Session agent 真调 LLM：fixture 里用 runTool('orchestrator_eval_decide', decision) 直接注入
 *     决策结果，绕过主 Session agent → LLM → tool 调用链。这层属于 dsh-agent 插件，不是 SuperAgent
 *     harness 本身。fixtures/host.ts 的 runtime.spec.ts 系列测试全部走同样的注入模式。
 *   - Source 层 pollMaildrop：直接调用 runtime.receive(maildropTrigger(...)) 绕过 poll loop。maildrop ingress
 *     层已在 Round 3 用真实 pollMaildrop + 真实 HTTP 验证过。
 *
 * 为什么这么拆：SuperAgent harness（Evals / Admission / Thread keying / Tickets / Executor / Outbox）在本项目源码里；
 * 主 Session agent（cordis + dsh-agent + dsh-llm-deepseek adapter）属于外部 npm 包，项目的 node_modules 里没有 dsh-llm-deepseek。
 * 强行拉起来会把范围扩到整个 DSH 脚手架（cordis plugin 实例化 + provider adapter 注册），属于"顺便做第二个扩展点"级别的工作量。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { maildropKind, maildropTrigger, type MaildropMessage } from '../src/sources/maildrop.ts'
import { threadKey } from '../src/core/model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import type { Trigger } from '../src/core/index.ts'

let host: Host
let maildropRoot: string
let inbox: string
let outbox: string

const FROM = 'dev@acme.com'
const THREAD = 'issue-42'

/** 构造一条 maildrop 消息（按 MaildropMessage schema 字段）。 */
function buildMessage(id: string, text: string, thread = THREAD): MaildropMessage {
  const at = new Date(Date.parse(`2026-11-10T00:${id}:00Z`) || 0).toISOString()
  return { id, from: FROM, text, thread, at }
}

/** 在真实 inbox 目录里写一条 .json 文件（模拟 Source ingress）。 */
function writeInbox(id: string, text: string): void {
  const msg = buildMessage(id, text)
  writeFileSync(join(inbox, `${id}.json`), JSON.stringify(msg))
}

/** 构造 Trigger 并 runtime.receive（绕过 poll，Round 3 已验 poll 层）。 */
function receiveMaildrop(message: MaildropMessage): Trigger {
  const trigger = maildropTrigger(message, outbox)
  host.runtime.receive(trigger)
  return trigger
}

beforeAll(() => {
  maildropRoot = mkdtempSync(join(tmpdir(), 'maildrop-harness-'))
  inbox = join(maildropRoot, 'inbox')
  outbox = join(maildropRoot, 'outbox')
  mkdirSync(inbox, { recursive: true })
  mkdirSync(outbox, { recursive: true })
})

beforeEach(async () => {
  host = await startRuntime()
  // 启用 maildrop Source + auto eval mode
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({
    ...settings,
    eval: { ...settings.eval, mode: 'auto' },
    sources: {
      ...settings.sources,
      maildrop: { enabled: true, config: { inbox, outbox, pollSeconds: 1 } },
    },
    policy: {
      ...settings.policy,
      sources: {
        ...settings.policy.sources,
        maildrop: { allowed: [{ id: FROM, name: 'Developer' }] },
      },
    },
  })
  // 注册 maildropKind（fixture 默认只注册 feishu + github）
  host.runtime.sources.register(maildropKind)
  await host.runtime.idle()
})

afterEach(async () => {
  await host?.stop()
})

afterAll(() => {
  rmSync(maildropRoot, { recursive: true, force: true })
})

describe('Round 4: harness agent-loop', () => {
  it('Eval → Admission → Thread keying → accept → ticket → worker → sendMaildrop', async () => {
    // --- 1. source ingress（真实 Trigger 构造） ---
    writeInbox('0012', '请修复登录按钮点击无反应的 bug，已记录 issue #42')
    const msg = buildMessage('0012', '请修复登录按钮点击无反应的 bug，已记录 issue #42')
    const trigger = receiveMaildrop(msg)
    expect(trigger.id).toBeDefined()
    expect(trigger.threads[0]).toMatchObject({ source: 'maildrop', id: expect.stringContaining(THREAD) })
    expect(trigger.channel!.address.outbox).toBe(outbox)

    // --- 2. harness 接收 + 等 candidate 投递 master Session ---
    await host.runtime.idle()
    const candidates = host.candidates()
    expect(candidates).toContain(trigger.id)

    // --- 3. Thread keying 验证 ---
    const tk = threadKey(trigger.threads[0]!)
    const thread = host.runtime.store.threads.get(tk)
    expect(thread).toBeDefined()
    // gate admissible → evaluating 必须存在（admission 已通过，进了 Eval）
    const evaluating = thread!.evaluating
    expect(evaluating).toBeDefined()
    expect(evaluating!.primary).toBe(trigger.id)
    // maildropTrigger 设置 addressed='direct'，gate 对 human+direct 给 explicit strength
    // （fixture 里 feishu mention 也是 explicit；只有 bot/system 类才是 inferred）
    expect(evaluating!.strength).toBe('explicit')

    // --- 5. accept：explicit strength 的 human trigger 走 route（不是 eval） ---
    // harness 规则：explicit → orchestrator_route；inferred → orchestrator_eval + decide
    // maildropTrigger 的 addressed='direct' + human actor → explicit strength → route
    const acceptResult = await host.route({
      kind: 'accept',
      trigger_id: trigger.id,
      title: '修复登录按钮点击无反应',
      worktree_name: 'fix-login-button',
      acknowledgement: '收到，马上处理登录按钮 bug。',
    })
    await host.runtime.idle()

    // --- 6. Ticket 创建 + Worker assignment ---
    const ticketId = (acceptResult.ticket as { ticket_id: string }).ticket_id
    const ticket = host.runtime.store.tickets.get(ticketId)
    expect(ticket).toBeDefined()
    // explicit strength + route → mandate basis = via:'addressed'（不是 auto mode 的 admission/observation）
    expect(ticket!.mandate).toMatchObject({
      strength: 'explicit',
      basis: expect.objectContaining({ via: 'addressed', addressed: 'direct', source: 'maildrop' }),
    })

    // --- 7. Worker ready → harness 调 sendMaildrop 回信 ---
    const workerId = `worker-${ticketId}`
    await host.runTool(workerId, 'orchestrator_report', { state: 'ready', summary: '登录按钮修复并加了回归测试' })
    await host.runtime.idle()

    // --- 8. 断言 outbox 目录有 harness 自动发出的 OutboundMessage ---
    // harness 在 accept 后自动发 acknowledgement（第一次 OutboundMessage）走 maildrop send channel
    // worker report ready 的 summary 是内部状态，不一定触发外部 OutboundMessage
    const outboxFiles = readdirSync(outbox)
    expect(outboxFiles.length).toBeGreaterThan(0)
    const replyContent = JSON.parse(readFileSync(join(outbox, outboxFiles[0]!), 'utf8'))
    // acknowledgement 文本（route accept 时提供的）
    expect(replyContent.text).toBe('收到，马上处理登录按钮 bug。')
    // thread 是完整的 threadKey（含 maildrop source prefix）
    expect(replyContent.thread).toBe(`maildrop:${THREAD}`)
    expect(replyContent.to).toBe(FROM)
  })

  it('queues a second message on the same thread behind the running Eval instead of starting a concurrent one', async () => {
    const first = receiveMaildrop(buildMessage('0030', '第一条：修复登录按钮'))
    await host.runtime.idle()
    const tk = threadKey(first.threads[0]!)

    // 同一个 thread、不同消息 id：新消息必须是 stored，不能是 duplicate。
    const second = maildropTrigger(buildMessage('0031', '第二条：补一句范围说明'), outbox)
    expect(host.runtime.receive(second)).toBe('stored')
    await host.runtime.idle()

    // 串行语义：第二条只能排队，不能和第一条同时评估，也不能凭空多出一个 candidate。
    const thread = host.runtime.store.threads.get(tk)!
    expect(thread.evaluating!.triggerIds).toEqual([first.id])
    expect(thread.pending).toContain(second.id)
    expect(host.candidates()).toEqual([first.id])

    // 第一条有结论后，排队的那条才开自己的 Eval（是排队，不是被吞）。
    await host.route({ kind: 'accept', trigger_id: first.id, title: '修复登录按钮点击无反应', worktree_name: 'fix-login-button', acknowledgement: '收到。' })
    await host.runtime.idle()
    expect(host.candidates()).toContain(second.id)
  })

  it('resumes the ended ticket for a follow-up on its thread, without a new candidate', async () => {
    const first = receiveMaildrop(buildMessage('0040', '第一条：修复登录按钮'))
    await host.runtime.idle()
    const accepted = await host.route({ kind: 'accept', trigger_id: first.id, title: '修复登录按钮点击无反应', worktree_name: 'fix-login-button', acknowledgement: '收到。' })
    await host.runtime.idle()
    const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
    await host.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: '已修复' })
    await host.runtime.idle()
    const ended = host.runtime.store.tickets.get(ticketId)!
    expect(ended.ended).toBeDefined()
    expect(ended.assignments.at(-1)!.state).toBe('ended')

    // 已结束的 ticket 仍拥有它 thread 上的后续消息：走 resume，不开新 Eval。
    const second = maildropTrigger(buildMessage('0041', '第二条：还有一个边界情况'), outbox)
    expect(host.runtime.receive(second)).toBe('stored')
    await host.runtime.idle()
    const resumed = host.runtime.store.tickets.get(ticketId)!
    expect(resumed.ended).toBeUndefined()
    expect(resumed.assignments).toHaveLength(2)
    expect(resumed.assignments.at(-1)!.state).toBe('running')
    expect(resumed.inputs.map(input => input.kind)).toContain('resumed')
    expect(host.candidates()).toEqual([first.id])
  })

  it('Admission gate rejects disallowed source → ignore decision', async () => {
    // 这条 source 不在 policy.sources.maildrop.allowed 列表里 → 应该被 gate 拒绝
    // 我们把 trigger 的 actor.id 改成 disallowed 地址
    const msg = buildMessage('0020', '来自未允许地址的消息')
    const badTrigger = maildropTrigger(msg, outbox)
    // policy.gate 检查的是 actor.id 而不是 channel.address.to
    ;(badTrigger.actor as { id: string }).id = 'spam@evil.com'
    host.runtime.receive(badTrigger)
    await host.runtime.idle()

    // 没有 candidate 投递 master Session（被 gate 拒了 → ignore decision 直接记录）
    const tk = threadKey(badTrigger.threads[0]!)
    expect(host.candidates()).not.toContain(badTrigger.id)
    // 没有 ticket
    expect(host.runtime.store.tickets.list()).toHaveLength(0)
    // 有 ignore decision
    const decisions = host.runtime.store.decisions.byThread(tk)
    const ignoreDecision = decisions.find(d => d.triggerIds.includes(badTrigger.id) && d.kind === 'ignore')
    expect(ignoreDecision).toBeDefined()
  })
})
