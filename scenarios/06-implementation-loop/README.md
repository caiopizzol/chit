# 06 - Implementation Loop

Purpose: test a sandboxed build -> review -> check loop.

```sh
BIN=../../src/index.ts
bun run $BIN run implement --input task="Create math.js exporting add(a,b), plus keep the smoke check passing."
```

Expected: dry-run diff is shown and saved. Review it, then run `bun run $BIN apply <run-id>`.
