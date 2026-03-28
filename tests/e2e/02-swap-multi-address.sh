#!/usr/bin/env bash
# =============================================================================
# 02-swap-multi-address.sh — Two simultaneous swaps
#
# Alice proposes swap A (1 BTC ↔ 10 ETH) and swap B (2 BTC ↔ 20 ETH).
# Bob accepts both. Both complete independently.
# Topup is 10x per swap to verify token splitting works across concurrent swaps.
# =============================================================================
set -euo pipefail
TEST_NAME="02-multi-swap"
source "$(dirname "${BASH_SOURCE[0]}")/e2e-helpers.sh"
parse_e2e_args "$@"

setup_workspace
ALICE="e2e02a_${RUN_ID}"
BOB="e2e02b_${RUN_ID}"
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

# --- Topup: separate tokens for each swap (10x each) ---
# Each topup creates a separate token. Using separate topups ensures
# each swap can use its own token without depending on change tokens
# from prior splits (change tokens require background aggregator round-trip).
log ""; log "=== Topup ==="
topup_wallet "$ALICE" BTC 10    # 10x for Swap A (needs 1)
topup_wallet "$ALICE" BTC 20    # 10x for Swap B (needs 2)
topup_wallet "$BOB" ETH 100    # 10x for Swap A (needs 10)
topup_wallet "$BOB" ETH 200    # 10x for Swap B (needs 20)

# --- Propose TWO swaps ---
log ""; log "=== Propose swap A: 1 BTC ↔ 10 ETH ==="
SWAP_A=$(propose_swap "$ALICE" "$BOB" "1 BTC" "10 ETH" "$ESCROW")
ok "Proposed swap A: ${SWAP_A:0:8}..."

log ""; log "=== Propose swap B: 2 BTC ↔ 20 ETH ==="
SWAP_B=$(propose_swap "$ALICE" "$BOB" "2 BTC" "20 ETH" "$ESCROW")
ok "Proposed swap B: ${SWAP_B:0:8}..."

# --- Bob accepts both ---
log ""; log "=== Bob accepts both ==="
accept_swap "$BOB" "${SWAP_A:0:8}"
accept_swap "$BOB" "${SWAP_B:0:8}"

# --- Both deposit into swap A ---
log ""; log "=== Swap A: deposits ==="
deposit_swap "$BOB" "${SWAP_A:0:8}"
deposit_swap "$ALICE" "${SWAP_A:0:8}"

# Verify change tokens after swap A deposits
log ""; log "=== Verify post-deposit A balances ==="
assert_deposit_change "$ALICE" BTC "Alice BTC after swap A deposit"
assert_deposit_change "$BOB" ETH "Bob ETH after swap A deposit"

# --- Both deposit into swap B ---
log ""; log "=== Swap B: deposits ==="
deposit_swap "$BOB" "${SWAP_B:0:8}"
deposit_swap "$ALICE" "${SWAP_B:0:8}"

# Verify change tokens after swap B deposits
log ""; log "=== Verify post-deposit B balances ==="
assert_deposit_change "$ALICE" BTC "Alice BTC after swap B deposit"
assert_deposit_change "$BOB" ETH "Bob ETH after swap B deposit"

# --- Wait for both to complete ---
log ""; log "=== Waiting for swap A completion ==="
FINAL_A=$(wait_swap_progress "$ALICE" "${SWAP_A:0:8}" "completed|failed|cancelled|pruned") || true
if [[ "$FINAL_A" == "completed" || "$FINAL_A" == "pruned" ]]; then
  ok "Swap A completed"
else
  fail "Swap A did not complete (final: $FINAL_A)"
fi

log ""; log "=== Waiting for swap B completion ==="
FINAL_B=$(wait_swap_progress "$ALICE" "${SWAP_B:0:8}" "completed|failed|cancelled|pruned") || true
if [[ "$FINAL_B" == "completed" || "$FINAL_B" == "pruned" ]]; then
  ok "Swap B completed"
else
  fail "Swap B did not complete (final: $FINAL_B)"
fi

# --- Verify final balances ---
log ""; log "=== Verify balances ==="
ALICE_BAL=$(cli_as "$ALICE" balance --finalize 2>&1) || true
if echo "$ALICE_BAL" | grep -q "ETH"; then ok "Alice received ETH"; else fail "Alice missing ETH"; fi
if echo "$ALICE_BAL" | grep -q "BTC"; then ok "Alice kept remaining BTC"; else fail "Alice lost all BTC — change tokens missing"; fi

BOB_BAL=$(cli_as "$BOB" balance --finalize 2>&1) || true
if echo "$BOB_BAL" | grep -q "BTC"; then ok "Bob received BTC"; else fail "Bob missing BTC"; fi
if echo "$BOB_BAL" | grep -q "ETH"; then ok "Bob kept remaining ETH"; else fail "Bob lost all ETH — change tokens missing"; fi

summary
[[ $FAIL -gt 0 ]] && exit 1
exit 0
