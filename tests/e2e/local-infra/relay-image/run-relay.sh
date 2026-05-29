#!/bin/bash
#
# Run script for the ssl-manager-wrapped Nostr relay.
#
# Usage:
#   ./run-relay.sh                                       # plaintext WS only
#   ./run-relay.sh --domain relay.example.com            # WSS + HAProxy
#   ./run-relay.sh --domain relay.example.com \
#                  --ssl-email ops@example.com \
#                  --haproxy-host haproxy
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── App identity ──────────────────────────────────────────────────────────────
CONTAINER_NAME="${CONTAINER_NAME:-unicity-relay}"
IMAGE_NAME="${RELAY_IMAGE:-unicity-relay-tls:latest}"
APP_TITLE="Unicity Nostr relay (ssl-manager-wrapped)"

# ── App networking ────────────────────────────────────────────────────────────
APP_NET="${APP_NET:-unicity-relay-net}"
DATA_VOLUME="${DATA_VOLUME:-unicity-relay-data}"
HEALTH_PORT="${HEALTH_PORT:-8080}"          # relay HTTP (NIP-11) — first port up
SSL_CHECK_PORT="${SSL_CHECK_PORT:-443}"     # nginx WSS termination
SSL_HTTPS_PORT="${SSL_HTTPS_PORT:-443}"
# IMPORTANT: APP_HTTP_PORT=0 disables ssl-manager's own ssl-http-proxy
# from re-proxying :443 → app HTTP. We do TLS termination ourselves in
# nginx (because nostr-rs-relay does NOT speak TLS).
APP_HTTP_PORT="${APP_HTTP_PORT:-0}"

# ── App defaults ──────────────────────────────────────────────────────────────
RELAY_NAME="${RELAY_NAME:-Unicity dev relay}"
RELAY_DESCRIPTION="${RELAY_DESCRIPTION:-Local Unicity testnet relay (ssl-manager-wrapped)}"
RUST_LOG="${RUST_LOG:-info,nostr_rs_relay=info}"

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
        --relay-name)        require_arg "$1" "${2:-}"; RELAY_NAME="$2";        return 2 ;;
        --relay-description) require_arg "$1" "${2:-}"; RELAY_DESCRIPTION="$2"; return 2 ;;
        --rust-log)          require_arg "$1" "${2:-}"; RUST_LOG="$2";          return 2 ;;
        *)                   return 0 ;;
    esac
}

app_env_args() {
    echo "-e RELAY_NAME=${RELAY_NAME}"
    echo "-e RELAY_DESCRIPTION=${RELAY_DESCRIPTION}"
    echo "-e RUST_LOG=${RUST_LOG}"
}

app_docker_args() {
    # Mount the persistent SQLite event log.
    echo "-v ${DATA_VOLUME}:/var/lib/relay"
}

app_health_check() {
    local container="$1"

    # NIP-11 info doc — proves the relay is up and the WebSocket
    # handler is registered.
    local resp
    resp=$(docker exec "$container" curl -fsS \
        -H 'Accept: application/nostr+json' \
        "http://127.0.0.1:${HEALTH_PORT}/" 2>/dev/null || true)
    if [ -n "$resp" ]; then
        local name; name=$(echo "$resp" | jq -r '.name // "?"' 2>/dev/null)
        echo "pass:Relay NIP-11 OK (name=$name)"
    else
        echo "fail:Relay NIP-11 endpoint not responding"
        return
    fi

    # If SSL is enabled, probe nginx :443.
    if [ -n "$SSL_DOMAIN" ]; then
        local s443
        s443=$(docker exec "$container" curl -fsSk \
            -H 'Accept: application/nostr+json' \
            "https://127.0.0.1:443/" 2>/dev/null || true)
        if [ -n "$s443" ]; then
            echo "pass:WSS endpoint OK (https://$SSL_DOMAIN)"
        else
            echo "warn:nginx :443 not responding yet"
        fi
    fi
}

app_print_config() {
    echo "  Relay name:   $RELAY_NAME"
    echo "  Data volume:  $DATA_VOLUME (persistent SQLite event log)"
}

app_help() {
    cat <<'APPHELP'
Relay-specific:
  --relay-name <name>          NIP-11 relay name (default: "Unicity dev relay")
  --relay-description <text>   NIP-11 description.
  --rust-log <directive>       RUST_LOG (default: info,nostr_rs_relay=info).
APPHELP
}

app_summary() {
    echo ""
    echo "Endpoints:"
    if [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ] && [ -n "$SSL_DOMAIN" ]; then
        echo "  WSS:    wss://$SSL_DOMAIN"
        echo "  NIP-11: https://$SSL_DOMAIN (Accept: application/nostr+json)"
    else
        echo "  WS:     ws://localhost:$HEALTH_PORT"
        echo "  NIP-11: curl -H 'Accept: application/nostr+json' http://localhost:$HEALTH_PORT"
    fi
    echo ""
    echo "Inspect events:"
    echo "  docker exec $CONTAINER_NAME sqlite3 /var/lib/relay/db/nostr.db 'SELECT COUNT(*) FROM event'"
}

ssl_manager_run "$@"
