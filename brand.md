---
name: "chit"
tagline: "Stop being the glue between your agents."
version: 2
language: en
---

# chit

## Strategy

### Overview

chit is an open-source runtime for multi-agent workflows. A chit is a small declared file that captures a routine you already run by hand: which agents take part, in what order, what context flows between them, where a validator checks, where you check. The runtime reads the chit and runs the workflow inside your Claude Code or CLI session. You see what is happening. You step in when judgment is needed. You stop being the copy-paste layer between two terminals.

chit started life as the `handoff` repo for prototyping multi-agent recipes. It got renamed and rewritten when the real problem came into focus, and the real problem is not framework choice and not governance theater. The real problem is smaller and more useful: the multi-agent routines that actually work are the ones you already trust enough to run again, and today you run them by hand.

**What it really does.** chit turns a routine you can describe ("Claude proposes, Codex verifies, Claude executes") into a declared file the runtime executes for you. You declare participants, steps, context flow, and permissions. The runtime walks the chit and calls the right agent at each step. The CLI and the Claude Code skill call the same runtime with the same chit. The output at the end shows what ran.

**The problem.** You opened a second terminal. Then a third. Claude on one side, Codex on another. You found a working rhythm: one agent proposes, another verifies, the first executes. The rhythm is useful. The rhythm is not portable. It does not survive next week, the next branch, or a teammate's machine. It also does not scale beyond what your fingers can keep up with.

Each kind of breakage has a name:

- **Copy-paste fatigue.** The handoff context lives in your clipboard, not in a file.
- **Workflow amnesia.** You remember the routine while it is fresh and forget the third time you need it.
- **Re-explained context.** Each new terminal session starts with you summarizing what already happened.
- **Lossy verification.** The validator does not have full context because you only pasted a slice.
- **Unrepeatable success.** It worked once. It would work again if you could write down what it was.

Generic agent frameworks (LangGraph, CrewAI, Microsoft Agent Framework) ask you to express the workflow in code. The OpenAI Agents SDK ships handoff as a runtime primitive but ties the workflow to its SDK. chit asks the smaller question: can the workflow be a file the runtime executes, in any session, against whichever agents you brought?

**Transformation.** Before: a multi-agent routine that lives in your head, your clipboard, and three terminals. After: a chit. The same routine, declared once, run inside your session, with you in the loop where it matters.

**Long-term ambition.** Become the thin runtime that turns the agent workflows you already trust into declared runs you can inspect, repeat, share, and interrupt.

### Positioning

**Category.** A thin runtime for multi-agent workflows.

**Where chit sits in the stack.** Underneath the agents (Codex, Claude, MCP, whatever ships next). Above bare orchestration primitives. Inside the surface you already use (your CLI, Claude Code). Adjacent to chat tools, but oriented toward what runs *between* agents, not how one human talks to one.

Agent frameworks try to be the way you build the agent. chit assumes you already have the agents. Chat front-ends wire one agent to one human. chit wires agents to each other, under a declared routine, while the human stays in the same shell.

**The keystone contrast.** *Chit, not chat.* Chat is one agent at a time with you in the middle, holding the thread. A chit takes the middle out: the routine is declared in a file, the runtime moves the work, you step in where it matters. This is the spine of the brand. It is not the tagline. It is the line everything else has to be consistent with.

**chit is NOT.**

- Not a workflow engine. No cron, no schedulers, no databases, no SaaS connectors. A chit is a file. The runtime reads it.
- Not an agent framework. We do not define how agents reason. We define how they hand work to each other.
- Not a code generator. Manifests are interpreted, not compiled.
- Not a dynamic router. v1 ships static DAGs. Agent-decided handoffs are deferred until a real recipe demands them.
- Not a vendor. Codex, Claude, MCP, future agents. Vendor neutrality is the point.
- Not an "AI-powered" anything. The platform is the runtime between agents. The intelligence belongs to the agents.
- Not a governance product. We make routines repeatable. We are not selling compliance.

