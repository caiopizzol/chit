# chit

[![npm version](https://img.shields.io/npm/v/@chit-run/cli.svg)](https://www.npmjs.com/package/@chit-run/cli)

Chit is a thin local runtime for multi-model agent workflows.

You declare a routine. Chit resolves the models, runs each step, passes context forward, checks the result, and writes a receipt. There are no built-in roles like implementer, reviewer, planner, griller, or goal. Those are names and prompts you define.

Website: https://chit.run
<br/>
Docs: https://chit.run/docs

## Get started

Chit shells out to the agent CLIs you already use, so install at least one (`claude`, `codex`, or `gemini`). Then:

```sh
bun add -g @chit-run/cli
cd /path/to/your-project
chit init implement --template loop
chit run implement --input task="add a --version flag"
chit apply <run-id>
```

`chit init` writes `chit.config.json`. Replace the placeholder check with your real command, such as `bun test`. Full walkthrough: [chit.run/docs](https://chit.run/docs).

## The Config Model

`chit.config.json` has two main sections:

- `profiles`: local adapter/model bindings, such as Claude, Codex, or Gemini.
- `routines`: declared workflows made of agents, steps, optional loops, checks, and limits.

```json
{
	"profiles": {
		"claude": "claude",
		"codex": "codex"
	},
	"routines": {
		"implement": {
			"input": "task",
			"agents": {
				"builder": { "profile": "claude", "instructions": "Implement the smallest correct change.", "filesystem": "read-write" },
				"reviewer": { "profile": "codex", "instructions": "Review the diff. Return JSON only.", "filesystem": "read-only" }
			},
			"steps": [
				{ "id": "build", "call": "builder", "prompt": "{{ inputs.task }}" },
				{
					"id": "review",
					"call": "reviewer",
					"prompt": "{{ diff }}",
					"json": {
						"schema": {
							"type": "object",
							"required": ["passed", "issues"],
							"properties": {
								"passed": { "type": "boolean" },
								"issues": { "type": "array", "items": { "type": "string" } }
							}
						}
					}
				},
				{ "id": "verify", "check": "bun test" }
			],
			"repeat": {
				"until": { "all": ["checks-pass", { "step": "review", "path": "passed", "equals": true }] },
				"maxIterations": 3
			}
		}
	}
}
```

The routine above runs until both signals pass: the deterministic check and the structured model review.

## How Chit Runs

Chit derives behavior from the routine shape. You do not choose a separate policy.

| Routine shape | Runtime behavior |
|---|---|
| read-only calls and formats | text run in the current directory |
| `routine` steps | flow that passes outputs forward |
| `repeat` | loop until the stop condition is met |
| checks or read-write agents | disposable git worktree sandbox |

Sandboxed runs are dry-run by default. They produce a patch and stop. Review the receipt, then apply the exact patch:

```sh
chit run implement --input task="add a version command"
chit trace --full run-a1b5efea
chit apply run-a1b5efea
```

## Patterns To Copy

These are normal routines, not built-in modes.

| Pattern | Chit example | Related pattern |
|---|---|---|
| Grill before planning | `examples/feature-griller.json` | [Matt Pocock `grill-me`](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md) |
| Goal loop | `examples/goal.json` | [Claude `/goal`](https://code.claude.com/docs/en/goal), [Claude `/loop`](https://code.claude.com/docs/en/scheduled-tasks), [Codex Goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) |
| Multi-model panel | `examples/panel-review.json` | [OpenRouter Fusion](https://openrouter.ai/docs/guides/features/server-tools/fusion) |
| Build and review loop | `examples/implementation-review.json` | One model builds, another reviews, checks gate the result |

## Commands

```sh
chit init [name]                  # create a starter routine
chit doctor [--real]              # validate config and local tools
chit routines                     # list routines and derived kinds
chit inspect <routine>            # show what will run
chit run <routine> --input k=v    # run a routine
chit runs                         # list past runs
chit trace <run-id> [--full]      # inspect a receipt
chit apply <run-id>               # apply a stored dry-run patch
chit cleanup                      # remove stale sandboxes
```

## Develop Chit

To work on Chit itself, clone and run from source:

```sh
git clone https://github.com/caiopizzol/chit
cd chit && bun install
cd packages/cli
bun run src/index.ts routines
bun run src/index.ts run feature-griller --input idea="add dark mode"
bun test
```

## Boundaries

- Chit is local and CLI-first. It shells out to installed agent CLIs.
- Profiles are local bindings. Routines stay reusable.
- Checks are arbitrary commands, so any routine with a check runs in a sandbox.
- Receipts under `.chit/runs` store inputs, final outputs, verdicts, and patches in plaintext.
- Chit is not a scheduler, hosted service, task database, or visual editor.
