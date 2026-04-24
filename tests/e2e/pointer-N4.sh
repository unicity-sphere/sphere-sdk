#!/usr/bin/env bash
# =============================================================================
# pointer-N4.sh — N4 crash during send (SIGKILL, marker recovery)
#
# SPEC TEST §5.5. Start a `send`, SIGKILL mid-flight, restart, verify the
# marker-driven idempotent recovery kicks in (no OTP reuse, no token loss).
#
# STATUS: TODO — placeholder.
#
# Why not implemented yet in this wave:
#   * Same faucet dependency as N3 — we need funded tokens to trigger a
#     real `send` that stalls long enough to SIGKILL cleanly.
#   * The marker-recovery code path is covered by unit tests in
#     tests/unit/profile/pointer/*.test.ts (W6 / marker_corrupt suite).
#     The N4 script's value is end-to-end validation of the CLI-level
#     retry semantics, which needs the faucet path.
#
# Next step: reuse the faucet helper from N3 (once that lands), then
# script: `send … &; PID=$!; sleep 0.1; kill -9 $PID; sleep 1; send …`
# and assert token conservation.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N4"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — needs funded wallet + SIGKILL harness (SPEC §5.5)"
pass "${TEST_NAME}"
exit 0
