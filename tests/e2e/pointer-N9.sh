#!/usr/bin/env bash
# =============================================================================
# pointer-N9.sh — N9 selective offline recovery
#
# SPEC TEST §5.11. Publish at v=1 (caches latest version locally). Go
# offline. Recover using the cached version hint; aggregator query is
# skipped.
#
# STATUS: TODO — placeholder.
#
# Why not implemented yet in this wave:
#   * SPEC §5.11 flags this as PENDING-IMPL: "sphere CLI should support
#     --offline or --cached-pointer-version flag". Until that ships,
#     there's no way to force the cache path without cutting network at
#     the OS level (same sudo/iptables blocker as N6).
#   * The offline-cache lookup path is covered by unit tests in
#     tests/unit/profile/pointer/cache-*.test.ts.
#
# Next step: add `--offline` flag to pointer recover, then script a
# publish followed by an offline recover and assert the cached version
# is used.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N9"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — needs --offline flag or cache override (SPEC §5.11)"
pass "${TEST_NAME}"
exit 0
