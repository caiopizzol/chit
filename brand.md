---
name: "chit"
tagline: "Stop being the glue between your agents."
version: 1
language: en
---

# chit

## Strategy

### Overview

chit is an open-source runtime for multi-agent workflows. A chit is a small declared file that captures a routine you already run by hand: which agents take part, in what order, what context flows between them, where a validator checks, where you check. The runtime reads the chit and runs it inside your Claude Code or CLI session. You see what is happening. You step in when judgment is required. You stop being the copy-paste layer between two terminals.

chit started as `handoff`, a repo for prototyping multi-agent recipes. It got renamed and rewritten when the real problem came into focus, and the real problem is not framework choice or governance theater. The real problem is that the most useful agent workflows are the ones you already trust enough to run repeatedly, and today you run them by hand.

**What it really does.** chit turns a routine you can describe (Claude proposes, Codex verifies, Claude executes) into a declared file the runtime executes for you. You declare participants, steps, context flow, and permissions. The runtime walks the chit and calls the right agent at each step. The CLI and the Claude Code skill surface call the same runtime with the same chit. The receipt at the end says what ran.

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

**Where chit sits in the stack.** Underneath the agents (Codex, Claude, MCP, whatever ships next). Above bare orchestration primitives ("call this, then that"). Inside the surface you already use (your CLI, Claude Code). Adjacent to chat tools but oriented toward what runs *between* agents, not how one human talks to one agent.

Agent frameworks try to be the way you build the agent. chit assumes you already have the agents. Chat front-ends wire one agent to one human. chit wires agents to each other, under a declared routine, while the human stays in the same shell.

**chit is NOT.**

- **Not a workflow engine.** No cron, no schedulers, no databases, no SaaS connectors. A chit is a file. The runtime reads it.
- **Not an agent framework.** We do not define how agents reason. We define how they hand work to each other.
- **Not a code generator.** Manifests are interpreted, not compiled.
- **Not a dynamic router.** v1 ships static DAGs. Agent-decided handoffs are deferred until a real recipe demands them.
- **Not a vendor.** Codex, Claude, MCP, future agents. Vendor neutrality is the point.
- **Not an AI-powered anything.** The platform is the runtime between agents. The intelligence belongs to the agents. The runtime belongs to chit.

**Competitive landscape (honest).**

- **LangGraph, CrewAI, Microsoft Agent Framework.** Code-first frameworks. Powerful, but the handoff lives inside their code.
- **OpenAI Agents SDK, Swarm.** Make handoff a runtime primitive, but the workflow is tied to the SDK and often decided by the model.
- **Inngest AgentKit.** Durable execution for TypeScript agents. Server-side. Different shape of problem.
- **Microsoft Foundry Declarative Workflows.** Declarative YAML, but locked to the Microsoft 365 ecosystem.
- **Hand-rolled scripts.** Most multi-agent work today is shell scripts and copy-paste. That is what chit is actually replacing.

**Structural differentials.**

- **A chit is a file, not a framework.** Hand-written or generated. Inspectable. Diffable. Forkable.
- **The runtime is thin.** It reads the chit and calls the right agent. It does not decide the workflow.
- **Runs inside your session.** Inside Claude Code, inside your terminal, inside CI. You are not handed off to a hosted service.
- **Multi-vendor by contract.** A chit names the agent abstractly. The adapter does the vendor work. Switching adapters does not change the chit.
- **Inspectable before execution.** ASCII, JSON, Mermaid, HTML. Four views of the same model. If the chit is invalid, the run does not start.
- **Static by design.** No dynamic dispatch in v1. Loops and agent-decided routing wait until a real recipe forces them.
- **Marker-based install lifecycle.** Every install writes a sealed marker. `chit list` and `chit uninstall` operate only on marked installs.
- **Browser-safe core.** Parsing, validation, graph model, registry parsing live in a node-free module. The Studio (when it lands) reuses what the CLI uses.
- **CLI-first. CI-native. Open source.**

**Territory owned.** The thin runtime between your agents. The file you would have written if you had written down the routine.

### Personality

