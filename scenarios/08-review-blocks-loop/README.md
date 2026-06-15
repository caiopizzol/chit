# 08 - Review Blocks Loop

Purpose: prove green checks are not enough when the routine declares reviewer approval as a blocking condition.

```sh
BIN=../../src/index.ts
bun run $BIN inspect implement
```

Expected inspect line: `all checks pass AND critique == "pass"`.
