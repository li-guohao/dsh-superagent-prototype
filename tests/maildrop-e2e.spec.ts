/**
 * Round-3 integration: drive the real maildrop Source through a fake LLM endpoint.
 *
 * What happens here (no harness boot required):
 *   1. Drop a JSON message file into an inbox directory.
 *   2. Poll with the real maildrop Source implementation (pollMaildrop) → Trigger.
 *   3. Call the real OpenAI-compatible fake endpoint over HTTP (no HTTP mocking).
 *   4. Build an OutboundMessage from the assistant content and deliver via sendMaildrop.
 *   5. Assert an outbox reply file was created AND the replay log proves the HTTP was real.
 *
 * Mock boundary (declared honestly): the fake LLM endpoint is mock; harness-level agent-loop
 * policies (eval, retries, admission, thread keying) are skipped; this script exercises the
 * Source ingress/egress plus one HTTP hop, not the full orchestrator lifecycle.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Health, SourceContext } from '../src/sources/host.ts'
import { maildropKind, pollMaildrop, sendMaildrop, SOURCE, type MaildropConfig } from '../src/sources/maildrop.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const FAKE_LLM = process.env.FAKE_LLM_URL ?? 'http://127.0.0.1:18787/v1/chat/completions'
// fake_model_endpoint.py writes here: Path(__file__).resolve().parent / "requests.jsonl"
const REPLAY_LOG = join(REPO_ROOT, 'examples', 'requests.jsonl')

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-superagent-r3-'))
  mkdirSync(join(root, 'inbox'), { recursive: true })
  mkdirSync(join(root, 'outbox'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const cfg = (): MaildropConfig => ({
  inbox: join(root, 'inbox'),
  outbox: join(root, 'outbox'),
  pollSeconds: 1,
})

function fakeSource(cfg_: MaildropConfig) {
  const state = new Map<string, unknown>()
  const received: import('../src/core/index.ts').Trigger[] = []
  const reports: { entry: string; health: Health }[] = []
  const source = {
    deployment: {},
    configured: () => true,
    config: () => cfg_,
    receive: (trigger: import('../src/core/index.ts').Trigger) => { received.push(trigger) },
    report: (entry: string, health: Health) => { reports.push({ entry, health }) },
    state: {
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => { value === undefined ? state.delete(key) : state.set(key, value) },
    },
  } as unknown as SourceContext
  return { source, received, reports }
}

describe('Round 3: maildrop ingress → fake LLM → outbox egress (real HTTP, real FS, real maildrop)', () => {
  it('takes an inbox message, hits the fake OpenAI-compatible endpoint, and delivers the reply', async () => {
    const config = cfg()
    writeFileSync(join(config.inbox, '0001.json'), JSON.stringify({
      id: 'm1', from: 'alice', text: 'fix the flaky test', thread: 'demo',
    }))
    const { source, received } = fakeSource(config)
    // --- ingress: real maildrop poll produces one Trigger ---
    expect(await pollMaildrop(source, config)).toBe(1)
    const trigger = received[0]!
    expect(trigger.source).toBe(SOURCE)
    expect(trigger.channel?.address?.to).toBe('alice')
    expect(trigger.channel?.address?.outbox).toBe(config.outbox)

    // --- call the REAL fake LLM over HTTP (not mocked) ---
    const response = await fetch(FAKE_LLM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fake',
        messages: [{ role: 'user', content: trigger.text }],
      }),
    })
    expect(response.status).toBe(200)
    const data = (await response.json()) as { choices: [{ message: { content: string } }] }
    const assistantContent = data.choices[0]!.message.content
    // The fake endpoint's {user_text} template substitutes the original message content.
    expect(assistantContent).toContain('echo: fix the flaky test')
    expect(assistantContent).toContain('from-fake-llm')

    // --- egress: real maildrop delivery writes <id>.json into outbox ---
    const deliver = await sendMaildrop({
      id: trigger.id,
      kind: 'reply',
      text: assistantContent,
      channel: {
        source: SOURCE,
        thread: trigger.channel!.thread!,
        address: trigger.channel!.address!,
      },
    })
    expect(deliver).toBe('sent')

    const outboxFiles = readdirSync(config.outbox)
    expect(outboxFiles).toHaveLength(1)
    const reply = JSON.parse(readFileSync(join(config.outbox, outboxFiles[0]!), 'utf8')) as { text: string; to: string; thread: string }
    expect(reply.to).toBe('alice')
    expect(reply.thread).toBe(`${SOURCE}:demo`)
    expect(reply.text).toContain('echo: fix the flaky test')
    expect(reply.text).toContain('from-fake-llm')
  }, 60_000)

  it('records a replay line in the fake endpoint log, proving the HTTP round-trip was real', async () => {
    // Clear prior replay so this run's line is unambiguous.
    if (existsSync(REPLAY_LOG)) unlinkSync(REPLAY_LOG)
    const config = cfg()
    writeFileSync(join(config.inbox, '0001.json'), JSON.stringify({
      id: 'm2', from: 'bob', text: 'what time is it', thread: 'demo',
    }))
    const { source, received } = fakeSource(config)
    await pollMaildrop(source, config)
    const trigger = received[0]!

    await fetch(FAKE_LLM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: trigger.text }] }),
    })

    const lines = readFileSync(REPLAY_LOG, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const last = JSON.parse(lines[lines.length - 1]!) as { path: string; body: { messages: [{ content: string }] } }
    expect(last.path).toBe('/v1/chat/completions')
    expect(last.body.messages[0]!.content).toBe('what time is it')
  }, 60_000)
})
