import { UserError } from './errors.ts'
import type { TransitionDiagnostic, UserErrorCode } from './errors.ts'
import type { AssignmentState, Ticket } from './model.ts'

/**
 * The domain's state machines, written down once: a Ticket's lifecycle, each of its Assignments, and the Eval a Thread
 * runs. Every command that branches on a state reads its answer here, so the set of legal transitions is enumerable and
 * every refusal names the state and the command it refused. `why` is the audit trail: it says why a cell is what it is,
 * which is what makes an implicit self-loop visible instead of accidental.
 */

export type TransitionEntity = TransitionDiagnostic['entity']

/** A Ticket is `stopped` only when a person ended it; every other ending is `ended`. */
export type TicketState = 'open' | 'ended' | 'stopped'
/** A Thread is `evaluating` while an Eval holds it, `idle` otherwise. */
export type ThreadState = 'idle' | 'evaluating'
/** `apply` moves the entity, `noop` is the deliberate self-loop, `refuse` throws, and `conditional` applies or refuses on a precondition. */
export type TransitionEffect = 'apply' | 'noop' | 'refuse' | 'conditional'

export interface TransitionCell<S extends string = string> {
  readonly entity: TransitionEntity
  readonly state: S
  readonly command: string
  readonly effect: TransitionEffect
  /** Every state the entity can be in when the command returns; more than one when an argument decides the ending. */
  readonly next: readonly S[]
  /** The refusal a `refuse` cell reports, and the one a `conditional` cell reports when its precondition fails. */
  readonly code?: UserErrorCode
  readonly why: string
}

export const TICKET_STATES = ['open', 'ended', 'stopped'] as const
export const ASSIGNMENT_STATES = ['pending', 'running', 'ended'] as const
export const THREAD_STATES = ['idle', 'evaluating'] as const

export const TICKET_COMMANDS = ['bind', 'attach', 'note', 'followForContext', 'report', 'retry', 'stop', 'end', 'wake', 'requestStatus'] as const
export type TicketCommand = (typeof TICKET_COMMANDS)[number]
export const ASSIGNMENT_COMMANDS = ['started', 'delivered', 'read', 'turnEnd', 'deliveryFail', 'interrupt', 'report', 'end', 'restart'] as const
export type AssignmentCommand = (typeof ASSIGNMENT_COMMANDS)[number]
export const THREAD_COMMANDS = ['start', 'deliver', 'decide', 'expire', 'reassess', 'withdraw', 'route'] as const
export type ThreadCommand = (typeof THREAD_COMMANDS)[number]

interface CellShape<S extends string> {
  readonly effect: TransitionEffect
  readonly next: readonly S[]
  readonly code?: UserErrorCode
}
interface Row<S extends string, C extends string> {
  readonly command: C
  readonly why: string
  /** A cell for every state, checked by the compiler so a new state cannot be added without a decision. */
  readonly cells: { readonly [K in S]: CellShape<S> }
}
interface Table<S extends string, C extends string> {
  readonly cells: readonly TransitionCell<S>[]
  readonly byKey: ReadonlyMap<string, TransitionCell<S>>
}

const keyOf = (state: string, command: string): string => `${state}\u0000${command}`

function build<S extends string, C extends string>(entity: TransitionEntity, states: readonly S[], rows: readonly Row<S, C>[]): Table<S, C> {
  const cells: TransitionCell<S>[] = []
  for (const row of rows) {
    for (const state of states) {
      const shape = row.cells[state]
      cells.push({ entity, state, command: row.command, effect: shape.effect, next: shape.next, ...(shape.code ? { code: shape.code } : {}), why: row.why })
    }
  }
  return { cells, byKey: new Map(cells.map(cell => [keyOf(cell.state, cell.command), cell] as const)) }
}

function lookup<S extends string, C extends string>(table: Table<S, C>, entity: TransitionEntity, state: S, command: C): TransitionCell<S> {
  const cell = table.byKey.get(keyOf(state, command))
  // Only reachable if a table is edited without a cell for a state: the startup assertion names it first, this guards the rest.
  if (!cell) throw new Error(`Missing transition: ${entity} ${state} ${command}`)
  return cell
}

