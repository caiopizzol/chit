---
name: "chit"
tagline: "Stop being the glue between your agents."
version: 3
language: en
---

# chit

## Position

Chit is a thin local runtime for multi-model agent workflows.

You declare a routine in `chit.config.json`: which local agent profiles exist, which routine can run, which steps execute, what context flows forward, where a human can answer, and what condition ends a loop. Chit reads that config, runs the steps from your terminal, writes a receipt, and leaves a patch for you to review before it touches your tree.

The product is the config and the run. Keep the story there.

## Core Message

Stop being the glue between your agents.

One model can plan. Another can build. Another can review. Your shell can check the result. Chit makes that routine explicit so it can be inspected, repeated, and changed without turning the workflow into a framework.

## What Chit Is

- A local CLI runtime.
- A config file that declares routines.
- A way to bind named profiles to adapters and models.
- A step runner for model calls, checks, human questions, and composed routines.
- A loop runner when the config declares `repeat`.
- A sandboxed write path for routines that edit files or run checks.
- A receipt for what ran.

## What Chit Is Not

- Not an agent framework.
- Not a hosted workflow platform.
- Not a chat product.
- Not a scheduler.
- Not a dynamic router.
- Not a vendor story.
- Not a compliance product.

## Vocabulary

Use these words consistently.

| Word | Meaning |
|---|---|
| `profile` | A local adapter and model binding, such as `codex:gpt-5.5`. |
| `routine` | A declared workflow in `chit.config.json` or a referenced routine file. |
| `agent` | A participant inside one routine. It points to a profile and has instructions. |
| `step` | One ordered action: `call`, `ask`, `check`, `format`, or `routine`. |
| `repeat` | The loop declaration and stop condition. |
| `receipt` | The saved record of what ran, which model ran, what checks passed, and what changed. |
| `sandbox` | The disposable git worktree used for writing or checking routines. |

Avoid older or broader words in public copy unless the code uses them directly. Prefer `profile` over provider, `routine` over recipe, `agent` over role, and `receipt` over transcript.

## Copy Rules

- Lead with the routine model, not a feature list.
- Show a real config before long explanation.
- Keep examples small enough to read in one screen.
- Say what is local, what is validated, and what is only checked at execution.
- Be clear that model availability is a live CLI/account concern, not a schema guarantee.
- Say "early" when something is early.
- Use "chit, not chat" sparingly, only when explaining the contrast.
- Do not use "AI-powered", "agentic" as marketing copy, "control plane", "seamless", "unlock", or "workflow automation platform".
- Do not mention old surfaces or previous product directions in public copy.

## Homepage Shape

1. Hero: the user is no longer the glue between agents.
2. One real `chit.config.json` example.
3. One real terminal transcript.
4. The dry-run, review, apply lifecycle.
5. Short early-state note.

Do not add extra product modes. If a concept is not visible in config or CLI output, it does not belong on the homepage yet.

## Docs Shape

The docs should stay small.

1. **Overview** explains the mental model.
2. **Config** is the reference for `chit.config.json`.

The Config page can be technical. It should still read like an API reference: tables, short descriptions, real JSON, and validation examples. Avoid tutorials that introduce many routines before the reader understands the file.

## Tone

Precise, compact, dry, plain.

Good:

- "A routine declares the work."
- "Profiles bind names to local adapters and models."
- "Checks are the strongest convergence signal."
- "Sandboxed runs are dry-run by default."

Bad:

- "Unlock multi-agent orchestration."
- "Build autonomous agent swarms."
- "Enterprise-grade agent governance."
- "Let AI decide the perfect route."

## Visual Direction

Paper, ink, terminal blocks, and compact reference tables.

Use:

- Real config snippets.
- Real CLI transcripts.
- Simple diagrams that show context flow.
- Tables that make config fields easy to scan.

Avoid:

- Chat bubbles.
- Robot or brain imagery.
- Purple AI gradients.
- Decorative dashboards.
- Screens that imply features not currently in the CLI.

## Status

Chit is early. Shipped in this minimal runtime: config parsing and schema validation, profiles, inline and file-backed routines, model-call steps, human `ask` steps, checks, loops, composed routines, sandboxed write runs, dry-run patches, `chit apply`, receipts, and adapters for Claude, Codex, and Gemini.

Not shipped in this minimal runtime: a scheduler, hosted service, dynamic routing, durable resume, or a visual config editor.

Brand copy must match what the minimal runtime can do today.
