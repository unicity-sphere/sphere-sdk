# Unicity Nostr relay — ssl-manager-wrapped image

Wraps `ghcr.io/unicitynetwork/unicity-tokens-relay:sha-1e1b544` with
the ssl-manager base image, terminating WSS on :443 with a real
Let's Encrypt certificate and registering itself with the HAProxy
auto-registration API.

## What this image gives you

- A real WSS endpoint at `wss://<your-domain>` that web wallets can
  connect to without certificate warnings.
- The NIP-11 info document at `https://<your-domain>/` (with
  `Accept: application/nostr+json`).
- Automatic Let's Encrypt cert acquisition + renewal.
- Dynamic HAProxy backend registration.
- A persistent Docker volume holding the SQLite event log
  (`/var/lib/relay/db/nostr.db`).

## Why we terminate TLS in-container

The host HAProxy runs in `mode tcp` with SNI passthrough — it does
NOT terminate TLS. Each container holds its own cert. nginx inside
this image does the TLS handshake, then proxies the (now-plaintext)
WebSocket upgrade to `nostr-rs-relay` on :8080.

## Build

```bash
docker build \
  -f tests/e2e/local-infra/relay-image/Dockerfile \
  -t unicity-relay-tls:latest \
  tests/e2e/local-infra/relay-image/
```

## Deploy

```bash
# Dev — plaintext WS on localhost:8080 only
./run-relay.sh

# Production — WSS + HAProxy
./run-relay.sh \
  --domain nostr-unicity-dev.dyndns.org \
  --ssl-email ops@example.com \
  --haproxy-host haproxy
```

## Inspect

```bash
# Live event count (great for confirming the relay is being used).
docker exec unicity-relay sqlite3 /var/lib/relay/db/nostr.db 'SELECT COUNT(*) FROM event'

# Tail the log.
docker logs -f unicity-relay
```

## Reset

```bash
docker rm -f unicity-relay
docker volume rm unicity-relay-data   # wipes the SQLite event log
```
