# Traps

Deliberately-broken manifests. Each one MUST fail with a specific, clear error.
They are regression fixtures: if a trap ever stops failing (or fails with a
worse message), a guardrail broke.

Two kinds, because chit validates in two phases:

- **Parse-time** traps are caught by `chit show` (and by parsing in general),
  before anything runs.
- **Resolve-time** traps parse fine but fail when the agent registry is
  consulted at `run` / `install`.

## Check them

```sh
# Parse-time: every one of these must exit non-zero on `show`. unknown-agent is
# excluded on purpose (it parses fine; it is the resolve-time trap below).
for f in dogfood/traps/*.json; do
  [ "$(basename "$f")" = "unknown-agent.json" ] && continue
  bun apps/cli/src/cli/run.ts show "$f" --format ascii >/dev/null 2>&1 \
    && echo "LEAK (show passed): $f" || echo "ok (rejected): $f"
done

# Resolve-time: unknown-agent passes `show` but must fail `run` (exit 2).
bun apps/cli/src/cli/run.ts run dogfood/traps/unknown-agent.json --input q=hi
```

## Expected failures (verified)

| File | Phase | Expected error (substring) |
|------|-------|----------------------------|
| `bad-template.json` | parse | `malformed template tag near "{{ inputs.q \| upper }}"` |
| `cyclic.json` | parse | `steps: cyclic dependency among: a, b` |
| `dangling-ref.json` | parse | `template references unknown step "ghost"` |
| `missing-output.json` | parse | `output: references unknown step "ghost"` |
| `unknown-agent.json` | resolve (run/install) | `unknown agent "gpt-9000" in registry` |

Note: `unknown-agent.json` intentionally passes `chit show` (exit 0). Registry
resolution is a run/install concern, not a parse concern. That split is the
point of keeping it here.
