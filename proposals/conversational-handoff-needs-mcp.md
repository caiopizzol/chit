# proposal: conversational handoff wants MCP or human-checkpoints, not skills

- Status: RESOLVED → build it. The progress-spike proved Claude Code renders MCP
  progress/log heartbeats live; the stepwise chit MCP spike
  (`apps/cli/src/surfaces/mcp/`) ran propose-verify-revise end to end and the
  live heartbeat through a 221s step felt materially better than the silent
  skill (receipt 0004). Stepwise static DAG over MCP is the conversational
  surface. Next: running-state lock, then cooperative cancellation, then
  within-step adapter streaming.
- Motivated by: Dogfood v0 scenario 5 design; the requirement to run a handoff
  inside the Claude CLI chat, see each agent's response as it lands, and jump in
  with a manual turn when needed.

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

## The identity question this forces

Naively there look like two shapes, and they are a false binary:

- **Static DAG = opaque.** chit owns the routing; the run is one closed call.
- **Free-form MCP = model-orchestrated.** The model calls participant-tools in
  whatever order it likes. Visible and interactive, but that is dynamic routing
  (the model invents the graph), which is the LangGraph-shaped thing chit
  defines itself against.

There is a third shape that keeps chit's thesis and gets the visibility:

- **Stepwise static DAG over MCP.** chit still owns the manifest and enforces
  the declared order; MCP exposes each *runnable* step as a visible tool call.
  The model (or the human) decides *when* to continue, but chit decides *what is
  legal to run next*. Visible tool calls and interjection points, without
  letting the model invent arbitrary routing. This avoids the LangGraph cliff.

  A possible future MCP shape:

  - `chit_start(manifest, input)` -> creates a run, returns run_id
  - `chit_next(run_id)` -> returns the step(s) the manifest says are ready
  - `chit_run_step(run_id, step_id)` -> allowed only if the manifest says that
    step is ready; runs it and returns its output
  - `chit_trace(run_id)` -> returns the current transcript

  Each `chit_run_step` is a tool call the client renders inline, so the human
  watches each handoff and can interject between steps, while the manifest still
  governs legality. The static DAG is preserved; only the *driving* moves into
  the conversation.

- **Human-checkpoint step (not a feature).** A simpler, surface-agnostic option:
  a step kind that pauses the run for human approval / edit before continuing.
  Turns the batch DAG into a stepped, interruptible run without MCP.

## Trace experiment (done) and what it tells us

Added an opt-in `--trace` (CLI flag; `chit install --trace` bakes it into the
skill) that renders a step transcript: per step, the participant, agent, session
policy, elapsed time, status, and prompt/output previews. Verified on
`consult-stateless` (the transcript even makes the parallel fan-out visible:
both calls start before either finishes) and on `propose-verify-revise` (shows
propose -> verify -> revise with timings, and confirms `per_scope` resume: the
revise output references the original proposal, which was never re-pasted).

This addresses *"I do not know what chit sent and received"* (post-hoc, or live
in a terminal; buffered-then-shown via the skill). It does NOT address *"watch
the agent think"* (the adapter keeps only the final answer; intermediate agent
reasoning is discarded) or *"jump in mid-flow"* (the run is still one closed
call). Those remain the MCP / checkpoint question.

A headless multi-task run (receipt 0003) sharpened the priority: the worst part
of the experience is a single step going silent for 141-164s (the codex verify
step), with the trace showing `> step "verify"` and then nothing until it
returns. The pain is as much *within-step latency* as between-step steering.
Step-level trace does not fix it, and neither would step-level MCP tool calls on
their own (you would still wait on one opaque `chit_run_step`). The deeper lever
is surfacing the intermediate agent events the adapter currently discards
(streaming within a step). Worth weighing alongside the stepwise-MCP shape: the
two are complementary (stepwise MCP for between-step control, within-step
streaming for "is it still working?"). The re-run in chat is the
evidence: if a clear transcript makes the batch skill feel acceptable, the MCP
work can wait; if it still feels like a black box you cannot steer, the stepwise
MCP shape above is the decisive next bet.

## Today's workaround (what we are dogfooding instead)

Single-agent skills with the human as orchestrator: the Claude Code session is
the conversation (the human is the Claude side), and `/ask-codex <...>` fetches
Codex's view into chat on demand. This is in-chat and fully interruptible, but
the human still pastes context into the skill argument and there is no
auto-orchestration. It tests "does pulling the other agent into one chat help"
without testing the full hands-off handoff.

## Recommendation

Defer the surface work; the trace experiment is the gate. Re-run `/ask-codex`
and `/propose-verify-revise` (both now installed with `--trace`) in chat and
judge whether the transcript dissolves the black-box feeling. If it does, the
batch skill is good enough for now and MCP stays "later." If it does not, the
decisive next bet is **stepwise static DAG over MCP** (not free-form model
orchestration, and ahead of a bare human-checkpoint step), because it is the
only shape that gives visibility and interjection while keeping chit's
declared-order thesis intact.

One refinement to keep explicit, from the headless run: within-step streaming
does NOT help the Claude skill surface by itself, because skills buffer the
whole command before substituting its output. It helps terminal runs, and it
becomes essential for an MCP surface. So the next bet is not "stepwise MCP OR
streaming" - it is **stepwise MCP with per-step progress / agent-event
streaming**. A bare `chit_run_step` tool that sits silent for 164 seconds would
reproduce the same "is this alive?" distrust at a smaller boundary. Between-step
control (stepwise) and within-step liveness (streaming) are both required; one
without the other still feels like a box.
