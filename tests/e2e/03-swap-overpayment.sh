#!/usr/bin/env bash
# =============================================================================
# 03-swap-overpayment.sh — Large swap with generous topup (10x)
#
# Tests that the escrow handles a swap where parties have 10x more tokens than
# needed. The deposit path MUST split the token and preserve the change.
# After deposit: each party must still hold 9/10 of their original balance.
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

# --- Generous topup (10x the swap amount) ---
log ""; log "=== Topup ==="
topup_wallet "$ALICE" BTC 50     # swap needs 5
topup_wallet "$BOB" ETH 500     # swap needs 50

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

# --- CRITICAL: Verify change tokens survived deposit ---
# This is THE key assertion for this test. If token splitting is broken,
# the entire 50 BTC / 500 ETH token is consumed instead of just 5 / 50.
log ""; log "=== Verify post-deposit balances (change tokens MUST exist) ==="
assert_deposit_change "$ALICE" BTC "Alice BTC after depositing 5 of 50"
assert_deposit_change "$BOB" ETH "Bob ETH after depositing 50 of 500"

# --- Wait for completion ---
log ""; log "=== Waiting for swap completion ==="
FINAL=$(wait_swap_progress "$ALICE" "${SWAP_ID:0:8}" "completed|failed|cancelled|pruned") || true
if [[ "$FINAL" == "completed" || "$FINAL" == "pruned" ]]; then
  ok "Large swap completed"
else
  fail "Swap did not complete (final: $FINAL)"
fi

# --- Verify final balances ---
log ""; log "=== Verify balances ==="
ALICE_BAL=$(cli_as "$ALICE" balance --finalize 2>&1) || true
log "Alice balance:"
echo "$ALICE_BAL" | grep -E "BTC|ETH" || echo "$ALICE_BAL" | tail -5

# Alice should have: ETH from payout + remaining BTC from change
if echo "$ALICE_BAL" | grep -q "ETH"; then ok "Alice received ETH from swap"; else fail "Alice missing ETH"; fi
if echo "$ALICE_BAL" | grep -q "BTC"; then
  ok "Alice kept remaining BTC (change token)"
else
  fail "Alice lost all BTC — change token missing after split"
fi

BOB_BAL=$(cli_as "$BOB" balance --finalize 2>&1) || true
log "Bob balance:"
echo "$BOB_BAL" | grep -E "BTC|ETH" || echo "$BOB_BAL" | tail -5

if echo "$BOB_BAL" | grep -q "BTC"; then ok "Bob received BTC from swap"; else fail "Bob missing BTC"; fi
if echo "$BOB_BAL" | grep -q "ETH"; then
  ok "Bob kept remaining ETH (change token)"
else
  fail "Bob lost all ETH — change token missing after split"
fi

summary
[[ $FAIL -gt 0 ]] && exit 1
exit 0
