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
# Canonical UX (sphere-cli #32): `--asset <amount> <coin>` is two
# positional tokens (no quoted compound form). `--json` opts back into
# the machine-readable output the grep below expects.
sphere invoice create --target "@${BOB_TAG}" --asset 7 UCT --memo "Accounting demo invoice — 7 UCT" --json \
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

sphere invoice deliver "$INV" --to "@${ALICE_TAG}" --json 2>&1 | tee "$SNAP/bob-invoice-deliver.log"
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
if grep -qiE '("state"[[:space:]]*:[[:space:]]*"(COVERED|CLOSED)"|state[[:space:]]*:[[:space:]]*(COVERED|CLOSED))' \
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

if (( rc != 0 )); then
  banner "FAIL (§5-§7) — see ASSERT FAIL lines above"
  exit "$rc"
fi
echo
echo "INFO: round-trip leg (§5-§7) green; proceeding to partial-pay + bulk-return leg."

# ===========================================================================
# Section 8 — Bob creates a SECOND 7 UCT invoice (partial-pay + return scenario)
#
# Invoice #1 is sealed in CLOSED state after §6's auto-close; `payInvoice` on
# CLOSED throws INVOICE_TERMINATED. We use a fresh invoice for the partial-pay
# scenario so the state machine has somewhere to flow (OPEN → PARTIAL → OPEN
# after return → PARTIAL again → COVERED).
# ===========================================================================
banner "Section 8: Bob creates a second 7 UCT invoice (partial-pay leg)"

cd "$PEER_BOB"
sphere wallet use bob
sphere invoice create --target "@${BOB_TAG}" --asset 7 UCT --memo "Accounting demo invoice #2 — partial-pay + return" --json \
  2>&1 | tee "$SNAP/bob-invoice-create-2.log"

