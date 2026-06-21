#!/usr/bin/env bash
#
# manual-test-trader-roundtrip.sh — trader-agent autonomous round-trip soak
# (sphere-sdk#474, the trader-agent G1 walkthrough).
#
# Scenario (verbatim from #474):
#   SETUP    alice (controller) faucets 100 UCT to her wallet
#            bob   (controller) faucets 10  ETH to his wallet
#   DEPOSIT  alice sends 50  UCT to her  trader tenant
#            bob   sends 4.5 ETH to his  trader tenant
#   INTENTS  alice's controller posts a SELL intent on (UCT/ETH)
#            bob's   controller posts a BUY  intent on (UCT/ETH)
#   DAEMONS  each tenant scans the market, finds the counter-intent,
#            negotiates terms via NP-0 over NIP-17 DMs, and executes
#            the matched deal through SwapModule.proposeSwap against
#            the escrow ($ESCROW, default @escrow-test-02).
#   COMPLETE alice's trader ends up with ~+4.25 ETH (and -50 UCT)
#            bob's   trader ends up with ~+50 UCT (and -~4.25 ETH)
#
# Net (tenant view):
#     alice-trader  -50 UCT  +~4.25 ETH
#     bob-trader    +50 UCT  -~4.25 ETH
#   Exact split is determined by the agreed rate, which the matching
#   code computes as floor((overlap_min + overlap_max) / 2) over the
#   intersection of both rate bands — see §5.2 of
#   /home/vrogojin/trader-service/docs/protocol-spec.md. With the default
#   [0.08, 0.09] band on both sides the midpoint is 0.085, so bob owes
#   0.085 × 50 = 4.25 ETH — within his 4.5 ETH deposit.
#
# This soak is the TRADER analog of:
#   - manual-test-swap-roundtrip.sh       (swap roundtrip)
#   - manual-test-accounting-roundtrip.sh (invoice roundtrip)
#
# ---------------------------------------------------------------------------
# Run:
#   bash manual-test-trader-roundtrip.sh
#   KEEP=1 bash manual-test-trader-roundtrip.sh           # preserve workspace
#   KEEP_TENANTS=1 bash manual-test-trader-roundtrip.sh   # leave tenants running
#   TRADER_TEST_DIR=/tmp/tr bash manual-test-trader-roundtrip.sh
#
# ---------------------------------------------------------------------------
# UX PRINCIPLE — human-friendly floats at the CLI surface
#
# Per the project owner's guidance, the operator works with human-friendly
# floats everywhere — `--rate-min 0.08`, `--volume-min 50`. The CLI is
# responsible for converting those to smallest-unit bigints internally via
# the token registry decimals lookup (UCT and ETH are both 18-decimal on
# testnet). This soak writes the float form as the canonical UX.
#
# TODO(#474 follow-up): the trader CLI (sphere-cli/src/trader/trader-
# commands.ts) currently accepts `--rate-min <bigint>` as a STRING-ENCODED
# BIGINT. This is the wrong UX — it must be fixed to accept floats and do
# the smallest-unit conversion internally. Until that lands, this soak's
# `with_float_or_bigint_shim` helper auto-detects the CLI's accepted form:
# it tries the float form first; on INVALID_PARAM it falls back to an
# inline float→bigint conversion (via `python3 -c "print(int(<f> * 10**18))"`)
# and prints a warning. Set TRADER_CLI_FLOAT_NATIVE=0 to skip the float
# attempt entirely and go straight to the bigint shim.
#
# ---------------------------------------------------------------------------
# Env contract (with defaults):
#
#   TRADER_TEST_DIR              Workspace root. Default /tmp/trader-roundtrip-$$
#   KEEP=0|1                     Preserve $TRADER_TEST_DIR on exit. Default 0.
#   KEEP_TENANTS=0|1             Leave spawned tenants AND their local HMs
#                                running on exit. Default 0 (we
#                                `sphere trader stop` them, which auto-tears
#                                down the per-user HM when the last tenant
#                                stops; setting this to 1 forwards `--keep-hm`).
#   SUFFIX                       Unique suffix shared by the alice/bob/tenant
#                                nametags. Default = epoch-tail + random.
#   ESCROW                       Escrow @nametag or DIRECT://hex.
#                                Default @escrow-test-02 (per sphere-sdk#456).
#   TRADER_RATE_MIN_ETH_PER_UCT  Lower edge of the rate band, as a
#                                **human-friendly float**. Default 0.08
#                                (= 0.08 ETH per 1 UCT).
#   TRADER_RATE_MAX_ETH_PER_UCT  Upper edge of the rate band. Default 0.09.
#                                Defaults must satisfy
#                                  rate_max × volume_max ≤ bob's deposit
#                                so the negotiation cannot land on a rate
#                                bob cannot fund. Today's hardcoded bob
#                                deposit is 4.5 ETH and volume is 50 UCT,
#                                hence rate_max = 4.5 ÷ 50 = 0.09. Raising
#                                the band requires raising bob's §5
#                                deposit by the same factor — see
#                                trader-service#29 for the upstream pre-
#                                flight check that would catch this for us.
#   TRADER_VOLUME_UCT            Volume to trade in **whole UCT**. Default 50.
#   TRADER_CLI_FLOAT_NATIVE      0 = skip the float attempt and go straight
#                                to the bigint shim. Default 1.
#   TRADER_DEAL_DEADLINE_S       Wall-clock cap for negotiation + settlement.
#                                Default 900 (15 min). Bumped from 600 to
#                                cover per-user local-HM bootstrap (two-shot
#                                drift-guard restart) on top of the trader
#                                scan interval. TRADER_SCAN_INTERVAL_MS
#                                defaults to 30 s in the template, so a first
#                                match round can take up to a minute.
#   TRADER_DEPOSIT_TIMEOUT_S     Wall-clock cap for the controller→tenant
#                                deposit confirmation poll. Default 240.
#   TRADER_FAUCET_WAIT_S         Wall-clock cap waiting for faucet UTXOs to
#                                land. Default 120.
#   MARKET_API_URL               Market feed base URL. Default
#                                https://market-api.unicity.network.
#   SPHERE_ALLOW_MNEMONIC_NON_TTY Always exported as 1 — the soak runs
#                                non-interactively, so it cannot prompt for
#                                mnemonic entry.
#
# Prerequisites:
#   - sphere-cli with `sphere trader spawn` / `sphere trader stop`
#     (unicity-sphere/sphere-cli#49 or later). The wrapper brings up a
#     per-user local Host Manager scoped to the current wallet's
#     controller pubkey + spawns the trader tenant in one command. The
#     public Host Manager is reserved for shared infra (escrow, faucet)
#     and is NOT used by this soak.
#   - Docker available locally — the wrapper drives docker for the
#     per-user HM container.
#
# ---------------------------------------------------------------------------
# KNOWN LIMITATIONS
#
#   1. Cross-process Nostr DM flakiness (sphere-sdk#473).
#      The controller `sphere trader ...` commands are CLI-process: they
#      boot, send one DM to the tenant, wait for a reply, exit. The tenant
#      stays subscribed, but its `since` cursor and the relay's per-pubkey
#      retention can drop occasional inbound DMs from a freshly-booted
#      controller process. Mitigations baked in here:
#        - `with_retry` wraps every `sphere trader ...` controller call
#          (3 attempts × 5 s back-off).
#        - After spawn we run `sphere trader portfolio` as a warm-up to
#          prime the tenant's `since` cursor before doing anything load-
#          bearing.
#        - The §8 deal-completion poll uses TRADER_DEAL_DEADLINE_S (default
#          15 min, i.e. ~30× TRADER_SCAN_INTERVAL_MS) so a missed DM is
#          recovered by the next scan iteration.
#
#   2. CLI float-vs-bigint UX (covered by TODO(#474 follow-up) above).
#      The soak writes the float form (post-fix UX), with an inline shim
#      that converts to smallest-unit bigints when the CLI rejects floats
#      with INVALID_PARAM. Verify the deployed CLI form against
#      `sphere trader create-intent --help` before running. The shim
#      assumes UCT and ETH have 18 decimals (true on production testnet);
#      override TRADER_*_DECIMALS env vars if your registry differs.
#
#   3. Trader image staleness (vrogojin/agentic_hosting#26).
#      The trader image tagged `ghcr.io/vrogojin/agentic-hosting/trader:v0.1`
#      was built before the SDK-side rotations in:
#        - sphere-sdk#456 (DEFAULT_ESCROW_ADDRESS = @escrow-test-02)
#        - sphere-sdk#457 (counterparty transport pubkey fail-fast)
#        - sphere-sdk#464 (MuxAdapter dispatch await)
#      Until the v0.2 image lands (vrogojin/agentic_hosting#26), this soak
#      may fail in §8 with one of:
#        - tenant times out negotiating because old SwapModule does not
#          fail fast on missing transport pubkey;
#        - tenant uses a stale default escrow that does not match $ESCROW
#          and the swap proposal never gets accepted.
#      Remediation: rebuild and republish the trader image upstream.
#      The `sphere trader spawn` wrapper accepts `--hm-image` for the host
#      manager image but the trader image itself is pinned by the template
#      registry (config/templates.json).
#
#   4. Some intent state values are not enumerated in this soak. It ASSUMES
#      that --state filters on list-intents/list-deals accept the canonical
#      uppercase forms documented in protocol-spec.md §6. If a future
#      revision changes the wire shape, the §11 cleanup may need adjusting.
#
# Canonical end-to-end walkthrough: sphere-sdk#474 (G1).

