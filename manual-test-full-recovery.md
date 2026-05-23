# Manual CLI test — full two-peer + daemon + bidirectional invoice + IPFS-only recovery

End-to-end smoke test for the multi-instance scenarios that the existing
`manual-test-drain-fix.md` does not exercise: a **second profile instance
per wallet** with the same mnemonic but a distinct `DATA_DIR`, long-running
**daemons** picking up live updates, **bidirectional invoices** verified
without manual sync, and **IPFS-only recovery** of both wallets on both
peers from mnemonics alone.

This is the companion to `manual-test-drain-fix.md`. Re-read §0 of that
document first — the CLI prerequisites, profile-mode defaults, and "save
the mnemonic" gates apply unchanged here.

> **Companion docs:**
> - `manual-test-drain-fix.md` — single-peer sync + IPFS recovery (drain fix)
> - This doc                   — two peers + daemon + invoices + IPFS-only recovery

---

## 0. Layout: three CWDs

This test uses three working directories under `~/sphere-full-test/`:

```
~/sphere-full-test/
├── peer1/         ← primary instance; both alice + bob via profile switching
│   ├── .sphere-cli/                ← profile registry (CWD-relative)
│   ├── .sphere-cli-alice/          ← alice's OrbitDB + tokens (peer1 view)
│   └── .sphere-cli-bob/            ← bob's   OrbitDB + tokens (peer1 view)
├── peer2-alice/   ← secondary instance of alice (own daemon)
│   ├── .sphere-cli/
│   └── .sphere-cli-alice/          ← alice's OrbitDB + tokens (peer2 view)
└── peer2-bob/     ← secondary instance of bob   (own daemon)
    ├── .sphere-cli/
    └── .sphere-cli-bob/            ← bob's   OrbitDB + tokens (peer2 view)
```

**Why three dirs?** The CLI reads `./.sphere-cli/config.json` from the
current working directory, and the daemon writes its PID/log to
`./.sphere-cli/daemon.{pid,log}` — also CWD-relative, not profile-scoped.
Running two daemons (one per identity) from the same CWD collides on PID
and config. Per-peer-wallet CWDs sidesteps the collision without needing
`--pid` / `--log` overrides.

Peer1 keeps the drain-fix layout (both profiles in one CWD via
`sphere wallet use`) because peer1 doesn't run daemons.

---

## 1. Peer1 setup — two wallets + faucet (same as drain-fix §1–§2)

```bash
mkdir -p ~/sphere-full-test/peer1 && cd ~/sphere-full-test/peer1

# Unique suffixes — testnet keeps minted nametags forever.
SUFFIX=$(date +%s)
ALICE_TAG=alice-full-$SUFFIX
BOB_TAG=bob-full-$SUFFIX

sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --nametag $ALICE_TAG
# ⚠️  Save the mnemonic — needed for peer2 init and §D recovery.
ALICE_MNEMONIC="<paste alice's mnemonic here>"
sphere status                              # Nametag: line MUST appear

sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --nametag $BOB_TAG
BOB_MNEMONIC="<paste bob's mnemonic here>"
sphere status                              # Nametag: line MUST appear

# Top up alice (faucet drops several coins)
sphere wallet use alice
sphere faucet
sphere payments sync                       # drains pending v5 + publishes CAR
sphere balance                             # should reflect faucet
```

If either `sphere status` doesn't show a `Nametag:` line, the on-chain mint
failed silently — fix per drain-fix §1's gotcha block before proceeding.

---

## §A. Peer2 setup — same identity, separate `DATA_DIR`

**Goal:** verify per-instance OrbitDB / IPFS sync works across distinct
`DATA_DIR`s for the same identity (same mnemonic). Peer2 must reconstruct
peer1's token set from IPFS only, with no faucet input.

### A.1 Alice on peer2-alice

```bash
mkdir -p ~/sphere-full-test/peer2-alice && cd ~/sphere-full-test/peer2-alice

sphere wallet create alice
sphere wallet use alice

# Same mnemonic → same secp256k1 identity → same L1/L3/transport addresses.
# A fresh DATA_DIR (./.sphere-cli-alice/) means peer2 starts with an empty
# OrbitDB; sync() must pull peer1's state from IPFS.
sphere init --network testnet --mnemonic "$ALICE_MNEMONIC"
sphere status                              # L1 address MUST match peer1

# Pull peer1's published state. Auto-sync runs at init; force one more
# and finalize any unconfirmed v5 tokens delivered via Nostr.
sphere payments sync
sphere payments receive --finalize
sphere balance > /tmp/alice-peer2-initial.txt

# What you're looking for: balance matches peer1's alice balance from §1.
sphere wallet use alice                    # (stay on alice for §B)
```

**Assertion gate.** Compare:

