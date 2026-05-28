#!/bin/bash
# tests/e2e/local-infra/faucet-image/entrypoint.sh
#
# 1. ssl-setup     — acquire / renew the LE cert for $SSL_DOMAIN
# 2. haproxy-register register — POST to the HAProxy /v1/backends API
# 3. start nginx   — serves :8080 (discovery JSON), proxied to :443 by ssl-manager
# 4. start faucet  — js-faucet's ACP-adapter main loop
#
# The faucet writes its derived wallet under /var/lib/faucet on first
# boot, then surfaces its chain_pubkey on stdout (and into a file
# /var/lib/faucet/identity.json that nginx serves via the discovery
# endpoint). Volume-mount /var/lib/faucet to preserve the identity.

set -euo pipefail

log() { printf '[faucet-entrypoint] %s\n' "$*" >&2; }

# ─── Signal handling ─────────────────────────────────────────────────────────
SHUTDOWN_REQUESTED=0
FAUCET_PID=
NGINX_PID=

handle_signal() {
    local sig="$1"
    log "received SIG${sig}, shutting down…"
    SHUTDOWN_REQUESTED=1

    if [ -n "${SSL_DOMAIN:-}" ] && [ -n "${HAPROXY_HOST:-}" ]; then
        log "deregistering from HAProxy…"
        haproxy-register unregister 2>/dev/null || true
    fi

    [ -n "$FAUCET_PID" ] && kill -TERM "$FAUCET_PID" 2>/dev/null || true
    [ -n "$NGINX_PID" ]  && kill -QUIT "$NGINX_PID" 2>/dev/null || true

    # Best-effort: stop the renewal loop spawned by ssl-setup.
    if [ -f /tmp/.ssl-renew.pid ]; then
        local pid; pid=$(cat /tmp/.ssl-renew.pid 2>/dev/null || true)
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    fi
}
trap 'handle_signal TERM' SIGTERM
trap 'handle_signal INT'  SIGINT

# ─── Step 1: SSL setup ───────────────────────────────────────────────────────
if [ -n "${SSL_DOMAIN:-}" ]; then
    log "running ssl-setup for $SSL_DOMAIN…"
    ssl-setup
else
    log "SSL_DOMAIN not set — skipping cert acquisition (dev mode)"
fi

# ─── Step 2: HAProxy registration ───────────────────────────────────────────
if [ -n "${SSL_DOMAIN:-}" ] && [ -n "${HAPROXY_HOST:-}" ]; then
    log "registering with HAProxy at $HAPROXY_HOST…"
    haproxy-register register || log "WARN: haproxy registration failed (continuing)"
fi

# ─── Step 3: nginx for the discovery endpoint ───────────────────────────────
# 755 on the dir + world-readable identity.json so nginx (www-data)
# can serve the file. The contents are public anyway — the faucet's
# pubkey is meant to be discoverable.
mkdir -p /var/lib/faucet
chmod 755 /var/lib/faucet

# Render nginx config(s).
export DISCOVERY_PORT="${FAUCET_DISCOVERY_PORT:-8080}"
envsubst '${DISCOVERY_PORT}' \
    < /etc/nginx/templates/discovery.conf.template \
    > /etc/nginx/sites-enabled/discovery.conf

# TLS block only when the cert is in place.
if [ -n "${SSL_DOMAIN:-}" ] && \
   [ -f "/etc/letsencrypt/live/${SSL_DOMAIN}/fullchain.pem" ] && \
   [ -f "/etc/letsencrypt/live/${SSL_DOMAIN}/privkey.pem" ]; then
    envsubst '${SSL_DOMAIN}' \
        < /etc/nginx/templates/tls.conf.template \
        > /etc/nginx/sites-enabled/tls.conf
    log "TLS termination enabled on :443"
fi

# Prime the discovery doc with a placeholder until the faucet
# announces its real pubkey. /var/lib/faucet/identity.json is
# overwritten by render-discovery.sh once the faucet logs
# chain_pubkey.
if [ ! -f /var/lib/faucet/identity.json ]; then
    cat > /var/lib/faucet/identity.json <<EOF
{
  "status": "starting",
  "domain": "${SSL_DOMAIN:-localhost}",
  "network": "${UNICITY_NETWORK:-testnet}",
  "chain_pubkey": null,
  "direct_address": null,
  "supported_coins": []
}
EOF
fi
chmod 644 /var/lib/faucet/identity.json

