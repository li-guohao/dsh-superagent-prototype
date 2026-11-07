/** Read-only Store queries for views, tools, and Source polling. */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Decision, Thread, Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { THREAD_STATUS, type ThreadStatusCode } from './codes.ts'
import type { Dropped, Receipt, TimelinePlace } from './store.ts'

/** When this process loaded the reads; stable per boot, so a snapshot can be attributed to the process that produced it. */
const BOOTED_AT = new Date().toISOString()

export interface InstanceIdentity {
  /** Persisted deployment identity (`KV.runtime.masterId`); absent until the Runtime writes it. */
  id?: string
  pid: number
  bootedAt: string
}

/** One active Thread as the assessment backlog sees it. */
export interface ThreadStatus {
  thread: string
  status: ThreadStatusCode
  /** The timestamp `ageMs` counts from: the oldest pending intake, or the running Eval's start. */
  since?: string
  ageMs?: number
  /** Triggers still waiting in this Thread's `pending`. */
  triggers: number
  /** The running Eval, when the Thread is evaluating (delivered or not). */
  eval?: string
}

export interface AssessmentStatus {
  at: string
  instance: InstanceIdentity
  totals: { threads: number; waiting: number; evaluating: number; undelivered: number; triggers: number }
  items: ThreadStatus[]
}