set -euo pipefail

# ---------------------------------------------------------------------------
# Workspace
# ---------------------------------------------------------------------------
ROOT="${TRADER_TEST_DIR:-/tmp/trader-roundtrip-$$}"
SNAP="$ROOT/snapshots"
mkdir -p "$SNAP"

SUFFIX="${SUFFIX:-$(date +%s | tail -c 5)$(printf '%04x' $((RANDOM % 65536)))}"
ALICE_TAG="alice-$SUFFIX"
BOB_TAG="bob-$SUFFIX"
ALICE_TRADER_TAG="alice-trader-$SUFFIX"
BOB_TRADER_TAG="bob-trader-$SUFFIX"
ALICE_TRADER_INSTANCE="alice-trader-$SUFFIX"
BOB_TRADER_INSTANCE="bob-trader-$SUFFIX"

echo "ALICE_TAG=$ALICE_TAG"
echo "BOB_TAG=$BOB_TAG"
echo "ALICE_TRADER_TAG=$ALICE_TRADER_TAG"
echo "BOB_TRADER_TAG=$BOB_TRADER_TAG"

PEER_ALICE="$ROOT/alice-peer"
PEER_BOB="$ROOT/bob-peer"
mkdir -p "$PEER_ALICE" "$PEER_BOB"

ESCROW="${ESCROW:-@escrow-test-02}"

# Human-friendly floats. The CLI is responsible for converting these
# to smallest-units (post-fix UX). The shim mode below converts inline
# when the CLI still demands bigints.
TRADER_RATE_MIN_ETH_PER_UCT="${TRADER_RATE_MIN_ETH_PER_UCT:-0.08}"
# rate_max × volume_max must stay ≤ bob's hardcoded deposit (4.5 ETH at
# §5 below). 0.09 × 50 = 4.5 ETH — bob can fund any rate the negotiation
# midpoint picks within [0.08, 0.09]. Raising rate_max without raising
# bob's deposit by the matching factor reproduces sphere-sdk#536's soak
# halt (deal fails with VOLUME_RESERVATION_FAILED at §8). Upstream
# defensive check tracked in trader-service#29.
TRADER_RATE_MAX_ETH_PER_UCT="${TRADER_RATE_MAX_ETH_PER_UCT:-0.09}"
TRADER_VOLUME_UCT="${TRADER_VOLUME_UCT:-50}"
TRADER_CLI_FLOAT_NATIVE="${TRADER_CLI_FLOAT_NATIVE:-1}"

# Decimals — UCT and ETH are both 18-decimal on testnet.
TRADER_UCT_DECIMALS="${TRADER_UCT_DECIMALS:-18}"
TRADER_ETH_DECIMALS="${TRADER_ETH_DECIMALS:-18}"

# Bumped 600→900 to cover per-user local-HM bootstrap on top of the
# trader scan interval. The wrapper performs a two-shot drift-guard
# restart of the HM before the trader tenant is ready, which the old
# 10-min budget did not account for.
TRADER_DEAL_DEADLINE_S="${TRADER_DEAL_DEADLINE_S:-900}"
TRADER_DEPOSIT_TIMEOUT_S="${TRADER_DEPOSIT_TIMEOUT_S:-240}"
TRADER_FAUCET_WAIT_S="${TRADER_FAUCET_WAIT_S:-120}"

MARKET_API_URL="${MARKET_API_URL:-https://market-api.unicity.network}"

# KEEP_TENANTS=1 forwards `--keep-hm` to `sphere trader stop` so the
# per-user local HM stays running for inspection. Note: `sphere trader
# stop` does NOT have a --keep-data flag; the tenant data dir is
# preserved by default.
KEEP_HM_FLAG=""
if [[ "${KEEP_TENANTS:-0}" == "1" ]]; then
  KEEP_HM_FLAG="--keep-hm"
fi

echo "ESCROW=$ESCROW"
echo "TRADER_RATE_MIN_ETH_PER_UCT=$TRADER_RATE_MIN_ETH_PER_UCT  (float)"
echo "TRADER_RATE_MAX_ETH_PER_UCT=$TRADER_RATE_MAX_ETH_PER_UCT  (float)"
echo "TRADER_VOLUME_UCT=$TRADER_VOLUME_UCT  (whole UCT)"
echo "TRADER_CLI_FLOAT_NATIVE=$TRADER_CLI_FLOAT_NATIVE"
echo "TRADER_DEAL_DEADLINE_S=$TRADER_DEAL_DEADLINE_S"
echo "MARKET_API_URL=$MARKET_API_URL"
echo "KEEP_HM_FLAG=${KEEP_HM_FLAG:-<auto-teardown>}"

export SPHERE_ALLOW_MNEMONIC_NON_TTY=1

