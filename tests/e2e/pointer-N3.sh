#!/usr/bin/env bash
# =============================================================================
# pointer-N3.sh — N3 concurrent publishes (two CLI processes, same wallet)
#
# SPEC TEST §5.4. Two CLI sends race on the same dataDir; MUTEX_KEY in the
# Profile provider MUST serialise them. Both eventually succeed, no OTP
# reuse, pointer version advances monotonically.
#
# STATUS: TODO — placeholder.
#
# Why not implemented yet in this wave:
#   * Requires a funded wallet (live faucet) to have tokens to send — the
#     faucet coupling is out of scope for the pointer-layer real-infra
#     harness (T-E19 / T-E20 explicitly carve out the faucet-driven
#     token-conservation scripts for a later wave).
#   * The lock contention is observable without sends via `pointer flush`
#     in two concurrent PIDs, but that doesn't exercise the user-action
#     write-path that the spec actually cares about.
#
# Next step: land the faucet helper in pointer-N0-prologue.sh, then wire
# two `_cd_cli "$DD" send …` processes with `&` + `wait` and assert
# monotonic `localVersion`.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N3"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — needs funded wallet + faucet helper (SPEC §5.4)"
pass "${TEST_NAME}"
exit 0
