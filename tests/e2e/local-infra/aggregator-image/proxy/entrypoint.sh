#!/bin/bash
# Aggregator-proxy entrypoint.
#
# 1. ssl-setup
# 2. haproxy-register register
# 3. start nginx (TLS termination → aggregator backend)

set -euo pipefail

log() { printf '[aggregator-proxy] %s\n' "$*" >&2; }

NGINX_PID=

handle_signal() {
    local sig="$1"
    log "received SIG${sig}, shutting down…"

    if [ -n "${SSL_DOMAIN:-}" ] && [ -n "${HAPROXY_HOST:-}" ]; then
        haproxy-register unregister 2>/dev/null || true
    fi

    [ -n "$NGINX_PID" ] && kill -QUIT "$NGINX_PID" 2>/dev/null || true

    if [ -f /tmp/.ssl-renew.pid ]; then
        local pid; pid=$(cat /tmp/.ssl-renew.pid 2>/dev/null || true)
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    fi
}
trap 'handle_signal TERM' SIGTERM
trap 'handle_signal INT'  SIGINT

if [ -z "${SSL_DOMAIN:-}" ]; then
    log "ERROR: SSL_DOMAIN is required for the aggregator proxy"
    exit 1
fi

log "running ssl-setup for $SSL_DOMAIN…"
ssl-setup

if [ -n "${HAPROXY_HOST:-}" ]; then
    log "registering with HAProxy at $HAPROXY_HOST…"
    haproxy-register register || log "WARN: haproxy registration failed (continuing)"
fi

# Wait for the aggregator backend to be reachable before starting
# nginx. Otherwise nginx would print "host not found" and exit.
log "waiting for aggregator backend at ${AGGREGATOR_BACKEND_HOST}:${AGGREGATOR_BACKEND_PORT}…"
for i in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://${AGGREGATOR_BACKEND_HOST}:${AGGREGATOR_BACKEND_PORT}/" 2>/dev/null; then
        log "backend is up after ${i}s"
        break
    fi
    if [ "$i" -eq 60 ]; then
        log "WARN: backend not responding after 60s — starting nginx anyway"
    fi
    sleep 1
done

envsubst '${SSL_DOMAIN} ${AGGREGATOR_BACKEND_HOST} ${AGGREGATOR_BACKEND_PORT}' \
    < /etc/nginx/templates/aggregator.conf.template \
    > /etc/nginx/sites-enabled/aggregator.conf
rm -f /etc/nginx/sites-enabled/default

log "starting nginx…"
nginx -g 'daemon off;' &
NGINX_PID=$!

wait -n "$NGINX_PID"
exit_code=$?
log "nginx exited with $exit_code"
handle_signal TERM
exit "$exit_code"
