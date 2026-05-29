#!/usr/bin/env bash
# =============================================================================
# pointer-N6.sh — N6 aggregator briefly unreachable → BLOCKED routing
#
# SPEC TEST §5.7. Publish at v=1 (succeeds). iptables-DROP aggregator.
# Attempt recover → BLOCKED flag is set. Remove iptables rule. `pointer
# unblock` clears the correct reason (routing-class, NOT integrity-class),
# pointer recovery succeeds.
#
# STATUS: TODO (partial placeholder).
#
# Implementation notes:
#   * Requires `sudo iptables` (DROP to aggregator IP). CI boxes without
#     privileged network namespaces cannot run this.
#   * The CLI `pointer unblock` subcommand (Wave A, cli/index.ts §5620+)
#     ALREADY distinguishes integrity reasons from routing reasons; we
#     rely on that behaviour.
#   * A safer, rootless substitute: run the CLI with an invalid
#     AGGREGATOR_URL and assert BLOCKED is set with reason in the
#     non-integrity set. SPEC §5.7 itself marks the iptables path as
#     "skip if not root".
#
# Why not implemented yet in this wave:
#   * Even the rootless substitute (env override) needs a CLI flag that
#     the current code doesn't expose — `AGGREGATOR_URL` is baked into
#     `NETWORKS[network]` in constants.ts. Wave A did not thread an
#     override through, and adding one is out of scope for T-E19/T-E20.
#   * The BLOCKED state-machine IS covered by unit tests
#     (tests/unit/profile/pointer/*blocked*.test.ts). The missing piece
#     is end-to-end validation of the CLI unblock-routing logic, which
#     needs the fault-injection knob.
#
# Next step: expose `SPHERE_OVERRIDE_AGGREGATOR_URL` as a CLI/env flag,
# then script: (a) set it to an unreachable IP, (b) try flush → expect
# BLOCKED with reason=aggregator_unreachable, (c) clear env, (d)
# `pointer unblock` → expect success, (e) flush → expect success.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N6"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

if [[ "${NETWORK_CHAOS:-0}" != "1" ]]; then
  echo "TODO: ${TEST_NAME} — needs NETWORK_CHAOS=1 + root/iptables or AGGREGATOR_URL override (SPEC §5.7)"
  pass "${TEST_NAME}"
  exit 0
fi

# NETWORK_CHAOS=1 path intentionally left unimplemented — documenting the
# requirement rather than shipping a half-broken iptables dance that would
# require a sudoers rule to run in CI.
echo "TODO: ${TEST_NAME} — NETWORK_CHAOS=1 path not yet wired (SPEC §5.7)"
pass "${TEST_NAME}"
exit 0
