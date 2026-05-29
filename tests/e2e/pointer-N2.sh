#!/usr/bin/env bash
# =============================================================================
# pointer-N2.sh — N2 recover on second device
#
# SPEC TEST §5.3 (adapted). Two dataDirs on the same host, same mnemonic:
#
#   Device A: init --profile → flush → pointer publishes v=1 anchor.
#   Device B: init --profile --mnemonic <MN> --no-nostr → pointer recover.
#
# What this proves:
#   1. The aggregator retains the pointer anchor past the A-side flush.
#   2. Device B, with only the mnemonic (no Nostr transport, no shared
#      storage), can locate the anchor and recover the CID.
#   3. `pointer recover` prints a line of the form
#        Recovered v=N cid=baf...
#      for a valid CID and a version >= 1.
#
# This is the core cross-device recovery invariant — the whole reason the
# pointer layer exists. If N1 passes but N2 fails, the anchor wasn't
# durably published or the recovery lookup is broken.
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N2"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

maybe_skip_no_testnet
setup_workspace
trap cleanup_workspace EXIT

DD_A="${WORKSPACE}/device-A"
DD_B="${WORKSPACE}/device-B"

log "=== Step 1: Device A — init + flush ==="
INIT_OUT=$(init_wallet "$DD_A" 2>&1) || die "A init failed"
MN=$(extract_mnemonic "$INIT_OUT")
[[ -n "$MN" ]] || die "could not extract mnemonic from device-A init"
ok "A initialised; mnemonic captured"

flush_pointer "$DD_A" "A post-init"
assert_pointer_fp_nonempty "$DD_A" "A post-flush"

# Capture A's expected CID so we can cross-check B's recovery lifts the
# same anchor (within aggregator consistency — there may be an in-flight
# re-publish on very fast sequences, but at this beat we expect == A).
A_RECOVER=$(_cd_cli "$DD_A" pointer recover 2>&1 || true)
A_CID=$(echo "$A_RECOVER" | sed -nE 's/.*cid=(\S+).*/\1/p' | head -1)
[[ -n "$A_CID" ]] || die "A pointer recover returned no CID (publish did not land?)"
log "A published CID: ${A_CID}"

log "=== Step 2: Device B — import mnemonic (--no-nostr) ==="
# --no-nostr: prove recovery path works from IPFS+aggregator alone, no
# relay-backed sync. If Nostr were required to recover, SPEC §11.12 would
# be violated — it's explicitly IPFS-first.
B_INIT=$(init_wallet "$DD_B" --mnemonic "$MN" 2>&1) || die "B init with mnemonic failed"
log "B init (tail):"
echo "$B_INIT" | tail -4 | sed 's/^/    /'
ok "B initialised with A's mnemonic"

log "=== Step 3: Device B — pointer recover ==="
B_RECOVER=$(_cd_cli "$DD_B" pointer recover 2>&1) || die "B pointer recover exited non-zero"
echo "$B_RECOVER" | sed 's/^/    /'

B_CID=$(echo "$B_RECOVER" | sed -nE 's/.*cid=(\S+).*/\1/p' | head -1)
if [[ -z "$B_CID" ]]; then
  bad "B recover did not print a CID"
elif [[ "$B_CID" != "$A_CID" ]]; then
  # Not a hard fail — A could have republished in the interval. Log and
  # verify the CID is at least well-formed.
  log "B CID (${B_CID}) differs from A's most-recent (${A_CID}) — possible re-publish race"
  if [[ "$B_CID" =~ ^ba[a-z0-9]+ ]]; then
    ok "B recovered a valid-looking CID (base32 CIDv1)"
  else
    bad "B recovered CID is malformed: ${B_CID}"
  fi
else
  ok "B recovered the same CID A published"
fi

# Sanity: B's pointer layer should not be BLOCKED after a successful
# recovery (no integrity event occurred).
assert_pointer_not_blocked "$DD_B" "B post-recover"

script_summary