**Competitive landscape.**

- **LangGraph, CrewAI, Microsoft Agent Framework.** Code-first frameworks. Powerful, but the handoff lives inside their code.
- **OpenAI Agents SDK, Swarm.** Make handoff a runtime primitive, but the workflow is tied to the SDK and often decided by the model.
- **Inngest AgentKit.** Durable execution for TypeScript agents. Server-side. Different shape of problem.
- **Microsoft Foundry Declarative Workflows.** Declarative YAML, but locked to the Microsoft 365 ecosystem.
- **brine.ai.** Adjacent: cryptographic identity and immutable audit for regulated agent workflows. We share the declared-artifact instinct; we are not a regulated-platform play.
- **Hand-rolled scripts.** Most multi-agent work today is shell scripts and copy-paste. That is what chit is actually replacing.

**Structural differentials.**

- **A chit is a file, not a framework.** Hand-written or generated. Inspectable. Diffable. Forkable.
- **The runtime is thin.** It reads the chit and calls the right agent. It does not decide the workflow.
- **Runs inside your session.** Inside Claude Code, inside your terminal, inside CI. You are not handed off to a hosted service.
- **Multi-vendor by contract.** A chit names the agent abstractly. The adapter does the vendor work. Switching adapters does not change the chit.
- **Inspectable before execution.** ASCII, JSON, Mermaid, HTML. Four views of the same model. If the chit is invalid, the run does not start.
- **Static by design.** No dynamic dispatch in v1. Loops and agent-decided routing wait until a real recipe forces them.
- **Marker-based install lifecycle.** Every install writes a sealed marker. `chit list` and `chit uninstall` operate only on marked installs.
- **Browser-safe core.** Parsing, validation, graph model, registry parsing live in a node-free module. The Studio reuses what the CLI uses.
- **CLI-first. CI-native. Open source.**

**Territory owned.** The declared routine between your agents. The small written file you would have produced if you had written down the multi-agent workflow that already works for you.

### Personality

**Archetype.** The Architect, playing the Quartermaster. The Architect is the voice: calm, precise, opinionated about structure, dry. The Quartermaster is the role: the person who keeps the file, issues the supplies in the order written, marks what went out. The Quartermaster is not a magistrate. We track the routine. We do not enforce the law.

**Attributes.** Declared. Inspectable. Plain. Vendor-neutral. Opinionated. Restrained.

**chit IS.**

- A file you can read.
- A runtime that runs inside your session.
- A routine that survives next week.
- Multi-vendor by contract.
- Static by design.
- Honest about being early.
- Open source.

**chit is NOT.**

- An agent framework.
- A workflow automation platform.
- A SaaS dashboard.
- A chat tool.
- A vendor pitch.
- A "magic agentic" anything.
- A consultancy with a CLI bolted on.
- A compliance product wearing a CLI.

### Promise

**Core promise.**

- The chit declares the routine.
- The runtime reads the chit.
- The agents run inside your session.
- You step in when judgment is required.
- You don't paste.

**Base message.** chit turns the multi-agent routines you already trust into declared files. The runtime reads the chit and runs the workflow inside your CLI or Claude Code session. You stop being the copy-paste layer.

Keep this paragraph stable across surfaces (README lead, homepage subhead, npm description, GitHub social card). When the product story shifts, update this paragraph first and propagate.

**Synthesizing phrase.** chit exists so the multi-agent routine you already trust can be a file.

### Guardrails

**Tone summary.** Precise. Compact. Dry. Plain. Opinionated. Honest about being early.

**chit cannot be.**

- A "build agents in minutes" pitch.
- An "agentic platform" hype piece.
- Enterprise procurement copy.
- A vendor lock-in story.
- A chat product.
- A framework that asks the user to learn a new programming model.
- A SaaS dashboard wrapped around someone else's API.
- A compliance pitch.

**Litmus test.** If the sentence makes the reader the runtime, rewrite it.

