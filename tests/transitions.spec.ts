import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError } from '../src/core/index.ts'
import type { Assessor, Assignment, Candidate, Executor, Outbox, Policy, Ticket, Trigger } from '../src/core/index.ts'
import { ASSIGNMENT_COMMANDS, ASSIGNMENT_STATES, THREAD_COMMANDS, THREAD_STATES, TICKET_COMMANDS, TICKET_STATES,
  assertTransitionTables, transitionCells } from '../src/core/transitions.ts'

const member = { source: 'chat', id: 'alice' }
const chat = { source: 'chat', id: 't1' }
const at = (id: string) => `2026-09-23T00:00:${id.padStart(2, '0')}Z`
function trigger(id: string): Trigger {
  return { id, source: 'chat', threads: [chat], actor: member, human: true, at: at(id), text: `message ${id}`,
    channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {} }
}
function harness() {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const launches: [Ticket, Assignment][] = []
  const executor: Executor = { start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }), deliver: vi.fn(), stop: vi.fn() }
  const outbox: Outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  let version = 'v1', paused = false
  const policy: Policy = { get version() { return version }, get paused() { return paused }, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => version !== 'revoked',
    admitsInferred: () => true }
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) }, assessor, executor, outbox,
    now: () => '2026-09-23T00:01:00Z' })
  /** Mark every assignment the executor launched as running, as the host would on a normal launch. */
  function settle() {
    for (let next = launches.shift(); next; next = launches.shift()) engine.assignmentStarted(next[0].id, next[1].id)
  }
  function accepted() {
    engine.receive(trigger('1')); engine.evaluateDue()
    const candidate = requests.at(-1)!
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'asked', acknowledgement: 'ok', evalId: candidate.evalId })
    settle()
    return { ticketId: decision.ticketId!, candidate }
  }
  return { repo, engine, requests, assessor, executor, launches, accepted, settle, ticket: (id: string) => repo.tickets.get(id)!,
    setVersion: (value: string) => { version = value } }
}
/** The UserError a command must throw; a command that succeeds or throws something else fails the test. */
function refusal(run: () => unknown): UserError {
  try { run() } catch (error) {
    if (error instanceof UserError) return error
    throw error
  }
  throw new Error('expected the command to be refused')
}
function statesOf(entity: 'ticket' | 'assignment' | 'thread'): readonly string[] {
  return entity === 'ticket' ? TICKET_STATES : entity === 'assignment' ? ASSIGNMENT_STATES : THREAD_STATES
}

describe('transition table', () => {
  it('covers every state and command, names only declared states, and gives every refusal a code', () => {
    expect(() => assertTransitionTables()).not.toThrow()
    const cells = transitionCells()
    expect(cells).toHaveLength(TICKET_STATES.length * TICKET_COMMANDS.length + ASSIGNMENT_STATES.length * ASSIGNMENT_COMMANDS.length
      + THREAD_STATES.length * THREAD_COMMANDS.length)
    for (const cell of cells) {
      expect(statesOf(cell.entity)).toContain(cell.state)
      for (const next of cell.next) expect(statesOf(cell.entity)).toContain(next)
      if (cell.effect === 'refuse') expect(cell.code).toBeDefined()
    }
  })
})

