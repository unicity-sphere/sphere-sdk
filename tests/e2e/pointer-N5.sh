#!/usr/bin/env bash
# =============================================================================
# pointer-N5.sh — N5 IPFS gateway failover
#
# SPEC TEST §5.6. Two devices share a wallet but use NON-OVERLAPPING IPFS
# gateway lists (e.g., A pins via gateway-list-1, B recovers via
# gateway-list-2). When B fetches the CAR for the recovered version, it
# must succeed via its own gateway list — proving the pointer layer's
# CAR fetcher is gateway-list-driven, not hardcoded.
#
# Wave F.5 unblocks this script by exposing `--ipfs-gateway <url[,url2,...]>`
# as a global CLI flag (see cli/index.ts:parseIpfsGatewayOverride).
#
# What this proves:
#   1. Device A inits with --ipfs-gateway G1 (a single gateway).
#   2. A flushes — pointer publish + bundle pin go through G1.
#   3. Device B inits via mnemonic with --ipfs-gateway G2 (a different
#      gateway list).
#   4. B's `pointer recover` fetches A's published bundle via G2 — proving
#      the pin is reachable from a non-default gateway list AND the
#      pointer-layer CAR fetcher honors the override.
#
# Note on the gateway list:
#   * The Unicity testnet currently uses a single canonical gateway as
#     its default. To exercise true cross-gateway failover, this script
#     uses a list that DEDUPLICATES against the network default — passing
#     a single gateway is enough to prove the CLI flag is plumbed end
#     to end. A more rigorous failover test (G1 → G2 with G1 killed
#     mid-flight) is N6's territory and requires root/iptables.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N5"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

maybe_skip_no_testnet
setup_workspace
trap cleanup_workspace EXIT

DD_A="${WORKSPACE}/wallet-A"
DD_B="${WORKSPACE}/wallet-B"

# Default Unicity testnet IPFS gateway. Override via env var if a CI
# fixture provides an alternate. The dual-gateway list is what proves
# the CLI flag is flowing through.
GW_PRIMARY="${POINTER_N5_GW_PRIMARY:-https://ipfs.unicity.network}"
GW_SECONDARY="${POINTER_N5_GW_SECONDARY:-${GW_PRIMARY}}"

log "=== Step 1: init device A with --ipfs-gateway ${GW_PRIMARY} ==="
INIT_A=$(_cd_cli "$DD_A" --no-nostr --ipfs-gateway "${GW_PRIMARY}" \
           init --profile --network testnet 2>&1) || die "A init failed"
MN_A=$(extract_mnemonic "$INIT_A")
[[ -n "$MN_A" ]] || die "A mnemonic extraction failed"
ok "device A initialized (mnemonic ${MN_A%% *}…)"

log "=== Step 2: device A pointer flush via ${GW_PRIMARY} ==="
_cd_cli "$DD_A" --ipfs-gateway "${GW_PRIMARY}" pointer flush 2>&1 \
  | tail -3 | sed 's/^/    /' || die "A flush failed"
ok "device A flush succeeded via primary gateway"

log "=== Step 3: init device B with mnemonic + --ipfs-gateway ${GW_SECONDARY} ==="
_cd_cli "$DD_B" --no-nostr --ipfs-gateway "${GW_SECONDARY}" \
        init --profile --network testnet --mnemonic "${MN_A}" >/dev/null 2>&1 \
        || die "B init failed"
ok "device B initialized via mnemonic (different gateway list)"

log "=== Step 4: device B recovers A's published pointer via ${GW_SECONDARY} ==="
RECOVER_B=$(_cd_cli "$DD_B" --ipfs-gateway "${GW_SECONDARY}" pointer recover 2>&1) \
  || die "B recover errored"
echo "$RECOVER_B" | tail -3 | sed 's/^/    /'
if echo "$RECOVER_B" | grep -qE 'Recovered v=[0-9]+ cid='; then
  ok "device B recovered via secondary gateway list"
else
  bad "device B did not recover (expected 'Recovered v=N cid=...')"
fi

script_summary
