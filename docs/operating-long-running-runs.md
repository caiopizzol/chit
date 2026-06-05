# Operating long-running chit runs

The recipe chit's maintainers use to drive a long converge run (anything likely
over ~10 minutes) to completion without holding the chat open. Every step is an
MCP tool you call from a Claude Code conversation.

The shape:

```text
chit_start  (mode background, with required_checks)  ->  run_id
chit_wait   (run_id)                                 ->  blocks until terminal
chit_status (run_id)                                 ->  inspect any time, read-only
chit_trace  (run_id)                                 ->  iteration history once terminal
chit_apply  (run_id)                                 ->  dry run, then confirm
chit_cleanup(run_id)                                 ->  after apply
```

## Start: background for anything long

Use `chit_start` with `mode: "background"` for work likely to run past ~10
minutes. It returns a `run_id` right away and hands the run to a detached worker
that drives it to completion. The worker survives an MCP reconnect.

```jsonc
chit_start({
  task: "<the slice to converge on>",
  scope: "<stable id; both agents keep their thread across iterations>",
  mode: "background",
  required_checks: [{ command: "bun", args: ["run", "check"] }],
  max_iterations: 5
})
```

The default, `mode: "foreground"`, is different: you advance it one iteration at
a time with `chit_next`, which blocks the chat for the whole iteration. Pressing
Esc there cancels the in-flight iteration and settles it. A background run has
nothing to babysit: Esc during `chit_wait` only stops the wait, the worker keeps
running. That is the reason to background long work.

A loop run needs both `task` and `scope`. By default the run is isolated in a
chit-managed worktree cut clean off HEAD, so its diff is attributable and your
checkout stays untouched until you apply it (see Salvage).

## Wait: block, don't poll

Call `chit_wait({ run_id })` to block until the run is terminal (completed,
failed, cancelled, or its worker died). It returns the same view as
`chit_status` plus a `waitResult`. Use this instead of polling `chit_status` in
a loop, and never read chit's state files: they are private.

`timeout_ms` defaults to 900000 (15 minutes). On `waitResult: "timeout"` the run
is still going, so just call `chit_wait` again. Esc stops the wait, not the run.

## Inspect while it runs

`chit_status({ run_id })` is read-only and side-effect-free: a poll never keeps a
run alive. Reach for it when you want a snapshot mid-flight; reach for
`chit_wait` when you want to block until done.

A background run reports a job view: `phase`, `elapsedMs`, `phaseElapsedMs`, and
`lastHeartbeatAgeMs`. The worker heartbeats every ~10 seconds. A
`lastHeartbeatAgeMs` past about a minute (the view then shows `stale: true` and
`display: "stale"`) means a dead or wedged worker, not slow work.

A foreground loop reports an in-flight `activity` object instead, present only
while an iteration runs: `iteration`, `phase`, `elapsedMs`, `phaseElapsedMs`, and
`lastActivityAgeMs`. Read `lastActivityAgeMs` differently from the background
heartbeat: it is the age of the last activity mark (an iteration start, a phase
transition, a cancel), not a periodic beat. Minutes-old is healthy mid-phase.

## After it's terminal: read the trace

`chit_trace({ run_id })` returns the iteration history: each iteration's summary,
changed files, verdict, the verification and its checks, usage, and the audit
ref.

If the run failed, stopped blocked, or its worker died mid-iteration, look for
`partialWork` in the `chit_status` view. Such a run can leave real edits
uncommitted in its worktree that no iteration record captured, so `changedFiles`
reads empty and the work looks gone. It is not: `partialWork` lists those files,
and they are sitting in the worktree, ready to salvage.

## Salvage: apply, then clean up

Bring a finished run's work into a checkout with `chit_apply`. Dry run first (the
default): it reports the tracked files, whether they apply cleanly, and the
untracked candidates, and applies nothing.

```jsonc
// dry run: inspect the file list, apply nothing
chit_apply({ run_id: "<id>" })

// apply: tracked changes staged, named untracked files unstaged
chit_apply({ run_id: "<id>", confirm: true, include_untracked: ["path/to/new-file"] })
```

Confirm the tracked files first, then pass `confirm: true`. Tracked changes apply
through git's 3-way check and are refused whole if they conflict with the target,
so your edits are never overwritten; they land staged. Untracked files apply only
when named in `include_untracked` and land unstaged. The target defaults to the
checkout you launched from; pass `target_cwd` to apply elsewhere. chit's required
checks ran in the worktree, so run your own gates again in the target checkout
after applying.

Run `chit_cleanup({ run_id })` only after you have applied. Dry run by default;
`confirm: true` removes the managed worktree and branch. It refuses while the run
is still active, so cancel it and let it settle first. Receipts survive cleanup:
the loop log and audit stay, so `chit_trace` and `chit_audit_show` still work
afterward.

## Always gate on required checks

Pass `required_checks` to every `chit_start`. chit runs those commands itself
after a reviewer returns `proceed` and treats the result as ground truth over the
reviewer's self-report (the verification is recorded with
`verificationSource: "chit"`). Checks pass and the loop converges; a check fails
and it revises; a check cannot run and it stops `needs-decision`.

Each check is `{ command, args?, name?, timeoutMs? }`, spawned as argv with no
shell. A run-level `required_checks` replaces (never merges) the manifest's, so a
default-loop `task` run gets real verification without writing a custom manifest.
For the manifest-level equivalent, see
[`examples/converge-required-checks.json`](../examples/converge-required-checks.json).