const TICKET_ROWS: readonly Row<TicketState, TicketCommand>[] = [
  { command: 'bind', why: 'Only an open ticket takes a new Thread; an ended ticket, by a person or its executor, refuses it.', cells: {
    open: { effect: 'apply', next: ['open'] },
    ended: { effect: 'refuse', next: ['ended'], code: 'ticketEnded' },
    stopped: { effect: 'refuse', next: ['stopped'], code: 'ticketEnded' },
  } },
  { command: 'attach', why: 'An ended ticket takes a message only to resume under its unchanged Mandate (see wake); a person-stopped one takes none.', cells: {
    open: { effect: 'apply', next: ['open'] },
    ended: { effect: 'conditional', next: ['ended', 'open'], code: 'mandateRevoked' },
    stopped: { effect: 'refuse', next: ['stopped'], code: 'ticketStopped' },
  } },
  { command: 'note', why: 'A note reaches an open ticket only.', cells: {
    open: { effect: 'apply', next: ['open'] },
    ended: { effect: 'refuse', next: ['ended'], code: 'ticketEnded' },
    stopped: { effect: 'refuse', next: ['stopped'], code: 'ticketEnded' },
  } },
  { command: 'followForContext', why: 'Only an open ticket takes a Thread to follow for context.', cells: {
    open: { effect: 'apply', next: ['open'] },
    ended: { effect: 'refuse', next: ['ended'], code: 'ticketEnded' },
    stopped: { effect: 'refuse', next: ['stopped'], code: 'ticketEnded' },
  } },
  { command: 'report', why: 'A worker reports on an open ticket; a ready or dropped report also ends it.', cells: {
    open: { effect: 'apply', next: ['open', 'ended'] },
    ended: { effect: 'refuse', next: ['ended'], code: 'ticketEnded' },
    stopped: { effect: 'refuse', next: ['stopped'], code: 'ticketEnded' },
  } },
  { command: 'retry', why: 'A retry needs an open ticket stalled on a blocked or failed report, or on a failed delivery.', cells: {
    open: { effect: 'conditional', next: ['open'], code: 'notRetryable' },
    ended: { effect: 'refuse', next: ['ended'], code: 'notRetryable' },
    stopped: { effect: 'refuse', next: ['stopped'], code: 'notRetryable' },
  } },
  { command: 'stop', why: 'Stopping an open ticket ends it by a person; an ended ticket keeps the ending it has.', cells: {
    open: { effect: 'apply', next: ['stopped'] },
    ended: { effect: 'noop', next: ['ended'] },
    stopped: { effect: 'noop', next: ['stopped'] },
  } },
  { command: 'end', why: 'An executor outcome ends an open ticket; an ended ticket keeps the ending it has.', cells: {
    open: { effect: 'apply', next: ['ended'] },
    ended: { effect: 'noop', next: ['ended'] },
    stopped: { effect: 'noop', next: ['stopped'] },
  } },
  { command: 'wake', why: 'Only an ended ticket a person did not stop resumes, on a message that waits while its Mandate holds.', cells: {
    open: { effect: 'noop', next: ['open'] },
    ended: { effect: 'conditional', next: ['ended', 'open'] },
    stopped: { effect: 'noop', next: ['stopped'] },
  } },
  { command: 'requestStatus', why: 'A status request asks a waiting worker on an open ticket; every other state queues nothing.', cells: {
    open: { effect: 'conditional', next: ['open'] },
    ended: { effect: 'noop', next: ['ended'] },
    stopped: { effect: 'noop', next: ['stopped'] },
  } },
]

