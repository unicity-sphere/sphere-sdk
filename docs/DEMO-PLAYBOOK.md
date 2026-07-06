# Sphere CLI Demo Playbook (public session)

A presenter-friendly run-through of the Sphere CLI: two wallets, a second
device per wallet, a live event daemon, an end-to-end invoice, and a
full **mnemonic-only recovery from IPFS** at the end.

This playbook is the demo-mode adaptation of the QA walkthrough at
[`manual-test-full-recovery.md`](../manual-test-full-recovery.md), which is
also the exact script the nightly soak runs (`.tmp/soak-264.sh`). If you
want the assertion-heavy version with diff gates, read that. If you want
to **show this to an audience**, read on.

---

## At a glance

| Phase | What you show | Time |
|---|---|---|
| §0 | Prereqs & setup | 2 min |
| §1 | Peer 1 — create two wallets and fund Alice | 5 min |
| §A | Peer 2 — Alice + Bob open the same wallet on a second device | 4 min |
| §B | Start an event daemon on each peer-2 wallet | 2 min |
| §C | Alice sends Bob an invoice; Bob pays it; peer 2 reacts live | 6 min |
| §D | **Wipe everything. Recover only from a 12-word phrase + IPFS.** | 6 min |
| §E | Show that the invoice ledger survived the wipe | 2 min |
| Wrap | Q&A | 3 min |
| | **Total** | **~30 min** |

---

## §0 Before you start

**The CLI must already be installed** and resolved against the SDK you
want to demo:

```bash
sphere --version            # any non-zero version
which sphere                # confirms it's on $PATH

# Confirm the CLI is linked against the SDK build you're demoing:
readlink -f ~/sphere-cli-work/sphere-cli/node_modules/@unicitylabs/sphere-sdk
```

You'll need **three terminals**. Lay them out side-by-side so the
audience can read everything at once:

```
┌───────────────────────┬───────────────────────┬───────────────────────┐
│ TERMINAL 1            │ TERMINAL 2            │ TERMINAL 3            │
│ Peer 1                │ Peer 2 — Alice daemon │ Peer 2 — Bob daemon   │
│ (drives the demo)     │ (passive listener)    │ (passive listener)    │
│                       │                       │                       │
│ ~/sphere-demo/peer1   │ ~/sphere-demo/        │ ~/sphere-demo/        │
│                       │   peer2-alice         │   peer2-bob           │
└───────────────────────┴───────────────────────┴───────────────────────┘
```

> **Why three CWDs?** Each wallet daemon writes its PID/log to
> `./.sphere-cli/daemon.pid` (current directory). Two daemons in one
> directory collide. One CWD per daemon sidesteps it without flag
> overrides.

In **Terminal 1**, set up the workspace and shell variables. Audience
sees nothing dramatic yet; talk while you type:

```bash
mkdir -p ~/sphere-demo/{peer1,peer2-alice,peer2-bob}
cd ~/sphere-demo/peer1

# Unique-per-run nametags. Testnet nametags are minted on-chain
# and live forever, so "alice" / "bob" are long taken.
SUFFIX=$(date +%s | tail -c 5)$(printf '%04x' $((RANDOM % 65536)))
ALICE_TAG=alice-$SUFFIX
BOB_TAG=bob-$SUFFIX
echo "Alice will be: @$ALICE_TAG"
echo "Bob   will be: @$BOB_TAG"
```

**Talk track:** "Sphere is a self-custodial wallet for the Unicity
network. Everything you'll see is happening on real testnet — the
nametags I'm registering are minted on-chain, the tokens move through
the aggregator, the state is published to IPFS. No mocks."

---

## §1 Peer 1 — create two wallets and fund Alice

Still in Terminal 1:

```bash
# Alice's wallet
sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --nametag $ALICE_TAG
```

The CLI prints a **12-word BIP-39 mnemonic**. Read one or two words to
the audience, then copy it into a shell var off-screen:

```bash
ALICE_MNEMONIC="<paste alice's 12 words>"
sphere status
```

**Audience should see:** an L1 address (`alpha1...`), a L3 DIRECT
address, and a `Nametag: @alice-XXXX` line.