# Remove Debian nginx default site so it doesn't try to bind :80
# (which is owned by ssl-manager's ssl-http-proxy for ACME challenges).
rm -f /etc/nginx/sites-enabled/default

log "starting nginx on :${DISCOVERY_PORT}…"
nginx -g 'daemon off;' &
NGINX_PID=$!

# ─── Step 4: faucet (js-faucet ACP-adapter) ─────────────────────────────────
# Build tenant env. We need valid UNICITY_MANAGER_PUBKEY (on-curve
# secp256k1) etc. for the tenant-config validator to pass. When
# deploying as a standalone faucet (no Host Manager), generate a
# throwaway manager keypair if none was injected.
if [ -z "${UNICITY_MANAGER_PUBKEY:-}" ]; then
    log "generating throwaway UNICITY_MANAGER_PUBKEY (no host-manager handshake)…"
    # cd into /opt/faucet so node resolves @noble/curves from the
    # faucet's local node_modules.
    UNICITY_MANAGER_PUBKEY=$(cd /opt/faucet && node --eval '
        const { secp256k1 } = require("@noble/curves/secp256k1.js");
        const { randomBytes } = require("crypto");
        process.stdout.write(Buffer.from(
            secp256k1.getPublicKey(randomBytes(32), true)
        ).toString("hex"));
    ' --input-type=commonjs)
    export UNICITY_MANAGER_PUBKEY
    export UNICITY_MANAGER_DIRECT_ADDRESS="DIRECT://${UNICITY_MANAGER_PUBKEY}"
fi

# Required tenant-config fields.
: "${UNICITY_BOOT_TOKEN:=$(cat /proc/sys/kernel/random/uuid)}"
: "${UNICITY_INSTANCE_ID:=$(cat /proc/sys/kernel/random/uuid)}"
: "${UNICITY_INSTANCE_NAME:=local-faucet-${UNICITY_INSTANCE_ID:0:8}}"
: "${UNICITY_TEMPLATE_ID:=faucet-agent}"
: "${UNICITY_NETWORK:=testnet}"
: "${UNICITY_LOG_LEVEL:=info}"
: "${UNICITY_HEARTBEAT_INTERVAL_MS:=60000}"
export UNICITY_BOOT_TOKEN UNICITY_INSTANCE_ID UNICITY_INSTANCE_NAME \
       UNICITY_TEMPLATE_ID UNICITY_NETWORK UNICITY_LOG_LEVEL \
       UNICITY_HEARTBEAT_INTERVAL_MS

# Relay URL — passed through SPHERE_NOSTR_RELAYS so the SDK's
# createNodeProviders applies it as a hard override. Default is
# the new local relay; override at deploy time with --nostr-relays.
: "${SPHERE_NOSTR_RELAYS:=wss://nostr-unicity-dev.dyndns.org}"
export SPHERE_NOSTR_RELAYS

# Wallet path so the derived mnemonic is persisted across restarts.
: "${UNICITY_WALLET_DIR:=/var/lib/faucet}"
export UNICITY_WALLET_DIR

log "spawning js-faucet (network=$UNICITY_NETWORK, relays=$SPHERE_NOSTR_RELAYS)…"
# Run the faucet under a small supervisor loop. If the faucet exits
# (e.g. because the configured relay rejects one of its startup
# events — see README "Known issues"), we DO NOT tear down the
# container: nginx keeps serving the discovery endpoint and the
# Let's Encrypt cert keeps getting renewed. Operators can restart
# the faucet process by `docker restart unicity-faucet`.
supervise_faucet() {
    local backoff=5
    while true; do
        log "starting faucet process…"
        ( cd /opt/faucet && node dist/acp-adapter/main.js 2>&1 \
            | tee >(/usr/local/bin/render-discovery.sh) ) || true
        log "faucet exited; restarting in ${backoff}s (backoff caps at 60s)"
        sleep "$backoff"
        # Exponential backoff up to 60s so we don't hot-loop on
        # persistent failures.
        backoff=$(( backoff * 2 ))
        [ "$backoff" -gt 60 ] && backoff=60
    done
}

supervise_faucet &
FAUCET_PID=$!

# Wait for either child to exit. nginx exiting is fatal; the
# supervisor loop above prevents faucet exits from reaching here.
wait -n "$NGINX_PID"
exit_code=$?
log "nginx exited with $exit_code, terminating…"
handle_signal TERM
exit "$exit_code"
