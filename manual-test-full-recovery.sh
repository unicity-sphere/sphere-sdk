#!/usr/bin/env bash
#
# manual-test-full-recovery.sh — automated re-run of manual-test-full-recovery.md
#
# Mirrors the exact CLI commands from the markdown walkthrough so an
# operator can re-validate end-to-end without retyping. The script creates
# a clean workspace and tears it down on exit.
#
# Env knobs:
#   SPHERE_FULL_TEST_DIR   workspace path (default: ~/sphere-full-test-manual)
#   KEEP=1                 skip teardown — keep workspace + daemons for debugging
#   SUFFIX                 override nametag suffix (default: epoch seconds + $$)
#
# Exit code:
#   0 on success, non-zero on any failed step or assertion.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT="${SPHERE_FULL_TEST_DIR:-$HOME/sphere-full-test-manual}"
PEER1="$ROOT/peer1"
PEER2_ALICE="$ROOT/peer2-alice"
PEER2_BOB="$ROOT/peer2-bob"
SNAP="$ROOT/snapshots"

# CWDs that have started a daemon; cleaned up in teardown.
DAEMON_DIRS=()

# ---------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------

teardown() {
  local rc=$?
  set +e

  if [[ "${KEEP:-}" == "1" ]]; then
    echo
    echo "=== KEEP=1 — leaving $ROOT in place (rc=$rc) ==="
    echo "Remember to: pkill -f 'sphere daemon' ; rm -rf $ROOT"
    return $rc
  fi

  echo
  echo "=== Teardown (rc=$rc) ==="

  # Stop each daemon via its CWD (uses ./.sphere-cli/daemon.pid by default).
  local d
  for d in "${DAEMON_DIRS[@]:-}"; do
    if [[ -n "$d" && -d "$d" ]]; then
      ( cd "$d" && sphere daemon stop >/dev/null 2>&1 ) || true
    fi
  done

  # Belt-and-braces: kill any leftover sphere daemons (foreground variants
  # or daemons whose PID file vanished).
  pkill -f "sphere-daemon" 2>/dev/null || true
  pkill -f "sphere daemon" 2>/dev/null || true

  # Give the daemons a moment to flush their PID files.
  sleep 1

  if [[ -d "$ROOT" ]]; then
    rm -rf "$ROOT"
  fi

  echo "=== Teardown done ==="
  return $rc
}
trap teardown EXIT INT TERM

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Extract a 12- or 24-word lowercase mnemonic from a log file. Relies
# on SPHERE_ALLOW_MNEMONIC_NON_TTY=1 emitting the phrase on stdout when
# init generates a fresh wallet from a non-TTY shell.
#
# CLI's `sphere init` default emits a 12-word BIP-39 mnemonic. The
# 24-word path is exposed via a flag (not used by this script). We
# accept either word count so the script works with both defaults.
#
# IMPORTANT: anchor to FULL LINES (^...$). The CLI's deprecation-
# warning text contains spans of 12+ consecutive lowercase words
# (e.g. "provider remains functional for backward compatibility but
# is no longer the recommended") that a non-anchored `\b...\b` regex
# would match BEFORE the real mnemonic — producing a "valid"-looking
# but actually-wrong string that the next `sphere init --mnemonic`
# rejects with "Invalid mnemonic". The real mnemonic always appears
# on a line by itself, so `^...$` is the correct discriminator.
#
# Tries 24-word first (longer match), then 12-word — `head -n 1`
# returns the first whole-line match in the file.
extract_mnemonic() {
  local m
  m="$(grep -E '^([a-z]+ ){23}[a-z]+$' "$1" | head -n 1)"
  if [[ -z "$m" ]]; then
    m="$(grep -E '^([a-z]+ ){11}[a-z]+$' "$1" | head -n 1)"
  fi
  printf '%s' "$m"
}

# Sleep up to NSEC seconds while polling CMD for a non-empty match against
# GREP_PATTERN. Used to wait for daemon log lines.
wait_for_log() {
  local file="$1" pattern="$2" timeout="${3:-30}"
  local elapsed=0
  while (( elapsed < timeout )); do
    if [[ -f "$file" ]] && grep -q -- "$pattern" "$file" 2>/dev/null; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "TIMEOUT waiting ${timeout}s for '$pattern' in $file" >&2
  return 1
}

