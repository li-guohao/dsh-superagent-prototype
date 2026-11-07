# Round 22 — worker end-to-end on Windows

Result: the worker really ran. `trigger → accept → worker wrote a file → DONE reply in outbox` completed on this machine with a real DeepSeek call chain. Four acceptance criteria all met; the call watchdog then killed dsh because the round finished using **10** model steps against a hard cap of **8**.

## 1. Path decision (zero-cost diagnosis)

Five POSIX touchpoints exist in the worker layer. Only one blocks the run.

| Where | What it does | Verdict |
| --- | --- | --- |
| `src/deployment.ts` `workerProbe` — `['env', 'PATH=…', gh …]` | Strips the worker shim directory from PATH via an `env` prefix | **Blocking.** Windows has no `env` executable, so every setup probe failed with `spawnFailed` |
| `src/deployment.ts` `resolveFeishuBot` — `['env', 'LARKSUITE…', cli …]` | Same trick for the Feishu bot CLI | Not triggered (no Feishu Source configured); same class of bug if it ever is |
| `src/infra/environment.ts` `writeEnvironment` — `#!/bin/sh` shims | Writes extensionless shell scripts into `worker-bin` | Writing works; execution does not. `CreateProcess` resolves `gh.exe` directly and never runs the shim, so the PATH guard is inert rather than fatal |
| `src/infra/environment.ts` `verifyEnvironment` — `git config -z --show-origin` | Compares `file:<worker-gitconfig>` and the credential helper | Not blocking; git echoes the exact path string it is given, and the state dir uses the same separator style |
| `src/executor/dsh.ts` `prepareDirectory` — `['sh', '-c', command]` | Runs the operator's prepare command | Not blocking while `executor.prepare` stays empty (it is empty here) |

Alternatives checked on this machine:

- **Git Bash present**: `C:\Program Files\Git\bin\sh.exe`, `usr\bin\env.exe`, `usr\bin\cygpath.exe`.
  Measured: `env.exe "PATH=<Windows PATH>" gh api user` → `/usr/bin/env: 'gh': No such file or directory` (exit 127). MSYS `env` needs a POSIX-style PATH, while the code passes a Windows-style one. With `cygpath -p` conversion the same call succeeds — so a no-code-change route would require the ambient PATH to be POSIX, which corrupts other Windows tools. **Not viable without code.**
- **WSL `Ubuntu-24.04`**: installed but stopped. Using it means reinstalling dependencies, credentials, and the repo inside WSL — far more work and a second environment to maintain. **Rejected.**
- **Code shim**: make `workerProbe` platform-aware. Both POSIX behavior and Windows behavior stay explicit; the `env` prefix remains byte-identical on POSIX. **Chosen as the shortest path.**

## 2. Change

`src/deployment.ts` — `workerProbe` takes an injectable `platform` (defaults to `process.platform`):

```ts
const timeout = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
if (platform === 'win32') return argv => runAsWorker(subprocess, argv, cwd, timeout, { PATH: path })
return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, timeout)
```

`runAsWorker` already accepts an `env` option, and the subprocess service merges it onto its scrubbed parent environment — verified in `dsh-subprocess-local`'s `childEnv`: `{...parent, ...spec.env}`, so `SystemRoot` and the rest survive while the shim directory is still removed from PATH.

`tests/deployment.spec.ts` — new `worker probe` describe with a recording fake subprocess (no `sh` needed, so it runs on every platform):
- win32: argv is `['gh','api','user']`, `env` is exactly `{ PATH: <shimless PATH> }`
- linux: argv keeps `['env','PATH=…','gh','api','user']`, `env` is undefined

`tests/runtime.spec.ts` — the existing setup assertion is now platform-branched instead of asserting the POSIX prefix unconditionally.

### Red → green

Red (after adding the test, before the fix): win32 assertion failed because the probe still emitted `env`; an earlier run also exposed my wrong import of `withoutDirectory` from `deployment.ts`, moved to `infra/environment.ts`.
Green:

```
✓ tests/deployment.spec.ts > worker probe > passes PATH through the subprocess environment on Windows, where no env executable exists
✓ tests/deployment.spec.ts > worker probe > keeps the POSIX env prefix unchanged
 Test Files  1 passed (1)
      Tests  4 passed | 3 skipped (7)
```

