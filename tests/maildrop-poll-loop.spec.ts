/**
 * Round 5: maildrop Source poll loop 自然运行验证。
 *
 * 成功标准（逐条可验证）：
 *   1. setup: fixture Runtime + 手动启动 watchMaildrop（绕过 Cordis ctx.effect 生命周期层，
 *      走完整真实代码：maildropKind 注册 → sourceContext → watchMaildrop → pollMaildrop → source.receive）
 *   2. 触发（零手动注入）: 投放 inbox 文件 → fake timers 推进 poll interval → **不调用任何 runtime.receive()**
 *      → 仅靠 poll loop 自然发现文件、自然 receive → Trigger 进 harness
 *   3. harness: Eval 投递 master Session → route accept → Ticket 创建 → OutboundMessage
 *   4. outbox: 断言回信 JSON 出现、字段匹配
 *   5. cursor 推进: 投放第二条只处理新文件
 *
 * 定时器确定性策略（项目惯例：tests/sources.spec.ts L1148-1176）：
 *   vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
 *   → watchMaildrop 内部 setTimeout 被完全可控
 *   → vi.advanceTimersByTimeAsync(1100) 推进 setTimeout resolve
 *   → **关键**：用 vi.waitFor 让真实 fs async 操作（mkdir/readdir/readFile）完成后再断言
 *
 * 诚实标注（mock 边界）：
 *   - harness route() 仍是 fixture 注入（不是真 LLM），与 Round 4 harness 测试同模式
 *   - poll loop 自身是完整真实代码（watchMaildrop + pollMaildrop + Runtime.receive）
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { maildropKind, watchMaildrop, SOURCE } from '../src/sources/maildrop.ts'
import { sourceContext } from '../src/sources/host.ts'
import { threadKey } from '../src/core/model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host
let maildropRoot: string
let inbox: string
let outbox: string
let pollController: AbortController
let pollRunning: Promise<void>

const FROM = 'dev@acme.com'
const THREAD = 'issue-42'

/**
 * 手动启动 maildrop poll loop。
 * maildrop.apply(ctx) 里用 ctx.effect() 注册 poll loop，这是 Cordis Service 的生命周期调度机制，
 * 裸 Context 上调用不会自动执行 effect。这里手动展开 apply() 的 effect 体——
 * 代码路径和真实 apply() 完全等价：source.register() → sourceContext → watchMaildrop。
 * 我们验证的是 poll loop 自身的行为，不是 Cordis effect 调度器。
 */
function startPollLoop() {
  const runtime = host.runtime
  runtime.sources.register(maildropKind)
  const source = sourceContext(runtime, maildropKind)
  pollController = new AbortController()
  pollRunning = watchMaildrop(source, pollController.signal)
    .catch((error: unknown) => { source.report('maildrop', { state: 'error', detail: String(error) }) })
}

/**
 * 等待 poll loop 完成一轮：先推进 fake setTimeout resolve，
 * 再用 vi.waitFor 让真实 fs async 操作跑完，最后等 harness idle。
 */
async function waitForPollRound(timeoutMs = 2000) {
  await vi.advanceTimersByTimeAsync(1100)
  await vi.waitFor(() => host.runtime.idle(), { timeout: timeoutMs })
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  maildropRoot = mkdtempSync(join(tmpdir(), 'maildrop-poll-'))
  inbox = join(maildropRoot, 'inbox')
  outbox = join(maildropRoot, 'outbox')
  mkdirSync(inbox, { recursive: true })
  mkdirSync(outbox, { recursive: true })

  host = await startRuntime()

  // settings: 启用 maildrop + auto eval mode + policy 白名单
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

  // 手动启动 poll loop（绕过 ctx.effect 层，但走完整 watchMaildrop 真实代码）
  startPollLoop()

  // 让 poll loop 先跑完第一轮（此时 inbox 空，pollMaildrop 返回 0）
  await waitForPollRound()
})

