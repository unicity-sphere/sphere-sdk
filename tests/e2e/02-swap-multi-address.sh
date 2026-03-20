#!/usr/bin/env bash
# =============================================================================
# 02-swap-multi-address.sh — Two simultaneous swaps from different addresses
#
# Tests that the escrow handles multiple concurrent swaps correctly.
# Alice proposes swap A from addr 0, proposes swap B from addr 0 (different amounts).
# Bob accepts both. Both complete independently.
#
# NOTE: Partial deposits via invoice-pay are currently limited by the SDK's
# ensureSync → load() cycle which can clear token state. When this is fixed,
# this test should be expanded to use actual multi-address partial deposits.
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

# --- Topup ---
log ""; log "=== Topup ==="
topup_wallet "$ALICE" BTC 20
topup_wallet "$BOB" ETH 200

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

# --- Both deposit into swap B ---
log ""; log "=== Swap B: deposits ==="
deposit_swap "$BOB" "${SWAP_B:0:8}"
deposit_swap "$ALICE" "${SWAP_B:0:8}"

# --- Wait for both to complete ---
log ""; log "=== Waiting for swap A completion ==="
FINAL_A=$(wait_swap_progress "$ALICE" "${SWAP_A:0:8}" "completed|failed|cancelled" 300) || true
if [[ "$FINAL_A" == "completed" ]]; then
  ok "Swap A completed"
else
  fail "Swap A did not complete (final: $FINAL_A)"
fi

log ""; log "=== Waiting for swap B completion ==="
FINAL_B=$(wait_swap_progress "$ALICE" "${SWAP_B:0:8}" "completed|failed|cancelled" 300) || true
if [[ "$FINAL_B" == "completed" ]]; then
  ok "Swap B completed"
else
  fail "Swap B did not complete (final: $FINAL_B)"
fi

# --- Verify ---
log ""; log "=== Verify balances ==="
ALICE_BAL=$(cli_as "$ALICE" balance --finalize 2>&1) || true
if echo "$ALICE_BAL" | grep -q "ETH"; then ok "Alice received ETH"; else fail "Alice missing ETH"; fi

BOB_BAL=$(cli_as "$BOB" balance --finalize 2>&1) || true
if echo "$BOB_BAL" | grep -q "BTC"; then ok "Bob received BTC"; else fail "Bob missing BTC"; fi

summary
[[ $FAIL -gt 0 ]] && exit 1
exit 0
