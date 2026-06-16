# 09 - Check Fails Then Recovers

Purpose: test a real multi-iteration loop where the builder must learn from the failing check output.

```sh
BIN=../../../src/index.ts
bun run $BIN run forced-revise
```

Expected: the first attempt may fail, the check output feeds the next iteration, and the loop can converge.
