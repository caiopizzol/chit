# Chit scenario matrix

This folder is a small test bench for the routine model. Each scenario is a standalone project with its own `chit.config.json` and routine manifests.

Use these when you want to dogfood a specific orchestration pattern without adding new runtime features.

## Scenarios

| Scenario | Proves |
| --- | --- |
| `01-clarify` | Human input with no model call. |
| `02-grill` | A read-only grilling session. |
| `03-plan` | Goal to plan, read-only. |
| `04-panel-review` | Multiple model participants with a final judge. |
| `05-refine-loop` | A read-only loop that stops when an evaluator says `ship`. |
| `06-implementation-loop` | Builder plus reviewer plus deterministic check in a sandbox. |
| `07-feature-flow` | Grill -> plan -> human gate -> implementation loop. |
| `08-review-blocks-loop` | Checks pass and the reviewer must return `pass`. |
| `09-check-fails-then-recovers` | A loop that should need feedback from a failing check. |
| `10-cross-run-handoff` | Manual, explicit context handoff from one run into another. |

## Run shape

From a scenario directory:

```sh
BIN=../../src/index.ts
bun run $BIN routines
bun run $BIN inspect <routine>
bun run $BIN run <routine> --input name=value
bun run $BIN trace <run-id>
```

Sandboxed routines are dry runs by default. Review the diff, then apply the exact stored patch:

```sh
bun run $BIN apply <run-id>
```

Use `--auto-apply` only for automation where skipping review is intentional.