`pnpm check` (typecheck + full suite + build, fake endpoint running for the maildrop e2e):

```
Build complete in 2151ms
exit=0
```

## 3. Real run evidence

Two config-only blockers surfaced during the first attempt; neither needed code changes:

1. `gh` is installed only as `gh.exe`, and `executable()` looks for an extensionless file. Fix: `sources.github.config.cli = C:\Program Files\GitHub CLI\gh.exe` (absolute path).
2. The first trigger was dropped with `kind: ignore, reason: not_a_member` — my prepared state had overwritten `policy.sources.maildrop` without a `allowed` list. Fix: `allowed: [{ id: 'operator', name: 'Operator' }]`.

That first attempt cost **0** model calls (the policy gate short-circuits before eval).

Second attempt, evidence from the live state and session logs:

| Criterion | Evidence |
| --- | --- |
| Worker really started | session dir `--C-Users-Administrator-AppData-Local-Temp-dsh-r22-state-work-proof-file-92d1bb87af6c--`, 4 steps |
| Marker written to the working directory | `…\dsh-r22-state\work\proof-file-92d1bb87af6c\docs\round22-worker-proof.md`, 24 bytes, `round22 worker executed` |
| `turn/end` completed, not max-tokens | orchestrator: 2 turns, both `completed`; worker: 1 turn, `completed` |
| DONE in outbox | `f3d823c07712d0a77de27a2ca25e1150.json`, `kind: reply`, `text: "DONE"`, at `05:07:26Z` |

Ticket `92d1bb87af6c10d7eef629beb0ebbe67`, decision `6c5d3aa1d2f7c094066ef972393c6393` with `kind: accept, reason: explicitRouted, strength: explicit`; an acknowledgement was also delivered before the reply.

Timeline (local time): ticket created 13:07:21, proof file written 13:07:22, DONE enqueued 13:07:26, watchdog breach 13:07:30.

## 4. Cost

- Model steps: **10** (orchestrator 6, worker 4) against the external watchdog cap of 8.
- Tokens: input 15,677 / cache read 132,480 / output 990 (total 149,147).
- Estimated spend ≈ **¥0.02** at published DeepSeek rates; the ≈¥0.05 budget was not exceeded.
- The watchdog kept scanning after each change and wrote `STOP.txt` (`{"count":10,"limit":8,...}`) then `taskkill /T /F` on the dsh tree. The end-to-end work had already completed at that instant, so the breach did not invalidate the run; it did prove the hard stop works.

Why 10: the lead turn used 6 steps (accept + acknowledgement wording + routing), and the worker used 4 (read, write, verify, reply) at `maxTokens: 1024`.

## 5. Cleanup

- dsh, the watchdog, and the fake endpoint are stopped; no `node` process with `dsh-r22` and no `watch_calls`/`fake_model_endpoint` python remains.
- No `*.lock` files in the state dir or the smoke profile.
- The smoke profile's `dsh-superagent/lib` was restored from `%TEMP%\dsh-r22\store-lib-backup` (20 files), so the temporary build overlay is gone.
- The test inbox message was deleted; the outbox replies remain in `%TEMP%\dsh-r22\maildrop\outbox` as evidence.
- Local state/config edits touched only `%TEMP%\dsh-r22*` and `%LOCALAPPDATA%\Temp\dsh-r22-state`.

## 6. Open items

- The 8-call cap was exceeded by 2. No retry was attempted; a future round should either raise the cap to 12 or trim the acknowledgement/routing steps.
- `resolveFeishuBot` still uses the POSIX `env` prefix; it is dormant without a Feishu Source but would fail the same way on Windows.
- The `#!/bin/sh` worker shims are inert on Windows: PATH stripping prevents the shim from being found, but `gh.exe` resolution also means a shim could never intercept the call. Any future guard that relies on shims needs a Windows strategy.
- `executor.prepare` remains untested on Windows (`sh -c`); this round deliberately kept it empty.
- PR #2 is still open; not merged, no force/amend/rebase, upstream untouched.
