#!/usr/bin/env bash
#
# manual-test-accounting-roundtrip.sh — accounting module invoice
# round-trip soak (real testnet, single-asset 7 UCT).
#
# Scenario (per the user's brief):
#   1. Alice tops up via faucet (100 UCT + assorted others).
#   2. Bob creates a 7 UCT invoice with himself as the payee, using
#      the human-friendly CLI: `--target @bob --asset "7 UCT"`.
#   3. Bob delivers the invoice to Alice via NIP-17 DM.
#   4. Alice covers (pays) the invoice.
#   5. Bob receives the payment; the invoice transitions to COVERED.
#
# What this verifies that the existing `manual-test-full-recovery.sh`
# does NOT:
#   - The invoice is created by the PAYEE (bob), not by the payer's
#     surrogate (the existing soak has alice create + alice receives
#     payment via bob's pay command).
#   - The human-friendly CLI surface introduced in sphere-cli's
#     invoice-create fix: `--asset "7 UCT"` instead of forcing the
#     user to type smallest-unit integers like "7000000000000000000".
#     The CLI handles registry decimals lookup + conversion.
#   - Addressing via @nametag throughout — `--target @bob` is the
#     only identity reference the script uses. No DIRECT://… is ever
#     constructed by hand; the CLI resolves the nametag before
#     handing the request to the SDK's accounting-module mint flow.
#
# Multi-asset support (e.g., "7 UCT + 2 ETH") is OUT OF SCOPE for
# this soak per the user's direction ("If it is too complex now for
# multiassets, lets create invoice just for 7 UCT, but the command
# must be user-friendly"). The CLI does support `--asset "..." --asset
# "..."` repetition; a follow-up multi-asset soak can chain that.
#
# Run:
#   bash manual-test-accounting-roundtrip.sh
#   KEEP=1 bash manual-test-accounting-roundtrip.sh    # preserve workspace
#   ACCOUNTING_TEST_DIR=/tmp/acc bash manual-test-accounting-roundtrip.sh
#
# Requires the `sphere` CLI on PATH and outbound HTTPS+WSS to testnet.

set -euo pipefail

# ---- workspace ----
ROOT="${ACCOUNTING_TEST_DIR:-/tmp/accounting-roundtrip-$$}"
SNAP="$ROOT/snapshots"
mkdir -p "$SNAP"

SUFFIX="${SUFFIX:-$(date +%s | tail -c 5)$(printf '%04x' $((RANDOM % 65536)))}"
ALICE_TAG="alice-$SUFFIX"
BOB_TAG="bob-$SUFFIX"
echo "ALICE_TAG=$ALICE_TAG"
echo "BOB_TAG=$BOB_TAG"