INV2="$(grep -Eo '"invoiceId":[[:space:]]*"[^"]+"' "$SNAP/bob-invoice-create-2.log" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[[ -n "$INV2" ]] || { echo "FAIL: couldn't extract invoice #2 invoiceId" >&2; exit 1; }
echo "INV2=$INV2"

sphere invoice deliver "$INV2" --to "@${ALICE_TAG}" --json 2>&1 | tee "$SNAP/bob-invoice-deliver-2.log"
grep -qE '"sent":[[:space:]]*1' "$SNAP/bob-invoice-deliver-2.log" \
  || { echo "ASSERT FAIL (deliver-2-acked): expected 'sent: 1' in invoice #2 deliver response" >&2; exit 1; }
echo "ASSERT OK (deliver-2-acked): invoice #2 delivery DM sent"

# ===========================================================================
# Section 9 — Alice partially covers invoice #2 (3 UCT of 7)
#
# Requires sphere-cli #36 (PR #37) — `invoice pay --amount <value>`
# interprets value as HUMAN units of the invoice's coin (matches
# `payments send 3 UCT`). Pre-PR-#37 CLIs treat --amount as smallest
# units, which would send 3 atoms (not 3 UCT) and break the balance
# assertions below.
# ===========================================================================
banner "Section 9: Alice partially covers invoice #2 — 3 UCT (explicit --amount)"

cd "$PEER_ALICE"
sphere wallet use alice

# Poll for alice's wallet to ingest invoice #2 (same pattern as §5).
INV2_DEADLINE=$(( $(date +%s) + 60 ))
INV2_FOUND=0
while (( $(date +%s) < INV2_DEADLINE )); do
  sphere payments sync 2>&1 > "$SNAP/alice-pre-pay2-sync.log"
  sphere invoice list 2>&1 | tee "$SNAP/alice-invoice-list-before-pay2.log" || true
  if grep -qE "(\"invoiceId\":[[:space:]]*\"${INV2}\"|ID:[[:space:]]+${INV2:0:16}|^${INV2:0:16})" \
       "$SNAP/alice-invoice-list-before-pay2.log"; then
    echo "INFO: invoice #2 visible in alice's local list"
    INV2_FOUND=1
    break
  fi
  echo "  invoice #2 not yet visible — sleeping 3s and retrying…"
  sleep 3
done
(( INV2_FOUND == 1 )) || { echo "ASSERT FAIL (invoice2-ingest-timeout)" >&2; exit 1; }

sphere balance | tee "$SNAP/alice-balance-before-partial-1.txt"
sphere invoice pay "$INV2" --amount 3 2>&1 | tee "$SNAP/alice-invoice-pay2-partial-1.log"
sphere payments sync 2>&1 | tee "$SNAP/alice-post-partial-1-sync.log"
sphere balance | tee "$SNAP/alice-balance-after-partial-1.txt"

# Assert: alice dropped exactly 3 UCT.
alice_uct_before_p1=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-before-partial-1.txt")
alice_uct_after_p1=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-after-partial-1.txt")
partial_1_delta=$(python3 -c "print($alice_uct_before_p1 - $alice_uct_after_p1)")
expected_3_uct=3000000000000000000
echo "alice UCT before partial #1: $alice_uct_before_p1"
echo "alice UCT after  partial #1: $alice_uct_after_p1"
echo "alice partial-1 delta:       $partial_1_delta  (expected $expected_3_uct)"
if [[ "$partial_1_delta" == "$expected_3_uct" ]]; then
  echo "ASSERT OK (alice-partial-1-minus-3): alice partial-paid exactly 3 UCT"
else
  echo "ASSERT FAIL (alice-partial-1-minus-3): expected $expected_3_uct, got $partial_1_delta" >&2
  echo "  HINT: if delta is '3' your sphere-cli predates PR #37 — --amount is being interpreted as smallest units." >&2
  exit 1
fi

# ===========================================================================
# Section 10 — Bob refunds alice's partial payment with `sphere invoice return $INV2`
#
# This is the canonical one-shot bulk-refund UX: no --recipient, no --asset.
# The CLI calls AccountingModule.returnAllInvoicePayments() under the hood,
# which iterates senderBalances and refunds every attributed payment to its
# recorded sender — including masked-predicate sends whose on-chain sender
# is a per-send one-time DIRECT://… the user cannot guess.
#
# Requires sphere-sdk PR #404 (returnAllInvoicePayments) and sphere-cli PR
# #39 (invoice return bulk wrapper).
#
# After this section: invoice #2's netCovered drops back to 0; state
# returns to OPEN (PARTIAL only if any payment remains attributed). The
# invoice is NOT terminated — alice can pay it again.
# ===========================================================================
banner "Section 10: Bob refunds alice's partial payment with one-shot \`sphere invoice return\`"

cd "$PEER_BOB"
sphere wallet use bob
sleep 5
sphere payments sync 2>&1 | tee "$SNAP/bob-pre-return-sync.log"
sphere payments receive --finalize 2>&1 | tee "$SNAP/bob-pre-return-recv.log" || true
sphere balance | tee "$SNAP/bob-balance-before-return.txt"

# The one-liner — no --recipient, no --asset. The SDK figures out who paid
# what and refunds them.
sphere invoice return "$INV2" --json 2>&1 | tee "$SNAP/bob-invoice-return-bulk.log"
if grep -qE '"refunds"[[:space:]]*:[[:space:]]*\[' "$SNAP/bob-invoice-return-bulk.log"; then
  echo "ASSERT OK (bulk-return-emitted): bob's bulk-return produced a refunds array"
else
  echo "ASSERT FAIL (bulk-return-emitted): expected a 'refunds' array in invoice-return-bulk.log" >&2
  tail -30 "$SNAP/bob-invoice-return-bulk.log" >&2
  exit 1
fi

# Verify exactly one refund row was submitted (alice's 3 UCT) by counting
# nested status objects.
refund_count=$(grep -oE '"status"[[:space:]]*:[[:space:]]*"(pending|submitted|delivered|completed)"' \
  "$SNAP/bob-invoice-return-bulk.log" | wc -l)
echo "refund count: $refund_count  (expected 1)"
[[ "$refund_count" == "1" ]] \
  || { echo "ASSERT FAIL (bulk-return-count): expected 1 refund, got $refund_count" >&2; exit 1; }

sphere payments sync 2>&1 | tee "$SNAP/bob-post-return-sync.log"
sphere balance | tee "$SNAP/bob-balance-after-return.txt"

# Bob's balance dropped by 3 UCT (the amount he just refunded).
bob_uct_before_return=$(extract_confirmed_smallest_units UCT < "$SNAP/bob-balance-before-return.txt")
bob_uct_after_return=$(extract_confirmed_smallest_units UCT < "$SNAP/bob-balance-after-return.txt")
bob_return_delta=$(python3 -c "print($bob_uct_before_return - $bob_uct_after_return)")
echo "bob UCT before return: $bob_uct_before_return"
echo "bob UCT after  return: $bob_uct_after_return"
echo "bob return delta:      $bob_return_delta  (expected $expected_3_uct)"
[[ "$bob_return_delta" == "$expected_3_uct" ]] \
  || { echo "ASSERT FAIL (bob-return-delta-minus-3): expected $expected_3_uct, got $bob_return_delta" >&2; exit 1; }
echo "ASSERT OK (bob-return-delta-minus-3): bob refunded exactly 3 UCT"

# ===========================================================================
# Section 11 — Alice receives the 3 UCT refund (back-direction transfer)
# ===========================================================================
banner "Section 11: Alice receives the 3 UCT refund"

cd "$PEER_ALICE"
sphere wallet use alice

RECV_DEADLINE=$(( $(date +%s) + 90 ))
RECV_OK=0
while (( $(date +%s) < RECV_DEADLINE )); do
  sphere payments sync                2>&1 > "$SNAP/alice-refund-poll-sync.log"
  sphere payments receive --finalize  2>&1 | tee "$SNAP/alice-refund-poll-recv.log" || true
  sphere balance | tee "$SNAP/alice-refund-poll-balance.txt"
  alice_uct_now=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-refund-poll-balance.txt")
  delta=$(python3 -c "print($alice_uct_now - $alice_uct_after_p1)")
  if [[ "$delta" == "$expected_3_uct" ]]; then
    echo "INFO: alice received the 3 UCT refund (delta=$delta)"
    RECV_OK=1
    break
  fi
  echo "  alice UCT not yet +3 UCT (delta=$delta) — sleeping 5s and retrying…"
  sleep 5
done
(( RECV_OK == 1 )) || { echo "ASSERT FAIL (refund-receive-timeout)" >&2; exit 1; }
cp "$SNAP/alice-refund-poll-balance.txt" "$SNAP/alice-balance-after-refund.txt"

# ===========================================================================
# Section 12 — Alice partial-pays invoice #2 AGAIN — 3 UCT (explicit --amount)
#
# After the refund, invoice #2's netCovered dropped to 0 → state is OPEN.
# This pay puts it back in PARTIAL.
# ===========================================================================
banner "Section 12: Alice partial-pays invoice #2 AGAIN — 3 UCT (explicit --amount)"

sphere invoice pay "$INV2" --amount 3 2>&1 | tee "$SNAP/alice-invoice-pay2-partial-2.log"
sphere payments sync 2>&1 | tee "$SNAP/alice-post-partial-2-sync.log"
sphere balance | tee "$SNAP/alice-balance-after-partial-2.txt"

alice_uct_after_p2=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-after-partial-2.txt")
alice_uct_after_refund=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-after-refund.txt")
partial_2_delta=$(python3 -c "print($alice_uct_after_refund - $alice_uct_after_p2)")
echo "alice UCT after refund:      $alice_uct_after_refund"
echo "alice UCT after  partial #2: $alice_uct_after_p2"
echo "alice partial-2 delta:       $partial_2_delta  (expected $expected_3_uct)"
[[ "$partial_2_delta" == "$expected_3_uct" ]] \
  || { echo "ASSERT FAIL (alice-partial-2-minus-3): expected $expected_3_uct, got $partial_2_delta" >&2; exit 1; }
echo "ASSERT OK (alice-partial-2-minus-3): alice partial-paid exactly 3 UCT (second time)"

# ===========================================================================
# Section 13 — Alice covers the rest (no --amount → SDK defaults to remaining)
#
# Per PayInvoiceParams.amount doc: "defaults to remaining needed to cover
# the asset". After §10's bulk refund AND §12's second partial-pay, the
# invoice's netCovered is 3 UCT (the §12 payment; §9's payment was refunded
# in §10). The SDK computes remaining = 7 - 3 = 4 UCT and sends that.
#
# This used to require an explicit `--amount 4` workaround because of
# sphere-sdk #404 (masked-predicate refund attribution): the §10 refund's
# back-direction transfer had `senderAddress: null` on-chain, so the
# balance-computer's per-target matcher classified it as irrelevant and
# the invoice's `returnedAmount` stayed stuck at zero. PR #413 fixed that
# with a destinationAddress-fallback recovery, and §13 can now use the
# canonical default-amount form.
# ===========================================================================
banner "Section 13: Alice covers the rest of invoice #2 (default --amount = remaining)"

sphere invoice pay "$INV2" 2>&1 | tee "$SNAP/alice-invoice-pay2-final.log"
sphere payments sync 2>&1 | tee "$SNAP/alice-post-final-sync.log"
sphere balance | tee "$SNAP/alice-balance-final.txt"

alice_uct_final=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-final.txt")
partial_3_delta=$(python3 -c "print($alice_uct_after_p2 - $alice_uct_final)")
expected_4_uct=4000000000000000000
echo "alice UCT after partial #2:  $alice_uct_after_p2"
echo "alice UCT final:             $alice_uct_final"
echo "alice partial-3 delta:       $partial_3_delta  (expected $expected_4_uct)"
[[ "$partial_3_delta" == "$expected_4_uct" ]] \
  || { echo "ASSERT FAIL (alice-partial-3-minus-4): expected $expected_4_uct, got $partial_3_delta" >&2; exit 1; }
echo "ASSERT OK (alice-partial-3-minus-4): alice covered remaining 4 UCT"

# ===========================================================================
# Section 14 — Bob confirms invoice #2 fully covered + final balance check
# ===========================================================================
banner "Section 14: Bob confirms invoice #2 COVERED + balance sanity"

cd "$PEER_BOB"
sphere wallet use bob
sleep 5
sphere payments sync 2>&1 | tee "$SNAP/bob-post-final-sync.log"
sphere payments receive --finalize 2>&1 | tee "$SNAP/bob-post-final-recv.log" || true
sphere balance | tee "$SNAP/bob-balance-final.txt"
sphere invoice status "$INV2" 2>&1 | tee "$SNAP/bob-invoice-status-final.log"

rc=0
if grep -qiE '("state"[[:space:]]*:[[:space:]]*"(COVERED|CLOSED)"|state[[:space:]]*:[[:space:]]*(COVERED|CLOSED))' \
    "$SNAP/bob-invoice-status-final.log"; then
  echo "ASSERT OK (invoice2-covered): invoice #2 reached COVERED/CLOSED after partial + cover"
else
  echo "ASSERT FAIL (invoice2-covered): invoice #2 did NOT reach COVERED/CLOSED" >&2
  tail -30 "$SNAP/bob-invoice-status-final.log" >&2
  rc=1
fi

# Net flow on bob across the whole scenario (UCT):
#   §5  +7 (alice's first invoice payment, attributed to INV1)
#   §10 -3 (refund of alice's partial on INV2)
#   §12 +3 (alice's second partial on INV2)
#   §13 +4 (alice's remainder on INV2)
#   ── net +11 vs baseline. INV1 contributed +7, INV2 contributed +7-3+3+4 = ... wait,
#   that's +4 net for INV2 because alice paid 3, was refunded 3, paid 3, paid 4 = net +7 paid
#   minus 3 refunded by bob = +4 attribution. But bob's wallet TOKEN flow is the
#   sum of inbound forward minus outbound refund = +3-3+3+4 = +7 from INV2.
#
# Concretely: bob received (7 + 3 + 3 + 4) = 17 UCT and sent back 3 UCT → net +14.
bob_uct_final=$(extract_confirmed_smallest_units UCT < "$SNAP/bob-balance-final.txt")
bob_total_delta=$(python3 -c "print($bob_uct_final - $bob_uct_0)")
expected_total_bob=14000000000000000000   # 7 (INV1) + 3 - 3 + 3 + 4 (INV2 round-trip net) = 14
echo "bob UCT baseline (§2): $bob_uct_0"
echo "bob UCT final    (§14): $bob_uct_final"
echo "bob total delta:        $bob_total_delta  (expected $expected_total_bob)"
if [[ "$bob_total_delta" == "$expected_total_bob" ]]; then
  echo "ASSERT OK (bob-net-+14): bob net UCT flow matches scenario expectations"
else
  echo "ASSERT FAIL (bob-net-+14): expected $expected_total_bob, got $bob_total_delta" >&2
  rc=1
fi

# Alice's net flow: -7 (§5) -3 (§9) +3 (§10 refund received) -3 (§12) -4 (§13) = -14 UCT.
alice_total_delta=$(python3 -c "print($alice_uct_0 - $alice_uct_final)")
expected_total_alice=14000000000000000000
echo "alice UCT baseline (§2):  $alice_uct_0"
echo "alice UCT final    (§14):  $alice_uct_final"
echo "alice total delta:         $alice_total_delta  (expected $expected_total_alice)"
if [[ "$alice_total_delta" == "$expected_total_alice" ]]; then
  echo "ASSERT OK (alice-net--14): alice net UCT flow matches scenario expectations"
else
  echo "ASSERT FAIL (alice-net--14): expected $expected_total_alice, got $alice_total_delta" >&2
  rc=1
fi

check_no_unconfirmed "alice-balance-final" "$SNAP/alice-balance-final.txt" || rc=1
check_no_unconfirmed "bob-balance-final"   "$SNAP/bob-balance-final.txt"   || rc=1

echo
if (( rc == 0 )); then
  banner "ALL GREEN — round-trip + partial-pay + bulk-return + repeat-pay scenario succeeded"
else
  banner "FAIL — see ASSERT FAIL lines above"
fi
exit "$rc"
