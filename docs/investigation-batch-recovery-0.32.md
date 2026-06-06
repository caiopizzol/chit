# Batch-task workspace recovery after 0.32.0

Can you still apply and clean up a batch task's worktree when its durable records
are partly gone? This note traces the three stores a batch task writes (job,
batch, loop log) and walks each loss scenario to a concrete answer.

Bottom line: **small follow-up.** With the job record present (which, today, is
always: nothing prunes it) `chit_apply` / `chit_cleanup` by `run_id` work for a
batch task exactly like a single background run. The one reachable gap is the
linked-worktree launch (scenario 5): a batch records the *launching* checkout as
its durable cleanup anchor instead of the main repo, so cleanup can strand
worktrees if that checkout is removed before the batch is cleaned. The
job-record-missing cases (scenarios 3-4) have real holes but are unreachable
through normal operation, so they are a documented limitation, not a fix.

## Findings

| Scenario | What remains | `chit_apply` by run_id | `chit_cleanup` / `chit_batch_cleanup` | Verdict |
|---|---|---|---|---|
| 2. Normal | job + batch + loop log | works | works | OK |
| 3. Job pruned | batch + loop log | fails (not recoverable) | `chit_batch_cleanup` works; per-run `chit_cleanup` fails | gap, **unreachable today** |
| 4. Log only | loop log | fails | fails | gap, **unreachable today** |
| 5. Linked-worktree launch | job + batch + loop log | works while launch checkout lives | strands worktrees if launch checkout removed first | **follow-up (reachable)** |

Scenario numbers match the task's scope list. "Unreachable today" is grounded in
scenario 6 below: no code path prunes job, batch, or loop-log records.

## What each store holds for a fresh 0.32.0 batch task (scenario 1)

A batch task is launched by `batchDeps.launchJob` → `launchConvergeJob`
(`apps/cli/src/surfaces/mcp/server.ts:2292`), forwarding the task's worktree and a
loop id of `<batchId>-<taskId>` (`apps/cli/src/batches/engine.ts:444`). It does
**not** pass a `runId`, so one is generated (`server.ts:620`). That single fact
drives everything below: for a batch task, `run_id` (a fresh UUID) and `loopId`
(`<batchId>-<taskId>`) are **different ids**.

- **JOB record** (`apps/cli/src/jobs/store.ts`, one file `<runId>.json`): carries
  the full workspace. `launchConvergeJob` writes `worktreePath`, `branch`,
  `baseSha`, `repo`, `callerCheckout` onto the record (`server.ts:627-633`) from
  the worktree the engine forwarded (`engine.ts:460-466`). This is the durable
  source of truth for recovery.
- **BATCH record** (`apps/cli/src/batches/store.ts`, one file per batch): each task
  carries `worktreePath` + `branch` (`apps/cli/src/batches/types.ts:119-120`, set
  at `engine.ts:439-440`), and the batch carries `repo` + `baseSha`
  (`types.ts:129,132`). Enough for `chit_batch_cleanup`, which keys on exactly
  these (`engine.ts:266-277,300`).
- **LOOP LOG header** (`apps/cli/src/loops/log-store.ts`, file
  `<batchId>-<taskId>.jsonl`): **does not carry the workspace.** `startLoop`
  writes the workspace fields only when handed an `opts.workspace`
  (`log-store.ts:179-185`), and `launchConvergeJob` calls `startLoop` **without**
  it (`server.ts:600-606`). The foreground path is the only caller that forwards
  it (`apps/cli/src/surfaces/mcp/converge-engine.ts:178-196`, mapping
  `worktree.repo` → header `mainRepo`). The background worker never re-writes the
  header at all: the enqueue side reserves the loop, the worker only appends
  iterations and the stop record (`apps/cli/src/jobs/worker.ts:7`). So a batch
  task's loop header has `loopId`, `scope`, `task`, `repo` (= the worktree
  toplevel, via `repoRoot(cwd)` at `log-store.ts:175`), `startedAt`,
  `maxIterations` - and nothing about the managed worktree's base, branch, main
  repo, or launching checkout.

