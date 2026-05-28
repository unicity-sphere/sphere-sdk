# Unicity testnet faucet — ssl-manager-wrapped image

Wraps the upstream `ghcr.io/unicitynetwork/agentic-hosting/faucet`
binary with the ssl-manager base image so the faucet can be deployed
under a real domain with Let's Encrypt + the HAProxy auto-registration
API.

## What this image gives you

- A real HTTPS endpoint at `https://<your-domain>/.well-known/faucet.json`
  that wallets can query for the faucet's chain pubkey.
- Automatic Let's Encrypt cert acquisition and renewal (via the
  ssl-manager base image's `ssl-setup` + `ssl-renew`).
- Dynamic HAProxy backend registration via `haproxy-register`.
- A persistent Docker volume for the faucet's derived wallet, so the
  faucet's pubkey stays stable across container restarts.

The faucet itself remains Nostr-DM driven — wallets request faucet
funds by sending a NIP-17 encrypted DM to the faucet's chain pubkey
via the configured Nostr relay. The HTTPS surface is purely for
identity discovery.

## Build

```bash
# 1. Make sure the upstream js-faucet image is available locally:
docker pull ghcr.io/unicitynetwork/agentic-hosting/faucet:local
#  OR build it from source:
#  cd /home/vrogojin && docker build -f js-faucet/Dockerfile \
#       -t ghcr.io/unicitynetwork/agentic-hosting/faucet:local .

# 2. Build the SSL wrapper:
docker build \
  -f tests/e2e/local-infra/faucet-image/Dockerfile \
  -t unicity-faucet-tls:latest \
  tests/e2e/local-infra/faucet-image/
```

## Deploy

```bash
# Dev — no SSL, exposes nginx on host port 8080
./run-faucet.sh

# Production — SSL + HAProxy
./run-faucet.sh \
  --domain faucet-unicity-dev.dyndns.org \
  --ssl-email ops@example.com \
  --haproxy-host haproxy \
  --nostr-relays wss://nostr-unicity-dev.dyndns.org
```

The first deploy generates a fresh mnemonic and persists the derived
wallet to the `unicity-faucet-identity` Docker volume. Subsequent
deploys load the existing identity. **Fund the resulting L1 address
before the faucet is useful**:

```bash
docker exec unicity-faucet cat /var/lib/faucet/identity.json | jq .
# → "chain_pubkey": "02ab...",   "direct_address": "DIRECT://02ab..."
# → send testnet ALPHA to the resulting L1 address.
```

## Discovery

Wallets that want to fund themselves from this faucet:

```bash
curl -s https://faucet-unicity-dev.dyndns.org/.well-known/faucet.json | jq .
# {
#   "status": "running",
#   "chain_pubkey": "02...",
#   "direct_address": "DIRECT://02...",
#   "supported_coins": []
# }
```

Then send a NIP-17 encrypted Nostr DM (`FAUCET_REQUEST`) to the
`chain_pubkey` via the relay.

## Known issues

### Faucet startup against `unicity-tokens-relay` (kind blocklist)

The pinned `ghcr.io/unicitynetwork/unicity-tokens-relay:sha-1e1b544`
relay image used by `tests/e2e/local-infra/relay-image/` REJECTS some
of the event kinds the js-faucet publishes at startup (observed:
`Event rejected: blocked: event kind is blocked by relay`). The
faucet process then exits with `faucet_acp_startup_failed`.

The container is supervisor-wrapped — the faucet is restarted on
crash but the discovery endpoint stays available throughout. The
chain pubkey announced before the crash is persisted in
`/var/lib/faucet/identity.json` and remains served via the
`.well-known/faucet.json` URL.

Workaround: point the faucet at a less restrictive relay:

```bash
./run-faucet.sh \
  --domain faucet-unicity-dev.dyndns.org \
  --ssl-email ops@example.com \
  --haproxy-host haproxy \
  --nostr-relays wss://nostr-relay.testnet.unicity.network
```

Long-term fix: either relax `unicity-tokens-relay`'s kind blocklist
to permit `NAMETAG_BINDING (30078)` + `DIRECT_MESSAGE (4)`, or pin
a different relay image for general-purpose use.

## Reset

```bash
docker rm -f unicity-faucet
docker volume rm unicity-faucet-identity   # WIPES the faucet's wallet
# Re-run run-faucet.sh; a fresh mnemonic is generated.
```
