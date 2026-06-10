# Sphere CLI Demo Playbook — Trader Round-Trip

A presenter-friendly run-through of **autonomous AI agents trading on Unicity testnet**. Two trader tenants — `alice-trader` and `bob-trader` — are each spawned by their controller on a **per-user local Host Manager** (one HM per developer, scoped to that wallet's controller pubkey), then given a one-line trading intent and left to negotiate, match, and execute a token swap entirely on their own. No human approvals, no orchestrator, no shared backend. No shared HM, either — each peer brings its own. Just two daemons watching a market and talking over Nostr DMs.

The twist that makes this demo land (versus the swap playbook, which exercises the same escrow but with humans driving every state transition): **after §6, the controllers go quiet.** The audience watches two AI tenants find each other on the market, negotiate a price inside both their bands, deposit into the same escrow service, and verify the payout — peer-to-peer, no human in the loop. The §3 "spin up two autonomous agents" beat and the §7 "watch them negotiate" beat are the load-bearing audience moments.

The bot's controller surface is just `sphere trader create-intent`. Everything else — the strategy engine, the market scan loop, the negotiation protocol (NP-0), the escrow handshake, the swap settlement — happens inside the trader-agent container.

This is the companion to the soak script [`manual-test-trader-roundtrip.sh`](../manual-test-trader-roundtrip.sh) — that script asserts the same thing programmatically; this playbook walks the same flow live in front of an audience.

---

## At a glance

```
SETUP   alice + bob controller wallets on testnet
        alice faucet 100 UCT, bob faucet 10 ETH

SPAWN   sphere trader spawn --name alice-trader-$SUFFIX
                          --trusted-escrows @escrow-test-02
        sphere trader spawn --name bob-trader-$SUFFIX
                          --trusted-escrows @escrow-test-02
        (each command brings up a per-user local Host Manager + the
         trader tenant; no shared HM, no controller-pubkey whitelist)

FUND    sphere payments send --recipient @alice-trader --amount 50 UCT
        sphere payments send --recipient @bob-trader   --amount 4.5 ETH

INTENTS sphere trader create-intent --tenant @alice-trader
                          --direction sell --base UCT --quote ETH
                          --rate-min 0.08 --rate-max 0.12
                          --volume-min 50 --volume-max 50
        sphere trader create-intent --tenant @bob-trader
                          --direction buy  --base UCT --quote ETH
                          --rate-min 0.08 --rate-max 0.12
                          --volume-min 50 --volume-max 50
        → controllers go quiet ←

WATCH   tenants discover each other on market-api,
        negotiate via NIP-17 DMs (NP-0 protocol),
        execute via @escrow-test-02 SwapModule

VERIFY  sphere trader portfolio --tenant @alice-trader  →  -50 UCT, +5 ETH
        sphere trader portfolio --tenant @bob-trader    →  +50 UCT, -5 ETH
        sphere trader list-deals --state completed      →  matching deal_id
```

Total run time: ~25 min on a healthy testnet (the trader scan interval defaults to 30s, and escrow finalization dominates the back half).

The "controller is just `sphere trader create-intent`; the rest happens autonomously" beat is the whole point — once §6 lands, you stop typing and start narrating.

---

## §0 Before you start

### Prerequisites

- `sphere` CLI on `PATH` (`which sphere` should resolve), built from a checkout that includes the `sphere trader spawn` / `sphere trader stop` wrapper ([unicity-sphere/sphere-cli#49](https://github.com/unicity-sphere/sphere-cli/pull/49) or later). The wrapper brings up a **per-user local Host Manager** scoped to the active wallet's controller pubkey, then spawns the trader tenant against it — no shared HM required.
- **Docker** available on the demo machine. The wrapper drives docker to start the local HM container.
- The **trader-agent template** registered in the wrapper's local templates registry. The container image is `ghcr.io/vrogojin/agentic-hosting/trader:v0.1` (see [Trader image staleness](#trader-image-staleness) below).
- Outbound HTTPS to: `faucet.unicity.network`, `goggregator-test.unicity.network`, `market-api.unicity.network`, Unicity IPFS gateways.
- Outbound WSS to: `wss://nostr-relay.testnet.unicity.network`.
- An escrow service reachable on the same testnet relay set. Default `@escrow-test-02`; pass via `--trusted-escrows` on `sphere trader spawn` or via `sphere trader set-strategy` if you've stood up your own.
- A clean workspace (the script wipes its own scratch dir on exit unless `KEEP=1`).

### Pre-flight sanity checks

Before you start typing for an audience, run all three of these and confirm the network is up:

```bash
# 1. Docker is up (the wrapper needs it to start the per-user HM container).
docker info >/dev/null && echo "docker OK"

# 2. Escrow is reachable and signing.
sphere swap ping @escrow-test-02

# 3. Market-api is reachable. Searching for an unlikely term should
#    return an empty-array response, not a connection error.
curl -fsS "https://market-api.unicity.network/intents?base_asset=UCT&quote_asset=ETH" | head -c 200; echo
```

If any of these fail, fix it before the demo — none of them recover gracefully under audience pressure.

### Versions to confirm

```bash
sphere --help | head -3
sphere trader --help | head -3              # should list spawn / stop / create-intent / cancel-intent / list-intents / list-deals / portfolio / set-strategy
node --version                               # >= 18
docker --version                             # any recent stable
```

### Suggested terminal layout

- **T1** — alice's controller wallet. All `--tenant @alice-trader` commands.
- **T2** — bob's controller wallet. All `--tenant @bob-trader` commands.
- **T3** — log tail. After §6 starts, this is where you show `docker logs -f sphere-trader-<wallet>-<name>` and `sphere trader list-deals --tenant @<tag>` running on both sides.

### Workspace bootstrap

```bash
ROOT="/tmp/demo-trader-$$"
mkdir -p "$ROOT/peer-alice" "$ROOT/peer-bob"
SUFFIX="$(date +%s | tail -c 5)$(printf '%04x' $((RANDOM % 65536)))"
ALICE_TAG="alice-$SUFFIX"
BOB_TAG="bob-$SUFFIX"
ALICE_TRADER_TAG="alice-trader-$SUFFIX"
BOB_TRADER_TAG="bob-trader-$SUFFIX"
# Instance names passed to `sphere trader spawn --name` in §3. We use
# the same slug as the nametag suffix for symmetry; they're separate
# identifiers (the instance name is the wrapper's local registry key,
# the nametag is the on-network identity).
ALICE_TRADER_INSTANCE="alice-trader-$SUFFIX"
BOB_TRADER_INSTANCE="bob-trader-$SUFFIX"
echo "ALICE_TAG=$ALICE_TAG"
echo "BOB_TAG=$BOB_TAG"
echo "ALICE_TRADER_TAG=$ALICE_TRADER_TAG"
echo "BOB_TRADER_TAG=$BOB_TRADER_TAG"

# Escrow used by both tenants. The trader image bakes @escrow-test-02
# as the default `trusted_escrows[0]` — if you need a different escrow,
# pass it via SET_STRATEGY (§3.5 sidebar) before posting intents.
ESCROW="${ESCROW:-@escrow-test-02}"
echo "ESCROW=$ESCROW"

# CLI emits mnemonic on stdout in non-TTY when --no-encrypt-mnemonic is
# implied. Allowing this makes the live walkthrough scriptable.
export SPHERE_ALLOW_MNEMONIC_NON_TTY=1
```

### Known gotchas (read before demoing)

#### Pre-flight: which form does the CLI accept? (float vs bigint)

The intended UX — and what the rest of this playbook is written against — is **human-friendly floats**: you type `--rate-min 0.08 --rate-max 0.12 --volume-min 50 --volume-max 50` and the CLI converts to smallest-unit bigints internally by looking up each asset's decimals in the token registry (UCT and ETH are both 18-decimal on testnet).

**However**, today's `sphere trader create-intent --help` may still declare `--rate-min <bigint>` (string-encoded smallest-unit integer). The CLI float-conversion is a #474 follow-up; before it lands, the deployed CLI accepts only the bigint form. **Run this one quick check before going live:**

```bash
sphere trader create-intent --help | grep -E -- '--rate-min|--volume-min'
```

- If the help output says `<float>` or `<number>` (or omits the type) — you're on the post-fix CLI. The float values in §5 / §6 below work as written.
- If the help output says `<bigint>` — you're on the pre-fix CLI. **Use the smallest-unit form** instead:

  | Quantity (intended)   | Smallest-unit bigint (UCT/ETH 18-decimal)     |
  |-----------------------|-----------------------------------------------|
  | rate `0.08` ETH/UCT   | `80000000000000000`     (`8 × 10^16`)         |
  | rate `0.12` ETH/UCT   | `120000000000000000`    (`1.2 × 10^17`)       |
  | rate `0.10` ETH/UCT   | `100000000000000000`    (`1 × 10^17`)         |
  | volume `50` UCT       | `50000000000000000000`  (`5 × 10^19`)         |
  | volume `1` UCT        | `1000000000000000000`   (`1 × 10^18`)         |

  Either substitute the bigint form into every `create-intent` call in §5 / §6, or set up bash aliases at the top of T1 / T2:

  ```bash
  RATE_MIN=80000000000000000
  RATE_MAX=120000000000000000
  VOLUME_MIN=50000000000000000000
  VOLUME_MAX=50000000000000000000
  ```

  …and then write `--rate-min "$RATE_MIN"` etc. in the §5 / §6 commands.

**Verification recipe — run on a throwaway tenant before the live demo regardless of which form the CLI accepts.** This is the canonical way to confirm the deployed image's internal rate convention round-trips correctly:

```bash
# Post a tiny test intent; read it back; confirm rate / volume round-trip.
sphere trader create-intent --tenant @<test-tenant> \
  --direction sell --base UCT --quote ETH \
  --rate-min 0.10 --rate-max 0.10 \
  --volume-min 1 --volume-max 1 \
  --expiry-ms 600000 --json
sphere trader list-intents --tenant @<test-tenant> --json | jq '.intents[] | {rate_min, rate_max, volume_min, volume_max}'
sphere trader cancel-intent --tenant @<test-tenant> --intent-id <id>
```

If the read-back values differ from what you expect by some factor of `10^N`, the deployed image normalizes rate to a different unit than you assumed. See [§11 — rate unit recompute](#11-what-to-do-if-a-section-fails-live) for the recompute helper.

#### Cross-process DM flakiness (issue #473)

Controller CLI commands exit between calls. The tenant authenticates each incoming ACP request against the controller's pubkey, and DM delivery between a short-lived controller process and a long-running tenant is occasionally flaky (tracked in [sphere-sdk#473](https://github.com/unicity-sphere/sphere-sdk/issues/473)). The current workaround is a retry loop:

```bash
# Helper: retry the next sphere trader call up to 3 times with 5s backoff.
trader_retry() {
  local n=0
  while [ $n -lt 3 ]; do
    "$@" && return 0
    n=$((n+1))
    echo "  (retry $n/3 after 5s)" >&2
    sleep 5
  done
  return 1
}
# Usage:
trader_retry sphere trader portfolio --tenant "@$ALICE_TRADER_TAG" --json
```

The `list-deals` / `list-intents` polls in §7 and §8 already build this in; you only need the helper for one-shot calls.

#### Trader image staleness

`ghcr.io/vrogojin/agentic-hosting/trader:v0.1` was tagged before several recent sphere-sdk changes that affect the negotiation→escrow path:

- `DEFAULT_ESCROW_ADDRESS = @escrow-test-02` ([sphere-sdk#468](https://github.com/unicity-sphere/sphere-sdk/pull/468))
- counterparty transport pubkey fail-fast ([sphere-sdk#459](https://github.com/unicity-sphere/sphere-sdk/pull/459))
- MuxAdapter await on async handler completion ([sphere-sdk#465](https://github.com/unicity-sphere/sphere-sdk/pull/465))

If §7 hangs on `proposal_received` or §8 shows `EXECUTING` with no progress for more than 5 minutes, the v0.1 image is the most likely culprit. Rebuild the trader image against sphere-sdk `main` and republish before retrying.

#### Trader scan interval

Default `TRADER_SCAN_INTERVAL_MS=30000` (30s). The first match round can take **up to a minute** after the second intent lands — the strategy engine scans the market at its own cadence, not on demand. During §7, tell the audience "give it a minute" and don't refresh every 5s. If you want a faster demo cycle, set `--env TRADER_SCAN_INTERVAL_MS=10000` in §3 when you spawn the tenants. We use the default in this playbook so the spawned tenants match the production image's behaviour.

---

## §1 Create the two controller wallets

These are the **humans'** wallets — alice and bob each have a sphere wallet that holds their primary funds, bootstraps their per-user local Host Manager (via `sphere trader spawn`), and authenticates as the controller on each tenant.

### Alice — T1

```bash
cd "$ROOT/peer-alice"
sphere wallet create alice
sphere wallet use alice
sphere init --network testnet --nametag "$ALICE_TAG"
```

Capture alice's pubkey for the talk-track — the per-user local HM that `sphere trader spawn` brings up in §3 scopes ACP authorization to this pubkey automatically, so you don't pass it explicitly, but it's still useful to show the audience:

```bash
ALICE_PUBKEY=$(sphere identity show --json | jq -r '.chainPubkey')
echo "ALICE_PUBKEY=$ALICE_PUBKEY"
```

### Bob — T2

```bash
cd "$ROOT/peer-bob"
sphere wallet create bob
sphere wallet use bob
sphere init --network testnet --nametag "$BOB_TAG"

BOB_PUBKEY=$(sphere identity show --json | jq -r '.chainPubkey')
echo "BOB_PUBKEY=$BOB_PUBKEY"
```

**Talk track:** "These are the human wallets. Alice and Bob each hold their primary funds in their controller wallet and use it to govern their respective trader tenants. The tenant has its own separate keypair — controller and tenant are different identities, and the tenant only accepts ACP commands signed by the controller's pubkey we just captured."

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
sphere faucet 10 ETH
sphere payments sync
sphere payments receive --finalize
sphere balance
```

Expected:
- alice: `UCT: 100 (1 token)` and no ETH row.
- bob: `ETH: 10 (1 token)` and no UCT row.

**Snapshot now.** This is the "before" state. The asymmetric faucet is intentional — every net-delta in §9 has to come out of the trade, not an existing pool of both coins.

**Talk track:** "Same trick as the swap demo. Each controller has only the coin it's giving up. The only way alice's portfolio ends up with ETH (and bob's with UCT) is for the two autonomous tenants to actually negotiate and settle a swap. There's no fallback liquidity to mask a bug."

---

## §3 Spawn the two trader tenants  ← BIG MOMENT

This is where the demo earns its title. The next two commands turn over the keys to two AI agents.

Each peer runs its OWN local Host Manager — there's no shared backend, no whitelist to apply for, no operator to coordinate with. `sphere trader spawn` brings up a per-user HM container scoped to the current wallet's controller pubkey, then launches the trader tenant against it. One command per peer, no environment plumbing.

### T1 — spawn alice's trader

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere trader spawn \
  --name "$ALICE_TRADER_INSTANCE" \
  --trusted-escrows "$ESCROW" \
  --json
```

Expected JSON excerpt (the wrapper streams progress lines then a final JSON document):

```json
{
  "instance_name": "alice-trader-XXXXX",
  "instance_id":   "t_01HX...",
  "tenant_direct_address": "DIRECT://0000...",
  "hm_container":  "sphere-hm-alice-...",
  "hm_manager_address": "DIRECT://0000..."
}
```

### T2 — spawn bob's trader

```bash
cd "$ROOT/peer-bob"
sphere wallet use bob
sphere trader spawn \
  --name "$BOB_TRADER_INSTANCE" \
  --trusted-escrows "$ESCROW" \
  --json
```

### Probe each tenant via ACP (proves Nostr transport is live + primes `since` cursor)

`sphere trader spawn` already blocks until the trader container reports ready (via `--ready-timeout-ms`). One ACP smoke call doubles as a transport-layer liveness probe and primes the tenant's Nostr `since` cursor for subsequent DMs (workaround for [sphere-sdk#473](https://github.com/unicity-sphere/sphere-sdk/issues/473)):

```bash
# T1 — first portfolio call doubles as a transport-layer liveness probe.
trader_retry sphere trader portfolio --tenant "@$ALICE_TRADER_TAG"
# T2
trader_retry sphere trader portfolio --tenant "@$BOB_TRADER_TAG"
```

Expected — an empty portfolio at this point (the tenant has its own wallet but no balance yet):

```json
{
  "balances": {},
  "address": "DIRECT://0000..."
}
```

**Talk track:** "These two containers are now autonomous. They have their own secp256k1 keypairs, their own subscriptions to the testnet Nostr relays, and a strategy engine that scans market-api every 30 seconds. Each peer runs its own local Host Manager — no shared HM, no whitelist to negotiate. The HM is just a launcher: once the tenant is RUNNING, the manager is out of the data path. Alice's only relationship with her trader is that the tenant accepts ACP commands signed by her controller pubkey — the same pubkey the local HM was bootstrapped against. Everything else, the tenant decides for itself."

### §3.5 — Optional sidebar: tune strategy before funding

If your demo image's default strategy is too aggressive (or too conservative), bring it in line before §4:

```bash
sphere trader set-strategy --tenant "@$ALICE_TRADER_TAG" \
  --rate-strategy moderate --max-concurrent 1
sphere trader set-strategy --tenant "@$BOB_TRADER_TAG" \
  --rate-strategy moderate --max-concurrent 1
```

`moderate` aims for the midpoint of the overlap band; `aggressive` skews to the band edge that maximizes the bot's take; `conservative` skews the other way. `max-concurrent 1` ensures the bot won't try to start a second deal mid-demo if a stray intent appears. Both can be skipped on a clean testnet.

---

## §4 Fund the tenants (controllers seed working capital)

The tenant's wallet was created empty in §3. The controller now sends in the working capital. The tenant cannot post an intent it can't reserve — the strategy engine pre-flights every intent against current balance.

### T1 — alice seeds 50 UCT into her tenant

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere payments send \
  --recipient "@$ALICE_TRADER_TAG" \
  --amount    50 \
  --coinId    UCT \
  --memo      "trader seed"
```

(`sphere payments send --amount` uses the human-friendly float form; `50` here means 50 UCT, which the CLI converts to `5 × 10^19` smallest-unit internally.)

### T2 — bob seeds 4.5 ETH into his tenant

```bash
cd "$ROOT/peer-bob"
sphere wallet use bob
sphere payments send \
  --recipient "@$BOB_TRADER_TAG" \
  --amount    4.5 \
  --coinId    ETH \
  --memo      "trader seed"
```

(4.5 ETH at 18 decimals = `4.5 × 10^18` smallest-unit internally.)

### Poll until the seed lands

```bash
# T1
for i in {1..40}; do
  bal=$(sphere trader portfolio --tenant "@$ALICE_TRADER_TAG" --json 2>/dev/null \
         | jq -r '.balances.UCT // "0"')
  echo "  alice-trader UCT balance: $bal"
  [ "$bal" != "0" ] && [ -n "$bal" ] && break
  sleep 3
done

# T2
for i in {1..40}; do
  bal=$(sphere trader portfolio --tenant "@$BOB_TRADER_TAG" --json 2>/dev/null \
         | jq -r '.balances.ETH // "0"')
  echo "  bob-trader ETH balance: $bal"
  [ "$bal" != "0" ] && [ -n "$bal" ] && break
  sleep 3
done
```

Expected (after both polls settle):

```text
alice-trader UCT balance: 50000000000000000000
bob-trader ETH balance:   4500000000000000000
```

**Talk track:** "The controller funded the tenant with a regular L3 payment — same wire format as any wallet-to-wallet send. The tenant received it, finalized the token, and updated its internal portfolio. Now the strategy engine sees there's working capital and will accept an intent up to that balance — anything more would fail the precommit reservation when the strategy engine maps the intent to a budget."

---

## §5 Alice posts her SELL intent

The controller's only job in the trading lifecycle is this command. Everything from here until §8 is the tenant.

### T1

```bash
sphere wallet use alice
trader_retry sphere trader create-intent \
  --tenant     "@$ALICE_TRADER_TAG" \
  --direction  sell \
  --base       UCT \
  --quote      ETH \
  --rate-min   0.08 \
  --rate-max   0.12 \
  --volume-min 50 \
  --volume-max 50 \
  --expiry-ms  3600000 \
  --json
```

Rate band, read out loud:
- `rate-min`  = `0.08` ETH per UCT
- `rate-max`  = `0.12` ETH per UCT
- midpoint    = `0.10` ETH per UCT — the price alice and bob's tenants should converge on under the `moderate` strategy.

Volume: alice will sell exactly 50 UCT (`volume-min == volume-max`); at the midpoint rate that earns her 5 ETH.

> **Pre-#474 CLI?** Substitute the bigint values from the [Pre-flight table](#pre-flight-which-form-does-the-cli-accept-float-vs-bigint) in §0 — `0.08` → `80000000000000000`, `0.12` → `120000000000000000`, `50` → `50000000000000000000`.

Expected JSON response excerpt (the wire is bigint regardless of CLI input form):

```json
{
  "ok": true,
  "result": {
    "intent_id":         "i_01HX...",
    "market_intent_id":  "mi_XXXX...",
    "state":             "active",
    "direction":         "sell",
    "base_asset":        "UCT",
    "quote_asset":       "ETH",
    "rate_min":          "80000000000000000",
    "rate_max":          "120000000000000000",
    "volume_min":        "50000000000000000000",
    "volume_max":        "50000000000000000000",
    "expires_at":        "..."
  }
}
```

Cross-verify the intent landed on the market-api:

```bash
curl -fsS "https://market-api.unicity.network/intents?base_asset=UCT&quote_asset=ETH&direction=sell" | jq '.intents[] | select(.market_intent_id == "<the-id-above>")'
```

**Talk track:** "Alice's tenant has now told the market 'I will sell 50 UCT for any rate between 0.08 and 0.12 ETH per UCT.' The intent is signed with the *tenant's* own secp256k1 key — not alice's controller key — and posted to market-api with secp256k1 auth headers. From market-api's perspective, the tenant is a first-class trader: market-api doesn't know or care that there's a controller behind it."

---

## §6 Bob posts the matching BUY intent  ← THE TRIGGER

### T2

```bash
sphere wallet use bob
trader_retry sphere trader create-intent \
  --tenant     "@$BOB_TRADER_TAG" \
  --direction  buy \
  --base       UCT \
  --quote      ETH \
  --rate-min   0.08 \
  --rate-max   0.12 \
  --volume-min 50 \
  --volume-max 50 \
  --expiry-ms  3600000 \
  --json
```

Same rate band as alice — `0.08` to `0.12` ETH per UCT. Same volume — 50 UCT. Opposite direction (buy vs sell). **Overlap is the whole band**; the midpoint `0.10` ETH/UCT is the price both bots will converge on under the `moderate` strategy.

> **Pre-#474 CLI?** Same substitution as §5 — switch the float values for their bigint equivalents.

```bash
BOB_INTENT_ID=$(jq -r '.result.intent_id' <<< "$LAST_JSON")     # or just copy from above
echo "BOB_INTENT_ID=$BOB_INTENT_ID"
```

**Now stop typing.** Tell the audience: "From this point on, no human touches the keyboard until §8 verification. The next thing that happens is one tenant's strategy engine wakes up on its 30-second scan, queries market-api, sees a matching intent on the opposite side, and starts a negotiation. Watch."

**Talk track:** "Two intents are now on the market — one to sell 50 UCT for ETH, one to buy 50 UCT for ETH, both with overlapping rate bands. From the bots' perspective, this is a perfect match: same pair, same volume, overlapping rates. The strategy engine on whichever tenant scans first will pick up the counterparty's intent, decide it's a viable deal, and initiate NP-0 (the negotiation protocol)."

---

## §7 The negotiation (audience watches the bots talk)

This is the demo's payoff. Tail both tenants' state continuously in T3 while you narrate.

### T3 — watch both sides progress

```bash
# In one terminal, two background pollers:
watch -n 5 '
echo "=== alice-trader intents ===";
sphere trader list-intents --tenant "@'"$ALICE_TRADER_TAG"'" --json 2>/dev/null | jq ".intents[] | {intent_id, state}";
echo "=== alice-trader deals ===";
sphere trader list-deals   --tenant "@'"$ALICE_TRADER_TAG"'" --json 2>/dev/null | jq ".deals[] | {deal_id, state, base_volume, rate}";
echo "=== bob-trader intents ===";
sphere trader list-intents --tenant "@'"$BOB_TRADER_TAG"'"   --json 2>/dev/null | jq ".intents[] | {intent_id, state}";
echo "=== bob-trader deals ===";
sphere trader list-deals   --tenant "@'"$BOB_TRADER_TAG"'"   --json 2>/dev/null | jq ".deals[] | {deal_id, state, base_volume, rate}";
'
```

You should see the following sequence over the next 60–120 seconds:

```
t=0s     both intents:  state: active                 deals: (none)
t=30s    one side fires the scan → match found
         that side's intent:    state: matching       deals: [{state: NEGOTIATING}]
t=35s    NP-0 propose_deal DM → counterparty's tenant
         counterparty:          state: matching       deals: [{state: NEGOTIATING}]
t=45s    NP-0 accept_deal DM → both transition to EXECUTING
         both tenants:          deals: [{state: EXECUTING, rate: "10000...", volume: "50..."}]
t=60s    SwapModule.proposeSwap → escrow handshake begins
t=90s    Both sides deposit, escrow validates, payouts emitted
t=120s   Both tenants:          deals: [{state: COMPLETED, ...}]
                                intents: state: filled (or partially filled)
```

If after 2 minutes no tenant has flipped to `NEGOTIATING`, see [§11 — Negotiation timeout](#11-what-to-do-if-a-section-fails-live).

**Talk track (THE PAYOFF):** "Notice nobody touched a keyboard for 90 seconds. The agents found each other on market-api, ran an NP-0 negotiation over NIP-17 gift-wrapped DMs — that's the same encrypted DM channel sphere wallets use for everything else — agreed on a rate and volume inside both their bands, and then handed off to the SwapModule to actually settle on the escrow. The controller — that's alice, the human — is asleep. She'll wake up tomorrow with 5 ETH in her portfolio and a settled deal on the books."

### §7.5 — Optional sidebar: tail tenant logs

If the audience wants to see the bots talking in real time, tail each trader container's logs directly via docker:

```bash
# T1 (alice's machine)
docker logs -f --tail 50 sphere-trader-alice-$SUFFIX
# T2 (bob's machine)
docker logs -f --tail 50 sphere-trader-bob-$SUFFIX
```

(Container names follow the `sphere-trader-<wallet>-<name>` pattern that `sphere trader spawn` uses; `docker ps | grep sphere-trader` will show the exact name if your wallet name differs.)

Look for:
- `intent_matched market_intent_id=mi_… counterparty=DIRECT://…` (the scanner woke up)
- `np.propose_deal sent` / `np.proposal_received` (the protocol handshake)
- `np.accept_deal sent` (deal agreed)
- `SwapModule.proposeSwap → swap_id=…` (handoff to swap settlement)
- `swap:deposit_confirmed` / `swap:completed` (escrow done)

---

## §8 Verify deal completion

Once `watch` shows both sides at `COMPLETED`, snapshot the deal record on each side.

### T1 — alice's view of the deal

```bash
cd "$ROOT/peer-alice"
sphere wallet use alice
sphere trader list-deals --tenant "@$ALICE_TRADER_TAG" --state completed --json | jq '.deals[0]'
```

### T2 — bob's view of the deal

```bash
cd "$ROOT/peer-bob"
sphere wallet use bob
sphere trader list-deals --tenant "@$BOB_TRADER_TAG" --state completed --json | jq '.deals[0]'
```

Both sides should agree on:
- the same `deal_id` (it's content-addressed over the negotiation manifest),
- the same agreed `rate` (e.g. `100000000000000000` for `0.10` ETH/UCT under `moderate` strategy),
- the same agreed `base_volume` (`50000000000000000000`),
- both `state: COMPLETED`,
- both reference the same underlying `swap_id` (the escrow swap that backed the deal).

**Talk track:** "Both tenants independently recorded the same deal — same id, same agreed rate, same volume. The deal record on each side is the bot's local commitment ledger; the underlying swap on the escrow is the cryptographic anchor. If the bots disagreed about any of these fields, the escrow would have refused to release the payouts — atomic settlement enforces consensus."

---

## §9 Verify balances (portfolio view)

### T1 — alice's tenant portfolio

```bash
sphere trader portfolio --tenant "@$ALICE_TRADER_TAG" --json | jq '.balances'
```

Expected:

```json
{
  "UCT": "0",
  "ETH": "5000000000000000000"
}
```

### T2 — bob's tenant portfolio

```bash
sphere trader portfolio --tenant "@$BOB_TRADER_TAG" --json | jq '.balances'
```

Expected:

```json
{
  "UCT": "50000000000000000000",
  "ETH": "0"
}
```

(Bob deposited 4.5 ETH but pays 5 ETH at the midpoint rate. If you want a clean `0` remainder, fund bob with exactly the midpoint payment — `5000000000000000000` — instead of `4500000000000000000`. The default in this playbook leaves a `−500000000000000000` shortfall: the bot will only execute at rates it can cover, so under `moderate` strategy with a `[0.08, 0.12]` band it will skew toward the lower edge to fit, or refuse if no feasible rate covers its budget. For a guaranteed clean outcome, fund bob with at least `6000000000000000000` (6 ETH) and accept that the residue will be left in the tenant.)

### Net delta from baseline (§2)

| Wallet            | Baseline (§2) | After §9            | Δ                       |
|-------------------|---------------|---------------------|-------------------------|
| alice (controller)| 100 UCT, 0 ETH| 50 UCT, 0 ETH       | −50 UCT (seeded to trader) |
| alice-trader      | 0, 0          | 0 UCT, 5 ETH        | **+5 ETH from trade**   |
| bob (controller)  | 0 UCT, 10 ETH | 0 UCT, 5.5 ETH      | −4.5 ETH (seeded to trader) |
| bob-trader        | 0, 0          | 50 UCT, 0 ETH       | **+50 UCT from trade**  |

Roll up alice's controller + alice's tenant: she's `−50 UCT, +5 ETH` net. Roll up bob's: he's `+50 UCT, −4.5 ETH` net (or `−5 ETH` if you topped him up to 6 ETH). Both ledgers balance against the escrow's internal accounting.

**Talk track:** "Atomic — both moved or neither. The rate the bots agreed on splits the overlap band evenly under the `moderate` strategy, so neither side feels squeezed. Notice the trader tenant holds the bought asset, not the controller — the controller would have to send a `payments send` from the tenant back to its own wallet to consolidate. In a long-running trading setup, you'd leave the proceeds in the tenant so it can roll them into the next intent. Alice and Bob can now go to bed; the daemons handle the next round."

---

## §10 Cleanup

### Cancel any leftover intents

If either intent was partially filled or somehow lingered:

```bash
# T1
ALICE_OPEN=$(sphere trader list-intents --tenant "@$ALICE_TRADER_TAG" --state active --json | jq -r '.intents[]?.intent_id')
for id in $ALICE_OPEN; do
  sphere trader cancel-intent --tenant "@$ALICE_TRADER_TAG" --intent-id "$id"
done

# T2
BOB_OPEN=$(sphere trader list-intents --tenant "@$BOB_TRADER_TAG" --state active --json | jq -r '.intents[]?.intent_id')
for id in $BOB_OPEN; do
  sphere trader cancel-intent --tenant "@$BOB_TRADER_TAG" --intent-id "$id"
done
```

### Stop the tenants (or `--keep-hm` for Q&A)

```bash
# T1
cd "$ROOT/peer-alice" && sphere wallet use alice
sphere trader stop --name "$ALICE_TRADER_INSTANCE"

# T2
cd "$ROOT/peer-bob" && sphere wallet use bob
sphere trader stop --name "$BOB_TRADER_INSTANCE"
```

`sphere trader stop` stops the trader tenant and — when the last tenant attached to a given per-user local HM stops — also tears down the HM container. If you want to leave the local HMs running for Q&A so the audience can ask follow-up questions via `sphere trader portfolio` / `list-intents` / `list-deals`, pass `--keep-hm`:

```bash
sphere trader stop --name "$ALICE_TRADER_INSTANCE" --keep-hm
sphere trader stop --name "$BOB_TRADER_INSTANCE"   --keep-hm
```

The tenant processes still stop (the wrapper's local registry is the source of truth — leaving an unregistered tenant alive would orphan it), but the HMs remain so you can `sphere trader spawn` a fresh tenant against them without re-paying the HM bootstrap cost.

### Wipe workspace

```bash
rm -rf "$ROOT"
```

If you want to inspect afterwards: leave `$ROOT` in place; the controller wallet stores are in `$ROOT/peer-alice/.sphere-cli-alice/` and `$ROOT/peer-bob/.sphere-cli-bob/`. The tenant's state lives in the per-user local HM's docker volume — `docker ps` will show the `sphere-hm-<wallet>-*` and `sphere-trader-*` containers and `docker inspect` will show the volume mounts.

---

## §11 What to do if a section fails live

| Symptom | What it means | Demo recovery |
|---|---|---|
| `sphere trader spawn` exits 1 before the JSON document | The wrapper couldn't bring up the local HM (docker daemon down, port collision, template missing). | Verify `docker info` works. Check `docker ps -a | grep sphere-hm` for a stuck container from a previous run — `docker rm -f` it and retry. Confirm the wrapper's templates registry includes `trader-agent`. |
| `sphere trader spawn` ready-timeout exceeded | The trader image started but didn't reach ready before the wrapper's `--ready-timeout-ms` budget. | Tail the trader container with `docker logs -f sphere-trader-<wallet>-<name>` and check for image-pull or first-boot errors. As a workaround, re-run with `--ready-timeout-ms 240000` (4 min) for slow IPFS warmups. |
| Tenant doesn't respond to `sphere trader portfolio` (TimeoutError after 30s) | Either: (a) the trader container died after `spawn` reported ready (check `docker logs`), or (b) the cross-process DM flakiness from [sphere-sdk#473](https://github.com/unicity-sphere/sphere-sdk/issues/473). | Re-run `trader_retry sphere trader portfolio --tenant @<tag>`. If retries also fail, check `docker ps` for the `sphere-trader-<wallet>-<name>` container — if it's gone, re-spawn. |
| `sphere trader create-intent` returns `ok: false` with `INSUFFICIENT_BALANCE` | The strategy engine pre-flighted the intent against current tenant balance and it doesn't fit. | Re-check `sphere trader portfolio` and confirm §4 seed actually landed. If yes, the rate-unit ambiguity may have made the intent volume larger than expected — recompute (see below). |
| `sphere trader create-intent` returns `INVALID_PARAM rate_min must be a non-negative integer string` (or `volume_min …`) | The CLI is on the pre-#474 bigint surface but you passed float values like `0.08`. The float→bigint conversion isn't wired yet, so the CLI sent `"0.08"` verbatim and the trader rejected it. | Switch the demo values from float form to the smallest-unit bigint form using the [Pre-flight table](#pre-flight-which-form-does-the-cli-accept-float-vs-bigint) in §0 (`0.08` → `80000000000000000`, etc.). Re-run create-intent. |
| `sphere trader create-intent` returns `INVALID_PARAM` referencing `rate_min` / `rate_max` for any other reason | Rate-unit ambiguity — the value you sent decodes to something the trader rejects (wrong scale, out-of-range, min > max). | Verify locally with `sphere trader list-intents --tenant @<other-test-tenant>` on a tiny test intent first. **Recompute rate:** if you want rate `R` (quote per base, as a decimal), and both base and quote have 18 decimals, encode rate as `floor(R × 10^18)`. Example: `0.10 ETH/UCT` → `10^17` → `100000000000000000`. |
| Intent appears on market-api but the other tenant never picks it up after 2 min | Either the other tenant's scanner isn't running, or it's filtering out this counterparty (trusted-escrow mismatch). | Tail logs (§7.5) on the other tenant; look for `scan tick` or `match_skipped reason=…` lines. If `trusted_escrows` mismatches, fix with `sphere trader set-strategy --tenant @<tag> --trusted-escrows @escrow-test-02`. |
| Tenant log shows `RATE_UNACCEPTABLE` after a match | The negotiated rate ended up outside one party's band — usually a rate-unit interpretation bug between the two tenants. | Cancel both intents, recompute rates as above, re-post. |
| Negotiation timeout (>2 min, no `DEAL_PROPOSED` exchanged) | Most likely cause is the trader v0.1 image staleness — [DEFAULT_ESCROW_ADDRESS rotation (#468)](https://github.com/unicity-sphere/sphere-sdk/pull/468), [counterparty transport pubkey fail-fast (#459)](https://github.com/unicity-sphere/sphere-sdk/pull/459), or [MuxAdapter await fix (#465)](https://github.com/unicity-sphere/sphere-sdk/pull/465) all changed behaviour. | Rebuild the trader image against sphere-sdk `main` and re-run. As a last-resort live demo recovery: cancel both intents, drop to the **swap playbook** for the back half — the SwapModule layer underneath is the same. |
| Both tenants RUNNING but neither intent appears on market-api after 30 s | market-api unreachable from the tenant, or the tenant's auth signature is being rejected. | Check market-api directly with `curl https://market-api.unicity.network/health`. If reachable, check tenant logs for `market_api: 401` or similar auth errors — that usually means a relay-clock-skew issue or a misconfigured base URL. |
| Deal stuck at `EXECUTING` for >5 min | The escrow handshake is blocked — escrow unreachable, escrow rejected the manifest, or one tenant failed to deposit. | `sphere swap ping @escrow-test-02` first. If escrow is up, ask the tenant for its swap_id and run `sphere swap status <swap_id> --query-escrow` from a peer wallet — the escrow's view tells you which deposit leg is missing. |
| Trader negotiation falls into an `AGENT_BUSY` loop | Two tenants matched simultaneously and both initiated NP-0 — the protocol's symmetry-breaker resolves by lexicographic pubkey comparison; one will back off. | Wait one full scan interval (~30 s). The loser will release the lock and the deal proceeds. If after 60 s nothing has moved, manually cancel the busier intent and re-post. |
| `[Nostr] [AT-LEAST-ONCE] TOKEN_TRANSFER … not durable — leaving 'since' at <ts>` | Background durability verifier couldn't confirm a previous event landed durably on the relay. Independent of trader flow. | Continue the demo. |

### Rate unit recompute helper

If `list-intents --json` shows your `rate_min` / `rate_max` round-tripping to values larger or smaller than expected by a factor of `10^N`:

```bash
# You wanted 0.10 ETH/UCT, but the tenant stored 1e35. That's a 10^18 scale-up.
# Re-encode at 10^17 instead of 10^35 (i.e. divide by 10^18):
echo "DESIRED_RATE × 10^17" | bc                  # 0.10 → 10000000000000000

# Or, for arbitrary precision and decimals:
python3 -c 'import sys; R, decimals = float(sys.argv[1]), int(sys.argv[2]); print(int(R * 10**decimals))' 0.10 17
# → 10000000000000000
```

The `decimals` value in the helper above is the **exponent the deployed image expects** — confirm with the verification recipe in §0 before adjusting.

---

## §12 Optional — the automated soak

Everything in this playbook is the script [`manual-test-trader-roundtrip.sh`](../manual-test-trader-roundtrip.sh) in the SDK repo:

```bash
cd <sphere-sdk-checkout>
bash manual-test-trader-roundtrip.sh                            # default scenario
KEEP=1 bash manual-test-trader-roundtrip.sh                     # preserve workspace
KEEP_TENANTS=1 bash manual-test-trader-roundtrip.sh             # leave per-user HMs running (--keep-hm)
ESCROW=@my-escrow bash manual-test-trader-roundtrip.sh          # override escrow
SUFFIX=demo01 bash manual-test-trader-roundtrip.sh              # deterministic tags
```

A green run prints `ALL GREEN — trader round-trip soak succeeded` and exits 0.

The soak script:
- Builds the same alice/bob controller wallets.
- Spawns the same `trader-agent` tenants with the same env.
- Funds each tenant.
- Posts both intents.
- **Polls** `list-deals --state completed` on both sides (up to a configurable budget).
- Asserts the `deal_id` matches across sides, the agreed rate sits inside the overlap band, and the portfolios reflect the agreed flow.
- Cleans up unless `KEEP=1` / `KEEP_TENANTS=1`.

Use the script for CI / nightly soaks; use this playbook for human demos.

---

## Presenter cheat sheet

```text
   §0  $ROOT, $ALICE_TAG, $BOB_TAG, $ALICE_TRADER_TAG, $BOB_TRADER_TAG, $ESCROW
       SPHERE_ALLOW_MNEMONIC_NON_TTY=1
       trader_retry() helper for #473 flakiness
       Pre-flight: docker info, sphere swap ping @escrow-test-02, market-api curl

   §1  sphere wallet create / use / init --nametag       ×2 controller wallets
       capture ALICE_PUBKEY, BOB_PUBKEY  (chainPubkey)

   §2  sphere faucet 100 UCT   (alice controller)
       sphere faucet  10 ETH   (bob controller)            ← asymmetric on purpose

   §3  sphere trader spawn --name alice-trader-$SUFFIX
                            --trusted-escrows @escrow-test-02 --json
       (and the same for bob — each peer brings up its OWN local HM)
       Wrapper blocks until trader image reports ready.
       First successful sphere trader portfolio = transport-layer liveness proof.
                                       ← BIG MOMENT: "autonomous agents are now alive"

   §4  sphere payments send → @alice-trader  --amount 50  --coinId UCT
       sphere payments send → @bob-trader    --amount 4.5 --coinId ETH
       Poll sphere trader portfolio --json until seed lands.

   §5  sphere trader create-intent --tenant @alice-trader
            --direction sell --base UCT --quote ETH
            --rate-min 0.08 --rate-max 0.12
            --volume-min 50 --volume-max 50
            --expiry-ms 3600000
            (pre-#474 CLI: substitute bigint form per §0)

   §6  sphere trader create-intent --tenant @bob-trader
            --direction buy  --base UCT --quote ETH
            --rate-min 0.08 --rate-max 0.12
            --volume-min 50 --volume-max 50
            --expiry-ms 3600000
                                       ← TRIGGER: stop typing now

   §7  Tail both sides with watch -n 5 'list-intents + list-deals'
       Expected: state: active → matching → NEGOTIATING → EXECUTING → COMPLETED
       Talk track: "nobody is touching a keyboard"

   §8  sphere trader list-deals --tenant @alice-trader --state completed
       sphere trader list-deals --tenant @bob-trader   --state completed
       Same deal_id, same rate, same volume, both COMPLETED.

   §9  sphere trader portfolio --tenant @alice-trader   → UCT 0, ETH ~5e18
       sphere trader portfolio --tenant @bob-trader     → UCT 5e19, ETH residue
       "Alice and Bob can now go to bed; the daemons handle the next round."

   §10 cancel-intent leftovers, sphere trader stop --name both tenants, rm -rf $ROOT
       (or sphere trader stop --keep-hm for Q&A)
```

### Command quick reference

| When you want to… | Run |
|---|---|
| Spawn a trader tenant | `sphere trader spawn --name <name> --trusted-escrows @<escrow> [--scan-interval-ms <ms>] [--ready-timeout-ms <ms>] [--json]` (brings up a per-user local HM + trader tenant) |
| Probe tenant liveness | `sphere trader portfolio --tenant @<tag>` (ACP — first successful call doubles as a transport-layer liveness probe) |
| Post a trading intent | `sphere trader create-intent --tenant @<tag> --direction <buy\|sell> --base <coin> --quote <coin> --rate-min <float> --rate-max <float> --volume-min <float> --volume-max <float>` (post-#474 UX; on pre-fix CLI, see [Pre-flight table](#pre-flight-which-form-does-the-cli-accept-float-vs-bigint)) |
| List the tenant's intents | `sphere trader list-intents --tenant @<tag> [--state active\|filled\|cancelled\|expired]` |
| Cancel an intent | `sphere trader cancel-intent --tenant @<tag> --intent-id <id>` |
| List the tenant's deals | `sphere trader list-deals --tenant @<tag> [--state active\|completed\|failed]` |
| Show tenant balance | `sphere trader portfolio --tenant @<tag>` |
| Tune trader strategy | `sphere trader set-strategy --tenant @<tag> [--rate-strategy aggressive\|moderate\|conservative] [--max-concurrent <n>] [--trusted-escrows @e1,@e2]` |
| Stop a tenant | `sphere trader stop --name <name> [--keep-hm]` (auto-tears down the per-user HM when the last tenant stops; `--keep-hm` leaves it running for Q&A) |
| Pre-flight escrow liveness | `sphere swap ping @escrow-test-02` |

### Exit codes that matter

| Command | Exit | Meaning |
|---|---|---|
| `sphere trader spawn`          | 0   | per-user HM up + tenant ready (final JSON document emitted) |
| `sphere trader spawn`          | 1   | docker unavailable, port collision, template missing, or ready-timeout exceeded |
| `sphere trader stop`           | 0   | tenant stopped (HM auto-torn-down unless `--keep-hm`) |
| `sphere trader stop`           | 1   | name not found in wrapper's local registry, or docker error |
| `sphere trader create-intent`  | 0   | intent accepted; `result.intent_id` returned |
| `sphere trader create-intent`  | 1   | rejected (`INVALID_PARAM`, `INSUFFICIENT_BALANCE`, transport timeout) |
| `sphere trader cancel-intent`  | 0   | cancelled; tenant flipped state to `cancelled` |
| `sphere trader cancel-intent`  | 1   | not found, already terminal, or transport error |
| `sphere trader list-deals`     | 0   | one or more matching deals returned (possibly empty array under `--state`) |
| `sphere trader list-deals`     | 1   | transport error / tenant unreachable / `--limit` invalid |
| `sphere trader portfolio`      | 0   | balances returned (possibly empty) |
| `sphere trader portfolio`      | 1   | transport error / tenant unreachable |
| `sphere trader set-strategy`   | 0   | strategy updated |
| `sphere trader set-strategy`   | 1   | no fields provided, invalid value, or transport error |
