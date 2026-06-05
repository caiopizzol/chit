Create `review-check.json`.

The manifest should be a one-shot read-only reviewer chit:

- `schema`: `1`
- `id`: `review-check`
- string inputs: `task`, `diff_summary`
- participant `reviewer` using agent `codex`
- `session`: `per_scope`
- `permissions.filesystem`: `read_only`
- one `call` step that references both inputs
- one `format` step that includes the reviewer output
- `output` points at the format step

Do not add a loop policy. Do not express required checks as shell strings.
