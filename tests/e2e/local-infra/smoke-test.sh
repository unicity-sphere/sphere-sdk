#!/usr/bin/env bash
# =============================================================================
# smoke-test.sh — One-shot end-to-end smoke for the local-infra harness.
#
# Boots the local Nostr relay + js-faucet ONCE, then runs three
# representative test surfaces against it:
#
#   (vitest A) profile-multi-device-sync.test.ts — Profile recovery
#              + Nostr DM round-trip + cold-start, the hardest single
#              test. ~70 s on a clean box.
#   (vitest B) dm-nip17.test.ts (deterministic subset) — pure Nostr
#              DM gift-wrap publish-and-confirm. Sanity check on the
#              relay's write path. ~35 s.
#   (shell)    pointer-N1.sh / pointer-N2.sh — pointer-layer
#              recovery via aggregator (still public). Skips cleanly
#              when the in-tree CLI is gone, so on this branch the
#              shell pass is reported as "SKIPPED" — included so the
#              driver also exercises the bash-side local-infra source
#              path (preflight + state reuse from /tmp/uxf-…).
#
# After all three finish, prints a single summary table and exits
# non-zero if anything failed.
#
# This is a SMOKE, not exhaustive coverage. It proves the harness
# works end-to-end (boot → probe-gate → run → teardown) on a clean
# box. Run before publishing the branch / image bumps.
#
# Usage:
#   bash tests/e2e/local-infra/smoke-test.sh
#   bash tests/e2e/local-infra/smoke-test.sh --keep-state    # don't tear down on exit
# =============================================================================
set -uo pipefail
# Note: NOT set -e — we want to collect every test's outcome and print
# a unified summary even if one fails.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SDK_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"

KEEP_STATE=false
for arg in "$@"; do
  case "$arg" in
    --keep-state) KEEP_STATE=true ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 2 ;;
  esac
done

LOG_DIR="$(mktemp -d /tmp/uxf-e2e-local-smoke-XXXXXX)"
echo "═══════════════════════════════════════════════════════════════════"
echo "  Local-infra end-to-end smoke"
echo "  Logs: $LOG_DIR"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# ---------------------------------------------------------------------------
# 1. Boot local infra once via the bash harness. Subsequent vitest
#    runs reuse the cached state file written under
#    /tmp/uxf-e2e-local-infra/.
# ---------------------------------------------------------------------------
export E2E_LOCAL_INFRA=1

echo "── [1/4] booting local relay + faucet ──"
boot_log="$LOG_DIR/boot.log"
# Source DIRECTLY — no pipeline. Any `|` would force `source` into a
# subshell and the `export` statements would not survive into the
# parent. Boot logs go to stdout AND the log file via process
# substitution, which keeps the source-in-current-shell semantics.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/local-infra.sh" > >(tee "$boot_log") 2>&1
if [[ -z "${E2E_LOCAL_FAUCET_PUBKEY:-}" ]]; then
  echo "✗ E2E_LOCAL_FAUCET_PUBKEY not set after boot — aborting"
  cat "$boot_log"
  exit 1
fi
echo "✓ relay=$SPHERE_NOSTR_RELAYS"
echo "✓ faucet=${E2E_LOCAL_FAUCET_PUBKEY:0:16}…"
echo ""