assert_diff_empty() {
  local label="$1" a="$2" b="$3"
  if diff -u "$a" "$b" > "$SNAP/${label}.diff"; then
    echo "ASSERT OK ($label): $(basename "$a") == $(basename "$b")"
  else
    echo "ASSERT FAIL ($label): see $SNAP/${label}.diff" >&2
    cat "$SNAP/${label}.diff" >&2 || true
    return 1
  fi
}

banner() {
  echo
  echo "================================================================"
  echo "$*"
  echo "================================================================"
}

# ---------------------------------------------------------------------------
# Prereqs
# ---------------------------------------------------------------------------

banner "§0 Prereqs"

sphere --version
which sphere

# Drain fix sentinel (must be 2 in the linked SDK build).
SDK_LINK="$HOME/sphere-cli-work/sphere-cli/node_modules/@unicitylabs/sphere-sdk/dist/index.cjs"
if [[ -f "$SDK_LINK" ]]; then
  DRAIN_COUNT="$(grep -c "drain timed out" "$SDK_LINK" || true)"
  echo "drain-fix sentinel count in linked SDK: $DRAIN_COUNT (expected 2)"
fi

# Allow non-TTY mnemonic capture from `sphere init`.
export SPHERE_ALLOW_MNEMONIC_NON_TTY=1

# ---------------------------------------------------------------------------
# Workspace
# ---------------------------------------------------------------------------

banner "Setup workspace at $ROOT"

rm -rf "$ROOT"
mkdir -p "$PEER1" "$PEER2_ALICE" "$PEER2_BOB" "$SNAP"

# Nametags must satisfy the SDK's Unicity ID regex: lowercase
# alphanumeric / underscore / hyphen, 3-20 chars total. The default
# epoch+pid suffix used to produce a 18+-char suffix (e.g.
# "1779456738-1932107") which pushed "alice-full-${SUFFIX}" past 20 chars
# and the init step failed with "Invalid Unicity ID format" before we
# could exercise anything. Trim to last 4 epoch digits + 4 hex chars
# (8 chars total) so "alice-${SUFFIX}" stays comfortably under the cap.
SUFFIX="${SUFFIX:-$(date +%s | tail -c 5)$(printf '%04x' $((RANDOM % 65536)))}"
ALICE_TAG="alice-${SUFFIX}"
BOB_TAG="bob-${SUFFIX}"
echo "ALICE_TAG=$ALICE_TAG"
echo "BOB_TAG=$BOB_TAG"

# ---------------------------------------------------------------------------
# §1 — Peer1 setup (drain-fix doc §1–§2)
# ---------------------------------------------------------------------------

banner "§1 Peer1 setup (wallets + faucet)"

cd "$PEER1"

# Alice
sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --nametag "$ALICE_TAG" 2>&1 | tee "$SNAP/peer1-alice-init.log"
ALICE_MNEMONIC="$(extract_mnemonic "$SNAP/peer1-alice-init.log")"
[[ -n "$ALICE_MNEMONIC" ]] || { echo "FAIL: couldn't extract alice mnemonic" >&2; exit 1; }
sphere status | tee "$SNAP/peer1-alice-status.log"
grep -qi "nametag" "$SNAP/peer1-alice-status.log" \
  || { echo "FAIL: alice nametag mint failed silently" >&2; exit 1; }

# Bob
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --nametag "$BOB_TAG" 2>&1 | tee "$SNAP/peer1-bob-init.log"
BOB_MNEMONIC="$(extract_mnemonic "$SNAP/peer1-bob-init.log")"
[[ -n "$BOB_MNEMONIC" ]] || { echo "FAIL: couldn't extract bob mnemonic" >&2; exit 1; }
sphere status | tee "$SNAP/peer1-bob-status.log"
grep -qi "nametag" "$SNAP/peer1-bob-status.log" \
  || { echo "FAIL: bob nametag mint failed silently" >&2; exit 1; }

