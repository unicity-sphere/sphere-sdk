# Sphere CLI Demo Playbook — Accounting Round-Trip

A presenter-friendly run-through of the **invoice lifecycle** on real testnet — payee-driven payments, partial-pay state transitions, and the one-shot bulk-refund UX. The demo covers two complete scenarios between two wallets:

1. **Scenario A (§1-§7) — Full round-trip.** Bob mints a 7 UCT invoice, alice pays it in one shot, bob confirms the invoice transitions COVERED → CLOSED.
2. **Scenario B (§8-§14) — Partial-pay + bulk-refund + repeat-pay.** Bob mints a second 7 UCT invoice, alice partial-pays 3 UCT, bob refunds the partial with a single `sphere invoice return <id>` call (no flags), alice partial-pays again and covers the rest, bob confirms COVERED.

The load-bearing payoff is **§10** — the one-shot bulk-refund. The SDK already had per-payment refunds; what's new is that a payee can refund every attributed payment on an invoice without typing recipient addresses or amounts. All needed info is in the invoice's status; the CLI reads it.

This is the companion to the soak script [`manual-test-accounting-roundtrip.sh`](../manual-test-accounting-roundtrip.sh) — that script asserts the same thing programmatically; this playbook walks the same flow live in front of an audience.

---

## At a glance

```
SETUP             alice + bob wallets on testnet, both faucet'd (100 UCT each)

SCENARIO A — full round-trip
§3-§4   Bob mints INV1 (7 UCT) and delivers via NIP-17 DM to alice
§5      Alice covers INV1 with `sphere invoice pay`
§6      Bob receives, finalizes, INV1 transitions COVERED → CLOSED
                                  alice 100 → 93,  bob 100 → 107

SCENARIO B — partial-pay + bulk-refund + repeat-pay
§8      Bob mints INV2 (7 UCT) and delivers
§9      Alice partial-pays:   `sphere invoice pay $INV2 --amount 3`
                                  alice 93 → 90,  invoice PARTIAL
§10     Bob refunds (no args): `sphere invoice return $INV2`              ←  the payoff
                                  bob -3 UCT, invoice's returnedAmount tracks the refund
§11     Alice receives the 3 UCT refund
                                  alice 90 → 93
§12     Alice partial-pays:   `sphere invoice pay $INV2 --amount 3`
                                  alice 93 → 90,  invoice PARTIAL
§13     Alice covers the rest: `sphere invoice pay $INV2`
                                  (no --amount → SDK defaults to remaining = 4 UCT)
                                  alice 90 → 86,  invoice COVERED → CLOSED
§14     Bob confirms COVERED + final balance check
                                  alice 100 → 86,  bob 100 → 114
NET                                  alice −14 UCT,  bob +14 UCT
```

Total run time: ~6-8 minutes on a healthy testnet.

---

## §0 Before you start

### Prerequisites

- `sphere` CLI on `PATH` (`which sphere` should resolve).
- Outbound HTTPS to: `faucet.unicity.network`, `goggregator-test.unicity.network`, Unicity IPFS gateways.
- Outbound WSS to: `wss://nostr-relay.testnet.unicity.network`.
- A clean workspace (the script wipes its own scratch dir on exit unless `KEEP=1`).

### Dependency check (one-time setup)

This playbook exercises features added across three coordinated PRs:

| Repo | PR / Branch | What it provides |
|---|---|---|
| sphere-cli | PR #37 (`fix/issue-36-invoice-pay-human-units`) | `--amount` interprets as HUMAN units (matches `payments send`). Pre-PR-#37 the CLI treats `--amount 3` as 3 atoms (≈3×10⁻¹⁸ UCT) and §9 fails the balance assertion. |
| sphere-cli | `feat/invoice-return-bulk-and-nametag` | `sphere invoice return <id>` (no flags) → calls SDK bulk-refund. Without this PR §10's one-shot form fails with "missing --recipient". |
| sphere-sdk | PR #405 (`feat/accounting-return-all-invoice-payments`) | `AccountingModule.returnAllInvoicePayments` — the bulk-refund SDK primitive the CLI wrapper calls. Without this PR the CLI wrapper compiles but the SDK method doesn't exist. |
| sphere-sdk | PR #413 (`fix/issue-404-masked-refund-attribution`) | Masked-predicate refund attribution recovery. Without this PR, §10's refund is correctly emitted at the token level but the SDK's invoice ledger doesn't see it — so §13's bare `sphere invoice pay $INV2` (default `--amount`) under-pays (sends 1 UCT instead of 4). |

