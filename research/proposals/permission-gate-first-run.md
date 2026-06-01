# proposal: permission gate on the first `chit run`

- Status: open, decision deferred (gather more dogfood receipts first)
- Motivated by: dogfood receipts 0001, 0002
- Decision needed: should an unenforceable `filesystem: read_only` warn-and-proceed on `chit run`, or keep failing closed?

## The friction

A new user's very first `chit run` of any chit that includes a claude
participant exits 2 before reaching the agents:

```
chit: cannot enforce required permissions for "consult-stateless":
  - participant "claude" (agent "claude") requires filesystem: read_only, but its adapter cannot enforce it

Pass --allow-unenforced-permissions to run anyway (emits a warning each run).
```

This is not an edge case. `filesystem: read_only` is the **default** participant
permission, and the bundled `claude-cli` adapter cannot enforce it. So every
example chit that uses claude (`consult`, `consult-stateless`, `ask-claude`)
hits this on the first try. The gate is on `run`, not just `install`.

## Why it happens

`findEnforcementGaps(manifest, registry)` returns a gap whenever a participant
declares a permission its adapter cannot enforce. The CLI run path fails closed
unless `--allow-unenforced-permissions` is set. `claude-cli` declares it cannot
enforce `filesystem: read_only` (the `codex-exec` adapter can, via
`--sandbox read-only`). Default `read_only` + claude = guaranteed gap.

## The tension (why this is a product call, not a UX tweak)

The obvious fix is "warn and proceed for `read_only`, since it is the safe
default." But that is exactly backwards on the governance axis: failing to
enforce `read_only` means claude **could write** when the chit declared it must
not. The hard-fail is the thing that makes the declaration mean something. That
is the "chit, not chat" premise: the order is enforced, not advisory.

So the choice is between two real goods:

- **Frictionless first run** (warn-and-proceed) vs
- **A `read_only` declaration that is actually guaranteed** (fail closed).

## Options

1. **Keep strict, document the flag.** Document `--allow-unenforced-permissions`
   prominently in Getting Started. Cheapest. Leaves the first-run stumble in
   place; the contract stays meaningful.
2. **Remove the `read_only` default from the examples.** Set the example chits'
   claude participants to a permission claude-cli can honor, so the out-of-box
   examples run clean and the gate only appears when a chit genuinely asks for
   an unenforceable guarantee. Changes example data, not runtime policy.
3. **Warn-and-proceed only on CLI `run`** (keep failing closed for `write` or
   other unenforceable perms, and keep the consent gate on install). Removes the
   friction but weakens the `read_only` guarantee for the claude adapter on the
   run path. Would want the per-run warning to stay loud.
4. **Make claude sandboxing real so the gap disappears.** Teach the claude-cli
   adapter to actually enforce `filesystem: read_only` (the way codex-exec does
   with `--sandbox read-only`). No friction and no weakening: the declaration
   becomes true. Most work; depends on what the claude CLI exposes.

## Recommendation

Defer until Dogfood v0 finishes. Do not change behavior yet. The real product
loop is still scenarios 5-8 (Studio install, Claude Code invocation, permission
consent, whether the warning reads clearly in context). The skill-install path
already requires the consent checkbox, so the same tension shows up there;
seeing both surfaces should tell us whether the pain is the behavior, the
defaults, the examples, or the docs.

Note on likely direction (not a decision): warn-and-proceed (option 3) is the
least favored, because it weakens the governance model that is the whole point.
The likelier endgame is option 2 (examples stop tripping the gap) or option 4
(actually enforce claude read-only). Decide after the Studio / Claude Code runs.
