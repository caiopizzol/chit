# 02 - Grill

Purpose: test a read-only grilling session. The model questions an idea and suggests a small first slice.

```sh
BIN=../../src/index.ts
bun run $BIN run grill --input idea="add a slugify helper"
```

Expected: no files change. The receipt records a single read-only model call.
