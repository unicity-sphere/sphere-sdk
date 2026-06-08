# Sphere CLI Demo Playbook — Swap Round-Trip

A presenter-friendly run-through of the **swap module lifecycle** on real testnet — proposal, acceptance, escrow-mediated deposits, and atomic payout. The demo exercises:

1. **Scenario A (§1-§8) — Happy path.** Alice proposes 50 UCT for 5 ETH, bob accepts + deposits, alice deposits, both sides receive payouts. Net delta: alice `-50 UCT +5 ETH`, bob `+50 UCT -5 ETH`.
2. **Scenario B (§9) — Acceptor declines.** Alice proposes 5 UCT for 0.1 ETH, bob runs `sphere swap reject --reason "…"`, both sides observe `cancelled` with no balance change. (Optional — adds ~3 min.)
3. **Scenario C (§10) — Proposer rescinds.** Alice proposes a tiny swap, then `sphere swap cancel` before bob accepts — pre-announce branch, local-only transition, no escrow round-trip. (Optional — adds ~2 min.)

The load-bearing payoff is **§7** — `sphere swap wait` is the new blocking primitive. Before this PR, soaks and demo scripts had to sit in a polling loop around `sphere swap status` with sleeps. The new command subscribes to swap events and exits when local progress reaches the target state, so a script can write `sphere swap wait $ID --state completed --timeout 300 --exit-on-failure` and trust the exit code.

This is the companion to the soak script [`manual-test-swap-roundtrip.sh`](../manual-test-swap-roundtrip.sh) — that script asserts the same thing programmatically; this playbook walks the same flow live in front of an audience.

---

## At a glance

```
SETUP             alice + bob wallets on testnet, asymmetric faucet
                     alice 100 UCT, bob 100 ETH

SCENARIO A — full swap round-trip
§3   Alice proposes:    sphere swap propose --to @bob --offer 50 UCT --want 5 ETH
                          → SWAP_ID captured from --json
§4   Bob lists incoming proposals     → SWAP_ID visible
§5   Bob accepts + deposits 5 ETH     → sphere swap accept $ID --deposit
§6   Alice deposits 50 UCT             → sphere swap deposit $ID
§7   Both block on swap wait           → sphere swap wait $ID --state completed
                                           --timeout 300 --exit-on-failure
§8   Verify balances + final status
                                           alice -50 UCT +5 ETH
                                           bob   +50 UCT -5 ETH
                                           both sides: progress: completed

SCENARIO B (optional) — acceptor declines
§9   Alice proposes 5 UCT for 0.1 ETH
     Bob:   sphere swap reject $ID --reason "Price too high"
     Both sides observe `cancelled`, no balance change

SCENARIO C (optional) — proposer rescinds before announce
§10  Alice proposes 1 UCT for 0.01 ETH
     Alice (immediately): sphere swap cancel $ID
     Local-only transition; deposits_returned: false
```

Total run time:
- Scenario A only: ~8-12 min on a healthy testnet
- Scenario A + B: ~12-16 min
- Scenario A + B + C: ~14-18 min

---

## §0 Before you start

### Prerequisites

- `sphere` CLI on `PATH` (`which sphere` should resolve).
- Outbound HTTPS to: `faucet.unicity.network`, `goggregator-test.unicity.network`, Unicity IPFS gateways.
- Outbound WSS to: `wss://nostr-relay.testnet.unicity.network`.
- An escrow service reachable on the same testnet relay set as the wallets. The default is `@escrow-testnet`; override with `--escrow @your-escrow` or `--escrow DIRECT://…` on `swap propose`.
- A clean workspace (the script wipes its own scratch dir on exit unless `KEEP=1`).

### Dependency check (one-time setup)

This playbook exercises three new CLI commands shipped with **sphere-sdk#437** (in sphere-cli): `swap reject` (`--reason` flag), `swap cancel` (state-aware + `--timeout`), and `swap wait` (new). Confirm the running CLI binary has them:

```bash
sphere swap reject --help | grep -c -- '--reason'        # should be 1
sphere swap cancel --help | grep -c -- '--timeout'       # should be 1
sphere swap wait   --help | grep -c -- '--exit-on-failure' # should be 1
```

If any of those return `0`, the binary on `PATH` is behind the #437 cut — rebuild before demoing. The SDK side (`rejectSwap` / `cancelSwap` / `getSwapStatus`) is unchanged — these are pure CLI additions on top of the existing `SwapModule`.

### Versions to confirm