```bash
( cd ~/sphere-full-test/peer1 && sphere wallet use alice && sphere balance ) \
  > /tmp/alice-peer1-initial.txt
diff /tmp/alice-peer1-initial.txt /tmp/alice-peer2-initial.txt
# Empty diff = per-instance IPFS sync works for the same identity.
```

### A.2 Bob on peer2-bob

```bash
mkdir -p ~/sphere-full-test/peer2-bob && cd ~/sphere-full-test/peer2-bob

sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --mnemonic "$BOB_MNEMONIC"
sphere status                              # L1 address MUST match peer1's bob

sphere payments sync
sphere payments receive --finalize
sphere balance > /tmp/bob-peer2-initial.txt

# Peer1 bob received nothing yet (faucet only hit alice), so this is
# typically empty — that's fine. The point is the sync didn't error.
```

---

## §B. Long-running daemons on peer2

**Goal:** start a foreground listener for each peer2 wallet that picks up
live updates (`transfer:incoming`, profile sync) while peer1 is active.

The daemon's quick-mode syntax is:

```
sphere daemon start --event <event> --action <spec> [--event ... --action ...] [--verbose]
```

Each `--event` subscribes to a Sphere event type; `--action auto-receive`
auto-finalizes incoming transfers; `log:<path>` appends a JSON line per
event. Multiple `--action` flags on a single rule all fire for every
subscribed event.

### B.1 Start alice's peer2 daemon (terminal 1, leave running)

```bash
cd ~/sphere-full-test/peer2-alice
sphere wallet use alice

# Foreground daemon. Ctrl-C to stop after §C/§D.
# - auto-receive finalizes incoming v5 tokens automatically
# - log:./events.log records every event as a JSON line for inspection
sphere daemon start \
  --event 'transfer:incoming' --action auto-receive \
  --event 'transfer:incoming' --action 'log:./events.log' \
  --event 'transfer:confirmed' --action 'log:./events.log' \
  --event 'invoice:payment'    --action 'log:./events.log' \
  --event 'invoice:covered'    --action 'log:./events.log' \
  --verbose
```

You should see:
```
Starting Sphere daemon...
Active rules: 1
Subscribed events: transfer:incoming, transfer:confirmed, invoice:payment, invoice:covered
Wallet: @alice-full-...
Daemon running. Waiting for events...
```

### B.2 Start bob's peer2 daemon (terminal 2, leave running)

```bash
cd ~/sphere-full-test/peer2-bob
sphere wallet use bob

sphere daemon start \
  --event 'transfer:incoming' --action auto-receive \
  --event 'transfer:incoming' --action 'log:./events.log' \
  --event 'transfer:confirmed' --action 'log:./events.log' \
  --event 'invoice:payment'    --action 'log:./events.log' \
  --event 'invoice:covered'    --action 'log:./events.log' \
  --verbose
```

> **Gotcha — two daemons in one CWD will collide.** Both default to
> `./.sphere-cli/daemon.pid`. The per-wallet CWD layout above avoids the
> collision. If you must share a CWD, pass `--pid ./alice.pid --log
> ./alice.log` to one and matching paths to the other.

### B.3 Detach mode (optional)

Add `--detach` to fork into the background. Logs go to
`./.sphere-cli/daemon.log` (or your `--log`). Stop with:

```bash
sphere daemon stop
sphere daemon status        # → "Daemon not running" once stopped
```

This walkthrough uses foreground daemons so you can watch events arrive.

---

## §C. Bidirectional invoice flow — verify peer2 sees state without manual sync

**Goal:** with peer2 daemons running, drive an invoice round-trip on peer1
and confirm peer2 reflects the new state with no manual `sync` call.

### C.1 Alice creates a 11 UCT invoice (Bob is the payer; on peer1)

`--target` names the RECEIVER of funds — alice, since she's asking Bob
to pay her. The payer (bob) is supplied to `invoice deliver` in §C.1b
below, not to `invoice create`.

```bash
cd ~/sphere-full-test/peer1
sphere wallet use alice
sphere invoice create --target @$ALICE_TAG --asset "11000000 UCT" --memo "Full-recovery test invoice"
# Capture the invoiceId from the JSON output.
INV=<paste invoiceId>
```

### C.1b Alice delivers the invoice to Bob (#226)

`sphere invoice create` does not auto-deliver. Delivery is a separate,
explicit step that packages the invoice into a UXF bundle and ships it
via NIP-17 DM. The invoice's only target is alice herself (self), so
pass `--to @$BOB_TAG` to explicitly route the invoice DM to Bob.
Without this step, Bob's wallet has no path to discover the invoice —
`payments sync` / `payments receive` don't pull invoices addressed to
him.

```bash
sphere invoice deliver $INV --to @$BOB_TAG
# Per-recipient outcome is printed as JSON. Successful delivery shows
# { sent: 1, failed: 0, recipients: [{ ..., success: true, shape: "inline" }] }.
```

