# 01 - Clarify

Purpose: prove the CLI can pause for a human answer and feed it forward without calling a model.

```sh
BIN=../../../src/index.ts
printf 'first run\n' | bun run $BIN run clarify
```

Expected: stdout says `Got it: first run`.
