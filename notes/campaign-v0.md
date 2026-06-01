# campaign v0 (experimental, dogfood-only)

`chit campaign` is an experimental local coordinator for running several `chit
converge` loops across a small set of GitHub issues, each in its own git
worktree. It is a dogfooding aid, not a headline v0 surface.

What it is, and is not:

- It is an orchestrator one layer above `converge`. `converge` orchestrates one
  task (implement/check to convergence over a static manifest); a campaign
  coordinates multiple `converge` runs.
- It is **not** part of the manifest runtime. It adds no dynamic routing to
  manifests; manifests stay static DAGs.
- It is **not** a daemon. Every command runs to completion and exits.
- It never auto-merges and never auto-pushes. v0 prints merge instructions and
  stops there.

This keeps the product boundary intact: the README's "not a workflow engine, no
schedulers" line is about the runtime, and `campaign` lives at the
orchestrator-on-top layer that `converge` already established (see
`notes/backlog.md` on dynamic orchestration staying out of the manifest).

## Hard limits (v0)

- `--max-parallel` is capped at 2.
- No auto-merge, no auto-push.
- No agent-to-agent chat.
- No daemon, no background process.
- No dynamic task creation: tasks come only from issues you pass explicitly.
- No overlapping path claims: a campaign refuses to start if two tasks claim
  overlapping paths.
- A task refuses to run against a dirty worktree (override with a flag).

## State

Campaign state is repo-scoped operational metadata, so it lives next to the
loop logs it points at:

```
.chit/
  campaigns/<campaign-id>.json   small repo-local coordination state (this)
  loops/<loop-id>.jsonl          per-task converge loop logs
~/.local/state/chit/audit/       large, sensitive transcripts (unchanged)
~/worktrees/<repo>/campaigns/<campaign-id>/<task-id>   task checkouts
```

`.chit/` is gitignored, so campaign state is never committed. Worktrees are not
repo state, so they live under `~/worktrees/`, never inside `.chit/`.

## Worktrees

A campaign creates one worktree per task, deterministically:

- path: `~/worktrees/<repo>/campaigns/<campaign-id>/<task-id>`
- branch: `caiopizzol/campaign-<campaign-id>-<task-id>`
- created from the campaign's recorded `baseSha`.

It refuses to clobber an existing path (unless `--reuse-worktree`) or branch
(unless `--reuse-branch`), verifies the worktree is clean before running, and
never removes a worktree on its own. `status` prints cleanup instructions.

## How a task runs

For each eligible task, the campaign invokes the existing converge driver
in-process (the same code path as `chit converge`), pointed at the task's
worktree:

```
converge --task <issue body + acceptance criteria>
         --scope campaign-<campaign-id>-<task-id>
         --cwd <task worktree>
         --max-iterations <n>
         --loop-id <deterministic id>
```

It then reads the loop log under the worktree's `.chit/loops/<loop-id>.jsonl`
and records the pointer (worktree path, branch, loop id, audit refs, changed
files, final verdict) into the campaign file.

## Task state machine

```
pending -> running -> review_ready    (converge converged: reviewer said proceed)
                   -> blocked          (converge blocked, or hit max-iterations)
                   -> failed           (the converge run itself failed/threw)
```

`merge_ready` and `merged` are reserved states. v0 does not assign them: there
is no merge tracking yet. A dependent task is scheduled only when all of its
dependencies are `merge_ready` or `merged`, so in v0 dependent tasks do not
auto-run. This is deliberate and fail-safe: running a dependent task from a
`baseSha` that does not yet contain its dependency's changes would be wrong.
Run independent tasks in v0; merge tracking is a later slice. `status` flags any
dependent task plainly ("will not auto-run in v0; merge deps first") so the
scheduler does not look broken.

The campaign status reflects this honestly: an all-converged campaign reports
`ready_for_review` (chit has done all it will do; a human still reviews and
merges), not `complete`. v0 only reaches `complete` if every task is actually
`merged`, which it never assigns on its own.

## Classification

Path claims come from a keyword heuristic over the issue TITLE only. Bodies
mention many areas in passing (a distribution issue that discusses MCP is not an
MCP code change), so matching the body over-claims and, because `start`
hard-refuses overlapping claims, would spuriously block useful campaigns. A
title the heuristic does not match is left `needs_human`; classify it
explicitly with `--claim issue-9=README.md,notes/**` (repeatable), which
replaces the heuristic claims for that task.

## Scheduling rules

A task is eligible to run when all hold:

- its status is `pending`;
- every dependency is `merge_ready` or `merged`;
- its claimed paths do not overlap any currently active task's claims;
- the number of active tasks is below `--max-parallel`.

The campaign stops a task on a `block` verdict, a failed converge run, or a
dirty/conflicted worktree. It never advances past a human checkpoint on its own.

## Commands

```
chit campaign start  --issues <n,...> [--claim <task-id>=<paths>] [--base <branch>] [--max-parallel <n>] [--id <id>]
chit campaign status <campaign-id>
chit campaign run    <campaign-id> [--max-iterations <n>] [--reuse-worktree] [--reuse-branch] [--allow-dirty]
chit campaign inspect <campaign-id> --task <task-id>
```

`start` records the campaign and classifies tasks (dependencies + path claims).
`run` runs eligible tasks up to the parallel cap. `status` and `inspect` are
read-only.

## v0 non-goals

Studio campaign UI, automatic conflict resolution, GitHub issue comments,
arbitrary dynamic task creation, more than 2 parallel tasks, and any
long-running background process are all out of scope. This surface stays
experimental until it proves it can coordinate two independent worktrees
cleanly.
