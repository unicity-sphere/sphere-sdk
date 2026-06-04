# Sphere CLI Demo Playbook — Payment Round-Trip

A presenter-friendly run-through of a **4-hop direct-payment round-trip** between two wallets on real testnet. The demo proves three coupled SDK behaviours work end-to-end:

1. **#391** — The duplicate-bundle guard correctly handles tokens that round-trip back to their original sender (alice → bob → alice → bob → alice). Pre-fix, the guard false-positively rejected the legitimate fourth hop with `DUPLICATE_BUNDLE_MEMBERSHIP`.
2. **#394** — The CLI now wires `publishToIpfs` + `cidFetchGateways` in `buildSphereProviders`. The SDK's automated CID-over-Nostr delivery is enabled.
3. **#394b** — The Nostr-safe inline cap is raised to **512 KiB** (today's relays carry up to ~1 MiB). Realistic 3-token chains (~120 KiB) stay inline; CID delivery is reserved for genuinely huge bundles.

This is the companion to the soak script `manual-test-roundtrip-391.sh` — that script asserts the same thing programmatically; this playbook walks the same flow live in front of an audience.

---

## At a glance

```
SETUP             alice (peer3) + bob (peer3), alice faucet'd 100 UCT
HOP 1   alice → bob   10 UCT     bob:   0 → 10        alice: 100 → 90
HOP 2   bob   → alice  2 UCT     bob:  10 → 8         alice:  90 → 92
HOP 3   alice → bob   91 UCT     bob:   8 → 99        alice:  92 →  1
HOP 4   bob   → alice 98.5 UCT   bob:  99 → 0.5       alice:   1 → 99.5
NET                              alice –0.5 UCT       bob +0.5 UCT
```

The bug used to fire at HOP 4 because bob's source set legitimately included a token whose on-chain `tokenId` already appeared in bob's *prior* OUTBOX entry's `tokenIds` (the recipient set of HOP 2). The fix changed the comparison to `sourceTokenIds` (what was actually burned), which is the only field that can express "don't burn the same source twice."

Total run time: ~3 minutes on a healthy testnet (CLI process per hop + Nostr/aggregator round-trips).

---

## §0 Before you start

### Prerequisites

- `sphere` CLI on `PATH` (`which sphere` should resolve).
- Outbound HTTPS to: `faucet.unicity.network`, `goggregator-test.unicity.network`, the Unicity IPFS gateways.
- Outbound WSS to: `wss://nostr-relay.testnet.unicity.network`.
- A clean workspace (the script wipes its own scratch dir on exit unless `KEEP=1`).

### Versions to confirm

```bash
sphere --help | head -3
node --version    # >= 18
```

Confirm the running CLI was built against post-#394 SDK by checking for the publisher wiring in its dist (one-time setup verification — skip if you've already confirmed):

```bash
# Resolve where the CLI's SDK actually lives, then grep for the kill-switch
SDK_DIST="$(readlink -f /usr/local/lib/node_modules/@unicitylabs/sphere-sdk)/dist/impl/nodejs/index.js"
grep -c "createUxfCarPublisher" "$SDK_DIST"        # should be >= 1
grep -c "AUTOMATED_CID_DELIVERY_ENABLED = true"    /usr/local/lib/node_modules/@unicitylabs/sphere-sdk/dist/index.js   # should be 1 (post-#394)
```

### Suggested terminal layout

- **T1** — alice's peer.
- **T2** — bob's peer.
- **T3** — log tail (optional; useful for showing the at-least-once durability warnings if any appear).

### Workspace

```bash
ROOT="/tmp/demo-roundtrip-$$"
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

Expected output excerpt:
```
Wallet initialized successfully!
Identity:
  l1Address:     alpha1q...
  directAddress: DIRECT://0000...
  chainPubkey:   02...
  nametag:       alice-...
```

### Bob — T2

```bash
cd "$ROOT/peer-bob"
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --nametag "$BOB_TAG"
```

---

## §2 Faucet alice — baseline

### T1

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere faucet                       # drops 100 UCT + the other test coins
sphere payments sync
sphere payments receive --finalize
sphere balance
```

Expected — alice's `UCT: 100 (1 token)` along with BTC/ETH/SOL/USDC/USDT/USDU rows.

### T2 (baseline-zero check)

```bash
cd "$ROOT/peer-bob"
sphere wallet use bob
sphere payments sync
sphere payments receive --finalize
sphere balance
```

Expected — no `UCT:` line for bob (or `UCT: 0`).

**Snapshot now.** This is the "before" state. The net deltas in §8 are computed against alice's `UCT: 100` here.

---

## §3 HOP 1 — alice → bob (10 UCT)

### T1

```bash
sphere wallet use alice
sphere payments send "@${BOB_TAG}" 10 UCT
```

Expected:
```
Sending 10 UCT to @bob-...
✓ Transfer successful!
  Transfer ID: ...
  Status: submitted
```

### T2 — bob receives

```bash
sphere wallet use bob
sphere payments sync
sphere payments receive --finalize
sphere balance
```

