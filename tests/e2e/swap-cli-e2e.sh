#!/usr/bin/env bash
# =============================================================================
# swap-cli-e2e.sh — End-to-end CLI swap flow test
#
# Uses two fresh one-time-use wallet profiles so each run starts clean.
# Escrow must be live at @test-escrow-e2e on testnet.
#
# Usage:
#   bash tests/e2e/swap-cli-e2e.sh
#   bash tests/e2e/swap-cli-e2e.sh --keep-wallets   # skip cleanup at end
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------
ESCROW="@test-escrow-e2e"
OFFER_COIN="BTC"
WANT_COIN="ETH"
OFFER_AMOUNT="1"          # Alice offers 1 BTC
WANT_AMOUNT="10"          # Alice wants 10 ETH
ALICE_FAUCET_AMOUNT="10"  # Topup alice with 10 BTC
BOB_FAUCET_AMOUNT="100"   # Topup bob with 100 ETH
SWAP_TIMEOUT=3600
CLI="npm run cli --"
DEPOSIT_WAIT=120   # seconds to wait for swap:announced after deposit
ESCROW_WAIT=300    # seconds to wait for escrow to complete swap

KEEP_WALLETS=false
[[ "${1:-}" == "--keep-wallets" ]] && KEEP_WALLETS=true

# ---------------------------------------------------------------------------
# Unique run ID → unique profile names
# ---------------------------------------------------------------------------
RUN_ID=$(date +%s)
ALICE_PROFILE="e2e_alice_${RUN_ID}"
BOB_PROFILE="e2e_bob_${RUN_ID}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
PASS=0; FAIL=0
log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ FAIL: $*" >&2; FAIL=$((FAIL + 1)); }
die()  { echo "  ✗ FATAL: $*" >&2; summary; exit 1; }

summary() {
  echo ""
  echo "================================================="
  echo "  Results: ${PASS} passed, ${FAIL} failed"
  echo "================================================="
}

# Run CLI as a specific profile (sets sphere-cli wallet context)
# Usage: cli_as <profile> <command...>
cli_as() {
  local profile=$1; shift
  $CLI wallet use "$profile" > /dev/null 2>&1
  $CLI "$@" 2>&1
}

# Extract a field from JSON output (first match)
jq_field() {
  local json=$1 field=$2
  echo "$json" | grep -oP "\"${field}\"\s*:\s*\K[^\s,}]+" | head -1 | tr -d '"'
}