```bash
sphere --help | head -3
node --version    # >= 18
```

### Suggested terminal layout

- **T1** — alice's peer.
- **T2** — bob's peer.
- **T3** — log tail (optional; useful for showing swap event flow if anything stalls).

### Workspace

```bash
ROOT="/tmp/demo-swap-$$"
mkdir -p "$ROOT/peer-alice" "$ROOT/peer-bob"
SUFFIX="$(date +%s | tail -c 5)$(printf '%04x' $((RANDOM % 65536)))"
ALICE_TAG="alice-$SUFFIX"
BOB_TAG="bob-$SUFFIX"
echo "ALICE_TAG=$ALICE_TAG"
echo "BOB_TAG=$BOB_TAG"

# Default escrow. Override if your environment uses a different one.
ESCROW="${ESCROW:-@escrow-testnet}"
echo "ESCROW=$ESCROW"

# CLI emits mnemonic on stdout in non-TTY when --no-encrypt-mnemonic
# is implied. Allowing this makes the live walkthrough scriptable.
export SPHERE_ALLOW_MNEMONIC_NON_TTY=1
```

---

## §1 Create the two wallets

### Alice — T1

```bash
cd "$ROOT/peer-alice"
sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --nametag "$ALICE_TAG"
```

### Bob — T2

```bash
cd "$ROOT/peer-bob"
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --nametag "$BOB_TAG"
```

**Talk track:** "Both wallets are minted on real testnet — alice and bob each have an on-chain nametag. The swap protocol's nametag-binding proofs use these on-chain identifiers, so the wallets must be fully provisioned before the proposal can be signed."

---

## §2 Faucet — asymmetric so the demo can catch cross-talk

### T1 — alice gets UCT only

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere faucet 100 UCT
sphere payments sync
sphere payments receive --finalize
sphere balance
```

### T2 — bob gets ETH only

```bash
cd "$ROOT/peer-bob"
sphere wallet use bob
sphere faucet 100 ETH
sphere payments sync
sphere payments receive --finalize
sphere balance
```

Expected:
- alice: `UCT: 100 (1 token)` and no ETH row.
- bob: `ETH: 100 (1 token)` and no UCT row.

**Snapshot now.** This is the "before" state. The asymmetric setup is intentional — every net-delta assertion in §8 has to come out of the swap, not an existing pool of both coins.

**Talk track:** "Each side has only the coin it's giving up. The only way alice can finish with ETH (and bob with UCT) is for the swap to actually pay out. There's no fallback liquidity to mask a bug."

---

# Scenario A — Full swap round-trip

## §3 Alice proposes — 50 UCT for 5 ETH

### T1

```bash
sphere wallet use alice
sphere swap propose \
  --to "@${BOB_TAG}" \
  --offer 50 UCT \
  --want 5 ETH \
  --escrow "$ESCROW" \
  --message "Demo: half my UCT for some of your ETH" \
  --json
```

Expected output excerpt:

```text
Swap proposed:
  {
    "swap_id": "0000...",   // 64 hex chars
    "counterparty": "@bob-XXXXX",
    "escrow": "@escrow-testnet",
    ...
  }
```

Capture the ID:

```bash
SWAP_ID=$(sphere swap propose ... --json 2>&1 | grep -Eo '"swap_id":[[:space:]]*"[0-9a-f]{64}"' | head -1 | sed -E 's/.*"([0-9a-f]+)".*/\1/')
# Or, if you ran it once already, copy the id from the prior output:
SWAP_ID=<paste-from-above>
echo "SWAP_ID=$SWAP_ID"
```

**Talk track:** "The proposal carries a signed manifest — proposer signature over `swap_consent:{swap_id}:{escrow_address}` plus a nametag binding proof. The escrow won't even look at the deal until both signatures match the manifest. The swap_id is content-addressed: SHA-256 over the manifest fields. Bob can recompute it and verify before he agrees."

---

## §4 Bob sees the proposal

### T2

```bash
cd "$ROOT/peer-bob"
sphere wallet use bob
sphere swap list --role acceptor
```

Expected — bob's list now shows an entry with `swapId: 0000…` (the first 16 hex chars of `$SWAP_ID`) and `progress: proposed`. If it doesn't appear immediately, poll for ~30s — the proposal DM is a NIP-17 gift-wrap and may take a few seconds to land:

```bash
# T2 — poll-and-wait pattern
for i in {1..20}; do
  sphere swap list --role acceptor | grep -q "${SWAP_ID:0:16}" && break
  sleep 3
