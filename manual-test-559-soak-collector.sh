#!/usr/bin/env bash
#
# manual-test-559-soak-collector.sh — F1 soak runbook for sphere-sdk#559.
#
# Drives ONE round of the trader-roundtrip soak with the
# `diag/issue-559-mux-dedup-instrumentation` branch's `[#559-diag]` log
# pair surfaced at INFO level, and prints a compact verdict table from
# the captured logs.
#
# What it does:
#   1. Verifies the local sphere-sdk checkout is on
#      `diag/issue-559-mux-dedup-instrumentation` (PR #582) OR a branch
#      that contains the F1 commit.
#   2. Verifies sphere-cli is using `file:` link to the local sphere-sdk
#      (so the F1 instrumentation is picked up live, no vendor-bump
#      needed).
#   3. Runs `manual-test-trader-roundtrip.sh` with SPHERE_DEBUG=Mux=info
#      and the trader-soak workspace preserved (KEEP=1).
#   4. Greps `[#559-diag]` + `[acp-m9]` lines from the captured §3
#      snapshots and prints a three-row verdict table.
#
# The verdict logic mirrors the table in PR #582's description.
#
# Run:
#   bash manual-test-559-soak-collector.sh
#
# Env contract:
#   SPHERE_SDK_DIR     Local sphere-sdk checkout. Default $PWD.
#   SPHERE_CLI_DIR     Local sphere-cli checkout. Default
#                      ~/sphere-cli-work/sphere-cli (matches @vrogojin's
#                      workspace).
#   TRADER_TEST_DIR    Forwarded to manual-test-trader-roundtrip.sh.
#                      Default /tmp/trader-559-collector-$$.

set -euo pipefail

SPHERE_SDK_DIR="${SPHERE_SDK_DIR:-$PWD}"
SPHERE_CLI_DIR="${SPHERE_CLI_DIR:-$HOME/sphere-cli-work/sphere-cli}"
TRADER_TEST_DIR="${TRADER_TEST_DIR:-/tmp/trader-559-collector-$$}"

banner() {
  echo
  echo "================================================================"
  echo "$@"
  echo "================================================================"
}

banner "Step 1: verify SDK branch"
cd "$SPHERE_SDK_DIR"

# F1 commit (51598330) introduced the `[#559-diag]` log pair. Accept any
# branch that contains it.
if ! git log HEAD --oneline | grep -q '51598330\|#559-diag'; then
  echo "ERROR: $SPHERE_SDK_DIR doesn't contain the F1 commit (51598330)."
  echo "Check out the F1 branch first:"
  echo "  git fetch origin diag/issue-559-mux-dedup-instrumentation"
  echo "  git checkout diag/issue-559-mux-dedup-instrumentation"
  exit 1
fi
echo "OK: F1 instrumentation present in $SPHERE_SDK_DIR ($(git rev-parse --short HEAD))"

banner "Step 2: verify sphere-cli SDK pin"
if [[ ! -d "$SPHERE_CLI_DIR" ]]; then
  echo "ERROR: SPHERE_CLI_DIR=$SPHERE_CLI_DIR not found."
  exit 1
fi
sdk_pin=$(grep '"@unicitylabs/sphere-sdk"' "$SPHERE_CLI_DIR/package.json" || true)
if [[ "$sdk_pin" != *"file:"* ]]; then
  echo "ERROR: sphere-cli SDK pin is not a file: link — F1 won't be picked up live."
  echo "Current pin: $sdk_pin"
  exit 1
fi
echo "OK: $sdk_pin"

banner "Step 3: rebuild SDK + run trader-soak with F1 instrumentation"
cd "$SPHERE_SDK_DIR"
npx tsup 2>&1 | tail -10 | grep -E 'ESM Build|CJS Build|build succeeded' || {
  echo "ERROR: SDK build failed."
  exit 1
}

mkdir -p "$TRADER_TEST_DIR"
LOG_FILE="$TRADER_TEST_DIR/559-soak.log"

# Run the soak with SPHERE_DEBUG=Mux=info so the [#559-diag] lines surface.
# KEEP=1 preserves the workspace for post-mortem grep.
SPHERE_DEBUG='Mux=info' \
KEEP=1 \
TRADER_TEST_DIR="$TRADER_TEST_DIR" \
bash "$SPHERE_SDK_DIR/manual-test-trader-roundtrip.sh" 2>&1 | tee "$LOG_FILE" || {
  echo "WARN: soak exited non-zero — collector still ran the verdict."
}

banner "Step 4: verdict"

# Count diag-log occurrences in the full log AND the §3 snapshots.
hydrated_lines=$(grep -h '\[#559-diag\] hydrated' "$LOG_FILE" 2>/dev/null || true)
dedup_hit_lines=$(grep -h '\[#559-diag\] dedup hit' "$LOG_FILE" 2>/dev/null || true)
acp_m9_lines=$(grep -h '\[acp-m9\] resolvedPubkey set' "$LOG_FILE" 2>/dev/null || true)

echo "----------------------------------------"
echo "  Hydrated samples (first 5):"
echo "$hydrated_lines" | head -5
echo "----------------------------------------"
echo "  Dedup-hit count: $(echo "$dedup_hit_lines" | grep -c '.' || echo 0)"
echo "  Sample dedup hits (first 3):"
echo "$dedup_hit_lines" | head -3
echo "----------------------------------------"
echo "  ACP M9 resolve samples (first 5):"
echo "$acp_m9_lines" | head -5
echo "----------------------------------------"

# Auto-conclude based on §3 first SET_STRATEGY pattern.
first_hydrated=$(echo "$hydrated_lines" | sed -n '1p')
if [[ -z "$first_hydrated" ]]; then
  echo "VERDICT: No [#559-diag] hydrated lines found. Either SPHERE_DEBUG didn't"
  echo "         propagate or the SDK build wasn't picked up by sphere-cli."
  echo "         Check: $LOG_FILE"
  exit 2
fi

# Read N from the first hydrate line: "hydrated: N event IDs"
n_hydrated=$(echo "$first_hydrated" | grep -oE 'hydrated: [0-9]+' | head -1 | grep -oE '[0-9]+' || echo "?")

if [[ "$n_hydrated" == "0" ]]; then
  echo "VERDICT: hydrated=0 in the first process. If you re-used a workspace,"
  echo "         this is CAUSE (1) — persistent dedup not surviving cross-process."
  echo "         File the OrbitDB Profile flush issue (F2)."
else
  echo "VERDICT: hydrated=$n_hydrated in the first sampled process."
  if [[ -n "$dedup_hit_lines" ]]; then
    echo "         Dedup is firing. CASE (3) self-wrap-race is the live"
    echo "         suspect: lift PR #558's hold and wire selfWrap: false"
    echo "         in sphere-cli's HMCP send sites (F3)."
  else
    echo "         Dedup loaded but never fires — buffered events are NEW IDs."
    echo "         Confirms CASE (3): the prior process never received what it"
    echo "         published. Lift #558 hold and wire selfWrap: false (F3)."
  fi
fi

echo
echo "Full log preserved at: $LOG_FILE"
echo "Workspace preserved at: $TRADER_TEST_DIR (set KEEP=0 to clean)"
