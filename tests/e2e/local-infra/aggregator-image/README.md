# Unicity aggregator stack — ssl-manager-wrapped

Deploys the full L3 aggregator stack (bft-root + bft-aggregator-genesis-gen
+ mongo + aggregator-go) behind a tiny ssl-manager-wrapped nginx
that terminates TLS on :443 with a real Let's Encrypt cert and
registers with the host HAProxy.

## Architecture

```
        Internet
            │
            ▼
   HAProxy (host) :443  ── TCP SNI passthrough ──┐
                                                 │
                                                 ▼
  ┌────────────────────────────────────────────────────────────┐
  │ haproxy-net (external)                                      │
  │                                                             │
  │   ┌──────────────────────────────────────────────────────┐  │
  │   │  agg-proxy (unicity-aggregator-proxy:latest)         │  │
  │   │  ssl-manager + nginx                                 │  │
  │   │  :443 (TLS termination, LE cert)                     │  │
  │   └────────────────────────┬─────────────────────────────┘  │
  │                            │                                │
  └────────────────────────────┼────────────────────────────────┘
                               │ plain HTTP
                               ▼
  ┌────────────────────────────────────────────────────────────┐
  │ agg-internal-net (private)                                  │
  │                                                             │
  │   agg-aggregator  ──── mongodb ─── bft-root                 │
  │   (:3000 HTTP)         (:27017)    (BFT consensus)          │
  └────────────────────────────────────────────────────────────┘
```

- The proxy is the ONLY container exposed to HAProxy.
- The aggregator, BFT nodes, and Mongo live on a private network
  with no external reachability.
- TLS is terminated by nginx; the aggregator binary itself runs with
  `ENABLE_TLS=false`.

## Build & deploy

```bash
./run-aggregator.sh \
  --domain aggregator-unicity-dev.dyndns.org \
  --ssl-email ops@example.com
```

The script:
1. Verifies the external `haproxy-net` exists.
2. Builds the `unicity-aggregator-proxy:latest` image from `proxy/`.
3. Brings up the compose stack with `docker compose up -d`.
4. Polls the proxy `:443` until it responds.
5. Runs an external HTTPS reachability check on the public domain.

### First run

On first run:
- `bft-root` mints a fresh trust-base (`./data/genesis/trust-base.json`).
- `bft-aggregator-genesis-gen` mints aggregator partition config.
- `upload-configurations` POSTs the partition config to `bft-root`.
- `aggregator` starts.
- `agg-proxy` runs `ssl-setup` to acquire the LE cert, then
  registers with HAProxy.

Total cold-start time: ~60–120s (most of it is cert issuance).

### Subsequent runs

Existing genesis files and the mongo volume are reused —
deterministic across restarts.

## Wallet integration

Per issue #321 § "Open decisions", we did NOT publish the trust-base
via a `/.well-known/trust-base.json` endpoint. Browser wallets must
use `sphereDev.setSkipTrustBase(true)` when pointing at this
aggregator. Soak-test Node clients can copy the trust-base out:

```bash
docker cp agg-aggregator:/app/bft-config/trust-base.json ./trust-base.json
```

## Reset

```bash
# Tear down, keep state.
./run-aggregator.sh --down

# Tear down + WIPE state (fresh genesis on next run).
./run-aggregator.sh --down --fresh
```

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Proxy keeps restarting | `docker logs agg-proxy` — usually a cert-acquisition error. Check that DNS for `--domain` resolves to the host, and port 80 is reachable from Let's Encrypt servers. |
| Aggregator unhealthy | `docker logs agg-aggregator` — usually `BFT_BOOTSTRAP_ADDRESSES` couldn't be derived. Wipe `./data/genesis` and start fresh. |
| HAProxy backend not listed | `curl http://127.0.0.1:8404/v1/backends` — proxy may have failed to register. |
| 502 from `https://<domain>` | Aggregator backend not yet healthy. `docker compose ps`. |

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Full multi-container stack |
| `proxy/Dockerfile` | ssl-manager + nginx proxy image |
| `proxy/entrypoint.sh` | ssl-setup → haproxy-register → nginx |
| `proxy/nginx.conf.template` | nginx config template |
| `run-aggregator.sh` | Orchestrator wrapper |
