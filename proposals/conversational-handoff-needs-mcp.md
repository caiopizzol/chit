# proposal: conversational handoff wants MCP or human-checkpoints, not skills

- Status: open, decision deferred (dogfood signal, not a commitment)
- Motivated by: Dogfood v0 scenario 5 design; the requirement to run a handoff
  inside the Claude CLI chat, see each agent's response as it lands, and jump in
  with a manual turn when needed.
- Decision needed: does the MCP surface (or a human-checkpoint step kind) move
  up the roadmap, given the skill surface cannot deliver the in-chat,
  interruptible experience?

## The signal

The intended way to use chit, stated plainly during dogfood: run the routine
inside a chat, watch the responses arrive, and interject manually whenever the
human wants. The skill surface does not provide this, by design:

- A skill runs `chit run <manifest>` as one bash block and returns a single
  captured output. The whole DAG executes to completion before anything is
  shown. No intermediate step is visible as it happens.
- The generated skill is `disable-model-invocation: true`, so the model never
  calls it as part of reasoning; the user invokes it explicitly.
- There is no `checkpoint` / `wait` / `human` step kind, so a run cannot pause
  for human input mid-flow (confirmed: no such kind in the manifest schema).

So the skill surface is batch. It is the right shape for "fire the whole
routine and hand me the result," and the wrong shape for "let me sit in the
loop."

## What would fit

- **MCP surface (not shipped).** Expose chit, or individual participants, as MCP
  tools the model can call mid-conversation. Codex's answer lands in the chat as
  a tool result, the human reads it inline and interjects naturally, and the
  model can chain calls. This is the surface the requirement actually describes.
- **Human-checkpoint step (not a feature).** A step kind that pauses the run and
  surfaces intermediate output for human approval / edit before continuing.
  Turns the batch DAG into a stepped, interruptible run.

## Today's workaround (what we are dogfooding instead)

Single-agent skills with the human as orchestrator: the Claude Code session is
the conversation (the human is the Claude side), and `/ask-codex <...>` fetches
Codex's view into chat on demand. This is in-chat and fully interruptible, but
the human still pastes context into the skill argument and there is no
auto-orchestration. It tests "does pulling the other agent into one chat help"
without testing the full hands-off handoff.

## Recommendation

Defer. Finish the Dogfood v0 CLI and single-agent-skill receipts first. But
record this as the clearest priority signal so far: the conversational,
human-in-the-loop use case points at MCP (currently slotted "later") and at
human-checkpoint steps (currently "not shipped, maybe later"). If the dogfood
receipts confirm the single-agent workaround feels like glue, that is the
evidence to pull MCP forward.
