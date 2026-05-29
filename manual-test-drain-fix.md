# Manual CLI test — sync() drain fix (PR #127 follow-up, commit f0cd580)

End-to-end smoke test for the architectural fix that has `sync()` drain
pending V5 finalizations before flushing to token-storage providers.

The workflow assumes `@unicity-sphere/cli` linked to this branch. CLI
binary is `sphere` (or `sphere-cli` if you `npm link`-ed). The CLI uses
**namespaced commands** that map internally to the legacy command names
— most commands you'll type live under `payments`, `invoice`, etc.

> **Profile mode is the default.** No `--profile` flag exists in this
> CLI build; profile-mode storage is auto-selected. Verify with
> `sphere status` after init — it should say `Storage: profile`.

---

## 0. CLI prerequisites

```bash
sphere --version            # any non-zero version is fine
which sphere                # confirms it's on $PATH

# Confirm the path-link to this sphere-sdk branch:
ls -l ~/sphere-cli-work/sphere-cli/node_modules/@unicitylabs/sphere-sdk
# → symlink to /home/vrogojin/uxf

# Confirm the drain fix is in the resolved SDK:
grep -c "drain timed out" \
  ~/sphere-cli-work/sphere-cli/node_modules/@unicitylabs/sphere-sdk/dist/index.cjs
# → 2
```

---

## 1. Two-wallet workspace (profile mode is default)

```bash
mkdir -p ~/sphere-drain-test && cd ~/sphere-drain-test

# Pick unique nametag suffixes — testnet keeps minted nametags forever,
# so "alice-t1" type names will collide on rerun.
SUFFIX=$(date +%s)
ALICE_TAG=alice-drain-$SUFFIX
BOB_TAG=bob-drain-$SUFFIX

# alice profile
sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --nametag $ALICE_TAG
# ⚠️  Save the printed mnemonic for alice — needed for recovery.
ALICE_MNEMONIC="<paste alice's mnemonic here>"

# Confirm alice's nametag landed (look for the `Nametag:` line)
sphere status

# bob profile
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --nametag $BOB_TAG
sphere status
```

**CRITICAL gate.** If `sphere status` for either wallet doesn't show a
`Nametag:` line, the mint failed silently (taken on testnet, or relay
flake). DO NOT proceed — `sphere faucet` will send tokens to whoever
actually owns the nametag, not to you. Fix first:

```bash
sphere wallet use alice
FRESH=alice-drain-$(date +%s)-$$
sphere nametag $FRESH
sphere status                # Nametag: line MUST appear now
ALICE_TAG=$FRESH

# Same drill for bob if needed:
sphere wallet use bob
sphere status | grep -i nametag || {
  FRESH=bob-drain-$(date +%s)-$$
  sphere nametag $FRESH
  BOB_TAG=$FRESH
}
```

---

## 2. Top up alice (multi-coin — this is where the drain matters)

```bash
sphere wallet use alice

# Faucet drops several coins. Tokens land in 'submitted' state until
# the recipient FinalizationWorker resolves each via the aggregator.
sphere faucet
# wait a few seconds for Nostr deliveries to land
sphere balance              # may show pending v5 tokens — that's the point

# THE CRITICAL STEP. Pre-fix: a `sync` here published a partial CAR
# (any still-pending coin was silently dropped). Post-fix: sync()
# drains pending v5 first, then flushes a complete CAR.
sphere payments sync
sphere balance              # should match what the faucet delivered
```

---

## 3. Send some money from alice to bob

```bash
sphere payments send @$BOB_TAG 10 UCT
# default mode is instant; pass --conservative for the slower, fully
# proven-up-front path

# verify on bob's side
sphere wallet use bob
sphere balance --finalize   # waits for UCT to confirm
```

---

## 4. Bob creates an invoice for alice to pay

```bash
sphere wallet use bob
sphere invoice create --target @$ALICE_TAG --asset "5000000 UCT" --memo "Coffee tab"
# captures invoiceId in the JSON output — copy it
INV=<paste invoiceId>

# alice pays
sphere wallet use alice
sphere invoice pay $INV

# bob checks status
sphere wallet use bob
sphere invoice status $INV  # expect COVERED once payment confirms
```

