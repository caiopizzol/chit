# Self-hosting: how chit develops chit

chit builds chit with its own loop. This is the operating guide: which mode to
use, what the orchestrator still owns, and the discipline that keeps autonomous
runs honest. The loop itself lives above chit (manifests are static DAGs and
cannot loop); see `docs/supervised-convergence.md` for why.

## The two modes

Both modes share one shape: an implementer writes a slice, a reviewer checks it,
and a human checkpoints. They differ in who implements.

- **Supervised.** The Claude Code chat implements with its full tools and
  context; a chit `per_scope` Codex advisor reviews each round
  (`apps/cli/examples/implementation-check-thread.json`, which inspects the git
  diff). The chat owns the loop and the checkpoint. Reach for this on nuanced,
  cross-package, or exploratory slices, where the chat's reasoning and live tools
  earn their keep.
- **Autonomous (`chit converge`).** The chat sets a task and runs the converge
  driver; chit's write-capable Claude implements and a read-only Codex reviews,
  and the driver loops to convergence (`apps/cli/examples/converge.json`). The
  chat does not implement and does not babysit each handoff. Reach for this on
  well-scoped, self-contained slices, and to keep building the self-hosting
  habit.

The mode is a per-slice choice, not a default. When in doubt on a gnarly change,
supervised produces cleaner results faster; on a tight, well-specified change,
autonomous is the better demonstration and offloads the writing.

## The orchestrator's job (both modes)

The chat is always the orchestrator. It owns three things the loop does not:

1. **Sequencing and the human checkpoint.** One slice at a time; stop and hand
   back on a `block`, an ambiguous product decision, or anything outward-facing.
2. **The final gates.** The reviewer runs read-only and usually cannot even run
   the tests (its sandbox blocks the temp dirs the suite needs). So the
   orchestrator runs them itself, every slice, before merge: the full test suite,
   a live smoke of the real behavior, typecheck, the linter, the browser-safety
   check when core changed, and a scan for banned characters. A reviewer
   `proceed` is necessary, not sufficient.
3. **The push.** Never push without explicit human permission, and only after the
   gates pass.

Treat the reviewer as an independent second opinion, not ground truth: verify
each finding against the code before acting on it. Codex reviews (not a second
Claude) precisely because an independent model catches what a same-model check
misses.

## Running an autonomous slice

1. Branch into a worktree so a wedged or abandoned run stays isolated.
2. Run the driver against that worktree:

   ```sh
   chit converge --task "<the slice>" --scope <stable-id> --cwd <worktree>
   ```

   It loops implement/check to the reviewer's verdict (`proceed` converges,
   `block` stops, anything else revises and retries up to `--max-iterations`,
   default 3; an unparseable verdict is treated as `block`, never an implicit
   proceed). It records the loop to `.chit/loops/<loopId>.jsonl` and audits each
   iteration by default.
3. Inspect what happened: read the loop log, and open a transcript with `chit
   audit show <runId>` (the run id is on the iteration's `detailsRef`). The
   transcript carries the prompts, outputs, live adapter events, usage, and the
   recorded per-participant config.
4. Run the final gates yourself (see above). The driver's reviewer could not.
5. Checkpoint with the human. Push only on explicit approval.

For autonomous work prefer the driver over manual `chit_start` / `chit_run_step`:
the driver owns the loop. The stepwise MCP tools are for the supervised single
check, or for watching and cancelling one long handoff.

## Discipline that bites

- **MCP server staleness.** The chit MCP server is a persistent process; it runs
  the adapter and runtime code from when it started. After changing an adapter or
  the runtime, reconnect the server before any MCP-driven run reflects the
  change. The reviewer reads files from disk, so reviews stay current; runs
  through the adapter do not.
- **Agent profiles.** Set model, reasoning effort, and timeouts on named agents
  in `~/.config/handoff/agents.json` and reference them from the converge
  manifest. `chit show` and `chit audit show` report the effective config so you
  can see what a run used.
- **Worktrees.** Run converge in a worktree; clean it up when the slice lands. A
  run's audit transcript survives in the local state dir even if the worktree is
  removed, but its loop log does not (it lives in the repo).

## Pointers

- `docs/supervised-convergence.md`: the supervised pattern and the installable
  skill.
- `apps/cli/examples/converge.json`: the autonomous loop manifest.
- `docs/audit-v0.md`: reading transcripts with `chit audit`.
- `docs/mcp-v0.md`: the stepwise MCP surface and its one invariant.
