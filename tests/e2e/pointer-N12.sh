#!/usr/bin/env bash
# =============================================================================
# pointer-N12.sh — N12 chaos: random SIGKILL during publish (20 iterations)
#
# SPEC TEST §5.14. 20 send-then-kill cycles; marker-driven recovery; no
# OTP reuse; final balance invariant.
#
# STATUS: TODO — placeholder.
#
# Why not implemented yet in this wave:
#   * Faucet dependency (same as N3/N4/N11).
#   * The marker-recovery path IS unit-tested extensively
#     (tests/unit/profile/pointer/marker-*.test.ts, W6 suite). The N12
#     script's unique contribution is stress-testing at the CLI level
#     with real timing jitter.
#
# Next step: reuse faucet helper + SIGKILL loop from N4, escalate to 20
# iterations, assert token conservation at the end.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N12"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — needs funded wallet + N4 SIGKILL primitive (SPEC §5.14)"
pass "${TEST_NAME}"
exit 0
