#!/usr/bin/env bash
#
# Issue #391 — 4-hop A→B→A→B→A round-trip soak.
#
# Reproduces the user-reported bug: after a chain of legitimate sends in
# which a token round-trips back to the original sender, the pre-fix
# duplicate-bundle guard would reject the next send with
# DUPLICATE_BUNDLE_MEMBERSHIP because (a) it compared candidates against
# the prior OUTBOX entry's recipient `tokenIds` set rather than its
# `sourceTokenIds` set, AND (b) short-lived CLI processes never gave the
# SentReconciliationWorker (60s first-scan delay) a chance to tombstone
# the stale `delivered-instant` entry.
#
# Pre-fix the 4th send (bob → alice 98.5 UCT) reliably errors:
#   "refusing to include token <hex> in this bundle — it is already
#    referenced by OUTBOX entry <id> (status=delivered-instant)"
# Post-fix all 4 sends succeed and every leg's balance reconciles.
#
# Run:
#   ./manual-test-roundtrip-391.sh
#   KEEP=1 ./manual-test-roundtrip-391.sh      # preserve workspace
#   ROUNDTRIP_391_TEST_DIR=/tmp/r391 ./manual-test-roundtrip-391.sh
#
# Requires the `sphere` CLI on PATH (e.g. via @unicity-sphere/cli) and
# outbound HTTPS+WSS to testnet hosts (aggregator, Nostr relay, IPFS
# gateway, faucet). Runs against testnet — no local infra needed.

set -euo pipefail

# ---- workspace ----
ROOT="${ROUNDTRIP_391_TEST_DIR:-/tmp/roundtrip-391-test-$$}"
SNAP="$ROOT/snapshots"
mkdir -p "$SNAP"

# Nametag constraint: lowercase alphanumeric / underscore / hyphen,
# 3–20 chars. Compact suffix to keep `alice-${SUFFIX}` under cap.
SUFFIX="${SUFFIX:-$(date +%s | tail -c 5)$(printf '%04x' $((RANDOM % 65536)))}"
ALICE_TAG="alice-$SUFFIX"
BOB_TAG="bob-$SUFFIX"
echo "ALICE_TAG=$ALICE_TAG"
echo "BOB_TAG=$BOB_TAG"

PEER_ALICE="$ROOT/alice-peer"
PEER_BOB="$ROOT/bob-peer"
mkdir -p "$PEER_ALICE" "$PEER_BOB"

# CLI emits mnemonic on stdout in non-TTY when --no-encrypt-mnemonic.
export SPHERE_ALLOW_MNEMONIC_NON_TTY=1

cleanup() {
  local rc=$?
  if [[ "${KEEP:-0}" != "1" ]]; then
    rm -rf "$ROOT" 2>/dev/null || true
  else
    echo "=== KEEP=1: workspace preserved at $ROOT ==="
  fi
  return "$rc"
}
trap cleanup EXIT INT TERM

banner() {
  echo
  echo "================================================================"
  echo "$@"
  echo "================================================================"
}

