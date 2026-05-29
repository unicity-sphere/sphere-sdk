# tests/e2e/local-infra/relay-image/Dockerfile
#
# ssl-manager-wrapped Nostr relay.
#
# The upstream image (ghcr.io/unicitynetwork/unicity-tokens-relay)
# is a thin nostr-rs-relay binary that listens on plain WebSocket
# at :8080. We add:
#   - ssl-manager base (certbot + haproxy-register + tini)
#   - nginx to terminate WSS on :443 and proxy to the relay on :8080
#   - persistent SQLite event log at /var/lib/relay/db/
#
# The HAProxy in front of us runs in `mode tcp` (SNI passthrough), so
# the cert MUST be terminated INSIDE this container — we cannot rely
# on HAProxy to do it. ssl-manager handles cert acquisition; nginx
# handles termination.
#
# Build (from the sphere-sdk repo root):
#   docker build \
#     -f tests/e2e/local-infra/relay-image/Dockerfile \
#     -t unicity-relay-tls:latest \
#     tests/e2e/local-infra/relay-image/

# ---------------------------------------------------------------------------
# Stage 1: pull the relay binary off the upstream image
# ---------------------------------------------------------------------------
ARG RELAY_IMAGE=ghcr.io/unicitynetwork/unicity-tokens-relay:sha-1e1b544
FROM ${RELAY_IMAGE} AS relay-src

# ---------------------------------------------------------------------------
# Stage 2: ssl-manager + nginx + relay binary
# ---------------------------------------------------------------------------
FROM ghcr.io/unicitynetwork/ssl-manager:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
        tini nginx supervisor sqlite3 ca-certificates \
        libssl3 gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Copy the relay binary off the upstream image. Strip the relay's
# default config + db (we provide our own).
COPY --from=relay-src /usr/src/app/nostr-rs-relay /usr/local/bin/nostr-rs-relay
RUN chmod 755 /usr/local/bin/nostr-rs-relay && \
    /usr/local/bin/nostr-rs-relay --help >/dev/null 2>&1 || \
        (echo "ERROR: nostr-rs-relay binary not runnable" >&2 && exit 1)

# Relay state lives in /var/lib/relay (mounted as a volume).
RUN useradd -r -m -d /var/lib/relay -u 1001 relay && \
    mkdir -p /var/lib/relay/db /etc/relay && \
    chown -R relay:relay /var/lib/relay /etc/relay

COPY config.toml.template /etc/relay/config.toml.template
COPY nginx-wss.conf.template /etc/nginx/templates/wss.conf.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

VOLUME ["/etc/letsencrypt", "/var/lib/relay"]

# Ports
# 8080 — internal HTTP/WS (relay binary), proxied by nginx on :443
# 443  — WSS (nginx terminates TLS, proxies to :8080)
# 80   — already EXPOSE'd by ssl-manager base (acme-challenge + redirect)
EXPOSE 8080 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS -H 'Accept: application/nostr+json' http://127.0.0.1:8080/ >/dev/null || exit 1

ENV RELAY_DATA_DIR=/var/lib/relay/db \
    RELAY_NAME="Unicity dev relay" \
    RELAY_DESCRIPTION="Local Unicity testnet relay (ssl-manager-wrapped)" \
    RUST_LOG="info,nostr_rs_relay=info" \
    RELAY_PORT=8080

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
