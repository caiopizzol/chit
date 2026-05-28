#!/usr/bin/env bash
# Browser-core build check.
#
# Bundles every module in @chit/core and greps the output for patterns that
# indicate Node-only IO leaked into the bundle. If the bundle contains any
# of these strings, a `bun build --target=browser` of the same entry points
# would produce code that crashes at runtime in a browser.
#
# Run via: bun --filter '@chit/core' check:browser
#
# Acceptance criteria: zero matches for any of the FORBIDDEN patterns below.

set -euo pipefail

# Always run from packages/core (parent of the scripts/ dir that holds this file).
cd "$(dirname "$0")/.."

OUTDIR=$(mktemp -d)
trap 'rm -rf "$OUTDIR"' EXIT

ENTRIES=(
  src/manifest/parse.ts
  src/manifest/types.ts
  src/agents/registry.ts
  src/agents/types.ts
  src/graph-model.ts
  src/install-marker.ts
  src/shared.ts
  src/show.ts
  src/index.ts
)

bun build --target=browser \
  "${ENTRIES[@]}" \
  --outdir "$OUTDIR" \
  --splitting \
  > /dev/null

# Patterns that should not appear in a clean browser-core bundle. If any
# match, a Node-only module slipped past the boundary.
FORBIDDEN=(
  '"node:'
  'readFileSync'
  'existsSync'
  'writeFileSync'
  'mkdirSync'
  'rmSync'
  'createHash'
  'randomBytes'
  'homedir'
  'process\.cwd'
  'process\.env'
)

FAILED=0
for pattern in "${FORBIDDEN[@]}"; do
  if grep -rE "$pattern" "$OUTDIR" > /dev/null 2>&1; then
    if [ $FAILED -eq 0 ]; then
      echo "browser-core bundle contains forbidden Node-only references:"
    fi
    echo ""
    echo "  pattern: $pattern"
    grep -rEn "$pattern" "$OUTDIR" | sed 's|'"$OUTDIR"'/|    |' | head -5
    FAILED=1
  fi
done

if [ $FAILED -eq 1 ]; then
  echo ""
  echo "Fix: move the offending code into a runtime-only package (apps/cli)."
  echo "Browser-core consumers must import only from @chit/core."
  exit 1
fi

echo "OK: browser-core bundle is clean ($(ls "$OUTDIR" | wc -l | tr -d ' ') chunks, no Node-only references)"
