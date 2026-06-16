# chit

**Stop being the glue between your agents.**

Chit is a thin local runtime for multi-model agent workflows. You declare a routine in `chit.config.json` (which agents run, in what order, what context flows forward, when a loop stops); Chit runs it from your terminal, writes a receipt, and leaves a patch to review before anything touches your tree.

## Install

Chit runs under [Bun](https://bun.sh) and shells out to the agent CLIs you already have (`claude`, `codex`, `gemini`). Install at least one, then:

```sh
bun add -g @chit-run/cli
```

## Quick start

```sh
cd your-project
chit init implement --template loop   # writes chit.config.json
chit doctor                           # check config + agent CLIs
chit run implement --input task="add a --version flag"
chit apply <run-id>                   # apply the reviewed patch
```

A routine with a check or a writing agent runs in a disposable git sandbox, dry-run by default: it produces a patch and stops. You review the receipt, then `chit apply` writes the exact patch.

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
              "required": ["passed"],
              "properties": { "passed": { "type": "boolean" } }
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

Starter examples: [plan](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/plan.json), [investigate](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/investigate.json), [implement](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/implement.json), [fix](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/fix.json), [review](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/review.json), and [goal](https://github.com/caiopizzol/chit/blob/main/packages/cli/examples/goal.json).

## Early

Chit is early. No scheduler, hosted service, dynamic routing, or durable resume.

Full reference: [chit.run/docs](https://chit.run/docs) · [Source](https://github.com/caiopizzol/chit) · MIT
