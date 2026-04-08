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

# Verify change after swap A deposits
# Alice deposited 1 BTC from 30 total → 29 remaining
# Bob deposited 10 ETH from 300 total → 290 remaining
log ""; log "=== Verify post-deposit A balances ==="
assert_balance "$ALICE" BTC "29" "Alice BTC after swap A deposit (30 - 1)"
assert_balance "$BOB" ETH "290" "Bob ETH after swap A deposit (300 - 10)"

# --- Both deposit into swap B ---
log ""; log "=== Swap B: deposits ==="
deposit_swap "$BOB" "${SWAP_B:0:8}"
deposit_swap "$ALICE" "${SWAP_B:0:8}"

# Verify change after swap B deposits
# Alice deposited 2 more BTC → 29 - 2 = 27 remaining
# Bob deposited 20 more ETH → 290 - 20 = 270 remaining
log ""; log "=== Verify post-deposit B balances ==="
assert_balance "$ALICE" BTC "27" "Alice BTC after swap B deposit (29 - 2)"
assert_balance "$BOB" ETH "270" "Bob ETH after swap B deposit (290 - 20)"

# --- Check swap A status after all deposits ---
log ""; log "=== Swap A intermediate status ==="
SWAP_A_MID=$(cli_as "$ALICE" swap-list --all 2>&1) || true
log "All swaps after deposits:"
{ echo "$SWAP_A_MID" | grep -E "${SWAP_A:0:8}|${SWAP_B:0:8}" || echo "(none visible)"; } >&2

# --- Wait for both to complete ---
log ""; log "=== Waiting for swap A completion ==="
FINAL_A=$(wait_swap_progress "$ALICE" "${SWAP_A:0:8}" "completed|failed|cancelled|pruned") || true
if [[ "$FINAL_A" == "completed" || "$FINAL_A" == "pruned" ]]; then
  ok "Swap A completed"
elif [[ "$FINAL_A" == "failed" ]]; then
  # Dump full status for post-mortem — the escrow may have completed but the SDK
  # misinterpreted a DM (known race in multi-swap scenarios)
  SWAP_A_STATUS=$(cli_as "$ALICE" swap-status "${SWAP_A:0:8}" 2>&1) || true
  log "Swap A ended in 'failed' — full status for diagnosis:"
  echo "$SWAP_A_STATUS" >&2
  fail "Swap A did not complete (final: $FINAL_A)"
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

# --- Verify exact final balances ---
# Alice: topup 10+20=30 BTC, deposited 1+2=3 → 27 BTC remaining + 10+20=30 ETH payout
# Bob: topup 100+200=300 ETH, deposited 10+20=30 → 270 ETH remaining + 1+2=3 BTC payout
log ""; log "=== Verify final balances ==="
cli_as "$ALICE" balance --finalize > /dev/null 2>&1 || true
cli_as "$BOB" balance --finalize > /dev/null 2>&1 || true

assert_balance "$ALICE" BTC "27" "Alice BTC remaining (30 - 3)"
assert_balance "$ALICE" ETH "30" "Alice ETH payout (10 + 20)"
assert_balance "$BOB" ETH "270" "Bob ETH remaining (300 - 30)"
assert_balance "$BOB" BTC "3" "Bob BTC payout (1 + 2)"

summary
[[ $FAIL -gt 0 ]] && exit 1
exit 0
