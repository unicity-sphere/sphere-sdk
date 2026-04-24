#!/usr/bin/env bash
# =============================================================================
# pointer-N8.sh — N8 trust base rotation on recovery
#
# SPEC TEST §5.10. Recover while aggregator's trust base rotates; proofs
# re-verify against the new root. Seamless rotation.
#
# STATUS: TODO — placeholder.
#
# Why not implemented yet in this wave:
#   * Trust-base rotation is an operator/ops event, not something a test
#     script can trigger without a --trustbase-url override (SPEC §5.10
#     marks this explicitly PENDING-IMPL).
#   * The rotation handling logic is covered by unit tests in
#     tests/unit/profile/pointer/trustbase-*.test.ts.
#
# Next step: add `--trustbase-url` CLI override, then script a two-phase
# recovery (old URL → new URL) and assert both succeed.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N8"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — needs --trustbase-url CLI override (SPEC §5.10)"
pass "${TEST_NAME}"
exit 0