**Archetype.** The Quartermaster played by The Architect. The Architect is the voice: calm, precise, opinionated about structure, dry. The Quartermaster is the role: the one who keeps the file, signs the seal, and tracks what ran. Neither says more than is needed.

**Attributes.** Declared. Inspectable. Plain. Vendor-neutral. Opinionated. Restrained.

**chit IS.**

- A file you can read.
- A runtime that runs inside your session.
- A handoff that survives next week.
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

### Promise

**Core promise.**

- The chit declares the routine.
- The runtime reads the chit.
- The agents run inside your session.
- You step in when judgment is required.
- You don't paste.

**Base message.** chit turns the multi-agent routines you already trust into declared files. The runtime reads the chit and runs the workflow inside your CLI or Claude Code session. You stop being the copy-paste layer.

Keep this paragraph stable across surfaces (README lead, homepage subhead, npm description). When the product story shifts, update this first and propagate.

**Synthesizing phrase.** chit exists so a useful multi-agent routine can be a file.

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

**Litmus test.** If the sentence makes the reader the runtime, rewrite it.

## Voice

### Identity

We are an open-source runtime for multi-agent workflows.

You already have agents. Claude. Codex. Whichever MCP server you brought. Whatever ships next month. You probably already have a routine: one proposes, one verifies, one executes. Today you move context between them by hand, in two or three terminals, by copying and pasting.

We give you a file that captures the routine. We call it a chit.

A chit declares which agents take part, in what order, with what context, under what permissions. The runtime reads the chit and runs the workflow inside your Claude Code or CLI session. You see what is happening. You step in when judgment is needed. The handoffs between agents are not a copy-paste anymore.

We are not an agent framework. We are not a workflow automation platform. We are not a dynamic router. We are not a chat tool. We are not a vendor.

We are the small declared file between your agents.

**Essence.** A thin runtime for multi-agent workflows.

### Tagline & Slogans

**Primary tagline.** Stop being the glue between your agents.

The line that names the pain. It points at the two-terminal copy-paste loop the reader is probably in right now. Use on the homepage hero, launch posts, and any first-impression surface where a reader needs to feel the problem before they understand the mechanism.

**Essence line.** A thin runtime for multi-agent workflows.

The technical line. Use as the GitHub repo description, the subtitle under the logo on a slide, and the line that defines the category for readers who already know what is at stake.

**Alternates.**

- chit, not chat.
- Your two-terminal workflow, in a file.
- Run agents in concert. Step in where it matters.
- Codex, Claude, and your shell, choreographed.

**Slogans for different contexts.**

- "Declare the routine. Read the chit." (How-it-works mode.)
- "Inside your session. Not in your clipboard." (Anti-SaaS positioning.)
- "Read the chit before it fires." (Inspector explainer.)
- "One chit. Many surfaces." (CLI, Claude Code skill, future MCP tool.)
- "Multi-vendor by contract." (Adapter story.)
- "Static by design." (Anti-dynamic-dispatch positioning.)
- "Receipts, not transcripts." (Audit-log mode; secondary, not headline.)

### Manifesto

You opened a second terminal.

Claude on the left.
Codex on the right.

Claude proposes.
You take the answer.
You paste it into Codex.
Codex verifies.
You take that answer back to Claude.
Claude executes.

It works. You found a rhythm that fits the work.

Then you do it again.
And again.
On the next branch. The next branch. The next bug.

You are the glue between two agents.

A chit is what you would write down if you wrote down the routine.

Which agents take part.
In what order.
What context goes with each step.
Where a validator checks.
Where you check.

The runtime reads the chit.
The agents do their work.
The handoffs are no longer a copy-paste.

You step in where it matters.
You don't paste.

chit

### Message Pillars

**The chit is the routine.** A small declared file that captures the multi-agent workflow you already run by hand. Read at every step. Survives next week, next branch, next teammate.

**You should not be the runtime.** The platform handles the handoffs between agents. You handle the moments that need judgment. Stop being the copy-paste layer.

**Runs inside your session.** Inside Claude Code, inside your terminal, inside CI. The runtime does not pull you out of the surface you already use. You see what is happening. You step in when needed.

**Multi-vendor by contract.** Codex, Claude, MCP. The chit names the agent abstractly. The adapter does the vendor wiring. Switching adapters does not change the chit.