## Voice

### Identity

We are an open-source runtime for multi-agent workflows.

You already have agents. Claude. Codex. Whichever MCP server you brought. Whatever ships next month. You probably already have a routine: one proposes, one verifies, one executes. Today you move context between them by hand, in two or three terminals, by copying and pasting.

We give you a file that captures the routine. We call it a chit.

A chit declares which agents take part, in what order, with what context, under what permissions. The runtime reads the chit and runs the workflow inside your Claude Code or CLI session. You see what is happening. You step in when judgment is needed. The handoffs between agents are not a copy-paste anymore.

We are not an agent framework. We are not a workflow automation platform. We are not a dynamic router. We are not a chat tool. We are not a vendor. We are not a governance product.

We are the small declared file between your agents.

**Essence.** A thin runtime for multi-agent workflows.

### Tagline & Slogans

**Primary tagline (homepage hero, GitHub social card, README opener).** Stop being the glue between your agents.

The line that names the pain. It points at the two-terminal copy-paste loop the reader is probably in right now. Use on the homepage hero, launch posts, and any first-impression surface where a reader needs to feel the problem before they understand the mechanism.

**Essence line (subhead, repo description, slide label).** A thin runtime for multi-agent workflows.

The technical line. Use as the GitHub repo description, the subtitle under the logo on a slide, and the line that defines the category for readers who already know what is at stake.

**Keystone contrast.** *Chit, not chat.*

This is the strategic spine, not the headline. It earns its weight by appearing exactly where the contrast does the most work, and nowhere else.

Allowed surfaces:

- Homepage: the keystone section that explains the difference. Once.
- README: one paragraph after the opener.
- Studio empty state and onboarding: where a first-time user is about to learn what a chit is.
- Launch posts: one line, used as the turn.

Forbidden surfaces:

- The tagline itself.
- Studio chrome (header, nav, button labels, status bar).
- CLI output of any kind.
- Error messages.
- Documentation body copy beyond the keystone explainer.

Held back is the way the line stays sharp. Repeated everywhere, it becomes wallpaper.

**Alternates (use sparingly, never replace the primary).**

- Your two-terminal workflow, in a file.
- Run agents in concert. Step in where it matters.
- Codex, Claude, and your shell, choreographed.

**Slogans for different contexts.**

- "Declare the routine. Read the chit." (How-it-works mode.)
- "Inside your session. Not in your clipboard." (Anti-SaaS positioning.)
- "Read the chit before it fires." (Inspector explainer.)
- "One chit. Many surfaces." (CLI, Claude Code skill, MCP.)
- "Multi-vendor by contract." (Adapter story.)
- "Static by design." (Anti-dynamic-dispatch positioning.)
- "Receipts, not transcripts." (Audit-log mode. Secondary. Never headline.)

### Manifesto

The manifesto is a field note. It is restrained. It does not sing. It lives in `brand.md`. The homepage, README, and product surfaces do not depend on it.

---

Field note. 2026.

Two terminals open. Claude on the left. Codex on the right.

You ask Claude to draft. You copy the draft.
You paste the draft into Codex. You ask Codex to check the draft.
You copy the check. You paste the check back into Claude.
You ask Claude to apply the check.

It works.

You do it again on the next branch. You do it again on the next bug.
You start a third terminal. You start a fourth.
You forget which terminal has which context. You re-explain to one of them.
The routine survives in your hands. It does not survive on disk.

The routine has a shape.
Two participants. One step that proposes. One step that verifies. One step that executes.
Inputs flow forward. The output of the verifier is read by the executor.
Permissions differ per participant. The proposer can read. The executor can write.

You could write this shape down.

If you wrote it down, the runtime could read it, call the right agent at each step, pass the context the chit declares, refuse to start if the chit is invalid, and write down at the end which agent ran with what input and produced what output.

You would not be the runtime anymore.

You would be the person who declared the routine, and who steps in where the chit asks for judgment.

The agents already think.