### C.2 Bob pays (on peer1)

```bash
sphere wallet use bob
# Give Bob's relay subscription a beat to ingest the invoice_delivery: DM.
sleep 5
sphere payments sync
sphere invoice pay $INV
sphere payments sync
```

### C.3 Watch the peer2 daemons (terminals 1 & 2)

Within a few seconds **peer2-alice** (alice's second device) should
see the following lines — alice's transport pubkey is the kind:31113
Nostr event's `#p` tag, so her subscription receives it:

```
[<ISO timestamp>] EVENT transfer:incoming data={"senderPubkey":"...","tokens":[...],...}
[<ISO timestamp>] EVENT invoice:payment   data={"invoiceId":"<id>",...}
[<ISO timestamp>] EVENT invoice:covered   data={"invoiceId":"<id>"}
```

**peer2-bob** will NOT see Nostr `transfer:*` events for this scenario
— the kind:31113 event's `#p` tag is alice's pubkey (she's the
recipient), not bob's. Bob's second device updates via IPFS
Profile-pointer sync; the §C.4 balance check below verifies that path.

`./events.log` in each peer2 CWD records the same events as one JSON line
per dispatch.

### C.4 Assert peer2 sees the payment without manual `sphere payments sync`

```bash
# Alice's peer2 view — invoice should be COVERED, balance reflects payment
cd ~/sphere-full-test/peer2-alice
sphere invoice status $INV                 # State: COVERED
sphere balance                             # +11 UCT vs §A.1's initial snapshot

# Bob's peer2 view — balance reflects the 11 UCT he sent (decreased)
cd ~/sphere-full-test/peer2-bob
sphere balance                             # tokens consumed by invoice-pay
```

If peer2's `sphere balance` reflects the payment **before** you've run
`sphere payments sync` on peer2, the daemon's auto-receive worked.

### C.5 (Optional) Send a small L3 transfer in the other direction

```bash
cd ~/sphere-full-test/peer1
sphere wallet use bob
sphere payments send @$ALICE_TAG 1 UCT     # 1 UCT bob → alice
sphere payments sync
# Peer2 daemons should log a fresh transfer:incoming / transfer:confirmed pair.
```

---

## §D. Wipe-and-recover BOTH profiles from IPFS only

**Goal:** clear both wallets on both peers, re-init from mnemonics alone
(no faucet, no live Nostr — `--no-nostr` disables the transport so IPFS is
the only data source), and prove the published state survived.

### D.1 Snapshot pre-clear state on peer1

```bash
cd ~/sphere-full-test/peer1

sphere wallet use alice
sphere payments sync                       # ensure latest CAR is on IPFS
sphere balance        > /tmp/alice-before.txt
sphere payments tokens > /tmp/alice-tokens-before.txt
sphere invoice list --state COVERED > /tmp/alice-invoices-before.txt

sphere wallet use bob
sphere payments sync
sphere balance        > /tmp/bob-before.txt
sphere payments tokens > /tmp/bob-tokens-before.txt
sphere invoice list --state COVERED > /tmp/bob-invoices-before.txt
```

### D.2 Stop the peer2 daemons

In terminals 1 and 2 (where the daemons are running), press Ctrl-C. You
should see:
```
Shutting down daemon...
Daemon stopped.
```

### D.3 Wipe every wallet on every peer

```bash
# Peer1 — both wallets
cd ~/sphere-full-test/peer1
sphere wallet use alice && sphere clear    # respond at the prompt
sphere wallet use bob   && sphere clear

# Peer2-alice
cd ~/sphere-full-test/peer2-alice
sphere wallet use alice && sphere clear

# Peer2-bob
cd ~/sphere-full-test/peer2-bob
sphere wallet use bob   && sphere clear
```

Verify each:
```bash
sphere status                              # should refuse — no wallet
```

### D.4 Recover with mnemonics, IPFS only (no Nostr, no faucet)

`--no-nostr` installs a no-op transport. The wallet loads identity from
mnemonic, then `sphere payments sync` pulls token state from IPFS. If a
peer's balance comes back complete after this, the published CAR was
complete and IPFS-only recovery works.

```bash
# Peer1 alice
cd ~/sphere-full-test/peer1
sphere wallet use alice
sphere init --network testnet --no-nostr --mnemonic "$ALICE_MNEMONIC"
sphere payments sync
sphere payments receive --finalize         # safe even with no-op transport
sphere balance        > /tmp/alice-after.txt
sphere payments tokens > /tmp/alice-tokens-after.txt
sphere invoice list --state COVERED > /tmp/alice-invoices-after.txt

# Peer1 bob
sphere wallet use bob
sphere init --network testnet --no-nostr --mnemonic "$BOB_MNEMONIC"
sphere payments sync
sphere payments receive --finalize
sphere balance        > /tmp/bob-after.txt
sphere payments tokens > /tmp/bob-tokens-after.txt
sphere invoice list --state COVERED > /tmp/bob-invoices-after.txt

# Peer2-alice
cd ~/sphere-full-test/peer2-alice
sphere wallet use alice
sphere init --network testnet --no-nostr --mnemonic "$ALICE_MNEMONIC"
sphere payments sync
sphere balance        > /tmp/alice-peer2-after.txt

# Peer2-bob
cd ~/sphere-full-test/peer2-bob
sphere wallet use bob
sphere init --network testnet --no-nostr --mnemonic "$BOB_MNEMONIC"
sphere payments sync
sphere balance        > /tmp/bob-peer2-after.txt
```

### D.5 ASSERT — pre-clear vs post-recovery diffs must all be empty

```bash
# Peer1
diff /tmp/alice-before.txt        /tmp/alice-after.txt
diff /tmp/alice-tokens-before.txt /tmp/alice-tokens-after.txt
diff /tmp/bob-before.txt          /tmp/bob-after.txt
diff /tmp/bob-tokens-before.txt   /tmp/bob-tokens-after.txt

# Peer2 — recovered from IPFS alone, no Nostr, no faucet
diff /tmp/alice-before.txt /tmp/alice-peer2-after.txt
diff /tmp/bob-before.txt   /tmp/bob-peer2-after.txt
```

**All four diffs empty = the CAR published in §C.2 (and the §C.5 sync, if
you ran it) was complete on IPFS.** Any missing UCT/USDC/USDU = a partial
CAR shipped at some sync step.

---

## §E. Recovery preserves the invoice ledger

**Goal:** verify the COVERED §C invoice round-trips through the wipe.
`invoice list` reads from the recovered profile's local OrbitDB store,
which was rebuilt from IPFS in §D.4.

```bash
# Each diff should be empty.
diff /tmp/alice-invoices-before.txt \
     <(cd ~/sphere-full-test/peer1 && sphere wallet use alice && sphere invoice list --state COVERED)
diff /tmp/bob-invoices-before.txt \
     <(cd ~/sphere-full-test/peer1 && sphere wallet use bob   && sphere invoice list --state COVERED)

# Spot-check the §C invoice on the recovered alice profile:
cd ~/sphere-full-test/peer1
sphere wallet use alice
sphere invoice status $INV                 # State: COVERED, same target + memo
```

If both diffs are empty and `invoice status $INV` reports `COVERED` with
the same target and "Full-recovery test invoice" memo, the invoice ledger
survived a full wipe + IPFS-only recovery.

---

## What you're looking for (summary)

| Section | Assertion |
|---|---|
| §A.1 | Peer2-alice's initial balance matches peer1 alice's balance after `init --mnemonic + sync` (no faucet on peer2) |
| §B   | `Daemon running. Waiting for events...` line for each peer2 wallet, with no PID-collision error |
| §C.4 | Peer2 balance reflects the §C payment **without** a manual `sphere payments sync` (auto-receive did it) |
| §D.5 | All four `diff` outputs empty: pre-clear ≡ post-recovery, on both peers |
| §E   | Pre-clear invoice list ≡ post-recovery invoice list, `--no-nostr` recovery preserved the §C COVERED invoice |

---

## Three gotchas

1. **Two daemons in one CWD collide on `./.sphere-cli/daemon.pid`.** Per
   §0's layout, alice's and bob's peer2 daemons run from separate CWDs to
   sidestep this. If you must share a CWD, pass distinct `--pid` and
   `--log` to each invocation.
2. **`sphere wallet use <name>` mutates `./.sphere-cli/config.json`
   globally.** A running daemon already loaded its config; switching
   profile in another terminal does NOT redirect the live daemon, but it
   DOES change which wallet a subsequent `sphere balance` (etc.) targets.
   Be deliberate about profile switching while daemons are alive.
3. **`--no-nostr` means no incoming transfers at all.** Use it for the §D
   IPFS-only recovery proof, but don't try to receive new transfers
   while it's active — the no-op transport drops them. Re-init without
   `--no-nostr` to resume live operations.

---

## Command cheat sheet (delta vs drain-fix doc)

| Want to... | Command |
|---|---|
| Start foreground listener daemon | `sphere daemon start --event 'transfer:incoming' --action auto-receive --verbose` |
| Append events to a file | add `--event '<ev>' --action 'log:./events.log'` to the daemon invocation |
| Stop daemon (detach mode) | `sphere daemon stop` |
| Check daemon status | `sphere daemon status` |
| Init wallet with IPFS-only recovery | `sphere init --network testnet --no-nostr --mnemonic "<phrase>"` |
| List COVERED invoices | `sphere invoice list --state COVERED` |
| Show one invoice | `sphere invoice status <id>` |