**Static by design.** No dynamic dispatch in v1. Multi-agent work is a DAG. Adding loops or agent-decided routing requires a real recipe demanding it. Static is honest. Adaptive is a marketing word until evidence forces it.

**Inspectable before execution.** Four views of the same model: ASCII, JSON, Mermaid, HTML. If the chit is invalid, the run does not start.

**Marker-based lifecycle.** Every install writes a sealed marker. Lifecycle commands operate only on marked installs. Removing a directory placed there by a different tool is not possible.

**Receipts at the end.** The audit log is structured. Which agent, with what input, what output, in what order. Diffable against last week's. Not a chat transcript.

**chit, not chat.** Chat is one agent at a time with you in the middle. A chit takes the middle out.

**Open. Free. MIT. CLI-first. CI-native.** No login. No dashboard. Runs locally. Runs in CI.

### Phrases

- Stop being the glue between your agents.
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
- The agents think. Chit moves the work.

### Social Bios

**LinkedIn.**

chit is an open-source runtime for multi-agent workflows. A chit is a small declared file that captures the routine you already run by hand: which agents take part, in what order, with what context, under what permissions. The runtime reads the chit and runs the workflow inside your Claude Code or CLI session. Codex, Claude, MCP. Multi-vendor by contract. Inspectable before execution. CLI-first, CI-native, MIT.

**X / Twitter.**

Open-source runtime for multi-agent workflows. The chit is the routine: who runs, in what order, with what context. Inside your session. Not in your clipboard. Codex, Claude, MCP. CLI-first. MIT.

**GitHub description.**

A thin runtime for multi-agent workflows. Stop being the glue between your agents.

**Website hero subhead.**

One agent proposes. Another verifies. Another executes. A chit captures the routine in a file the runtime reads. Codex, Claude, MCP, your shell. Choreographed. You step in when judgment matters.

### Tonal Rules

1. Short sentences. Declarative. End on a verb or a noun, not an adjective.
2. Use words a developer would say out loud. No "leverage", "unlock", "empower", "seamless", "holistic", "synergy".
3. Show, don't sell. A code block beats a paragraph. A real CLI transcript beats a screenshot.
4. Second person when teaching. First person plural ("we") only when stating identity.
5. The chit metaphor is structural, not decorative. Use chit / receipt / seal where they earn their place. Do not shake them on top of every paragraph.
6. "AI" is fine. "AI-powered" is forbidden. "Agentic" is forbidden as a marketing adjective.
7. Numbers are concrete. Never "up to X%" or "as much as X".
8. If a sentence could appear on a Salesforce page, rewrite it.
9. Cite when you make a claim. We are early, so be specific about what is shipped and what is not.
10. Don't apologize for being a CLI.
11. Be honest about being pre-v0. "Early" is more credible than "trusted by leading teams".
12. No em dashes. Periods, commas, parentheses, or hyphens only.
13. The keystone contrast is *chit, not chat*. Use the pairing where it teaches. Do not bury it; do not overuse it.

### Identity boundaries

- We are not an agent framework.
- We are not a workflow automation platform.
- We are not a vendor.
- We are not "AI-powered" anything.
- We are not a consultancy that left a CLI behind.
- We are not the agent. We are the file between agents.

### We Say / We Never Say

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
| "The agents think. Chit moves the work." | "Let our orchestration layer handle the complexity." |
| "Honest about being early." | "Trusted by leading teams worldwide." |

### Playfulness

chit is dryly dry. Less playful than Pickled. The wink is the keystone contrast *chit, not chat* and the quiet acknowledgement that you have been the runtime up until now. The metaphor is structural, not seasoning.

Play is allowed in:

- The footer sign-off (e.g., "Read the chit.").
- Empty states (e.g., "No chits installed. Run `chit install <manifest>`.").
- Success states (e.g., "Receipt written.").
- One or two campaign lines per page.

Play is not allowed in:

- The hero tagline.
- Scoring or verdict copy.
- Error states.
- Competitive claims.
- Setup instructions.

Do not turn the product into a chit-themed joke set. If the metaphor competes with the runtime semantics, cut the metaphor.