done
sphere swap list --role acceptor
```

**Talk track:** "Bob's wallet picked up the proposal DM, decoded the manifest, verified alice's nametag binding, and registered the swap in his local SwapModule. He hasn't sent anything back yet — accepting is an explicit step."

---

## §5 Bob accepts + deposits 5 ETH (one shot)

### T2

```bash
sphere swap accept "$SWAP_ID" --deposit --no-wait
```

Expected:

```text
Swap accepted. Announced to escrow. Waiting for deposit invoice...
[swap] swap reached 'announced' — running deposit
Deposit sent: <transferId>
Run 'swap wait <id>' to block until completion.
```

What this single command did:
1. Sent the acceptance DM to alice (acceptor signature added to the manifest).
2. Sent the announce DM to the escrow (with both signatures now present).
3. Waited for the escrow's `announce_result` reply.
4. Paid the resulting deposit invoice with 5 ETH.

**Talk track:** "`--deposit --no-wait` is the one-shot 'accept and pay my side' UX. Without `--deposit`, bob would have to run `sphere swap deposit $SWAP_ID` later. `--no-wait` makes the command return as soon as the deposit transfer is sent, instead of blocking until the whole swap finishes — we use `sphere swap wait` later for the blocking phase, which is the canonical pattern."

---

## §6 Alice deposits 50 UCT

### T1

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice

# Wait for alice's wallet to see the escrow's announce_result (so the
# deposit invoice is locally known). Polling here is normal — the
# announce_result DM is async and can take 10-30s on a slow relay.
for i in {1..40}; do
  state=$(sphere swap status "$SWAP_ID" 2>/dev/null \
    | grep -oE 'progress[[:space:]]*:[[:space:]]*[a-z_]+' | head -1 | awk '{print $3}')
  echo "  alice's swap progress: $state"
  case "$state" in announced|depositing|awaiting_counter) break ;; esac
  sleep 3
done

sphere swap deposit "$SWAP_ID"
```

Expected:

```text
Deposit result:
  id     : <transferId>
  status : submitted
```

**Talk track:** "The deposit invoice was created by the escrow when bob sent the announce. Both parties' wallets receive it via DM and import it locally. Alice's `swap deposit` is just `sphere invoice pay` under the hood — the deposit invoice is a regular invoice token. The escrow validates the payment against the manifest and only releases when both deposits cover the required amounts."

---

## §7 Both parties block on `swap wait`  ← the new primitive

### T1 (run in background)

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere swap wait "$SWAP_ID" \
  --state completed \
  --timeout 300 \
  --exit-on-failure &
ALICE_WAIT_PID=$!
echo "alice swap wait pid=$ALICE_WAIT_PID"
```

### T2 (block in foreground)

```bash
cd "$ROOT/peer-bob"
sphere wallet use bob
sphere swap wait "$SWAP_ID" \
  --state completed \
  --timeout 300 \
  --exit-on-failure
# bob's wait returns first (or simultaneously); then:
wait "$ALICE_WAIT_PID"
```

Expected — both commands stream state transitions while waiting, then exit 0:

```text
[14:32:11] swap 0000abcd → depositing
[14:32:14] swap 0000abcd → awaiting_counter
[14:32:24] swap 0000abcd → concluding
[14:32:31] swap 0000abcd → completed
```

In `--json` mode, each transition is one compact JSON line:

```json
{"swap_id":"0000abcd...","state":"depositing","ts":1747839131456}
```

**Exit-code contract** (load-bearing for soaks and CI):

| Exit | Meaning |
|---|---|
| `0` | Reached `--state` (or terminal-but-wrong without `--exit-on-failure`). |
| `1` | Reached a terminal-but-wrong state (`cancelled`/`failed`) and `--exit-on-failure` was set. |
| `124` | Wall-clock timeout. Matches GNU `timeout(1)`. |

**Talk track:** "This is the payoff of #437. Before this command, every soak script that called `sphere swap propose` had to wrap the result in a polling loop around `sphere swap status` with sleeps. Now you spell 'wait until this swap settles' as one command, and the exit code tells you what happened. The 124 timeout maps to `timeout`'s convention so existing shell idioms (`if !$cmd; then …; fi`) work the way operators expect."

---

## §8 Verify balances + final state

### T1 — alice

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere payments sync
sphere payments receive --finalize
sphere balance
sphere swap status "$SWAP_ID"
```