This is the gap the task flagged as most likely, and it is real. Its blast radius
is bounded by who reads the header, covered under scenario 4.

## Scenario 2 - job record present (the real-world case)

Works, for both verbs, because both resolve the workspace from the job record, not
the log. `runController.resolve(run_id)` finds the background job
(`apps/cli/src/surfaces/mcp/controller.ts:49-62`), and `resolveRunWorkspace` reads
`worktreePath` / `baseSha` / `repo` / `callerCheckout` straight off it
(`server.ts:1257-1264`). `chit_apply` then runs `git diff baseSha` in the task
worktree and applies to `callerCheckout` (`server.ts:2214-2255`); `chit_cleanup`
retires the worktree from `repo` (`server.ts:2113-2126`). A batch task's `run_id`
is surfaced for this on every status read (`engine.ts:570`,
`run_id: t.jobId`). This is the ae01633 parity the feature set out to deliver, and
it holds.

Edge worth stating precisely, since the task asks about "missing **or stale**": a
stale job is not a missing record. `stale` is derived at read time, never stored
(`apps/cli/src/jobs/types.ts:26-27`), so the record is still on disk and
`resolveRunWorkspace` still reads the workspace off it. But "shows as stale" and
"safe to apply/cleanup" are two different tests, and they can disagree. `isStale`
marks a *running* job stale on either a dead pid **or just an old heartbeat**
(`apps/cli/src/jobs/health.ts:42`, `return heartbeatOld || !pidAlive(job.pid)`),
whereas `resolveRunWorkspace` calls a running job live strictly on the pid
(`server.ts:1256`, `workerLive = deps.pidAlive(job.pid)`), ignoring heartbeat age.
So the stale cases split:

- **stale-queued** (sat past the window, never produced a pid) and
  **stale-running with a dead pid** → `workerLive: false` → `chit_apply` /
  `chit_cleanup` proceed.
- **stale-running with a still-live pid** (a silent or wedged worker, or a paused
  machine - old heartbeat but the process is up) → surfaced as stale, yet
  `workerLive: true` → `chit_cleanup` refuses it as still active
  (`server.ts:2103-2106`) and `chit_apply` refuses because the diff "is not final
  yet" (`server.ts:2235-2239`). That refusal is deliberate: removing the worktree
  or snapshotting the diff out from under a live process would corrupt the run. It
  clears only once the worker's pid is actually gone (apply/cleanup gate on
  `pidAlive` via `workerLive`, `server.ts:1256`), so it stays blocked until the
  worker exits or settles, possibly after a `chit_cancel` request - not because the
  record is present. And `chit_cancel` is not a guaranteed unblock here:
  `requestJobCancel` always persists the cancel intent but sends SIGTERM only when
  the job is *not* stale and its pid is live (`server.ts:907`); a stale-running job
  fails that test, so cancel can return `signaled: false` and merely record intent
  for the worker to honor between iterations.

So "missing or stale" bites differently: *missing* loses the workspace handle
(scenarios 3-4); *stale* keeps it, but apply/cleanup still gate on the worker not
being pid-live - a stale display alone does not make a batch task recoverable.

## Scenario 3 - job record gone, batch record intact

`chit_batch_cleanup` still works. Its liveness guard treats a vanished job as
not-alive (`engine.ts:250-253`: `getJob` returns `undefined` → the task is not
counted alive), and it removes worktrees off the batch task's own
`worktreePath`/`branch` anchored on `existing.repo` (`engine.ts:296-302`). No job
read is required to clean.

