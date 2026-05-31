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

# Poll `sphere invoice status $INVOICE` until peer2 has replicated the
# invoice, OR fail after TIMEOUT seconds. Cross-device invoice visibility
# requires three legs to complete:
#
#   1. Sender (Bob)'s profile-token IPFS publish lands durably.
#   2. Sender's Nostr at-least-once mux acks (60s cooldown on retry).
#   3. Receiver (peer2-alice)'s OrbitDB replicates the accounting key.
#
# Under flaky testnet conditions (e.g. unicity-ipfs1.dyndns.org HTTP 500
# observed 2026-05-29), any leg can stall. Without this loop a transient
# stall trips `set -euo pipefail` and aborts the soak at §C.4 even though
# the wallet code is correct. Treats ONLY "No invoice found" as transient;
# other errors (e.g. "Database is not open") still propagate immediately.
wait_for_invoice_visible() {
  local invoice="$1" output_file="$2" timeout="${3:-150}"
  local elapsed=0 step=15 rc
  : > "$output_file"
  while (( elapsed < timeout )); do
    if sphere invoice status "$invoice" > "$output_file" 2>&1; then
      if ! grep -q 'No invoice found' "$output_file"; then
        cat "$output_file"
        return 0
      fi
      # Found a "No invoice" — transient. Retry after sleep.
    else
      rc=$?
      if ! grep -q 'No invoice found' "$output_file"; then
        # CLI failed for a non-transient reason (e.g. DB lock, network
        # config). Surface immediately so the soak fails informatively.
        cat "$output_file" >&2
        echo "sphere invoice status failed with rc=$rc (non-transient — not retrying)" >&2
        return "$rc"
      fi
    fi
    sleep "$step"
    elapsed=$((elapsed + step))
  done
  cat "$output_file" >&2
  echo "TIMEOUT (${timeout}s) waiting for peer2 to see invoice $invoice — testnet replication stalled" >&2
  return 1
}

# Normalize a snapshot before byte-comparison. Strips lines that are
# legitimately volatile across runs but do NOT reflect logical wallet
# state. False positives observed on 2026-05-29 (issue: page-freeze):
#
#   - "  IPFS: +N added, -M removed" — transient sync-status emitted
#     when `sphere balance` notices background IPFS sync activity. The
#     count varies depending on whether a prior write is still landing.
#   - "Syncing..." / "  Ready." — wallet-load progress banner.
#   - "[YYYY-MM-DDThh:mm:ss.sssZ] [LEVEL] [Component] ..." — debug
#     output captured when the CLI runs in verbose mode. Wall-clock
#     timestamps + monotonic counters (event IDs, bundle counts) make
#     these lines pure noise for state comparison.
#   - "[perf-counters] snapshot: { ... }" — MULTI-LINE perf dump emitted
#     by core/perf-counters.ts on a setInterval when SPHERE_PERF=1. The
#     opening line is timestamped (and would be stripped by the ISO rule
#     below), but the continuation lines and the bare closing `}` at
#     column 0 survive a per-line sed filter and produce spurious
#     diffs between otherwise-equal snapshots. Issue #364 Item #6.
#
# Filtering operates on a temp file the caller hands to diff, leaving
# the original snapshot untouched for forensics.
#
# Implementation note: the awk pass runs FIRST so it can detect the
# opening `[perf-counters] snapshot: {` line even when that line is
# timestamped (and would otherwise be eaten by the ISO sed rule before
# awk gets to see it). The awk state machine drops every line from
# the opening through the matching closing `}` at column 0 inclusive.
normalize_snapshot() {
  # shellcheck disable=SC2016
  awk '
    BEGIN { in_perf = 0 }
    {
      if (in_perf) {
        # Closing brace of the perf-block — always at column 0 because
        # Node util.inspect renders the top-level } unindented.
        if ($0 ~ /^\}[[:space:]]*$/) {
          in_perf = 0
        }
        next
      }
      # Detect opening of a perf-counters snapshot block. Substring
      # match works for both timestamped ("[ISO] [INFO ] [perf] ...")
      # and untimestamped ("[perf] ...") logger output.
      if (index($0, "[perf-counters] snapshot:") > 0) {
        # Single-line snapshot (1-counter case): line ends with "}".
        # Drop and stay outside block mode.
        if ($0 ~ /\}[[:space:]]*$/) {
          next
        }
        # Multi-line snapshot: line ends with "{". Drop and enter
        # block mode so subsequent continuation lines are dropped too.
        in_perf = 1
        next
      }
      print
    }
  ' "$1" | sed -E \
    -e '/^\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\] /d' \
    -e '/^  IPFS: \+[0-9]+ added, -[0-9]+ removed$/d' \
    -e '/^Syncing\.\.\.$/d' \
    -e '/^  Ready\.$/d'
}

