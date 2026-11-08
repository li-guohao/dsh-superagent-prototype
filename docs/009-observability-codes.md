# 009 Observable codes

Status and event codes are stable identifiers for operations. A value is assigned once and never reused or reworded; this table is the registry, `src/app/codes.ts` holds the constants, and `Store.read.assessmentStatus()` returns status codes with per-Thread ages. Code spaces: status 0–99, events 100–999.

## Snapshot identity

Each snapshot carries `instance.id` (the persisted `KV.runtime.masterId`), `instance.pid` and `instance.bootedAt` (when the process loaded the reads). `id` names the deployment, so it survives restarts; `bootedAt` separates one process from the next, which is what tells a stale snapshot from a fresh one.

Each Thread entry carries its deterministic key and, when an Eval runs, that Eval's id. Trigger ids keep their existing sha256 content identity; Eval ids identify one batch attempt (their inputs include the start time), so do not use them for deduplication.

## Status codes

| Code | Constant | Meaning | Introduced |
|---|---|---|---|
| 0 | `THREAD_STATUS.UNKNOWN` | Reserved. A record that cannot be classified must never look like a real state. | 0.1.0 |
| 1 | `THREAD_STATUS.WAITING` | `pending` holds Triggers no ticket decides and no Eval runs. `ageMs` counts from the oldest such intake. | 0.1.0 |
| 2 | `THREAD_STATUS.EVALUATING` | An Eval runs and `evaluating.delivered` is set. `ageMs` counts from the Eval start. | 0.1.0 |
| 3 | `THREAD_STATUS.UNDELIVERED` | An Eval runs but `evaluating.delivered` is missing; it never expires. `ageMs` counts from the Eval start. | 0.1.0 |
| 4–9 | — | Reserved for later Thread states. Add a registry row before assigning a value. | — |

One code per Thread: a Thread that is evaluating reports 2 or 3 even when it also holds pending Triggers. Those Triggers still count in `totals.triggers`.

A Trigger counts as waiting only while it still awaits an Eval, judged by `followupOwners`: a Trigger a ticket still decides is that ticket's, and `Evals.start` removes it from `pending` on its next pass. A stale row that pass has not reached yet, or one that an Eval's presence keeps a Thread from reaching, is not backlog: it is neither counted nor aged, and a Thread kept active only by such rows has no entry.

## Event codes

Registered in 0.1.0 and emitted by nothing yet: this step adds no log channel. The values are assigned before the emitters exist so a later step cannot invent them.

| Code | Constant | Meaning | Introduced |
|---|---|---|---|
| 100 | `ASSESSMENT_EVENT.EVAL_STARTED` | An Eval was created for a Thread. | 0.1.0 (registered, not emitted) |
| 101 | `ASSESSMENT_EVENT.CANDIDATE_DELIVERED` | The candidate card reached the main Session; `evaluating.delivered` is set. | 0.1.0 (registered, not emitted) |
| 102 | `ASSESSMENT_EVENT.CANDIDATE_DELIVERY_FAILED` | One delivery attempt failed; count these to see retries. | 0.1.0 (registered, not emitted) |
| 103 | `ASSESSMENT_EVENT.EVAL_EXPIRED` | The deadline passed for a delivered Eval. | 0.1.0 (registered, not emitted) |
| 104 | `ASSESSMENT_EVENT.EVAL_REQUEUED` | The Triggers went back to `pending` after an expiry. | 0.1.0 (registered, not emitted) |
| 105 | `ASSESSMENT_EVENT.EVAL_UNAVAILABLE` | The Thread gave up after the allowed requeues. | 0.1.0 (registered, not emitted) |
| 200 | `ASSESSMENT_EVENT.DEFERRED` | The gate stopped starting Evals. Belongs to a later step. | reserved |
| 201 | `ASSESSMENT_EVENT.RECOVERED` | The gate lifted. Belongs to a later step. | reserved |
| 106–199, 202–999 | — | Reserved. Do not reuse a retired value. | — |

Events are not stored: there is no event table, by design, so counts and filters come from log aggregation once an emitter exists. Status values stay program-readable in the snapshot and never depend on log text.