Repeat for Bob:

```bash
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --nametag $BOB_TAG
BOB_MNEMONIC="<paste bob's 12 words>"
sphere status
```

> **If `sphere status` does NOT print a `Nametag:` line**, the on-chain
> mint silently failed (nametag taken or transient relay flake). Run
> `sphere nametag <fresh-name>` with a new suffix and update the env
> var. The audience won't notice the recovery if you stay calm.

Top up Alice from the testnet faucet:

```bash
sphere wallet use alice
sphere faucet
sphere payments sync       # publishes the new CAR to IPFS
sphere balance
```

**Talk track:** "Alice now holds a few testnet tokens — UCT, USDU,
USDC. The wallet just published its state as a content-addressed CAR
file to IPFS, signed an IPNS pointer, and broadcast it. Bob, who's
sitting in another tab, hasn't received anything yet."

---

## §A Peer 2 — open the same wallet on a second device

Each peer-2 directory is **the same identity** (same mnemonic, same
secp256k1 keys, same L1/L3 addresses) but a **fresh local state
directory**. We're going to prove the wallet reconstructs itself from
IPFS alone.

### A.1 Alice on peer-2 — Terminal 2

```bash
cd ~/sphere-demo/peer2-alice
sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --mnemonic "$ALICE_MNEMONIC"
sphere status            # ← same L1 address as Terminal 1
```

> **Side-by-side cue:** Have the audience compare the `L1 address` line
> in Terminal 1 vs Terminal 2. Identical → same identity.

Pull state from IPFS:

```bash
sphere payments sync
sphere payments receive --finalize
sphere balance
```

**Audience should see:** the same UCT balance as Terminal 1 — no faucet
ever ran on peer 2.

### A.2 Bob on peer-2 — Terminal 3

```bash
cd ~/sphere-demo/peer2-bob
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --mnemonic "$BOB_MNEMONIC"
sphere status            # ← same L1 address as Bob in Terminal 1
sphere payments sync
sphere balance           # likely empty — Bob hasn't been paid yet
```

**Talk track:** "Bob's second device has nothing yet, because nobody
has paid him. Watch what happens when Alice asks him to."

---

## §B Start a live event daemon on each peer 2

The daemon subscribes to Sphere events (`transfer:incoming`,
`invoice:payment`, etc.) and auto-finalizes received tokens. We want the
audience to **see events arrive in real time** while peer 1 drives the
demo.

### B.1 Alice's daemon — Terminal 2 (leave running)

```bash
sphere daemon start \
  --event 'transfer:incoming'  --action auto-receive \
  --event 'transfer:incoming'  --action 'log:./events.log' \
  --event 'transfer:confirmed' --action 'log:./events.log' \
  --event 'invoice:payment'    --action 'log:./events.log' \
  --event 'invoice:covered'    --action 'log:./events.log' \
  --verbose
```

You'll see:
```
Starting Sphere daemon...
Subscribed events: transfer:incoming, transfer:confirmed, invoice:payment, invoice:covered
Wallet: @alice-...
Daemon running. Waiting for events...
```

### B.2 Bob's daemon — Terminal 3 (leave running)

Identical command — Bob's wallet, Bob's directory:

```bash
sphere daemon start \
  --event 'transfer:incoming'  --action auto-receive \
  --event 'transfer:incoming'  --action 'log:./events.log' \
  --event 'transfer:confirmed' --action 'log:./events.log' \
  --event 'invoice:payment'    --action 'log:./events.log' \
  --event 'invoice:covered'    --action 'log:./events.log' \
  --verbose
```

Both terminals now sit on `Waiting for events...`. **This is your live
canvas for the next section.**

**Talk track:** "These two terminals are listening on a Nostr relay
for events tagged with their wallet's transport pubkey. Anything that
happens to Alice or Bob from anywhere in the world will appear here
within seconds."

---

## §C The invoice round-trip

Back to Terminal 1 (peer 1). Alice creates an invoice; Alice ships it
to Bob; Bob pays it; Alice's peer-2 daemon catches the payment **without
any manual sync**.

### C.1 Alice creates an 11 UCT invoice

