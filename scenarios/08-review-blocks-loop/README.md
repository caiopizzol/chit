# 08 - Review Blocks Loop (advanced + fragile)

Purpose: show how to make a model verdict BLOCK convergence, and why it is the exception, not the default.

The loop converges only when the deterministic check passes AND a model verdict returns `pass`. To make
the verdict as reliable as a model verdict gets, the review is split into two steps:

- `review`: free-form critique. Feedback for the builder; never the gate.
- `verdict`: a constrained call ("reply exactly `pass` or `revise`"). This is the signal the loop gates on.

```sh
BIN=../../src/index.ts
bun run $BIN inspect implement
```

Expected inspect line: `all checks pass AND verdict == "pass"`.

## Why this is fragile (and the default is `06`)

A real dogfood run of the blocking form did-not-converge: even on a green check, the model withheld the
exact token, and the builder over-corrected chasing the reviewer and regressed the check (receipt
`run-9b687124` in `chit-dogfood-lab`). A deterministic check does not drift; a model verdict does. Prefer
`06-implementation-loop` (checks-pass, reviewer advisory) unless you specifically want a model to be able
to hold the line on something a check cannot express.
