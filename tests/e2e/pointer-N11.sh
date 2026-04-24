#!/usr/bin/env bash
# =============================================================================
# pointer-N11.sh — N11 high-volume send (100+ sends in rapid succession)
#
# SPEC TEST §5.13. 50-100 concurrent sends; all succeed or are queued.
# Token conservation holds.
#
# STATUS: TODO — placeholder.
#
# Why not implemented yet in this wave:
#   * Same faucet dependency as N3/N4 — needs a funded wallet with enough
#     balance to cover 50+ sends.
#   * The concurrent-publish / batched-CAR pipeline is covered by unit
#     tests in tests/unit/profile/pointer/concurrent-*.test.ts.
#
# Next step: reuse N3's faucet helper, then script 50 background sends +
# `wait` + final balance delta assertion.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N11"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — needs funded wallet + faucet helper (SPEC §5.13)"
pass "${TEST_NAME}"
exit 0
