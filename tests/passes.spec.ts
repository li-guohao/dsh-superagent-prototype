/** Pass scheduling, coalescing, and runtime health reporting. */
import { expect, it, vi } from 'vitest'
import { PASS_INTERVAL_MS, Passes } from '../src/app/passes.ts'
import type { PassClock } from '../src/app/passes.ts'
import type { Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'

function passes(closing = () => false, configured = () => true, clock?: PassClock) {
  const health = new HealthBoard().claim('runtime', { state: 'starting', detail: '' })
  const engine = { receive: vi.fn(() => 'stored' as const), evaluateDue: vi.fn() }
  const effects = { kick: vi.fn(), idle: vi.fn(async () => {}) }
  const value = new Passes({ engine, effects, health, lifetime: new AbortController().signal, configured, closing }, clock)
  return { passes: value, engine, effects, health }
}
const trigger = { id: 't1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true,
  at: '2026-10-01T00:00:00.000Z', text: 'hi', meta: {} } as Trigger

it('reports a failed pass as an error of the runtime, which the next pass that succeeds clears', async () => {
  const h = passes()
  h.engine.evaluateDue.mockImplementationOnce(() => { throw new Error('database is locked') })
  h.passes.request()
  await h.passes.idle()
  expect(h.health.get()).toMatchObject({ state: 'error', detail: 'A pass failed: Error: database is locked' })
  h.passes.request()
  await h.passes.idle()
  expect(h.health.get()).toMatchObject({ state: 'ready', detail: 'Orchestrator is ready' })
})

it('leaves an error standing when the pass that ran was skipped for being unconfigured', async () => {
  const h = passes(() => false, () => false)
  h.health.set({ state: 'error', detail: 'A pass failed: Error: database is locked' })
  h.passes.request()
  await h.passes.idle()
  expect(h.engine.evaluateDue).not.toHaveBeenCalled()
  expect(h.health.get()).toMatchObject({ state: 'error', detail: 'A pass failed: Error: database is locked' })
})

it('becomes ready only once a pass completes, leaving a runtime that never ran one at starting', async () => {
  const skipped = passes(() => false, () => false)
  expect(skipped.passes.status().completedAt).toBeNull()
  skipped.passes.request()
  await skipped.passes.idle()
  expect(skipped.health.get()).toMatchObject({ state: 'starting' })
  const ran = passes()
  ran.passes.request()
  await ran.passes.idle()
  expect(ran.health.get()).toMatchObject({ state: 'ready' })
  expect(ran.passes.status().completedAt).toBeTypeOf('number')
})

it('measures a long pass in milliseconds and counts it without raising an error', async () => {
  const h = passes()
  const busy = 2500
  h.engine.evaluateDue.mockImplementationOnce(() => { const end = performance.now() + busy; while (performance.now() < end) { /* block the loop on purpose */ } })
  h.passes.request()
  await h.passes.idle()
  const status = h.passes.status()
  expect(status.tookMs).toBeGreaterThanOrEqual(busy)
  expect(status.slow).toBe(1)
  expect(h.health.get()).toMatchObject({ state: 'ready' })
}, 20_000)

it('reports a recovered stall with the time it measured, after the pass that recovered it', async () => {
  const h = passes()
  const busy = 6500
  h.engine.evaluateDue.mockImplementationOnce(() => { const end = performance.now() + busy; while (performance.now() < end) { /* block the loop on purpose */ } })
  h.passes.request()
  await h.passes.idle()
  const status = h.passes.status()
  expect(status.stalls).toBe(1)
  expect((status.tookMs ?? 0) + (status.gapMs ?? 0)).toBeGreaterThanOrEqual(busy)
  const entry = h.health.get()
  expect(entry?.state).toBe('error')
  expect(entry?.detail).toMatch(/^A pass stalled for \d+ms$/)
  const reported = Number(entry?.detail.match(/(\d+)ms/)?.[1])
  expect(reported).toBeGreaterThanOrEqual(busy)
}, 25_000)

it('judges a stall by the monotonic clock, so a wall-clock jump alone is not one [logic only, not a suspension]', async () => {
  let monotonic = 0
  let wall = Date.parse('2026-10-01T00:00:00.000Z')
  const h = passes(() => false, () => true, { monotonic: () => monotonic, wall: () => wall })
  h.passes.request()
  await h.passes.idle()
  // An hour of wall time with one beat of monotonic time is what a suspended process looks like from inside.
  wall += 3_600_000
  monotonic += PASS_INTERVAL_MS
  h.passes.request()
  await h.passes.idle()
  expect(h.passes.status()).toMatchObject({ gapMs: PASS_INTERVAL_MS, stalls: 0 })
  expect(h.health.get()).toMatchObject({ state: 'ready' })
})

it('runs the passes asked for during a pass as one pass after it', async () => {
  const h = passes()
  await Promise.all([h.passes.pump(), h.passes.pump(), h.passes.pump(), h.passes.pump()])
  expect([h.engine.evaluateDue.mock.calls.length, h.effects.kick.mock.calls.length]).toEqual([2, 2])
  await h.passes.pump()
  expect(h.engine.evaluateDue).toHaveBeenCalledTimes(3)
})

it('refuses a Trigger while dsh-superagent stops, before the Engine stores anything, and starts a pass for one it stored', async () => {
  let closing = true
  const h = passes(() => closing)
  expect(() => h.passes.receive(trigger)).toThrow('Orchestrator is stopping')
  expect(h.engine.receive).not.toHaveBeenCalled()
  closing = false
  expect(h.passes.receive(trigger)).toBe('stored')
  await h.passes.idle()
  expect(h.engine.evaluateDue).toHaveBeenCalledOnce()
})

it('starts no timer once stopped, as a start-up that ends after a stop asks', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const h = passes()
    await h.passes.stop()
    h.passes.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.engine.evaluateDue).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
