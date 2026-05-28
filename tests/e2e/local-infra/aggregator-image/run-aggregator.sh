#!/bin/bash
#
# Orchestrator wrapper around docker-compose.yml.
#
# Usage:
#   ./run-aggregator.sh --domain aggregator-unicity-dev.dyndns.org \
#                       --ssl-email ops@example.com
#
# Options:
#   --domain <d>       SSL domain (REQUIRED — proxy refuses to start otherwise)
#   --ssl-email <e>    Let's Encrypt registration email (REQUIRED)
#   --haproxy-host <h> HAProxy registration host (default: haproxy)
#   --haproxy-port <p> HAProxy admin API port (default: 8404)
#   --ssl-staging      Use Let's Encrypt staging (rate-limit safe for testing)
#   --ssl-test-mode    Use self-signed cert (offline mode)
#   --fresh            Wipe ./data/* + named volumes before starting.
#                      DESTROYS any existing aggregator state.
#   --down             Tear down the stack (keeps volumes; combine with
#                      --fresh to wipe).
#   --logs             Tail the aggregator container's logs and exit.
#   --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Defaults ────────────────────────────────────────────────────────────────
AGG_DOMAIN=""
SSL_EMAIL=""
HAPROXY_HOST="haproxy"
HAPROXY_PORT="8404"
SSL_STAGING=""
SSL_TEST_MODE=""
FRESH=false
DOWN=false
LOGS=false

# ── Colors ──────────────────────────────────────────────────────────────────
C_GREEN='\033[0;32m'
C_YELLOW='\033[0;33m'
C_RED='\033[0;31m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

log()  { printf '[run-aggregator] %s\n' "$*" >&2; }
pass() { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$1"; }
warn() { printf "  ${C_YELLOW}⚠${C_RESET} %s\n" "$1"; }
fail() { printf "  ${C_RED}✗${C_RESET} %s\n" "$1"; }

usage() {
    sed -n '3,25p' "$0"
}

# ── Arg parsing ─────────────────────────────────────────────────────────────
while [ "$#" -gt 0 ]; do
    case "$1" in
        --domain)        AGG_DOMAIN="$2";    shift 2 ;;
        --ssl-email)     SSL_EMAIL="$2";     shift 2 ;;
        --haproxy-host)  HAPROXY_HOST="$2";  shift 2 ;;
        --haproxy-port)  HAPROXY_PORT="$2";  shift 2 ;;
        --ssl-staging)   SSL_STAGING=true;   shift   ;;
        --ssl-test-mode) SSL_TEST_MODE=true; shift   ;;
        --fresh)         FRESH=true;         shift   ;;
        --down)          DOWN=true;          shift   ;;
        --logs)          LOGS=true;          shift   ;;
        --help|-h)       usage; exit 0 ;;
        *)               log "unknown arg: $1"; usage; exit 1 ;;
    esac
done

if [ "$LOGS" = true ]; then
    exec docker logs -f agg-aggregator
fi

if [ "$DOWN" = true ]; then
    log "stopping the aggregator stack…"
    docker compose down --remove-orphans --volumes || true
    if [ "$FRESH" = true ]; then
        log "removing data dirs (genesis, mongodb)…"
        rm -rf ./data/genesis ./data/genesis-root ./data/mongodb_data 2>/dev/null || \
             sudo rm -rf ./data/genesis ./data/genesis-root ./data/mongodb_data
        docker volume rm agg-letsencrypt 2>/dev/null || true
    fi
    log "done."
    exit 0
fi

# ── Validation ──────────────────────────────────────────────────────────────
if [ -z "$AGG_DOMAIN" ] && [ -z "$SSL_TEST_MODE" ]; then
    fail "--domain is REQUIRED (unless --ssl-test-mode)"
    usage; exit 1
fi
if [ -z "$SSL_EMAIL" ] && [ -z "$SSL_TEST_MODE" ]; then
    fail "--ssl-email is REQUIRED (unless --ssl-test-mode)"
    usage; exit 1
