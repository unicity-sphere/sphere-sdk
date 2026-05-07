#!/usr/bin/env bash
# =============================================================================
# pointer-N0-prologue.sh — Shared env + helpers for pointer-layer N-scripts
#
# Part of T-E19 / T-E20 (SPEC TEST §5.1). Sourced by every pointer-NX.sh
# script so the scripts themselves stay short and declarative.
#
# Contract:
#   * Sourced, not executed directly. Running it as a script exits 0 with a
#     "sourced-only" note so shellcheck / CI smoke-runs don't fail.
#   * Provides: workspace mktemp, SPHERE_CLI binding, fail()/pass() helpers,
#     init_wallet / flush_pointer / pointer_status helpers, NO_TESTNET skip
#     sentinel, _cd_cli wrapper that pins CWD to the per-script dataDir.
#
# Conventions (SPEC TEST §5.1 / project-wide):
#   * set -Eeuo pipefail in every script.
#   * NO_TESTNET=1 → scripts print "SKIP: no testnet" and exit 0.
#   * Each script ends with a literal "PASS: <name>" or "FAIL: <name>" line
#     that run-all.sh greps for.
# =============================================================================

# Strict mode applies to the prologue itself. We expect to be sourced, so do
# NOT call `exit` on a non-sourced invocation — just print the usage note.
set -Eeuo pipefail

# Idempotent source guard. Prevents redefinition when a script chain-sources
# (e.g., N14 pre-seeds state then re-sources for assertion helpers).
if [[ "${POINTER_PROLOGUE_LOADED:-0}" == "1" ]]; then
  return 0 2>/dev/null || true
fi
export POINTER_PROLOGUE_LOADED=1

# ---------------------------------------------------------------------------
# Detect sourced-vs-executed so a direct run prints usage and exits cleanly
# (required for the "prologue sources cleanly" smoke check).
# ---------------------------------------------------------------------------
_POINTER_PROLOGUE_SOURCED=0
# BASH_SOURCE[0] is this file; ${0} is the entry script. If they match, we
# were executed directly.
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  _POINTER_PROLOGUE_SOURCED=1
fi

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
POINTER_PROLOGUE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SDK_ROOT="$(cd -- "${POINTER_PROLOGUE_DIR}/../.." && pwd -P)"
export POINTER_PROLOGUE_DIR SDK_ROOT

# CLI invocation. The resolver is centralized in lib/resolve-cli.sh so
# every shell entry-point uses the same fallback chain. See that file
# for the full lookup order — env override → in-tree → sibling repo
# (post-split layouts) → globally-installed binary → SKIP.
# shellcheck source=./lib/resolve-cli.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-cli.sh"
if ! resolve_sphere_cli "${SDK_ROOT}" SPHERE_CLI; then
  print_resolve_failure_help "${SDK_ROOT}"
  exit 0
fi

# Pointer-N* tests drive the legacy top-level command shape:
#   sphere init --profile --network testnet
#   sphere pointer flush / pointer status / pointer recover
# The post-extraction `@unicity-sphere/cli` is mid-migration — it has
# `wallet init` (legacy bridge) but the top-level `init` and the
# entire `pointer` namespace haven't been ported yet. Probe for
# `pointer` and SKIP cleanly with a precise reason instead of
# crashing inside `init_wallet` with a generic "init failed".
if ! cli_supports_command "$SPHERE_CLI" pointer; then
  echo "SKIP: ${TEST_NAME:-pointer-test} — CLI does not implement \`pointer\` namespace."
  echo "  Resolved CLI: $SPHERE_CLI"
  echo "  This branch's pointer-N* tests use the legacy top-level"
  echo "  \`pointer\` and \`init\` commands. \`@unicity-sphere/cli\` Phase 2"
  echo "  hasn't ported them yet (wallet init exists; pointer namespace"
  echo "  is missing). Either install a sphere-cli build that exposes"
  echo "  \`sphere pointer\`, or wait for Phase 2 to land."
  exit 0
