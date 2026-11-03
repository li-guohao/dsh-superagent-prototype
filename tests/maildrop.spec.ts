/** The Maildrop Source: poll order and cursor persistence, malformed files, and idempotent outbox delivery. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import type { Deployment } from '../src/deployment.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import { MaildropConfigSchema, maildropKind, maildropTrigger, pollMaildrop, sendMaildrop, SOURCE, type MaildropConfig } from '../src/sources/maildrop.ts'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-superagent-maildrop-test-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const config = (): MaildropConfig => ({
  inbox: join(root, 'inbox'),
  outbox: join(root, 'outbox'),
  pollSeconds: 5,
})

/** A minimal SourceContext: a KV map, a received-trigger list, and health reports; nothing else is touched by the poll. */
function fakeSource(cfg: MaildropConfig) {
  const state = new Map<string, unknown>()
  const received: Trigger[] = []
  const reports: { entry: string; health: Health }[] = []
  const source = {
    deployment: {} as Deployment,
    configured: () => true,
    config: () => cfg,
    receive: (trigger: Trigger) => { received.push(trigger) },
    report: (entry: string, health: Health) => { reports.push({ entry, health }) },
    state: {
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => { value === undefined ? state.delete(key) : state.set(key, value) },
    },
  } as unknown as SourceContext
  return { source, received, reports }
}

function drop(inbox: string, name: string, message: unknown): void {
  writeFileSync(join(inbox, name), JSON.stringify(message), 'utf8')
}

describe('maildrop source', () => {
  it('ingests every inbox file past the cursor, oldest first, as direct human triggers', async () => {
    const cfg = config()
    const inbox = cfg.inbox
    rmSync(inbox, { recursive: true, force: true })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(inbox, { recursive: true })
    drop(inbox, '0001.json', { id: 'm1', from: 'alice', text: 'first', thread: 'demo', at: '2026-11-03T09:00:00Z' })
    drop(inbox, '0002.json', { id: 'm2', from: 'bob', text: 'second' })
    const { source, received } = fakeSource(cfg)

    expect(await pollMaildrop(source, cfg)).toBe(2)
    expect(received.map((trigger) => trigger.text)).toEqual(['first', 'second'])
    expect(received[0]!).toMatchObject({
      source: SOURCE, human: true, addressed: 'direct', at: '2026-11-03T09:00:00Z',
      actor: { source: SOURCE, id: 'alice' }, meta: { maildropId: 'm1' },
    })
    expect(received[0]!.channel?.address.outbox).toBe(cfg.outbox)
    // A message without `thread` threads by its own ID.
    expect(received[1]!.channel?.thread).toBe(`${SOURCE}:m2`)
  })

  it('gives every message its own stable trigger id, so a second mail is not deduplicated away', async () => {
    const cfg = config()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cfg.inbox, { recursive: true })
    drop(cfg.inbox, '0001.json', { id: 'm1', from: 'alice', text: 'first' })
    drop(cfg.inbox, '0002.json', { id: 'm2', from: 'bob', text: 'second' })
    const { source, received } = fakeSource(cfg)

    expect(await pollMaildrop(source, cfg)).toBe(2)
    // Intake drops a trigger whose id already exists, so one id for every message would silently swallow all but the first.
    expect(received[0]!.id).not.toBe(received[1]!.id)
    // Stability matters too: the same message must keep its id across polls and restarts, or re-delivery would duplicate it.
    expect(maildropTrigger({ id: 'm1', from: 'alice', text: 'first' }, cfg.outbox).id).toBe(received[0]!.id)
    expect(maildropTrigger({ id: 'm2', from: 'bob', text: 'second' }, cfg.outbox).id).toBe(received[1]!.id)
  })

  it('persists the cursor so a second poll ingests nothing and a restart repeats nothing', async () => {
    const cfg = config()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cfg.inbox, { recursive: true })
    drop(cfg.inbox, '0001.json', { id: 'm1', from: 'alice', text: 'once' })
    const { source, received } = fakeSource(cfg)

    expect(await pollMaildrop(source, cfg)).toBe(1)
    expect(await pollMaildrop(source, cfg)).toBe(0)
    // A new SourceContext over the same KV would see the same cursor; here the map lives in the fake's closure.
    expect(received).toHaveLength(1)
  })

  it('skips a malformed file with an error health report and still processes what follows', async () => {
    const cfg = config()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cfg.inbox, { recursive: true })
    drop(cfg.inbox, '0001.json', { not: 'a message' })
    drop(cfg.inbox, '0002.json', { id: 'm2', from: 'bob', text: 'fine' })
    const { source, received, reports } = fakeSource(cfg)

    expect(await pollMaildrop(source, cfg)).toBe(1)
    expect(received[0]!.text).toBe('fine')
    expect(reports.some((report) => report.health.state === 'error' && report.health.code === 'pollFailures')).toBe(true)
  })

  it('delivers a reply as <id>.json in the outbox, and the same ID rewrites the same content', async () => {
    const cfg = config()
    const message: OutboundMessage = {
      id: 'reply-1', kind: 'reply', text: 'done',
      channel: { source: SOURCE, thread: `${SOURCE}:demo`, address: { to: 'alice', outbox: cfg.outbox } },
    }
    expect(await sendMaildrop(message)).toBe('sent')
    expect(await sendMaildrop(message)).toBe('sent')
    const files = readdirSync(cfg.outbox)
    expect(files).toEqual(['reply-1.json'])
    expect(JSON.parse(readFileSync(join(cfg.outbox, 'reply-1.json'), 'utf8'))).toMatchObject({ id: 'reply-1', to: 'alice', text: 'done' })
  })

  it('throws when the channel address carries no outbox, so the Engine may retry', async () => {
    const message: OutboundMessage = {
      id: 'reply-2', kind: 'reply', text: 'lost',
      channel: { source: SOURCE, thread: `${SOURCE}:demo`, address: { to: 'alice' } },
    }
    await expect(sendMaildrop(message)).rejects.toThrow('outbox')
  })

  it('declares its kind, health entries, and a form field per schema key', () => {
    expect(maildropKind.kind).toBe(SOURCE)
    expect(maildropKind.health).toEqual(['maildrop'])
    const schemaKeys = Object.keys(MaildropConfigSchema.shape)
    for (const field of maildropKind.fields) expect(schemaKeys).toContain(field.key)
  })
})
