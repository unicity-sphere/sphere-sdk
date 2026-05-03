#!/usr/bin/env bash
# =============================================================================
# preflight-infra.sh — shared infra-probe gate for shell-script e2e tests
#
# Sourced by tests/e2e/e2e-helpers.sh and tests/e2e/pointer-N0-prologue.sh,
# so every shell-driven e2e test inherits the same gate without each
# script having to know about it.
#
# Usage from a sourcing script:
#
#   preflight_infra "nostr,aggregator,ipfs"
#
# Behaviour:
#   * Runs `npx -y @unicitylabs/infra-probe --network <net> --only <list>
#     --quiet` once. The probe's documented exit codes drive the gate:
#       0 — every required service is healthy        → continue
#       1 — at least one service is degraded         → warn, continue
#       2 — at least one service is UNREACHABLE      → SKIP the test
#       3 — internal CLI / arg error                  → warn, continue
#         (we'd rather run a test that turns out to time out than skip
#          one that would have caught a regression)
#
#   * "Skip" means the script ends with a clear stdout/stderr message
#     and `exit 0` so CI doesn't flag it as a failure (the absence of
#     the test is informational, not a regression).
#
# Bypass / customise via env vars:
#   E2E_SKIP_PREFLIGHT=1        — bypass entirely; never run the probe
#   E2E_NETWORK=mainnet|testnet — which network to probe (default: testnet)
#   E2E_PROBE_TIMEOUT=<ms>      — per-probe ceiling (default 60000)
# =============================================================================

# Idempotent source guard.
if [[ "${PREFLIGHT_INFRA_LOADED:-0}" == "1" ]]; then
  return 0 2>/dev/null || true
fi
export PREFLIGHT_INFRA_LOADED=1

# ---------------------------------------------------------------------------
# preflight_infra <services>
# ---------------------------------------------------------------------------
#
# Runs the infra-probe for the given comma-separated list of services
# (e.g. "nostr,aggregator,ipfs"). Exits the calling script with code 0
# (intentional skip) if any required service is reported UNREACHABLE.
# Returns 0 (continues) on healthy or degraded.
#
# Caller MUST source, not exec — we use `exit` directly to abort the
# calling script on a skip.
preflight_infra() {
  local services="${1:-nostr,aggregator,ipfs}"

  if [[ "${E2E_SKIP_PREFLIGHT:-0}" == "1" ]]; then
    echo "  [preflight] E2E_SKIP_PREFLIGHT=1 — skipping infra probe"
    return 0
  fi

  local network="${E2E_NETWORK:-testnet}"
  local timeout="${E2E_PROBE_TIMEOUT:-60000}"

  echo "  [preflight] running @unicitylabs/infra-probe --network ${network} --only ${services} (this may take ~30s)…"

  # Run the probe. Capture stdout for the human-readable summary line
  # but route it to stderr so test scripts that pipe stdout don't see
  # it. Exit code is what we actually act on.
  local probe_status
  if ! npx -y @unicitylabs/infra-probe --network "$network" --only "$services" --timeout "$timeout" --no-color >&2; then
    probe_status=$?
  else
    probe_status=0
  fi

  case "$probe_status" in
    0)
      echo "  [preflight] ✓ infra healthy — proceeding"
      return 0
      ;;
    1)
      echo "  [preflight] ⚠ infra degraded — proceeding (test may pass anyway; failure will be informative)"
      return 0
      ;;
    2)
      echo "  [preflight] ✗ infra UNREACHABLE — skipping ${TEST_NAME:-test} cleanly"
      # Output the canonical "PASS" / "SKIP" sentinel that run-all.sh
      # greps for. We use SKIP, not FAIL — this is an intentional
      # absence, not a regression.
      echo "SKIP: ${TEST_NAME:-unknown} — required infra unreachable"
      exit 0
      ;;
    3)
      echo "  [preflight] (probe internal error — falling through; existing test logic decides)"
      return 0
      ;;
    *)
      echo "  [preflight] (probe exited unexpectedly with code ${probe_status} — falling through)"
      return 0
      ;;
  esac
}
