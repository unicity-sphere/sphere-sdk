#!/usr/bin/env bash
#
# Simple alice→bob 10 UCT send + receive + finalize verification.
#
# Verifies: bob's CONFIRMED UCT balance goes UP by exactly 10 UCT
# (in smallest units: 1_000_000_000) and alice's CONFIRMED UCT
# balance goes DOWN by exactly 10 UCT, after Bob runs
# `payments receive --finalize`.
#
# Integer-only verification: balances are compared at the smallest-unit
# (satoshi/integer) layer extracted from the CLI's decimal-formatted
# output. NO float coercion.

set -euo pipefail

# ---- workspace ----
ROOT="${SIMPLE_SEND_TEST_DIR:-/tmp/simple-send-test-$$}"
SNAP="$ROOT/snapshots"
mkdir -p "$SNAP"

# Nametag constraint: lowercase alphanumeric / underscore / hyphen,
# 3–20 chars. The soak uses a compact 4-digit epoch tail + 4-hex
# random to keep `alice-${SUFFIX}` under cap. Mirror that exactly.
SUFFIX="${SUFFIX:-$(date +%s | tail -c 5)$(printf '%04x' $((RANDOM % 65536)))}"
ALICE_TAG="alice-$SUFFIX"
BOB_TAG="bob-$SUFFIX"
echo "ALICE_TAG=$ALICE_TAG"
echo "BOB_TAG=$BOB_TAG"

PEER_ALICE="$ROOT/alice-peer"
PEER_BOB="$ROOT/bob-peer"
mkdir -p "$PEER_ALICE" "$PEER_BOB"

# Allow non-TTY mnemonic capture (CLI emits mnemonic on stdout in non-TTY when --no-encrypt-mnemonic).
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
# Section 1 — Create alice
# ---------------------------------------------------------------------------
banner "Section 1: Create alice wallet (testnet)"

cd "$PEER_ALICE"
sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --nametag "$ALICE_TAG" 2>&1 | tee "$SNAP/alice-init.log"

# ---------------------------------------------------------------------------
# Section 2 — Create bob
# ---------------------------------------------------------------------------
banner "Section 2: Create bob wallet (testnet)"

cd "$PEER_BOB"
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --nametag "$BOB_TAG" 2>&1 | tee "$SNAP/bob-init.log"

# ---------------------------------------------------------------------------
# Section 3 — Top up alice via faucet
# ---------------------------------------------------------------------------
banner "Section 3: Top up alice"

cd "$PEER_ALICE"
sphere wallet use alice
sphere faucet         2>&1 | tee "$SNAP/alice-faucet.log"
sphere payments sync  2>&1 | tee "$SNAP/alice-sync.log"

# Receive + finalize any incoming from the faucet so the baseline is CONFIRMED.
sphere payments receive --finalize 2>&1 | tee "$SNAP/alice-faucet-receive.log"
sphere balance | tee "$SNAP/alice-balance-before.txt"

# ---------------------------------------------------------------------------
# Section 4 — Baseline bob (zero)
# ---------------------------------------------------------------------------
banner "Section 4: Baseline bob (expected zero UCT)"

cd "$PEER_BOB"
sphere wallet use bob
sphere payments sync  2>&1 | tee "$SNAP/bob-sync.log"
sphere payments receive --finalize 2>&1 | tee "$SNAP/bob-baseline-receive.log"
sphere balance | tee "$SNAP/bob-balance-before.txt"

# ---------------------------------------------------------------------------
# Section 5 — Alice sends 10 UCT to bob (instant)
# ---------------------------------------------------------------------------
banner "Section 5: alice → @${BOB_TAG} (10 UCT, instant)"

cd "$PEER_ALICE"
sphere wallet use alice
sphere payments send "@${BOB_TAG}" 10 UCT 2>&1 | tee "$SNAP/alice-send.log"

# ---------------------------------------------------------------------------
# Section 6 — Bob receives + finalizes
# ---------------------------------------------------------------------------
banner "Section 6: bob payments receive --finalize"

cd "$PEER_BOB"
sphere wallet use bob
sphere payments sync 2>&1 | tee "$SNAP/bob-sync-after.log"
sphere payments receive --finalize 2>&1 | tee "$SNAP/bob-receive.log"

# ---------------------------------------------------------------------------
# Section 7 — Snapshot final balances
# ---------------------------------------------------------------------------
banner "Section 7: Snapshot final balances"

cd "$PEER_BOB"
sphere balance | tee "$SNAP/bob-balance-after.txt"

cd "$PEER_ALICE"
sphere wallet use alice
sphere payments sync 2>&1 | tee "$SNAP/alice-sync-after.log"
sphere balance | tee "$SNAP/alice-balance-after.txt"

# ---------------------------------------------------------------------------
# Section 8 — Verify delta (integer-only)
# ---------------------------------------------------------------------------
banner "Section 8: Verify exact ±10 UCT CONFIRMED delta"

