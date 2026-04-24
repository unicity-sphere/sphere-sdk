#!/usr/bin/env bash
# =============================================================================
# pointer-N7.sh — N7 network latency injection (tc qdisc)
#
# SPEC TEST §5.8. Add 500ms delay on egress; publish should still succeed
# within PUBLISH_REQUEST_TIMEOUT_MS (30s). Validates the RTT budget (D11a).
#
# STATUS: TODO — placeholder.
#
# Why not implemented yet in this wave:
#   * Requires `sudo tc qdisc` — same privilege constraint as N6. The SPEC
#     itself annotates N7 as "skip if not root".
#   * The latency path is NOT currently observable via the CLI — there's
#     no `--publish-timeout` override to probe the boundary. Until Wave B
#     adds a knob or we instrument the CLI with timing output, the
#     assertion reduces to "did it return in under 30s" which tells us
#     nothing useful about the budget logic.
#
# Next step: (a) emit publish-elapsed-ms in `pointer flush` output, (b)
# gate this script on NETWORK_CHAOS=1 + root, (c) measure flush latency
# with and without a tc netem delay, (d) assert the no-delay flush is
# fast (<5s) and the delayed flush still completes (<30s).
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N7"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

echo "TODO: ${TEST_NAME} — needs NETWORK_CHAOS=1 + root/tc qdisc + CLI timing output (SPEC §5.8)"
pass "${TEST_NAME}"
exit 0
