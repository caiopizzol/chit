# chit

[![npm version](https://img.shields.io/npm/v/@chit-run/cli.svg)](https://www.npmjs.com/package/@chit-run/cli)

Chit is a thin local runtime for multi-model agent workflows.

You declare a routine. Chit resolves the models, runs each step, passes context forward, checks the result, and writes a receipt. There are no built-in roles like builder, reviewer, planner, or judge. Those are names and prompts you define.

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

If your shell cannot find `chit` after install, add Bun's global bin directory to `PATH`:

```sh
export PATH="$(bun pm bin -g):$PATH"
```

Add the same line to your shell startup file to keep it in new terminals.

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

For a long run, detach it and wait on the receipt:

```sh
chit run implement --input task="add a version command" --background
chit wait <run-id>
```

## Examples

The examples are copyable references, not built-in modes: [config](packages/cli/examples/chit.config.json), [plan](packages/cli/examples/plan.json), [investigate](packages/cli/examples/investigate.json), [implement](packages/cli/examples/implement.json), [fix](packages/cli/examples/fix.json), [review](packages/cli/examples/review.json), and [goal](packages/cli/examples/goal.json). `chit init --template` uses small built-in starter templates.

## Commands

```sh
chit init [name]                  # create a starter routine
chit doctor [--real]              # validate config and local tools
chit routines                     # list routines and derived kinds
chit inspect <routine>            # show what will run
chit run <routine> --input k=v    # run a routine, add --background to detach
chit ps                           # list live runs
chit wait <run-id>                # block until a live run writes its receipt
chit stop <run-id>                # ask a live run to stop
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
cp examples/chit.config.json chit.config.json
bun run chit routines
bun run chit run plan --input task="add dark mode"
bun test
```

`packages/cli/chit.config.json` is ignored, so local model and routine choices stay out of commits.

## Boundaries

- Chit is local and CLI-first. It shells out to installed agent CLIs.
- Profiles are local bindings. Routines stay reusable.
- Checks are arbitrary commands, so any routine with a check runs in a sandbox.
- Receipts under `.chit/runs` store inputs, final outputs, verdicts, and patches in plaintext.
- Chit is not a scheduler, hosted service, task database, or visual editor.
