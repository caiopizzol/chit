# Chit scenario matrix

This folder is a test bench for Chit development. It is not the starter examples folder.

Each scenario is a standalone project with its own `chit.config.json` and routine manifests. Tests use these fixtures to prove runtime shapes without spending model calls.

## Convergence: checks first, reviewer as feedback

A deterministic `check` is the strongest convergence signal. Model verdicts are useful when judgment is the point, but they need a constrained output shape. Scenario `08` keeps that advanced shape isolated.

## Scenarios

| Scenario | Proves |
| --- | --- |
| `01-clarify` | Human input with no model call. |
| `02-grill` | A read-only grilling session. |
| `03-plan` | Goal to plan, read-only. |
| `04-panel-review` | Multiple routine agents with a final judge. |
| `05-refine-loop` | A read-only loop that stops when an evaluator says `ship`. |
| `06-implementation-loop` | The default: builder + advisory reviewer + a deterministic check as the gate. |
| `07-feature-flow` | Grill -> plan -> human gate -> implementation loop. |
| `08-review-blocks-loop` | Advanced + fragile: a constrained model verdict also gates convergence. |
| `09-check-fails-then-recovers` | A real multi-iteration loop: a failing check feeds the next iteration. |
| `10-cross-run-handoff` | Manual, explicit context handoff from one run into another. |

## Run shape

From a scenario directory:

```sh
BIN=../../../src/index.ts
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