### Interface Feedback

The CLI verbs stay plain English. The brand vocabulary lives in docs, the inspector, the Studio, and the README. It does not live in the verbs the user types.

**CLI verbs (plain).**

- `chit run <manifest>` — execute a manifest.
- `chit show <manifest>` — render the graph and validation as ASCII / JSON / Mermaid / HTML.
- `chit install <manifest> --as <surface>` — install into a surface (today: claude-skill).
- `chit list` — list installed chits.
- `chit uninstall <name>` — remove a marked install.

The CLI must not say "fire", "send", "drop", "stamp", or "sign". Those are doc and UI words. The CLI says what it does.

**Output grammar.**

- Lead with the command. Show what is scoped (manifest, scope, surface).
- Show validation before output.
- End with one next-action sentence on failure.
- Use the same word for the same state across every surface. Do not alternate between "failed", "errored", and "aborted".

**Verdict labels (consistent across surfaces).**

`installed` / `uninstalled` / `run ok` / `run failed` / `validation failed` / `refused` / `warning`.

**Feedback tone.**

- Concise.
- Name the failed contract by its declared name.
- Show the evidence.
- Give one next action.
- Do not explain the brand in the result.
- Do not use the chit metaphor in error copy.

## Visual

The identity should feel like a small declared file pinned in a quiet shell. Paper, ink, restraint. No accent color. The product is the file and the run, not the chrome.

### Colors

A two-tone system. Paper and ink. No accent color.

| Role | Color | Hex |
|---|---|---|
| Background | Paper | `#F4F2EA` |
| Lifted panel | Sheet | `#EAE5D5` |
| Cards / code blocks | Receipt | `#E0DBC6` |
| Primary text | Ink | `#0A0A0A` |
| Secondary text | Carbon | `#2A2A2A` |
| Faded / disabled | Faded | `#807766` |
| Hairline borders | Hairline | `#C7BFAB` |
| Inverted CLI block (background) | Ink | `#0A0A0A` |
| Inverted CLI block (text) | Inverted Paper | `#F4F1E8` |

Status indicators (pass / warn / fail) are not color-coded. See *Iconography & Status* below.

A dark variant exists for terminals and the future Studio's code view. Marketing surfaces (homepage, docs, README) default to light.

**Avoid.**

- Accent colors. There is no brand red, no brand blue, no brand green. The keystone gets weight from typography, not color.
- Purple / violet "AI" gradients.
- Neon greens (Pickled territory; different brand).
- Corporate-blue dominance.
- Dark-mode default with neon accents.
- Pastel SaaS palettes.
- Chat-bubble shapes anywhere in chrome.

### Typography

- **Display.** Bricolage Grotesque, 600-700. Headlines, hero, section titles, the brand wordmark. Slightly transitional. Reads printed, not Silicon Valley.
- **Body.** Inter, 400-500. Paragraphs, UI copy, docs, navigation.
- **Mono.** JetBrains Mono, 400-600. CLI commands, manifest fields, agent IDs, step names, code snippets, receipt numbers, status labels, document metadata.

Mono is the evidence layer. The receipt number is always mono. The agent name in a chit is always mono. CLI output is always mono.

Sub-section headings (h3) use **mono uppercase with letter-spacing**, not display sans. This is part of the "document tone" — sections feel labeled rather than headlined.

### Iconography & Status

Status uses shape, not color.

- **Pass** — filled circle (●)
- **Warn** — hollow circle (○)
- **Fail** — rotated square / diamond (◆)

The choice is deliberate. Color-coded status is the default. Shape-coded status is restrained, accessible, and consistent with the no-accent palette.

Graph nodes use the same logic:

- **Default node** — solid border
- **Warn state** — dashed border (instead of amber border)
- **Fail state** — diamond corner cut, or rotated label position

The seal indicator is a small filled circle followed by uppercase mono text: `● SEALED 2026-05-28 sha256:abc…`. Use exactly once per page or document. Do not repeat before every code block.

### Photography

Skip photography of people, robots, devices, "AI brain" art. Use:

- Real CLI output. The actual terminal, the actual chit, the actual receipt.
- Code blocks with real manifest files from `examples/`.
- Abstract close-ups of paper, ink, perforations, seal impressions, ledger margins — only as texture, never as the main subject.