chit moves the work.

---

End note.

### Message Pillars

**The chit is the routine.** A small declared file that captures the multi-agent workflow you already run by hand. Read at every step. Survives next week, next branch, next teammate.

**You should not be the runtime.** The platform handles the handoffs between agents. You handle the moments that need judgment. Stop being the copy-paste layer.

**Runs inside your session.** Inside Claude Code, inside your terminal, inside CI. The runtime does not pull you out of the surface you already use. You see what is happening. You step in when needed.

**Multi-vendor by contract.** Codex, Claude, MCP. The chit names the agent abstractly. The adapter does the vendor wiring. Switching adapters does not change the chit.

**Static by design.** No dynamic dispatch in v1. Multi-agent work that holds up is a DAG. Adding loops or agent-decided routing waits for a real recipe. Static is honest. Adaptive is a marketing word until evidence forces it.

**Inspectable before execution.** Four views of the same model: ASCII, JSON, Mermaid, HTML. The CLI and the Studio share one render. If the chit is invalid, the run does not start.

**Marker-based lifecycle.** Every install writes a sealed marker. Lifecycle commands operate only on marked installs. Removing a directory placed there by a different tool is not possible.

**Receipts at the end.** Shipped. An audited run leaves a structured trail: which agent, with what input, what output, in what order, with token usage. Readable via `chit audit` and the Studio audit view. Evidence, not law.

**Chit, not chat.** Chat is one agent at a time with you in the middle. A chit takes the middle out. Strategic spine; use sparingly.

**Open. Free. MIT. CLI-first. CI-native.** No login. No dashboard. Runs locally. Runs in CI.

### Phrases

- Stop being the glue between your agents.
- A thin runtime for multi-agent workflows.
- chit, not chat.
- A chit is what you would write down if you wrote down the routine.
- The runtime reads the chit. You don't paste.
- Inside your session. Not in your clipboard.
- One chit. Many surfaces.
- Multi-vendor by contract.
- Static by design.
- Read the chit before it fires.
- Receipts, not transcripts.
- A chit is a file, not a framework.
- The agents think. chit moves the work.

### Playfulness

chit is dryly serious. Less playful than Pickled. The wink is the keystone contrast (*chit, not chat*) and the quiet acknowledgement that you have been the runtime up until now. The chit metaphor is structural, not seasoning.

Play is allowed in:

- The footer sign-off ("Read the chit.").
- Empty states ("No chits installed. Run `chit install <manifest>`.").
- One or two campaign lines per page.

Success and status copy stays plain. See *Interface Feedback* for the exact verdict labels.

Play is not allowed in:

- The hero tagline.
- Verdict or status copy.
- Error states.
- Competitive claims.
- Setup instructions.

Do not turn the product into a chit-themed joke set. If the metaphor competes with the runtime semantics, cut the metaphor.

### Interface Feedback

Every surface uses the same feedback grammar: CLI, Claude Code skill output, Studio chrome, the MCP surface, the audit log. The surface can change. The message should not.

**CLI verbs (plain).** The CLI uses plain English. Brand vocabulary lives in docs, the inspector, the Studio, and the README. It does not live in the verbs the user types.

- `chit run <manifest>` - execute a manifest.
- `chit show <manifest>` - render the graph and validation as ASCII / JSON / Mermaid / HTML.
- `chit install <manifest> --as <surface>` - install into a surface (today: claude-skill).
- `chit list` - list installed chits.
- `chit uninstall <name>` - remove a marked install.

The CLI must not use the verbs "fire", "send", "drop", "stamp", or "sign". Those are doc and UI words. The CLI says what it does.

**Default output structure.**

Items 1-3 describe the run-feedback grammar. Item 4, the receipt, is recorded to the audit log and read with `chit audit` or the Studio audit view; it is not printed inline by `chit run`. Item 5 is the target shape: a failed run names the failed step and the error today, not yet a one-line next action.

