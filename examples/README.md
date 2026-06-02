# Examples

Three manifests live here on purpose:

- `consult.json` - the first-run example. Ask Codex and Claude the same question in parallel, then format both answers.
- `converge.json` - the advanced loop manifest used by `chit converge`. The default pairing: a write-capable Claude implements, a read-only Codex reviews, and the driver owns the loop.
- `converge-codex-writer.json` - the same loop with the agents swapped (a write-capable Codex implements, a read-only Claude reviews). Point a batch task's `manifestPath`, or `chit_start`'s `manifest_path`, at it to run a Codex implementer. Shows that roles are assigned in the chit, not fixed to a vendor.

Keep this directory small. Add a new example only when it teaches a distinct runtime shape that the docs actually need.