# ---------------------------------------------------------------------------
# Cleanup hook — runs even on signal / failure / set -e.
# ---------------------------------------------------------------------------
cleanup() {
  local rc=$?
  if [[ "$KEEP_STATE" == "true" ]]; then
    echo ""
    echo "[cleanup] --keep-state — leaving local infra running."
    echo "          Tear down later with:"
    echo "          docker rm -f uxf-e2e-faucet uxf-e2e-relay"
    echo "          docker compose -f $SCRIPT_DIR/docker-compose.yml down -v"
    return 0
  fi
  echo ""
  echo "── tearing down local infra ──"
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/local-infra.sh"
  local_infra_down >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers — run a single phase, capture log + status.
# ---------------------------------------------------------------------------
run_phase() {
  local name="$1"
  local log="$LOG_DIR/${name}.log"
  shift
  echo "── [running] $name ──"
  local started
  started=$(date +%s)
  if "$@" > "$log" 2>&1; then
    local elapsed=$(( $(date +%s) - started ))
    echo "✓ $name (${elapsed}s)"
    return 0
  else
    local rc=$?
    local elapsed=$(( $(date +%s) - started ))
    echo "✗ $name (${elapsed}s, exit=$rc) — see $log"
    return "$rc"
  fi
}

declare -a PHASE_NAMES PHASE_STATUS
PHASE_NAMES=()
PHASE_STATUS=()

record() {
  PHASE_NAMES+=("$1")
  PHASE_STATUS+=("$2")
}

# ---------------------------------------------------------------------------
# 2. vitest A — profile-multi-device-sync (broadest local-infra coverage)
# ---------------------------------------------------------------------------
echo ""
echo "── [2/4] vitest: profile-multi-device-sync ──"
if run_phase "vitest-profile-multi-device-sync" \
    npx --prefix "$SDK_ROOT" vitest run \
      --config "$SDK_ROOT/vitest.e2e.config.ts" \
      "$SDK_ROOT/tests/e2e/profile-multi-device-sync.test.ts" \
      --testTimeout=600000 ; then
  record "vitest-profile-multi-device-sync" "PASS"
else
  record "vitest-profile-multi-device-sync" "FAIL"
fi

# ---------------------------------------------------------------------------
# 3. vitest B — dm-nip17 deterministic subset
# ---------------------------------------------------------------------------
echo ""
echo "── [3/4] vitest: dm-nip17 (deterministic subset) ──"
if run_phase "vitest-dm-nip17-deterministic" \
    npx --prefix "$SDK_ROOT" vitest run \
      --config "$SDK_ROOT/vitest.e2e.config.ts" \
      "$SDK_ROOT/tests/e2e/dm-nip17.test.ts" \
      -t "completes bidirectional|sends DM" \
      --testTimeout=300000 ; then
  record "vitest-dm-nip17-deterministic" "PASS"
else
  record "vitest-dm-nip17-deterministic" "FAIL"
fi

# ---------------------------------------------------------------------------
# 4. shell — exercises the bash local-infra source path.
#
# These scripts may SKIP cleanly on this branch (CLI extracted to
# @unicity-sphere/cli). The point isn't to validate the test logic
# itself — it's to prove that:
#   a) sourcing local-infra.sh from a fresh script doesn't double-
#      boot when state.env exists.
#   b) preflight-infra.sh's E2E_LOCAL_INFRA=1 path runs and either
#      passes (services healthy) or skips cleanly (CLI missing).
# A clean SKIP is a PASS for the harness — only a non-zero exit
# from a non-SKIP failure is a real fail.
# ---------------------------------------------------------------------------
echo ""
echo "── [4/4] shell: pointer-N1 (local-infra source path) ──"
shell_phase_log="$LOG_DIR/shell-pointer-N1.log"
started=$(date +%s)
if bash "$SDK_ROOT/tests/e2e/pointer-N1.sh" > "$shell_phase_log" 2>&1; then
  elapsed=$(( $(date +%s) - started ))
  if grep -q "^SKIP:" "$shell_phase_log"; then
    echo "↷ shell-pointer-N1 SKIPPED cleanly (${elapsed}s)"
    record "shell-pointer-N1" "SKIP"
  else
    echo "✓ shell-pointer-N1 (${elapsed}s)"
    record "shell-pointer-N1" "PASS"
  fi
else
  rc=$?
  elapsed=$(( $(date +%s) - started ))
  echo "✗ shell-pointer-N1 (${elapsed}s, exit=$rc) — see $shell_phase_log"
  record "shell-pointer-N1" "FAIL"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  Smoke-test results"
echo "═══════════════════════════════════════════════════════════════════"
printf "  %-40s %s\n" "PHASE" "RESULT"
echo "  -----------------------------------------------"
fail_count=0
skip_count=0
for i in "${!PHASE_NAMES[@]}"; do
  name="${PHASE_NAMES[$i]}"
  status="${PHASE_STATUS[$i]}"
  case "$status" in
    PASS) printf "  %-40s \e[32m%s\e[0m\n" "$name" "PASS" ;;
    FAIL) printf "  %-40s \e[31m%s\e[0m\n" "$name" "FAIL"; fail_count=$((fail_count + 1)) ;;
    SKIP) printf "  %-40s \e[33m%s\e[0m\n" "$name" "SKIP"; skip_count=$((skip_count + 1)) ;;
    *)    printf "  %-40s \e[33m%s\e[0m\n" "$name" "$status" ;;
  esac
done
echo "═══════════════════════════════════════════════════════════════════"
echo "  total=${#PHASE_NAMES[@]} fail=$fail_count skip=$skip_count log_dir=$LOG_DIR"
echo "═══════════════════════════════════════════════════════════════════"

# Print failed-phase tails so the operator can triage in-place.
if (( fail_count > 0 )); then
  echo ""
  echo "── failed phase tails ──"
  for i in "${!PHASE_NAMES[@]}"; do
    if [[ "${PHASE_STATUS[$i]}" == "FAIL" ]]; then
      log_path="$LOG_DIR/${PHASE_NAMES[$i]}.log"
      [[ -f "$log_path" ]] || continue
      echo ""
      echo "--- last 40 lines of ${PHASE_NAMES[$i]}.log ---"
      tail -40 "$log_path"
    fi
  done
fi

exit "$fail_count"