Expected — `UCT: 10 (1 token)` on bob's side.

### T1 — alice's confirmed balance

```bash
sphere wallet use alice
sphere payments sync
sphere balance
```

Expected — alice's `UCT: 90 (1 token)` (faucet 100 − 10 sent = 90 change).

---

## §4 HOP 2 — bob → alice (2 UCT)

This creates **bob's first OUTBOX entry** whose `tokenIds` recipient set is what HOPs 3 and 4 will later round-trip through.

### T2

```bash
sphere wallet use bob
sphere payments send "@${ALICE_TAG}" 2 UCT
```

### T1 — alice receives

```bash
sphere wallet use alice
sphere payments sync
sphere payments receive --finalize
sphere balance
```

Expected — alice's `UCT: 92 (2 tokens)`. The two tokens are: 90 (change from §3) + 2 (received from bob).

### T2 — bob's confirmed balance

```bash
sphere wallet use bob
sphere payments sync
sphere balance
```

Expected — `UCT: 8 (1 token)` for bob (10 received − 2 sent = 8 change).

### Talking points

- "Bob's OUTBOX entry from this hop has `tokenIds = [<alice's received tokenId>]` and `sourceTokenIds = [<bob's burned 10-UCT source>]`. That entry will stay in bob's local OUTBOX storage as `delivered-instant` for the rest of this demo — short-lived CLI processes don't give the SentReconciliationWorker its 60-second first-scan window to tombstone it."
- "This is the *seed* for #391's false-positive: the alice-side tokenId in that entry's `tokenIds` is about to come back to bob in HOP 3."

---

## §5 HOP 3 — alice → bob (91 UCT)

