#!/usr/bin/env bash
# =============================================================================
# 03-swap-overpayment.sh — Large swap with generous topup (10x)
#
# Tests that the escrow handles a swap where parties have 10x more tokens than
# needed. The deposit path MUST split the token and preserve the change.
# Verifies exact balance changes at every stage.
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
topup_wallet "$ALICE" BTC 50     # swap needs 5 → expect 45 remaining
topup_wallet "$BOB" ETH 500     # swap needs 50 → expect 450 remaining

# Record pre-swap balances
ALICE_BTC_BEFORE=$(get_coin_amount "$ALICE" BTC)
BOB_ETH_BEFORE=$(get_coin_amount "$BOB" ETH)
log "Before: Alice BTC=${ALICE_BTC_BEFORE}, Bob ETH=${BOB_ETH_BEFORE}"

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

# --- CRITICAL: Verify exact change amounts after deposit ---
log ""; log "=== Verify post-deposit balances (exact amounts) ==="
assert_balance "$ALICE" BTC "45" "Alice BTC after depositing 5 of 50"
assert_balance "$BOB" ETH "450" "Bob ETH after depositing 50 of 500"

# --- Wait for completion ---
log ""; log "=== Waiting for swap completion ==="
FINAL=$(wait_swap_progress "$ALICE" "${SWAP_ID:0:8}" "completed|failed|cancelled|pruned") || true
if [[ "$FINAL" == "completed" || "$FINAL" == "pruned" ]]; then
  ok "Large swap completed"
else
  fail "Swap did not complete (final: $FINAL)"
fi

# --- Verify exact final balances ---
log ""; log "=== Verify final balances ==="
cli_as "$ALICE" balance --finalize > /dev/null 2>&1 || true
cli_as "$BOB" balance --finalize > /dev/null 2>&1 || true

# Alice: 50 BTC - 5 deposited = 45 BTC remaining + 50 ETH payout
assert_balance "$ALICE" BTC "45" "Alice BTC remaining (50 - 5)"
assert_balance "$ALICE" ETH "50" "Alice ETH payout"
# Bob: 500 ETH - 50 deposited = 450 ETH remaining + 5 BTC payout
assert_balance "$BOB" ETH "450" "Bob ETH remaining (500 - 50)"
assert_balance "$BOB" BTC "5" "Bob BTC payout"

summary
[[ $FAIL -gt 0 ]] && exit 1
exit 0