Expected:
- alice's `UCT: 50 (1 or more tokens)` (100 − 50 = 50)
- alice's `ETH: 5 (1 token)` (0 + 5 = 5)
- swap status: `progress: completed`, `role: proposer`

### T2 — bob

```bash
cd "$ROOT/peer-bob"
sphere wallet use bob
sphere payments sync
sphere payments receive --finalize
sphere balance
sphere swap status "$SWAP_ID"
```

Expected:
- bob's `UCT: 50 (1 token)` (0 + 50 = 50)
- bob's `ETH: 95 (1 or more tokens)` (100 − 5 = 95)
- swap status: `progress: completed`, `role: acceptor`

### Scenario A net flow

| Wallet | Baseline (§2)       | Final (§8)         | Δ                  |
|---|---|---|---|
| alice | 100 UCT, 0 ETH | 50 UCT, 5 ETH | **−50 UCT, +5 ETH** |
| bob   | 0 UCT, 100 ETH | 50 UCT, 95 ETH | **+50 UCT, −5 ETH** |

In smallest-unit integers (both coins have 18 decimals):
- alice UCT: `100·10¹⁸ → 50·10¹⁸` (Δ = `−50·10¹⁸`)
- alice ETH: `0 → 5·10¹⁸` (Δ = `+5·10¹⁸`)
- bob UCT:   `0 → 50·10¹⁸` (Δ = `+50·10¹⁸`)
- bob ETH:   `100·10¹⁸ → 95·10¹⁸` (Δ = `−5·10¹⁸`)

All four match. The 50 UCT / 5 ETH atomic swap is real, on-chain, and accounted for at every level — token-level balances, the escrow's deposit/payout invoice ledger, and both wallets' local SwapRef records (`progress: completed`).

**Talk track:** "Atomic — both sides moved or neither. Cryptographically: each payout invoice was created by the escrow with the receiving party's address as the target. The escrow's payout transfer is on-chain; the wallets' `swap:completed` event fires only after `verifyPayout` confirms the payout invoice's terms match what was promised in the manifest."

---

# Scenario B — Acceptor declines (optional, ~3 min)

A clean negative-path demo: bob doesn't like the terms and rejects. No funds move.

## §9 Alice proposes, bob rejects

### T1

```bash
sphere wallet use alice
sphere balance | tee /tmp/alice-pre-B.txt   # snapshot for the no-change check
sphere swap propose \
  --to "@${BOB_TAG}" \
  --offer 5 UCT \
  --want 0.1 ETH \
  --escrow "$ESCROW" \
  --message "Demo: smaller test deal" \
  --json
# capture the new swap_id:
SWAP_B=<paste-from-above>
echo "SWAP_B=$SWAP_B"
```

### T2

```bash
sphere wallet use bob
sphere balance | tee /tmp/bob-pre-B.txt
# Poll until bob sees the new proposal:
for i in {1..20}; do
  sphere swap list --role acceptor | grep -q "${SWAP_B:0:16}" && break
  sleep 3
done
# Reject with an explanatory reason:
sphere swap reject "$SWAP_B" --reason "Price too high for this slot" --json
```

Expected:

```text
Swap rejected:
  {
    "swap_id": "<id>",
    "prev_state": "proposed",
    "new_state": "cancelled",
    "reason": "Price too high for this slot"
  }
```

### T1 — alice observes the rejection

```bash
sphere wallet use alice
# Poll for state transition:
for i in {1..30}; do
  state=$(sphere swap status "$SWAP_B" 2>/dev/null \
    | grep -oE 'progress[[:space:]]*:[[:space:]]*[a-z_]+' | head -1 | awk '{print $3}')
  echo "  alice's view of SWAP_B: $state"
  [[ "$state" == "cancelled" ]] && break
  sleep 3
done
sphere swap status "$SWAP_B"
```

