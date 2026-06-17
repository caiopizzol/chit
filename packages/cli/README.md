# chit

**Stop being the glue between your agents.**

Chit is a thin local runtime for multi-model agent workflows. You declare a routine in `chit.config.json` (which agents run, in what order, what context flows forward, when a loop stops); Chit runs it from your terminal, writes a receipt, and leaves a patch to review before anything touches your tree.

## Get started

Chit runs under [Bun](https://bun.sh) and shells out to the agent CLIs you already have (`claude`, `codex`, `gemini`). Install at least one, then:

```sh
bun add -g @chit-run/cli
cd your-project
chit init implement --template loop   # writes chit.config.json
chit run implement --input task="add a --version flag"
chit apply <run-id>                   # apply the reviewed patch
```

If your shell cannot find `chit` after install, add Bun's global bin directory to `PATH`:

```sh
export PATH="$(bun pm bin -g):$PATH"
```

Add the same line to your shell startup file to keep it in new terminals.

Replace the placeholder check in `chit.config.json` with your real command, such as `bun test`. A routine with a check or a writing agent runs in a disposable git sandbox, dry-run by default: it produces a patch and stops. You review the receipt, then `chit apply` writes the exact patch.

For a long run, add `--background`. It returns once the run has accepted and pinned the base commit it will run from, so you can keep working in the tree; then stream its progress and block on the receipt with `chit wait <run-id>`. Use `chit ps` and `chit stop <run-id>` to inspect or cancel live runs. `chit help <command>` prints focused help for any command.

For agents and scripts, `chit status <run-id>` reads one run's state, live or finished, from its receipt and live registry. `ps`, `status`, and `wait` take `--json` to print that state as machine-readable output, and stdout stays JSON only. `chit wait <run-id> --follow --json` instead streams the run's lifecycle events as JSONL on stdout as they arrive, then a final run-state object as the last line. Once a run finishes, `chit result <run-id> --json` summarizes the outcome, patch state, declared `repeat.until` signals, structured step outputs, checks, and next command. Chit reports the routine's own conditions; it does not special-case review or verdict steps. A global `--project <path>` (or `CHIT_PROJECT`) points any command at another project dir, so a run can be driven from any cwd.

## A routine

```json
{
  "profiles": { "claude": "claude", "codex": "codex" },
  "routines": {
    "implement": {
      "input": "task",
      "agents": {
        "builder":  { "profile": "claude", "instructions": "Implement the smallest correct change.", "filesystem": "read-write" },
        "reviewer": { "profile": "codex",  "instructions": "Review the diff. Return JSON only.",       "filesystem": "read-only" }
      },
      "steps": [
        { "id": "build",  "call": "builder",  "prompt": "{{ inputs.task }}" },
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
        "until": {
          "all": ["checks-pass", { "step": "review", "path": "passed", "equals": true }]
        },
        "maxIterations": 3
      }
    }
  }
}
```

How it runs is derived from the routine's shape: a `repeat` makes it a loop; a check or a writing agent makes it sandboxed.

## Examples

Starter examples: [config](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/chit.config.json), [plan](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/plan.json), [investigate](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/investigate.json), [implement](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/implement.json), [fix](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/fix.json), [review](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/review.json), and [goal](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/goal.json). `chit init --template` uses built-in starter templates; these files are copyable references.

## Early

Chit is early. No scheduler, hosted service, dynamic routing, or durable resume.

Full reference: [chit.run/docs](https://chit.run/docs) · [Source](https://github.com/caiopizzol/chit) · MIT
