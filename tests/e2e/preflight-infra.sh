#!/usr/bin/env bash
# =============================================================================
# preflight-infra.sh — shared infra-probe gate for shell-script e2e tests
#
# Sourced by tests/e2e/pointer-N0-prologue.sh, so every pointer-N*.sh
# test inherits the same gate without having to know about it.
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

  # Local-infra mode: when the test harness has booted a local Nostr
  # relay + faucet (via tests/e2e/local-infra/local-infra.sh), the
  # public testnet relay/faucet are NOT what we want to probe.
  # Strategy:
  #   - Drop `nostr` and `faucet` from the services list passed to
  #     the public probe — those are local now.
  #   - Run the public probe on whatever's left (aggregator/ipfs/
  #     fulcrum/market). Same gate semantics for non-local services.
  #   - For `nostr`: hand-roll a NIP-11 doc check against
  #     $SPHERE_NOSTR_RELAYS — a quick HTTP GET that proves the
  #     local relay container is up and serving.
  #   - For `faucet`: trust the boot-time check in local-infra.sh.
  #     The faucet's chain_pubkey was already verified before
  #     E2E_LOCAL_FAUCET_PUBKEY was exported. No HTTP probe path
  #     exists for the DM-driven faucet.
  if [[ "${E2E_LOCAL_INFRA:-0}" == "1" ]]; then
    local include_local_nostr=0
    local include_local_faucet=0
    local public_only=""
    local IFS_SAVE="$IFS"
    IFS=','
    for svc in $services; do
      svc="${svc//[[:space:]]/}"
      case "$svc" in
        nostr) include_local_nostr=1 ;;
        faucet) include_local_faucet=1 ;;
        *) public_only="${public_only:+$public_only,}$svc" ;;
      esac
    done
    IFS="$IFS_SAVE"

    if (( include_local_nostr == 1 )); then
      local relay_url="${SPHERE_NOSTR_RELAYS:-ws://127.0.0.1:7777}"
      # ws://… → http://…; wss://… → https://…
      local http_url="${relay_url/ws:/http:}"
      http_url="${http_url/wss:/https:}"
      if curl -sf -H "Accept: application/nostr+json" "$http_url" -o /dev/null 2>/dev/null; then
        echo "  [preflight] ✓ local nostr relay healthy ($relay_url)"
      else
        echo "  [preflight] ✗ local nostr relay UNREACHABLE ($relay_url) — skipping"
        echo "SKIP: ${TEST_NAME:-unknown} — local nostr relay unreachable"
        exit 0
      fi
    fi

    if (( include_local_faucet == 1 )); then
      if [[ -n "${E2E_LOCAL_FAUCET_PUBKEY:-}" ]]; then
        echo "  [preflight] ✓ local faucet booted (pubkey=${E2E_LOCAL_FAUCET_PUBKEY:0:16}…)"
      else
        echo "  [preflight] ✗ local faucet not booted (E2E_LOCAL_FAUCET_PUBKEY unset) — skipping"
        echo "SKIP: ${TEST_NAME:-unknown} — local faucet not booted"
        exit 0
      fi
    fi

    # If only nostr/faucet were requested, we're done.
    if [[ -z "$public_only" ]]; then
      echo "  [preflight] ✓ infra healthy — proceeding"
      return 0
    fi

    services="$public_only"
    echo "  [preflight] E2E_LOCAL_INFRA=1 — public probe restricted to: $services"
  fi

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
      # Output the canonical "PASS" / "SKIP" sentinel that batched
      # callers can grep for. We use SKIP, not FAIL — this is an
      # intentional absence, not a regression.
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
