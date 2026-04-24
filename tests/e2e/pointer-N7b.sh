#!/usr/bin/env bash
# =============================================================================
# pointer-N7b.sh — N7b BLOCKED state persists across process restart
#
# SPEC TEST §5.9 (v2 new). Simulate aggregator failure → BLOCKED set.
# Kill process. Restart. BLOCKED flag MUST still be set (state is durable
# on disk, not just in-memory). Publish refused while BLOCKED. `pointer
# unblock` clears → next publish succeeds.
#
# STATUS: TODO — placeholder.
#
# Why not implemented yet in this wave:
#   * To reach the BLOCKED state we need fault injection (same blocker
#     as N6 — no AGGREGATOR_URL override, no iptables without sudo).
#   * Each CLI invocation is already a fresh process (we `cd && npx tsx
#     cli/index.ts` for every call via _cd_cli), so the "process restart"
#     part is automatic; we just need a way to GET to BLOCKED first.
#   * The on-disk persistence IS covered by unit tests in
#     tests/unit/profile/pointer/blocked-state-persistence.test.ts —
#     the N7b script's unique value is end-to-end CLI validation.
#
# Next step: once N6 has fault-injection wired up, this script becomes
# a straightforward variant — reuse the same BLOCKED-forcing primitive,
# then simply re-invoke `pointer status` (fresh process) and assert
# Blocked:YES persists.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N7b"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — depends on N6's fault-injection primitive (SPEC §5.9)"
pass "${TEST_NAME}"
exit 0