Confirm the running CLI binary includes all three:

```bash
sphere invoice return --help | grep -c "refund every sender" # should be 1 (post-bulk-return CLI)
sphere invoice pay --help    | grep -c "HUMAN units"          # should be 1 (post-PR #37)

# Resolve where the CLI's SDK actually lives:
SDK_DIST="$(readlink -f /usr/local/lib/node_modules/@unicitylabs/sphere-sdk)/dist/index.js"
grep -c "returnAllInvoicePayments" "$SDK_DIST"                # should be >= 1 (post-PR #405)
grep -c "forwardSendersByTargetCoin" "$SDK_DIST"              # should be >= 1 (post-PR #413)
```

If any of those return `0`, the binary on PATH is behind one of the PRs — rebuild before demoing.

### Versions to confirm

```bash
sphere --help | head -3
node --version    # >= 18
```

### Suggested terminal layout

- **T1** — alice's peer.
- **T2** — bob's peer.
- **T3** — log tail (optional; useful for showing Nostr durability warnings if any appear).

### Workspace

```bash
ROOT="/tmp/demo-accounting-$$"
mkdir -p "$ROOT/peer-alice" "$ROOT/peer-bob"
SUFFIX="$(date +%s | tail -c 5)$(printf '%04x' $((RANDOM % 65536)))"
ALICE_TAG="alice-$SUFFIX"
BOB_TAG="bob-$SUFFIX"
echo "ALICE_TAG=$ALICE_TAG"
echo "BOB_TAG=$BOB_TAG"

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

**Talk track:** "Both wallets are minted on real testnet — alice and bob each have an on-chain nametag. Anything Bob mints later is owned by his chain pubkey; the invoice will cryptographically bind to *Bob* as payee."

---

## §2 Faucet both wallets — baseline

### T1 — alice

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere faucet                       # drops 100 UCT + the other test coins
sphere payments sync
sphere payments receive --finalize
sphere balance
```

### T2 — bob

```bash
cd "$ROOT/peer-bob"
sphere wallet use bob
sphere faucet
sphere payments sync
sphere payments receive --finalize
sphere balance
```

Expected — both wallets show `UCT: 100 (1 token)` along with the other test coins.

**Snapshot now.** This is the "before" state. Every net-delta assertion in §7 and §14 is computed against `UCT: 100` per side.

---

# Scenario A — Full round-trip

## §3 Bob mints an invoice for 7 UCT

### T2

```bash
sphere wallet use bob
sphere invoice create --target "@${BOB_TAG}" --asset 7 UCT --memo "Demo invoice — 7 UCT"
```

Expected output excerpt:
```
Invoice created:
  invoiceId: 0000... (64 hex chars)
  ...
INV=0000...
```

Capture the ID into a variable for the rest of the demo:

```bash
INV=$(sphere invoice list --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[-1]['invoiceId'])")
echo "INV=$INV"
```

**Talk track:** "Bob is the *payee*. He's declared: 'I expect to receive 7 UCT at this address.' The invoice is itself a token minted on-chain — its terms are cryptographically committed. Nobody can later argue what was owed."

---

## §4 Bob delivers the invoice to alice

### T2

```bash
sphere invoice deliver "$INV" --to "@${ALICE_TAG}"
```

Expected:
```
{ "sent": 1, "failed": 0 }
```

The invoice ships as a NIP-17-encrypted DM. Alice's wallet auto-imports it.

### T1 — alice sees the new invoice

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere payments sync
sphere invoice list           # may take a few seconds to appear
```

Expected — alice's list now shows the invoice with `state: OPEN`.

---

## §5 Alice covers the invoice in one shot

### T1

```bash
sphere invoice pay "$INV"
```

No `--amount` → the SDK defaults to "remaining needed to cover the asset" = 7 UCT.

Expected:
```
Payment result:
  id     : ...
  status : submitted