```bash
cd ~/sphere-demo/peer1
sphere wallet use alice
sphere invoice create \
  --target @$ALICE_TAG \
  --asset "11000000 UCT" \
  --memo "Demo invoice"
```

The CLI prints JSON. **Grab the `invoiceId` field** — it looks like
`0xabc123...`. Save it:

```bash
INV=<paste invoiceId>
```

> The `--target` flag names the **receiver of funds** (Alice — she's
> asking to be paid). The payer (Bob) is named in the next step.

### C.1b Alice delivers the invoice to Bob

`invoice create` mints the invoice but does **not** auto-send it.
Delivery is explicit:

```bash
sphere invoice deliver $INV --to @$BOB_TAG
```

You'll see JSON ending in `{ sent: 1, failed: 0, ... shape: "inline" }`.
The invoice traveled as a NIP-17 encrypted DM to Bob's transport pubkey.

### C.2 Bob pays — same peer 1, different wallet

```bash
sphere wallet use bob
sleep 5                            # let Bob's relay sub catch the DM
sphere payments sync
sphere invoice pay $INV
sphere payments sync
```

> The `sleep 5` is a presenter courtesy — Bob's wallet needs a moment
> to ingest the inbound `invoice_delivery` DM before `invoice pay`
> finds the record locally. In production this is automatic.

### C.3 Show Terminal 2 — Alice's peer-2 daemon

**Direct the audience's eyes to Terminal 2.** Within ~10 seconds you'll
see three event lines arrive without anyone touching that terminal:

```
[<iso>] EVENT transfer:incoming  data={"senderPubkey":"...","tokens":[...],...}
[<iso>] EVENT invoice:payment    data={"invoiceId":"<id>",...}
[<iso>] EVENT invoice:covered    data={"invoiceId":"<id>"}
```

**Talk track:** "Alice is at her desk on Terminal 1. Her phone — well,
her second device — is on Terminal 2. The phone just learned, in real
time, over an encrypted Nostr DM, that Bob paid the invoice. The wallet
auto-finalized the incoming token. No polling, no manual refresh."

### C.4 Verify peer 2 already sees it (no manual sync)

In Terminal 2 (Ctrl-Z + `bg` the daemon, or just open a new shell in
the same directory):

```bash
cd ~/sphere-demo/peer2-alice
sphere wallet use alice
sphere invoice status $INV         # State: COVERED
sphere balance                     # +11 UCT vs §A.1
```

In Terminal 3 (same trick — new shell in the same CWD if the daemon is
foregrounded):

```bash
cd ~/sphere-demo/peer2-bob
sphere wallet use bob
sphere balance                     # Bob's tokens were consumed
```

**The key moment:** peer 2 reflects the payment without anyone ever
typing `sphere payments sync` on peer 2. The daemon's `auto-receive`
action did it the instant the Nostr event arrived.

### C.5 (Optional) Free-form transfer the other way

If you have time:

```bash
cd ~/sphere-demo/peer1
sphere wallet use bob
sphere payments send @$ALICE_TAG 1 UCT
sphere payments sync
```

Watch Terminal 2 for a fresh `transfer:incoming` event.

---

## §D Wipe everything. Recover from a 12-word phrase + IPFS.

This is the demo's climax. You're going to **destroy all four wallet
instances** and bring them back using only mnemonics, with **Nostr
disabled** so the audience knows IPFS did the work.

### D.1 Snapshot the "before" state on peer 1

```bash
cd ~/sphere-demo/peer1

sphere wallet use alice
sphere payments sync
sphere balance         > /tmp/alice-before.txt
sphere payments tokens > /tmp/alice-tokens-before.txt
sphere invoice list --state COVERED > /tmp/alice-invoices-before.txt

sphere wallet use bob
sphere payments sync
sphere balance         > /tmp/bob-before.txt
sphere payments tokens > /tmp/bob-tokens-before.txt
sphere invoice list --state COVERED > /tmp/bob-invoices-before.txt
```

### D.2 Stop the peer-2 daemons

In Terminals 2 and 3, hit **Ctrl-C** in each:

```
Shutting down daemon...
Daemon stopped.
```

### D.3 Wipe all four wallets

