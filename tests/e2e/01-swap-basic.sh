#!/usr/bin/env bash
# =============================================================================
# 01-swap-basic.sh — Basic happy-path swap
#
# Alice proposes 1 BTC ↔ 10 ETH, Bob accepts, both deposit, escrow completes.
# Topup is 10x the swap amount to verify token splitting (change tokens).
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
topup_wallet "$ALICE" BTC 10     # swap needs 1
topup_wallet "$BOB" ETH 100     # swap needs 10

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

# Verify change tokens survived the deposit (split must not consume entire token)
log ""; log "=== Verify post-deposit balances (change tokens) ==="
assert_deposit_change "$ALICE" BTC "Alice BTC after deposit"
assert_deposit_change "$BOB" ETH "Bob ETH after deposit"

# Wait for completion
log ""; log "=== Waiting for swap completion ==="
FINAL=$(wait_swap_progress "$ALICE" "${SWAP_ID:0:8}" "completed|failed|cancelled|pruned") || true
if [[ "$FINAL" == "completed" || "$FINAL" == "pruned" ]]; then
  ok "Swap completed"
else
  fail "Swap did not complete (final: $FINAL)"
fi

# Verify final balances — both parties should have swapped coins + remaining original coins
log ""; log "=== Verify final balances ==="
ALICE_BAL=$(cli_as "$ALICE" balance --finalize 2>&1) || true
if echo "$ALICE_BAL" | grep -q "ETH"; then ok "Alice received ETH"; else fail "Alice missing ETH"; fi
if echo "$ALICE_BAL" | grep -q "BTC"; then ok "Alice kept remaining BTC"; else fail "Alice lost all BTC — change token missing"; fi

BOB_BAL=$(cli_as "$BOB" balance --finalize 2>&1) || true
if echo "$BOB_BAL" | grep -q "BTC"; then ok "Bob received BTC"; else fail "Bob missing BTC"; fi
if echo "$BOB_BAL" | grep -q "ETH"; then ok "Bob kept remaining ETH"; else fail "Bob lost all ETH — change token missing"; fi

summary
[[ $FAIL -gt 0 ]] && exit 1
exit 0
