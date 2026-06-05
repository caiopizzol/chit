#!/usr/bin/env bash
set -euo pipefail

test -f README.md
test -f review-check.json

if grep -R "requiredChecks.*bun test\\|shell" review-check.json >/dev/null; then
  echo "manifest should not use shell-style required checks" >&2
  exit 1
fi

bun -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync("review-check.json", "utf8"));

const must = (condition, message) => {
  if (!condition) throw new Error(message);
};

must(manifest.schema === 1, "schema must be 1");
must(manifest.id === "review-check", "id must be review-check");
must(typeof manifest.description === "string" && manifest.description.length > 0, "description required");
must(manifest.inputs?.task?.type === "string", "task string input required");
must(manifest.inputs?.diff_summary?.type === "string", "diff_summary string input required");

const reviewer = manifest.participants?.reviewer;
must(reviewer?.agent === "codex", "reviewer must use codex");
must(reviewer?.session === "per_scope", "reviewer must use per_scope");
must(reviewer?.permissions?.filesystem === "read_only", "reviewer must be read_only");
must(typeof reviewer?.instructions === "string" && reviewer.instructions.length > 0, "reviewer instructions required");

const steps = manifest.steps ?? {};
const callEntries = Object.entries(steps).filter(([, step]) => step.call === "reviewer");
must(callEntries.length === 1, "exactly one reviewer call step required");
const [callId, callStep] = callEntries[0];
must(callStep.prompt.includes("{{ inputs.task }}"), "call prompt must reference inputs.task");
must(callStep.prompt.includes("{{ inputs.diff_summary }}"), "call prompt must reference inputs.diff_summary");

const formatEntries = Object.entries(steps).filter(([, step]) => typeof step.format === "string");
must(formatEntries.length === 1, "exactly one format step required");
const [formatId, formatStep] = formatEntries[0];
must(formatStep.format.includes(`{{ steps.${callId}.output }}`), "format must include reviewer output");
must(manifest.output === formatId, "output must point to the format step");
must(!manifest.policy, "one-shot manifest should not declare a loop policy");
'