```bash
# Peer 1
cd ~/sphere-demo/peer1
sphere wallet use alice && sphere clear   # confirm at prompt
sphere wallet use bob   && sphere clear

# Peer 2 Alice
cd ~/sphere-demo/peer2-alice
sphere wallet use alice && sphere clear

# Peer 2 Bob
cd ~/sphere-demo/peer2-bob
sphere wallet use bob   && sphere clear
```

Spot-check that the wallets are gone:

```bash
sphere status        # → "No wallet"
```

**Talk track:** "I've just wiped 100% of the local state on four
wallets. OrbitDB stores, token caches, daemon configs — all gone. The
only things that remain are the four mnemonics I wrote down, plus
whatever the wallets published to IPFS."

### D.4 Recover from mnemonic + IPFS only (Nostr disabled)

The `--no-nostr` flag installs a no-op transport. The wallet derives
identity from the mnemonic and pulls token state from IPFS via the
IPNS pointer associated with the identity's keys. Nothing else.

```bash
# Peer 1 — Alice
cd ~/sphere-demo/peer1
sphere wallet use alice
sphere init --network testnet --no-nostr --mnemonic "$ALICE_MNEMONIC"
sphere payments sync
sphere payments receive --finalize
sphere balance         > /tmp/alice-after.txt
sphere payments tokens > /tmp/alice-tokens-after.txt
sphere invoice list --state COVERED > /tmp/alice-invoices-after.txt

# Peer 1 — Bob
sphere wallet use bob
sphere init --network testnet --no-nostr --mnemonic "$BOB_MNEMONIC"
sphere payments sync
sphere payments receive --finalize
sphere balance         > /tmp/bob-after.txt
sphere payments tokens > /tmp/bob-tokens-after.txt
sphere invoice list --state COVERED > /tmp/bob-invoices-after.txt

# Peer 2 — Alice
cd ~/sphere-demo/peer2-alice
sphere wallet use alice
sphere init --network testnet --no-nostr --mnemonic "$ALICE_MNEMONIC"
sphere payments sync
sphere balance         > /tmp/alice-peer2-after.txt

# Peer 2 — Bob
cd ~/sphere-demo/peer2-bob
sphere wallet use bob
sphere init --network testnet --no-nostr --mnemonic "$BOB_MNEMONIC"
sphere payments sync
sphere balance         > /tmp/bob-peer2-after.txt
```

### D.5 Show the diffs — empty means bit-for-bit recovery

```bash
diff /tmp/alice-before.txt        /tmp/alice-after.txt
diff /tmp/alice-tokens-before.txt /tmp/alice-tokens-after.txt
diff /tmp/bob-before.txt          /tmp/bob-after.txt
diff /tmp/bob-tokens-before.txt   /tmp/bob-tokens-after.txt

# And the cross-device recoveries:
diff /tmp/alice-before.txt /tmp/alice-peer2-after.txt
diff /tmp/bob-before.txt   /tmp/bob-peer2-after.txt
```

**All six diffs print nothing.** Four wiped wallets came back from
twelve words each and a content-addressed pointer on IPFS.

**Talk track:** "Self-custody, but without keeping a database around.
The state isn't on a server you trust — it's on IPFS, signed by your
own key, addressed by content hash. As long as one peer keeps the CAR
file alive, your wallet can rebuild itself from twelve words anywhere
in the world."

---

## §E The invoice ledger survived too

Recovery doesn't stop at fungible balances. The accounting/invoice
ledger lives in the same IPFS-backed OrbitDB store.

```bash
diff /tmp/alice-invoices-before.txt \
  <(cd ~/sphere-demo/peer1 && sphere wallet use alice && \
    sphere invoice list --state COVERED)
diff /tmp/bob-invoices-before.txt \
  <(cd ~/sphere-demo/peer1 && sphere wallet use bob && \
    sphere invoice list --state COVERED)

# Spot-check the §C invoice on recovered Alice:
cd ~/sphere-demo/peer1
sphere wallet use alice
sphere invoice status $INV         # State: COVERED, memo "Demo invoice"
```

Both diffs empty + the original COVERED invoice still readable by ID
with its memo intact = **business state survives wallet wipes**.