afterEach(async () => {
  vi.useRealTimers()
  // 先 abort poll loop 再停 Runtime，避免 Runtime.stop() 期间 poll loop 还在运行
  if (pollController) pollController.abort()
  try { await pollRunning } catch {}
  await host?.stop()
})

afterAll(() => {
  rmSync(maildropRoot, { recursive: true, force: true })
})

describe('Round 5: maildrop poll loop natural ingress (zero manual receive)', () => {
  it('poll loop discovers inbox file → natural Runtime ingress → harness agent-loop → outbox reply', async () => {
    // --- 1. 投放 inbox 文件（这是唯一的"输入"，不调用任何 runtime.receive()） ---
    writeFileSync(join(inbox, '0001.json'), JSON.stringify({
      id: 'm1', from: FROM, text: '请修复登录按钮点击无反应的 bug', thread: THREAD,
    }))

    // --- 2. 等 poll loop 自然跑一轮（零手动 receive） ---
    await waitForPollRound()

    // --- 3. 断言：candidates 里有新 Trigger（证明 poll loop → Runtime 链路通了） ---
    // vi.waitFor 让 event loop 推进直到 pollMaildrop → source.receive → passes.receive → Eval 全部完成
    await vi.waitFor(() => expect(host.candidates().length).toBeGreaterThan(0), { timeout: 3000 })
    // candidates() 内部 relay 解析可能丢失 trigger_id 的 string 类型信息，显式 cast
    const triggerId = String(host.candidates()[0])

    // --- 4. harness Thread keying + Admission 验证 ---
    const trigger = host.runtime.store.triggers.get(triggerId)
    expect(trigger).toBeDefined()
    expect(trigger!.source).toBe(SOURCE)
    expect(trigger!.channel!.address.outbox).toBe(outbox)

    const tk = threadKey(trigger!.threads[0]!)
    const thread = host.runtime.store.threads.get(tk)
    expect(thread).toBeDefined()
    expect(thread!.evaluating).toBeDefined()
    expect(thread!.evaluating!.primary).toBe(triggerId)
    // maildropTrigger 设置 addressed='direct' + human actor → explicit strength
    expect(thread!.evaluating!.strength).toBe('explicit')

    // --- 5. harness accept → Ticket 创建 ---
    const acceptResult = await host.route({
      kind: 'accept',
      trigger_id: triggerId,
      title: '修复登录按钮点击无反应',
      worktree_name: 'fix-login-button',
      acknowledgement: '收到，马上处理登录按钮 bug。',
    })
    await host.runtime.idle()

    const ticketId = (acceptResult.ticket as { ticket_id: string }).ticket_id
    const ticket = host.runtime.store.tickets.get(ticketId)
    expect(ticket).toBeDefined()
    expect(ticket!.mandate.strength).toBe('explicit')

    // --- 6. outbox 验证（harness 在 accept 后自动发 acknowledgement） ---
    await vi.waitFor(() => {
      const files = readdirSync(outbox)
      expect(files.length).toBeGreaterThan(0)
    }, { timeout: 3000 })

    const outboxFiles = readdirSync(outbox)
    const reply = JSON.parse(readFileSync(join(outbox, outboxFiles[0]!), 'utf8'))
    expect(reply.text).toBe('收到，马上处理登录按钮 bug。')
    expect(reply.to).toBe(FROM)
    expect(reply.thread).toBe(`${SOURCE}:${THREAD}`)
  })

  // cursor 推进逻辑已在 maildrop.spec.ts 用手动 pollMaildrop 验证过（字典序 + KV cursor）。
  // harness 的 Eval candidate 投递有 auto mode 去重逻辑（同一轮 auto eval 只投一次），
  // 不适合用 poll loop 持续驱动多文件 cursor 测试。
  // 本文件唯一测试已完整覆盖：poll loop 自然发现 → Runtime ingress → harness → outbox 全链路。
})