1. Command and scope (manifest, surface, scope where relevant).
2. Validation result.
3. Step-by-step run output, in declared order.
4. Receipt: which agent, with what input, what output, what status, with token usage. *(Recorded to the audit log; read via `chit audit`, not inline.)*
5. One next-action sentence on failure.

**Status labels (consistent across surfaces).** Use the same word for the same state on the CLI, in the Studio, and in the audit log.

- `installed` / `uninstalled`
- `run ok` / `run failed`
- `validation passed` / `validation failed`
- `needs override` (a participant requires a permission the adapter cannot enforce)
- `refused` (the runtime declined to start)
- `warning` (validation passed with caveats)

Do not alternate between "failed", "errored", and "aborted" for the same state. Pick one and use it everywhere.

**Verdict layers.** chit has two verdicts. They are orthogonal. Renderers must not conflate them.

- **Validation verdict** answers whether the chit is well-formed and can run on the requested surface. Values: `valid`, `needs override`, `invalid`. Determines whether a run can start.
- **Run verdict** answers whether the run reached its declared output. Values: `run ok`, `run failed`. Determines whether the receipt is a success or a failure.

A chit with `needs override` validation can still run if the user explicitly accepts the override. A chit with `invalid` validation cannot.

**Feedback tone.**

- Concise.
- Name the failed contract by its declared name (the step, the participant, the permission).
- Show the evidence.
- Give one next action.
- Do not explain the brand in the result.
- Do not use the chit metaphor in error copy.

**Good terminal copy.**

```text
chit run apps/cli/examples/consult.json --question "Is this migration safe?"

manifest: consult
participants: codex, claude
validation: valid

[1/3] ask_codex   ● ok
[2/3] ask_claude  ● ok
[3/3] out         ● ok

run ok.
```

### Release Notes

Release notes are a public surface. Same grammar as the CLI: short, specific, no marketing voice.

**Section names.** Use only `What's New`, `Fixes`, `Improvements`, and `Breaking Changes`. Do not invent grouping headers like `Under the Hood`, `Other`, `Miscellaneous`, or `Behind the Scenes`. If a change does not fit one of the four, ask whether it belongs in the notes at all.

**Bullet shape.** One sentence per change. Lead with what changed for the user, not the implementation. Bold the feature name. Use a hyphen, never an em dash, to join the name and the description.

**Nouns.** Use the repo's actual terms: `chit` (not `manifest file`), `participant` (not `agent role`), `step` (not `node` or `stage`), `surface` (not `target` or `integration`), `receipt` (not `log entry`), `install marker` (not `sentinel` or `state file`), `validation` (not `lint`), `adapter` (not `provider`).

**Honesty constraints.** No absolutes. A test `catches a regression in step ordering`; it does not `guarantee correctness`. A guard `prevents drift between CLI and Studio`; it does not `eliminate drift`. If a change is docs-only, say so. If a dependency upgrade required no code changes, say so plainly.

**Skip.** Version bumps. CI tweaks that affect no user behavior. Code that exists only in proposals or drafts.

**Good release-notes copy.**

```markdown
### What's New

- **Studio inspector** - Browser-side viewer for any chit on disk. Renders ASCII, JSON, Mermaid, and HTML from the shared core, with path-traversal guarding.
- **Install marker lifecycle** - `chit install` writes a sealed marker; `chit list` and `chit uninstall` operate only on marked installs.

### Improvements

- **Browser-safe core boundary** - Parsing, validation, graph model, and the show renderer moved into `@chit/core` with no node imports. CI verifies the boundary.
- **Path resolution from workspace root** - Studio resolves relative paths from the workspace root, not the launch cwd, so quick-links work regardless of how Studio was started.

### Fixes

- **Quick-link 400** - Canonical example links no longer return 400 when Studio is launched via the root `--filter` script.
```

### Social Bios

**LinkedIn.**

