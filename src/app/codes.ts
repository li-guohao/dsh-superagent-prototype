/**
 * Stable numeric codes for observability. A value is assigned once and never reused or reworded; meaning and
 * introducing version live in `docs/009-observability-codes.md`. Code spaces: status 0–99, events 100–999.
 *
 * S1 registers both tables but emits no events: nothing in this batch writes logs, so the status codes are the only
 * values that leave the process (through `Store.read.assessmentStatus()`).
 */
export const THREAD_STATUS = {
  /** Reserved: a record that cannot be classified must never look like a real state. */
  UNKNOWN: 0,
  /** Triggers wait in `pending`; no Eval is running. */
  WAITING: 1,
  /** An Eval runs and its candidate reached the main Session (`evaluating.delivered` is set). */
  EVALUATING: 2,
  /** An Eval runs but `delivered` is missing; it never expires, so it stays until the candidate is delivered. */
  UNDELIVERED: 3,
} as const
export type ThreadStatusCode = (typeof THREAD_STATUS)[keyof typeof THREAD_STATUS]

/**
 * Transitions of the assessment state machine. Registered now, emitted later, so the emitter cannot invent values.
 * `CANDIDATE_DELIVERY_FAILED` counts attempts; `DEFERRED` and `RECOVERED` belong to the gate, not to S1.
 */
export const ASSESSMENT_EVENT = {
  EVAL_STARTED: 100,
  CANDIDATE_DELIVERED: 101,
  CANDIDATE_DELIVERY_FAILED: 102,
  EVAL_EXPIRED: 103,
  EVAL_REQUEUED: 104,
  EVAL_UNAVAILABLE: 105,
  DEFERRED: 200,
  RECOVERED: 201,
} as const
export type AssessmentEventCode = (typeof ASSESSMENT_EVENT)[keyof typeof ASSESSMENT_EVENT]
