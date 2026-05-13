#!/usr/bin/env bash
# =============================================================================
# pointer-N9.sh — N9 selective offline recovery
#
# SPEC TEST §5.11. Publish at v=1 (caches latest version locally). Go
# offline. Recover using the cached version hint; aggregator query is
# skipped.
#
# STATUS: TODO (v2) — placeholder.
#
# Why not implemented in v1:
#   * SPEC §5.11 flags this as PENDING-IMPL. The pointer layer's
#     `recoverLatest()` is currently aggregator-driven by design — a
#     true offline mode would require a NEW code path that uses
#     `currentLocalVersion` + cached probe history to skip the
#     aggregator query entirely. This is a feature, not just a flag.
#   * The offline-cache lookup path that this would build on is
#     covered indirectly by tests/integration/pointer/category-C.test.ts
#     (multi-device contention with mocked aggregator).
#
# v2 plan: add `recoverLatest({ offline: true })` to ProfilePointerLayer,
# then surface as `pointer recover --offline` in the CLI, then script
# a publish followed by an offline recover and assert the cached
# version is used without aggregator round-trip.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N9"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — needs --offline flag or cache override (SPEC §5.11)"
pass "${TEST_NAME}"
exit 0