export function storeReads(db: DatabaseSync) {
  const values = <T>(sql: string, ...parameters: SQLInputValue[]): T[] => db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  return {
  /** Newest first by arrival (`rowid`) order rather than trigger timestamp. */
  recentTriggers: (offset = 0, limit = 50): Trigger[] => db.prepare('SELECT value FROM trigger ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value)) as Trigger),
  /** Per-source trigger counts since `since`, plus the latest arrival timestamp across all time. */
  triggerStats: (since: string): Record<string, { received: number; filtered: number; lastAt: string }> => {
    const result: Record<string, { received: number; filtered: number; lastAt: string }> = {}
    for (const row of db.prepare("SELECT json_extract(t.value, '$.source') AS source, MAX(t.at) AS last, SUM(t.at >= ?) AS received, SUM(t.at >= ? AND json_extract(d.value, '$.filtered') IS NOT NULL) AS filtered FROM trigger t LEFT JOIN disposition d ON d.id = t.id GROUP BY source").all(since, since))
      result[String(row.source)] = { received: Number(row.received ?? 0), filtered: Number(row.filtered ?? 0), lastAt: String(row.last ?? '') }
    return result
  },
  /**
   * Counts triggers arriving at or after `since` that passed source filtering and reached a decision,
   * and how many accept/reopen decisions those same arrivals produced.
   */
  flow: (since: string): { judged: number; accepted: number } => {
    const passed = "t.at >= ? AND NOT EXISTS (SELECT 1 FROM disposition s WHERE s.id = t.id AND json_extract(s.value, '$.filtered') IS NOT NULL)"
    const judged = db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE ${passed}`).get(since)
    const accepted = db.prepare(`SELECT COUNT(DISTINCT d.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE json_extract(d.value, '$.kind') IN ('accept', 'reopen') AND t.at >= ?`).get(since)
    return { judged: Number(judged?.n ?? 0), accepted: Number(accepted?.n ?? 0) }
  },
  triggers: (options: { source?: string; filtered?: boolean }, offset = 0, limit = 50): { items: Trigger[]; more: boolean } => {
    const where = [...(options.source ? ["json_extract(t.value, '$.source') = ?"] : []), ...(options.filtered ? ["json_extract(d.value, '$.filtered') IS NOT NULL"] : [])]
    const rows = db.prepare(`SELECT t.value FROM trigger t LEFT JOIN disposition d ON d.id = t.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.at DESC LIMIT ? OFFSET ?`).all(...(options.source ? [options.source] : []), limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as Trigger), more: rows.length > limit }
  },
  /** Latest `limit` triggers on a thread returned oldest-first, optionally bounded before (or through) `before`. */
  threadTriggers: (threadKeyValue: string, limit = 50, before?: TimelinePlace, through = false): Trigger[] => {
    const place = before ? `AND (x.at, x.id) ${through ? '<=' : '<'} (?, ?)` : ''
    return values<Trigger>(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${place}
      ORDER BY x.at DESC, x.id DESC LIMIT ?`, threadKeyValue, ...before ? [before.at, before.id] : [], limit).reverse()
  },
  threadPage: (threadKeyValue: string, offset: number, limit: number): Trigger[] => values(`SELECT t.value FROM trigger_thread x
    JOIN trigger t ON t.id = x.id WHERE x.thread = ? ORDER BY x.at DESC, t.rowid DESC LIMIT ? OFFSET ?`, threadKeyValue, limit, offset),
  /** Nearest non-CI triggers on a thread immediately before and after `(at, id)`. */
  neighbours: (threadKeyValue: string, at: string, id: string): { before?: Trigger; after?: Trigger } => {
    const nearest = (side: '<' | '>') => values<Trigger>(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id
      WHERE x.thread = ? AND (x.at, x.id) ${side} (?, ?) AND json_extract(t.value, '$.meta.ci') IS NULL
      ORDER BY x.at ${side === '<' ? 'DESC' : 'ASC'}, x.id ${side === '<' ? 'DESC' : 'ASC'} LIMIT 1`, threadKeyValue, at, id)[0]
    const before = nearest('<'), after = nearest('>')
    return { ...before ? { before } : {}, ...after ? { after } : {} }
  },
  /** Oldest trigger on a thread, used to title the thread in listings. */
  firstTrigger: (threadKeyValue: string, humanOnly = false): Trigger | undefined => {
    const row = db.prepare(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${humanOnly ? 'AND x.human = 1' : ''} ORDER BY x.at ASC, t.rowid ASC LIMIT 1`).get(threadKeyValue)
    return row ? JSON.parse(String(row.value)) as Trigger : undefined
  },
  search: (query: string, limit = 20): Trigger[] => {
    const pattern = `%${query.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return db.prepare("SELECT value FROM trigger WHERE id = ? OR json_extract(value, '$.url') LIKE ? ESCAPE '\\' OR json_extract(value, '$.meta.messageId') = ? OR json_extract(value, '$.text') LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ?").all(query, `${query.replace(/[\\%_]/g, match => `\\${match}`)}%`, query, pattern, limit).map(row => JSON.parse(String(row.value)) as Trigger)
  },
  recentDecisions: (offset = 0, limit = 50): Decision[] => db.prepare('SELECT value FROM decision ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value)) as Decision),
  /** Decisions matching `kinds` whose triggers arrived at or after `since`, aligned with `flow` window counts. */
  decisions: (options: { kinds: string[]; since: string }, offset: number, limit: number): { items: Decision[]; more: boolean } => {
    const where = [...(options.kinds.length ? [`json_extract(d.value, '$.kind') IN (${options.kinds.map(() => '?').join(',')})`] : []),
      ...(options.since ? ["EXISTS (SELECT 1 FROM json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE t.at >= ?)"] : [])]
    const rows = db.prepare(`SELECT d.value FROM decision d ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.rowid DESC LIMIT ? OFFSET ?`)
      .all(...options.kinds, ...(options.since ? [options.since] : []), limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as Decision), more: rows.length > limit }
  },
  /** Newest decisions of the given kinds, for surfaces that must surface rare outcomes among many ignores. */
  decisionsOfKinds: (kinds: string[], limit = 30): Decision[] => db.prepare(`SELECT value FROM decision WHERE json_extract(value, '$.kind') IN (${kinds.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT ?`).all(...kinds, limit).map(row => JSON.parse(String(row.value)) as Decision),
  /** Messages whose `reply` effect failed, with consecutive failure count and last error, oldest first. */
  failingReplies: (): (Receipt & { attempts: number; error: string })[] => db.prepare(`SELECT o.value, e.attempts, e.error FROM effect e
    JOIN outbox o ON o.id = e.key WHERE e.kind = 'reply' AND e.attempts > 0 ORDER BY e.seq`).all()
    .map(row => ({ ...JSON.parse(String(row.value)) as Receipt, attempts: Number(row.attempts), error: String(row.error) })),
  droppedReplies: (limit = 20): Dropped[] =>
    values('SELECT value FROM outbox WHERE dropped IS NOT NULL ORDER BY dropped DESC LIMIT ?', limit),
  droppedSince: (since: string): number => Number(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE dropped >= ?').get(since)?.n ?? 0),
  subscribedThreads: (source?: string): Thread[] => source
    ? values('SELECT value FROM thread WHERE subscribed = ? ORDER BY rowid', source)
    // Force the partial index so SQLite does not scan the entire table in rowid order.
    : values('SELECT value FROM thread INDEXED BY thread_subscribed WHERE subscribed IS NOT NULL ORDER BY rowid'),
  /**
   * One entry per active Thread, oldest first: waiting in `pending` (status 1), evaluating with its candidate delivered
   * (status 2), or evaluating with `delivered` missing (status 3, which never expires). `ageMs` counts from the oldest
   * pending intake (`disposition.at`, not `trigger.at`: polled history reaches back the Source's horizon and would read
   * as a backlog that never existed) or from the Eval's start.
   *
   * Cost: one scan over `thread WHERE active = 1` using the existing partial index; the pending lookup is a correlated
   * subquery evaluated only for those rows, so neither the whole `thread` table nor `disposition` is scanned wholesale.
   */
  assessmentStatus: (now = new Date().toISOString()): AssessmentStatus => {
    const rows = db.prepare(`SELECT t.key AS thread,
        json_extract(t.value, '$.evaluating.id') AS eval,
        json_extract(t.value, '$.evaluating.delivered') AS delivered,
        json_extract(t.value, '$.evaluating.startedAt') AS startedAt,
        json_array_length(t.value, '$.pending') AS pending,
        (SELECT MIN(json_extract(d.value, '$.at')) FROM json_each(t.value, '$.pending') AS p JOIN disposition d ON d.id = p.value) AS oldest
      FROM thread t WHERE t.active = 1 ORDER BY t.rowid`).all()
    const items = rows.map(row => {
      const triggers = Number(row.pending ?? 0)
      // `eval` present means an Eval runs; `delivered` then decides whether its candidate reached the main Session.
      const running = row.eval == null ? undefined : String(row.eval)
      const status = running === undefined ? THREAD_STATUS.WAITING : row.delivered == null ? THREAD_STATUS.UNDELIVERED : THREAD_STATUS.EVALUATING
      const since = running === undefined
        ? row.oldest == null ? undefined : String(row.oldest)
        : row.startedAt == null ? undefined : String(row.startedAt)
      // Clamp at 0 so a backwards clock step cannot turn an age into a negative wait.
      const ageMs = since === undefined ? undefined : Math.max(0, Date.parse(now) - Date.parse(since))
      return { thread: String(row.thread), status, triggers, ...since === undefined ? {} : { since },
        ...ageMs === undefined ? {} : { ageMs }, ...running === undefined ? {} : { eval: running } }
    })
    items.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1) || (a.thread < b.thread ? -1 : a.thread > b.thread ? 1 : 0))
    const master = db.prepare('SELECT value FROM kv WHERE key = ?').get(KV.runtime.masterId)
    const count = (status: ThreadStatusCode) => items.filter(item => item.status === status).length
    return {
      at: now,
      instance: { pid: process.pid, bootedAt: BOOTED_AT, ...master ? { id: String(JSON.parse(String(master.value)) as string) } : {} },
      totals: {
        threads: items.length, waiting: count(THREAD_STATUS.WAITING), evaluating: count(THREAD_STATUS.EVALUATING),
        undelivered: count(THREAD_STATUS.UNDELIVERED), triggers: items.reduce((sum, item) => sum + item.triggers, 0),
      },
      items,
    }
  },
  }
}