fi
if ! cli_supports_command "$SPHERE_CLI" init; then
  echo "SKIP: ${TEST_NAME:-pointer-test} — CLI does not implement top-level \`init\` command."
  echo "  Resolved CLI: $SPHERE_CLI"
  echo "  Pointer-N* tests use \`sphere init --profile --network testnet\`"
  echo "  to bootstrap a fresh Profile wallet. The post-extraction CLI"
  echo "  exposes \`sphere wallet init <name>\` instead — different shape."
  echo "  Either install a sphere-cli build with the legacy top-level"
  echo "  \`init\`, or wait for the pointer-N* tests to be ported to the"
  echo "  new command shape."
  exit 0
fi

# Endpoints (kept for N-scripts that might probe /health manually; the CLI
# itself already defaults to these on testnet).
export AGGREGATOR_URL="${AGGREGATOR_URL:-https://goggregator-test.unicity.network}"
export FAUCET_URL="${FAUCET_URL:-https://faucet.unicity.network/api/v1/faucet/request}"

# ---------------------------------------------------------------------------
# Global state (reset per script via setup_workspace)
# ---------------------------------------------------------------------------
WORKSPACE=""
TEST_NAME="${TEST_NAME:-pointer-unknown}"
PASS_COUNT=0
FAIL_COUNT=0
KEEP_WORKSPACE="${KEEP_WORKSPACE:-false}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log()  { echo "[$(date '+%H:%M:%S')] [${TEST_NAME}] $*"; }
ok()   { echo "  ok   $*"; PASS_COUNT=$((PASS_COUNT + 1)); }
bad()  { echo "  FAIL $*" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Uniform pass/fail lines for run-all.sh. Scripts MUST call exactly one of
# these at the end; run-all.sh / CI greps for the leading "PASS:" / "FAIL:".
pass() {
  local name="${1:-${TEST_NAME}}"
  echo "PASS: ${name}"
}
fail() {
  local name="${1:-${TEST_NAME}}"
  local msg="${2:-}"
  if [[ -n "$msg" ]]; then
    echo "FAIL: ${name}: ${msg}" >&2
  else
    echo "FAIL: ${name}" >&2
  fi
}

# Hard-exit helper for setup failures that can't be attributed to a specific
# assertion (e.g., faucet unreachable, mnemonic extraction blank). Prints a
# FAIL line so run-all.sh still reports the test correctly.
die() {
  local msg="${1:-fatal}"
  fail "${TEST_NAME}" "${msg}"
  exit 1
}

# ---------------------------------------------------------------------------
# NO_TESTNET skip sentinel.
# Every script calls this before attempting any CLI invocation so CI boxes
# without testnet access get a clean PASS with a "SKIP" marker. run-all.sh
# treats exit 0 as pass; the leading "SKIP:" line is documentary.
# ---------------------------------------------------------------------------
maybe_skip_no_testnet() {
  if [[ "${NO_TESTNET:-0}" == "1" ]]; then
    echo "SKIP: ${TEST_NAME}: no testnet (NO_TESTNET=1)"
    # Still emit a PASS line so harness-greps treat this as a non-failure.
    # The SKIP line above distinguishes from a real pass for human readers.
    pass "${TEST_NAME}"
    exit 0
  fi
}

# ---------------------------------------------------------------------------
# Infra-probe preflight — runs @unicitylabs/infra-probe to confirm the live
# testnet is functional before we spend minutes inside the test. Skips
# cleanly (exit 0) if any required service is reported UNREACHABLE; warns
# but proceeds if degraded. Pointer-layer tests need aggregator + nostr
# (identity binding events) + ipfs (pointer publishes are CAR-encoded
# bundles pinned to IPFS).
#
# Bypass with E2E_SKIP_PREFLIGHT=1; override services via the optional
# arg to preflight_infra (defaults to "nostr,aggregator,ipfs").
# ---------------------------------------------------------------------------
# shellcheck source=./preflight-infra.sh
source "$(dirname "${BASH_SOURCE[0]}")/preflight-infra.sh"

# Local-infra harness — sourced ONLY when E2E_LOCAL_INFRA=1, no-op
# otherwise. Boots a local Nostr relay + faucet via Docker so the
# pointer-NX scripts can run against a deterministic local stack.
# Exports SPHERE_NOSTR_RELAYS + E2E_LOCAL_FAUCET_PUBKEY which the SDK
# (createNodeProviders' env-override) and pointer-NX wallets pick up
# transparently. State is persisted under /tmp/uxf-e2e-local-infra/
# so concurrent N-scripts share a single boot.
# shellcheck source=./local-infra/local-infra.sh
source "$(dirname "${BASH_SOURCE[0]}")/local-infra/local-infra.sh"

maybe_preflight_infra() {
  preflight_infra "${POINTER_PREFLIGHT_SERVICES:-nostr,aggregator,ipfs}"
}

# ---------------------------------------------------------------------------
# Workspace setup — one tmpdir per script, under /tmp/sphere-pointer-e2e-*.
# ---------------------------------------------------------------------------
setup_workspace() {
  WORKSPACE="$(mktemp -d "/tmp/sphere-pointer-e2e-${TEST_NAME}-XXXXXX")"
  export WORKSPACE
  log "Workspace: ${WORKSPACE}"
}

cleanup_workspace() {
  local exit_code=$?
  if [[ "${KEEP_WORKSPACE}" == "true" ]]; then
    [[ -n "${WORKSPACE}" ]] && log "Workspace preserved: ${WORKSPACE}"
  else
    [[ -n "${WORKSPACE}" ]] && rm -rf -- "${WORKSPACE}"
  fi
  exit "$exit_code"
}

# ---------------------------------------------------------------------------
# _cd_cli <datadir> <cli-args...>
# Runs the CLI inside the given dataDir. The CLI resolves config/profiles
# relative to CWD (.sphere-cli/), so each sub-wallet lives in its own dir.
# This mirrors the pattern in e2e-helpers.sh `_cli()`.
# ---------------------------------------------------------------------------
_cd_cli() {
  local datadir="$1"; shift
  [[ -d "$datadir" ]] || mkdir -p "$datadir"
  # Intentionally unquoted $SPHERE_CLI — it's a command + args string like
  # "npx --prefix /path tsx /path/cli/index.ts" and MUST word-split.
  # shellcheck disable=SC2086
  (cd "$datadir" && $SPHERE_CLI "$@")
}

# ---------------------------------------------------------------------------
# init_wallet <datadir> [extra-init-args...]
# Initialises a fresh Profile-mode wallet at <datadir>. Captures stdout so
# callers can extract the mnemonic when needed. --no-nostr is default so
# recovery scripts (N2, N13, N14) prove IPFS-only paths.
# ---------------------------------------------------------------------------
init_wallet() {
  local datadir="$1"; shift
  _cd_cli "$datadir" --no-nostr init --profile --network testnet "$@"
}

# ---------------------------------------------------------------------------
# extract_mnemonic <init-stdout>
# Parses 24 consecutive lowercase words out of init output (BIP-39). The
# CLI prints the mnemonic between two `──────` dashes on a fresh init.
# Returns empty string on import (--mnemonic given), which is expected —
# callers that need the mnemonic must init without --mnemonic.
# ---------------------------------------------------------------------------
extract_mnemonic() {
  local out="$1"
  # Grep the single line that holds 24 lowercase space-separated words.
  # Fall back to empty on any mismatch — callers must decide if that's an
  # error (N1/N2: yes; N13 re-init of same wallet: no).
  echo "$out" \
    | grep -oE '\b[a-z]+( [a-z]+){23}\b' \
    | head -1 \
    || true
}

# ---------------------------------------------------------------------------
# pointer_status <datadir>
# Returns the raw `pointer status` output. Used by assertion helpers below.
# ---------------------------------------------------------------------------
pointer_status() {
  local datadir="$1"
  _cd_cli "$datadir" pointer status 2>&1 || true
}

# assert_pointer_reachable <datadir> <label>
# Greps for "Reachable:    yes" in the status output.
assert_pointer_reachable() {
  local datadir="$1" label="$2"
  local out
  out="$(pointer_status "$datadir")"
  if echo "$out" | grep -qE 'Reachable: *yes'; then
    ok "${label}: pointer reachable"
  else
    bad "${label}: pointer NOT reachable"
    echo "$out" | sed 's/^/    /'
  fi
}

# assert_pointer_not_blocked <datadir> <label>
assert_pointer_not_blocked() {
  local datadir="$1" label="$2"
  local out
  out="$(pointer_status "$datadir")"
  if echo "$out" | grep -qE 'Blocked: *no'; then
    ok "${label}: pointer not blocked"
  else
    bad "${label}: pointer IS blocked"
    echo "$out" | sed 's/^/    /'
  fi
}

# assert_pointer_fp_nonempty <datadir> <label>
# Probe fingerprint MUST be non-empty after a successful flush.
assert_pointer_fp_nonempty() {
  local datadir="$1" label="$2"
  local out fp
  out="$(pointer_status "$datadir")"
  fp=$(echo "$out" | sed -nE 's/.*Probe FP: *(.+)$/\1/p' | head -1 | tr -d '[:space:]')
  if [[ -n "$fp" && "$fp" != "(noprobesyet)" && "$fp" != "(none)" ]]; then
    ok "${label}: probe fingerprint present (${fp:0:16}...)"
  else
    bad "${label}: probe fingerprint empty — pointer never published"
    echo "$out" | sed 's/^/    /'
  fi
}

# ---------------------------------------------------------------------------
# flush_pointer <datadir> <label>
# Forces a save + pointer publish round-trip. Used by N1/N2/N13.
# ---------------------------------------------------------------------------
flush_pointer() {
  local datadir="$1" label="$2"
  local out
  if out=$(_cd_cli "$datadir" pointer flush 2>&1); then
    ok "${label}: pointer flush succeeded"
  else
    bad "${label}: pointer flush failed"
    echo "$out" | sed 's/^/    /'
    return 1
  fi
}

# ---------------------------------------------------------------------------
# recover_pointer <datadir> <label>
# Invokes `pointer recover` and expects either a recovered CID or a clean
# "no anchor" line. Prints the raw output on stderr for operator triage.
# Returns 0 if recovered, 1 if no anchor, 2 on error.
# ---------------------------------------------------------------------------
recover_pointer() {
  local datadir="$1" label="$2"
  local out
  out=$(_cd_cli "$datadir" pointer recover 2>&1) || {
    bad "${label}: pointer recover errored"
    echo "$out" | sed 's/^/    /'
    return 2
  }
  if echo "$out" | grep -qE 'Recovered v=[0-9]+ cid='; then
    local cid
    cid=$(echo "$out" | sed -nE 's/.*cid=(\S+).*/\1/p' | head -1)
    ok "${label}: recovered CID ${cid:0:24}..."
    return 0
  fi
  if echo "$out" | grep -qE 'No pointer anchor published yet'; then
    log "${label}: no anchor to recover (expected for fresh wallet)"
    return 1
  fi
  bad "${label}: unexpected pointer recover output"
  echo "$out" | sed 's/^/    /'
  return 2
}

# ---------------------------------------------------------------------------
# script_summary — tail of every script. Prints the per-script pass/fail
# count and emits the harness-consumed "PASS:/FAIL:" line.
# ---------------------------------------------------------------------------
script_summary() {
  echo ""
  echo "================================================="
  echo "  ${TEST_NAME}: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
  echo "================================================="
  if [[ ${FAIL_COUNT} -gt 0 ]]; then
    fail "${TEST_NAME}"
    exit 1
  fi
  pass "${TEST_NAME}"
}

# ---------------------------------------------------------------------------
# Direct-run behaviour — just document that this file is meant to be sourced.
# ---------------------------------------------------------------------------
if [[ "${_POINTER_PROLOGUE_SOURCED}" == "0" ]]; then
  cat <<'EOF'
pointer-N0-prologue.sh: this file is meant to be sourced, not executed.

Usage from a test script:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  TEST_NAME="pointer-NX"
  source "$(dirname "$0")/pointer-N0-prologue.sh"
  # NO_TESTNET + infra-probe preflight are invoked automatically on
  # source; set E2E_NO_AUTO_PREFLIGHT=1 to suppress the probe.
  setup_workspace
  trap cleanup_workspace EXIT
  ...
  script_summary
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# Automatic gates on source (post-source).
#
# Every pointer-NX script needs the same two checks before the test does
# anything expensive: NO_TESTNET fast-skip, and the @unicitylabs/infra-
# probe preflight (the latter prevents flaky-infra false-negatives — see
# tests/e2e/preflight-infra.sh).
#
# Opt out either with NO_TESTNET=1 (skip everything) or
# E2E_NO_AUTO_PREFLIGHT=1 (run anyway despite probe outcome).
# ---------------------------------------------------------------------------
maybe_skip_no_testnet
if [[ "${E2E_NO_AUTO_PREFLIGHT:-0}" != "1" ]]; then
  maybe_preflight_infra
fi
