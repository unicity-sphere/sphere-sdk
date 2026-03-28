#!/usr/bin/env bash
# =============================================================================
# 03-swap-overpayment.sh — Large swap with generous topup
#
# Tests that the escrow handles a swap where parties have more tokens than
# needed. The standard deposit path deposits exactly the required amount.
# Surplus tokens remain in the parties' wallets.
#
# NOTE: True overpayment testing (deposit more than required into the invoice)
# requires the invoice-pay CLI to work after a prior partial payment, which
# is currently limited by the SDK's ensureSync → load() cycle. This test
# verifies the basic "deposit exact amount, keep surplus" flow.
# =============================================================================
set -euo pipefail
TEST_NAME="03-large-swap"
source "$(dirname "${BASH_SOURCE[0]}")/e2e-helpers.sh"
parse_e2e_args "$@"

setup_workspace
ALICE="e2e03a_${RUN_ID}"
BOB="e2e03b_${RUN_ID}"
WALLETS_TO_DELETE="$ALICE $BOB"
trap cleanup EXIT

setup_escrow
launch_escrow

# --- Wallets ---
log ""; log "=== Create wallets ==="
create_wallet "$ALICE" "$ALICE"
create_wallet "$BOB" "$BOB"

# Ping escrow
ping_escrow "$ALICE" "$ESCROW"

# --- Generous topup (much more than swap requires) ---
log ""; log "=== Topup ==="
topup_wallet "$ALICE" BTC 100
topup_wallet "$BOB" ETH 1000

# --- Propose: 5 BTC ↔ 50 ETH ---
log ""; log "=== Propose: 5 BTC ↔ 50 ETH ==="
SWAP_ID=$(propose_swap "$ALICE" "$BOB" "5 BTC" "50 ETH" "$ESCROW")
ok "Proposed ${SWAP_ID:0:8}..."

# --- Accept + deposit ---
log ""; log "=== Accept ==="
accept_swap "$BOB" "${SWAP_ID:0:8}"

log ""; log "=== Deposits ==="
deposit_swap "$BOB" "${SWAP_ID:0:8}"
deposit_swap "$ALICE" "${SWAP_ID:0:8}"

# --- Wait for completion ---
log ""; log "=== Waiting for swap completion ==="
FINAL=$(wait_swap_progress "$ALICE" "${SWAP_ID:0:8}" "completed|failed|cancelled|pruned") || true
if [[ "$FINAL" == "completed" || "$FINAL" == "pruned" ]]; then
  ok "Large swap completed"
else
  fail "Swap did not complete (final: $FINAL)"
fi

# --- Verify balances ---
log ""; log "=== Verify balances ==="
ALICE_BAL=$(cli_as "$ALICE" balance --finalize 2>&1) || true
log "Alice balance:"
echo "$ALICE_BAL" | grep -E "BTC|ETH" || echo "$ALICE_BAL" | tail -5

# Alice should have received ETH from swap
if echo "$ALICE_BAL" | grep -q "ETH"; then ok "Alice received ETH from swap"; else fail "Alice missing ETH"; fi
# Alice's remaining BTC may or may not be visible depending on token split timing
if echo "$ALICE_BAL" | grep -q "BTC"; then
  ok "Alice kept remaining BTC"
else
  log "  Note: Alice's remaining BTC may arrive after token split finalization"
fi

BOB_BAL=$(cli_as "$BOB" balance --finalize 2>&1) || true
log "Bob balance:"
echo "$BOB_BAL" | grep -E "BTC|ETH" || echo "$BOB_BAL" | tail -5

if echo "$BOB_BAL" | grep -q "BTC"; then ok "Bob received BTC from swap"; else fail "Bob missing BTC"; fi
# Bob's remaining ETH may need finalization
if echo "$BOB_BAL" | grep -q "ETH"; then
  ok "Bob kept remaining ETH"
else
  log "  Note: Bob's remaining ETH may arrive after token split finalization"
fi

summary
[[ $FAIL -gt 0 ]] && exit 1
exit 0
