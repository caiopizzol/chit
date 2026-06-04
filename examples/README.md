# Examples

Four manifests live here on purpose:

- `consult.json` - the first-run example. Ask Codex and Claude the same question in parallel, then format both answers.
- `converge.json` - the advanced loop manifest used by `chit converge`. The default pairing: a write-capable Claude implements, a read-only Codex reviews, and the driver owns the loop.
- `converge-codex-writer.json` - the same loop with the agents swapped (a write-capable Codex implements, a read-only Claude reviews). Point a batch task's `manifestPath`, or `chit_start`'s `manifest_path`, at it to run a Codex implementer. Shows that roles are assigned in the chit, not fixed to a vendor.
- `converge-required-checks.json` - the same loop with `policy.requiredChecks`, so chit runs its own verification commands (argv, no shell) after a proceed review and treats the result as ground truth: pass converges, fail revises, a check that cannot run needs a human. Shows chit-executed verification, not the reviewer's self-report.

Keep this directory small. Add a new example only when it teaches a distinct runtime shape that the docs actually need.