But nothing resolves **apply** for that task. There is no batch-keyed apply tool
(the registered set is `chit_apply` + `chit_batch_{start,list,status,advance,cancel,cleanup}`
only). `chit_apply` takes a `run_id`; with the job gone, `resolve` returns
`undefined` (`controller.ts:55-62`) and falls to the archived loop-log path
(`server.ts:2164-2180`), which cannot match a batch task (scenario 4). The diff is
not lost - it sits in the task worktree, and the batch record still names the path
- but recovering it means a manual `git -C <worktree> diff`, not `chit_apply`.

## Scenario 4 - only the loop log remains

No recovery path resolves a batch task here, for three independent reasons - any
one is fatal:

1. **The file is keyed by loopId, not run_id.** `chit_apply` / `chit_cleanup` /
   `chit_trace` fall back to `resolveArchivedForegroundLoop(run_id)` →
   `findLoopByRunId(run_id)`, which scans for a file literally named
   `<run_id>.jsonl` (`apps/cli/src/loops/log-store.ts:113-122`). A batch task's log
   is `<batchId>-<taskId>.jsonl`, and `run_id` is an unrelated UUID, so the scan
   returns `undefined`. This fallback was built for **foreground** runs, where
   `run_id` *is* the loopId by construction (`controller.ts:37-40`,
   `registerLoop` returns `session.loopId`) - so the file name equals the lookup
   key. Background runs (single and batch) break that equality, so the loop log is
   simply not a `run_id`-addressable store for them.
2. **The header has no workspace.** Even if the file were found, the batch header
   omits `worktreePath`/`branch`/`baseSha`/`mainRepo`/`callerCheckout` (scenario 1),
   so the "future logs (0.23+)" branch (`server.ts:1778-1792`) does not fire.
3. **The git-derivation fallback assumes a single-run branch.** The older-log
   branch derives the workspace from git but only accepts a branch matching
   `chit-run/<loopId>/` (`server.ts:1804-1805`). A batch task's branch is
   `chit-batch/<batchId>/<taskId>` (`apps/cli/src/batches/worktree.ts:62-69`), so
   the prefix check fails and it returns no workspace.

So "only the loop log" is an unsupported recovery state for any background run, and
doubly so for a batch task. This is by design (the job record is the durable
handle), not a regression - but it is worth recording as a known limit.

## Scenario 5 - launched from a linked worktree (the reachable gap)

The maintainer routinely runs from `~/worktrees/chit/<feature>`. `startBatch`
resolves the batch's `repo` with `repoToplevel`
(`apps/cli/src/batches/engine.ts:137`), which is `git rev-parse --show-toplevel` -
**the launching checkout**, i.e. the linked worktree itself, not the main repo.
That one value is then used for everything: the worktree-creation cwd
(`engine.ts:434`), and **both** `repo` and `callerCheckout` on every task's job
record (`engine.ts:460-466`, `repo: c.repo, callerCheckout: c.repo`), and the
cleanup anchor `existing.repo` (`engine.ts:300`).

The single-run path deliberately does **not** do this. `prepareRunWorkspace`
resolves `repo` with `mainRepoOfWorktree` - the durable main repo behind the
shared `.git` - precisely so "cleanup must anchor on the main repo that owns the
shared .git" survives the linked checkout being removed
(`apps/cli/src/batches/worktree.ts:182-195,261-277`); it keeps `repoToplevel` only
for `callerCheckout` (the apply target). The batch path collapses both into the
ephemeral `repoToplevel`.

Consequence: while the launch checkout exists, everything works (apply even
defaults to the right place, the checkout you are working in). But if that linked
worktree is removed first - e.g. the feature merged and you ran
`/worktree-cleanup` before cleaning the batch - then `repo` points at a deleted
directory. `removeTaskWorktree` runs `git -C <deleted> worktree remove ...`
(`worktree.ts:232`), git cannot start in a missing cwd, and cleanup returns
`{ok:false}` for every task. The worktrees and branches are stranded (recoverable
by hand: `git -C <main repo> worktree remove --force ...`), but no work is lost -
the converged diffs are still on disk. Launch from the main repo and none of this
applies (`repoToplevel` == main repo there).

