# 03 - Plan

Purpose: test a read-only goal-to-plan routine.

```sh
BIN=../../../src/index.ts
bun run $BIN run plan --input goal="add a small slugify helper"
```

Expected: a short plan with files and verification. No files change.
