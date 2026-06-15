# 07 - Feature Flow

Purpose: test grill -> plan -> human gate -> sandboxed implementation in one flow.

```sh
BIN=../../src/index.ts
printf 'Keep the first slice tiny.\n' | bun run $BIN run feature-flow --input idea="add slugify(input)"
```

Expected: a dry-run patch is stored under the flow run id. Apply with `bun run $BIN apply <flow-run-id>`.
