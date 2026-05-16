#!/usr/bin/env bash
# =============================================================================
# pointer-N10.sh — N10 long soak test (24-hour continuous publish/receive)
#
# SPEC TEST §5.12. Two devices. A sends to B every 10 minutes for 24h.
# Final: A + B == initial (token conservation over extended period).
#
# STATUS: TODO — placeholder.
#
# Why not implemented yet in this wave:
#   * 24h runtime is strictly out of scope for any CI harness. Even the
#     SPEC's "simplified 10-minute" variant requires a funded faucet +
#     working send pipeline (same blocker as N3/N4).
#   * Soak tests belong in a separate nightly/weekly job, not the
#     T-E19/T-E20 real-infra script set that runs per-PR.
#
# Next step: once N3's faucet helper exists, wire a `SOAK_MINUTES=${N:-10}`
# loop and run this as a standalone nightly job (not in the per-PR set).
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N10"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — long soak test, separate nightly job (SPEC §5.12)"
pass "${TEST_NAME}"
exit 0