describe('refusals carry their state and command', () => {
  it('an ended ticket refuses bind, note, followForContext and report as ticketEnded', () => {
    const h = harness(); const { ticketId } = h.accepted()
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    expect(h.ticket(ticketId).ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    for (const run of [() => h.engine.bindThread(ticketId, { source: 'chat', id: 'other' }, false), () => h.engine.note(ticketId, 'x'),
      () => h.engine.followForContext(ticketId, { source: 'chat', id: 'other' }), () => h.engine.report(ticketId, { state: 'progress', summary: 'x' })]) {
      expect(refusal(run).transition).toEqual(expect.objectContaining({ entity: 'ticket', state: 'ended' }))
    }
  })
  it('a person-stopped ticket refuses attach as ticketStopped and retry as notRetryable', () => {
    const h = harness(); const { ticketId } = h.accepted()
    h.engine.stopTicket(ticketId, 'stop')
    h.engine.receive(trigger('2'))
    const attach = refusal(() => h.engine.attach(ticketId, '2'))
    expect(attach.code).toBe('ticketStopped')
    expect(attach.transition).toEqual({ entity: 'ticket', state: 'stopped', command: 'attach' })
    const retry = refusal(() => h.engine.retryTicket(ticketId))
    expect(retry.code).toBe('notRetryable')
    expect(retry.transition).toEqual({ entity: 'ticket', state: 'stopped', command: 'retry' })
  })
  it('an ended ticket whose mandate no longer holds refuses attach as mandateRevoked', () => {
    const h = harness(); const { ticketId } = h.accepted()
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    h.engine.receive(trigger('2'))
    const error = refusal(() => h.engine.attach(ticketId, '2'))
    expect(error.code).toBe('mandateRevoked')
    expect(error.transition).toEqual({ entity: 'ticket', state: 'ended', command: 'attach' })
  })
  it('an open ticket that is not retryable refuses retry with its open state', () => {
    const h = harness(); const { ticketId } = h.accepted()
    const error = refusal(() => h.engine.retryTicket(ticketId))
    expect(error.code).toBe('notRetryable')
    expect(error.transition).toEqual({ entity: 'ticket', state: 'open', command: 'retry' })
  })
  it('an ended assignment refuses report as assignmentEnded', () => {
    const h = harness(); const { ticketId } = h.accepted()
    const open = h.ticket(ticketId)
    h.repo.tickets.save({ ...open, assignments: open.assignments.map(assignment => ({ ...assignment, state: 'ended' as const })) })
    const error = refusal(() => h.engine.report(ticketId, { state: 'progress', summary: 'x' }))
    expect(error.code).toBe('assignmentEnded')
    expect(error.transition).toEqual({ entity: 'assignment', state: 'ended', command: 'report' })
  })
  it('a finished eval refuses decide as evalFinished on an idle thread', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.engine.evaluateDue()
    const candidate = h.requests[0]!
    h.engine.decide(candidate.triggers[0]!.id, { kind: 'ignore', reason: 'chatter', evalId: candidate.evalId })
    const error = refusal(() => h.engine.decide(candidate.triggers[0]!.id, { kind: 'ignore', reason: 'chatter', evalId: candidate.evalId }))
    expect(error.code).toBe('evalFinished')
    expect(error.transition).toEqual({ entity: 'thread', state: 'idle', command: 'decide' })
  })
})

describe('legal paths stay equivalent', () => {
  it('accept runs an assignment, stop ends the ticket as a person, and a progress report keeps it open', () => {
    const h = harness(); const { ticketId } = h.accepted()
    expect(h.ticket(ticketId).assignments).toEqual([expect.objectContaining({ state: 'running' })])
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    expect(h.ticket(ticketId).ended).toBeUndefined()
    h.engine.stopTicket(ticketId)
    expect(h.ticket(ticketId).ended).toMatchObject({ by: 'human', outcome: 'stopped' })
  })
  it('a ready report ends the ticket as its executor, and a blocked report allows a retry with a fresh pending assignment', () => {
    const h = harness(); const { ticketId } = h.accepted()
    h.engine.report(ticketId, { state: 'blocked', summary: 'need input' })
    h.engine.retryTicket(ticketId)
    expect(h.ticket(ticketId).assignments.map(assignment => assignment.state)).toEqual(['ended', 'pending'])
    expect(h.ticket(ticketId).assignments[0]).toMatchObject({ endedReason: 'retried' })
    h.settle()
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    expect(h.ticket(ticketId).ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  })
  it('a thread starts an eval when idle and returns to idle when it is decided', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.engine.evaluateDue()
    expect(h.repo.threads.get('chat:t1')?.evaluating).toBeDefined()
    const candidate = h.requests[0]!
    h.engine.decide(candidate.triggers[0]!.id, { kind: 'ignore', reason: 'chatter', evalId: candidate.evalId })
    expect(h.repo.threads.get('chat:t1')?.evaluating).toBeUndefined()
  })
  it('a person message resumes an ended ticket under its revalidating mandate', () => {
    const h = harness(); const { ticketId } = h.accepted()
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    expect(h.ticket(ticketId).ended).toMatchObject({ by: 'executor' })
    h.engine.receive(trigger('2'))
    expect(h.ticket(ticketId).ended).toBeUndefined()
  })
})

describe('explicit no-ops stay no-ops', () => {
  it('a second stop leaves the ticket ending unchanged', () => {
    const h = harness(); const { ticketId } = h.accepted()
    h.engine.stopTicket(ticketId)
    const first = h.ticket(ticketId).ended
    h.engine.stopTicket(ticketId)
    expect(h.ticket(ticketId).ended).toEqual(first)
  })
  it('facts about an ended assignment are ignored', () => {
    const h = harness(); const { ticketId } = h.accepted()
    const assignmentId = h.ticket(ticketId).assignments[0]!.id
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.engine.assignmentStarted(ticketId, assignmentId)
    h.engine.turnEnded(ticketId, assignmentId)
    expect(h.ticket(ticketId).assignments[0]).toMatchObject({ state: 'ended' })
    expect(h.ticket(ticketId).assignments[0]?.idleAt).toBeUndefined()
  })
  it('a status request on a worker that is not waiting queues nothing', () => {
    const h = harness(); const { ticketId } = h.accepted()
    expect(h.engine.requestStatus(ticketId)).toBe(false)
    expect(h.ticket(ticketId).inputs).toEqual([])
  })
})