# Stash for debug (in-workspace, gets wiped on teardown)
printf '%s\n' "$ALICE_MNEMONIC" > "$SNAP/alice.mnemonic"
printf '%s\n' "$BOB_MNEMONIC"   > "$SNAP/bob.mnemonic"

# Top up alice
sphere wallet use alice
sphere faucet            2>&1 | tee "$SNAP/peer1-alice-faucet.log"
sphere payments sync     2>&1 | tee "$SNAP/peer1-alice-sync.log"
sphere balance           | tee "$SNAP/peer1-alice-balance.txt"

# Top up bob — needed for §C.2 invoice pay (11 UCT). Without this,
# bob's balance is 0 and `sphere invoice pay $INV` errors with
# "Insufficient balance" even though the invoice was successfully
# discovered via §C.1b deliver (#226).
sphere wallet use bob
sphere faucet            2>&1 | tee "$SNAP/peer1-bob-faucet.log"
sphere payments sync     2>&1 | tee "$SNAP/peer1-bob-sync.log"
sphere balance           | tee "$SNAP/peer1-bob-balance.txt"

# ---------------------------------------------------------------------------
# §A — Peer2 setup (same identity, separate DATA_DIR)
# ---------------------------------------------------------------------------

banner "§A.1 Peer2-alice setup"

cd "$PEER2_ALICE"
sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --mnemonic "$ALICE_MNEMONIC" 2>&1 | tee "$SNAP/peer2-alice-init.log"
sphere status                              | tee "$SNAP/peer2-alice-status.log"
sphere payments sync                       2>&1 | tee "$SNAP/peer2-alice-sync.log"
sphere payments receive --finalize         2>&1 | tee "$SNAP/peer2-alice-receive.log"
sphere balance                             > "$SNAP/peer2-alice-initial.txt"
cat "$SNAP/peer2-alice-initial.txt"

# Peer1 snapshot for diffing
( cd "$PEER1" && sphere wallet use alice && sphere balance ) > "$SNAP/peer1-alice-initial.txt"

assert_diff_empty "alice-peer1-vs-peer2-initial" \
  "$SNAP/peer1-alice-initial.txt" \
  "$SNAP/peer2-alice-initial.txt" \
  || { echo "WARN: peer1/peer2 alice balance mismatch — IPFS may need more sync time" >&2; }

banner "§A.2 Peer2-bob setup"

cd "$PEER2_BOB"
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --mnemonic "$BOB_MNEMONIC" 2>&1 | tee "$SNAP/peer2-bob-init.log"
sphere status                              | tee "$SNAP/peer2-bob-status.log"
sphere payments sync                       2>&1 | tee "$SNAP/peer2-bob-sync.log"
sphere payments receive --finalize         2>&1 | tee "$SNAP/peer2-bob-receive.log"
sphere balance                             > "$SNAP/peer2-bob-initial.txt"
cat "$SNAP/peer2-bob-initial.txt"

# ---------------------------------------------------------------------------
# §B — Daemons on peer2
# ---------------------------------------------------------------------------

banner "§B Start peer2 daemons (--detach)"

cd "$PEER2_ALICE"
sphere wallet use alice
sphere daemon start \
  --detach \
  --event 'transfer:incoming' --action auto-receive \
  --event 'transfer:incoming' --action 'log:./events.log' \
  --event 'transfer:confirmed' --action 'log:./events.log' \
  --event 'invoice:payment'    --action 'log:./events.log' \
  --event 'invoice:covered'    --action 'log:./events.log' \
  --verbose
DAEMON_DIRS+=("$PEER2_ALICE")
sleep 3
sphere daemon status

cd "$PEER2_BOB"
sphere wallet use bob
sphere daemon start \
  --detach \
  --event 'transfer:incoming' --action auto-receive \
  --event 'transfer:incoming' --action 'log:./events.log' \
  --event 'transfer:confirmed' --action 'log:./events.log' \
  --event 'invoice:payment'    --action 'log:./events.log' \
  --event 'invoice:covered'    --action 'log:./events.log' \
  --verbose
DAEMON_DIRS+=("$PEER2_BOB")
sleep 3
sphere daemon status