---

## Wrap up

Things you've demonstrated in ~30 minutes:

1. **Two identities** created on testnet with on-chain nametag registration.
2. **Cross-device sync** of the same identity via fresh `DATA_DIR` + mnemonic.
3. **Live event-driven daemon** auto-finalizing incoming tokens.
4. **Encrypted P2P invoicing** (NIP-17 DM transport, no central server).
5. **Full IPFS-only recovery** of four wallet instances from mnemonics.
6. **Business-state durability** — the invoice ledger round-trips through wipe.

Stop the daemons (if still running):

```bash
pkill -f "sphere daemon" 2>/dev/null
```

Tear down the workspace:

```bash
rm -rf ~/sphere-demo
```

---

## Presenter cheat sheet

| When you want to... | Run |
|---|---|
| Create a wallet | `sphere init --network testnet [--nametag <tag>]` |
| Open an existing wallet | `sphere init --network testnet --mnemonic "<12 words>"` |
| IPFS-only recovery | add `--no-nostr` to the init line above |
| Switch profile | `sphere wallet use <name>` |
| Show identity | `sphere status` |
| Fund (testnet) | `sphere faucet` |
| Show balance | `sphere balance` |
| Show tokens | `sphere payments tokens` |
| Send | `sphere payments send <recipient> <amount> <symbol>` |
| Force IPFS sync | `sphere payments sync` |
| Finalize received | `sphere payments receive --finalize` |
| Create invoice | `sphere invoice create --target @x --asset "<amount> <sym>"` |
| Deliver invoice | `sphere invoice deliver <id> --to @<payer>` |
| Pay invoice | `sphere invoice pay <id>` |
| Show invoice | `sphere invoice status <id>` |
| List invoices | `sphere invoice list --state COVERED` |
| Start event daemon | `sphere daemon start --event '<ev>' --action <spec> [--verbose]` |
| Stop background daemon | `sphere daemon stop` |
| Daemon actions | `auto-receive`, `log:<path>`, `shell:<cmd>` |
| Wipe wallet | `sphere clear` |

---

## Common live-demo failure modes

1. **Nametag mint silently fails** → `sphere status` shows no
   `Nametag:` line. Run `sphere nametag <new-tag>` and update the env
   var. Don't proceed if peer 1's nametag isn't visible — the faucet
   payment will go to whoever actually owns the tag.

2. **Bob's wallet can't find the invoice after delivery** → the relay
   subscription hasn't ingested the DM yet. The `sleep 5` in §C.2
   handles the usual case; if it's still missing, run
   `sphere payments sync` again and retry `sphere invoice pay`.

3. **`sphere balance` doesn't reflect the §C payment on peer 2** → the
   daemon may have died (Nostr socket reset). Check Terminal 2 for a
   `Daemon stopped` line; restart it and re-run §C from C.2.

4. **`sphere clear` prompts and you can't tell if it accepted** → type
   `yes` and Enter. The prompt is interactive even when the broader
   shell isn't.

5. **`diff` output isn't empty in §D.5** → most often a
   not-yet-finalized v5 token. Re-run `sphere payments receive
   --finalize` and re-snapshot. If still divergent, the partial CAR
   issue is real and worth flagging in Q&A as "this is where the
   testnet runtime is still hardening."

---

## Source material

This playbook is the demo-mode adaptation of:

- [`manual-test-full-recovery.md`](../manual-test-full-recovery.md) —
  the QA walkthrough with full assertion gates.
- [`manual-test-drain-fix.md`](../manual-test-drain-fix.md) — the
  single-peer prerequisite (CLI install, profile mode default,
  nametag-collision rescue).
- [`.tmp/soak-264.sh`](../.tmp/soak-264.sh) — the automated runner that
  replays the QA walkthrough on a loop. Each iteration is a complete
  end-to-end pass; the nightly soak runs 5+ iterations and asserts
  zero pointer-monotonicity violations.

If you're showing this internally and want the **assertion-heavy** run
(every step gated by a `diff` or `grep`), use the QA doc instead. The
demo playbook above intentionally narrates around the proof points
without printing every check.
