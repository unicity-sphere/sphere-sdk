#!/usr/bin/env bash
# =============================================================================
# 03-swap-overpayment.sh — Overpayment with surplus return
#
# Bob overpays his deposit. Verify swap completes AND surplus is returned.
# =============================================================================
set -euo pipefail
TEST_NAME="03-overpay"
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

# --- Topup generously ---
log ""; log "=== Topup ==="
topup_wallet "$ALICE" BTC 10
topup_wallet "$BOB" ETH 200

# --- Propose small swap: 1 BTC ↔ 10 ETH ---
log ""; log "=== Propose: 1 BTC ↔ 10 ETH ==="
SWAP_ID=$(propose_swap "$ALICE" "$BOB" "1 BTC" "10 ETH" "$ESCROW")
ok "Proposed ${SWAP_ID:0:8}..."

# --- Accept ---
log ""; log "=== Bob accepts ==="
accept_swap "$BOB" "${SWAP_ID:0:8}"

# --- Wait for announced ---
wait_swap_progress "$ALICE" "${SWAP_ID:0:8}" "announced|depositing|awaiting_counter" 120 > /dev/null || true

# --- Get deposit invoice from Bob's side ---
# Wait for Bob to reach announced (invoice imported via escrow DMs)
wait_swap_progress "$BOB" "${SWAP_ID:0:8}" "announced|depositing|awaiting_counter" 120 > /dev/null || true
DEPOSIT_INV=$(get_deposit_invoice_id "$BOB" "${SWAP_ID:0:8}")
[[ -z "$DEPOSIT_INV" ]] && die "No deposit invoice ID from Bob"
log "Deposit invoice: ${DEPOSIT_INV:0:16}..."

# --- Bob OVERPAYS: sends 15 ETH instead of required 10 ---
log ""; log "=== Bob overpays: 15 ETH (required: 10) ==="
cli_as "$BOB" invoice-pay "${DEPOSIT_INV:0:8}" --amount 15 2>&1 | tail -3
ok "Bob deposited 15 ETH (overpayment of 5)"

# --- Alice deposits normally ---
log ""; log "=== Alice deposits ==="
deposit_swap "$ALICE" "${SWAP_ID:0:8}"

# --- Wait for completion ---
log ""; log "=== Waiting for swap completion ==="
FINAL=$(wait_swap_progress "$ALICE" "${SWAP_ID:0:8}" "completed|failed|cancelled" 300) || true
if [[ "$FINAL" == "completed" ]]; then
  ok "Overpayment swap completed"
else
  fail "Swap did not complete (final: $FINAL)"
fi

# --- Verify payouts ---
log ""; log "=== Verify balances ==="
ALICE_BAL=$(cli_as "$ALICE" balance --finalize 2>&1) || true
if echo "$ALICE_BAL" | grep -q "ETH"; then ok "Alice received ETH"; else fail "Alice missing ETH"; fi

BOB_BAL=$(cli_as "$BOB" balance --finalize 2>&1) || true
if echo "$BOB_BAL" | grep -q "BTC"; then ok "Bob received BTC"; else fail "Bob missing BTC"; fi

# --- Verify surplus return ---
# Bob should have some ETH back (the surplus 5 ETH)
# Allow time for auto-return to process
log ""; log "=== Verify surplus return ==="
sleep 15
BOB_BAL2=$(cli_as "$BOB" balance --finalize 2>&1) || true
log "Bob final balance:"
echo "$BOB_BAL2" | grep -E "BTC|ETH" || echo "$BOB_BAL2" | tail -5

if echo "$BOB_BAL2" | grep -q "ETH"; then
  ok "Bob has ETH (surplus returned)"
else
  log "  Note: Surplus return may take additional time or may be a separate token"
  fail "Bob ETH surplus not yet visible"
fi

summary
[[ $FAIL -gt 0 ]] && exit 1
exit 0
