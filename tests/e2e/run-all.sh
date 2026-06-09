#!/usr/bin/env bash
# =============================================================================
# run-all.sh — Parallel launcher for swap e2e test suite
#
# Starts all tests in parallel (each with its own escrow).
# Each test logs to its own file. Prints summary table at the end.
#
# Usage:
#   bash tests/e2e/run-all.sh --escrow-cmd "cp -r ../escrow-service \$WORKSPACE/escrow"
#   bash tests/e2e/run-all.sh --sequential     # one at a time (debugging)
#   bash tests/e2e/run-all.sh --test 01         # run only test 01
# =============================================================================
set -uo pipefail
# Note: NOT set -e — we collect results from all tests even if some fail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# Parse our args vs passthrough args
SEQUENTIAL=false
TEST_FILTER=""
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sequential)  SEQUENTIAL=true; shift ;;
    --test)        TEST_FILTER="$2"; shift 2 ;;
    *)             PASSTHROUGH+=("$1"); shift ;;
  esac
done

# Discover test scripts
TESTS=()
for f in "${SCRIPT_DIR}"/[0-9][0-9]-*.sh; do
  [[ -f "$f" ]] || continue
  if [[ -n "$TEST_FILTER" ]]; then
    basename "$f" | grep -q "^${TEST_FILTER}" || continue
  fi
  TESTS+=("$f")
done

if [[ ${#TESTS[@]} -eq 0 ]]; then
  echo "No test scripts found."
  exit 1
fi

# Results directory
RESULTS_DIR=$(mktemp -d /tmp/swap-e2e-results-XXXXXX)
echo "========================================"
echo "  E2E Swap Test Suite"
echo "========================================"
echo "  Tests:   ${#TESTS[@]}"
echo "  Mode:    $(if $SEQUENTIAL; then echo sequential; else echo parallel; fi)"
echo "  Results: ${RESULTS_DIR}"
echo "  Args:    ${PASSTHROUGH[*]:-none}"
echo "========================================"
echo ""

# Launch
PIDS=()
NAMES=()
STARTS=()

for test_script in "${TESTS[@]}"; do
  name=$(basename "$test_script" .sh)
  NAMES+=("$name")
  log_file="${RESULTS_DIR}/${name}.log"
  STARTS+=("$(date +%s)")

  echo "[$(date '+%H:%M:%S')] Starting: ${name}"

  if $SEQUENTIAL; then
    bash "$test_script" "${PASSTHROUGH[@]}" > "$log_file" 2>&1 && PIDS+=("0") || PIDS+=("$?")
  else
    bash "$test_script" "${PASSTHROUGH[@]}" > "$log_file" 2>&1 &
    PIDS+=("$!")
  fi
done

echo ""
if ! $SEQUENTIAL; then
  echo "All tests launched. Waiting for completion..."
  echo ""
fi

# Collect results
RESULTS=()
for i in "${!PIDS[@]}"; do
  if $SEQUENTIAL; then
    if [[ "${PIDS[$i]}" -eq 0 ]]; then
      RESULTS+=("PASS")
    else
      RESULTS+=("FAIL")
    fi
  else
    if wait "${PIDS[$i]}" 2>/dev/null; then
      RESULTS+=("PASS")
    else
      RESULTS+=("FAIL")
    fi
  fi
done

# Summary table
echo ""
echo "================================================================="
echo "  E2E SWAP TEST SUITE RESULTS"
echo "================================================================="
printf "  %-35s %-8s %s\n" "TEST" "RESULT" "LOG"
echo "-----------------------------------------------------------------"

TOTAL_FAIL=0
for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  result="${RESULTS[$i]}"
  log_file="${RESULTS_DIR}/${name}.log"

  if [[ "$result" == "FAIL" ]]; then
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    printf "  %-35s \e[31m%-8s\e[0m %s\n" "$name" "FAIL" "$log_file"
  else
    printf "  %-35s \e[32m%-8s\e[0m %s\n" "$name" "PASS" "$log_file"
  fi
done

echo "================================================================="
TOTAL_PASS=$(( ${#TESTS[@]} - TOTAL_FAIL ))
echo "  Total: ${#TESTS[@]} tests, ${TOTAL_PASS} passed, ${TOTAL_FAIL} failed"
echo "================================================================="
echo ""

# Show tail of failed test logs + collect preserved escrow logs
for i in "${!NAMES[@]}"; do
  if [[ "${RESULTS[$i]}" == "FAIL" ]]; then
    echo "--- Last 40 lines of ${NAMES[$i]}.log ---"
    tail -40 "${RESULTS_DIR}/${NAMES[$i]}.log" 2>/dev/null || true
    echo ""

    # Collect preserved escrow log. cleanup() writes it as /tmp/escrow-${TEST_NAME}-${ts}.log.
    # TEST_NAME differs from script filename, so grep for any escrow log newer than test start.
    local_escrow_log=$(find /tmp -maxdepth 1 -name "escrow-*-*.log" -newer "${RESULTS_DIR}/${NAMES[$i]}.log" 2>/dev/null | head -1)
    if [[ -n "$local_escrow_log" ]]; then
      cp "$local_escrow_log" "${RESULTS_DIR}/${NAMES[$i]}-escrow.log" 2>/dev/null || true
      echo "  Escrow log: ${RESULTS_DIR}/${NAMES[$i]}-escrow.log"
    fi
  fi
done

echo "Full logs: ${RESULTS_DIR}/"
exit "$TOTAL_FAIL"
