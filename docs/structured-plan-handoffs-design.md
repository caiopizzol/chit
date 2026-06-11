# Structured plan handoffs

Status: design note. No code.

This note describes the next orchestration layer after recipes: a plan step can
produce a bounded structured artifact, and a later plan step can consume it
without the chat session summarizing or relaying the data.

The goal is to move Chit closer to the useful part of workflow systems: the
runtime moves intermediate data between agents. The goal is not to turn Chit
into a general scripting engine or dynamic router.

## Current facts

- Manifests already have step-output references inside a single static DAG:
  `steps.foo.output` can feed a later manifest step.
- Sequential plans already flow code by applying a review-ready step into the
  plan integration branch, then launching dependent steps from that new commit.
- Plans do not currently have a first-class data channel. A dependent step can
  see earlier applied code, but it cannot consume a structured non-code result
  except through the human chat or by committing a scratch file into the repo.
- Receipts and audit transcripts already preserve model outputs, but they are
  inspection surfaces, not typed handoff contracts.
- Studio live intentionally shows compact identity and event skeletons, not full
  prompt or output bodies.

## Problem

A real orchestrated workflow often has a step that investigates and emits facts:

- files likely involved in a bug
- candidate tasks from an issue tracker
- API contract decisions
- risk list for the implementer
- review findings that should drive a follow-up step

Today the operator has to read that result and put it into the next step's
prompt. That makes the chat session the data bus again, which is exactly the
thing Chit is supposed to remove.

Committing an intermediate JSON file into the repo is not the right default
either. Many handoffs are useful to the plan but should not become product code
or documentation.

## Principle

Code diffs and handoff data are different artifacts.

- Code flows through the integration branch and the existing gated apply.
- Handoff data flows through Chit's durable plan record and receipts.
- A handoff becomes available to downstream steps only after the producing step
  has converged and the operator has accepted that step.

That keeps the same human gate as code: unreviewed work does not flow forward.

## Threat model: prompt injection

A handoff is model output that Chit later injects into another model's prompt.
That makes it an explicit prompt-injection channel, even though it flows through
the declared plan.

Validation proves shape: size, JSON parseability, optional schema. It does not
prove that the content is true, safe, or aligned with the operator's goal. The
defense is review and framing:

- The producing step's reviewer must see declared handoff content before the
  step can converge.
- The operator must be able to inspect the full handoff body at the apply gate,
  with preview as the default display, not the only display.
- The consuming step must receive handoff content as untrusted data, never as
  instructions.

Current converge changed-file tracking is not enough by itself. Untracked
non-generated files can appear in `changedFiles`, and generated artifacts can
appear in `workspaceWarnings`, but neither is a typed guarantee that the
reviewer read the declared handoff body. Handoffs need their own review surface.

## Proposed v1 shape

A plan step may declare handoffs it will produce:

```jsonc
{
  "id": "investigate",
  "title": "Find the failing surfaces",
  "body": "Investigate the failure and produce a structured findings handoff.",
  "recipe": "investigate-readonly",
  "handoffs": {
    "findings": {
      "path": "findings.json",
      "format": "json",
      "maxBytes": 65536
    }
  }
}
```

A later step may consume accepted handoffs:

```jsonc
{
  "id": "implement",
  "title": "Fix the selected findings",
  "dependsOn": ["investigate"],
  "consumes": [
    { "step": "investigate", "handoff": "findings", "as": "findings" }
  ],
  "recipe": "deep-feature",
  "body": "Use the findings handoff to implement the fix."
}
```

Field rules:

- `handoffs` is a map from handoff id to a declaration.
- Handoff ids use the same safe id class as plan step ids.
- `path` is relative to the producing step worktree root, must stay inside that
  worktree, and must not be under `.git`.
- `format` is `"json"` in v1.
- `maxBytes` defaults to a conservative cap, such as 64 KiB.
- A consuming step also has a total consumed-handoff budget, so several accepted
  handoffs cannot silently stack into an oversized prompt.
- `consumes` names a producing step, handoff id, and local alias.
- A consumed handoff must come from a declared dependency or transitive
  dependency. No hidden data dependency should bypass `dependsOn`.
- A step may consume only accepted handoffs.

## Lifecycle

1. **Plan dry run.** Chit validates the handoff declarations and consume edges.
   The declarations are bound into the plan approval hash.
2. **Step launch.** The producing step receives deterministic instructions that
   describe every required handoff path and format. The operator's `body`
   remains the main task brief.
3. **Producing-step review.** Before the reviewer returns the verdict for a
   producing step, Chit reads every declared handoff file that exists, validates
   size and JSON parseability, and adds the full declared handoff body to the
   reviewer context. Missing or invalid required handoffs are reviewable facts
   and should block convergence until fixed.
4. **Step convergence.** After the step converges, Chit reads the declared
   handoff files again from the step worktree, verifies size and JSON
   parseability, computes a digest, and records a pending handoff summary and
   content blob on the step.
5. **Apply dry run.** The apply view reports the code diff and pending handoff
   summaries: id, path, format, size, digest, and a bounded preview. It must also
   offer the full body from the same apply gate, so the operator can inspect the
   exact content being accepted without leaving the approval flow.
6. **Apply confirm.** When the operator confirms the step apply, Chit commits
   the code diff to the integration branch and marks the pending handoffs as
   accepted. Accepted handoffs are immutable plan artifacts.
7. **Dependent launch.** Chit injects the consumed accepted handoffs into the
   dependent step prompt through a deterministic untrusted-data envelope, using
   the alias from `consumes`.
8. **Receipts.** `chit_plan_status`, `chit_trace`, and audit receipts show which
   handoffs were produced, accepted, consumed, and by which step.

