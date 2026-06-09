#!/usr/bin/env bash
#
# manual-test-swap-roundtrip.sh — swap module roundtrip soak
# (sphere-sdk#437).
#
# Scenario A — happy path:
#   1. Alice tops up via faucet to 100 UCT; bob tops up to 100 ETH.
#   2. Alice proposes a swap to @bob: give 50 UCT, receive 5 ETH.
#   3. Bob lists incoming proposals, captures the swap ID.
#   4. Bob accepts + deposits 5 ETH into escrow.
#   5. Alice deposits 50 UCT into escrow.
#   6. Both parties block on `sphere swap wait` until the escrow pays
#      out and the swap reaches `completed` locally.
#   7. Verify integer-only net deltas:
#        alice  -50 UCT  +5 ETH
#        bob    +50 UCT  -5 ETH
#   8. Verify both sides observe progress: completed.
#   9. Cross-hop poison-pill scan (no SERIALIZATION_ERROR /
#      VERIFICATION_FAILED / DUPLICATE_BUNDLE_MEMBERSHIP across logs).
#
# Optional Scenario B (acceptor declines):
#   After §A succeeds, alice proposes a smaller swap (5 UCT for 0.1 ETH),
#   bob runs `sphere swap reject` with a reason, both sides observe
#   `cancelled` and no balance changes.
#
# Optional Scenario C (proposer rescinds before counterparty accepts):
#   Alice proposes a swap, bob does NOT accept, alice runs
#   `sphere swap cancel`. Local state transitions to `cancelled`;
#   no DMs to escrow (pre-announce branch).
#
# This soak is the SWAP analog of:
#   - manual-test-roundtrip-391.sh         (transfer roundtrip)
#   - manual-test-accounting-roundtrip.sh  (invoice roundtrip)
#   - manual-test-full-recovery.sh         (Profile recovery)
#
# Run:
#   bash manual-test-swap-roundtrip.sh
#   KEEP=1 bash manual-test-swap-roundtrip.sh       # preserve workspace
#   SWAP_TEST_DIR=/tmp/sw bash manual-test-swap-roundtrip.sh
#   SCENARIO=A bash manual-test-swap-roundtrip.sh   # happy-path only
#   SCENARIO=AB bash manual-test-swap-roundtrip.sh  # default: A + B
#   SCENARIO=ABC bash manual-test-swap-roundtrip.sh # add cancel-before-accept
#
# Required env:
#   ESCROW          — escrow @nametag or DIRECT:// address
#                     (default: @escrow-testnet)
#
# Requires `sphere` on PATH, outbound HTTPS+WSS to testnet, and a
# reachable escrow service.
#
# Escrow nametag resolution fallback (sphere-sdk#456):
#   If the @escrow-testnet nametag does not resolve on the testnet
#   relay (the §2.5 `sphere swap ping` pre-flight will fail with
#   `Could not resolve recipient`), re-run with the escrow's raw
#   DIRECT address. The production testnet escrow currently lives at:
#
#     ESCROW="DIRECT://00007968fa28648e4670438bf1f3c936296e84ff46dd5ebb2e34e20092e780b652da2d3d695b" \
#       bash manual-test-swap-roundtrip.sh
#
#   The nametag remains the canonical reference — switch back once
#   the operator republishes the binding event.

set -euo pipefail

# ---- workspace ----
ROOT="${SWAP_TEST_DIR:-/tmp/swap-roundtrip-$$}"
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

ESCROW="${ESCROW:-@escrow-testnet}"
echo "ESCROW=$ESCROW"

SCENARIO="${SCENARIO:-AB}"
echo "SCENARIO=$SCENARIO"

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
# Same convention as manual-test-accounting-roundtrip.sh: both UCT and
# ETH have 18 decimals in the production testnet registry, so we pad
# fractional parts to 18 chars to get a smallest-unit integer.
#
# Args:   $1 = symbol (e.g. "UCT", "ETH")
# Stdin:  contents of `sphere balance` output.
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