## Scenario 6 - nothing prunes the records

This is what bounds scenarios 3 and 4 to "theoretical." None of the three stores
deletes a record. `JobStore` and `BatchStore` expose only
`create`/`get`/`update`/`claim`/`list` - no delete, no retention sweep (the only
`rmSync` in either is the temp-file cleanup inside `writeAtomic`,
`jobs/store.ts:206`, `batches/store.ts:116`). `log-store.ts` has no delete either.
`cleanupBatch` and `cleanupRunWorkspace` explicitly keep receipts
(`engine.ts:286-290`, `worktree.ts:286`). A repo-wide search for
`prune|retention|sweep|evict|expire|ttl|reap|purge` turns up only `git worktree
prune` (a git op on stale worktree entries, `worktree.ts:237`), the in-memory
foreground-run eviction (`controller.ts:90-96`, which never touches durable
records), and the **audit** store's `prune` (`apps/cli/src/audit/store.ts:203`,
called opportunistically from the converge driver, `cli/converge.ts:965`). Audit
prune deletes transcript run directories only; the workspace-recovery metadata
lives in the job and batch records, never in audit, so it cannot cause scenario 3
or 4. So the only way to reach "job record gone" today is external file deletion
or losing the state dir (e.g. an `XDG_STATE_HOME` change) - not anything chit does.

## Recommendation

**Small follow-up.** The feature works for the state that actually occurs (job
record present, always). Do one thing now; the rest is optional.

1. **Anchor a batch on the durable main repo (scenario 5).** In `startBatch`,
   resolve the cleanup anchor with `mainRepoOfWorktree` and keep the launching
   checkout separately for apply's target, mirroring `prepareRunWorkspace`.
   Concretely: store both on the batch (add a `callerCheckout` to the `Batch`
   record, set `repo` = main repo, `callerCheckout` = `repoToplevel`) and forward
   them distinctly at `engine.ts:460-466` instead of `repo: c.repo,
   callerCheckout: c.repo`. **Effort: ~half a day** - the helper and the
   single-run precedent already exist; the work is threading one extra field
   through the `Batch` type, `startBatch`, and the launch params.

2. **(Optional) Forward the workspace into the batch loop header.** Pass
   `opts.workspace` from `launchConvergeJob` to `startLoop` (mirror
   `converge-engine.ts:187-195`). One line, and it also helps single background
   runs. But it does **not** close scenario 4 on its own: the log is still keyed by
   `loopId` not `run_id`, so `findLoopByRunId(run_id)` still misses. Not worth more
   than the one line until something can actually prune a job record.

### Proposed deterministic test (scenario 5)

The seam is `startBatch`'s injected `git: GitRunner` and `launchJob` dep - both
already faked in the batch engine tests, so this is a pure unit test with no real
git.

- **Fixture:** a scripted `GitRunner` mimicking a linked-worktree launch -
  `rev-parse --show-toplevel` → `/wt/feature` (the launching linked worktree),
  `rev-parse --git-common-dir` → `/main/.git`, `rev-parse <ref>` → a fixed base
  sha. A spy `launchJob` that captures the `LaunchJobParams.worktree` it receives,
  and a fake `createWorktree` returning a deterministic path/branch.
- **Asserts:** the captured `worktree.repo === "/main"` (the durable main repo
  derived from the common dir) and `worktree.callerCheckout === "/wt/feature"` (the
  launching checkout) - i.e. they are **distinct**. Against today's code the
  assertion fails because both come back `"/wt/feature"`. A second case launches
  from the main repo (`--show-toplevel` and the common-dir parent both `/main`) and
  asserts `repo === callerCheckout === "/main"`, pinning that the fix is a no-op
  for the common path.

A companion engine test can drive `cleanupBatch` with `existing.repo` pointed at a
non-existent dir and assert today's stranding (every entry `removed === false`),
then flip to passing once the anchor is the main repo - but the unit test above is
the minimal one that captures the defect at its seam.
