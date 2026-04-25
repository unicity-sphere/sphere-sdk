#!/usr/bin/env bash
# =============================================================================
# pointer-N8.sh — N8 trust base rotation on recovery
#
# SPEC TEST §5.10. Recover while aggregator's trust base rotates; proofs
# re-verify against the new root. Seamless rotation.
#
# STATUS: TODO (v2) — placeholder.
#
# Why not implemented in v1:
#   * Trust-base rotation is an operator/ops event, not something a test
#     script can trigger without a --trustbase-url CLI override or
#     equivalent oracle reconfiguration. The flag itself is a
#     non-trivial feature: the OracleProvider would need to support
#     mid-session trust-base substitution while preserving the SPEC
#     §8.4.2 H6 "shared instance" invariant across L4 and pointer
#     layers.
#   * The rotation handling LOGIC is fully covered by unit tests in
#     tests/unit/pointer/category-F.test.ts (F1-F9 trust-base rotation
#     conformance, 25 tests). The N8 testnet script's unique value is
#     end-to-end verification against a real rotation event — which
#     also needs aggregator-side cooperation.
#
# v2 plan: add --trustbase-url CLI override + OracleProvider.rotate()
# API. Then script a two-phase recovery (old URL → new URL) and
# assert both succeed.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N8"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — needs --trustbase-url CLI override (SPEC §5.10)"
pass "${TEST_NAME}"
exit 0
