# fixtures

Test fixtures shared across the suites.

- `traps/` - intentionally invalid manifests (cyclic graphs, dangling refs,
  unknown agents, bad templates, missing outputs) that confirm validation fails
  the way it should. See `traps/README.md`.
