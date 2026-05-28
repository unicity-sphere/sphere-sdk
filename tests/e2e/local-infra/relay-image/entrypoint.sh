#!/bin/bash
# tests/e2e/local-infra/relay-image/entrypoint.sh
#
# 1. ssl-setup     — acquire / renew Let's Encrypt cert
# 2. haproxy-register register
# 3. start nostr-rs-relay (binds :8080)
# 4. start nginx (binds :443 with the LE cert, proxies WSS → :8080)

set -euo pipefail

log() { printf '[relay-entrypoint] %s\n' "$*" >&2; }

# ─── Signal handling ─────────────────────────────────────────────────────────
RELAY_PID=
NGINX_PID=

handle_signal() {
    local sig="$1"
    log "received SIG${sig}, shutting down…"

    if [ -n "${SSL_DOMAIN:-}" ] && [ -n "${HAPROXY_HOST:-}" ]; then
        log "deregistering from HAProxy…"
        haproxy-register unregister 2>/dev/null || true
    fi

    [ -n "$NGINX_PID" ] && kill -QUIT "$NGINX_PID" 2>/dev/null || true
    [ -n "$RELAY_PID" ] && kill -TERM "$RELAY_PID" 2>/dev/null || true

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
    log "SSL_DOMAIN not set — running plaintext only (dev mode)"
fi

# ─── Step 2: HAProxy registration ───────────────────────────────────────────
if [ -n "${SSL_DOMAIN:-}" ] && [ -n "${HAPROXY_HOST:-}" ]; then
    log "registering with HAProxy at $HAPROXY_HOST…"
    haproxy-register register || log "WARN: haproxy registration failed (continuing)"
fi

# ─── Step 3: render config.toml ─────────────────────────────────────────────
mkdir -p "$RELAY_DATA_DIR"
chown -R relay:relay /var/lib/relay 2>/dev/null || true

export RELAY_URL="wss://${SSL_DOMAIN:-localhost}"
envsubst '${RELAY_URL} ${RELAY_NAME} ${RELAY_DESCRIPTION} ${RELAY_DATA_DIR} ${RELAY_PORT}' \
    < /etc/relay/config.toml.template \
    > /etc/relay/config.toml

# ─── Step 4: start the relay (background) ───────────────────────────────────
log "starting nostr-rs-relay on :${RELAY_PORT} (db=${RELAY_DATA_DIR})…"
su relay -s /bin/sh -c "RUST_LOG=${RUST_LOG} /usr/local/bin/nostr-rs-relay --config /etc/relay/config.toml --db ${RELAY_DATA_DIR}" &
RELAY_PID=$!

# Wait for the relay to bind :8080.
for i in $(seq 1 30); do
    if curl -fsS -H 'Accept: application/nostr+json' "http://127.0.0.1:${RELAY_PORT}/" >/dev/null 2>&1; then
        log "relay is up after ${i}s"
        break
    fi
    sleep 1
    if [ "$i" -eq 30 ]; then
        log "ERROR: relay failed to start within 30s"
        kill -TERM "$RELAY_PID" 2>/dev/null || true
        exit 1
    fi
done

# ─── Step 5: render + start nginx (only when SSL is configured) ─────────────
if [ -n "${SSL_DOMAIN:-}" ] && \
   [ -f "/etc/letsencrypt/live/${SSL_DOMAIN}/fullchain.pem" ] && \
   [ -f "/etc/letsencrypt/live/${SSL_DOMAIN}/privkey.pem" ]; then
    envsubst '${SSL_DOMAIN} ${RELAY_PORT}' \
        < /etc/nginx/templates/wss.conf.template \
        > /etc/nginx/sites-enabled/wss.conf
    # Remove default site so nginx doesn't grab port 80 (ssl-manager owns it).
    rm -f /etc/nginx/sites-enabled/default
    log "starting nginx for WSS termination…"
    nginx -g 'daemon off;' &
    NGINX_PID=$!
else
    log "SSL_DOMAIN unset or cert missing — nginx NOT started (plain :${RELAY_PORT} only)"
fi

# Wait for either child to exit.
if [ -n "$NGINX_PID" ]; then
    wait -n "$RELAY_PID" "$NGINX_PID"
else
    wait -n "$RELAY_PID"
fi
exit_code=$?
log "child exited with $exit_code"
handle_signal TERM
exit "$exit_code"