chit is an open-source runtime for multi-agent workflows. A chit is a small declared file that captures the routine you already run by hand: which agents take part, in what order, with what context, under what permissions. The runtime reads the chit and runs the workflow inside your Claude Code or CLI session. Codex, Claude, MCP. Multi-vendor by contract. Inspectable before execution. CLI-first, CI-native, MIT.

**X / Twitter.**

Open-source runtime for multi-agent workflows. The chit is the routine: who runs, in what order, with what context. Inside your session. Not in your clipboard. Codex, Claude, MCP. CLI-first. MIT.

**GitHub repo description.**

A thin runtime for multi-agent workflows. Stop being the glue between your agents.

**Website hero subhead.**

One agent proposes. Another verifies. Another executes. A chit captures the routine in a file the runtime reads. Codex, Claude, MCP, your shell. Choreographed. You step in when judgment matters.

### Tonal Rules

1. Short sentences. Declarative. End on a verb or a noun, not an adjective.
2. Use words a developer would say out loud. No "leverage", "unlock", "empower", "seamless", "holistic", "synergy".
3. Show, don't sell. A code block beats a paragraph. A real CLI transcript beats a screenshot.
4. Second person when teaching. First person plural ("we") only when stating identity.
5. The chit metaphor is structural, not decorative. Use chit / receipt / seal where they earn their place. Do not shake them on top of every paragraph.
6. "AI" is fine. "AI-powered" is forbidden. "Agentic" is forbidden as a marketing adjective. "Control plane" is forbidden unless quoting someone else.
7. Numbers are concrete. Never "up to X%" or "as much as X".
8. If a sentence could appear on a Salesforce page, rewrite it.
9. Cite when you make a claim. We are early, so be specific about what is shipped and what is not.
10. Don't apologize for being a CLI.
11. Be honest about being pre-v0. "Early" is more credible than "trusted by leading teams".
12. No em dashes anywhere. Periods, commas, parentheses, or hyphens only.
13. The keystone contrast is *chit, not chat*. Use it where the contrast teaches. Do not bury it; do not overuse it. It is the spine, not the headline.
14. Do not pitch governance. We make routines repeatable. Receipts are evidence, not law.

**Identity boundaries.**

- We are not an agent framework.
- We are not a workflow automation platform.
- We are not a vendor.
- We are not "AI-powered" anything.
- We are not a consultancy that left a CLI behind.
- We are not a compliance product.
- We are not the agent. We are the file between agents.

**We Say / We Never Say.**

| We Say | We Never Say |
|---|---|
| "Stop being the glue between your agents." | "Unlock seamless agent orchestration." |
| "A chit is the routine you would write down." | "Build autonomous workflows in minutes." |
| "A thin runtime for multi-agent workflows." | "An AI-powered control plane for your agent workforce." |
| "Inside your session. Not in your clipboard." | "Real-time collaborative agent intelligence." |
| "Multi-vendor by contract." | "Best-in-class LLM agnosticism." |
| "Static by design." | "Adaptive routing that learns." |
| "Read the chit before it fires." | "Trust the system to choose intelligently." |
| "Receipts, not transcripts." | "Conversational audit trail." |
| "The agents think. chit moves the work." | "Let our orchestration layer handle the complexity." |
| "Honest about being early." | "Trusted by leading teams worldwide." |
| "chit, not chat." | "Chat with your agents about your work." |

## Visual

The identity is paper-and-ink. Default surfaces (homepage, docs, README, Studio) are warm paper with black ink. Terminal-dark is reserved for terminal blocks, code examples, and CLI transcripts. The Studio is paper, not split. The product is the file and the run, not the chrome.

### Colors

A two-tone system. Paper and ink. No accent color.

| Role | Color | Hex |
|---|---|---|
| Background | Paper | `#F4F2EA` |
| Lifted panel | Sheet | `#EAE5D5` |
| Cards / inline code blocks | Receipt | `#E0DBC6` |
| Primary text | Ink | `#0A0A0A` |
| Secondary text | Carbon | `#2A2A2A` |
| Faded / disabled | Faded | `#807766` |
| Hairline borders | Hairline | `#C7BFAB` |
| Inverted block background | Ink | `#0A0A0A` |
| Inverted block text | Inverted Paper | `#F4F1E8` |

