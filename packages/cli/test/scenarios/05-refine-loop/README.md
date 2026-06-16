# 05 - Refine Loop

Purpose: test a read-only loop where a critic decides when a draft is ready.

```sh
BIN=../../../src/index.ts
bun run $BIN run refine --input brief="Write one paragraph explaining Chit routines."
```

Expected: the loop repeats until the verdict step returns exactly `ship`, or stops at `maxIterations`.
