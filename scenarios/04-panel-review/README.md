# 04 - Panel Review

Purpose: test multiple participants and model bindings in one read-only routine.

```sh
BIN=../../src/index.ts
bun run $BIN run panel-review --input question="Should we add slugify now?"
```

Expected: two answers and one final judge recommendation. No files change.
