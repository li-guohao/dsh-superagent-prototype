/** Coordinates periodic and on-demand orchestration passes that drive due effects and Engine evaluations. */
import type { Engine, ReceiveResult, Trigger } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Effects } from './effects.ts'

export interface PassesHost {
  readonly engine: Pick<Engine, 'receive' | 'evaluateDue'>
  readonly effects: Pick<Effects, 'kick' | 'idle'>
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  configured(): boolean
  closing(): boolean
}

/** One beat of the loop; a pass that takes longer than this delays the next one. */
export const PASS_INTERVAL_MS = 2000
/** Three missed beats mean the loop stopped serving passes, rather than one pass running long. */
export const STALL_MS = 3 * PASS_INTERVAL_MS

/** The two clocks differ on purpose: monotonic excludes time the process was suspended, wall clock includes it. */
export interface PassClock { monotonic(): number; wall(): number }
const systemClock: PassClock = { monotonic: () => performance.now(), wall: () => Date.now() }

/** What the last completed pass saw. */
export interface PassStatus {
  /** Monotonic ms at which the last pass completed; `null` until one runs, so "never ran" is not mistaken for idle. */
  readonly completedAt: number | null
  readonly wall: string | null
  readonly tookMs: number | null
  /** Monotonic ms between the previous completion and this start; `0` for the first pass. */
  readonly gapMs: number | null
  /** Passes longer than one beat, counted only: a long pass is not a failure. */
  readonly slow: number
  /** Recovered stalls, counted only: the loop cannot report one while it is stalled. */
  readonly stalls: number
}

const now = (): string => new Date().toISOString()

/**
 * Schedules and serializes orchestration passes that kick due `Effects` and advance `Engine` evaluations.
 * `Runtime` manages its lifecycle, while sources, tools, `Settings`, and HTTP routes trigger immediate passes when new work arrives or state changes.
 * Updates the runtime `HealthEntry` when a pass fails and clears the error once a subsequent pass actually runs.
 * A skipped pass proves nothing: it neither clears an error nor makes the runtime ready.
 * The level of protection is deliberately local. A stall is only reported after the loop recovers, because a blocked event loop
 * cannot run a watchdog of its own; surviving a blocked loop needs a supervisor outside this process.
 */
export class Passes {
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private pumping?: Promise<boolean>
  private pumpAgain?: Promise<boolean>
  private completedAt?: number
  private completedWall?: string
  private tookMs?: number
  private gapMs?: number
  private slow = 0
  private stalls = 0
  /** A gap that a completed pass measured, reported once after the readiness flip of the request that awaited it. */
  private pendingStall?: number
  constructor(private readonly host: PassesHost, private readonly clock: PassClock = systemClock) {}
  start(): void { if (!this.stopped) this.timer = setInterval(() => { this.request() }, PASS_INTERVAL_MS) }
  stop(): Promise<unknown> {
    this.stopped = true
    clearInterval(this.timer)
    return Promise.allSettled([this.pumping, this.pumpAgain])
  }
  receive(trigger: Trigger): ReceiveResult {
    if (this.host.closing()) throw new Error('Orchestrator is stopping')
    const result = this.host.engine.receive(trigger)
    if (result === 'stored') this.request()
    return result
  }
  status(): PassStatus {
    return { completedAt: this.completedAt ?? null, wall: this.completedWall ?? null, tookMs: this.tookMs ?? null,
      gapMs: this.gapMs ?? null, slow: this.slow, stalls: this.stalls }
  }
  request(): void { this.pump().catch(() => { /* pumpOnce records the failure in health. */ }) }
  /** Wait until no pass or effect that can start now is running. */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.pumpAgain])
      await this.host.effects.idle()
      if (!this.pumping && !this.pumpAgain) return
    }
  }
  /** Run one pass, coalescing concurrent callers into a single follow-up pass. Resolves false when the pass was skipped. */
  async pump(): Promise<boolean> {
    // Do not assess, dispatch, or send while waiting for setup; queued work waits for the restart that completes setup.
    if (!this.host.configured() || this.host.closing()) return false
    if (!this.pumping) return this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined })
    const next = () => { this.pumpAgain = undefined; return this.pump() }
    return this.pumpAgain ??= this.pumping.then(next, next)
  }
  private async pumpOnce(): Promise<boolean> {
    try {
      const started = this.clock.monotonic()
      const gap = this.completedAt === undefined ? 0 : started - this.completedAt
      this.host.effects.kick()
      if (!this.host.closing()) this.host.engine.evaluateDue()
      const took = this.clock.monotonic() - started
      this.completedAt = started + took
      this.completedWall = new Date(this.clock.wall()).toISOString()
      this.tookMs = took
      this.gapMs = gap
      if (took > PASS_INTERVAL_MS) this.slow += 1
      // Time since the previous completion, which is what "the loop stopped beating" means at the moment a pass returns.
      // The monotonic clock is the judgment: a suspended process pauses it too, so a wall-clock jump alone is not a stall.
      const since = gap + took
      if (since > STALL_MS) { this.stalls += 1; this.pendingStall = Math.round(since) }
      this.report()
      return true
    } catch (error) {
      this.host.health.set({ state: 'error', detail: `A pass failed: ${String(error)}`, at: now() })
      throw error
    }
  }
  /** A pass that ran is the only thing that can make the runtime ready or clear its error. */
  private report(): void {
    if (this.host.lifetime.aborted) return
    const { health } = this.host
    const state = health.get()?.state
    if (state === 'error' || state === 'starting') health.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    // Report a stall after the flip above, or this pass would clear the very error it just measured.
    const stall = this.pendingStall
    this.pendingStall = undefined
    if (stall !== undefined) health.set({ state: 'error', detail: `A pass stalled for ${stall}ms`, at: now() })
  }
}
