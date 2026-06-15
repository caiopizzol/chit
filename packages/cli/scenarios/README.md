# Chit scenario matrix

This folder is a small test bench for the routine model. Each scenario is a standalone project with its own `chit.config.json` and routine manifests.

Use these when you want to dogfood a specific orchestration pattern without adding new runtime features.

## Convergence: checks first, reviewer as feedback

A deterministic `check` is the best convergence signal: it is reproducible and it cannot drift.
So the default implementation loop converges on `repeat.until: "checks-pass"`, and the reviewer
step is **feedback** that feeds the next iteration, not a gate.

A model verdict CAN block convergence (`repeat.until: { all: ["checks-pass", { step, equals }] }`),
but treat it as an **advanced, fragile** pattern. A real dogfood run of the blocking form
did-not-converge: even on a green check, the model withheld the exact `pass` token, and the builder
then over-corrected to chase the reviewer and regressed the check (receipt in `chit-dogfood-lab`,
run `run-9b687124`). Reach for it only when the author deliberately wants that trade-off, and use the
two-step form (free-form `review` for feedback + a constrained `verdict` for the signal) shown in `08`.

## Scenarios

| Scenario | Proves |
| --- | --- |
| `01-clarify` | Human input with no model call. |
| `02-grill` | A read-only grilling session. |
| `03-plan` | Goal to plan, read-only. |
| `04-panel-review` | Multiple model participants with a final judge. |
| `05-refine-loop` | A read-only loop that stops when an evaluator says `ship`. |
| `06-implementation-loop` | The default: builder + advisory reviewer + a deterministic check as the gate. |
| `07-feature-flow` | Grill -> plan -> human gate -> implementation loop. |
| `08-review-blocks-loop` | Advanced + fragile: a constrained model verdict also gates convergence. |
| `09-check-fails-then-recovers` | A real multi-iteration loop: a failing check feeds the next iteration. |
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
