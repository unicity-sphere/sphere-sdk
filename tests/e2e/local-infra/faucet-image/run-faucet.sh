#!/bin/bash
#
# Run script for the ssl-manager-wrapped js-faucet image.
#
# Usage:
#   ./run-faucet.sh                                     # No SSL, port 8080 on host
#   ./run-faucet.sh --domain faucet.example.com         # SSL + HAProxy registration
#   ./run-faucet.sh --domain faucet.example.com \
#                   --ssl-email ops@example.com \
#                   --nostr-relays wss://relay.example.com
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── App identity ──────────────────────────────────────────────────────────────
CONTAINER_NAME="${CONTAINER_NAME:-unicity-faucet}"
IMAGE_NAME="${FAUCET_IMAGE:-unicity-faucet-tls:latest}"
APP_TITLE="Unicity testnet faucet (ssl-manager-wrapped)"

# ── App networking ────────────────────────────────────────────────────────────
APP_NET="${APP_NET:-unicity-faucet-net}"
DATA_VOLUME="${DATA_VOLUME:-unicity-faucet-data}"
HEALTH_PORT="${HEALTH_PORT:-8080}"          # discovery HTTP — first port up
SSL_CHECK_PORT="${SSL_CHECK_PORT:-443}"
SSL_HTTPS_PORT="${SSL_HTTPS_PORT:-443}"
APP_HTTP_PORT="${APP_HTTP_PORT:-8080}"      # ssl-manager proxies :443 → :8080

# ── App defaults ──────────────────────────────────────────────────────────────
NOSTR_RELAYS="${NOSTR_RELAYS:-wss://nostr-unicity-dev.dyndns.org}"
UNICITY_NETWORK="${UNICITY_NETWORK:-testnet}"
LOG_LEVEL="${LOG_LEVEL:-info}"

# Override path — wallet/identity is persisted under a Docker volume.
FAUCET_IDENTITY_VOLUME="${FAUCET_IDENTITY_VOLUME:-unicity-faucet-identity}"

# ── Source the library ────────────────────────────────────────────────────────
if [ ! -f "${SCRIPT_DIR}/../_shared/run-lib.sh" ]; then
    echo "ERROR: run-lib.sh not found in ${SCRIPT_DIR}/../_shared" >&2
    exit 1
fi
source "${SCRIPT_DIR}/../_shared/run-lib.sh"

# ═══════════════════════════════════════════════════════════════════════════════
# App-specific hooks
# ═══════════════════════════════════════════════════════════════════════════════

app_parse_args() {
    case "$1" in
        --nostr-relays)   require_arg "$1" "${2:-}"; NOSTR_RELAYS="$2";    return 2 ;;
        --network)        require_arg "$1" "${2:-}"; UNICITY_NETWORK="$2"; return 2 ;;
        --log-level)      require_arg "$1" "${2:-}"; LOG_LEVEL="$2";       return 2 ;;
        --identity-vol)   require_arg "$1" "${2:-}"; FAUCET_IDENTITY_VOLUME="$2"; return 2 ;;
        *)                return 0 ;;
    esac
}

app_env_args() {
    echo "-e SPHERE_NOSTR_RELAYS=${NOSTR_RELAYS}"
    echo "-e UNICITY_NETWORK=${UNICITY_NETWORK}"
    echo "-e UNICITY_LOG_LEVEL=${LOG_LEVEL}"
    echo "-e FAUCET_DISCOVERY_PORT=${APP_HTTP_PORT}"
}

app_docker_args() {
    # Persist the faucet's derived wallet across container restarts.
    echo "-v ${FAUCET_IDENTITY_VOLUME}:/var/lib/faucet"
}

app_health_check() {
    local container="$1"

    # Probe the discovery doc — proves nginx is up.
    local body
    body=$(docker exec "$container" curl -fsS "http://127.0.0.1:${APP_HTTP_PORT}/.well-known/faucet.json" 2>/dev/null || true)
    if [ -n "$body" ]; then
        local status; status=$(echo "$body" | jq -r '.status' 2>/dev/null || echo "?")
        echo "pass:Discovery endpoint OK (status=$status)"
    else
        echo "fail:Discovery endpoint not responding"
        return
    fi

    # Probe chain_pubkey — proves the faucet has finished booting.
    local pk
    pk=$(echo "$body" | jq -r '.chain_pubkey' 2>/dev/null || echo "")
    if [ -n "$pk" ] && [ "$pk" != "null" ]; then
        echo "pass:Faucet identity: $pk"
    else
        echo "warn:Faucet still initialising (no chain_pubkey yet)"
    fi
}

app_print_config() {
    echo "  Nostr relays: $NOSTR_RELAYS"
    echo "  Network:      $UNICITY_NETWORK"
    echo "  Wallet vol:   $FAUCET_IDENTITY_VOLUME"
}

app_help() {
    cat <<'APPHELP'
Faucet-specific:
  --nostr-relays <url>   Comma-separated Nostr relay URL(s) the faucet listens on
                         (default: wss://nostr-unicity-dev.dyndns.org).
  --network <name>       Unicity network (default: testnet).
  --log-level <lvl>      info | debug | warn (default: info).
  --identity-vol <name>  Docker volume holding the faucet's wallet
                         (default: unicity-faucet-identity).
APPHELP
}

app_summary() {
    echo ""
    echo "Endpoints:"
    if [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ] && [ -n "$SSL_DOMAIN" ]; then
        echo "  Discovery: https://$SSL_DOMAIN/.well-known/faucet.json"
        echo "  Health:    https://$SSL_DOMAIN/health"
    else
        echo "  Discovery: http://localhost:$APP_HTTP_PORT/.well-known/faucet.json"
    fi
    echo ""
    echo "Inspect faucet identity:"
    echo "  docker exec $CONTAINER_NAME cat /var/lib/faucet/identity.json"
}

ssl_manager_run "$@"