## Privacy and visibility

The live tower should not stream full handoff bodies by default.

Allowed in live/status views:

- handoff id
- producing step
- consuming step
- format
- size
- digest
- validation status
- bounded preview when explicitly safe for a status surface

Not allowed in the default live tower:

- arbitrary full handoff body
- prompt bodies
- model output bodies
- audit blobs
- environment values

Full bodies belong behind an explicit receipt or audit action, the same way
prompt and output bodies do.

Apply is a special case: the full body must be reachable from the apply gate
because apply is where the operator accepts the payload into downstream prompts.
That does not make full bodies part of the default live tower.

## Approval and drift

The start approval hash binds the handoff declarations, not the future content.
The content does not exist yet.

The content gate is the step apply gate:

- a handoff produced by a converged step is pending until apply confirm
- dependents can consume only accepted handoffs
- if a pending handoff changes between apply dry run and confirm, Chit must
  either refuse the confirm or clearly report the new digest before accepting it
- once accepted, the handoff is immutable in the plan record

This mirrors the existing code flow: unreviewed diffs do not move into the
integration branch, and unaccepted handoffs do not move into dependent prompts.

### Atomicity and recovery

Applying a step spans git state and the plan store, so it cannot be treated as a
single database transaction. The implementation should follow the existing
applied-commit pattern: record enough durable state to recover idempotently if
git commit succeeds but handoff acceptance is interrupted. A retry must not
commit the same diff twice, and it must not expose a dependent step to a handoff
until the accepted digest is recorded.

### Prompt framing

The dependent step envelope must mark consumed handoffs as data from another
agent, not instructions from the operator or Chit. The envelope should include:

- alias
- producing step id
- handoff id
- digest
- format
- body fenced or otherwise clearly delimited as untrusted data

The consuming step's task brief and manifest instructions remain the only
instructions. Handoff content can inform the work, but it must not override the
task, permissions, checks, recipe, or approval gates.

## Schema validation

V1 should require valid JSON and a size cap. That is enough to create a durable,
machine-readable channel without committing to a full schema system.

The next step can add JSON Schema:

- schema is declared inline or by repo-relative schema path
- schema identity and content digest are bound into the approval hash
- Chit validates the produced handoff before apply
- schema validation errors keep the step from becoming ready to apply

Do not hand-roll a partial schema language. If schema validation becomes part of
the runtime, use a proven validator and keep the accepted subset explicit.

## Why not use repo files

A producing step can already write a JSON file and a dependent step can see it if
the operator applies it into the integration branch. That is correct for files
that belong in the repo.

It is the wrong default for investigation results, review findings, or temporary
coordination data. Those are plan artifacts. They should be durable, inspectable,
and digest-addressed, but not necessarily committed to the project.

## Why not use transcripts

Audit transcripts preserve prompts and outputs, but they are not a contract:

- bodies can be large
- bodies can hold secrets
- outputs are not guaranteed to be structured
- downstream prompts would depend on transcript shape
- live Studio would be pressured to expose too much text

Handoffs should be explicit artifacts with bounded size, declared format, and
receipt identity. Transcripts remain evidence.

## Implementation sequence

### Phase 1: parser and approval surface

- Add `handoffs` and `consumes` to plan parsing.
- Validate ids, paths, size caps, JSON-only format, and consume edges.
- Bind declarations into the plan approval hash.
- Update the plan-author prompt and human review rubric.

### Phase 2: producer capture

- Before each producing-step review verdict, read and validate declared handoff
  files and include their full content in the reviewer context.
- At step settle, read declared handoff files from the step worktree.
- Enforce path containment, size cap, and JSON parseability.
- Record pending handoff summaries and content blobs in the plan store.
- Show pending summaries in `chit_plan_status`.

### Phase 3: gated acceptance

- Include pending handoff summaries in plan apply dry run, with preview by
  default and full body available from the same gate.
- On apply confirm, accept the handoffs with the step apply using the recoverable
  ordering defined above.
- Refuse or re-report if content changed between dry run and confirm.
- Keep accepted handoffs available after worktree cleanup.
- Define idempotent recovery for the git-commit-plus-plan-store boundary.

### Phase 4: dependent injection

- Before launching a consuming step, load accepted handoffs from the plan record.
- Enforce the per-step total consumed-handoff byte budget.
- Inject them into the task brief with a deterministic untrusted-data envelope.
- Record the consumed handoff ids and digests on the launched job receipt.

### Phase 5: Studio and receipts

- Show compact handoff chips or rows on the selected plan/run detail.
- Keep full bodies behind receipt/audit actions.
- Add filters for produced, pending, accepted, and consumed.

## Anti-scope

Do not build in v1:

- a general JavaScript workflow engine
- model-decided dynamic routing
- auto-apply based on handoff validation
- arbitrary file passthrough into downstream prompts
- instruction-like handoff framing
- binary handoffs
- unlimited handoff size
- transcript streaming as a handoff mechanism
- schema language invention

## Definition of done

The handoff layer is ready when:

- a reviewed plan can declare a producer and consumer step
- the producer emits a bounded JSON handoff
- Chit records the handoff digest and validation result
- the producing step's reviewer sees the declared handoff content before
  convergence
- the operator sees the handoff summary and can open the full body at the apply
  gate
- the consumer receives the accepted handoff without chat mediation, framed as
  untrusted data
- per-handoff and total-consumed byte budgets are enforced
- receipts say which handoff was produced, accepted, and consumed
- cleanup removes worktrees but leaves handoff receipts available

At that point, Chit can move both code and structured knowledge through a plan
while preserving its runtime contract: declared artifacts, explicit gates,
external checks, and receipts.