fi

# ── Fresh-state mode ────────────────────────────────────────────────────────
if [ "$FRESH" = true ]; then
    warn "Fresh mode — wiping ./data/* and named volumes…"
    AGG_DOMAIN="$AGG_DOMAIN" SSL_EMAIL="$SSL_EMAIL" \
        docker compose down --remove-orphans --volumes 2>/dev/null || true
    rm -rf ./data/genesis ./data/genesis-root ./data/mongodb_data 2>/dev/null || \
        sudo rm -rf ./data/genesis ./data/genesis-root ./data/mongodb_data
    docker volume rm agg-letsencrypt 2>/dev/null || true
fi

# Pre-create data dirs with the caller's UID so the containers (running
# as $USER_UID) can write into them. Without this, Docker creates the
# subdirs as root, and bft-root (running as 1000:1000) can't write
# /genesis/root/node-info.json etc.
mkdir -p ./data/genesis ./data/genesis-root ./data/mongodb_data

# ── Verify haproxy-net exists (proxy container joins it) ────────────────────
# Skipped in --ssl-test-mode: that path is for offline dev where no HAProxy
# stack is running. Note the compose file declares haproxy-net `external: true`
# unconditionally, so even in test-mode you'll need to `docker network create
# haproxy-net` once on the host.
if [ -z "$SSL_TEST_MODE" ]; then
    if ! docker network ls --format '{{.Name}}' | grep -q '^haproxy-net$'; then
        fail "haproxy-net external network missing — is the host HAProxy stack running?"
        exit 1
    fi
    pass "haproxy-net network present"
fi

# ── Verify the proxy image builds (catch syntax errors early) ───────────────
log "building the aggregator-proxy image…"
docker build -q -f proxy/Dockerfile -t unicity-aggregator-proxy:latest proxy/ >/dev/null
pass "proxy image built"

# ── Launch ──────────────────────────────────────────────────────────────────
log "starting the aggregator stack (domain=$AGG_DOMAIN)…"
USER_UID=$(id -u) USER_GID=$(id -g) \
AGG_DOMAIN="$AGG_DOMAIN" \
SSL_EMAIL="$SSL_EMAIL" \
HAPROXY_HOST="$HAPROXY_HOST" \
HAPROXY_PORT="$HAPROXY_PORT" \
SSL_STAGING="${SSL_STAGING}" \
SSL_TEST_MODE="${SSL_TEST_MODE}" \
docker compose up -d

echo ""
log "stack starting — this can take 60–120s on first run (genesis + cert issuance)"
log "track progress with:  docker compose -f $SCRIPT_DIR/docker-compose.yml ps"
echo ""

# Poll for proxy readiness.
log "waiting for proxy :443 to come up…"
deadline=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
    if docker exec agg-proxy curl -fsSk https://127.0.0.1/health >/dev/null 2>&1; then
        pass "proxy is up"
        break
    fi
    sleep 3
done

# Final check via external DNS / public TLS — only when a real domain
# is configured. In --ssl-test-mode AGG_DOMAIN is unset and the URL
# would degenerate to https:///health.
if [ -n "$AGG_DOMAIN" ]; then
    echo ""
    log "running external reachability check…"
    if curl -fsS --max-time 10 "https://${AGG_DOMAIN}/health" -o /dev/null; then
        pass "https://${AGG_DOMAIN}/health responds"
    else
        warn "https://${AGG_DOMAIN}/health not reachable yet — check 'docker logs agg-proxy'"
    fi
fi

echo ""
echo "${C_BOLD}Endpoints:${C_RESET}"
echo "  Aggregator: https://${AGG_DOMAIN}"
echo "  Trust-base path: /app/bft-config/trust-base.json inside agg-aggregator"
echo ""
echo "Useful commands:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml ps"
echo "  docker logs -f agg-aggregator"
echo "  docker logs -f agg-proxy"
echo "  ./run-aggregator.sh --down --fresh   # tear down + wipe state"