const ASSIGNMENT_ROWS: readonly Row<AssignmentState, AssignmentCommand>[] = [
  { command: 'started', why: 'The executor reports an assignment running; a late fact about an ended one changes nothing.', cells: {
    pending: { effect: 'apply', next: ['running'] },
    running: { effect: 'apply', next: ['running'] },
    ended: { effect: 'noop', next: ['ended'] },
  } },
  { command: 'delivered', why: 'Delivery is recorded only while the assignment runs for an open ticket.', cells: {
    pending: { effect: 'noop', next: ['pending'] },
    running: { effect: 'apply', next: ['running'] },
    ended: { effect: 'noop', next: ['ended'] },
  } },
  { command: 'read', why: 'Reads are recorded on an open ticket, whatever its assignment is doing.', cells: {
    pending: { effect: 'apply', next: ['pending'] },
    running: { effect: 'apply', next: ['running'] },
    ended: { effect: 'apply', next: ['ended'] },
  } },
  { command: 'turnEnd', why: 'A turn ends on a running assignment; an ended one is not turned.', cells: {
    pending: { effect: 'noop', next: ['pending'] },
    running: { effect: 'apply', next: ['running'] },
    ended: { effect: 'noop', next: ['ended'] },
  } },
  { command: 'deliveryFail', why: 'A failed delivery restarts a running assignment; an ended one is not delivered.', cells: {
    pending: { effect: 'noop', next: ['pending'] },
    running: { effect: 'apply', next: ['running'] },
    ended: { effect: 'noop', next: ['ended'] },
  } },
  { command: 'interrupt', why: 'An interruption restarts a running assignment or hands it back; an ended one is left alone.', cells: {
    pending: { effect: 'noop', next: ['pending'] },
    running: { effect: 'conditional', next: ['running', 'ended'] },
    ended: { effect: 'noop', next: ['ended'] },
  } },
  { command: 'report', why: 'A report lands on a pending or running assignment; an ended one owns no report.', cells: {
    pending: { effect: 'apply', next: ['pending'] },
    running: { effect: 'apply', next: ['running'] },
    ended: { effect: 'refuse', next: ['ended'], code: 'assignmentEnded' },
  } },
  { command: 'end', why: 'Ending an unfinished assignment closes it; an ended one stays ended.', cells: {
    pending: { effect: 'apply', next: ['ended'] },
    running: { effect: 'apply', next: ['ended'] },
    ended: { effect: 'noop', next: ['ended'] },
  } },
  { command: 'restart', why: 'A restart ends the running assignment it replaces; other states have no assignment to replace.', cells: {
    pending: { effect: 'noop', next: ['pending'] },
    running: { effect: 'apply', next: ['ended'] },
    ended: { effect: 'noop', next: ['ended'] },
  } },
]

const THREAD_ROWS: readonly Row<ThreadState, ThreadCommand>[] = [
  { command: 'start', why: 'The Engine starts an Eval only on an idle thread with queued Triggers.', cells: {
    idle: { effect: 'apply', next: ['idle', 'evaluating'] },
    evaluating: { effect: 'noop', next: ['evaluating'] },
  } },
  { command: 'deliver', why: 'A candidate counts once, on the evaluating thread.', cells: {
    idle: { effect: 'noop', next: ['idle'] },
    evaluating: { effect: 'conditional', next: ['evaluating'] },
  } },
  { command: 'decide', why: 'A decision applies to the Eval it names; one naming a finished Eval is refused, direct or held.', cells: {
    idle: { effect: 'conditional', next: ['idle'], code: 'evalFinished' },
    evaluating: { effect: 'conditional', next: ['idle', 'evaluating'], code: 'evalFinished' },
  } },
  { command: 'expire', why: 'Only an evaluating thread expires, back to idle.', cells: {
    idle: { effect: 'noop', next: ['idle'] },
    evaluating: { effect: 'apply', next: ['idle'] },
  } },
  { command: 'reassess', why: 'A changed Policy reassesses only an Eval in progress.', cells: {
    idle: { effect: 'noop', next: ['idle'] },
    evaluating: { effect: 'apply', next: ['idle'] },
  } },
  { command: 'withdraw', why: 'Withdrawing a queued Trigger leaves the Eval state untouched.', cells: {
    idle: { effect: 'apply', next: ['idle'] },
    evaluating: { effect: 'apply', next: ['evaluating'] },
  } },
  { command: 'route', why: 'Only a thread holding the routed Eval finishes or reassesses it; an idle thread does nothing.', cells: {
    idle: { effect: 'noop', next: ['idle'] },
    evaluating: { effect: 'conditional', next: ['idle', 'evaluating'] },
  } },
]

const TICKET_TABLE = build('ticket', TICKET_STATES, TICKET_ROWS)
const ASSIGNMENT_TABLE = build('assignment', ASSIGNMENT_STATES, ASSIGNMENT_ROWS)
const THREAD_TABLE = build('thread', THREAD_STATES, THREAD_ROWS)