Expected:
- `progress: cancelled`
- `cancelReason: rejected` (or `error: Rejected by user` per the SDK's record shape)

### No balance change check

```bash
# T1
sphere balance | diff -q /tmp/alice-pre-B.txt -    # exit 0 → identical
# T2
sphere balance | diff -q /tmp/bob-pre-B.txt -      # exit 0 → identical
```

**Talk track:** "`swap reject` is acceptor-only by CLI policy — running it on a proposal you SENT exits with a helpful error pointing you at `swap cancel`. The rejection DM is best-effort: even if the network drops it, the local state flip on bob's side is the canonical signal that the proposal is dead. Alice's wallet picks up the rejection over Nostr a few seconds later and mirrors the state."

---

# Scenario C — Proposer rescinds before announce (optional, ~2 min)

The pre-announce branch of `swap cancel` — local-only, no escrow round-trip.

## §10 Alice proposes, then cancels immediately

### T1

```bash
sphere wallet use alice
sphere balance | tee /tmp/alice-pre-C.txt

sphere swap propose \
  --to "@${BOB_TAG}" \
  --offer 1 UCT \
  --want 0.01 ETH \
  --escrow "$ESCROW" \
  --message "Demo: pre-announce cancel" \
  --json
SWAP_C=<paste-from-above>
echo "SWAP_C=$SWAP_C"

# IMMEDIATELY cancel — before bob has a chance to accept.
sphere swap cancel "$SWAP_C" --json
```

Expected:

```text
Swap cancelled:
  {
    "swap_id": "<id>",
    "prev_state": "proposed",
    "new_state": "cancelled",
    "deposits_returned": false
  }
```

`deposits_returned: false` here means "no escrow round-trip happened" — the CLI saw the swap was still at `proposed` and took the pure-local pre-announce branch. No escrow DM was sent.

### Confirm no balance change

```bash
sphere balance | diff -q /tmp/alice-pre-C.txt -    # exit 0
```

**Talk track:** "The state-aware cancel matters because the SDK can't always tell from a single decision point whether deposits exist. The CLI snapshots `progress` at cancel-time and picks the right branch: pre-announce = local-only; post-announce = subscribe to `swap:deposit_returned` and wait. The `deposits_returned: false` in the JSON output is the operator-readable proof that no escrow involvement was needed."

---

## §11 What to do if a section fails live

| Symptom | What it means | Demo recovery |
|---|---|---|
| `swap propose: --escrow <addr>` resolution fails | The escrow nametag doesn't resolve on the relay set. | Use a DIRECT://… form: ask the escrow operator for its direct address. |
| `Escrow ping failed` from `sphere swap ping $ESCROW` (sanity check) | The escrow service is unreachable. | Restart the escrow container or point at a different one via `ESCROW=…`. |
| Proposal never appears in bob's `swap list` after 90s | Either the relay is slow, or alice's wallet exited before the gift-wrap was actually published. | Run `sphere payments sync` on alice's peer to flush. If still empty after another 60s, restart from §3. |
| `swap accept --deposit` errors with "Swap did not reach 'announced' state" | The escrow didn't reply to the announce. Either escrow is down, or its nametag binding doesn't include bob's relay. | Skip `--deposit`, run `sphere swap accept` (no `--deposit`) and check `sphere swap status $SWAP_ID --query-escrow` to query the escrow directly. |
| `swap wait` times out (exit 124) | One of: testnet aggregator is slow, escrow finalization is slow, or your `--timeout` is too tight. | Re-run `sphere swap wait $SWAP_ID --state completed --timeout 600` with a larger budget. |
| `swap wait` exits 1 with terminal state `cancelled` | The escrow returned the deposits — usually because one party's deposit didn't cover the expected amount or arrived after the escrow timeout. | Check `sphere swap status $SWAP_ID --query-escrow` for the escrow's perspective on which leg failed. |
| Both `swap wait` invocations exit 0 but bob's balance shows 0 UCT | The payout invoice was paid but `payments receive --finalize` hasn't run. | Run `sphere payments sync && sphere payments receive --finalize`. The balance should appear within ~10s. |
| `swap reject` exits 1 with "Cannot reject: 'swap reject' is acceptor-only" | You ran it on the proposer side (probably switched terminals by mistake). | Run `sphere swap cancel $SWAP_ID` instead — it's the proposer's analog. |
| `swap cancel` exits 1 with "Cannot cancel: payouts are already in progress" | The swap is already at `concluding` — the escrow is mid-payout and there's no safe way to abort. | Wait for the swap to finish naturally (either `completed` or escrow timeout → `cancelled`). |
| `[Nostr] [AT-LEAST-ONCE] TOKEN_TRANSFER … not durable — leaving 'since' at <ts>` | Background durability verifier couldn't confirm a previous event landed durably on the relay. Independent of the current step. | Continue the demo. |

---

## §12 Cleanup

If you didn't use `KEEP=1`:

```bash
rm -rf "$ROOT"
```

If you used `KEEP=1` and want to inspect post-mortem:

```bash
ls -la "$ROOT/peer-alice/.sphere-cli-alice/" "$ROOT/peer-bob/.sphere-cli-bob/"
```

The wallet directories contain the OrbitDB-backed Profile storage and the swap-record store; re-attach to either wallet later with `sphere wallet use alice` (from `$ROOT/peer-alice`).

---

## §13 Optional — the automated soak

Everything in this playbook is the script [`manual-test-swap-roundtrip.sh`](../manual-test-swap-roundtrip.sh) in the SDK repo:

```bash
cd <sphere-sdk-checkout>
bash manual-test-swap-roundtrip.sh                     # default: Scenario A + B
KEEP=1 bash manual-test-swap-roundtrip.sh              # preserve workspace
SCENARIO=A bash manual-test-swap-roundtrip.sh          # happy-path only
SCENARIO=ABC bash manual-test-swap-roundtrip.sh        # all three scenarios
SWAP_TEST_DIR=/tmp/sw bash manual-test-swap-roundtrip.sh
ESCROW=@my-escrow bash manual-test-swap-roundtrip.sh   # custom escrow
```

A green run prints `ALL GREEN — swap round-trip soak succeeded (<SCENARIO>)` and exits 0.

---

## Presenter cheat sheet

```text
   §0  $ROOT, $ALICE_TAG, $BOB_TAG, $ESCROW, SPHERE_ALLOW_MNEMONIC_NON_TTY=1
   §1  sphere wallet create / use / init --nametag      ×2 wallets
   §2  sphere faucet 100 UCT  (alice)
       sphere faucet 100 ETH  (bob)                     ← asymmetric on purpose

   SCENARIO A — full round-trip
   §3  sphere swap propose --to @bob --offer 50 UCT --want 5 ETH
                            --escrow @escrow-testnet --json
                            → SWAP_ID
   §4  sphere swap list --role acceptor                 ← bob sees the proposal
   §5  sphere swap accept $SWAP_ID --deposit --no-wait  ← bob accepts + deposits
   §6  sphere swap deposit $SWAP_ID                     ← alice deposits
   §7  sphere swap wait $SWAP_ID --state completed      ← BOTH parties block
              --timeout 300 --exit-on-failure
   §8  alice -50 UCT +5 ETH,  bob +50 UCT -5 ETH        ✓

   SCENARIO B — acceptor declines (optional)
   §9  alice proposes 5 UCT for 0.1 ETH
       sphere swap reject $SWAP_B --reason "…"          ← bob rejects (acceptor-only)
       both sides → progress: cancelled
       no balance change

   SCENARIO C — proposer rescinds pre-announce (optional)
   §10 alice proposes 1 UCT for 0.01 ETH
       sphere swap cancel $SWAP_C                       ← alice cancels immediately
       deposits_returned: false (local-only)
       no balance change
```

### Command quick reference

| When you want to… | Run |
|---|---|
| Propose a swap | `sphere swap propose --to @<r> --offer <a> <coin> --want <a> <coin> --escrow @<e>` |
| List inbound proposals | `sphere swap list --role acceptor --progress proposed` |
| Accept + deposit in one shot | `sphere swap accept <id> --deposit` |
| Accept + deposit, return early | `sphere swap accept <id> --deposit --no-wait` |
| Just accept (deposit later) | `sphere swap accept <id>` |
| Reject a proposal (acceptor) | `sphere swap reject <id> [--reason "…"]` |
| Deposit your side | `sphere swap deposit <id>` |
| Cancel your own swap (proposer or pre-concluding acceptor) | `sphere swap cancel <id> [--timeout <s>]` |
| Block until terminal state | `sphere swap wait <id> --state completed [--timeout <s>] [--exit-on-failure]` |
| Show swap detail | `sphere swap status <id>` |
| Live escrow query | `sphere swap status <id> --query-escrow` |
| Ping the escrow for liveness | `sphere swap ping <@escrow-or-direct>` |

### Exit codes that matter

| Command | Exit | Meaning |
|---|---|---|
| `swap reject` | 0 | rejected, both sides → `cancelled` |
| `swap reject` | 1 | not acceptor (use `swap cancel` instead) |
| `swap cancel` | 0 | cancelled (`new_state: cancelled`) |
| `swap cancel` | 1 | refused (already concluding/terminal) |
| `swap wait`   | 0 | reached `--state` or terminal-but-wrong without `--exit-on-failure` |
| `swap wait`   | 1 | terminal-but-wrong with `--exit-on-failure` |
| `swap wait`   | 124 | wall-clock timeout (GNU `timeout` convention) |