---

## 5. Snapshot alice's pre-clear state

```bash
sphere wallet use alice
sphere payments sync         # one more publish so IPFS is current
sphere balance > /tmp/alice-before.txt
sphere payments tokens > /tmp/alice-tokens-before.txt
cat /tmp/alice-before.txt
```

---

## 6. Delete alice's profile completely

```bash
# Wipes wallet.json + orbitdb/ + tokens/ for the active profile.
# This CLI build doesn't accept --yes; respond at the prompt.
sphere clear

# Verify the wipe
sphere status                # should refuse — no wallet
ls -la .sphere-cli-alice/    # mostly gone
```

---

## 7. Recover alice from mnemonic

```bash
# Re-init the same profile with the saved mnemonic. Profile mode
# pulls state from OrbitDB+IPFS using the wallet identity derived
# from the mnemonic — this is the path that breaks if step 2's
# sync published a partial CAR.
sphere wallet use alice
sphere init --network testnet --mnemonic "$ALICE_MNEMONIC"

# Auto-sync runs as part of init/load. Force one more for good measure
# and explicitly drain any still-pending tokens:
sphere payments sync
sphere payments receive --finalize
sphere balance > /tmp/alice-after.txt
sphere payments tokens > /tmp/alice-tokens-after.txt
```

---

## 8. THE ASSERT: pre-clear and post-recovery must match

```bash
diff /tmp/alice-before.txt /tmp/alice-after.txt
diff /tmp/alice-tokens-before.txt /tmp/alice-tokens-after.txt
# Empty diff = drain fix held. Any missing coin/token = regression.
```

---

## What you're looking for

- **Step 2's `sphere payments sync`** — the headline test. With the fix,
  sync() blocks for up to 30s draining pending v5 tokens, then publishes
  a complete CAR. Without the fix, it returns immediately and the CAR
  is missing whatever was still pending.
- **Step 8's `diff`** — empty means the published CAR was complete.
  Non-empty (especially missing UCT/USDC/USDU) means a partial CAR
  shipped at step 2 and recovery couldn't reconstitute the lost coin.
- **Watch for** `sync: drain timed out with N token(s) still pending`
  warnings — that's the new fix announcing it skipped a partial-CAR
  publish. Re-run `sphere payments sync` after 30s and it should clear.

## Three gotchas

1. **Faucet flake (per 889aa52):** if you see `Cannot finalize PROXY
   transfer - no Unicity ID token` after `faucet`, that's the broken
   testnet faucet, not a drain regression. Re-try the faucet or wait
   it out.
2. **Nametag collisions are silent.** If `sphere status` after init
   doesn't show your nametag, the mint failed silently (taken or
   transient relay flake). Fix it with `sphere nametag <fresh-name>`
   and update your shell var.
3. **No `topup` / `send` / `sync` / `tokens` at top level.** This CLI
   namespaces them: `sphere faucet` (alias for topup), `sphere payments
   send`, `sphere payments sync`, `sphere payments tokens`. The doc
   above already uses the right form; if you remember an old shape from
   the published CLI, check `sphere --help` for the namespace.

## Command cheat sheet (quick reference)

| Want to... | Command |
|---|---|
| Create wallet | `sphere init --network testnet [--nametag <tag>]` |
| Show identity | `sphere status` |
| Switch profile | `sphere wallet use <name>` |
| Faucet | `sphere faucet` (or `sphere faucet 100 UCT`) |
| Show balance | `sphere balance [--finalize] [--no-sync]` |
| List tokens | `sphere payments tokens` |
| Send | `sphere payments send <recipient> <amount> <symbol>` |
| Receive | `sphere payments receive [--finalize]` |
| IPFS sync | `sphere payments sync` |
| Register nametag | `sphere nametag <name>` |
| Look up nametag | `sphere nametag info <name>` |
| Show my nametag | `sphere nametag my` |
| Create invoice | `sphere invoice create --target @x --asset "N SYM"` |
| Pay invoice | `sphere invoice pay <id>` |
| Invoice status | `sphere invoice status <id>` |
| Wipe profile | `sphere clear` |