# Helper for grep-based assertions that keep the ASSERT lines uniform.
assert_grep() {
  local label="$1" pattern="$2" file="$3"
  if grep -qE "$pattern" "$file"; then
    echo "ASSERT OK ($label): pattern matched in $file"
    return 0
  fi
  echo "ASSERT FAIL ($label): pattern '$pattern' NOT found in $file" >&2
  echo "--- $(basename "$file") tail ---" >&2
  tail -20 "$file" >&2 || true
  return 1
}

# Capture the swap_id from a `sphere swap propose --json` log.
extract_swap_id() {
  local log="$1"
  grep -Eo '"swap_id":[[:space:]]*"[0-9a-fA-F]{64}"' "$log" | head -1 \
    | sed -E 's/.*"([0-9a-fA-F]{64})".*/\1/'
}

# ---------------------------------------------------------------------------
# Section 1 — Create alice + bob (testnet)
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
sphere status | tee "$SNAP/bob-status.log"
grep -qE "Nametag:.*$BOB_TAG" "$SNAP/bob-status.log" \
  || { echo "FAIL: bob's nametag '$BOB_TAG' not visible in status" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Section 2 — Faucet alice → 100 UCT, bob → 100 ETH; capture baselines
#
# The swap soak's payoff is "alice gives UCT, bob gives ETH" → each side
# needs ONLY its half. We deliberately faucet asymmetrically here so the
# net-delta assertions in §8 catch any UCT/ETH cross-talk.
# ---------------------------------------------------------------------------
banner "Section 2: Faucet alice 100 UCT + bob 100 ETH; baselines"

cd "$PEER_ALICE"
sphere wallet use alice
sphere faucet 100 UCT               2>&1 | tee "$SNAP/alice-faucet.log"
sphere payments sync                2>&1 | tee "$SNAP/alice-sync-0.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/alice-faucet-receive.log"
sphere balance | tee "$SNAP/alice-balance-0.txt"

cd "$PEER_BOB"
sphere wallet use bob
sphere faucet 100 ETH               2>&1 | tee "$SNAP/bob-faucet.log"
sphere payments sync                2>&1 | tee "$SNAP/bob-sync-0.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/bob-faucet-receive.log"
sphere balance | tee "$SNAP/bob-balance-0.txt"

alice_uct_0=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-0.txt")
alice_eth_0=$(extract_confirmed_smallest_units ETH < "$SNAP/alice-balance-0.txt")
bob_uct_0=$(extract_confirmed_smallest_units   UCT < "$SNAP/bob-balance-0.txt")
bob_eth_0=$(extract_confirmed_smallest_units   ETH < "$SNAP/bob-balance-0.txt")
echo "BASELINE alice UCT=$alice_uct_0  ETH=$alice_eth_0"
echo "BASELINE bob   UCT=$bob_uct_0    ETH=$bob_eth_0"

EXPECTED_50_UCT=50000000000000000000   # 50 × 10^18
EXPECTED_5_ETH=5000000000000000000     #  5 × 10^18

# ---------------------------------------------------------------------------
# Section 2.5 — Escrow liveness pre-flight
#
# Without this, an unreachable escrow surfaces as
# `FAIL: couldn't extract swap_id from alice-propose-A.log` at §3, which
# misdirects operators to debug the propose command. A direct ping
# narrows the failure to "escrow not online" before we burn any swap
# state.
# ---------------------------------------------------------------------------
banner "Section 2.5: Escrow liveness pre-flight ($ESCROW)"

cd "$PEER_ALICE"
sphere wallet use alice
if ! sphere swap ping "$ESCROW" 2>&1 | tee "$SNAP/alice-escrow-ping.log"; then
  echo "ASSERT FAIL (escrow-unreachable): $ESCROW did not respond to swap ping" >&2
  echo "Hint: set ESCROW=<addr> to point at a different escrow service." >&2
  if [[ "$ESCROW" == "@escrow-testnet" ]]; then
    echo "Hint (sphere-sdk#456): the @escrow-testnet nametag binding may be" >&2
    echo "  missing on the testnet relay. Re-run with the DIRECT-address fallback:" >&2
    echo "  ESCROW=\"DIRECT://00007968fa28648e4670438bf1f3c936296e84ff46dd5ebb2e34e20092e780b652da2d3d695b\" \\" >&2
    echo "    bash manual-test-swap-roundtrip.sh" >&2
  fi
  exit 1
fi
echo "ASSERT OK (escrow-reachable): $ESCROW responded"

# ===========================================================================
# Scenario A — Full swap roundtrip
# ===========================================================================
banner "Scenario A — propose → accept → deposit → completed"

# ---------------------------------------------------------------------------
# Section 3 — Alice proposes 50 UCT for 5 ETH to @bob
# ---------------------------------------------------------------------------
banner "Section 3: Alice proposes 50 UCT for 5 ETH to @${BOB_TAG}"

cd "$PEER_ALICE"
sphere wallet use alice
sphere swap propose \
  --to "@${BOB_TAG}" \
  --offer 50 UCT \
  --want 5 ETH \
  --escrow "$ESCROW" \
  --message "soak: A=50 UCT for 5 ETH" \
  --json \
  2>&1 | tee "$SNAP/alice-propose-A.log"

SWAP_A=$(extract_swap_id "$SNAP/alice-propose-A.log")
[[ -n "$SWAP_A" ]] || { echo "FAIL: couldn't extract swap_id from alice-propose-A.log" >&2; exit 1; }
echo "SWAP_A=$SWAP_A"

# ---------------------------------------------------------------------------
# Section 4 — Bob polls until the proposal lands in his wallet
#
# Cross-process Nostr delivery: alice's CLI exits as soon as the
# propose DM is sent; bob's wallet needs to boot, subscribe with its
# persisted `since` cursor, and pull the DM from the relay backlog.
# Each `swap list` boot performs that subscription, so polling-with-tee
# is the right shape. Practical median latency is 5-15s; we cap at 90s.
# ---------------------------------------------------------------------------
banner "Section 4: Bob waits for the proposal to appear in `swap list`"

cd "$PEER_BOB"
sphere wallet use bob

DEADLINE=$(( $(date +%s) + 90 ))
PROPOSAL_SEEN=0
while (( $(date +%s) < DEADLINE )); do
  sphere payments sync > "$SNAP/bob-pre-list-A.log" 2>&1 || true
  sphere swap list --role acceptor 2>&1 | tee "$SNAP/bob-swap-list-A.log" || true
  # swap-list prints only the first 8 hex chars in its SWAP ID column.
  if grep -qE "${SWAP_A:0:8}" "$SNAP/bob-swap-list-A.log"; then
    echo "INFO: bob saw proposal ${SWAP_A:0:16}"
    PROPOSAL_SEEN=1
    break
  fi
  echo "  proposal not yet visible — sleeping 3s and retrying…"
  sleep 3
done
if (( PROPOSAL_SEEN == 0 )); then
  echo "ASSERT FAIL (proposal-ingest-timeout): bob did NOT receive proposal $SWAP_A within 90s" >&2
  exit 1
fi
echo "ASSERT OK (proposal-ingest): bob ingested proposal $SWAP_A"

# ---------------------------------------------------------------------------
# Section 5 — Bob accepts + deposits 5 ETH
#
# `swap accept --deposit` waits for `swap:announced` from the escrow,
# then immediately calls `deposit` against the escrow's deposit
# invoice. Without `--deposit` bob would have to call `swap deposit`
# separately; we exercise the one-shot form here because it's the
# canonical happy-path UX.
# ---------------------------------------------------------------------------
banner "Section 5: Bob accepts + deposits 5 ETH"

sphere swap accept "$SWAP_A" --deposit --no-wait 2>&1 | tee "$SNAP/bob-accept-A.log"

# ---------------------------------------------------------------------------
# Section 6 — Alice deposits 50 UCT
#
# Alice's wallet needs to have ingested the escrow's `announce_result`
# DM before `swap deposit` can succeed (the deposit invoice ID is only
# known after that DM lands). We poll `swap status` until alice sees
# the swap progress at >= 'announced'.
# ---------------------------------------------------------------------------
banner "Section 6: Alice waits for announce → deposits 50 UCT"

cd "$PEER_ALICE"
sphere wallet use alice

# Poll until alice's local SwapRef has advanced past 'proposed'.
DEADLINE=$(( $(date +%s) + 120 ))
ANNOUNCED=0
while (( $(date +%s) < DEADLINE )); do
  sphere payments sync > "$SNAP/alice-pre-deposit-sync.log" 2>&1 || true
  sphere swap status "$SWAP_A" 2>&1 | tee "$SNAP/alice-swap-status-pre-deposit.log" || true
  # `progress: announced`, `progress: depositing`, or `progress: awaiting_counter`
  # all indicate the escrow's announce_result has been processed.
  if grep -qE 'progress[[:space:]]*:[[:space:]]*(announced|depositing|awaiting_counter)' \
       "$SNAP/alice-swap-status-pre-deposit.log"; then
    echo "INFO: alice's swap reached announced/depositing/awaiting_counter"
    ANNOUNCED=1
    break
  fi
  echo "  swap not yet announced for alice — sleeping 3s and retrying…"
  sleep 3
done
if (( ANNOUNCED == 0 )); then
  echo "ASSERT FAIL (announce-ingest-timeout): alice did not see swap announced within 120s" >&2
  exit 1
fi

sphere swap deposit "$SWAP_A" 2>&1 | tee "$SNAP/alice-deposit-A.log"

# ---------------------------------------------------------------------------
# Section 7 — Both parties block on `swap wait --state completed`
#
# This is the load-bearing pin for the new wait primitive: each side's
# wait subscribes to swap:* events for SWAP_A, dispatches on each
# transition, and exits 0 only when local progress reaches 'completed'.
# We run alice in the background and bob in the foreground so the
# script blocks until BOTH return.
#
# Subshell exit-code semantics (load-bearing): `set -euo pipefail` is
# inherited by the subshell. `sphere swap wait | tee` is a 2-stage
# pipeline. With `pipefail`, the pipeline's exit code is the first
# non-zero stage — so a non-zero exit from sphere swap wait (terminal
# state with --exit-on-failure → 1, or timeout → 124) propagates
# through tee (which is always 0) to the subshell's exit. `wait $PID`
# then captures it correctly. If a future edit drops the subshell or
# replaces `tee` with a write that can fail, this contract breaks.
# ---------------------------------------------------------------------------
banner "Section 7: Both parties wait for swap completion"

(
  cd "$PEER_ALICE"
  sphere wallet use alice
  sphere swap wait "$SWAP_A" --state completed --timeout 300 --exit-on-failure \
    2>&1 | tee "$SNAP/alice-wait-A.log"
) &
ALICE_WAIT_PID=$!

cd "$PEER_BOB"
sphere wallet use bob
set +e
sphere swap wait "$SWAP_A" --state completed --timeout 300 --exit-on-failure \
  2>&1 | tee "$SNAP/bob-wait-A.log"
BOB_WAIT_RC=$?
set -e

set +e
wait "$ALICE_WAIT_PID"
ALICE_WAIT_RC=$?
set -e

echo "alice swap wait rc: $ALICE_WAIT_RC"
echo "bob   swap wait rc: $BOB_WAIT_RC"
[[ "$BOB_WAIT_RC" -eq 0 ]] \
  || { echo "ASSERT FAIL (bob-wait): exit $BOB_WAIT_RC (expected 0)" >&2; exit 1; }
[[ "$ALICE_WAIT_RC" -eq 0 ]] \
  || { echo "ASSERT FAIL (alice-wait): exit $ALICE_WAIT_RC (expected 0)" >&2; exit 1; }
echo "ASSERT OK (both-wait-rc-0): both sides reached 'completed' within budget"

# ---------------------------------------------------------------------------
# Section 8 — Verify integer-only net deltas
#
# Expected:
#   alice  -50 UCT  +5 ETH
#   bob    +50 UCT  -5 ETH
# ---------------------------------------------------------------------------
banner "Section 8: Verify net deltas (smallest-unit integers)"

cd "$PEER_ALICE"
sphere wallet use alice
sphere payments sync                2>&1 | tee "$SNAP/alice-post-sync.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/alice-post-receive.log" || true
sphere balance | tee "$SNAP/alice-balance-A.txt"

cd "$PEER_BOB"
sphere wallet use bob
sphere payments sync                2>&1 | tee "$SNAP/bob-post-sync.log"
sphere payments receive --finalize  2>&1 | tee "$SNAP/bob-post-receive.log" || true
sphere balance | tee "$SNAP/bob-balance-A.txt"

alice_uct_A=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-A.txt")
alice_eth_A=$(extract_confirmed_smallest_units ETH < "$SNAP/alice-balance-A.txt")
bob_uct_A=$(extract_confirmed_smallest_units   UCT < "$SNAP/bob-balance-A.txt")
bob_eth_A=$(extract_confirmed_smallest_units   ETH < "$SNAP/bob-balance-A.txt")

alice_uct_delta=$(python3 -c "print($alice_uct_0 - $alice_uct_A)")  # POSITIVE = paid
alice_eth_delta=$(python3 -c "print($alice_eth_A - $alice_eth_0)")  # POSITIVE = received
bob_uct_delta=$(python3 -c "print($bob_uct_A - $bob_uct_0)")        # POSITIVE = received
bob_eth_delta=$(python3 -c "print($bob_eth_0 - $bob_eth_A)")        # POSITIVE = paid

echo "alice UCT delta (paid):    $alice_uct_delta  (expected $EXPECTED_50_UCT)"
echo "alice ETH delta (received): $alice_eth_delta  (expected $EXPECTED_5_ETH)"
echo "bob   UCT delta (received): $bob_uct_delta    (expected $EXPECTED_50_UCT)"
echo "bob   ETH delta (paid):     $bob_eth_delta    (expected $EXPECTED_5_ETH)"

rc=0
[[ "$alice_uct_delta" == "$EXPECTED_50_UCT" ]] \
  || { echo "ASSERT FAIL (alice-uct-minus-50): expected $EXPECTED_50_UCT, got $alice_uct_delta" >&2; rc=1; }
[[ "$alice_eth_delta" == "$EXPECTED_5_ETH" ]] \
  || { echo "ASSERT FAIL (alice-eth-plus-5):  expected $EXPECTED_5_ETH, got $alice_eth_delta" >&2; rc=1; }
[[ "$bob_uct_delta"   == "$EXPECTED_50_UCT" ]] \
  || { echo "ASSERT FAIL (bob-uct-plus-50):   expected $EXPECTED_50_UCT, got $bob_uct_delta" >&2; rc=1; }
[[ "$bob_eth_delta"   == "$EXPECTED_5_ETH" ]] \
  || { echo "ASSERT FAIL (bob-eth-minus-5):   expected $EXPECTED_5_ETH, got $bob_eth_delta" >&2; rc=1; }
(( rc == 0 )) && echo "ASSERT OK (deltas): all four legs match"

# ---------------------------------------------------------------------------
# Section 9 — Final state: both sides show progress: completed
# ---------------------------------------------------------------------------
banner "Section 9: Verify final swap status on both sides"

cd "$PEER_ALICE"
sphere wallet use alice
sphere swap status "$SWAP_A" 2>&1 | tee "$SNAP/alice-swap-status-final.log"
assert_grep "alice-status-completed" 'progress[[:space:]]*:[[:space:]]*completed' \
  "$SNAP/alice-swap-status-final.log" || rc=1

cd "$PEER_BOB"
sphere wallet use bob
sphere swap status "$SWAP_A" 2>&1 | tee "$SNAP/bob-swap-status-final.log"
assert_grep "bob-status-completed" 'progress[[:space:]]*:[[:space:]]*completed' \
  "$SNAP/bob-swap-status-final.log" || rc=1

# ---------------------------------------------------------------------------
# Section 10 — Cross-hop poison-pill scan
# ---------------------------------------------------------------------------
banner "Section 10: Poison-pill scan across all logs"

# Use `grep -l` (list filenames with matches). The old `grep -c | grep -v ':0$'`
# pipeline tripped `set -euo pipefail` on a clean run: the inner `grep -v`
# exits 1 when every file is `:0` (no matches), pipefail propagates, and
# the command substitution aborts the script before we ever print
# "ASSERT OK". `|| true` keeps the pipeline non-fatal on no-matches —
# emptiness is the success case here, not an error.
POISON_FILES=$(grep -lE "SERIALIZATION_ERROR|VERIFICATION_FAILED|DUPLICATE_BUNDLE_MEMBERSHIP" \
  "$SNAP"/*.log 2>/dev/null || true)
if [[ -n "$POISON_FILES" ]]; then
  POISON_HITS=$(printf '%s\n' "$POISON_FILES" | wc -l)
  echo "ASSERT FAIL (poison-pill): found $POISON_HITS log(s) with poison-pill errors" >&2
  printf '%s\n' "$POISON_FILES" >&2
  rc=1
else
  echo "ASSERT OK (poison-pill-clean): no SERIALIZATION_ERROR / VERIFICATION_FAILED / DUPLICATE_BUNDLE_MEMBERSHIP across any log"
fi

if (( rc != 0 )); then
  banner "FAIL Scenario A — see ASSERT FAIL lines above"
  exit "$rc"
fi

# ---------------------------------------------------------------------------
# Section 11 — ALL GREEN (Scenario A)
# ---------------------------------------------------------------------------
banner "ALL GREEN — swap round-trip succeeded (Scenario A)"

if [[ "$SCENARIO" != *"B"* && "$SCENARIO" != *"C"* ]]; then
  exit 0
fi

# ===========================================================================
# Scenario B — Acceptor declines (negative path)
# ===========================================================================
if [[ "$SCENARIO" == *"B"* ]]; then
  banner "Scenario B — propose → reject → no balance change"

  # Snapshot balances before scenario B so we can prove no funds moved.
  cd "$PEER_ALICE"; sphere wallet use alice
  sphere balance | tee "$SNAP/alice-balance-pre-B.txt"
  alice_uct_pre_B=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-pre-B.txt")
  alice_eth_pre_B=$(extract_confirmed_smallest_units ETH < "$SNAP/alice-balance-pre-B.txt")

  cd "$PEER_BOB"; sphere wallet use bob
  sphere balance | tee "$SNAP/bob-balance-pre-B.txt"
  bob_uct_pre_B=$(extract_confirmed_smallest_units UCT < "$SNAP/bob-balance-pre-B.txt")
  bob_eth_pre_B=$(extract_confirmed_smallest_units ETH < "$SNAP/bob-balance-pre-B.txt")

  banner "Section B.1: Alice proposes 5 UCT for 0.1 ETH (smaller stake)"
  cd "$PEER_ALICE"; sphere wallet use alice
  sphere swap propose \
    --to "@${BOB_TAG}" \
    --offer 5 UCT \
    --want 0.1 ETH \
    --escrow "$ESCROW" \
    --message "soak: B=5 UCT for 0.1 ETH (will be declined)" \
    --json \
    2>&1 | tee "$SNAP/alice-propose-B.log"

  SWAP_B=$(extract_swap_id "$SNAP/alice-propose-B.log")
  [[ -n "$SWAP_B" ]] || { echo "FAIL: couldn't extract swap_id (B)" >&2; exit 1; }
  echo "SWAP_B=$SWAP_B"

  banner "Section B.2: Bob waits for the proposal then rejects"
  cd "$PEER_BOB"; sphere wallet use bob

  DEADLINE=$(( $(date +%s) + 90 ))
  PROPOSAL_SEEN=0
  while (( $(date +%s) < DEADLINE )); do
    sphere payments sync >/dev/null 2>&1 || true
    sphere swap list --role acceptor 2>&1 | tee "$SNAP/bob-swap-list-B.log" || true
    if grep -qE "${SWAP_B:0:8}" "$SNAP/bob-swap-list-B.log"; then
      PROPOSAL_SEEN=1
      break
    fi
    sleep 3
  done
  (( PROPOSAL_SEEN == 1 )) \
    || { echo "ASSERT FAIL (B-proposal-ingest): bob did not see proposal B within 90s" >&2; exit 1; }

  # NOTE: deliberately NOT using --json — assert_grep below targets the
  # human renderer's unquoted "key : value" form rather than the
  # double-quoted JSON shape that formatOutput emits in --json mode.
  sphere swap reject "$SWAP_B" --reason "soak: declining for B" \
    2>&1 | tee "$SNAP/bob-reject-B.log"
  assert_grep "B-reject-state" 'new_state[[:space:]]*:[[:space:]]*cancelled' \
    "$SNAP/bob-reject-B.log" || rc=1
  assert_grep "B-reject-reason" 'reason[[:space:]]*:[[:space:]]*soak: declining for B' \
    "$SNAP/bob-reject-B.log" || rc=1

  banner "Section B.3: Alice observes 'cancelled' state for the rejected swap"
  cd "$PEER_ALICE"; sphere wallet use alice

  DEADLINE=$(( $(date +%s) + 90 ))
  CANCEL_SEEN=0
  while (( $(date +%s) < DEADLINE )); do
    sphere payments sync >/dev/null 2>&1 || true
    sphere swap status "$SWAP_B" 2>&1 | tee "$SNAP/alice-swap-status-B.log" || true
    if grep -qE 'progress[[:space:]]*:[[:space:]]*cancelled' "$SNAP/alice-swap-status-B.log"; then
      CANCEL_SEEN=1
      break
    fi
    sleep 3
  done
  (( CANCEL_SEEN == 1 )) \
    || { echo "ASSERT FAIL (B-alice-cancel-ingest): alice did not see swap B cancelled within 90s" >&2; rc=1; }
  [[ "$rc" -eq 0 ]] && echo "ASSERT OK (B-alice-cancel): alice observed swap B cancelled"

  banner "Section B.4: No balance changes from Scenario B"
  cd "$PEER_ALICE"; sphere wallet use alice
  sphere payments sync >/dev/null 2>&1 || true
  sphere balance | tee "$SNAP/alice-balance-post-B.txt"
  cd "$PEER_BOB"; sphere wallet use bob
  sphere payments sync >/dev/null 2>&1 || true
  sphere balance | tee "$SNAP/bob-balance-post-B.txt"

  alice_uct_post_B=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-post-B.txt")
  alice_eth_post_B=$(extract_confirmed_smallest_units ETH < "$SNAP/alice-balance-post-B.txt")
  bob_uct_post_B=$(extract_confirmed_smallest_units   UCT < "$SNAP/bob-balance-post-B.txt")
  bob_eth_post_B=$(extract_confirmed_smallest_units   ETH < "$SNAP/bob-balance-post-B.txt")

  for pair in \
    "alice-UCT $alice_uct_pre_B $alice_uct_post_B" \
    "alice-ETH $alice_eth_pre_B $alice_eth_post_B" \
    "bob-UCT $bob_uct_pre_B $bob_uct_post_B" \
    "bob-ETH $bob_eth_pre_B $bob_eth_post_B"; do
    # shellcheck disable=SC2086
    set -- $pair
    label="$1" pre="$2" post="$3"
    if [[ "$pre" == "$post" ]]; then
      echo "ASSERT OK (B-no-balance-change-$label): $pre == $post"
    else
      echo "ASSERT FAIL (B-no-balance-change-$label): $pre != $post (delta $(python3 -c "print($post - $pre)"))" >&2
      rc=1
    fi
  done

  if (( rc != 0 )); then
    banner "FAIL Scenario B — see ASSERT FAIL lines above"
    exit "$rc"
  fi
  banner "ALL GREEN — Scenario B (reject) succeeded"
fi

# ===========================================================================
# Scenario C — Proposer rescinds before counterparty accepts
# ===========================================================================
if [[ "$SCENARIO" == *"C"* ]]; then
  banner "Scenario C — propose → (no accept) → proposer cancels pre-announce"

  cd "$PEER_ALICE"; sphere wallet use alice
  sphere balance | tee "$SNAP/alice-balance-pre-C.txt"
  alice_uct_pre_C=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-pre-C.txt")
  alice_eth_pre_C=$(extract_confirmed_smallest_units ETH < "$SNAP/alice-balance-pre-C.txt")

  banner "Section C.1: Alice proposes a tiny swap (will be cancelled pre-announce)"
  sphere swap propose \
    --to "@${BOB_TAG}" \
    --offer 1 UCT \
    --want 0.01 ETH \
    --escrow "$ESCROW" \
    --message "soak: C=1 UCT for 0.01 ETH (will be cancelled)" \
    --json \
    2>&1 | tee "$SNAP/alice-propose-C.log"

  SWAP_C=$(extract_swap_id "$SNAP/alice-propose-C.log")
  [[ -n "$SWAP_C" ]] || { echo "FAIL: couldn't extract swap_id (C)" >&2; exit 1; }
  echo "SWAP_C=$SWAP_C"

  # Cancel immediately, before bob has a chance to accept. The CLI's
  # state-aware cancel takes the pre-announce branch and exits without
  # waiting for any escrow round-trip.
  banner "Section C.2: Alice cancels the swap (pre-announce)"
  # See note in §B.2 — human renderer's "key : value" lines are what
  # assert_grep targets.
  sphere swap cancel "$SWAP_C" 2>&1 | tee "$SNAP/alice-cancel-C.log"
  assert_grep "C-cancel-state" 'new_state[[:space:]]*:[[:space:]]*cancelled' \
    "$SNAP/alice-cancel-C.log" || rc=1
  assert_grep "C-cancel-prev-state" 'prev_state[[:space:]]*:[[:space:]]*(proposed|accepted)' \
    "$SNAP/alice-cancel-C.log" || rc=1

  # If the pre-announce branch was taken correctly, the JSON output's
  # deposits_returned will be `false` (no escrow involvement) — this is
  # the cleanest signal that the cancel went through the local-only path.
  assert_grep "C-cancel-pre-announce" 'deposits_returned[[:space:]]*:[[:space:]]*false' \
    "$SNAP/alice-cancel-C.log" || rc=1

  banner "Section C.3: No balance changes from Scenario C"
  sphere payments sync >/dev/null 2>&1 || true
  sphere balance | tee "$SNAP/alice-balance-post-C.txt"
  alice_uct_post_C=$(extract_confirmed_smallest_units UCT < "$SNAP/alice-balance-post-C.txt")
  alice_eth_post_C=$(extract_confirmed_smallest_units ETH < "$SNAP/alice-balance-post-C.txt")

  [[ "$alice_uct_pre_C" == "$alice_uct_post_C" ]] \
    || { echo "ASSERT FAIL (C-no-balance-change-alice-UCT): $alice_uct_pre_C != $alice_uct_post_C" >&2; rc=1; }
  [[ "$alice_eth_pre_C" == "$alice_eth_post_C" ]] \
    || { echo "ASSERT FAIL (C-no-balance-change-alice-ETH): $alice_eth_pre_C != $alice_eth_post_C" >&2; rc=1; }
  (( rc == 0 )) && echo "ASSERT OK (C-no-balance-change): alice's balances unchanged"

  if (( rc != 0 )); then
    banner "FAIL Scenario C — see ASSERT FAIL lines above"
    exit "$rc"
  fi
  banner "ALL GREEN — Scenario C (proposer cancel) succeeded"
fi

banner "ALL GREEN — swap round-trip soak succeeded ($SCENARIO)"
exit 0
