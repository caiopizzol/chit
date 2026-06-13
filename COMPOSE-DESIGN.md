# Composition — design proposal (NOT yet built)

Status: proposal for review. No code written. The single loop is now honest + bounded
(stale wording fixed, diff capped, real revise path field-tested), so composition is unblocked.

## What it is

A **flow** is a routine whose steps invoke OTHER routines, passing outputs forward. It is
still just a routine (`chit run feature-flow ...`), so the product model stays "one concept".

```json
{
  "id": "feature-flow",
  "policy": "flow",
  "inputs": { "idea": { "type": "string", "required": true } },
  "steps": [
    { "id": "grill", "routine": "feature-griller",      "inputs": { "idea": "{{ inputs.idea }}" } },
    { "id": "plan",  "routine": "planning",             "inputs": { "goal": "{{ steps.grill.output }}" } },
    { "id": "impl",  "routine": "implementation-review", "inputs": { "task": "{{ steps.plan.output }}" } }
  ],
  "output": "impl"
}
```

`chit run feature-flow --input idea="..."` runs grill, then plan (fed grill's output), then
implementation-review (fed plan's output). The same `{{ inputs.* }}` / `{{ steps.<id>.output }}`
templating you already have, now mapping one routine's output into the next routine's inputs.

## Decisions (R = recommended)

**D1. New `policy: "flow"`** alongside one-shot / converge. A flow step is `{ id, routine, inputs }`.
Parse-time checks: every referenced routine exists, no cycles, inputs map only references prior
steps. R: yes - keeps "a flow is a routine" and reuses resolve/inspect/trace.

**D2. The safety fork - how do converge steps inside a flow handle the sandbox? (the real decision)**
A converge step edits files; a flow like grill -> plan -> impl needs impl's edits to be the flow's result.
- R (v1): **one converge step per flow, and it is terminal-ish.** One-shot steps (grill, plan) produce
  TEXT only (no file edits). A converge step runs in its own sandbox exactly as today: **dry run by
  default** (flow shows the combined result + the converge diff, discards), `--apply` writes the
  converge step's diff back. This reuses the converge safety wholesale and adds no new write path.
- Deferred: multiple converge steps / a shared flow-level sandbox where later steps see earlier edits.
  That is the powerful version but it multiplies the sandbox/apply complexity; not needed to prove composition.

**D3. Flow receipt = a chain.** A `FlowReceipt` lists each step's id, routine, status, elapsed, and
the sub-run id (so `chit trace <subRunId>` still works per step). It records each step's output length,
not the body (same body-free rule). `trace` renders the chain; the converge step's own receipt holds its iterations.

**D4. Failure propagation.** If a step fails (one-shot failed, or converge did-not-converge/failed),
the flow stops there and reports which step failed. R: yes - no point planning on a failed grill.

**D5. No new safety surface.** A flow with no converge step never touches your tree. A flow with a
converge step inherits dry-run-by-default + `--apply`. Per-call timeout and wall-time already apply to each sub-run.

## What I'd build (test-first, mirrors converge)

1. manifest: `policy: "flow"`, flow steps, parse + validate (routine exists, no cycles, input refs). Tests.
2. flow executor: resolve + run each sub-routine in order (one-shot via runOneShot, converge via
   runConvergeInSandbox), map inputs via the template context, chain receipts. Fake-backed. Tests.
3. `FlowReceipt` + trace rendering (the chain). store handles the third receipt shape. Tests.
4. CLI: `chit run <flow>`; inspect shows the step->routine chain; `--apply` forwarded to the converge step.
5. A real `feature-flow` example + an end-to-end smoke (grill -> plan -> a tiny implementation-review), dry-run.

## The one thing to confirm before I build

D2. I recommend **v1 = text steps then at most one converge step, dry-run by default, `--apply` at the
flow level**. The alternative (a shared flow sandbox so multiple converge steps build on each other) is
more powerful but materially more complex and risk-prone. I'd ship the simple one first.