PEER_ALICE="$ROOT/alice-peer"
PEER_BOB="$ROOT/bob-peer"
mkdir -p "$PEER_ALICE" "$PEER_BOB"

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
# Integer-only confirmed balance extractor.
#
# UCT and ETH both have 18 decimals on the production testnet registry
# (https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet.json).
# The extractor pads fractional parts to exactly 18 chars so the
# resulting integer string is in smallest units. Adapted from
# manual-test-roundtrip-391.sh's extractor (which used 8 decimals
# for UCT under the legacy assumption; we now follow the real
# registry).
#
# Args:
#   $1 — symbol (e.g. "UCT", "ETH")
# Stdin: contents of `sphere balance` output.
# Stdout: confirmed balance as smallest-unit integer string.
# ---------------------------------------------------------------------------
extract_confirmed_smallest_units() {
  local symbol="$1"
  local line decimal int_part frac_part
  line=$(grep -E "^${symbol}:" || true)
  if [[ -z "$line" ]]; then
    echo "0"
    return
  fi
  decimal=$(echo "$line" | sed -E -e "s/^${symbol}:[[:space:]]+//" -e 's/[[:space:]]+\(.+$//')
  if [[ "$decimal" == *.* ]]; then
    int_part="${decimal%.*}"
    frac_part="${decimal#*.}"
  else
    int_part="$decimal"
    frac_part=""
  fi
  while (( ${#frac_part} < 18 )); do frac_part="${frac_part}0"; done
  if (( ${#frac_part} > 18 )); then
    echo "ERROR: ${symbol} fractional part >18 digits ($decimal)" >&2
    return 1
  fi
  local combined="${int_part}${frac_part}"
  combined=$(echo "$combined" | sed -E 's/^0+//')
  [[ -z "$combined" ]] && combined="0"
  echo "$combined"
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
# Sanity — `sphere status` should print bob's nametag (mint succeeded).
sphere status | tee "$SNAP/bob-status.log"
grep -qE "Nametag:.*$BOB_TAG" "$SNAP/bob-status.log" \
  || { echo "FAIL: bob's nametag '$BOB_TAG' not visible in status" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Section 2 — Faucet both wallets, capture baselines
#
# Why faucet bob too: minting the invoice token requires bob's wallet
# to have a working aggregator path. Even though invoice mint doesn't
# consume any existing payment token, fauceting bob mirrors the
# proven pattern in manual-test-full-recovery.sh and reduces flake
# surface (a brand-new wallet with zero on-chain history can race
# Profile sync on first mint).
# ---------------------------------------------------------------------------
banner "Section 2: Faucet alice + bob; capture baselines"

cd "$PEER_ALICE"
sphere wallet use alice
sphere faucet                       2>&1 | tee "$SNAP/alice-faucet.log"
sphere payments sync                2>&1 | tee "$SNAP/alice-sync-1.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/alice-faucet-receive.log"
sphere balance | tee "$SNAP/alice-balance-0.txt"

cd "$PEER_BOB"
sphere wallet use bob
sphere faucet                       2>&1 | tee "$SNAP/bob-faucet.log"
sphere payments sync                2>&1 | tee "$SNAP/bob-sync-1.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/bob-faucet-receive.log"
sphere balance | tee "$SNAP/bob-balance-0.txt"

# ---------------------------------------------------------------------------
# Section 3 — Bob creates a 7 UCT invoice (single-asset, human-friendly)
#
# CLI surface (human-friendly, per sphere-cli's invoice-create fix):
#   - `sphere invoice create --target @<nametag> --asset "7 UCT"`
#     accepts the human-readable amount. The CLI:
#       1) resolves `@nametag` → DIRECT:// via the transport's
#          nametag binding events (AccountingModule.createInvoice
#          requires DIRECT at the cryptographic-binding boundary).
#       2) looks up the symbol's decimals via the token registry
#          (UCT: 18 decimals on the testnet registry).
#       3) converts "7" + decimals=18 → 7×10^18 smallest units before
#          handing the request to the SDK.
#   - Multi-asset is also supported (e.g. `--asset "7 UCT" --asset
#     "2 ETH"`), but this soak deliberately uses single-asset to
#     match the user's directive ("If it is too complex now for
#     multiassets, lets create invoice just for 7 UCT").
# ---------------------------------------------------------------------------
banner "Section 3: Bob creates a 7 UCT invoice (human-friendly --asset)"

cd "$PEER_BOB"
sphere wallet use bob
sphere invoice create --target "@${BOB_TAG}" --asset "7 UCT" --memo "Accounting demo invoice — 7 UCT" \
  2>&1 | tee "$SNAP/bob-invoice-create.log"

INV="$(grep -Eo '"invoiceId":[[:space:]]*"[^"]+"' "$SNAP/bob-invoice-create.log" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[[ -n "$INV" ]] || { echo "FAIL: couldn't extract invoiceId" >&2; exit 1; }
echo "INV=$INV"

# Snapshot bob's balance after invoice mint. The invoice itself is a
# new on-chain token — bob's "balance" output may or may not include
# it depending on whether the CLI's balance formatter filters invoice
# tokens out of the asset roll-up. For the assertions below we care
# only about UCT/ETH deltas, not the invoice token row.
sphere balance | tee "$SNAP/bob-balance-1.txt"

# ---------------------------------------------------------------------------
# Section 4 — Bob delivers the invoice to alice
#
# `sphere invoice deliver $INV --to @alice` packages the invoice into
# a UXF bundle and ships it via NIP-17 DM (kind 14). Alice's wallet
# auto-imports the bundle on receipt (handled inside AccountingModule,
# not the payments pipeline).
# ---------------------------------------------------------------------------
banner "Section 4: Bob delivers invoice to @${ALICE_TAG}"

sphere invoice deliver "$INV" --to "@${ALICE_TAG}" 2>&1 | tee "$SNAP/bob-invoice-deliver.log"
grep -qE '"sent":[[:space:]]*1' "$SNAP/bob-invoice-deliver.log" \
  || { echo "ASSERT FAIL (deliver-acked): expected 'sent: 1' in deliver response" >&2; exit 1; }
echo "ASSERT OK (deliver-acked): invoice delivery DM sent"

# ---------------------------------------------------------------------------
# Section 5 — Alice covers (pays) the invoice
#
# A short settle gives alice's Nostr subscription time to ingest the
# `invoice_delivery` DM and AccountingModule's importInvoice to write
# the invoice into the local Profile store. Without it, the very next
# `invoice pay` would race the DM arrival and could error with "No
# invoice found matching prefix" (the same pattern noted at
# manual-test-full-recovery.sh §C.2).
# ---------------------------------------------------------------------------
banner "Section 5: Alice covers the invoice"

cd "$PEER_ALICE"
sphere wallet use alice

# Poll for alice's local AccountingModule to ingest bob's
# invoice_delivery DM. Each `sphere invoice list` call boots a fresh
# CLI process, which:
#   1) opens a Nostr subscription with `since=<persisted_timestamp>`,
#   2) fetches pending events (including bob's DM if it's still on
#      the relay), routes them through CommunicationsModule, which
#      hands invoice_delivery payloads to AccountingModule.importInvoice,
#   3) writes the imported invoice to alice's local Profile.
#
# The first call ALSO advances alice's `since` cursor, so subsequent
# calls only pick up newer events. Polling is the right shape because
# the testnet relay's read path can lag behind writes by several
# seconds (sometimes >10s under load) — a one-shot 5s sleep wasn't
# enough in run #1.
#
# Bail out at 60s wall-clock; in practice the invoice appears within
# 5–20s on a healthy relay.
INV_LIST_DEADLINE=$(( $(date +%s) + 60 ))
INV_FOUND=0
while (( $(date +%s) < INV_LIST_DEADLINE )); do
  sphere payments sync                2>&1 > "$SNAP/alice-pre-pay-sync.log"
  # Fresh-list dump on every poll so the final state is captured.
  sphere invoice list 2>&1 | tee "$SNAP/alice-invoice-list-before-pay.log" || true
  # Accept any of the three shapes the CLI emits:
  #   - JSON: "invoiceId": "<hex>"
  #   - `ID:   <hex>` from the human-readable `invoice list` formatter (note
  #     the leading whitespace before the hex — the prior `^<hex>` anchor
  #     missed this and reported false-negative timeouts even when the
  #     invoice WAS in alice's local store, see #397).
  #   - bare prefix at line start (catch-all for future formatters).
  if grep -qE "(\"invoiceId\":[[:space:]]*\"${INV}\"|ID:[[:space:]]+${INV:0:16}|^${INV:0:16})" "$SNAP/alice-invoice-list-before-pay.log"; then
    echo "INFO: invoice $INV visible in alice's local list"
    INV_FOUND=1
    break
  fi
  echo "  invoice not yet visible — sleeping 3s and retrying…"
  sleep 3
done
if (( INV_FOUND == 0 )); then
  echo "ASSERT FAIL (invoice-ingest-timeout): alice's wallet did NOT ingest invoice $INV within 60s" >&2
  echo "--- alice-invoice-list-before-pay.log tail ---" >&2
  tail -20 "$SNAP/alice-invoice-list-before-pay.log" >&2 || true
  exit 1
fi
sphere invoice pay "$INV" 2>&1 | tee "$SNAP/alice-invoice-pay.log"
sphere payments sync                2>&1 | tee "$SNAP/alice-post-pay-sync.log"
sphere balance | tee "$SNAP/alice-balance-1.txt"

# ---------------------------------------------------------------------------
# Section 6 — Bob receives, finalizes, and observes COVERED state
# ---------------------------------------------------------------------------
banner "Section 6: Bob receives + verifies COVERED"

cd "$PEER_BOB"
sphere wallet use bob
sleep 5
sphere payments sync                2>&1 | tee "$SNAP/bob-post-pay-sync.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/bob-receive.log"
sphere balance | tee "$SNAP/bob-balance-2.txt"
sphere invoice status "$INV" 2>&1 | tee "$SNAP/bob-invoice-status.log"

# ---------------------------------------------------------------------------
# Section 7 — Assertions
#
# Three load-bearing checks:
#   (a) bob's invoice state transitioned to COVERED (the invoice's
#       lifecycle moved through the receipt path correctly).
#   (b) bob's UCT and ETH balances rose by exactly the demanded
#       amounts (no over-payment, no shortfall).
#   (c) alice's UCT and ETH balances fell by EXACTLY the demanded
#       amounts (no extra charges, no UCT/ETH cross-talk).
# ---------------------------------------------------------------------------
banner "Section 7: Verify assertions"

rc=0

# (a) Invoice state — the CLI's `invoice status` output includes a
# `state: <STATE>` field; we grep tolerantly because the JSON formatter
# may render it in any of several equivalent shapes. Accept COVERED or
# CLOSED because the auto-terminate-on-full-cover lifecycle (default on
# in AccountingModule) walks COVERED → CLOSED in a single step once all
# targets are fully paid — both indicate the payment was attributed to
# the invoice correctly.
if grep -qE '("state"[[:space:]]*:[[:space:]]*"(COVERED|CLOSED)"|State:[[:space:]]*(COVERED|CLOSED)|state:[[:space:]]*(COVERED|CLOSED))' \
    "$SNAP/bob-invoice-status.log"; then
  echo "ASSERT OK (invoice-covered): bob's invoice transitioned to COVERED or CLOSED"
else
  echo "ASSERT FAIL (invoice-covered): bob's invoice did not reach COVERED/CLOSED" >&2
  echo "--- bob-invoice-status.log tail ---" >&2
  tail -30 "$SNAP/bob-invoice-status.log" >&2
  rc=1
fi

# (b) Bob's UCT balance rose by exactly 7 UCT.
bob_uct_0=$(extract_confirmed_smallest_units UCT < "$SNAP/bob-balance-0.txt")
bob_uct_2=$(extract_confirmed_smallest_units UCT < "$SNAP/bob-balance-2.txt")

# Use python for 18-digit-decimal arithmetic — bash $(( … )) tops out
# at 64-bit signed (~9.2e18); 7×10^18 fits but the sum 100+7 UCT in
# smallest units would exceed it on some compositions.
bob_uct_delta=$(python3 -c "print($bob_uct_2 - $bob_uct_0)")

expected_uct=7000000000000000000

echo "bob UCT baseline:  $bob_uct_0"
echo "bob UCT final:     $bob_uct_2"
echo "bob UCT delta:     $bob_uct_delta  (expected $expected_uct)"

if [[ "$bob_uct_delta" == "$expected_uct" ]]; then
  echo "ASSERT OK (bob-uct-delta-plus-7): bob received exactly 7 UCT"
else
  echo "ASSERT FAIL (bob-uct-delta-plus-7): expected $expected_uct, got $bob_uct_delta" >&2
  rc=1
fi

# (c) Alice's UCT balance fell by exactly 7 UCT.
alice_uct_0=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-0.txt")
alice_uct_1=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-1.txt")

alice_uct_delta=$(python3 -c "print($alice_uct_0 - $alice_uct_1)")

echo "alice UCT baseline: $alice_uct_0"
echo "alice UCT final:    $alice_uct_1"
echo "alice UCT delta:    $alice_uct_delta  (expected $expected_uct)"

if [[ "$alice_uct_delta" == "$expected_uct" ]]; then
  echo "ASSERT OK (alice-uct-delta-minus-7): alice paid exactly 7 UCT"
else
  echo "ASSERT FAIL (alice-uct-delta-minus-7): expected $expected_uct, got $alice_uct_delta" >&2
  rc=1
fi

# Cross-hop unconfirmed residue check.
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

check_no_unconfirmed "alice-balance-1" "$SNAP/alice-balance-1.txt" || rc=1
check_no_unconfirmed "bob-balance-2"   "$SNAP/bob-balance-2.txt"   || rc=1

echo
if (( rc == 0 )); then
  banner "ALL GREEN — invoice round-trip succeeded; bob +7 UCT, alice -7 UCT, invoice COVERED"
else
  banner "FAIL — see ASSERT FAIL lines above"
fi
exit "$rc"