# ---------------------------------------------------------------------------
# Extract CONFIRMED UCT balance as integer (smallest units).
# Mirrors manual-test-simple-send.sh's extractor exactly so the assertion
# layer stays consistent across soaks.
# ---------------------------------------------------------------------------
extract_uct_confirmed_smallest_units() {
  local line decimal int_part frac_part
  line=$(grep -E '^UCT:' || true)
  if [[ -z "$line" ]]; then
    echo "0"
    return
  fi
  decimal=$(echo "$line" | sed -E -e 's/^UCT:[[:space:]]+//' -e 's/[[:space:]]+\(.+$//')
  if [[ "$decimal" == *.* ]]; then
    int_part="${decimal%.*}"
    frac_part="${decimal#*.}"
  else
    int_part="$decimal"
    frac_part=""
  fi
  while (( ${#frac_part} < 8 )); do frac_part="${frac_part}0"; done
  if (( ${#frac_part} > 8 )); then
    echo "ERROR: UCT fractional part >8 digits ($decimal)" >&2
    return 1
  fi
  local combined="${int_part}${frac_part}"
  combined=$(echo "$combined" | sed -E 's/^0+//')
  [[ -z "$combined" ]] && combined="0"
  echo "$combined"
}

# Returns 0 if the file contains DUPLICATE_BUNDLE_MEMBERSHIP or the
# "refusing to include token" phrase, 1 otherwise.
contains_duplicate_bundle_error() {
  grep -qE 'DUPLICATE_BUNDLE_MEMBERSHIP|refusing to include token' "$1"
}

# ---------------------------------------------------------------------------
# Section 1 — Create alice + bob
# ---------------------------------------------------------------------------
banner "Section 1: Create alice + bob (testnet)"

cd "$PEER_ALICE"
sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --nametag "$ALICE_TAG" 2>&1 | tee "$SNAP/alice-init.log"

cd "$PEER_BOB"
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --nametag "$BOB_TAG" 2>&1 | tee "$SNAP/bob-init.log"

# ---------------------------------------------------------------------------
# Section 2 — Faucet alice (baseline 100 UCT confirmed)
# ---------------------------------------------------------------------------
banner "Section 2: Faucet alice + capture baseline"

cd "$PEER_ALICE"
sphere wallet use alice
sphere faucet                       2>&1 | tee "$SNAP/alice-faucet.log"
sphere payments sync                2>&1 | tee "$SNAP/alice-sync-1.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/alice-faucet-receive.log"
sphere balance | tee "$SNAP/alice-balance-0.txt"

cd "$PEER_BOB"
sphere wallet use bob
sphere payments sync                2>&1 | tee "$SNAP/bob-sync-1.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/bob-baseline-receive.log"
sphere balance | tee "$SNAP/bob-balance-0.txt"

# ---------------------------------------------------------------------------
# Section 3 — Hop 1: alice → @bob (10 UCT)
# ---------------------------------------------------------------------------
banner "Section 3: HOP 1 — alice → @${BOB_TAG} (10 UCT)"

cd "$PEER_ALICE"
sphere wallet use alice
sphere payments send "@${BOB_TAG}" 10 UCT 2>&1 | tee "$SNAP/hop1-alice-send.log"

if contains_duplicate_bundle_error "$SNAP/hop1-alice-send.log"; then
  echo "ASSERT FAIL (hop1-no-dup-bundle-err): alice's first send tripped duplicate-bundle guard" >&2
  exit 1
fi

cd "$PEER_BOB"
sphere wallet use bob
sphere payments sync                2>&1 | tee "$SNAP/hop1-bob-sync.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/hop1-bob-receive.log"
sphere balance | tee "$SNAP/bob-balance-1.txt"

cd "$PEER_ALICE"
sphere wallet use alice
sphere payments sync                2>&1 | tee "$SNAP/hop1-alice-sync.log"
sphere balance | tee "$SNAP/alice-balance-1.txt"

# ---------------------------------------------------------------------------
# Section 4 — Hop 2: bob → @alice (2 UCT)
# This creates the OUTBOX entry that the pre-fix guard would later trip on.
# ---------------------------------------------------------------------------
banner "Section 4: HOP 2 — bob → @${ALICE_TAG} (2 UCT)"

cd "$PEER_BOB"
sphere wallet use bob
sphere payments send "@${ALICE_TAG}" 2 UCT 2>&1 | tee "$SNAP/hop2-bob-send.log"

if contains_duplicate_bundle_error "$SNAP/hop2-bob-send.log"; then
  echo "ASSERT FAIL (hop2-no-dup-bundle-err): bob's first send tripped duplicate-bundle guard" >&2
  exit 1
fi

cd "$PEER_ALICE"
sphere wallet use alice
sphere payments sync                2>&1 | tee "$SNAP/hop2-alice-sync.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/hop2-alice-receive.log"
sphere balance | tee "$SNAP/alice-balance-2.txt"

cd "$PEER_BOB"
sphere wallet use bob
sphere payments sync                2>&1 | tee "$SNAP/hop2-bob-sync.log"
sphere balance | tee "$SNAP/bob-balance-2.txt"

# ---------------------------------------------------------------------------
# Section 5 — Hop 3: alice → @bob (91 UCT)
# Alice has 92 UCT in 2 tokens (90 change + 2 from bob). This send forces
# a whole-token transfer of the 2-UCT token PLUS a split of the 90-UCT
# token → bob receives the 2-UCT token's tokenId verbatim (round-trip!)
# plus a new 89-UCT mint.
# ---------------------------------------------------------------------------
banner "Section 5: HOP 3 — alice → @${BOB_TAG} (91 UCT)"

cd "$PEER_ALICE"
sphere wallet use alice
sphere payments send "@${BOB_TAG}" 91 UCT 2>&1 | tee "$SNAP/hop3-alice-send.log"

if contains_duplicate_bundle_error "$SNAP/hop3-alice-send.log"; then
  echo "ASSERT FAIL (hop3-no-dup-bundle-err): alice's 91-UCT send tripped duplicate-bundle guard" >&2
  exit 1
fi

cd "$PEER_BOB"
sphere wallet use bob
sphere payments sync                2>&1 | tee "$SNAP/hop3-bob-sync.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/hop3-bob-receive.log"
sphere balance | tee "$SNAP/bob-balance-3.txt"

cd "$PEER_ALICE"
sphere wallet use alice
sphere payments sync                2>&1 | tee "$SNAP/hop3-alice-sync.log"
sphere balance | tee "$SNAP/alice-balance-3.txt"

# ---------------------------------------------------------------------------
# Section 6 — Hop 4: bob → @alice (98.5 UCT)  ← #391 critical hop
#
# Bob has 99 UCT in 3 tokens (8 change + 2 round-tripped + 89 received).
# To send 98.5, the spend planner picks at least the round-tripped 2-UCT
# token whose on-chain tokenId equals alice's hop-2 recipient tokenId,
# AND that tokenId is STILL referenced by bob's `delivered-instant`
# OUTBOX entry from hop 2 (which never advanced past delivered-instant
# because the SentReconciliationWorker's 60s first-scan delay outlived
# the short CLI process between hops).
#
# Pre-fix:  guard compared candidate against entry.tokenIds (recipient
#           set) → match → throw DUPLICATE_BUNDLE_MEMBERSHIP.
# Post-fix: guard compares candidate against entry.sourceTokenIds
#           (bob's burned source) → no match → send proceeds. The
#           load-tail SENT-reconciliation sweep also runs once at the
#           start of bob's CLI process and tombstones the stale entry
#           outright; either fix alone breaks the failure mode.
#
# **Issue #393 layered effect.** With automated CID delivery currently
# disabled (kill-switch in modules/payments/transfer/limits.ts), this
# hop's bundle (3 source tokens, each carrying multi-hop history) ALSO
# exceeds the 96 KiB inline ceiling and throws INLINE_CAR_TOO_LARGE
# from the dispatcher pre-flight. That secondary throw is EXPECTED
# post-#393 and is treated as a "soft pass" here: the load-bearing
# assertion is that bob's send did NOT trip the duplicate-bundle
# guard. The full balance reconciliation in Section 7 is conditional
# on HOP 4 actually delivering — when it doesn't (the expected
# post-#393 outcome), the section emits an INFO line and the soak
# exits 0 if the #391 invariant held.
# ---------------------------------------------------------------------------
banner "Section 6: HOP 4 — bob → @${ALICE_TAG} (98.5 UCT) ← #391 CRITICAL HOP"

cd "$PEER_BOB"
sphere wallet use bob
# Capture exit code so the script doesn't abort on the now-expected
# post-#393 INLINE_CAR_TOO_LARGE failure. The duplicate-bundle
# assertion below is the load-bearing check.
hop4_send_rc=0
sphere payments send "@${ALICE_TAG}" 98.5 UCT 2>&1 | tee "$SNAP/hop4-bob-send.log" || hop4_send_rc=$?
echo "hop4-bob-send exit code: $hop4_send_rc"

if contains_duplicate_bundle_error "$SNAP/hop4-bob-send.log"; then
  echo "ASSERT FAIL (hop4-no-dup-bundle-err): bob's 98.5-UCT send tripped duplicate-bundle guard (#391 REGRESSION)" >&2
  exit 1
fi
echo "ASSERT OK (hop4-no-dup-bundle-err): bob's 98.5-UCT send passed the duplicate-bundle guard (#391 INVARIANT VERIFIED)"

# Detect the post-#393 documented limit and short-circuit the
# subsequent balance reconciliation when it fires. The #393 message
# is fingerprint-stable per the throw in
# `modules/payments/transfer/instant-sender.ts`.
#
# **Issue #394 strict mode.** Set `STRICT_CID_DELIVERY=1` to require
# HOP 4 to ACTUALLY DELIVER (via CID-over-Nostr when the bundle
# exceeds the inline cap). When the SDK has `AUTOMATED_CID_DELIVERY_ENABLED = true`
# AND the CLI's `buildSphereProviders` wires `publishToIpfs`
# (sphere-cli issue #394), this assertion holds. The two states the
# soak covers:
#   - `STRICT_CID_DELIVERY` unset (default): post-#393 soft-pass —
#     INLINE_CAR_TOO_LARGE is acceptable; balance reconciliation is
#     skipped; soak still exits 0 because the #391 invariant held.
#   - `STRICT_CID_DELIVERY=1`: post-#394 hard requirement —
#     INLINE_CAR_TOO_LARGE means the publisher wiring is broken or
#     the kill-switch is off; fail the soak.
hop4_delivered=1
if grep -qE 'INLINE_CAR_TOO_LARGE|automated CID delivery is currently disabled' \
    "$SNAP/hop4-bob-send.log"; then
  hop4_delivered=0
  if [[ "${STRICT_CID_DELIVERY:-0}" == "1" ]]; then
    echo "ASSERT FAIL (hop4-cid-must-deliver): STRICT_CID_DELIVERY=1 set, but HOP 4 threw INLINE_CAR_TOO_LARGE — kill-switch off OR CLI publisher not wired (sphere-cli #394 + sphere-sdk #394)." >&2
    exit 1
  fi
  echo "ASSERT INFO (hop4-cid-disabled): bundle exceeded inline cap AND automated CID delivery is OFF (#393); HOP 4 did not deliver. The #391 invariant is still verified by the assertion above. Skipping balance reconciliation. (Pass STRICT_CID_DELIVERY=1 to fail-fast on this outcome.)"
fi

if (( hop4_delivered == 1 )); then
  cd "$PEER_ALICE"
  sphere wallet use alice
  sphere payments sync                2>&1 | tee "$SNAP/hop4-alice-sync.log"
  sphere payments receive --finalize  2>&1 | tee "$SNAP/hop4-alice-receive.log"
  sphere balance | tee "$SNAP/alice-balance-4.txt"

  cd "$PEER_BOB"
  sphere wallet use bob
  sphere payments sync                2>&1 | tee "$SNAP/hop4-bob-sync.log"
  sphere balance | tee "$SNAP/bob-balance-4.txt"
fi

# ---------------------------------------------------------------------------
# Section 7 — Verify balances (integer-only)
#
# Expected net positions (smallest UCT units; 1 UCT = 10^8):
#   alice (faucet baseline) - 10  + 2  - 91 + 98.5 =  -0.5
#   bob                     + 10  - 2  + 91 - 98.5 =  +0.5
#
# So:
#   alice_final - alice_0 = -0.5 UCT = -50_000_000
#   bob_final   - bob_0   = +0.5 UCT = +50_000_000
#
# **Issue #393.** When HOP 4 hits the disabled-automated-CID throw
# (expected post-#393), there is no balance to reconcile against.
# Section 7 emits an INFO line and is skipped — the #391 invariant
# assertion above is the load-bearing check.
# ---------------------------------------------------------------------------
banner "Section 7: Verify net deltas (integer-only)"

rc=0
if (( hop4_delivered == 0 )); then
  echo "ASSERT INFO (section-7-skipped): HOP 4 did not deliver (post-#393 expected). Skipping balance reconciliation; #391 invariant verified above."
else
  alice_0=$(extract_uct_confirmed_smallest_units < "$SNAP/alice-balance-0.txt")
  alice_4=$(extract_uct_confirmed_smallest_units < "$SNAP/alice-balance-4.txt")
  bob_0=$(  extract_uct_confirmed_smallest_units < "$SNAP/bob-balance-0.txt")
  bob_4=$(  extract_uct_confirmed_smallest_units < "$SNAP/bob-balance-4.txt")

  echo "alice CONFIRMED hop-0 baseline: $alice_0  (smallest units)"
  echo "alice CONFIRMED hop-4 final:    $alice_4  (smallest units)"
  echo "bob   CONFIRMED hop-0 baseline: $bob_0    (smallest units)"
  echo "bob   CONFIRMED hop-4 final:    $bob_4    (smallest units)"

  # Net deltas. Use signed arithmetic; bash supports negatives in $((...)).
  alice_net_delta=$(( alice_4 - alice_0 ))
  bob_net_delta=$(  ( bob_4   - bob_0   ) )
  expected_alice=-50000000
  expected_bob=50000000

  echo
  echo "alice net delta (final - baseline): $alice_net_delta"
  echo "bob   net delta (final - baseline): $bob_net_delta"
  echo "expected alice:                     $expected_alice  (-0.5 UCT × 10^8)"
  echo "expected bob:                       $expected_bob   (+0.5 UCT × 10^8)"

  if (( alice_net_delta == expected_alice )); then
    echo "ASSERT OK (alice-net-delta-minus-0.5-UCT)"
  else
    echo "ASSERT FAIL (alice-net-delta-minus-0.5-UCT): expected $expected_alice, got $alice_net_delta" >&2
    rc=1
  fi
  if (( bob_net_delta == expected_bob )); then
    echo "ASSERT OK (bob-net-delta-plus-0.5-UCT)"
  else
    echo "ASSERT FAIL (bob-net-delta-plus-0.5-UCT): expected $expected_bob, got $bob_net_delta" >&2
    rc=1
  fi
fi

# Per-hop status sanity: no DUPLICATE_BUNDLE_MEMBERSHIP in any send log
# (re-asserted as a single sweep so a future regression that adds the
# error to a non-critical hop is also caught).
banner "Section 8: Cross-hop duplicate-bundle scan"
for f in \
    "$SNAP/hop1-alice-send.log" \
    "$SNAP/hop2-bob-send.log" \
    "$SNAP/hop3-alice-send.log" \
    "$SNAP/hop4-bob-send.log"; do
  if contains_duplicate_bundle_error "$f"; then
    echo "ASSERT FAIL (cross-hop-dup-bundle-scan): $f contains DUPLICATE_BUNDLE_MEMBERSHIP" >&2
    rc=1
  fi
done
if (( rc == 0 )); then
  echo "ASSERT OK (cross-hop-dup-bundle-scan): no DUPLICATE_BUNDLE_MEMBERSHIP in any send log"
fi

# Unconfirmed residue check — both wallets must settle cleanly after
# finalize. Mirrors manual-test-simple-send.sh §#389 #2 gate.
check_no_unconfirmed() {
  local label="$1" snapshot="$2"
  local pat='\(\+ [0-9.]*[1-9][0-9.]* unconfirmed\)'
  if grep -qE "$pat" "$snapshot"; then
    echo "ASSERT FAIL ($label): non-zero unconfirmed residue in post-finalize snapshot" >&2
    grep -nE "$pat" "$snapshot" >&2 || true
    return 1
  fi
  echo "ASSERT OK ($label): no unconfirmed residue post-finalize"
}

if (( hop4_delivered == 1 )); then
  check_no_unconfirmed "alice-balance-4" "$SNAP/alice-balance-4.txt" || rc=1
  check_no_unconfirmed "bob-balance-4"   "$SNAP/bob-balance-4.txt"   || rc=1
fi

echo
if (( rc == 0 )); then
  if (( hop4_delivered == 1 )); then
    banner "ALL GREEN — 4-hop A→B→A→B→A round-trip succeeded; #391 guard + load-tail fix verified"
  else
    banner "GREEN-WITH-NOTE — #391 invariant verified (no duplicate-bundle false-positive). HOP 4 did not deliver because automated CID is disabled (#393); balance reconciliation skipped."
  fi
else
  banner "FAIL — see ASSERT FAIL lines above"
fi
exit "$rc"
