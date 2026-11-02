/**
 * Maildrop Source: a filesystem mailbox that lets anyone drive the agent without GitHub or Feishu accounts.
 *
 * Gap evidence: the bundle ships exactly two Source kinds (github, feishu), both requiring external accounts
 * and CLIs; docs/008-cookbook.md "Add a Source" walks through a `webhook` kind that is explicitly imaginary
 * ("an invented CLI, hookq"). This module makes that documented extension point real with zero external
 * dependencies: message files dropped into `inbox` become Triggers, replies appear as files in `outbox`.
 *
 * Message file (JSON, name sortable, e.g. `0001.json`):
 *   { "id": "m1", "from": "alice", "text": "fix the flaky test", "thread": "demo", "at": "2026-11-03T09:00:00Z" }
 * The poll cursor is the last processed filename; files sort lexicographically so writers should zero-pad.
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type ThreadRef, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'maildrop'
/** Read cursor of the inbox; external Source plugins type their own keys with `record` (see src/kv.ts). */
const cursorKey = record<string>('maildrop:cursor')

export const MaildropConfigSchema = z.object({
  inbox: z.string().min(1),
  outbox: z.string().min(1),
  pollSeconds: z.number().int().min(1).max(3600).default(5),
}).strict()
export type MaildropConfig = z.infer<typeof MaildropConfigSchema>

const MessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  text: z.string(),
  thread: z.string().optional(),
  at: z.string().optional(),
}).strict()
export type MaildropMessage = z.infer<typeof MessageSchema>

export const maildropRef = (id: string): ThreadRef => ({ source: SOURCE, id })

/** Builds the Trigger for one message file; `outbox` rides along in the channel address so `send` needs no config. */
export function maildropTrigger(message: MaildropMessage, outbox: string): Trigger {
  const thread = message.thread ?? message.id
  return {
    id: key(),
    source: SOURCE,
    threads: [maildropRef(thread)],
    actor: { source: SOURCE, id: message.from },
    human: true,
    addressed: 'direct',
    at: message.at ?? new Date().toISOString(),
    text: message.text,
    channel: { source: SOURCE, thread: threadKey(maildropRef(thread)), address: { to: message.from, outbox } },
    meta: { maildropId: message.id },
  }
}

/** One poll: ingests every inbox file past the cursor, oldest first. Returns how many were stored. */
export async function pollMaildrop(source: SourceContext, config: MaildropConfig): Promise<number> {
  const names = (await readdir(config.inbox))
    .filter((name) => name.endsWith('.json'))
    .sort()
  const cursor = source.state.get(cursorKey) ?? ''
  let stored = 0
  for (const name of names) {
    if (name <= cursor) continue
    let parsed: MaildropMessage
    try {
      parsed = MessageSchema.parse(JSON.parse(await readFile(join(config.inbox, name), 'utf8')))
    } catch (error) {
      // A malformed file is skipped, not fatal: report it and still advance past it so one bad file cannot wedge the loop.
      source.report('maildrop', health('error', 'pollFailures', { count: '1', error: `${name}: ${String(error)}` }))
      source.state.set(cursorKey, name)
      continue
    }
    // Await ingestion before advancing the cursor (host contract: cursors move only after receive resolves).
    await source.receive(maildropTrigger(parsed, config.outbox))
    source.state.set(cursorKey, name)
    stored += 1
  }
  return stored
}

/** Poll loop of the plugin; a round is skipped while the Source is disabled or unconfigured. */
export async function watchMaildrop(source: SourceContext, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const config = source.config<MaildropConfig>(SOURCE)
    if (source.configured() && config) {
      try {
        await mkdir(config.inbox, { recursive: true })
        await mkdir(config.outbox, { recursive: true })
        await pollMaildrop(source, config)
        source.report('maildrop', health('ready', 'sourceOff'))
      } catch (error) {
        source.report('maildrop', health('error', 'pollFailures', { count: '1', error: String(error) }))
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, (config?.pollSeconds ?? 5) * 1000)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
}

/** Writes the reply as `<message.id>.json` in the outbox; same ID rewrites the same content, so delivery is idempotent. */
export async function sendMaildrop(message: OutboundMessage): Promise<'sent' | 'gone'> {
  const outbox = message.channel.address.outbox
  if (!outbox) throw new Error('maildrop channel address lacks outbox')
  await mkdir(outbox, { recursive: true })
  const file = join(outbox, `${message.id.replace(/[^\w.-]/g, '_')}.json`)
  await writeFile(file, JSON.stringify({
    id: message.id,
    thread: message.channel.thread,
    to: message.channel.address.to,
    kind: message.kind,
    text: message.text,
    at: new Date().toISOString(),
  }, null, 2), 'utf8')
  return 'sent'
}

export const maildropKind: SourceKind<MaildropConfig> = {
  kind: SOURCE,
  title: { zh: '文件信箱', en: 'Maildrop' },
  description: {
    zh: '一个目录信箱：把 JSON 消息文件放进收件目录即发给智能体，回复以文件形式出现在发件目录。用于无 GitHub/飞书账号的本地演示、评测与 CI。',
    en: 'A directory mailbox: drop a JSON message file into the inbox to address the agent; replies appear as files in the outbox. For local demos, evaluation and CI without GitHub or Feishu accounts.',
  },
  schema: MaildropConfigSchema,
  fields: [
    { key: 'inbox', type: 'text', label: { zh: '收件目录', en: 'Inbox directory' },
      hint: { zh: '消息文件的目录；文件名按字典序处理（建议零填充编号），处理位置持久化，重启不重复接收。', en: 'Directory of message files; names process in lexicographic order (zero-pad numbers), and the read position persists across restarts.' } },
    { key: 'outbox', type: 'text', label: { zh: '发件目录', en: 'Outbox directory' },
      hint: { zh: '智能体的回复以 <消息 ID>.json 写入这里，同名重写，保证幂等。', en: 'Replies land here as <message ID>.json; the same ID rewrites the same content, keeping delivery idempotent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 1, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['maildrop'],
  channel: {
    send: (_host, message) => sendMaildrop(message),
    link: (address) => ({ url: '', label: { zh: `文件信箱 ${address.to ?? ''}`, en: `Maildrop ${address.to ?? ''}` } }),
  },
  find: (query) => ({ threads: query.trim() ? [`${SOURCE}:${query.trim()}`] : [], terms: [] }),
}

export const name = 'dsh-superagent-maildrop'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(maildropKind), 'maildrop: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, maildropKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watchMaildrop(source, controller.signal)
      .catch((error: unknown) => { source.report('maildrop', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