```

### T1 — alice's confirmed balance after pay

```bash
sphere payments sync
sphere balance
```

Expected — alice's `UCT: 93 (1 token)`.

---

## §6 Bob receives + verifies COVERED

### T2

```bash
sphere wallet use bob
sphere payments sync
sphere payments receive --finalize
sphere balance
sphere invoice status "$INV"
```

Expected:
- bob's `UCT: 107 (1 token)` (100 + 7 = 107).
- invoice status: `state: COVERED` or `state: CLOSED` (the implicit close gate auto-terminates on COVERED+allConfirmed; both are correct).

---

## §7 Scenario A net delta — the math checks out

| Wallet | Baseline | After §6 | Δ |
|---|---|---|---|
| alice | 100 UCT | 93 UCT | **−7 UCT** |
| bob | 100 UCT | 107 UCT | **+7 UCT** |

**Talk track:** "Invoice received, paid, attributed, sealed. The invoice's job is done; its state is now frozen. The payee and payer have a cryptographic receipt of what was owed and what was paid."

---

# Scenario B — Partial-pay + bulk-refund + repeat-pay

The first invoice is COVERED/CLOSED — terminal state, can't be re-paid (`payInvoice` on CLOSED throws `INVOICE_TERMINATED`). For the partial-pay scenario we mint a **fresh** invoice so the state machine has somewhere to flow (OPEN → PARTIAL → OPEN after refund → PARTIAL → COVERED).

## §8 Bob mints a second invoice (INV2)

### T2

```bash
sphere wallet use bob
sphere invoice create --target "@${BOB_TAG}" --asset 7 UCT --memo "Demo invoice #2 — partial-pay"

# Capture the new ID — it's the most recent in the list.
INV2=$(sphere invoice list --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[-1]['invoiceId'])")
echo "INV2=$INV2"

sphere invoice deliver "$INV2" --to "@${ALICE_TAG}"
```

### T1 — alice sees INV2

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere payments sync
sphere invoice list   # INV2 should appear as OPEN, may take ~3-10s
```

---

## §9 Alice partial-pays — 3 UCT (explicit `--amount`)

### T1

```bash
sphere invoice pay "$INV2" --amount 3
```

The `--amount 3` is in **human units** of the invoice's coin (PR #37). The SDK converts to 3×10¹⁸ smallest units and sends.

```bash
sphere payments sync
sphere balance
```

Expected — alice's `UCT: 90 (1 token)` (93 − 3 = 90).

**Talk track:** "Alice is paying less than the full invoice amount. The invoice now goes from OPEN to PARTIAL — bob's receipt-side still expects 4 more UCT to reach COVERED."

---

## §10 Bob refunds alice — one CLI call, no flags ← the demo's payoff

### What used to be required (pre-PRs)