# ---------------------------------------------------------------------------
# §C — Bidirectional invoice flow on peer1
# ---------------------------------------------------------------------------

banner "§C.1 Alice creates 11 UCT invoice for Bob"

cd "$PEER1"
sphere wallet use alice
sphere invoice create --target "@$BOB_TAG" --asset "11000000 UCT" --memo "Full-recovery test invoice" \
  2>&1 | tee "$SNAP/peer1-invoice-create.log"

INV="$(grep -Eo '"invoiceId":[[:space:]]*"[^"]+"' "$SNAP/peer1-invoice-create.log" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[[ -n "$INV" ]] || { echo "FAIL: couldn't extract invoiceId" >&2; exit 1; }
echo "INV=$INV"

banner "§C.1b Alice delivers the invoice to Bob (#226 — UXF bundle over DM)"

# `sphere invoice create` no longer auto-delivers (#226). Delivery is a
# separate, explicit step: package the invoice into a UXF bundle and
# ship it to every non-self target via NIP-17 DM. Without this step,
# Bob's wallet has no path to discover the invoice — payment-time
# sync/receive don't pull invoices addressed to him, and `invoice pay`
# would error with "No invoice found matching prefix: ...".
sphere invoice deliver "$INV" 2>&1 | tee "$SNAP/peer1-invoice-deliver.log"

banner "§C.2 Bob pays"

sphere wallet use bob
# Give Bob's relay subscription a beat to ingest the just-published
# `invoice_delivery:` DM. The receive pipeline imports the bundled
# invoice synchronously on DM arrival, so a short settle suffices.
sleep 5
sphere payments sync       2>&1 | tee "$SNAP/peer1-bob-pre-pay-sync.log"
# `payments receive --finalize` drains any pending V5 tokens before
# Bob looks up the invoice. The invoice itself rides through the
# `invoice_delivery:` DM channel (handled by AccountingModule, not
# the payments pipeline) — included here purely for hygiene.
sphere payments receive --finalize 2>&1 | tee "$SNAP/peer1-bob-pre-pay-receive.log"
sphere invoice pay "$INV"  2>&1 | tee "$SNAP/peer1-invoice-pay.log"
sphere payments sync       2>&1 | tee "$SNAP/peer1-invoice-pay-sync.log"

banner "§C.3 Verify peer2 daemons saw events"

# Alice's peer2 daemon should have logged invoice:payment or invoice:covered.
wait_for_log "$PEER2_ALICE/events.log" "invoice:" 60 \
  || { echo "WARN: no invoice event hit alice peer2 events.log in 60s" >&2; }

# Bob's peer2 daemon should have seen transfer:incoming or transfer:confirmed.
wait_for_log "$PEER2_BOB/events.log" "transfer:" 60 \
  || { echo "WARN: no transfer event hit bob peer2 events.log in 60s" >&2; }

echo "--- peer2-alice events.log (tail) ---"
tail -n 20 "$PEER2_ALICE/events.log" 2>/dev/null || true
echo "--- peer2-bob events.log (tail) ---"
tail -n 20 "$PEER2_BOB/events.log"   2>/dev/null || true

banner "§C.4 Peer2 view (NO manual sync)"

cd "$PEER2_ALICE"
sphere invoice status "$INV" 2>&1 | tee "$SNAP/peer2-alice-invoice-status.log"
sphere balance               | tee "$SNAP/peer2-alice-postC-balance.txt"

cd "$PEER2_BOB"
sphere balance               | tee "$SNAP/peer2-bob-postC-balance.txt"

# ---------------------------------------------------------------------------
# §D — Pre-clear snapshots + wipe + IPFS-only recovery
# ---------------------------------------------------------------------------

banner "§D.1 Pre-clear snapshots on peer1"

cd "$PEER1"
sphere wallet use alice
sphere payments sync
sphere balance                      > "$SNAP/alice-before.txt"
sphere payments tokens              > "$SNAP/alice-tokens-before.txt"
sphere invoice list --state COVERED > "$SNAP/alice-invoices-before.txt"

sphere wallet use bob
sphere payments sync
sphere balance                      > "$SNAP/bob-before.txt"
sphere payments tokens              > "$SNAP/bob-tokens-before.txt"
sphere invoice list --state COVERED > "$SNAP/bob-invoices-before.txt"

banner "§D.2 Stop peer2 daemons"

cd "$PEER2_ALICE" && sphere daemon stop  || true
cd "$PEER2_BOB"   && sphere daemon stop  || true
sleep 2

banner "§D.3 sphere clear on all wallets"

cd "$PEER1"      && sphere wallet use alice && sphere clear --yes
cd "$PEER1"      && sphere wallet use bob   && sphere clear --yes
cd "$PEER2_ALICE" && sphere wallet use alice && sphere clear --yes
cd "$PEER2_BOB"   && sphere wallet use bob   && sphere clear --yes

banner "§D.4 Recover with mnemonics + --no-nostr (IPFS only)"

# Peer1 alice
cd "$PEER1"
sphere wallet use alice
sphere init --network testnet --no-nostr --mnemonic "$ALICE_MNEMONIC"
sphere payments sync
sphere payments receive --finalize
sphere balance                      > "$SNAP/alice-after.txt"
sphere payments tokens              > "$SNAP/alice-tokens-after.txt"
sphere invoice list --state COVERED > "$SNAP/alice-invoices-after.txt"

# Peer1 bob
sphere wallet use bob
sphere init --network testnet --no-nostr --mnemonic "$BOB_MNEMONIC"
sphere payments sync
sphere payments receive --finalize
sphere balance                      > "$SNAP/bob-after.txt"
sphere payments tokens              > "$SNAP/bob-tokens-after.txt"
sphere invoice list --state COVERED > "$SNAP/bob-invoices-after.txt"

# Peer2-alice
cd "$PEER2_ALICE"
sphere wallet use alice
sphere init --network testnet --no-nostr --mnemonic "$ALICE_MNEMONIC"
sphere payments sync
sphere balance                      > "$SNAP/alice-peer2-after.txt"

# Peer2-bob
cd "$PEER2_BOB"
sphere wallet use bob
sphere init --network testnet --no-nostr --mnemonic "$BOB_MNEMONIC"
sphere payments sync
sphere balance                      > "$SNAP/bob-peer2-after.txt"

banner "§D.5 Assertions"

assert_diff_empty "alice-peer1-before-vs-after"   "$SNAP/alice-before.txt"        "$SNAP/alice-after.txt"
assert_diff_empty "alice-peer1-tokens"            "$SNAP/alice-tokens-before.txt" "$SNAP/alice-tokens-after.txt"
assert_diff_empty "bob-peer1-before-vs-after"     "$SNAP/bob-before.txt"          "$SNAP/bob-after.txt"
assert_diff_empty "bob-peer1-tokens"              "$SNAP/bob-tokens-before.txt"   "$SNAP/bob-tokens-after.txt"
assert_diff_empty "alice-peer1-vs-peer2-after"    "$SNAP/alice-before.txt"        "$SNAP/alice-peer2-after.txt"
assert_diff_empty "bob-peer1-vs-peer2-after"      "$SNAP/bob-before.txt"          "$SNAP/bob-peer2-after.txt"

# ---------------------------------------------------------------------------
# §E — Invoice ledger preserved
# ---------------------------------------------------------------------------

banner "§E Recovery preserves invoice ledger"

assert_diff_empty "alice-invoices" "$SNAP/alice-invoices-before.txt" "$SNAP/alice-invoices-after.txt"
assert_diff_empty "bob-invoices"   "$SNAP/bob-invoices-before.txt"   "$SNAP/bob-invoices-after.txt"

cd "$PEER1"
sphere wallet use alice
sphere invoice status "$INV" | tee "$SNAP/alice-invoice-status-after.log"
grep -qi "COVERED" "$SNAP/alice-invoice-status-after.log" \
  || { echo "FAIL: invoice $INV not COVERED after recovery" >&2; exit 1; }

banner "ALL GREEN"
echo "Workspace: $ROOT  (will be removed by teardown unless KEEP=1)"
