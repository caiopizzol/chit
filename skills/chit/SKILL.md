---
name: chit
description: "Operate the Chit CLI for declared multi-agent routines. Use when a repo has `chit.config.json`, the user asks to run, inspect, monitor, stop, trace, apply, debug, or clean up Chit runs, or Codex needs to use Chit as a supervised agent workflow runner from the terminal."
---

# Chit

## Purpose

Use Chit as a supervised local routine runner. Chit reads `chit.config.json`, resolves routines and profiles, runs model/check steps, stores receipts under `.chit/runs`, and for sandboxed routines produces a reviewed patch before applying anything to the working tree.

This skill is an operating workflow, not a config reference. Run `chit --help` when unsure about exact flags.

## Command Selection

Prefer the global CLI when operating a normal project:

```bash
chit --help
```

When developing Chit itself or testing uncommitted CLI changes, run the source CLI from the intended checkout:

```bash
bun packages/cli/src/index.ts --help
```

Use the same command form consistently for the whole run.

When operating from outside the project directory, pass `--project <path>` or set `CHIT_PROJECT=<path>`. Prefer this to changing directories in agent harnesses.

## Safe Workflow

1. Detect Chit:

```bash
test -f chit.config.json
```

2. Check readiness before model calls:

```bash
chit doctor
```

Use `chit doctor --real` only when real adapter calls are appropriate. It can spend model/API quota.

3. Inspect the available routines:

```bash
chit routines
chit inspect <routine>
```

Inspect before running whenever the routine, inputs, sandbox behavior, or model bindings are not already known.

4. Run dry by default:

```bash
chit run <routine> --input name=value
```

Repeat `--input` for multiple inputs. Quote shell values that contain spaces or punctuation.

For long runs, use background mode:

```bash
chit run <routine> --input name=value --background
```

The command returns after Chit has accepted the run's starting state. Use `wait` before judging the result.

5. Monitor active runs:

```bash
chit ps
chit status <run-id>
chit wait <run-id>
```

For agent-readable monitoring, use structured output:

```bash
chit ps --json
chit status <run-id> --json
chit wait <run-id> --json
chit wait <run-id> --follow --json
```

Use `wait --follow --json` when a monitor needs one JSONL stream of lifecycle events followed by the final run-state object. `wait` exits with the run outcome: `0` for completed/converged, `1` for failed/did-not-converge, `130` for cancelled.

If you interrupt `wait`, Chit detaches from the local monitor and the run keeps going. Use `chit stop <run-id>` only when you want to cancel the run itself.

Use `chit stop <run-id>` for a graceful cancel. Use `chit stop <run-id> --force` only when graceful cancel does not work or the user explicitly wants force. After forced stops, run cleanup.

6. Review evidence:

```bash
chit result <run-id> --json
chit trace <run-id>
chit trace --full <run-id>
```

Use `result --json` as the compact machine contract after a run finishes. It reports outcome, exit code, patch/apply readiness, declared convergence signals, structured step outputs, checks, and the next command. If `result` is unavailable, the installed CLI is older; use `trace --full` or the source CLI. Use `trace` for the human audit view, and `trace --full` when diagnosing failures, reviewing model outputs, or inspecting saved patches/debug patches.

7. Apply only after review:

```bash
chit apply <run-id>
```

Do not use `--auto-apply` unless the user explicitly asked for automation or the surrounding workflow already requires it.

8. Clean interrupted state:

```bash
chit cleanup
```

Run cleanup after interrupted sandboxed runs, forced stops, or suspicious leftover worktrees.

## Failure Handling

Do not assume a failed Chit run means the target code is wrong. First classify the failure from `trace`, `trace --full`, stderr, and stored patches:

- Config/setup problem: `doctor` or `inspect` fails before a model call.
- Model/capacity problem: adapter exits, times out, returns invalid structured output, or is cancelled.
- Verification problem: checks fail inside the sandbox.
- Change-policy problem: trace reports unexpected changed files.
- Operator cancellation: run exits 130 or trace says cancelled.
- Apply problem: the run converged but `apply` is blocked by base commit, dirty tree, or conflicts.

For failed or non-converged sandboxed runs, look for debug patch evidence in `trace --full`. Debug patches are for inspection, not `chit apply`.

## Safety Rules

- Prefer `inspect` before expensive or write-capable runs.
- Treat sandboxed runs as dry runs until `chit apply` is explicitly chosen.
- Prefer `chit ps` and `chit stop` over manual process killing.
- Do not push, apply, or force-stop merely because a run is slow. Check `chit ps`, progress output, and elapsed time first.
- Receipts and patches under `.chit/runs` are plaintext. Avoid putting secrets, private customer details, or unnecessary sensitive text into routine inputs.
- If the user asks for advice only, inspect and explain. Do not run model calls or apply patches.