Inverted blocks (Ink-on-Paper inverted) are reserved for embedded CLI transcripts, full terminal screenshots, and dedicated code examples. They are not used for chrome, panels, or marketing emphasis.

Status indicators (pass / warn / fail) are not color-coded. See **Iconography & Status** below.

**Avoid.**

- Accent colors. There is no brand red, no brand blue, no brand green. The keystone gets weight from typography and restraint, not color.
- Purple / violet "AI" gradients.
- Neon greens (Pickled territory; different brand).
- Corporate-blue dominance.
- Dark-mode default. Paper is the default. A dark preference can ship later as a preference; it is not the brand surface.
- Pastel SaaS palettes.
- Chat-bubble shapes anywhere in chrome.

### Typography

- **Display.** Bricolage Grotesque, 600-700. Headlines, hero, section titles, the wordmark. Slightly transitional. Reads printed, not Silicon Valley.
- **Body.** Inter, 400-500. Paragraphs, UI copy, docs, navigation.
- **Mono.** JetBrains Mono, 400-600. CLI commands, manifest fields, agent IDs, step names, code snippets, receipt numbers, status labels.

Mono is the evidence layer. The receipt number is always mono. The agent name in a chit is always mono. CLI output is always mono. Status labels are always mono.

Subsection headings (h3 and below) use **mono uppercase with letter-spacing**, not display sans. This is part of the document tone: sections feel labeled rather than headlined, like fields on a form.

### Iconography & Status

Status uses shape, not color.

- **Pass** - filled circle (●)
- **Warn** - hollow circle (○)
- **Fail** - rotated square / diamond (◆)

The choice is deliberate. Color-coded status is the default everywhere; shape-coded status is restrained, accessible, and consistent with the no-accent palette. The CLI, the Studio, and the audit log all use the same shapes.

Graph nodes (Studio, Mermaid, ASCII) use the same logic:

- **Default node** - solid border.
- **Warn state** - dashed border.
- **Fail state** - diamond corner cut or rotated label position.

The seal indicator is a small filled circle followed by uppercase mono text: `● SEALED 2026-05-28 sha256:abc…`. Use exactly once per page or document. Do not repeat before every code block.

### Photography

Skip photography of people, robots, devices, and "AI brain" art. Use:

- Real CLI output. The actual terminal, the actual chit, the actual receipt.
- Code blocks with real manifest files from `apps/cli/examples/`.
- Abstract close-ups of paper, ink, perforations, seal impressions, ledger margins, only as texture, never as the main subject.

**Avoid.**

- Stock photos of "AI" or robots.
- Smiling enterprise team shots.
- Particle-mesh "neural network" art.
- Glowing brain graphics.
- Chat-bubble or message-UI screenshots.
- Restaurant-kitchen imagery. The chit metaphor covers club voucher, military signed paper, restaurant order ticket, IOU, factory routing slip, and customs slip. Do not collapse into kitchen cosplay.
- People at laptops, hands on keyboards.

### Style

**Design keywords.** Declared. Inked. Restrained. Compact. CLI-native. Plain. Honest. Pre-v0.

**Reference brands.**

- Linear. Calm precision. Dev-first. Terse copy. Restrained palette.
- Terraform / HashiCorp. Declarative protocol credibility (before the corporate sheen).
- Stripe. Restrained authority. Documentation gravitas.
- Sentry. Dev-tool seriousness. Failure-mode language that names real things.
- Cloudflare Workers docs. Dense and clean.
- Pickled. Sibling brand. Same voice register (terse, dry, opinionated, dev-first), different metaphor and different palette.

**Anti-references.**

