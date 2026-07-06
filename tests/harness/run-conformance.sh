#!/usr/bin/env bash
# Report-only API-conformance harness (uxf-v2 Phase 1). Dumps the current tree's exported
# API surface via the TypeScript compiler API and diffs it against the frozen upstream
# main v0.11.4 snapshot (tests/harness/main-exports.json). Always exits 0 — this is a
# burn-down metric for later phases, not a CI gate. See docs/uxf/uxfv2-phase-1-report.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

OUT="$(mktemp -t uxf-exports-XXXXXX.json)"
trap 'rm -f "$OUT"' EXIT

node tests/harness/dump-exports.mjs "$ROOT" \
  index.ts core/index.ts l1/index.ts \
  impl/browser/index.ts impl/browser/ipfs.ts impl/nodejs/index.ts \
  connect/index.ts impl/browser/connect/index.ts impl/nodejs/connect/index.ts \
  uxf/index.ts profile/index.ts profile/browser.ts profile/node.ts \
  > "$OUT" || {
    echo "Drift-vs-main: dump-exports.mjs failed to run — report-only, not failing build"
    exit 0
  }

python3 tests/harness/compare-exports.py "$OUT" tests/harness/main-exports.json