/** The Ticket state a stored ticket is in, as the table names it. */
export function ticketState(ticket: Pick<Ticket, 'ended'>): TicketState {
  if (!ticket.ended) return 'open'
  return ticket.ended.by === 'human' ? 'stopped' : 'ended'
}

export function ticketTransition(state: TicketState, command: TicketCommand): TransitionCell<TicketState> {
  return lookup(TICKET_TABLE, 'ticket', state, command)
}
export function assignmentTransition(state: AssignmentState, command: AssignmentCommand): TransitionCell<AssignmentState> {
  return lookup(ASSIGNMENT_TABLE, 'assignment', state, command)
}
export function threadTransition(state: ThreadState, command: ThreadCommand): TransitionCell<ThreadState> {
  return lookup(THREAD_TABLE, 'thread', state, command)
}

/** The error a cell refuses with, carrying the entity, state and command that produced it. */
export function transitionError(cell: Pick<TransitionCell, 'entity' | 'state' | 'command' | 'code'>, values: Record<string, string> = {}): UserError {
  if (!cell.code) throw new Error(`Transition ${cell.entity} ${cell.state} ${cell.command} has no refusal code`)
  return new UserError(cell.code, values, { entity: cell.entity, state: cell.state, command: cell.command })
}

/** The refusal a ticket command must throw in its current state, or `undefined` when the command may run. */
export function ticketRefusal(ticket: Pick<Ticket, 'ended'>, command: TicketCommand): UserError | undefined {
  const cell = ticketTransition(ticketState(ticket), command)
  return cell.effect === 'refuse' ? transitionError(cell) : undefined
}
/** The refusal an assignment command must throw in its current state, or `undefined` when the command may run. */
export function assignmentRefusal(state: AssignmentState, command: AssignmentCommand): UserError | undefined {
  const cell = assignmentTransition(state, command)
  return cell.effect === 'refuse' ? transitionError(cell) : undefined
}
/** The refusal a thread command must throw in its current state, or `undefined` when the command may run. */
export function threadRefusal(state: ThreadState, command: ThreadCommand): UserError | undefined {
  const cell = threadTransition(state, command)
  return cell.effect === 'refuse' ? transitionError(cell) : undefined
}

/** Every cell of every table, for tests and tooling that need to enumerate the machines. */
export function transitionCells(): readonly TransitionCell[] {
  return [...TICKET_TABLE.cells, ...ASSIGNMENT_TABLE.cells, ...THREAD_TABLE.cells]
}

/**
 * Assert the tables are total and coherent. The Engine calls this once at construction: a state or command added
 * without a cell fails loudly at startup instead of silently becoming an implicit self-loop at runtime.
 */
export function assertTransitionTables(): void {
  assertTable('ticket', TICKET_TABLE, TICKET_STATES, TICKET_COMMANDS)
  assertTable('assignment', ASSIGNMENT_TABLE, ASSIGNMENT_STATES, ASSIGNMENT_COMMANDS)
  assertTable('thread', THREAD_TABLE, THREAD_STATES, THREAD_COMMANDS)
}

function assertTable<S extends string, C extends string>(entity: TransitionEntity, table: Table<S, C>, states: readonly S[], commands: readonly C[]): void {
  if (table.cells.length !== states.length * commands.length) throw new Error(`Transition table ${entity} is not total: ${table.cells.length} cells`)
  const seen = new Set<string>()
  for (const cell of table.cells) {
    const key = keyOf(cell.state, cell.command)
    if (seen.has(key)) throw new Error(`Duplicate transition: ${entity} ${cell.state} ${cell.command}`)
    seen.add(key)
    if (!states.includes(cell.state)) throw new Error(`Unknown state: ${entity} ${cell.state}`)
    for (const next of cell.next) if (!states.includes(next)) throw new Error(`Unknown next state: ${entity} ${cell.state} -> ${next}`)
    if (cell.effect === 'refuse' && !cell.code) throw new Error(`Refusal without a code: ${entity} ${cell.state} ${cell.command}`)
  }
  for (const state of states) for (const command of commands) {
    if (!seen.has(keyOf(state, command))) throw new Error(`Missing transition: ${entity} ${state} ${command}`)
  }
}
