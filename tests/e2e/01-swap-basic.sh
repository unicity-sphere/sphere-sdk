#!/usr/bin/env bash
# =============================================================================
# 01-swap-basic.sh — Basic happy-path swap
#
# Alice proposes 1 BTC ↔ 10 ETH, Bob accepts, both deposit, escrow completes.
# Topup is 10x the swap amount to verify token splitting (change tokens).
# Verifies exact balance changes: before → after deposit → after payout.
# =============================================================================
set -euo pipefail
TEST_NAME="01-basic"
source "$(dirname "${BASH_SOURCE[0]}")/e2e-helpers.sh"
parse_e2e_args "$@"

setup_workspace
ALICE="e2e01a_${RUN_ID}"
BOB="e2e01b_${RUN_ID}"
WALLETS_TO_DELETE="$ALICE $BOB"
trap cleanup EXIT

setup_escrow
launch_escrow

# Wallets
log ""; log "=== Create wallets ==="
create_wallet "$ALICE" "$ALICE"
create_wallet "$BOB" "$BOB"

# Ping escrow to verify it's reachable before proceeding
ping_escrow "$ALICE" "$ESCROW"

# Topup (10x the swap amount)
log ""; log "=== Topup ==="
topup_wallet "$ALICE" BTC 10     # swap needs 1 → expect 9 remaining
topup_wallet "$BOB" ETH 100     # swap needs 10 → expect 90 remaining

# Record balances before swap
ALICE_BTC_BEFORE=$(get_coin_amount "$ALICE" BTC)
BOB_ETH_BEFORE=$(get_coin_amount "$BOB" ETH)
log "Before: Alice BTC=${ALICE_BTC_BEFORE}, Bob ETH=${BOB_ETH_BEFORE}"

# Propose
log ""; log "=== Propose swap: 1 BTC ↔ 10 ETH ==="
SWAP_ID=$(propose_swap "$ALICE" "$BOB" "1 BTC" "10 ETH" "$ESCROW")
ok "Proposed ${SWAP_ID:0:8}..."

# Accept
log ""; log "=== Bob accepts ==="
accept_swap "$BOB" "${SWAP_ID:0:8}"

# Both deposit
log ""; log "=== Deposits ==="
deposit_swap "$BOB" "${SWAP_ID:0:8}"
deposit_swap "$ALICE" "${SWAP_ID:0:8}"

# Verify exact change amounts after deposit
log ""; log "=== Verify post-deposit balances ==="
assert_balance "$ALICE" BTC "9" "Alice BTC after depositing 1 of 10"
assert_balance "$BOB" ETH "90" "Bob ETH after depositing 10 of 100"

# Wait for completion
log ""; log "=== Waiting for swap completion ==="
FINAL=$(wait_swap_progress "$ALICE" "${SWAP_ID:0:8}" "completed|failed|cancelled|pruned") || true
if [[ "$FINAL" == "completed" ]]; then
  ok "Swap completed"
elif [[ "$FINAL" == "pruned" ]]; then
  log "Swap pruned — balance assertions below verify success"
else
  fail "Swap did not complete (final: ${FINAL:-unknown})"
fi

# Verify final balances with exact amounts
log ""; log "=== Verify final balances ==="
cli_as "$ALICE" balance --finalize > /dev/null 2>&1 || true
cli_as "$BOB" balance --finalize > /dev/null 2>&1 || true

# Alice: started with 10 BTC, deposited 1, should have 9 BTC + received 10 ETH
assert_balance "$ALICE" BTC "9" "Alice BTC remaining (10 - 1)"
assert_balance "$ALICE" ETH "10" "Alice ETH payout"
# Bob: started with 100 ETH, deposited 10, should have 90 ETH + received 1 BTC
assert_balance "$BOB" ETH "90" "Bob ETH remaining (100 - 10)"
assert_balance "$BOB" BTC "1" "Bob BTC payout"

summary
[[ $FAIL -gt 0 ]] && exit 1
exit 0