# ---------------------------------------------------------------------------
# Derived expected values (smallest-units) for §10 assertions.
# Both rates and volume are floats here; convert to bigint smallest-units
# via python (arbitrary precision).
# ---------------------------------------------------------------------------
EXPECTED_UCT_SMALLEST=$(python3 -c "print(int($TRADER_VOLUME_UCT * 10**$TRADER_UCT_DECIMALS))")
# ETH band: low/high bounds on the expected ETH delta for the agreed volume.
ETH_LOW_SMALLEST=$(python3 -c "
print(int($TRADER_RATE_MIN_ETH_PER_UCT * $TRADER_VOLUME_UCT * 10**$TRADER_ETH_DECIMALS))
")
ETH_HIGH_SMALLEST=$(python3 -c "
print(int($TRADER_RATE_MAX_ETH_PER_UCT * $TRADER_VOLUME_UCT * 10**$TRADER_ETH_DECIMALS))
")
ETH_MID_SMALLEST=$(python3 -c "
rmid = ($TRADER_RATE_MIN_ETH_PER_UCT + $TRADER_RATE_MAX_ETH_PER_UCT) / 2
print(int(rmid * $TRADER_VOLUME_UCT * 10**$TRADER_ETH_DECIMALS))
")

echo "EXPECTED_UCT_SMALLEST=$EXPECTED_UCT_SMALLEST  (alice trader sells, bob trader receives)"
echo "ETH_LOW_SMALLEST     =$ETH_LOW_SMALLEST       (alice trader minimum receive)"
echo "ETH_HIGH_SMALLEST    =$ETH_HIGH_SMALLEST      (alice trader maximum receive)"
echo "ETH_MID_SMALLEST     =$ETH_MID_SMALLEST       (midpoint expectation)"

cleanup() {
  local rc=$?
  # Stop spawned tenants on the way out via `sphere trader stop`. The
  # wrapper auto-tears down each peer's per-user local Host Manager when
  # the last tenant attached to it stops; pass --keep-hm (via
  # KEEP_HM_FLAG, set from KEEP_TENANTS) to leave the HM containers
  # running for inspection.
  #
  # Even with KEEP_TENANTS=1 we still issue `sphere trader stop` (with
  # --keep-hm) so the tenant process exits cleanly — this differs from
  # the previous behavior, which skipped cleanup entirely. We do this
  # because the wrapper's bookkeeping (tenant registry, HM ref count)
  # is the source of truth; leaving the tenant alive but unregistered
  # would orphan it. If you genuinely want a tenant left running for
  # ACP probing, comment out the `sphere trader stop` lines.
  if [[ -n "${PEER_ALICE:-}" && -d "$PEER_ALICE" ]]; then
    (
      cd "$PEER_ALICE" 2>/dev/null && \
      sphere wallet use alice 2>/dev/null && \
      sphere trader stop --name "$ALICE_TRADER_INSTANCE" $KEEP_HM_FLAG \
        2>&1 | tee -a "$SNAP/alice-trader-stop.log" || true
    ) || true
  fi
  if [[ -n "${PEER_BOB:-}" && -d "$PEER_BOB" ]]; then
    (
      cd "$PEER_BOB" 2>/dev/null && \
      sphere wallet use bob 2>/dev/null && \
      sphere trader stop --name "$BOB_TRADER_INSTANCE" $KEEP_HM_FLAG \
        2>&1 | tee -a "$SNAP/bob-trader-stop.log" || true
    ) || true
  fi
  if [[ "${KEEP_TENANTS:-0}" == "1" ]]; then
    echo "=== KEEP_TENANTS=1: per-user HMs left running (--keep-hm); tenant processes stopped ==="
  fi
  if [[ "${KEEP:-0}" != "1" ]]; then
    rm -rf "$ROOT" 2>/dev/null || true
  else
    echo "=== KEEP=1: workspace preserved at $ROOT ==="
  fi
  return "$rc"
}
trap cleanup EXIT INT TERM

banner() {
  echo
  echo "================================================================"
  echo "$@"
  echo "================================================================"
}

# ---------------------------------------------------------------------------
# Integer-only confirmed balance extractor for `sphere balance` output.
# Same convention as manual-test-{swap,accounting}-roundtrip.sh: both UCT
# and ETH are 18-decimal coins on the production testnet registry, so we
# pad fractional parts to 18 chars to get a smallest-unit integer.
# ---------------------------------------------------------------------------
extract_confirmed_smallest_units() {
  local symbol="$1"
  local line decimal int_part frac_part
  line=$(grep -E "^${symbol}:" || true)
  if [[ -z "$line" ]]; then
    echo "0"
    return
  fi
  decimal=$(echo "$line" | sed -E -e "s/^${symbol}:[[:space:]]+//" -e 's/[[:space:]]+\(.+$//')
  if [[ "$decimal" == *.* ]]; then
    int_part="${decimal%.*}"
    frac_part="${decimal#*.}"
  else
    int_part="$decimal"
    frac_part=""
  fi
  while (( ${#frac_part} < 18 )); do frac_part="${frac_part}0"; done
  if (( ${#frac_part} > 18 )); then
    echo "ERROR: ${symbol} fractional part >18 digits ($decimal)" >&2
    return 1
  fi
  local combined="${int_part}${frac_part}"
  combined=$(echo "$combined" | sed -E 's/^0+//')
  [[ -z "$combined" ]] && combined="0"
  echo "$combined"
}

# Helper for grep-based assertions that keep the ASSERT lines uniform.
assert_grep() {
  local label="$1" pattern="$2" file="$3"
  if grep -qE "$pattern" "$file"; then
    echo "ASSERT OK ($label): pattern matched in $file"
    return 0
  fi
  echo "ASSERT FAIL ($label): pattern '$pattern' NOT found in $file" >&2
  echo "--- $(basename "$file") tail ---" >&2
  tail -20 "$file" >&2 || true
  return 1
}

# ---------------------------------------------------------------------------
# Retry helper for controller → tenant DM calls (KNOWN LIMITATION #1).
#
# Usage:  with_retry <label> <cmd...>
#
# Runs <cmd...> up to 3 times with a 5 s back-off between attempts.
# Returns 0 on the first successful attempt, or the last attempt's rc.
# ---------------------------------------------------------------------------
with_retry() {
  local label="$1"
  shift
  local attempts=3
  local backoff=5
  local i rc
  for (( i = 1; i <= attempts; i++ )); do
    if "$@"; then
      if (( i > 1 )); then
        echo "INFO (with_retry $label): succeeded on attempt $i/$attempts"
      fi
      return 0
    fi
    rc=$?
    if (( i < attempts )); then
      echo "WARN (with_retry $label): attempt $i/$attempts failed (rc=$rc); sleeping ${backoff}s and retrying…" >&2
      sleep "$backoff"
    else
      echo "ERROR (with_retry $label): exhausted $attempts attempts (last rc=$rc)" >&2
    fi
  done
  return "${rc:-1}"
}

# ---------------------------------------------------------------------------
# Convert a human-friendly float to a smallest-unit bigint string.
#   float_to_bigint 0.08 18  →  80000000000000000
#   float_to_bigint 50   18  →  50000000000000000000
# Uses python so arbitrary precision works (bash floor div tops out at int64).
# ---------------------------------------------------------------------------
float_to_bigint() {
  local v="$1" dec="$2"
  python3 -c "print(int(float('$v') * 10**$dec))"
}

# ---------------------------------------------------------------------------
# CLI-form shim: try `sphere trader create-intent` with float values first
# (post-fix UX); on INVALID_PARAM fall back to bigint smallest-units
# (legacy/current UX). Returns 0 on success, non-zero on failure.
#
# Args:
#   $1 = label for log + warn
#   $2 = tenant nametag
#   $3 = direction (buy|sell)
#   $4 = base asset symbol
#   $5 = quote asset symbol
#   $6 = rate_min (float)
#   $7 = rate_max (float)
#   $8 = volume   (whole-units float — used for both min and max)
#   $9 = expiry_ms
#   $10 = output log path
#
# On bigint fallback the soak prints a one-time warning citing the
# TODO(#474 follow-up).
# ---------------------------------------------------------------------------
create_intent_with_shim() {
  local label="$1" tenant_nt="$2" direction="$3"
  local base="$4" quote="$5"
  local rate_min_f="$6" rate_max_f="$7" volume_f="$8"
  local expiry_ms="$9" log="${10}"

  # Try float form first (post-fix CLI UX) unless the operator opted out.
  if [[ "$TRADER_CLI_FLOAT_NATIVE" == "1" ]]; then
    if with_retry "$label-float" \
         bash -c "sphere trader create-intent --tenant '@$tenant_nt' --json --timeout 30000 \
                    --direction '$direction' --base '$base' --quote '$quote' \
                    --rate-min '$rate_min_f' --rate-max '$rate_max_f' \
                    --volume-min '$volume_f' --volume-max '$volume_f' \
                    --expiry-ms $expiry_ms \
                    2>&1 | tee '$log'"; then
      # The CLI may have accepted but the tenant may have returned an
      # INVALID_PARAM (e.g. because the bigint-mode validator rejected
      # a decimal string). Detect that and fall through to the shim.
      if ! grep -qE 'INVALID_PARAM|invalid_param' "$log"; then
        echo "INFO ($label): float form accepted"
        return 0
      fi
      echo "WARN ($label): CLI accepted float syntax but the tenant returned INVALID_PARAM — falling back to bigint shim" >&2
    else
      echo "WARN ($label): float form failed — falling back to bigint shim" >&2
    fi
  fi

  # Bigint shim — convert floats to smallest-unit bigints inline.
  # Quote-side decimals (rate is "quote per base unit" — per spec §2.3).
  local rate_min_bi rate_max_bi volume_bi
  rate_min_bi=$(float_to_bigint "$rate_min_f" "$TRADER_ETH_DECIMALS")
  rate_max_bi=$(float_to_bigint "$rate_max_f" "$TRADER_ETH_DECIMALS")
  volume_bi=$(float_to_bigint "$volume_f" "$TRADER_UCT_DECIMALS")
  echo "WARN ($label): bigint shim — TODO(#474 follow-up): CLI accepts bigint strings today, must" >&2
  echo "  be updated to accept floats and convert internally. Shim values:" >&2
  echo "    rate_min=$rate_min_bi rate_max=$rate_max_bi volume=$volume_bi" >&2

  with_retry "$label-bigint-shim" \
    bash -c "sphere trader create-intent --tenant '@$tenant_nt' --json --timeout 30000 \
               --direction '$direction' --base '$base' --quote '$quote' \
               --rate-min '$rate_min_bi' --rate-max '$rate_max_bi' \
               --volume-min '$volume_bi' --volume-max '$volume_bi' \
               --expiry-ms $expiry_ms \
               2>&1 | tee '$log'"
}

# ---------------------------------------------------------------------------
# Smoke-probe a freshly-spawned tenant via ACP `sphere trader portfolio`.
#
# `sphere trader spawn` blocks until the trader image reports ready (via
# --ready-timeout-ms, default exposed by the wrapper). By the time we
# return from spawn, the local HM is up and the trader container is
# running. We still need a one-shot ACP probe to:
#   - Confirm the tenant's Nostr transport is online and listening.
#   - Prime the tenant's `since` cursor for subsequent DMs from the
#     controller (KNOWN LIMITATION #1).
#
# Args: $1 = peer dir, $2 = wallet name, $3 = instance name,
#       $4 = tenant @nametag, $5 = output log path, $6 = timeout seconds
# ---------------------------------------------------------------------------
wait_for_tenant_running() {
  local peer="$1" wallet="$2" instance="$3" tenant_nt="$4" log="$5" timeout_s="$6"
  local deadline=$(( $(date +%s) + timeout_s ))
  cd "$peer"
  sphere wallet use "$wallet"
  while (( $(date +%s) < deadline )); do
    if sphere trader portfolio --tenant "@$tenant_nt" --timeout 20000 \
         2>&1 | tee "$log" \
         | grep -qE '"balances"|balances'; then
      echo "INFO: $instance accepted ACP probe (portfolio)"
      return 0
    fi
    echo "  $instance ACP probe not ready yet — sleeping 5 s…"
    sleep 5
  done
  echo "ASSERT FAIL (tenant-running): $instance did not pass ACP probe within ${timeout_s}s" >&2
  tail -30 "$log" >&2 || true
  return 1
}

# ---------------------------------------------------------------------------
# Extract a controller's `chainPubkey` from `sphere status` output.
# Kept for diagnostic logging — the per-user local HM (spawned by
# `sphere trader spawn`) already scopes ACP authorization to the active
# wallet's controller pubkey, so we don't pass it explicitly to the
# spawn command.
# ---------------------------------------------------------------------------
extract_chain_pubkey() {
  local status_log="$1"
  # Two output shapes:
  #   - `sphere init`   emits `chainPubkey   : <hex>` (camelCase, JSON-ish block)
  #   - `sphere status` emits `Chain Pubkey:  <hex>`  (human label)
  # Match both; case-insensitive grep with optional internal whitespace.
  grep -Eoi '(chain[[:space:]]*pubkey)[[:space:]]*:[[:space:]]*[0-9a-fA-F]+' "$status_log" \
    | head -1 \
    | sed -E 's/.*:[[:space:]]*([0-9a-fA-F]+).*/\1/'
}

# Extract the first JSON id by key from a log/file ("intent_id" etc.).
extract_json_id() {
  local file="$1" key="$2"
  grep -Eo "\"${key}\":[[:space:]]*\"[^\"]+\"" "$file" | head -1 \
    | sed -E "s/.*\"([^\"]+)\".*/\1/"
}

# Pull a per-asset balance out of a `sphere trader portfolio --json`
# document. Tolerant of envelope shapes ({result:{balances:…}} or just
# {balances:…}) and of common field-name conventions (asset/coin/symbol;
# available/total/balance). Always prints a non-empty integer string
# (defaults to "0" on miss) so caller arithmetic doesn't blow up.
portfolio_balance() {
  local file="$1" symbol="$2"
  python3 - "$file" "$symbol" <<'PYEOF' 2>/dev/null
import json, sys, re
path, symbol = sys.argv[1], sys.argv[2]
try:
    with open(path, 'r') as f:
        raw = f.read()
except Exception:
    print("0"); sys.exit(0)
# Strip leading non-JSON prelude (tee can prepend warnings / labels).
m = re.search(r'(\{|\[)', raw)
if not m:
    print("0"); sys.exit(0)
# Use raw_decode so we only consume the FIRST complete JSON value and
# tolerate trailing log lines (e.g. `[ipfs-client] WARN ...`) that tee
# can append AFTER the portfolio JSON. Previous version used json.loads
# which fails with "Extra data" on any trailing text and silently
# returned 0 for every snapshot — yielding 0-delta in §10 even after a
# real settlement.
try:
    data, _ = json.JSONDecoder().raw_decode(raw[m.start():])
except Exception:
    print("0"); sys.exit(0)
def find_balances(obj):
    if isinstance(obj, dict):
        if 'balances' in obj and isinstance(obj['balances'], list):
            return obj['balances']
        for v in obj.values():
            r = find_balances(v)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = find_balances(v)
            if r is not None:
                return r
    return None
balances = find_balances(data) or []
for entry in balances:
    if not isinstance(entry, dict):
        continue
    asset = entry.get('asset') or entry.get('coin') or entry.get('symbol') \
            or entry.get('coin_id') or entry.get('coinId')
    if str(asset).upper() == symbol.upper():
        for key in ('available', 'total', 'balance', 'amount'):
            v = entry.get(key)
            if v is not None:
                print(str(v).strip('"'))
                sys.exit(0)
print("0")
PYEOF
}

# ---------------------------------------------------------------------------
# Section 1 — Create alice + bob controller wallets (testnet)
# ---------------------------------------------------------------------------
banner "Section 1: Create alice + bob controller wallets (testnet)"

cd "$PEER_ALICE"
sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --nametag "$ALICE_TAG" 2>&1 | tee "$SNAP/alice-init.log"
sphere status | tee "$SNAP/alice-status.log"
grep -qE "Nametag:.*$ALICE_TAG|nametag[[:space:]]*:[[:space:]]*@?$ALICE_TAG" "$SNAP/alice-status.log" \
  || { echo "FAIL: alice's nametag '$ALICE_TAG' not visible in status" >&2; exit 1; }

ALICE_PUBKEY="$(extract_chain_pubkey "$SNAP/alice-status.log")"
[[ -n "$ALICE_PUBKEY" ]] \
  || { echo "FAIL: couldn't extract alice's chainPubkey from $SNAP/alice-status.log" >&2; exit 1; }
echo "ALICE_PUBKEY=$ALICE_PUBKEY"

cd "$PEER_BOB"
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --nametag "$BOB_TAG" 2>&1 | tee "$SNAP/bob-init.log"
sphere status | tee "$SNAP/bob-status.log"
grep -qE "Nametag:.*$BOB_TAG|nametag[[:space:]]*:[[:space:]]*@?$BOB_TAG" "$SNAP/bob-status.log" \
  || { echo "FAIL: bob's nametag '$BOB_TAG' not visible in status" >&2; exit 1; }

BOB_PUBKEY="$(extract_chain_pubkey "$SNAP/bob-status.log")"
[[ -n "$BOB_PUBKEY" ]] \
  || { echo "FAIL: couldn't extract bob's chainPubkey from $SNAP/bob-status.log" >&2; exit 1; }
echo "BOB_PUBKEY=$BOB_PUBKEY"

# ---------------------------------------------------------------------------
# Section 2 — Faucet alice 100 UCT + bob 10 ETH; capture controller baselines
#
# Asymmetric faucet on purpose: alice's trader sells UCT, bob's trader sells
# ETH. The net-delta assertions in §10 check that UCT only flows alice→bob
# and ETH only flows bob→alice (modulo controller→tenant deposits).
# ---------------------------------------------------------------------------
banner "Section 2: Faucet alice 100 UCT + bob 10 ETH; capture controller baselines"

cd "$PEER_ALICE"
sphere wallet use alice
sphere faucet 100 UCT               2>&1 | tee "$SNAP/alice-faucet.log"

deadline=$(( $(date +%s) + TRADER_FAUCET_WAIT_S ))
while (( $(date +%s) < deadline )); do
  sphere payments sync                2>&1 | tee "$SNAP/alice-sync-faucet.log"
  sphere payments receive --finalize  2>&1 | tee "$SNAP/alice-faucet-receive.log" || true
  sphere balance | tee "$SNAP/alice-balance-0.txt"
  alice_uct_now=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-0.txt")
  if [[ "$alice_uct_now" != "0" ]]; then
    echo "INFO: alice faucet confirmed (UCT smallest=$alice_uct_now)"
    break
  fi
  echo "  alice faucet not yet visible — sleeping 5 s…"
  sleep 5
done

cd "$PEER_BOB"
sphere wallet use bob
sphere faucet 10 ETH                2>&1 | tee "$SNAP/bob-faucet.log"

deadline=$(( $(date +%s) + TRADER_FAUCET_WAIT_S ))
while (( $(date +%s) < deadline )); do
  sphere payments sync                2>&1 | tee "$SNAP/bob-sync-faucet.log"
  sphere payments receive --finalize  2>&1 | tee "$SNAP/bob-faucet-receive.log" || true
  sphere balance | tee "$SNAP/bob-balance-0.txt"
  bob_eth_now=$(extract_confirmed_smallest_units ETH < "$SNAP/bob-balance-0.txt")
  if [[ "$bob_eth_now" != "0" ]]; then
    echo "INFO: bob faucet confirmed (ETH smallest=$bob_eth_now)"
    break
  fi
  echo "  bob faucet not yet visible — sleeping 5 s…"
  sleep 5
done

alice_uct_0=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-0.txt")
alice_eth_0=$(extract_confirmed_smallest_units ETH < "$SNAP/alice-balance-0.txt")
bob_uct_0=$(extract_confirmed_smallest_units   UCT < "$SNAP/bob-balance-0.txt")
bob_eth_0=$(extract_confirmed_smallest_units   ETH < "$SNAP/bob-balance-0.txt")
echo "BASELINE alice controller UCT=$alice_uct_0  ETH=$alice_eth_0"
echo "BASELINE bob   controller UCT=$bob_uct_0    ETH=$bob_eth_0"

if [[ "$alice_uct_0" == "0" ]]; then
  echo "ASSERT FAIL (alice-faucet-uct): alice's UCT balance is still 0 after ${TRADER_FAUCET_WAIT_S}s" >&2
  exit 1
fi
if [[ "$bob_eth_0" == "0" ]]; then
  echo "ASSERT FAIL (bob-faucet-eth): bob's ETH balance is still 0 after ${TRADER_FAUCET_WAIT_S}s" >&2
  exit 1
fi
echo "ASSERT OK (faucet): both controllers have non-zero baselines"

# ---------------------------------------------------------------------------
# Section 2.5 — Escrow + Market-API liveness pre-flight
#
# Without this, an unreachable escrow surfaces as a confusing
# `NEGOTIATION_TIMED_OUT` in §8 (or worse, a silent hang). Likewise an
# unreachable market API surfaces as `intent posted` then "no matches
# ever found". A direct ping narrows the failure to "infra not online"
# before we spawn anything.
# ---------------------------------------------------------------------------
banner "Section 2.5: Escrow + Market-API pre-flight"

cd "$PEER_ALICE"
sphere wallet use alice
if ! sphere swap ping "$ESCROW" 2>&1 | tee "$SNAP/alice-escrow-ping.log"; then
  echo "ASSERT FAIL (escrow-unreachable): $ESCROW did not respond to swap ping" >&2
  echo "Hint: set ESCROW=<addr> to point at a different escrow service." >&2
  exit 1
fi
echo "ASSERT OK (escrow-reachable): $ESCROW responded"

if command -v curl >/dev/null 2>&1; then
  if curl -sf --max-time 10 -o /dev/null "$MARKET_API_URL/api/feed/recent"; then
    echo "ASSERT OK (market-api-reachable): $MARKET_API_URL/api/feed/recent responded"
  else
    echo "WARN (market-api): $MARKET_API_URL/api/feed/recent did not respond (HEAD/GET failed)" >&2
    echo "  The tenants may still work if a different MARKET endpoint is configured." >&2
  fi
else
  echo "WARN (market-api): curl not installed — skipping market-api pre-flight." >&2
fi

# ---------------------------------------------------------------------------
# Section 3 — Spawn alice-trader + bob-trader tenants via per-user local HMs
#
# Each peer brings up its OWN local Host Manager via `sphere trader spawn`.
# The wrapper:
#   - Boots a per-user HM container (scoped to the current wallet's
#     controller pubkey — no shared whitelist, no public-HM dependency).
#   - Spawns the trader tenant against that local HM with the canonical
#     trader template + ESCROW + nametag wired in.
#   - Blocks until the trader image reports ready (--ready-timeout-ms).
#
# This replaces the shared-HM pattern used in earlier revisions of the
# soak. The public HM (@hostmgr-test-01) is reserved for shared infra
# (escrow, faucet) and is not touched here.
# ---------------------------------------------------------------------------
banner "Section 3: Spawn alice-trader + bob-trader tenants (per-user local HM)"

# Extract the tenant's actual address from the spawn JSON. The trader-
# service derives its OWN nametag as `t-<18-hex>` from the instance ID
# (see trader-service/src/trader/main.ts:279) — the operator-supplied
# instance name is metadata only. We use the address the wrapper
# returns so every subsequent ACP call lands at the right tenant.
extract_tenant_address() {
  local log="$1"
  python3 - "$log" <<'PYEOF'
import json, re, sys
path = sys.argv[1]
try:
    raw = open(path, 'r').read()
except Exception:
    sys.exit(1)
m = re.search(r'(\{[\s\S]*\})', raw)
if not m:
    sys.exit(1)
try:
    data = json.loads(m.group(1))
except Exception:
    sys.exit(1)
addr = data.get('tenant_direct_address')
if not addr:
    sys.exit(1)
print(addr)
PYEOF
}

cd "$PEER_ALICE"
sphere wallet use alice
sphere trader spawn \
  --name "$ALICE_TRADER_INSTANCE" \
  --trusted-escrows "$ESCROW" \
  --json \
  2>&1 | tee "$SNAP/alice-trader-spawn.log"

ALICE_TRADER_ADDR="$(extract_tenant_address "$SNAP/alice-trader-spawn.log")"
[[ -n "$ALICE_TRADER_ADDR" ]] \
  || { echo "ASSERT FAIL (alice-trader-spawn): no tenant_direct_address in spawn log" >&2; exit 1; }
# Re-bind ALICE_TRADER_TAG to the tenant's actual nametag (strip leading
# @). The placeholder value set at the top of the script assumed the
# spawn payload's `nametag` field controlled the tenant's identity, but
# the trader-service derives its own `t-<hex>` from the instance ID, so
# every downstream `@$ALICE_TRADER_TAG` usage must use the live value.
ALICE_TRADER_TAG="${ALICE_TRADER_ADDR#@}"
echo "ASSERT OK (alice-trader-spawn): alice-trader instance spawned on alice's local HM"
echo "ALICE_TRADER_ADDR=$ALICE_TRADER_ADDR"
echo "ALICE_TRADER_TAG=$ALICE_TRADER_TAG  (live, derived from spawn)"

cd "$PEER_BOB"
sphere wallet use bob
sphere trader spawn \
  --name "$BOB_TRADER_INSTANCE" \
  --trusted-escrows "$ESCROW" \
  --json \
  2>&1 | tee "$SNAP/bob-trader-spawn.log"

BOB_TRADER_ADDR="$(extract_tenant_address "$SNAP/bob-trader-spawn.log")"
[[ -n "$BOB_TRADER_ADDR" ]] \
  || { echo "ASSERT FAIL (bob-trader-spawn): no tenant_direct_address in spawn log" >&2; exit 1; }
BOB_TRADER_TAG="${BOB_TRADER_ADDR#@}"
echo "ASSERT OK (bob-trader-spawn): bob-trader instance spawned on bob's local HM"
echo "BOB_TRADER_ADDR=$BOB_TRADER_ADDR"
echo "BOB_TRADER_TAG=$BOB_TRADER_TAG  (live, derived from spawn)"

# ---------------------------------------------------------------------------
# Section 4 — ACP smoke probe each tenant (primes the Nostr `since` cursor)
# ---------------------------------------------------------------------------
banner "Section 4: ACP smoke probe each tenant"

wait_for_tenant_running "$PEER_ALICE" alice "$ALICE_TRADER_INSTANCE" \
  "$ALICE_TRADER_TAG" "$SNAP/alice-trader-acp-probe.log" 180
wait_for_tenant_running "$PEER_BOB" bob "$BOB_TRADER_INSTANCE" \
  "$BOB_TRADER_TAG" "$SNAP/bob-trader-acp-probe.log" 180

# Brief settle so each tenant's MarketModule subscription and Nostr
# `since` cursor are fully primed before the controller starts hammering
# create-intent calls.
sleep 5

# ---------------------------------------------------------------------------
# Section 5 — Controllers deposit working capital into their tenants
#
#   alice → alice-trader : 50 UCT
#   bob   → bob-trader   : 4.5 ETH (per #474 scenario; trader keeps
#                          headroom for fee + integer-divisor slippage)
# ---------------------------------------------------------------------------
banner "Section 5: Controllers deposit working capital into their tenants"

cd "$PEER_ALICE"
sphere wallet use alice
# `sphere payments send <recipient> <amount> <coin>` — positional order
# (recipient first). The `--memo` flag isn't supported on the current
# CLI surface; rely on the trader's portfolio-poll to confirm the
# deposit landed.
sphere payments send "@$ALICE_TRADER_TAG" 50 UCT \
  2>&1 | tee "$SNAP/alice-deposit-uct.log"

cd "$PEER_BOB"
sphere wallet use bob
sphere payments send "@$BOB_TRADER_TAG" 4.5 ETH \
  2>&1 | tee "$SNAP/bob-deposit-eth.log"

banner "Section 5: Poll tenant portfolios for deposit confirmation"

cd "$PEER_ALICE"
sphere wallet use alice
deadline=$(( $(date +%s) + TRADER_DEPOSIT_TIMEOUT_S ))
ALICE_TENANT_OK=0
while (( $(date +%s) < deadline )); do
  if with_retry "alice-tenant-portfolio" \
       bash -c "sphere trader portfolio --tenant '@$ALICE_TRADER_TAG' --json --timeout 20000 \
                  2>&1 | tee '$SNAP/alice-tenant-portfolio-pre.log'"; then
    if grep -qE '"(asset|coin|symbol|coin_id|coinId)"[[:space:]]*:[[:space:]]*"UCT"' \
         "$SNAP/alice-tenant-portfolio-pre.log"; then
      echo "INFO: alice-trader portfolio reports a UCT entry"
      ALICE_TENANT_OK=1
      break
    fi
  fi
  echo "  alice-trader UCT deposit not yet visible — sleeping 8 s…"
  sleep 8
done
(( ALICE_TENANT_OK == 1 )) \
  || { echo "ASSERT FAIL (alice-tenant-deposit-uct): alice-trader did not see UCT deposit within ${TRADER_DEPOSIT_TIMEOUT_S}s" >&2; exit 1; }
echo "ASSERT OK (alice-tenant-deposit-uct): alice-trader observed UCT deposit"

cd "$PEER_BOB"
sphere wallet use bob
deadline=$(( $(date +%s) + TRADER_DEPOSIT_TIMEOUT_S ))
BOB_TENANT_OK=0
while (( $(date +%s) < deadline )); do
  if with_retry "bob-tenant-portfolio" \
       bash -c "sphere trader portfolio --tenant '@$BOB_TRADER_TAG' --json --timeout 20000 \
                  2>&1 | tee '$SNAP/bob-tenant-portfolio-pre.log'"; then
    if grep -qE '"(asset|coin|symbol|coin_id|coinId)"[[:space:]]*:[[:space:]]*"ETH"' \
         "$SNAP/bob-tenant-portfolio-pre.log"; then
      echo "INFO: bob-trader portfolio reports an ETH entry"
      BOB_TENANT_OK=1
      break
    fi
  fi
  echo "  bob-trader ETH deposit not yet visible — sleeping 8 s…"
  sleep 8
done
(( BOB_TENANT_OK == 1 )) \
  || { echo "ASSERT FAIL (bob-tenant-deposit-eth): bob-trader did not see ETH deposit within ${TRADER_DEPOSIT_TIMEOUT_S}s" >&2; exit 1; }
echo "ASSERT OK (bob-tenant-deposit-eth): bob-trader observed ETH deposit"

# Snapshot tenant portfolios after deposits for §10 delta math.
cd "$PEER_ALICE"
sphere wallet use alice
with_retry "alice-tenant-portfolio-baseline" \
  bash -c "sphere trader portfolio --tenant '@$ALICE_TRADER_TAG' --json --timeout 20000 \
             2>&1 | tee '$SNAP/alice-tenant-portfolio-baseline.json'"

cd "$PEER_BOB"
sphere wallet use bob
with_retry "bob-tenant-portfolio-baseline" \
  bash -c "sphere trader portfolio --tenant '@$BOB_TRADER_TAG' --json --timeout 20000 \
             2>&1 | tee '$SNAP/bob-tenant-portfolio-baseline.json'"

# ---------------------------------------------------------------------------
# Section 6 — Alice's controller posts the SELL intent
#
# Trade pair: (base=UCT, quote=ETH). Alice sells UCT for ETH.
# Volume:  volume_min == volume_max == 50 UCT (single-fill intent).
# Rate:    [TRADER_RATE_MIN_ETH_PER_UCT, TRADER_RATE_MAX_ETH_PER_UCT].
# Expiry:  1 hour. (Trader caps at 7 days; 1h is plenty for a soak.)
#
# Float UX (post-fix). The shim falls back to bigint smallest-units if
# the CLI rejects floats — see TODO(#474 follow-up) in the header.
# ---------------------------------------------------------------------------
banner "Section 6: Alice posts the SELL intent (float UX)"

cd "$PEER_ALICE"
sphere wallet use alice

create_intent_with_shim "alice-create-intent" \
  "$ALICE_TRADER_TAG" \
  sell UCT ETH \
  "$TRADER_RATE_MIN_ETH_PER_UCT" "$TRADER_RATE_MAX_ETH_PER_UCT" \
  "$TRADER_VOLUME_UCT" \
  3600000 \
  "$SNAP/alice-create-intent.log"

ALICE_INTENT_ID="$(extract_json_id "$SNAP/alice-create-intent.log" intent_id)"
[[ -n "$ALICE_INTENT_ID" ]] \
  || { echo "ASSERT FAIL (alice-intent-id): couldn't extract intent_id from $SNAP/alice-create-intent.log" >&2; exit 1; }
echo "ALICE_INTENT_ID=$ALICE_INTENT_ID"

with_retry "alice-list-intents" \
  bash -c "sphere trader list-intents --tenant '@$ALICE_TRADER_TAG' --json --timeout 20000 \
             2>&1 | tee '$SNAP/alice-list-intents-post-create.json'"
assert_grep "alice-intent-listed" "\"intent_id\"[[:space:]]*:[[:space:]]*\"$ALICE_INTENT_ID\"" \
  "$SNAP/alice-list-intents-post-create.json" \
  || echo "WARN: alice's intent not yet reflected in list-intents (eventually consistent on market post)"

if command -v curl >/dev/null 2>&1; then
  curl -sf --max-time 10 "$MARKET_API_URL/api/feed/recent?limit=50" \
    2>&1 | tee "$SNAP/market-feed-alice.json" >/dev/null || true
fi

# ---------------------------------------------------------------------------
# Section 7 — Bob's controller posts the BUY intent (opposite direction)
#
# Same asset pair (base=UCT, quote=ETH), opposite direction, same volume
# and overlapping rate band. Per protocol-spec.md §5.1 the matching code
# requires:
#   - same base_asset / quote_asset
#   - opposite direction (one buy, one sell)
#   - overlapping rate ranges (alice.rate_min ≤ bob.rate_max AND
#                              bob.rate_min ≤ alice.rate_max)
#   - non-self (different agent_pubkey)
# The agreed rate is floor((overlap_min + overlap_max) / 2).
# ---------------------------------------------------------------------------
banner "Section 7: Bob posts the BUY intent (opposite direction, same pair)"

cd "$PEER_BOB"
sphere wallet use bob

create_intent_with_shim "bob-create-intent" \
  "$BOB_TRADER_TAG" \
  buy UCT ETH \
  "$TRADER_RATE_MIN_ETH_PER_UCT" "$TRADER_RATE_MAX_ETH_PER_UCT" \
  "$TRADER_VOLUME_UCT" \
  3600000 \
  "$SNAP/bob-create-intent.log"

BOB_INTENT_ID="$(extract_json_id "$SNAP/bob-create-intent.log" intent_id)"
[[ -n "$BOB_INTENT_ID" ]] \
  || { echo "ASSERT FAIL (bob-intent-id): couldn't extract intent_id from $SNAP/bob-create-intent.log" >&2; exit 1; }
echo "BOB_INTENT_ID=$BOB_INTENT_ID"

with_retry "bob-list-intents" \
  bash -c "sphere trader list-intents --tenant '@$BOB_TRADER_TAG' --json --timeout 20000 \
             2>&1 | tee '$SNAP/bob-list-intents-post-create.json'"
assert_grep "bob-intent-listed" "\"intent_id\"[[:space:]]*:[[:space:]]*\"$BOB_INTENT_ID\"" \
  "$SNAP/bob-list-intents-post-create.json" \
  || echo "WARN: bob's intent not yet reflected in list-intents (eventually consistent on market post)"

# ---------------------------------------------------------------------------
# Section 8 — Wait for autonomous negotiation + settlement
#
# Each tenant scans the market on a $TRADER_SCAN_INTERVAL_MS-cadence
# (default 30 s). Once they match, they negotiate over NP-0 (NIP-17 DMs),
# both deposit into the escrow, and the escrow pays out. Each side's
# `list-deals` should eventually report a deal with state=completed
# (case may vary across versions; we match case-insensitive).
#
# Poll cadence: every 10 s; deadline TRADER_DEAL_DEADLINE_S (default 10
# min) which is ~20× the scan interval — enough for at least one full
# match cycle plus escrow round-trips even on a slow relay.
# ---------------------------------------------------------------------------
banner "Section 8: Wait for autonomous negotiation + settlement (≤ ${TRADER_DEAL_DEADLINE_S}s)"

deadline=$(( $(date +%s) + TRADER_DEAL_DEADLINE_S ))
ALICE_DEAL_OK=0
BOB_DEAL_OK=0
ALICE_DEAL_LAST=""
BOB_DEAL_LAST=""

while (( $(date +%s) < deadline )); do
  remaining=$(( deadline - $(date +%s) ))
  echo "  --- poll ($(date +%H:%M:%S), remaining ${remaining}s) ---"

  cd "$PEER_ALICE"
  sphere wallet use alice >/dev/null 2>&1
  if with_retry "alice-list-deals" \
       bash -c "sphere trader list-deals --tenant '@$ALICE_TRADER_TAG' --json --timeout 20000 \
                  2>&1 | tee '$SNAP/alice-list-deals-poll.json'"; then
    ALICE_DEAL_LAST="$SNAP/alice-list-deals-poll.json"
    if grep -qiE '"state"[[:space:]]*:[[:space:]]*"completed"' "$ALICE_DEAL_LAST"; then
      ALICE_DEAL_OK=1
    fi
  fi

  cd "$PEER_BOB"
  sphere wallet use bob >/dev/null 2>&1
  if with_retry "bob-list-deals" \
       bash -c "sphere trader list-deals --tenant '@$BOB_TRADER_TAG' --json --timeout 20000 \
                  2>&1 | tee '$SNAP/bob-list-deals-poll.json'"; then
    BOB_DEAL_LAST="$SNAP/bob-list-deals-poll.json"
    if grep -qiE '"state"[[:space:]]*:[[:space:]]*"completed"' "$BOB_DEAL_LAST"; then
      BOB_DEAL_OK=1
    fi
  fi

  if (( ALICE_DEAL_OK == 1 && BOB_DEAL_OK == 1 )); then
    echo "INFO: both sides report a COMPLETED deal"
    cp "$ALICE_DEAL_LAST" "$SNAP/alice-list-deals-final.json"
    cp "$BOB_DEAL_LAST"   "$SNAP/bob-list-deals-final.json"
    break
  fi

  echo "  alice-deal-completed=$ALICE_DEAL_OK bob-deal-completed=$BOB_DEAL_OK — sleeping 10 s…"
  sleep 10
done

if (( ALICE_DEAL_OK == 0 || BOB_DEAL_OK == 0 )); then
  echo "ASSERT FAIL (deal-deadline): alice-completed=$ALICE_DEAL_OK bob-completed=$BOB_DEAL_OK after ${TRADER_DEAL_DEADLINE_S}s" >&2
  echo "--- alice-list-deals-poll.json tail ---" >&2
  tail -40 "$SNAP/alice-list-deals-poll.json" >&2 || true
  echo "--- bob-list-deals-poll.json tail ---" >&2
  tail -40 "$SNAP/bob-list-deals-poll.json" >&2 || true
  exit 1
fi
echo "ASSERT OK (deal-completed): both sides report a COMPLETED deal"

# ---------------------------------------------------------------------------
# Section 9 — Cross-side sanity on agreed rate
#
# We don't constrain on the bigint encoding here (it's been historically
# fluid — see KNOWN LIMITATION #2's deprecated text and TODO(#474 follow-
# up)). Instead we:
#   a) check that both sides agree on the same `rate` value, AND
#   b) leave the band-check to §10 where we compare against ETH deltas
#      directly. This is more robust to rate-encoding changes than
#      asserting on the raw rate integer.
# ---------------------------------------------------------------------------
banner "Section 9: Cross-side sanity on agreed rate"

rc=0

ALICE_AGREED_RATE="$(grep -Eo '"(rate|agreed_rate)"[[:space:]]*:[[:space:]]*"?[0-9.]+"?' \
  "$SNAP/alice-list-deals-final.json" 2>/dev/null \
  | head -1 \
  | sed -E 's/.*:[[:space:]]*"?([0-9.]+)"?.*/\1/' || true)"
BOB_AGREED_RATE="$(grep -Eo '"(rate|agreed_rate)"[[:space:]]*:[[:space:]]*"?[0-9.]+"?' \
  "$SNAP/bob-list-deals-final.json" 2>/dev/null \
  | head -1 \
  | sed -E 's/.*:[[:space:]]*"?([0-9.]+)"?.*/\1/' || true)"

echo "ALICE_AGREED_RATE=$ALICE_AGREED_RATE"
echo "BOB_AGREED_RATE  =$BOB_AGREED_RATE"

if [[ -z "$ALICE_AGREED_RATE" || -z "$BOB_AGREED_RATE" ]]; then
  echo "WARN (agreed-rate-extract): one or both sides did not expose a rate field — leaving rate band check to §10" >&2
elif [[ "$ALICE_AGREED_RATE" != "$BOB_AGREED_RATE" ]]; then
  echo "ASSERT FAIL (agreed-rate-mismatch): alice=$ALICE_AGREED_RATE != bob=$BOB_AGREED_RATE" >&2
  rc=1
else
  echo "ASSERT OK (agreed-rate-matches): both sides agree on rate=$ALICE_AGREED_RATE"
fi

# Volume cross-check. The deal-API surface is HUMAN-DECIMAL (matches
# intents — see trader-service spec / sphere-sdk#534 commit message:
# "intents work in human-readable decimal strings; actual swaps work in
# exact bigint smallest-units"). The expected match is $TRADER_VOLUME_UCT
# verbatim, NOT $EXPECTED_UCT_SMALLEST (which is the bigint smallest-units
# form used downstream in §10's portfolio-delta assertions).
#
# Accept the field under several aliases. Allow fractional values so a
# future partial-fill negotiation surface still matches.
ALICE_AGREED_VOLUME="$(grep -Eo '"(volume|base_amount|amount_base|amount)"[[:space:]]*:[[:space:]]*"?[0-9]+(\.[0-9]+)?"?' \
  "$SNAP/alice-list-deals-final.json" 2>/dev/null \
  | head -1 \
  | sed -E 's/.*:[[:space:]]*"?([0-9.]+)"?.*/\1/' || true)"
BOB_AGREED_VOLUME="$(grep -Eo '"(volume|base_amount|amount_base|amount)"[[:space:]]*:[[:space:]]*"?[0-9]+(\.[0-9]+)?"?' \
  "$SNAP/bob-list-deals-final.json" 2>/dev/null \
  | head -1 \
  | sed -E 's/.*:[[:space:]]*"?([0-9.]+)"?.*/\1/' || true)"
echo "ALICE_AGREED_VOLUME=$ALICE_AGREED_VOLUME"
echo "BOB_AGREED_VOLUME  =$BOB_AGREED_VOLUME"
if [[ -z "$ALICE_AGREED_VOLUME" || -z "$BOB_AGREED_VOLUME" ]]; then
  echo "WARN (volume-extract): one or both sides did not expose a volume field — skipping volume check"
elif [[ "$ALICE_AGREED_VOLUME" != "$BOB_AGREED_VOLUME" ]]; then
  echo "ASSERT FAIL (agreed-volume-mismatch): alice=$ALICE_AGREED_VOLUME != bob=$BOB_AGREED_VOLUME" >&2
  rc=1
elif [[ "$ALICE_AGREED_VOLUME" != "$TRADER_VOLUME_UCT" ]]; then
  echo "ASSERT FAIL (agreed-volume): expected $TRADER_VOLUME_UCT (human-decimal), got $ALICE_AGREED_VOLUME" >&2
  rc=1
else
  echo "ASSERT OK (agreed-volume): both sides agree on volume=$ALICE_AGREED_VOLUME (human-decimal UCT)"
fi

# ---------------------------------------------------------------------------
# Section 10 — Snapshot final tenant portfolios + verify net deltas
#
# Balances reported by `sphere trader portfolio --json` are in smallest-
# units (bigint). The soak computes expected smallest-unit deltas from the
# operator's float rates and volume:
#
#   EXPECTED_UCT_SMALLEST = TRADER_VOLUME_UCT × 10^18
#                          (alice trader -delta == bob trader +delta)
#   ETH_LOW_SMALLEST      = TRADER_RATE_MIN × TRADER_VOLUME × 10^18
#   ETH_HIGH_SMALLEST     = TRADER_RATE_MAX × TRADER_VOLUME × 10^18
#                          (alice trader +ETH delta ∈ [LOW, HIGH])
#                          (bob   trader -ETH delta ∈ [LOW, HIGH])
#
# UCT delta is asserted as strict equality (single-fill intent).
# ETH delta is asserted within-band (the agreed rate can be anywhere in
# the overlap).
# ---------------------------------------------------------------------------
banner "Section 10: Snapshot tenant portfolios + verify net deltas"

cd "$PEER_ALICE"
sphere wallet use alice
with_retry "alice-tenant-portfolio-final" \
  bash -c "sphere trader portfolio --tenant '@$ALICE_TRADER_TAG' --json --timeout 20000 \
             2>&1 | tee '$SNAP/alice-tenant-portfolio-final.json'"

cd "$PEER_BOB"
sphere wallet use bob
with_retry "bob-tenant-portfolio-final" \
  bash -c "sphere trader portfolio --tenant '@$BOB_TRADER_TAG' --json --timeout 20000 \
             2>&1 | tee '$SNAP/bob-tenant-portfolio-final.json'"

alice_tenant_uct_baseline=$(portfolio_balance "$SNAP/alice-tenant-portfolio-baseline.json" UCT)
alice_tenant_eth_baseline=$(portfolio_balance "$SNAP/alice-tenant-portfolio-baseline.json" ETH)
bob_tenant_uct_baseline=$(portfolio_balance "$SNAP/bob-tenant-portfolio-baseline.json" UCT)
bob_tenant_eth_baseline=$(portfolio_balance "$SNAP/bob-tenant-portfolio-baseline.json" ETH)

alice_tenant_uct_final=$(portfolio_balance "$SNAP/alice-tenant-portfolio-final.json" UCT)
alice_tenant_eth_final=$(portfolio_balance "$SNAP/alice-tenant-portfolio-final.json" ETH)
bob_tenant_uct_final=$(portfolio_balance "$SNAP/bob-tenant-portfolio-final.json" UCT)
bob_tenant_eth_final=$(portfolio_balance "$SNAP/bob-tenant-portfolio-final.json" ETH)

echo "alice-trader baseline UCT=$alice_tenant_uct_baseline ETH=$alice_tenant_eth_baseline"
echo "alice-trader final    UCT=$alice_tenant_uct_final   ETH=$alice_tenant_eth_final"
echo "bob-trader   baseline UCT=$bob_tenant_uct_baseline   ETH=$bob_tenant_eth_baseline"
echo "bob-trader   final    UCT=$bob_tenant_uct_final     ETH=$bob_tenant_eth_final"

alice_tenant_uct_delta=$(python3 -c "print(int('$alice_tenant_uct_baseline') - int('$alice_tenant_uct_final'))")  # POSITIVE = sold
alice_tenant_eth_delta=$(python3 -c "print(int('$alice_tenant_eth_final') - int('$alice_tenant_eth_baseline'))")  # POSITIVE = received
bob_tenant_uct_delta=$(python3 -c   "print(int('$bob_tenant_uct_final')   - int('$bob_tenant_uct_baseline'))")    # POSITIVE = received
bob_tenant_eth_delta=$(python3 -c   "print(int('$bob_tenant_eth_baseline') - int('$bob_tenant_eth_final'))")     # POSITIVE = sold

echo "alice-trader UCT delta (sold):     $alice_tenant_uct_delta  (expected $EXPECTED_UCT_SMALLEST)"
echo "bob-trader   UCT delta (received): $bob_tenant_uct_delta    (expected $EXPECTED_UCT_SMALLEST)"
echo "alice-trader ETH delta (received): $alice_tenant_eth_delta  (band [$ETH_LOW_SMALLEST, $ETH_HIGH_SMALLEST])"
echo "bob-trader   ETH delta (sold):     $bob_tenant_eth_delta    (band [$ETH_LOW_SMALLEST, $ETH_HIGH_SMALLEST])"

# Strict UCT deltas (single-fill).
[[ "$alice_tenant_uct_delta" == "$EXPECTED_UCT_SMALLEST" ]] \
  || { echo "ASSERT FAIL (alice-trader-uct-delta): expected $EXPECTED_UCT_SMALLEST, got $alice_tenant_uct_delta" >&2; rc=1; }
[[ "$bob_tenant_uct_delta"   == "$EXPECTED_UCT_SMALLEST" ]] \
  || { echo "ASSERT FAIL (bob-trader-uct-delta):   expected $EXPECTED_UCT_SMALLEST, got $bob_tenant_uct_delta" >&2; rc=1; }
(( rc == 0 )) && echo "ASSERT OK (uct-deltas): both UCT deltas = $EXPECTED_UCT_SMALLEST"

# Cross-side ETH-delta symmetry.
eth_delta_match=$(python3 -c "print(1 if int('$alice_tenant_eth_delta') == int('$bob_tenant_eth_delta') else 0)")
if [[ "$eth_delta_match" != "1" ]]; then
  echo "ASSERT FAIL (eth-delta-symmetry): alice=$alice_tenant_eth_delta != bob=$bob_tenant_eth_delta" >&2
  rc=1
else
  echo "ASSERT OK (eth-delta-symmetry): |alice ETH delta| == |bob ETH delta| == $alice_tenant_eth_delta"
fi

# In-band ETH delta — alice's positive delta must lie in
# [ETH_LOW_SMALLEST, ETH_HIGH_SMALLEST]. Use python for arbitrary precision.
in_band=$(python3 -c "
a = int('$alice_tenant_eth_delta')
lo = int('$ETH_LOW_SMALLEST')
hi = int('$ETH_HIGH_SMALLEST')
print(1 if lo <= a <= hi else 0)
")
if [[ "$in_band" == "1" ]]; then
  echo "ASSERT OK (eth-delta-in-band): $alice_tenant_eth_delta ∈ [$ETH_LOW_SMALLEST, $ETH_HIGH_SMALLEST]"
else
  echo "ASSERT FAIL (eth-delta-in-band): $alice_tenant_eth_delta NOT in [$ETH_LOW_SMALLEST, $ETH_HIGH_SMALLEST]" >&2
  echo "  HINT (TODO(#474 follow-up)): if the CLI still requires bigint smallest-units and is" >&2
  echo "  treating your rate floats as raw integers, the band assertion will be far off." >&2
  echo "  Compare against ETH_MID_SMALLEST=$ETH_MID_SMALLEST for a sanity check." >&2
  rc=1
fi

# ---------------------------------------------------------------------------
# Section 11 — Cleanup hygiene
#
#   - Cancel any leftover non-terminal intents on both sides (the matched
#     intents should already be FILLED, but cancel ACTIVE/MATCHING/
#     NEGOTIATING/PARTIALLY_FILLED as a defensive sweep).
#   - Verify no deals in FAILED state.
#   - Poison-pill scan: SERIALIZATION_ERROR / VERIFICATION_FAILED /
#     DUPLICATE_BUNDLE_MEMBERSHIP from the swap-roundtrip lineage, plus
#     trader-specific terms (STRATEGY_MISMATCH, RATE_UNACCEPTABLE,
#     NEGOTIATION_TIMED_OUT, MATCHING_FAILED).
# ---------------------------------------------------------------------------
banner "Section 11: Cleanup hygiene + poison-pill scan"

cancel_active_intents() {
  local peer="$1" wallet="$2" tenant_nt="$3" tag="$4"
  cd "$peer"
  sphere wallet use "$wallet" >/dev/null 2>&1
  with_retry "$tag-list-intents-cleanup" \
    bash -c "sphere trader list-intents --tenant '@$tenant_nt' --json --timeout 20000 \
               2>&1 | tee '$SNAP/$tag-list-intents-cleanup.json'" || return 0
  python3 - "$SNAP/$tag-list-intents-cleanup.json" <<'PYEOF' 2>/dev/null | while read -r intent_id; do
import json, sys, re
path = sys.argv[1]
try:
    with open(path, 'r') as f:
        raw = f.read()
except Exception:
    sys.exit(0)
m = re.search(r'(\{|\[)', raw)
if not m:
    sys.exit(0)
try:
    doc = json.loads(raw[m.start():])
except Exception:
    sys.exit(0)
def walk(obj):
    if isinstance(obj, dict):
        if 'intent_id' in obj and 'state' in obj:
            if str(obj['state']).upper() in ('ACTIVE','MATCHING','NEGOTIATING','PARTIALLY_FILLED'):
                print(obj['intent_id'])
        for v in obj.values():
            walk(v)
    elif isinstance(obj, list):
        for v in obj:
            walk(v)
walk(doc)
PYEOF
    [[ -z "$intent_id" ]] && continue
    echo "INFO: cancelling lingering intent $intent_id on @$tenant_nt"
    with_retry "$tag-cancel-$intent_id" \
      bash -c "sphere trader cancel-intent --tenant '@$tenant_nt' --intent-id '$intent_id' --json --timeout 20000 \
                 2>&1 | tee '$SNAP/$tag-cancel-$intent_id.log'" || true
  done
  return 0
}

cancel_active_intents "$PEER_ALICE" alice "$ALICE_TRADER_TAG" alice
cancel_active_intents "$PEER_BOB"   bob   "$BOB_TRADER_TAG"   bob

for side in alice bob; do
  if grep -qiE '"state"[[:space:]]*:[[:space:]]*"(FAILED|failed)"' "$SNAP/${side}-list-deals-final.json"; then
    echo "ASSERT FAIL (${side}-failed-deal): a deal in FAILED state exists in ${side}-list-deals-final.json" >&2
    rc=1
  else
    echo "ASSERT OK (${side}-no-failed-deals): no FAILED deals on $side"
  fi
done

# Cross-hop poison-pill scan. `grep -lE` + `|| true` so a clean run
# doesn't trip pipefail.
POISON_FILES=$(grep -lE "SERIALIZATION_ERROR|VERIFICATION_FAILED|DUPLICATE_BUNDLE_MEMBERSHIP|STRATEGY_MISMATCH|RATE_UNACCEPTABLE|NEGOTIATION_TIMED_OUT|MATCHING_FAILED" \
  "$SNAP"/*.log "$SNAP"/*.json 2>/dev/null || true)
if [[ -n "$POISON_FILES" ]]; then
  POISON_HITS=$(printf '%s\n' "$POISON_FILES" | wc -l)
  echo "ASSERT FAIL (poison-pill): found $POISON_HITS log(s) with poison-pill errors" >&2
  printf '%s\n' "$POISON_FILES" >&2
  rc=1
else
  echo "ASSERT OK (poison-pill-clean): no poison-pill errors across any log"
fi

if (( rc != 0 )); then
  banner "FAIL — trader round-trip soak: see ASSERT FAIL lines above"
  exit "$rc"
fi

# ---------------------------------------------------------------------------
# Section 12 — Final banner
#
# Tenant cleanup (`sphere trader stop`) happens in `cleanup()` on EXIT.
# Default behavior: stop both tenants on exit and auto-tear-down each
# peer's per-user local HM. KEEP_TENANTS=1 forwards `--keep-hm` so the
# HM containers stay running for inspection.
# ---------------------------------------------------------------------------
banner "ALL GREEN — trader round-trip succeeded"
echo "Summary (smallest-unit deltas):"
echo "  alice-trader UCT delta = -$alice_tenant_uct_delta  (expected -$EXPECTED_UCT_SMALLEST)"
echo "  bob-trader   UCT delta = +$bob_tenant_uct_delta    (expected +$EXPECTED_UCT_SMALLEST)"
echo "  alice-trader ETH delta = +$alice_tenant_eth_delta  (band [+$ETH_LOW_SMALLEST, +$ETH_HIGH_SMALLEST])"
echo "  bob-trader   ETH delta = -$bob_tenant_eth_delta    (band [-$ETH_HIGH_SMALLEST, -$ETH_LOW_SMALLEST])"
[[ -n "${ALICE_AGREED_RATE:-}" ]] && echo "  agreed rate (as reported) = $ALICE_AGREED_RATE  (operator floats: [$TRADER_RATE_MIN_ETH_PER_UCT, $TRADER_RATE_MAX_ETH_PER_UCT])"
exit 0