Alice has 92 UCT in 2 tokens. To send 91, she must include both: whole-transfer the 2-UCT token + split the 90-UCT token (89 to bob's recipient, 1 retained as change).

**This is the moment a tokenId round-trips.** The 2-UCT token alice received from bob in HOP 2 is now whole-token-transferred *back* to bob. Its on-chain `tokenId` is preserved through the whole-transfer.

### T1

```bash
sphere wallet use alice
sphere payments send "@${BOB_TAG}" 91 UCT
```

### T2 — bob receives

```bash
sphere wallet use bob
sphere payments sync
sphere payments receive --finalize
sphere balance
```

Expected — bob's `UCT: 99 (3 tokens)`. The three tokens:
- 8 UCT (change from §4)
- 2 UCT (the round-tripped token; **same on-chain tokenId** as in bob's HOP-2 OUTBOX entry's recipient set)
- 89 UCT (new mint, fresh tokenId)

### T1 — alice's confirmed balance

```bash
sphere wallet use alice
sphere payments sync
sphere balance
```

Expected — `UCT: 1 (1 token)` for alice (92 − 91 = 1).

---

## §6 HOP 4 — bob → alice (98.5 UCT) ← the demo's payoff

Bob has 99 UCT in 3 tokens. To send 98.5 he must include **all three**, including the round-tripped 2-UCT token.

### What pre-fix would happen

The CLI used to throw:
```
Error: dispatchUxfInstantSend: refusing to include token <hex> in this bundle
— it is already referenced by OUTBOX entry <id> (status=delivered-instant).
Set TransferRequest.allowDuplicateBundleMembership=true to bypass this guard
if the re-include is intentional.
```

Reason: bob's HOP-2 OUTBOX entry's `tokenIds` field contained the same hex as one of HOP 4's source candidates. The guard treated that as a double-spend signal — but the token had legitimately come back via HOP 3.

### What post-#391/#394/#394b actually happens

### T2

```bash
sphere wallet use bob
sphere payments send "@${ALICE_TAG}" 98.5 UCT
```

Expected — clean success:
```
Sending 98.5 UCT to @alice-...
✓ Transfer successful!
  Transfer ID: ...
  Status: submitted
```

No `DUPLICATE_BUNDLE_MEMBERSHIP`. No `INLINE_CAR_TOO_LARGE`. Bundle is ~120 KiB — well under the post-#394b 512 KiB inline cap, so it ships as `uxf-car` (inline on Nostr), no IPFS pin needed for this scenario.

### T1 — alice receives

```bash
sphere wallet use alice
sphere payments sync
sphere payments receive --finalize
sphere balance
```

Expected — alice's `UCT: 99.5 (>= 1 token)` (the 1 UCT from §5 change + 98.5 received).

### T2 — bob's confirmed balance

```bash
sphere wallet use bob
sphere payments sync
sphere balance
```

Expected — `UCT: 0.5 (1 token)` for bob (99 − 98.5 = 0.5 change).

---

## §7 Net delta — the math checks out

Expected positions vs. baseline:

| Wallet | Baseline | Final | Net delta |
|---|---|---|---|
| alice | 100 UCT | 99.5 UCT | **−0.5 UCT** |
| bob | 0 UCT | 0.5 UCT | **+0.5 UCT** |

In smallest-unit integers (UCT has 8 decimals; 1 UCT = 10^8 smallest):
- alice: `10_000_000_000 → 9_950_000_000` (Δ = `-50_000_000`)
- bob:   `0 → 50_000_000` (Δ = `+50_000_000`)

Both deltas reconcile to the protocol-predicted ±0.5 UCT. No tokens lost, no fees (testnet), the chain-of-custody held end-to-end.

### Talking points

- "The bundle bob sent in HOP 4 weighs ~120 KiB. Pre-#394b that was *above* the 96 KiB inline ceiling — the SDK would have forced CID-over-Nostr delivery, exposing a separate recipient-side bug (tracked at https://github.com/unicity-sphere/sphere-sdk/issues/396) that silently dropped CID bundles. Post-#394b the bundle fits inline (relay event caps are ~1 MiB today; we conservatively use half), and the round-trip completes without exercising the CID path at all."
- "The chain-of-custody assertion — same on-chain tokenId, three different owners across four hops, all settled correctly — is the load-bearing invariant. The fact that we can name it and verify it end-to-end is the whole point of UXF."

---

## §8 Optional — the automated soak

Everything in this playbook is the script `manual-test-roundtrip-391.sh` in the SDK repo:

```bash
cd <sphere-sdk-checkout>
bash manual-test-roundtrip-391.sh
# or, asserting the bundle stayed inline (no CID delivery) AND alice received:
STRICT_CID_DELIVERY=1 bash manual-test-roundtrip-391.sh
# or, keep the workspace after exit:
KEEP=1 bash manual-test-roundtrip-391.sh
```

A green run prints `ALL GREEN — 4-hop A→B→A→B→A round-trip succeeded; #391 guard + load-tail fix verified` and exits 0.

---

## §9 What to do if a hop fails live

| Symptom | What it means | Demo recovery |
|---|---|---|
| `DUPLICATE_BUNDLE_MEMBERSHIP` at HOP 4 | The SDK doesn't include the #391 fix. Either the SDK build is stale or it was rebuilt from pre-PR #392 code. | Stop the demo, rebuild SDK (`npm run build`), restart. |
| `INLINE_CAR_TOO_LARGE` at HOP 4 | The kill-switch is OFF (`AUTOMATED_CID_DELIVERY_ENABLED = false`) AND the bundle exceeded the inline cap. | Check `limits.ts:AUTOMATED_CID_DELIVERY_ENABLED`. Should be `true` post-#394. |
| `Connectivity gate reports aggregator 'down'` | Testnet aggregator's health probe failed. Send proceeds anyway and usually succeeds — note it in the talk but don't panic. | Continue the demo. |
| `[Nostr] [AT-LEAST-ONCE] TOKEN_TRANSFER … not durable — leaving 'since' at <ts>; cooldown 30000ms` | Background durability verifier couldn't confirm a previous event landed durably on the relay. Independent of the current hop. | Continue the demo. |
| `[Nostr] … exhausted 3 durability replay attempts — advancing cursor` | Same as above, terminal-failure variant. Doesn't affect the current send. | Continue. If many appear at once, the testnet relay is flaky — pause and let it settle. |
| `Insufficient balance for this transaction` at HOP 4 | Bob never received HOP 3's 91 UCT (probably a #390-class V6-RECOVER finalize error). | Run `sphere payments sync && sphere payments receive --finalize` on bob's side and retry. If it persists, check that PR #388 (V6-RECOVER fixes) is merged. |

---

## §10 Cleanup

If you didn't use `KEEP=1`:

```bash
rm -rf "$ROOT"
```

If you used `KEEP=1` and want to inspect post-mortem:

```bash
ls -la "$ROOT/peer-alice/.sphere-cli-alice/" "$ROOT/peer-bob/.sphere-cli-bob/"
```

The wallet directories contain the OrbitDB-backed Profile storage; you can re-attach to either wallet later with `sphere wallet use alice` (from `$ROOT/peer-alice`).

---

## Presenter cheat sheet

```text
   §0  $ROOT, $ALICE_TAG, $BOB_TAG, SPHERE_ALLOW_MNEMONIC_NON_TTY=1
   §1  sphere wallet create / use / init --nametag      ×2 wallets
   §2  sphere faucet  →  alice 100 UCT baseline
   §3  HOP 1   alice → bob   10 UCT     check  bob 10 / alice 90
   §4  HOP 2   bob   → alice  2 UCT     check  alice 92(2) / bob 8
   §5  HOP 3   alice → bob   91 UCT     check  bob 99(3) / alice 1
   §6  HOP 4   bob   → alice 98.5 UCT   check  alice 99.5 / bob 0.5
   §7  Net  alice –0.5 UCT,  bob +0.5 UCT  ←  the punchline
```

## References

- `manual-test-roundtrip-391.sh` — the automated version of this playbook (this is what CI runs).
- PR #392 — #391 fix + #393 kill-switch (merged 2026-06-04).
- PR #395 — #394 SDK changes (publisher export, kill-switch flip, 512 KiB cap raise).
- sphere-cli PR #31 — `buildSphereProviders` publisher wiring.
- Issue #396 — recipient-side CID-fetch silent-drop (deferred follow-up).