**Avoid.**

- Stock photos of "AI" or robots.
- Smiling enterprise team shots.
- Particle-mesh "neural network" art.
- Glowing brain graphics.
- Chat-bubble or message-UI screenshots.
- Restaurant-kitchen imagery (different brand; do not blur into kitchen cosplay).
- People at laptops.

### Style

**Design keywords.** Declared. Inked. Restrained. Compact. CLI-native. Plain. Honest. Pre-v0.

**Reference brands.**

- Linear. Calm precision. Dev-first. Terse copy. Restrained palette.
- Terraform / HashiCorp. Declarative protocol credibility (before the corporate sheen).
- Stripe. Restrained authority. Documentation gravitas.
- Sentry. Dev-tool seriousness. Failure-mode language.
- Cloudflare Workers docs. Dense and clean.
- Pickled. Sibling brand. Same voice register (terse, dry, opinionated, dev-first), different metaphor.

**Anti-references.**

- LangChain. Abstraction churn, framework theater, vocabulary that changes every six months.
- Microsoft Foundry / Copilot Studio. Enterprise taxonomy. AI-mascot energy.
- Generic "Agentic AI Platform" companies. The ones that put "agentic" on every page.
- Salesforce. Trailblazer energy. "Synergy" earnestness. Customer-as-partner language.
- Any product with a chat bubble in the hero.
- Any product with a robot mascot personality.

**Direction.** The identity should feel like a small declared file pinned next to your terminal. Old enough to be trustworthy. Sharp enough to be modern. Quiet enough that the product, not the brand, is the loudest thing on the page. **The CLI is the hero. The chit is the artifact. The receipt is the proof.**

## Naming notes

The wordmark is lowercase `chit` in body copy and `Chit` at sentence-start. The legal name and primary domain are `chitgraph.com`. The CLI shortcut domain is `chit.new` (Google `.new` policy: it must open a creation flow, e.g., "create a new chit" in the future Studio). The execution surface domain is `chit.run` (used for runtime documentation and run-receipt URLs).

The phonetic neighbor *chat* is the most common collocation in English (*chit-chat*). The brand treats this as positioning fuel, not a landmine. We are the opposite of chat. The brand surfaces the contrast deliberately and quietly, with the phrase *chit, not chat* held as the keystone — meaning *declared workflow, not ad-hoc back-and-forth with one agent at a time*.

The metaphor is broader than restaurant. A chit is a small declared written order: a club voucher, a military signed paper, a restaurant order ticket, an IOU, a factory routing slip, a customs slip. Use the example that fits the surface. Do not lean hard on any single industry's vocabulary.

**Heritage acknowledgment.** The codebase started as the `handoff` repo. The brand surface migration is partial:

- *Migrated.* Repo directory (`/personal/handoff` to `/personal/chit`), root README, workspace package names (`chit-workspace`, `chit-cli`, `chit-web`, `@chit/core`), CLI binary name (`chit`), CLI help text and `chit:` stderr prefixes, landing site.
- *Not yet migrated (deliberately deferred).* State paths (`~/.config/handoff/agents.json`, `~/.local/state/handoff/sessions/`), install marker filename (`.handoff-install.json`), and a handful of code comments. Changing these breaks existing local installs and the few tests that assert against them; the brand decision is to do that migration in a single coordinated commit when the v0 cut is ready, so existing local state is invalidated once rather than twice.
- *Source control.* The repo is not yet under git. When it goes under git, the migration commits above become its first real history; pre-rename file moves are not preserved.

**Pickled** is a sibling brand. Same founder, same voice register, different product (agent legibility testing) and different metaphor (preservation). The two should read as *two opinionated dev tools by the same person*, not as a themed series. Do not borrow Pickled's pickle vocabulary in chit copy.

**Status.** Pre-v0. The runtime, CLI, Claude Code skill surface, inspector (ASCII / JSON / Mermaid / HTML), install marker, and safe lifecycle are shipped. Audit log, Studio web UI, MCP surface, and declared human-checkpoint steps are not. Brand copy should match what is shipped; do not promise what is not.