The user had to manually:
1. Dump invoice status as JSON.
2. Read each `senderBalances[].senderAddress` (a per-send masked-predicate DIRECT://… that the user could NOT guess from alice's wallet identity).
3. Read each `netBalance`.
4. Convert smallest units → human units.
5. Run `sphere invoice return $INV2 --recipient <addr> --asset <human-amount> <coin>` for each row.

For one sender on one coin that's already 5 manual steps. For an invoice with multiple senders or coins, it's worse — and the per-send masked-predicate addresses are the only data the SDK accepts; the user's natural identity references (`@alice`) don't work.

### What it is now

### T2 — bob refunds with ONE call

```bash
sphere wallet use bob
sphere invoice return "$INV2"
```

That's it. No `--recipient`, no `--asset`. The SDK reads the invoice's `senderBalances`, iterates, and refunds every attributed payment to its recorded sender.

Expected:
```
Return payment results:
  1 refund(s) submitted:
  [0] 3 UCT → DIRECT://0000...
       id     : <transferId>
       status : submitted
```

### T2 — bob's confirmed balance after refund

```bash
sphere payments sync
sphere balance
```

Expected — bob's `UCT: 104 (1 or more tokens)` (107 − 3 = 104).

**Talk track:** "This is the new bulk-refund UX. One short command — no addresses to type, no amounts to look up. The CLI reads the invoice's per-sender balance breakdown straight from the SDK's `getInvoiceStatus` and refunds each non-zero row. Particularly important for **masked-predicate sends** (the privacy default) where the on-chain sender address is a one-time DIRECT://… the user cannot guess from their wallet's identity."

---

## §11 Alice receives the 3 UCT refund

### T1

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere payments sync
sphere payments receive --finalize
sphere balance
```

Expected — alice's `UCT: 93 (>=1 token)` (90 + 3 = 93).

**Talk track:** "The refund is a real on-chain back-direction transfer. Bob's wallet sent 3 UCT to the address recorded in alice's original payment. The :B memo direction tells AccountingModule to attribute it as a refund — and after PR #413, masked-predicate refunds are correctly attributed back to the invoice via the destinationAddress fallback in `computeInvoiceStatus`. The invoice's `returnedAmount` updates and `netCovered` drops correctly."

---

## §12 Alice partial-pays again — 3 UCT (explicit `--amount`)

The refund dropped INV2's netCovered back toward 0; the invoice is payable again. Alice partial-pays once more:

### T1

```bash
sphere invoice pay "$INV2" --amount 3
sphere payments sync
sphere balance
```

Expected — alice's `UCT: 90 (1 token)` (93 − 3 = 90).

---

## §13 Alice covers the rest (default `--amount`)

### T1

```bash
sphere invoice pay "$INV2"
sphere payments sync
sphere balance
```

No `--amount` → the SDK reads the invoice's current state, computes `remaining = requested − netCovered = 7 − 3 = 4 UCT`, and sends that. Expected — alice's `UCT: 86 (1 token)` (90 − 4 = 86).

**Talk track:** "Default `--amount` works correctly post-PR #413: the SDK sees the refund recorded in §10 (netCovered correctly drops from 6 to 3 after the refund is attributed), so 'remaining' computes to the right value. Operators don't have to manually track what's been refunded."

---

## §14 Bob confirms COVERED + Scenario B net delta

### T2

```bash
sphere wallet use bob
sphere payments sync
sphere payments receive --finalize
sphere balance
sphere invoice status "$INV2"
```

Expected:
- bob's `UCT: 114 (multiple tokens)` (104 + 3 + 4 = 111; with §9's earlier 3 = 114).
- INV2 status: `state: COVERED` (or `CLOSED` if auto-close fired).

### Scenario B net flow (alone)

| Wallet | After §7 | After §14 | Δ in Scenario B |
|---|---|---|---|
| alice | 93 UCT | 86 UCT | **−7 UCT** |
| bob | 107 UCT | 114 UCT | **+7 UCT** |

### Full scenario net flow (Scenario A + B combined)

| Wallet | Baseline (§2) | Final (§14) | Total Δ |
|---|---|---|---|
| alice | 100 UCT | 86 UCT | **−14 UCT** |
| bob | 100 UCT | 114 UCT | **+14 UCT** |

In smallest-unit integers (UCT has 18 decimals):
- alice: `100·10¹⁸ → 86·10¹⁸` (Δ = `−14·10¹⁸`)
- bob:   `100·10¹⁸ → 114·10¹⁸` (Δ = `+14·10¹⁸`)

Both reconcile. The 3 UCT that flowed bob→alice in §10 is real, on-chain, and accounted for at every level — token-level balances AND the invoice's internal ledger (per PR #413's attribution-recovery fix).

---

## §15 Optional — the automated soak

Everything in this playbook is the script `manual-test-accounting-roundtrip.sh` in the SDK repo:

```bash
cd <sphere-sdk-checkout>
bash manual-test-accounting-roundtrip.sh
# or, keep the workspace after exit:
KEEP=1 bash manual-test-accounting-roundtrip.sh
# or, point at a specific workspace:
ACCOUNTING_TEST_DIR=/tmp/acc bash manual-test-accounting-roundtrip.sh
```

A green run prints `ALL GREEN — round-trip + partial-pay + bulk-return + repeat-pay scenario succeeded` and exits 0.

---

## §16 What to do if a section fails live

| Symptom | What it means | Demo recovery |
|---|---|---|
| `Error: --asset expects two positional tokens` at §3/§8 | The CLI is older than PR #33 (canonical UX). Quoted `--asset "7 UCT"` form was dropped in favor of two-arg form. | Confirm sphere-cli is at the canonical-UX tip; rebuild. |
| `Payment result: status: submitted` then alice's balance doesn't drop by 3 in §9 | The CLI is older than PR #37 — `--amount 3` is being treated as 3 atoms (≈3×10⁻¹⁸ UCT). | Confirm sphere-cli has PR #37 merged or branch checked out; rebuild. |
| `Error: --recipient <address> is required` at §10 | The CLI is older than the bulk-return wrapper (`feat/invoice-return-bulk-and-nametag`). | Confirm sphere-cli branch + rebuild. |
| `Error: 'returnAllInvoicePayments' is not a function` at §10 | The SDK is older than PR #405. | Confirm sphere-sdk has PR #405 merged or branch checked out; rebuild. |
| `INVOICE_TERMINATED` at §9 or §12 | The invoice was auto-closed before the pay attempt (probably because `invoice status` was called on a COVERED invoice and the implicit close gate fired). For §9 this shouldn't happen on a brand-new invoice; for §12 it would indicate the refund somehow drove the invoice to terminal. | If at §9: re-mint INV2. If at §12: the SDK lifecycle is more aggressive than expected — note it in the talk and skip the second scenario. |
| `Connectivity gate reports aggregator 'down'` | Testnet aggregator's health probe failed. Send proceeds anyway and usually succeeds — note it in the talk but don't panic. | Continue the demo. |
| `[Nostr] [AT-LEAST-ONCE] TOKEN_TRANSFER … not durable — leaving 'since' at <ts>; cooldown 30000ms` | Background durability verifier couldn't confirm a previous event landed durably on the relay. Independent of the current step. | Continue the demo. |
| Alice's balance lags after refund in §11 | The back-direction transfer hasn't fully propagated yet — Nostr fan-out + IPFS pin can take 10-30s on a slow testnet. | Retry `sphere payments sync && sphere payments receive --finalize` once or twice before failing. |
| §13 default `--amount` sends 1 UCT instead of 4 | The SDK build predates PR #413 (masked-predicate refund attribution). The refund in §10 isn't being attributed back to the invoice, so the SDK overestimates netCovered. | Bump SDK to post-#413, OR fall back to explicit `--amount 4` for the duration of the demo. |
| Invoice state stays at PARTIAL after §13 | Either the demo is running with the legacy default-amount under-pay (above row), or `coveredAmount` is incorrect for a different reason. | Inspect `sphere invoice status $INV2 --json` — `coveredAmount` should equal 7 UCT and `netCovered` should equal 7 UCT after §13. |

---

## §17 Cleanup

If you didn't use `KEEP=1`:

```bash
rm -rf "$ROOT"
```

If you used `KEEP=1` and want to inspect post-mortem:

```bash
ls -la "$ROOT/peer-alice/.sphere-cli-alice/" "$ROOT/peer-bob/.sphere-cli-bob/"
```

The wallet directories contain the OrbitDB-backed Profile storage; re-attach to either wallet later with `sphere wallet use alice` (from `$ROOT/peer-alice`).

---

## Presenter cheat sheet

```text
   §0  $ROOT, $ALICE_TAG, $BOB_TAG, SPHERE_ALLOW_MNEMONIC_NON_TTY=1
   §1  sphere wallet create / use / init --nametag      ×2 wallets
   §2  sphere faucet  →  both 100 UCT baseline

   SCENARIO A — full round-trip
   §3  sphere invoice create --target @bob --asset 7 UCT   ← bob mints INV1
   §4  sphere invoice deliver $INV --to @alice              ← NIP-17 DM
   §5  sphere invoice pay $INV                              ← alice covers full
   §6  bob checks invoice status → COVERED/CLOSED
   §7  alice -7, bob +7   ✓

   SCENARIO B — partial-pay + bulk-refund + repeat-pay
   §8  bob mints INV2, delivers
   §9  sphere invoice pay $INV2 --amount 3        ← alice partial-pay
   §10 sphere invoice return $INV2                ← bob refunds (NO FLAGS) ← payoff
   §11 alice receives the refund
   §12 sphere invoice pay $INV2 --amount 3        ← alice partial-pay again
   §13 sphere invoice pay $INV2                   ← alice covers rest (default --amount)
   §14 bob confirms COVERED
   NET (over A+B):  alice -14, bob +14   ✓
```

---

## References

- `manual-test-accounting-roundtrip.sh` — the automated version of this playbook.
- sphere-sdk PR #405 — `AccountingModule.returnAllInvoicePayments`.
- sphere-sdk PR #413 — masked-predicate refund attribution fix (closes #404). Enables §13's default-`--amount` form.
- sphere-cli PR #37 (`fix/issue-36-invoice-pay-human-units`) — `invoice pay --amount` human units.
- sphere-cli branch `feat/invoice-return-bulk-and-nametag` — `sphere invoice return <id>` (no flags) and `--recipient @nametag` resolution.
- [`DEMO-PLAYBOOK-PAYMENT-ROUNDTRIP.md`](DEMO-PLAYBOOK-PAYMENT-ROUNDTRIP.md) — companion demo for the direct-payment round-trip (#391 guard).
- [`DEMO-PLAYBOOK.md`](DEMO-PLAYBOOK.md) — the umbrella demo (full-recovery + multi-device).
