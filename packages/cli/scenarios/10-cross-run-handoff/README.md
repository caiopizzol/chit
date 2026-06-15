# 10 - Cross Run Handoff

Purpose: show the current explicit handoff pattern between separate runs.

Run the panel first:

```sh
BIN=../../src/index.ts
bun run $BIN run panel-review --input question="What should the first slice be?"
```

Then copy the useful recommendation into a second run:

```sh
bun run $BIN run implement-with-context \
  --input task="Implement the chosen first slice." \
  --input context="<paste the panel recommendation>"
```

This is intentionally manual. Automatic `--from <run-id>` handoff is not built yet.
