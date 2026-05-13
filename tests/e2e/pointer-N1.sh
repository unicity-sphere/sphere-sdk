#!/usr/bin/env bash
# =============================================================================
# pointer-N1.sh — N1 first-run: init wallet, flush, verify pointer status
#
# SPEC TEST §5.2 (adapted — this variant does NOT require a faucet; a fresh
# wallet with zero tokens still produces a valid flush because the save
# chain is triggered regardless of balance. Pure pointer-layer round-trip.)
#
# What this proves:
#   1. `init --profile` on a fresh dataDir creates a usable Profile wallet.
#   2. `pointer flush` triggers a save + pointer publish round-trip.
#   3. After flush, `pointer status` reports:
#        - Reachable: yes   (aggregator round-trip succeeded)
#        - Blocked:   no    (no integrity/failure conditions)
#        - Probe FP:  <non-empty hex>   (at least one probe round-tripped)
#
# This is the minimum-viable pointer-layer liveness check. If this fails,
# every other N-script is doomed — the aggregator is unreachable, the
# pointer layer isn't constructed, or the CLI wiring is broken.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N1"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

maybe_skip_no_testnet
setup_workspace
trap cleanup_workspace EXIT

DD_A="${WORKSPACE}/wallet-A"

log "=== Step 1: init wallet in ${DD_A} ==="
# Capture stdout for mnemonic extraction (needed by N2/N13 parents; for N1
# itself we just need the wallet to be initialised).
INIT_OUT=$(init_wallet "$DD_A" 2>&1) || die "init failed"
log "init output (tail):"
echo "$INIT_OUT" | tail -6 | sed 's/^/    /'

MN=$(extract_mnemonic "$INIT_OUT")
if [[ -z "$MN" ]]; then
  bad "could not extract mnemonic from init output"
else
  ok "mnemonic extracted (${MN%% *}…)"
fi

log "=== Step 2: pointer flush ==="
flush_pointer "$DD_A" "post-init"

log "=== Step 3: pointer status assertions ==="
assert_pointer_reachable   "$DD_A" "N1"
assert_pointer_not_blocked "$DD_A" "N1"
assert_pointer_fp_nonempty "$DD_A" "N1"

script_summary