- LangChain. Abstraction churn. Framework theater. Vocabulary that changes every six months.
- Microsoft Foundry / Copilot Studio. Enterprise taxonomy. AI-mascot energy.
- Generic "Agentic AI Platform" companies. The ones that put "agentic" on every page.
- Salesforce / Einstein. Trailblazer energy. "Synergy" earnestness. Robot-mascot energy. Customer-as-partner language.
- Any product with a chat bubble in the hero.
- Any product with a robot mascot personality.
- Brigade / kitchen-cosplay branding. chit is broader than restaurant; keep food references restrained.

**Direction.** The identity should feel like a small declared file pinned next to your terminal. Old enough to be trustworthy. Sharp enough to be modern. Quiet enough that the product, not the brand, is the loudest thing on the page. **The CLI is the hero. The chit is the artifact. The receipt is the proof.**

## Naming notes

The wordmark is lowercase `chit` in body copy and `Chit` at sentence-start. The brand domain is `chit.run` (acquired 2026-05-28). The landing site, runtime documentation, and any future run-receipt URLs all live there. `chit.new` is a reserved candidate for the future Studio creation flow (Google `.new` policy requires the URL to open a creation action, e.g., "create a new chit"); it is not yet acquired, and public copy should not depend on it.

The phonetic neighbor *chat* is the most common collocation in English (*chit-chat*). The brand treats this as positioning fuel, not a landmine. We are the opposite of chat. The brand surfaces the contrast deliberately and sparingly with the keystone *chit, not chat*: declared routine, not ad-hoc back-and-forth with one agent at a time.

The metaphor is broader than restaurant. A chit is a small declared written order: a club voucher, a military signed paper, a restaurant order ticket, an IOU, a factory routing slip, a customs slip. Use the example that fits the surface. Do not lean hard on any single industry's vocabulary.

**Heritage acknowledgment.** The codebase started as the `handoff` repo. This is acknowledged once, here in `brand.md`, and in the changelog at the rename commit. The homepage and README open as chit. Public copy does not lead with the old name. The repo history is the public record.

Migration status:

- *Migrated.* Repo directory (`/personal/handoff` → `/personal/chit`), root README, workspace package names (`chit-workspace`, `@chit/cli`, `@chit/site`, `@chit/core`), CLI binary name (`chit`), CLI help and stderr prefixes, landing site and docs.
- *Migrated at the v0 cut.* State and config paths (`~/.config/chit/agents.json`, `~/.local/state/chit/sessions/`, `~/.local/state/chit/audit/`) and the install marker (`.chit-install.json`). chit reads and writes only the `chit` names; the old `handoff` paths and `.handoff-install.json` are no longer read, so local state from before the cut must be moved to the `chit` paths to stay visible. Historical artifacts (`proposals/`, receipts, `dogfood/`) keep the `handoff` name on purpose: they record when the project was called handoff.

**Pickled** is a sibling brand. Same founder, same voice register, different product (agent legibility testing) and different metaphor (preservation). They should read as *two opinionated dev tools by the same person*, not as a themed series. Do not borrow Pickled's pickle vocabulary in chit copy. Do not borrow chit's paper-and-ink palette in Pickled copy.

**Status.** Pre-v0. Shipped: the runtime, CLI, Claude Code skill surface, MCP stepwise surface, inspector (ASCII / JSON / Mermaid / HTML), Studio (graph editor + read-only Loops view + audit transcript view), the convergence log, the supervised and autonomous implement/check loops, the audit log (full prompt/output transcripts on all three run surfaces, with retention, readable via `chit audit` and Studio), preservation of both adapters' observable event streams (Codex JSONL and Claude stream-json) as audit events on audited runs, the install marker, and safe lifecycle. Not shipped: declared human-checkpoint or loop steps inside manifests; MCP client-facing output streaming (a live token stream to the client). Adapter events are surfaced live as they arrive, recorded with real arrival timestamps on audited runs, and are the observable CLI event stream, never hidden model reasoning. Brand copy must match what is shipped. Do not promise what is not.
