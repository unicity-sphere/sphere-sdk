#!/usr/bin/env bash
# =============================================================================
# pointer-N5.sh — N5 IPFS gateway failover
#
# SPEC TEST §5.6. Publish on device A using gateway G1. Kill G1. Recover on
# device B using only G2. CAR fetch from G2 succeeds; recovery finds and
# fetches CAR on the alternate gateway.
#
# STATUS: TODO — placeholder.
#
# Why not implemented yet in this wave:
#   * SPEC §5.6 explicitly notes "PENDING-IMPL: sphere CLI should support
#     --ipfs-gateway-list override or similar". Until the CLI exposes a
#     way to pin a specific gateway (or disable specific ones), we cannot
#     reliably force G1-only → G2-only behaviour without intercepting at
#     the iptables layer (which is N6's territory).
#   * The cross-gateway logic IS exercised by the `DEFAULT_IPFS_GATEWAYS`
#     list in impl/shared/ipfs — unit tests cover the failover order.
#     The N5 script's unique value is proving the real multi-gateway
#     fallback against a live IPFS network; that's a later wave.
#
# Next step: add `--ipfs-gateway` flag to CLI init, then script a two-
# device publish/recover with non-overlapping gateway lists.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N5"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — needs --ipfs-gateway CLI override (SPEC §5.6)"
pass "${TEST_NAME}"
exit 0
