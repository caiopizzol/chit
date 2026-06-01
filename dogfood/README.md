# dogfood

The manual record of running real chits against real agents. Unlike the test
suite, these runs spend tokens and are non-deterministic, so the matrix is run
by hand, not in CI.

- `v0.md` - the scenarios, exact commands, pass/fail criteria, and known
  blockers for the current dogfood milestone.
- `receipts/` - one numbered receipt per real run: what ran, with what input,
  what output, and observed timing.
- `traps/` - intentionally invalid manifests (cyclic graphs, dangling refs,
  unknown agents, bad templates, missing outputs) that confirm validation fails
  the way it should. See `traps/README.md`.
- `propose-verify-revise.json` - a dogfood chit used in the matrix.

The `handoff` name survives in some receipts and fixtures here on purpose: this
folder records runs from when the project was called handoff. See `brand.md`.
