# tests/e2e/local-infra/faucet-image/Dockerfile
#
# ssl-manager-wrapped js-faucet image.
#
# Builds on top of an existing js-faucet runtime image
# (ghcr.io/unicitynetwork/agentic-hosting/faucet:local). Adds:
#   - ssl-manager base (certbot + haproxy-register + tini)
#   - a tiny nginx that exposes :8080 (HTTP) and is reverse-proxied
#     by ssl-manager on :443 (HTTPS). nginx serves a JSON discovery
#     document (the faucet's chain pubkey + supported coins) so
#     wallets can find the faucet by domain.
#
# The faucet itself is purely Nostr-DM driven (no public REST
# endpoint), so the only thing the HTTPS surface needs to do is
# advertise the faucet's identity for wallet discovery.
#
# Build (from the sphere-sdk repo root):
#   docker build \
#     -f tests/e2e/local-infra/faucet-image/Dockerfile \
#     -t unicity-faucet-tls:latest \
#     tests/e2e/local-infra/faucet-image/
#
# Requires the upstream js-faucet image to be present locally
# (it's tagged `:local` because it's built on the deployment host —
# the tag is NOT served by GHCR). Build it via:
#
#   git clone https://github.com/unicitynetwork/js-faucet ../js-faucet
#   git clone https://github.com/unicity-sphere/sphere-sdk ../sphere-sdk
#   cd .. && docker build -f js-faucet/Dockerfile \
#       -t ghcr.io/unicitynetwork/agentic-hosting/faucet:local .
#
# Override with --build-arg FAUCET_IMAGE=... to use a different tag.

# ---------------------------------------------------------------------------
# Stage 1: extract js-faucet runtime + node_modules from the upstream image
# ---------------------------------------------------------------------------
ARG FAUCET_IMAGE=ghcr.io/unicitynetwork/agentic-hosting/faucet:local
FROM ${FAUCET_IMAGE} AS faucet-src

# ---------------------------------------------------------------------------
# Stage 2: ssl-manager + node + nginx + faucet
# ---------------------------------------------------------------------------
FROM ghcr.io/unicitynetwork/ssl-manager:latest

# ssl-manager already includes: certbot, openssl, curl, jq,
# netcat-openbsd, python3, procps, ca-certificates. We need
# Node.js to run the faucet and nginx for the HTTPS discovery
# surface.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg tini nginx supervisor gettext-base \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy the faucet's compiled application from the upstream image.
# The upstream image's WORKDIR contains node_modules + dist; we
# inherit the entire tree so npm doesn't have to reinstall.
COPY --from=faucet-src /app /opt/faucet

# Resilience: some upstream tags ship the app under /usr/src/app.
# Fall back to that if /opt/faucet is empty.
RUN if [ ! -f /opt/faucet/package.json ]; then \
        rm -rf /opt/faucet && \
        cp -a /usr/src/app /opt/faucet 2>/dev/null || true; \
    fi && \
    test -f /opt/faucet/package.json || (echo "ERROR: faucet sources not found in upstream image" >&2 && exit 1)

# Identity persistence: the faucet writes its derived wallet under
# /var/lib/faucet on first boot. Volume-mount this to keep the
# faucet's pubkey stable across container restarts.
RUN mkdir -p /var/lib/faucet && chmod 700 /var/lib/faucet

# Nginx config + scripts.
COPY nginx-discovery.conf.template /etc/nginx/templates/discovery.conf.template
COPY nginx-tls.conf.template       /etc/nginx/templates/tls.conf.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY render-discovery.sh /usr/local/bin/render-discovery.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/render-discovery.sh

# Volumes declared for documentation. Explicit -v mounts are always used.
VOLUME ["/etc/letsencrypt", "/var/lib/faucet"]

# Ports
# 8080 - nginx (HTTP, proxied to :443 by ssl-manager when SSL is enabled)
# 443  - HTTPS via ssl-manager's reverse proxy
# 80   - HTTP (acme-challenge + redirect) is EXPOSE'd by the base image
EXPOSE 8080 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/.well-known/faucet.json >/dev/null || exit 1

ENV FAUCET_HOME=/var/lib/faucet \
    FAUCET_DISCOVERY_PORT=8080 \
    UNICITY_NETWORK=testnet \
    UNICITY_LOG_LEVEL=info \
    UNICITY_HEARTBEAT_INTERVAL_MS=60000

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
