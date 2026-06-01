# notes

Design records for chit: specs, RFCs, sketches, and spikes. This is the
project's thinking, kept for context. It is **not** the published documentation.

- The docs users read live in `apps/site/content/docs/` and ship to the website.
- These notes are design history. They can lag the shipped behavior; when they
  disagree, the code and the published docs win.

## Layout

- `*-v0.md` - design specs for a surface or subsystem (manifest schema, MCP,
  audit log, Studio, loop view) as designed. The code cites several of these as
  the contract.
- `supervised-convergence.md`, `self-hosting.md` - operating patterns for the
  implement/check loop.
- `studio-node-sketches.md` - early Studio node sketches.
- `backlog.md` - the working backlog.
- `proposals/` - design proposals, resolved and open.
- `spikes/` - throwaway experiments kept for reference. Each is standalone (its
  own `package.json`/lockfile), not part of the Bun workspace.

Test material lives elsewhere: `dogfood/` holds real-run receipts and
deliberately-broken trap fixtures. That is product test material, not design
notes, and the dated receipts are kept verbatim as historical records.
