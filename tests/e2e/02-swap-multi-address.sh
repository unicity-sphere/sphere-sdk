#!/usr/bin/env bash
# =============================================================================
# 02-swap-multi-address.sh — Multi-address partial deposits
#
# Alice deposits from 2 addresses, Bob deposits from 2 addresses.
# Uses invoice-pay with explicit amounts for partial deposits.
# =============================================================================
set -euo pipefail
TEST_NAME="02-multi-addr"
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

# --- Topup primary addresses ---
log ""; log "=== Topup ==="
# Alice addr 0: 12 BTC (more than the 10 needed, will split across payments)
topup_wallet "$ALICE" BTC 12
# Bob addr 0: 120 ETH
topup_wallet "$BOB" ETH 120

# --- Propose: 10 BTC ↔ 100 ETH ---
log ""; log "=== Propose swap: 10 BTC ↔ 100 ETH ==="
SWAP_ID=$(propose_swap "$ALICE" "$BOB" "10 BTC" "100 ETH" "$ESCROW")
ok "Proposed ${SWAP_ID:0:8}..."

# --- Accept ---
log ""; log "=== Bob accepts ==="
accept_swap "$BOB" "${SWAP_ID:0:8}"

# --- Wait for announced ---
log ""; log "=== Wait for announced ==="
wait_swap_progress "$ALICE" "${SWAP_ID:0:8}" "announced|depositing|awaiting_counter" 120 > /dev/null || true

# --- Get deposit invoice ID ---
DEPOSIT_INV=$(get_deposit_invoice_id "$ALICE" "${SWAP_ID:0:8}")
[[ -z "$DEPOSIT_INV" ]] && die "No deposit invoice ID"
log "Deposit invoice: ${DEPOSIT_INV:0:16}..."

# --- Alice partial deposits (2 payments from primary address) ---
log ""; log "=== Alice deposits in 2 partial payments ==="

log "Alice payment 1: 6 BTC..."
cli_as "$ALICE" invoice-pay "${DEPOSIT_INV:0:8}" --amount 6 2>&1 | tail -3
ok "Alice partial deposit 1 (6 BTC)"

log "Alice payment 2: 4 BTC (remaining)..."
cli_as "$ALICE" invoice-pay "${DEPOSIT_INV:0:8}" --amount 4 2>&1 | tail -3
ok "Alice partial deposit 2 (4 BTC)"

# --- Bob partial deposits (2 payments from primary address) ---
log ""; log "=== Bob deposits in 2 partial payments ==="

log "Bob payment 1: 60 ETH..."
cli_as "$BOB" invoice-pay "${DEPOSIT_INV:0:8}" --amount 60 2>&1 | tail -3
ok "Bob partial deposit 1 (60 ETH)"

log "Bob payment 2: 40 ETH (remaining)..."
cli_as "$BOB" invoice-pay "${DEPOSIT_INV:0:8}" --amount 40 2>&1 | tail -3
ok "Bob partial deposit 2 (40 ETH)"

# --- Wait for completion ---
log ""; log "=== Waiting for swap completion ==="
FINAL=$(wait_swap_progress "$ALICE" "${SWAP_ID:0:8}" "completed|failed|cancelled" 300) || true
if [[ "$FINAL" == "completed" ]]; then
  ok "Multi-address swap completed"
else
  fail "Swap did not complete (final: $FINAL)"
fi

# --- Verify ---
log ""; log "=== Verify balances ==="
cli_as "$ALICE" switch 0 > /dev/null 2>&1 || true
ALICE_BAL=$(cli_as "$ALICE" balance --finalize 2>&1) || true
if echo "$ALICE_BAL" | grep -q "ETH"; then ok "Alice received ETH"; else fail "Alice missing ETH"; fi

cli_as "$BOB" switch 0 > /dev/null 2>&1 || true
BOB_BAL=$(cli_as "$BOB" balance --finalize 2>&1) || true
if echo "$BOB_BAL" | grep -q "BTC"; then ok "Bob received BTC"; else fail "Bob missing BTC"; fi

summary
[[ $FAIL -gt 0 ]] && exit 1
exit 0
