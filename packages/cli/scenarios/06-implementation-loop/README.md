# 06 - Implementation Loop (the recommended default)

Purpose: the default shape for an implementation loop. A builder writes, a reviewer gives advisory
feedback that feeds the next iteration, and a deterministic `check` is the convergence gate
(`repeat.until: "checks-pass"`). The reviewer shapes the work; the check decides when it is done.
For a model verdict that can BLOCK convergence, see `08` -- but it is fragile, so prefer this.

```sh
BIN=../../src/index.ts
bun run $BIN run implement --input task="Create math.js exporting add(a,b), plus keep the smoke check passing."
```

Expected: dry-run diff is shown and saved. Review it, then run `bun run $BIN apply <run-id>`.
