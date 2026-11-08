# 010 Standing issues

Risks this deployment knows about and deliberately leaves alone for now. Each entry states what triggers it, what grows, why this round does not touch it, and where a later change belongs. Recording one here is not a plan to fix it in this round.

## Pending grows while an Eval never ends

### Trigger

A Thread holds `pending` Triggers while `evaluating` is set. `Intake` queues every Trigger no ticket decides on its primary Thread (`src/core/part.ts`, `queueForEval`), and `Engine.evaluateDue` starts an Eval only when the Thread has no Eval (`src/core/engine.ts`). So while one Eval runs, arrivals queue behind it. The pressure case is an Eval that never ends: the Eval deadline applies only to a delivered candidate, and an undelivered Eval never expires ([009 Observable codes](009-observability-codes.md), status 3), so a candidate the main Session never receives holds `evaluating` indefinitely.

### Growth

`pending` grows with the Thread's arrival rate of Triggers no ticket decides, multiplied by how long its Eval stays open. Nothing caps it and nothing ages it out; only the end of the Eval, or the main Session deciding those Triggers, drains it. A quiet Thread does not grow, and a busy Thread grows without a bound proportional to its traffic.

The cost grows with the list as well, not only with its time: the list lives inside the Thread's JSON value, so every arrival rewrites a larger row, and `Store.read.assessmentStatus()` reads each queued Trigger of an active Thread on every pass, so a status pass costs in proportion to `pending` length. The snapshot still shows the count (`totals.triggers` and each entry's `triggers`), but a Thread with an Eval reports status 2 or 3 rather than 1, and `assessor` alarms on the age of the undelivered candidate, so this growth raises no alarm of its own.

### Why this round leaves it alone

- No Trigger is lost. The rows stay in `pending` and go to the next Eval; the list is storage, not a drop path. Reaching this state is a delay, not a correctness failure.
- One Eval per Thread is intended scheduling: a Trigger that arrives while an Eval runs is meant to be read by the next Eval, and a second concurrent Eval would change what the assessor sees and which candidate wins. A cap, or starting anyway, is a decision about which Triggers one Eval sees; it is not a bug fix.
- This round bounds effect attempts (`eval.effectAttemptSeconds`, described in [006 Deployment](006-deployment.md)) and adds observability. Evals already bound themselves with `eval.timeoutSeconds` and `REQUEUES`; the remaining unbounded case is the undelivered Eval, whose non-expiry is a known gap in its own right.
- The fix needs a policy choice (a cap size, a start condition, or an expiry for undelivered Evals), so it belongs in a round that may change scheduling, not in one that froze it.

### Where a later change goes

- `Engine.evaluateDue` (`src/core/engine.ts`): the condition that starts an Eval only when none runs, and the pause check beside it. A cap, a second Eval, or any priority rule starts here.
- `Evals.start` and `Evals.expire` (`src/core/evals.ts`): removal of Triggers a ticket owns happens lazily on the next start, so rows a ticket decides can also wait out an Eval. Moving that cleanup to intake would keep both kinds out of `pending`.
- `queueForEval` (`src/core/part.ts`, reached from `src/core/intake.ts` and `src/core/tickets.ts`): the append itself, where a cap would be enforced and where a refused Trigger would need its own record.
- `thread.active` (`src/app/store.ts`) and its in-memory mirror (`src/core/memory.ts`): both treat any non-empty `pending` as active, so a cap changes which Threads passes scan and the cost of every pass.
- [009 Observable codes](009-observability-codes.md): the waiting definition must stay based on `followupOwners`; a Trigger kept only for the next Eval must not turn into a waiting count or an alarm by accident.