# UCT has 8 decimals → 10 UCT = 1_000_000_000 smallest units.
# Extract `UCT: <amount>` lines, normalize to smallest units WITHOUT
# float coercion: split on `.`, left-pad fractional part to 8 chars,
# concatenate, strip leading zeros.
#
# Why no `awk amt+0` / `bc`? Because per the SDK's bigint-only
# aggregation rule, any conversion through a numeric type capped at
# IEEE-754 double silently loses precision for amounts above ~9e15.
# We work in strings throughout, then compare integers via shell
# arithmetic only when both sides comfortably fit in a 64-bit signed
# integer (10 UCT is 10^10 — well within bounds).

extract_uct_confirmed_smallest_units() {
  # Reads a `sphere balance` snapshot from stdin; emits the CONFIRMED
  # UCT amount as a smallest-unit integer string. Lines we recognize:
  #   `UCT: 100.000000000000 (1 token)`              -- fully confirmed
  #   `UCT: 100 (+ 5 unconfirmed) [1+1 tokens]`      -- partial
  #   `UCT: 100.5 (1 token)`                         -- short fractional
  # We deliberately ignore the `(+ N unconfirmed)` clause — only
  # CONFIRMED counts here.
  local line decimal int_part frac_part
  line=$(grep -E '^UCT:' || true)
  if [[ -z "$line" ]]; then
    echo "0"
    return
  fi
  # Strip optional `(+N unconfirmed) [...]` and `(N tokens)` clauses.
  decimal=$(echo "$line" | sed -E -e 's/^UCT:[[:space:]]+//' -e 's/[[:space:]]+\(.+$//')
  if [[ "$decimal" == *.* ]]; then
    int_part="${decimal%.*}"
    frac_part="${decimal#*.}"
  else
    int_part="$decimal"
    frac_part=""
  fi
  # Pad fractional part to exactly 8 chars (UCT decimals = 8).
  while (( ${#frac_part} < 8 )); do frac_part="${frac_part}0"; done
  if (( ${#frac_part} > 8 )); then
    echo "ERROR: UCT fractional part >8 digits ($decimal)" >&2
    return 1
  fi
  # Concatenate and strip leading zeros (preserve at least one digit).
  local combined="${int_part}${frac_part}"
  combined=$(echo "$combined" | sed -E 's/^0+//')
  [[ -z "$combined" ]] && combined="0"
  echo "$combined"
}

alice_before=$(extract_uct_confirmed_smallest_units < "$SNAP/alice-balance-before.txt")
alice_after=$( extract_uct_confirmed_smallest_units < "$SNAP/alice-balance-after.txt")
bob_before=$(  extract_uct_confirmed_smallest_units < "$SNAP/bob-balance-before.txt")
bob_after=$(   extract_uct_confirmed_smallest_units < "$SNAP/bob-balance-after.txt")

echo "alice CONFIRMED before: $alice_before  (smallest units)"
echo "alice CONFIRMED after:  $alice_after   (smallest units)"
echo "bob   CONFIRMED before: $bob_before    (smallest units)"
echo "bob   CONFIRMED after:  $bob_after     (smallest units)"

# Expected delta: 10 UCT = 10 * 10^8 = 1_000_000_000 smallest units.
expected_delta=1000000000

alice_delta=$(( alice_before - alice_after ))
bob_delta=$(( bob_after - bob_before ))

echo
echo "alice delta (before - after): $alice_delta"
echo "bob   delta (after - before): $bob_delta"
echo "expected:                     $expected_delta  (10 UCT × 10^8)"

rc=0
if (( alice_delta == expected_delta )); then
  echo "ASSERT OK (alice-confirmed-drop-10-UCT): alice dropped exactly 10 UCT confirmed"
else
  echo "ASSERT FAIL (alice-confirmed-drop-10-UCT): expected delta $expected_delta, got $alice_delta" >&2
  rc=1
fi

if (( bob_delta == expected_delta )); then
  echo "ASSERT OK (bob-confirmed-rise-10-UCT): bob rose exactly 10 UCT confirmed"
else
  echo "ASSERT FAIL (bob-confirmed-rise-10-UCT): expected delta $expected_delta, got $bob_delta" >&2
  rc=1
fi

# Also assert there's no unconfirmed UCT residue on either side after
# finalize — the #389 #2 decimal-aware gate.
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

check_no_unconfirmed "alice-balance-after" "$SNAP/alice-balance-after.txt" || rc=1
check_no_unconfirmed "bob-balance-after"   "$SNAP/bob-balance-after.txt"   || rc=1

echo
if (( rc == 0 )); then
  banner "ALL GREEN — alice -10 UCT, bob +10 UCT, both CONFIRMED, no residue"
else
  banner "FAIL — see ASSERT FAIL lines above"
fi
exit "$rc"