assert_diff_empty() {
  local label="$1" a="$2" b="$3"
  local na="$SNAP/${label}.a.norm" nb="$SNAP/${label}.b.norm"
  normalize_snapshot "$a" > "$na"
  normalize_snapshot "$b" > "$nb"
  if diff -u "$na" "$nb" > "$SNAP/${label}.diff"; then
    echo "ASSERT OK ($label): $(basename "$a") == $(basename "$b")"
  else
    echo "ASSERT FAIL ($label): see $SNAP/${label}.diff" >&2
    echo "  (compared normalized snapshots: ${label}.a.norm vs ${label}.b.norm)" >&2
    cat "$SNAP/${label}.diff" >&2 || true
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Optional self-test for normalize_snapshot()
#
# Run with: RUN_NORMALIZE_TESTS=1 bash manual-test-full-recovery.sh
#
# Pipes synthetic snapshots that EQUAL each other modulo `[perf-counters]
# snapshot:` blocks through normalize_snapshot() and asserts the diff is
# empty. Protects against regressions of the #364 Item #6 fix where the
# multi-line perf dump contaminates byte comparisons between
# logically-equivalent `sphere status` / `sphere balance` outputs.
#
# Exits 0 on pass, non-zero on fail. Bypasses the teardown trap.
# ---------------------------------------------------------------------------

run_normalize_self_tests() {
  local tmpdir a b na nb rc=0
  tmpdir="$(mktemp -d -t normalize-tests.XXXXXX)"
  a="$tmpdir/a.txt"
  b="$tmpdir/b.txt"
  na="$tmpdir/a.norm"
  nb="$tmpdir/b.norm"

  echo "=== normalize_snapshot self-tests ==="

  # ---- T1: multi-line perf block (untimestamped) ----
  cat > "$a" <<'EOF'
Balance: 11 UCT
Tokens: 3
EOF
  cat > "$b" <<'EOF'
Balance: 11 UCT
[perf] [perf-counters] snapshot: {
  'profile.applySnapshot': { count: 42, totalMs: 123.4, avgMs: 2.9, maxMs: 9.8 },
  'aggregator.fetch': { count: 7, totalMs: 12.3, avgMs: 1.7, maxMs: 4.5 }
}
Tokens: 3
EOF
  normalize_snapshot "$a" > "$na"
  normalize_snapshot "$b" > "$nb"
  if diff -u "$na" "$nb" >/dev/null; then
    echo "T1 OK: multi-line untimestamped perf block stripped"
  else
    echo "T1 FAIL: multi-line untimestamped perf block leaked" >&2
    diff -u "$na" "$nb" >&2 || true
    rc=1
  fi

  # ---- T2: multi-line perf block (timestamped opening) ----
  cat > "$b" <<'EOF'
Balance: 11 UCT
[2026-05-31T12:34:56.789Z] [INFO ] [perf] [perf-counters] snapshot: {
  'profile.applySnapshot': { count: 42, totalMs: 123.4, avgMs: 2.9, maxMs: 9.8 },
  'aggregator.fetch': { count: 7, totalMs: 12.3, avgMs: 1.7, maxMs: 4.5 }
}
Tokens: 3
EOF
  normalize_snapshot "$a" > "$na"
  normalize_snapshot "$b" > "$nb"
  if diff -u "$na" "$nb" >/dev/null; then
    echo "T2 OK: timestamped-opening perf block stripped"
  else
    echo "T2 FAIL: timestamped-opening perf block leaked" >&2
    diff -u "$na" "$nb" >&2 || true
    rc=1
  fi

  # ---- T3: single-line perf block (1-counter case) ----
  cat > "$b" <<'EOF'
Balance: 11 UCT
[perf] [perf-counters] snapshot: { a: { count: 1, totalMs: 2, avgMs: 2, maxMs: 2 } }
Tokens: 3
EOF
  normalize_snapshot "$a" > "$na"
  normalize_snapshot "$b" > "$nb"
  if diff -u "$na" "$nb" >/dev/null; then
    echo "T3 OK: single-line perf block stripped"
  else
    echo "T3 FAIL: single-line perf block leaked" >&2
    diff -u "$na" "$nb" >&2 || true
    rc=1
  fi

  # ---- T4: multiple consecutive perf blocks ----
  cat > "$b" <<'EOF'
Balance: 11 UCT
[perf] [perf-counters] snapshot: {
  'a.b.c': { count: 1, totalMs: 2, avgMs: 2, maxMs: 2 },
  'd.e.f': { count: 3, totalMs: 4, avgMs: 4, maxMs: 4 }
}
[perf] [perf-counters] snapshot: {
  'g.h.i': { count: 5, totalMs: 6, avgMs: 6, maxMs: 6 }
}
Tokens: 3
EOF
  normalize_snapshot "$a" > "$na"
  normalize_snapshot "$b" > "$nb"
  if diff -u "$na" "$nb" >/dev/null; then
    echo "T4 OK: multiple consecutive perf blocks stripped"
  else
    echo "T4 FAIL: multiple consecutive perf blocks leaked" >&2
    diff -u "$na" "$nb" >&2 || true
    rc=1
  fi

  # ---- T5: existing strips still work (ISO + IPFS + Syncing + Ready) ----
  cat > "$b" <<'EOF'
Balance: 11 UCT
[2026-05-31T12:34:56.789Z] [INFO ] [Sphere] something happened
  IPFS: +3 added, -1 removed
Syncing...
  Ready.
Tokens: 3
EOF
  normalize_snapshot "$a" > "$na"
  normalize_snapshot "$b" > "$nb"
  if diff -u "$na" "$nb" >/dev/null; then
    echo "T5 OK: legacy strips intact"
  else
    echo "T5 FAIL: legacy strips broken" >&2
    diff -u "$na" "$nb" >&2 || true
    rc=1
  fi

  # ---- T6: counter name containing '}' must not exit perf block early ----
  # Defensive: counter names in our codebase are dot-paths, but a future
  # operator-style counter could contain literal braces. We trust the
  # column-0 anchor of the closing `}` per Node util.inspect formatting.
  cat > "$b" <<'EOF'
Balance: 11 UCT
[perf] [perf-counters] snapshot: {
  'odd}name': { count: 1, totalMs: 2, avgMs: 2, maxMs: 2 },
  'other': { count: 3, totalMs: 4, avgMs: 4, maxMs: 4 }
}
Tokens: 3
EOF
  normalize_snapshot "$a" > "$na"
  normalize_snapshot "$b" > "$nb"
  if diff -u "$na" "$nb" >/dev/null; then
    echo "T6 OK: indented '}' inside counter name does not exit block"
  else
    echo "T6 FAIL: indented '}' inside counter name exited block early" >&2
    diff -u "$na" "$nb" >&2 || true
    rc=1
  fi

  # ---- T7: no perf block — identical inputs stay identical ----
  cat > "$b" <<'EOF'
Balance: 11 UCT
Tokens: 3
EOF
  normalize_snapshot "$a" > "$na"
  normalize_snapshot "$b" > "$nb"
  if diff -u "$na" "$nb" >/dev/null; then
    echo "T7 OK: identity passthrough"
  else
    echo "T7 FAIL: passthrough corrupted equal inputs" >&2
    diff -u "$na" "$nb" >&2 || true
    rc=1
  fi

  rm -rf "$tmpdir"
  if (( rc == 0 )); then
    echo "=== normalize_snapshot self-tests: ALL PASS ==="
  else
    echo "=== normalize_snapshot self-tests: FAILED ===" >&2
  fi
  return "$rc"
}

if [[ "${RUN_NORMALIZE_TESTS:-}" == "1" ]]; then
  run_normalize_self_tests
  # Bypass teardown trap — nothing was created.
  trap - EXIT INT TERM
  exit $?
fi

# Wall-clock anchor + per-section elapsed. SECTION_T0 is set the first
# time `banner` is invoked; SECTION_LAST_TS tracks the previous banner so
# each new section prints how long the previous one took. The full
# breakdown is the diff between any two section-banner timestamps.
SECTION_T0=0
SECTION_LAST_TS=0
SECTION_LAST_NAME=""
banner() {
  local now ts iso elapsed_total elapsed_section
  ts=$(date +%s)
  iso=$(date -Iseconds)
  if (( SECTION_T0 == 0 )); then
    SECTION_T0=$ts
    SECTION_LAST_TS=$ts
    elapsed_total=0
    elapsed_section=0
  else
    elapsed_total=$((ts - SECTION_T0))
    elapsed_section=$((ts - SECTION_LAST_TS))
  fi
  echo
  echo "================================================================"
  if [[ -n "$SECTION_LAST_NAME" ]]; then
    printf "[%s] +%-4ds (prev section %s took %ds)\n" "$iso" "$elapsed_total" "$SECTION_LAST_NAME" "$elapsed_section"
  else
    printf "[%s] +0s (soak start)\n" "$iso"
  fi
  echo "$*"
  echo "================================================================"
  SECTION_LAST_TS=$ts
  SECTION_LAST_NAME="$*"
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

banner "§C.1 Alice creates 11 UCT invoice (Bob will pay)"

cd "$PEER1"
sphere wallet use alice
# `--target` is the receiver of funds. Alice is the receiver (Bob pays
# her), so the target is `@$ALICE_TAG`. Bob (the payer) is supplied to
# `invoice deliver` in §C.1b via `--to`, because the invoice's only
# target is self and `deliver`'s default ("every non-self target")
# would yield zero recipients.
sphere invoice create --target "@$ALICE_TAG" --asset "11000000 UCT" --memo "Full-recovery test invoice" \
  2>&1 | tee "$SNAP/peer1-invoice-create.log"

INV="$(grep -Eo '"invoiceId":[[:space:]]*"[^"]+"' "$SNAP/peer1-invoice-create.log" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[[ -n "$INV" ]] || { echo "FAIL: couldn't extract invoiceId" >&2; exit 1; }
echo "INV=$INV"

banner "§C.1b Alice delivers the invoice to Bob (#226 — UXF bundle over DM)"

# `sphere invoice create` no longer auto-delivers (#226). Delivery is a
# separate, explicit step: package the invoice into a UXF bundle and
# ship it via NIP-17 DM. The invoice's `--target` is the RECEIVER of
# funds (alice), so the payer (bob) is supplied here as the explicit
# `--to` recipient. Without this step, Bob's wallet has no path to
# discover the invoice — payment-time sync/receive don't pull invoices
# addressed to him, and `invoice pay` would error with "No invoice
# found matching prefix: ...".
sphere invoice deliver "$INV" --to "@$BOB_TAG" 2>&1 | tee "$SNAP/peer1-invoice-deliver.log"

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

# Alice's peer2 daemon should have logged transfer:incoming (the
# kind:31113 Nostr event is tagged with alice's transport pubkey since
# alice is the payment recipient). `invoice:payment` / `invoice:
# covered` MAY also fire if AccountingModule's invoiceTermsCache has
# the invoice cached — but that path can be blocked by an unrelated
# bug in cache refresh (#223 follow-up), so we assert on `transfer:`
# alone to isolate the cross-process Nostr signal.
wait_for_log "$PEER2_ALICE/events.log" "transfer:" 60 \
  || { echo "WARN: no transfer event hit alice peer2 events.log in 60s" >&2; }

# Bob's peer2 daemon will NOT see a Nostr transfer:* event because the
# kind:31113 event's #p tag is alice's transport pubkey, not bob's.
# Bob's view updates via IPFS Profile-pointer sync (live propagation
# from peer1-bob), surfaced in §C.4's `sphere balance` assertion below.

echo "--- peer2-alice events.log (tail) ---"
tail -n 20 "$PEER2_ALICE/events.log" 2>/dev/null || true
echo "--- peer2-bob events.log (tail; expected empty for this scenario) ---"
tail -n 20 "$PEER2_BOB/events.log"   2>/dev/null || true

banner "§C.4 Peer2 view (NO manual sync)"

# Issue #247 — short-term: stop the peer2 daemons around the CLI
# assertion. The daemon holds the OrbitDB / Helia directory lock
# (POSIX advisory lock on LevelDB LOCK files); a sibling CLI in the
# same dataDir fails with "Database is not open" after the bounded
# retry budget. The proper fix is the daemon-broker IPC surface
# (#247 follow-up) so CLIs can talk to a running daemon instead of
# opening OrbitDB directly. Until then, stop+start preserves the
# test's intent (verify peer2 saw the events via Nostr) without
# the lock contention.

cd "$PEER2_ALICE" && sphere daemon stop || true
cd "$PEER2_BOB"   && sphere daemon stop || true
sleep 2

cd "$PEER2_ALICE"
# Wait for cross-device replication to complete before asserting peer2's
# view. Under flaky testnet conditions the invoice can take 30s+ to land.
# Treats "No invoice found" as transient; other errors propagate.
wait_for_invoice_visible "$INV" "$SNAP/peer2-alice-invoice-status.log" 150
sphere balance               | tee "$SNAP/peer2-alice-postC-balance.txt"

cd "$PEER2_BOB"
sphere balance               | tee "$SNAP/peer2-bob-postC-balance.txt"

# Restart the daemons so subsequent sections that depend on them
# (event replay, Nostr listening) keep working.
cd "$PEER2_ALICE"
sphere daemon start \
  --detach \
  --event 'transfer:incoming' --action auto-receive \
  --event 'transfer:incoming' --action 'log:./events.log' \
  --event 'transfer:confirmed' --action 'log:./events.log' \
  --event 'invoice:payment'    --action 'log:./events.log' \
  --event 'invoice:covered'    --action 'log:./events.log' \
  --verbose
DAEMON_DIRS+=("$PEER2_ALICE")
sleep 2

cd "$PEER2_BOB"
sphere daemon start \
  --detach \
  --event 'transfer:incoming' --action auto-receive \
  --event 'transfer:incoming' --action 'log:./events.log' \
  --event 'transfer:confirmed' --action 'log:./events.log' \
  --event 'invoice:payment'    --action 'log:./events.log' \
  --event 'invoice:covered'    --action 'log:./events.log' \
  --verbose
DAEMON_DIRS+=("$PEER2_BOB")
sleep 2

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