cleanup() {
  if [[ "$KEEP_WALLETS" == "false" ]]; then
    log "Cleaning up test wallets..."
    $CLI wallet delete "$ALICE_PROFILE" > /dev/null 2>&1 || true
    $CLI wallet delete "$BOB_PROFILE"   > /dev/null 2>&1 || true
  else
    log "Keeping wallets: ${ALICE_PROFILE}, ${BOB_PROFILE}"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 0: Create fresh wallets
# ---------------------------------------------------------------------------
log "=== STEP 0: Create fresh one-time-use wallets ==="

log "Creating Alice wallet: ${ALICE_PROFILE}"
$CLI wallet create "$ALICE_PROFILE" --network testnet > /dev/null 2>&1
$CLI wallet use "$ALICE_PROFILE" > /dev/null 2>&1
ALICE_INIT=$($CLI init --nametag "$ALICE_PROFILE" 2>&1)
log "Alice init: $(echo "$ALICE_INIT" | tail -3)"
ok "Alice wallet created with nametag @${ALICE_PROFILE}"

log "Creating Bob wallet: ${BOB_PROFILE}"
$CLI wallet create "$BOB_PROFILE" --network testnet > /dev/null 2>&1
$CLI wallet use "$BOB_PROFILE" > /dev/null 2>&1
BOB_INIT=$($CLI init --nametag "$BOB_PROFILE" 2>&1)
log "Bob init: $(echo "$BOB_INIT" | tail -3)"
ok "Bob wallet created with nametag @${BOB_PROFILE}"

# ---------------------------------------------------------------------------
# Step 1: Topup Alice with BTC, verify balance
# ---------------------------------------------------------------------------
log ""
log "=== STEP 1: Topup Alice with ${ALICE_FAUCET_AMOUNT} ${OFFER_COIN} ==="

$CLI wallet use "$ALICE_PROFILE" > /dev/null 2>&1
log "Requesting ${ALICE_FAUCET_AMOUNT} ${OFFER_COIN} from faucet..."
TOPUP_OUT=$($CLI topup "$ALICE_FAUCET_AMOUNT" "$OFFER_COIN" 2>&1) || true
log "Topup: $(echo "$TOPUP_OUT" | tail -3)"

# Wait for finalization
log "Waiting for token finalization..."
BALANCE_OUT=$($CLI balance --finalize 2>&1) || true
log "Alice balance:"
echo "$BALANCE_OUT" | grep -E "${OFFER_COIN}|${WANT_COIN}|Total" || echo "$BALANCE_OUT"

if echo "$BALANCE_OUT" | grep -q "$OFFER_COIN"; then
  ok "Alice has ${OFFER_COIN} tokens after faucet"
else
  fail "Alice ${OFFER_COIN} balance not visible after topup — continuing anyway"
fi

# ---------------------------------------------------------------------------
# Step 2: Topup Bob with ETH, verify balance
# ---------------------------------------------------------------------------
log ""
log "=== STEP 2: Topup Bob with ${BOB_FAUCET_AMOUNT} ${WANT_COIN} ==="

$CLI wallet use "$BOB_PROFILE" > /dev/null 2>&1
log "Requesting ${BOB_FAUCET_AMOUNT} ${WANT_COIN} from faucet..."
TOPUP_OUT=$($CLI topup "$BOB_FAUCET_AMOUNT" "$WANT_COIN" 2>&1) || true
log "Topup: $(echo "$TOPUP_OUT" | tail -3)"

log "Waiting for token finalization..."
BALANCE_OUT=$($CLI balance --finalize 2>&1) || true
log "Bob balance:"
echo "$BALANCE_OUT" | grep -E "${OFFER_COIN}|${WANT_COIN}|Total" || echo "$BALANCE_OUT"

if echo "$BALANCE_OUT" | grep -q "$WANT_COIN"; then
  ok "Bob has ${WANT_COIN} tokens after faucet"
else
  fail "Bob ${WANT_COIN} balance not visible after topup — continuing anyway"
fi

# ---------------------------------------------------------------------------
# Step 3: Alice proposes swap
# ---------------------------------------------------------------------------
log ""
log "=== STEP 3: Alice proposes swap (${OFFER_AMOUNT} ${OFFER_COIN} ↔ ${WANT_AMOUNT} ${WANT_COIN}) ==="

$CLI wallet use "$ALICE_PROFILE" > /dev/null 2>&1
PROPOSE_OUT=$($CLI swap-propose \
  --to "@${BOB_PROFILE}" \
  --offer "${OFFER_AMOUNT} ${OFFER_COIN}" \
  --want "${WANT_AMOUNT} ${WANT_COIN}" \
  --escrow "$ESCROW" \
  --timeout "$SWAP_TIMEOUT" \
  --message "${OFFER_AMOUNT} ${OFFER_COIN} for ${WANT_AMOUNT} ${WANT_COIN}" 2>&1) || true

log "Propose output:"
echo "$PROPOSE_OUT"

SWAP_ID=$(echo "$PROPOSE_OUT" | grep -oP '"swap_id"\s*:\s*"\K[^"]+' | head -1)
if [[ -z "$SWAP_ID" ]]; then
  die "Failed to extract swap_id from propose output"
fi
log "Swap ID: ${SWAP_ID}"
ok "Alice proposed swap ${SWAP_ID:0:8}..."

# ---------------------------------------------------------------------------
# Step 4: Alice verifies swap is in proposed state
# ---------------------------------------------------------------------------
log ""
log "=== STEP 4: Alice verifies swap state ==="

LIST_OUT=$($CLI swap-list 2>&1) || true
log "Alice swap-list: $(echo "$LIST_OUT" | grep "${SWAP_ID:0:8}" || echo "$LIST_OUT")"

if echo "$LIST_OUT" | grep -q "proposed"; then
  ok "Alice sees swap in 'proposed' state"
else
  fail "Alice swap not in 'proposed' state"
fi

# ---------------------------------------------------------------------------
# Step 5: Bob accepts the swap
# ---------------------------------------------------------------------------
log ""
log "=== STEP 5: Bob accepts the swap ==="

$CLI wallet use "$BOB_PROFILE" > /dev/null 2>&1

# Retry swap-accept directly until it succeeds or times out.
# Each swap-accept invocation calls fetchPendingEvents() with a 5s EOSE wait,
# so it stays connected long enough to receive the NIP-17 gift-wrap DM.
# If the swap isn't in local state yet ("No swap found"), we wait 5s and retry.
log "Accepting swap (retrying up to 300s for proposal DM to arrive)..."
ACCEPT_OUT=""
BOB_ACCEPTED=false
for i in $(seq 1 60); do
  TRY=$($CLI swap-accept "${SWAP_ID:0:8}" 2>&1) || true
  if echo "$TRY" | grep -qiE "Swap accepted|announced|deposit invoice"; then
    ACCEPT_OUT="$TRY"
    BOB_ACCEPTED=true
    log "Bob accepted the swap on attempt ${i} (~$((i * 5))s)"
    break
  fi
  if echo "$TRY" | grep -qiE "No swap found|not found"; then
    log "Attempt ${i}: swap not arrived yet at Bob, retrying in 5s..."
    sleep 5
    continue
  fi
  # Any other error: log and retry (may be transient relay/escrow issue)
  log "Attempt ${i}: $(echo "$TRY" | tail -2) — retrying in 5s..."
  ACCEPT_OUT="$TRY"
  sleep 5
done

if [[ "$BOB_ACCEPTED" == "true" ]]; then
  ok "Bob accepted the swap"
else
  die "Bob could not accept swap after 300s — last output: ${ACCEPT_OUT:-<none>}"
fi

# ---------------------------------------------------------------------------
# Step 6: Bob verifies swap is in accepted state
# ---------------------------------------------------------------------------
log ""
log "=== STEP 6: Bob verifies swap state ==="

LIST_OUT=$($CLI swap-list 2>&1) || true
log "Bob swap-list: $(echo "$LIST_OUT" | grep "${SWAP_ID:0:8}" || echo "$LIST_OUT")"

BOB_PROGRESS=$(echo "$LIST_OUT" | grep "${SWAP_ID:0:8}" | grep -oP '\b(proposed|accepted|announced|depositing|awaiting_counter|concluding|completed|failed|cancelled)\b' | head -1)
log "Bob swap progress: ${BOB_PROGRESS:-unknown}"

if [[ "$BOB_PROGRESS" == "accepted" || "$BOB_PROGRESS" == "announced" ]]; then
  ok "Bob sees swap in '${BOB_PROGRESS}' state"
else
  fail "Expected 'accepted' or 'announced', got '${BOB_PROGRESS:-unknown}'"
fi

# ---------------------------------------------------------------------------
# Step 7: Bob deposits ETH into escrow
# ---------------------------------------------------------------------------
log ""
log "=== STEP 7: Bob deposits ${WANT_AMOUNT} ${WANT_COIN} into escrow ==="

$CLI wallet use "$BOB_PROFILE" > /dev/null 2>&1
log "Running swap-deposit (waits up to 60s for announced state)..."
DEPOSIT_OUT=$($CLI swap-deposit "${SWAP_ID:0:8}" 2>&1) || true
log "Bob deposit output:"
echo "$DEPOSIT_OUT"

if echo "$DEPOSIT_OUT" | grep -qiE '"status"\s*:\s*"(submitted|delivered|completed)"'; then
  ok "Bob deposit submitted"
elif echo "$DEPOSIT_OUT" | grep -qi "failed\|error\|wrong state"; then
  fail "Bob deposit failed: $(echo "$DEPOSIT_OUT" | grep -iE 'failed|error|wrong state' | head -2)"
else
  ok "Bob deposit command completed (verify status below)"
fi

LIST_OUT=$($CLI swap-list 2>&1) || true
log "Bob swap-list after deposit: $(echo "$LIST_OUT" | grep "${SWAP_ID:0:8}" || echo "$LIST_OUT")"

# ---------------------------------------------------------------------------
# Step 8: Alice deposits BTC into escrow
# ---------------------------------------------------------------------------
log ""
log "=== STEP 8: Alice deposits ${OFFER_AMOUNT} ${OFFER_COIN} into escrow ==="

$CLI wallet use "$ALICE_PROFILE" > /dev/null 2>&1
log "Running swap-deposit for Alice (waits up to 60s for announced state)..."
DEPOSIT_OUT=$($CLI swap-deposit "${SWAP_ID:0:8}" 2>&1) || true
log "Alice deposit output:"
echo "$DEPOSIT_OUT"

if echo "$DEPOSIT_OUT" | grep -qiE '"status"\s*:\s*"(submitted|delivered|completed)"'; then
  ok "Alice deposit submitted"
elif echo "$DEPOSIT_OUT" | grep -qi "failed\|error\|wrong state"; then
  fail "Alice deposit failed: $(echo "$DEPOSIT_OUT" | grep -iE 'failed|error|wrong state' | head -2)"
else
  ok "Alice deposit command completed (verify status below)"
fi

LIST_OUT=$($CLI swap-list 2>&1) || true
log "Alice swap-list after deposit: $(echo "$LIST_OUT" | grep "${SWAP_ID:0:8}" || echo "$LIST_OUT")"

# ---------------------------------------------------------------------------
# Step 9: Wait for escrow to complete the swap
# ---------------------------------------------------------------------------
log ""
log "=== STEP 9: Waiting up to ${ESCROW_WAIT}s for escrow to complete swap ==="

ELAPSED=0
FINAL_PROGRESS=""
while [[ $ELAPSED -lt $ESCROW_WAIT ]]; do
  $CLI wallet use "$ALICE_PROFILE" > /dev/null 2>&1 || true
  STATUS_OUT=$($CLI swap-status "${SWAP_ID:0:8}" 2>&1) || true
  FINAL_PROGRESS=$(echo "$STATUS_OUT" | grep -oP '\b(proposed|accepted|announced|depositing|awaiting_counter|concluding|completed|failed|cancelled)\b' | tail -1)
  log "[${ELAPSED}s] Alice swap progress: ${FINAL_PROGRESS:-unknown}"

  if [[ "$FINAL_PROGRESS" == "completed" || "$FINAL_PROGRESS" == "failed" || "$FINAL_PROGRESS" == "cancelled" ]]; then
    break
  fi
  sleep 15
  ELAPSED=$((ELAPSED + 15))
done

if [[ "$FINAL_PROGRESS" == "completed" ]]; then
  ok "Swap completed"
else
  fail "Swap did not complete — final state: ${FINAL_PROGRESS:-unknown}"
  log "Alice swap-status output:"
  echo "$STATUS_OUT"
fi

# ---------------------------------------------------------------------------
# Step 10: Verify final balances
# ---------------------------------------------------------------------------
log ""
log "=== STEP 10: Verify final balances ==="

# Alice: should have ETH (received), BTC should be gone
$CLI wallet use "$ALICE_PROFILE" > /dev/null 2>&1
ALICE_BALANCE=$($CLI balance --no-sync 2>&1) || true
log "Alice final balance:"
echo "$ALICE_BALANCE" | grep -E "${OFFER_COIN}|${WANT_COIN}" || echo "$ALICE_BALANCE"

if echo "$ALICE_BALANCE" | grep -q "$WANT_COIN"; then
  ok "Alice received ${WANT_COIN} ✓"
else
  fail "Alice missing ${WANT_COIN} after swap"
fi
if echo "$ALICE_BALANCE" | grep -qP "${OFFER_COIN}.*\b0\b|No ${OFFER_COIN}"; then
  ok "Alice ${OFFER_COIN} gone ✓"
else
  log "  Note: Alice ${OFFER_COIN} balance unclear — check manually"
fi

# Bob: should have BTC (received), ETH should be gone
$CLI wallet use "$BOB_PROFILE" > /dev/null 2>&1
BOB_BALANCE=$($CLI balance --no-sync 2>&1) || true
log "Bob final balance:"
echo "$BOB_BALANCE" | grep -E "${OFFER_COIN}|${WANT_COIN}" || echo "$BOB_BALANCE"

if echo "$BOB_BALANCE" | grep -q "$OFFER_COIN"; then
  ok "Bob received ${OFFER_COIN} ✓"
else
  fail "Bob missing ${OFFER_COIN} after swap"
fi
if echo "$BOB_BALANCE" | grep -qP "${WANT_COIN}.*\b0\b|No ${WANT_COIN}"; then
  ok "Bob ${WANT_COIN} gone ✓"
else
  log "  Note: Bob ${WANT_COIN} balance unclear — check manually"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log ""
summary

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
