# spike/studio-nodes

Slice 0 of the chit Studio plan. See `docs/studio-v0.md` and `docs/studio-node-sketches.md` for context.

Goal: prove React Flow + ELK + paper-and-ink can render the three node sketches without producing "React Flow with less color." Also prove `bun build --target=browser` can bundle React Flow.

Throwaway. Delete once Slice 1 lands.

## Run

```sh
bun install
bun run dev
```

Open `http://127.0.0.1:4040`.

## Inputs

Hardcoded: one `question` input, one `ask_codex` call, one `out` format. Mirrors `apps/cli/examples/consult.json` shape (single-advisor variant).

## What this spike does not do

No manifest IO. No server beyond a static file handler. No saving. No edit. No auth. None of it is needed to answer the visual fit + bundler questions.
