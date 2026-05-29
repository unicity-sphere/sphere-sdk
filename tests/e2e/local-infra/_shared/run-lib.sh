#!/bin/bash
#
# ssl-manager run library — source this into your app-specific run script.
#
# Provides the common startup pattern for any Docker service using the
# ssl-manager base image:
#
#   1. Parse SSL/HAProxy CLI arguments
#   2. Create Docker networks
#   3. Start the container (docker create + network connect + start)
#   4. Wait for readiness (port polling)
#   5. Run health checks (color-coded: green/yellow/red)
#   6. Call app-specific functional checks
#
# ─── Usage in your run script: ────────────────────────────────────────────────
#
#   #!/bin/bash
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#
#   # App identity (set BEFORE sourcing)
#   CONTAINER_NAME="${CONTAINER_NAME:-my-service}"
#   IMAGE_NAME="${MY_IMAGE:-my-service:latest}"
#   APP_TITLE="My Service Runner"
#
#   # App networking
#   APP_NET="${APP_NET:-my-app-net}"       # app-specific Docker network
#   DATA_VOLUME="${DATA_VOLUME:-my-data}"  # app data volume
#   HEALTH_PORT=3000                       # primary port to poll for readiness
#   SSL_CHECK_PORT=3443                    # SSL port to verify (optional)
#   SSL_HTTPS_PORT="${SSL_HTTPS_PORT:-3443}"
#   APP_HTTP_PORT="${APP_HTTP_PORT:-8080}"
#
#   # Source the library
#   source "${SCRIPT_DIR}/run-lib.sh"
#
#   # ── App-specific hooks (all optional) ──
#
#   app_parse_args() {                     # custom CLI args
#       case "$1" in
#           --db-host) require_arg "$1" "${2:-}"; DB_HOST="$2"; return 2 ;;
#           *) return 0 ;;
#       esac
#   }
#
#   app_env_args() {                       # extra -e flags for docker create
#       echo "-e DB_HOST=${DB_HOST:-localhost}"
#   }
#
#   app_port_args() {                      # extra -p flags (direct mode only)
#       echo "-p 3000:3000"
#   }
#
#   app_docker_args() {                    # extra docker create flags
#       echo "--dns 8.8.8.8"
#   }
#
#   app_health_check() {                   # functional checks (after ports up)
#       local container="$1"
#       # Each line: "pass:message", "warn:message", or "fail:message"
#       local resp
#       resp=$(docker exec "$container" curl -sf localhost:3000/health 2>/dev/null)
#       if [ -n "$resp" ]; then
#           echo "pass:Health endpoint OK"
#       else
#           echo "fail:Health endpoint not responding"
#       fi
#   }
#
#   app_validate() { ... }                 # custom validation after arg parsing
#   app_print_config() { ... }             # print app config section
#   app_help() { ... }                     # print app-specific help section
#   app_summary() { ... }                  # print app endpoints after startup
#   app_needs_host_gateway() { return 0; } # return 0 if --add-host needed
#
#   # ── Run ──
#   ssl_manager_run "$@"
#

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
C_GREEN='\033[0;32m'
C_YELLOW='\033[0;33m'
C_RED='\033[0;31m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

WARN_COUNT=0
FAIL_COUNT=0

check_pass() { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$1"; }
check_warn() { printf "  ${C_YELLOW}⚠${C_RESET} %s\n" "$1"; WARN_COUNT=$((WARN_COUNT + 1)); }
check_fail() { printf "  ${C_RED}✗${C_RESET} %s\n" "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ─── Helpers ──────────────────────────────────────────────────────────────────
require_arg() {
    if [[ $# -lt 2 || "$2" == --* ]]; then
        printf 'ERROR: %s requires a value\n' "$1" >&2
        exit 1
    fi
}

validate_port() {
    local name="$1" value="$2"
    if [ "$value" = "0" ]; then return 0; fi
    if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
        printf 'ERROR: %s must be a port (1-65535), got: %s\n' "$name" "$value" >&2
        exit 1
    fi
}

# ─── SSL / HAProxy defaults (override BEFORE sourcing) ────────────────────────
: "${SSL_DOMAIN:=}"
: "${SSL_ADMIN_EMAIL:=}"
: "${SSL_REQUIRED:=true}"
: "${SSL_STAGING:=}"
: "${SSL_TEST_MODE:=}"
: "${SSL_HTTPS_PORT:=443}"
: "${APP_HTTP_PORT:=0}"
: "${SSL_DOMAIN_ALIASES:=}"
: "${EXTRA_PORTS:=}"
: "${HAPROXY_HOST:=haproxy}"
: "${HAPROXY_API_PORT:=8404}"
: "${HAPROXY_NET:=haproxy-net}"
: "${HAPROXY_API_KEY:=}"
: "${LETSENCRYPT_VOLUME:=letsencrypt-data}"
: "${HEALTH_TIMEOUT:=120}"
: "${HEALTH_PORT:=80}"

# Tunnel mode defaults
: "${REMOTE_HAPROXY_ID:=}"
: "${TUNNEL_MODE:=full}"
: "${TUNNEL_RELAY_URLS:=}"
: "${TUNNEL_TRANSPORT:=auto}"
: "${DYNDNS_PROVIDER:=}"

USE_HAPROXY=true
USE_TUNNEL=false
SHOW_HELP=false

# ─── Parse one SSL/HAProxy CLI argument ───────────────────────────────────────
_ssl_parse_arg() {
    case "$1" in
        --domain)         require_arg "$1" "${2:-}"; SSL_DOMAIN="$2";       return 2 ;;
        --ssl-email)      require_arg "$1" "${2:-}"; SSL_ADMIN_EMAIL="$2";  return 2 ;;
        --ssl-staging)    SSL_STAGING="true";     return 1 ;;
        --ssl-test-mode)  SSL_TEST_MODE="true";   return 1 ;;
        --ssl-required)   require_arg "$1" "${2:-}"; SSL_REQUIRED="$2";     return 2 ;;
        --no-ssl)         SSL_DOMAIN="";          return 1 ;;
        --ssl-https-port) require_arg "$1" "${2:-}"; SSL_HTTPS_PORT="$2";   return 2 ;;
        --app-http-port)  require_arg "$1" "${2:-}"; APP_HTTP_PORT="$2";    return 2 ;;
        --domain-aliases) require_arg "$1" "${2:-}"; SSL_DOMAIN_ALIASES="$2"; return 2 ;;
        --extra-ports)    require_arg "$1" "${2:-}"; EXTRA_PORTS="$2";      return 2 ;;
        --haproxy-host)   require_arg "$1" "${2:-}"; HAPROXY_HOST="$2";     return 2 ;;
        --haproxy-net)    require_arg "$1" "${2:-}"; HAPROXY_NET="$2";      return 2 ;;
        --haproxy-api-key) require_arg "$1" "${2:-}"; HAPROXY_API_KEY="$2"; return 2 ;;
        --no-haproxy)     USE_HAPROXY=false; HAPROXY_HOST=""; return 1 ;;
        --remote-haproxy-id) require_arg "$1" "${2:-}"; REMOTE_HAPROXY_ID="$2"; USE_TUNNEL=true; return 2 ;;
        --tunnel-mode)    require_arg "$1" "${2:-}"; TUNNEL_MODE="$2";      return 2 ;;
        --tunnel-relay)   require_arg "$1" "${2:-}"; TUNNEL_RELAY_URLS="$2"; return 2 ;;
        --tunnel-transport) require_arg "$1" "${2:-}"; TUNNEL_TRANSPORT="$2"; return 2 ;;
        --dyndns-provider) require_arg "$1" "${2:-}"; DYNDNS_PROVIDER="$2"; return 2 ;;
        --container-name) require_arg "$1" "${2:-}"; CONTAINER_NAME="$2";   return 2 ;;
        --image)          require_arg "$1" "${2:-}"; IMAGE_NAME="$2";       return 2 ;;
        --help|-h)        SHOW_HELP=true; return 1 ;;
        *)                return 0 ;;
    esac
}

# ─── Build env args for docker create ─────────────────────────────────────────
_ssl_env_args() {
    if [ -n "$SSL_DOMAIN" ]; then
        echo "-e SSL_DOMAIN=$SSL_DOMAIN"
        echo "-e SSL_REQUIRED=$SSL_REQUIRED"
        echo "-e SSL_HTTPS_PORT=$SSL_HTTPS_PORT"
        echo "-e APP_HTTP_PORT=$APP_HTTP_PORT"
        if [ -n "$SSL_ADMIN_EMAIL" ]; then echo "-e SSL_ADMIN_EMAIL=$SSL_ADMIN_EMAIL"; fi
        if [ -n "$SSL_DOMAIN_ALIASES" ]; then
            echo "-e SSL_DOMAIN_ALIASES=$SSL_DOMAIN_ALIASES"
        fi
        if [ -n "$SSL_STAGING" ]; then echo "-e SSL_STAGING=$SSL_STAGING"; fi
        if [ -n "$SSL_TEST_MODE" ]; then echo "-e SSL_TEST_MODE=$SSL_TEST_MODE"; fi
    fi
    if [ "$USE_TUNNEL" = true ] && [ -n "$REMOTE_HAPROXY_ID" ]; then
        echo "-e REMOTE_HAPROXY_ID=$REMOTE_HAPROXY_ID"
        echo "-e TUNNEL_MODE=$TUNNEL_MODE"
        if [ -n "$TUNNEL_RELAY_URLS" ]; then echo "-e TUNNEL_RELAY_URLS=$TUNNEL_RELAY_URLS"; fi
        if [ -n "$TUNNEL_TRANSPORT" ]; then echo "-e TUNNEL_TRANSPORT=$TUNNEL_TRANSPORT"; fi
        if [ -n "$DYNDNS_PROVIDER" ]; then echo "-e DYNDNS_PROVIDER=$DYNDNS_PROVIDER"; fi
        if [ -n "$EXTRA_PORTS" ]; then echo "-e EXTRA_PORTS=$EXTRA_PORTS"; fi
        if [ -n "$HAPROXY_API_KEY" ]; then echo "-e HAPROXY_API_KEY=$HAPROXY_API_KEY"; fi
    elif [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ]; then
        echo "-e HAPROXY_HOST=$HAPROXY_HOST"
        echo "-e HAPROXY_API_PORT=$HAPROXY_API_PORT"
        if [ -n "$HAPROXY_API_KEY" ]; then echo "-e HAPROXY_API_KEY=$HAPROXY_API_KEY"; fi
        if [ -n "$EXTRA_PORTS" ]; then echo "-e EXTRA_PORTS=$EXTRA_PORTS"; fi
    fi
}

# ─── Build port args ──────────────────────────────────────────────────────────
_ssl_port_args() {
    if [ "$USE_TUNNEL" = true ] && [ -n "$REMOTE_HAPROXY_ID" ]; then
        return  # Traffic arrives through tunnel, no port publishing
    fi
    if [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ]; then
        return  # HAProxy owns all ports
    fi
    if [ -n "$SSL_DOMAIN" ]; then echo "-p 80:80"; fi
}

# ─── Setup Docker networks ───────────────────────────────────────────────────
_ssl_setup_networks() {
    if [ -n "${APP_NET:-}" ]; then docker network inspect "$APP_NET" >/dev/null 2>&1 || docker network create "$APP_NET"; fi
    # In tunnel mode, no haproxy-net needed (traffic goes through WireGuard)
    if [ "$USE_TUNNEL" = true ] && [ -n "$REMOTE_HAPROXY_ID" ]; then
        return
    fi
    if [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ]; then
        docker network inspect "$HAPROXY_NET" >/dev/null 2>&1 || docker network create "$HAPROXY_NET"
    fi
}

# ─── Stop existing container ─────────────────────────────────────────────────
_ssl_stop_existing() {
    if [ -n "$(docker ps -aq --filter "name=^${CONTAINER_NAME}$" 2>/dev/null)" ]; then
        echo "Stopping existing container '$CONTAINER_NAME'..."
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
    fi
}

# ─── Start container (create + network connect + start) ───────────────────────
_ssl_start_container() {
    local primary_net="${APP_NET:-default}"
    local secondary_net=""
    if [ "$USE_TUNNEL" = true ] && [ -n "$REMOTE_HAPROXY_ID" ]; then
        # Tunnel mode: no haproxy-net, just app-net
        primary_net="${APP_NET:-default}"
        secondary_net=""
    elif [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ]; then
        primary_net="$HAPROXY_NET"
        secondary_net="${APP_NET:-}"
    fi

    local all_env=() all_ports=() all_extra=() host_opts=() tunnel_opts=()

    # Helper: read lines of "-flag value" or "-flag=value" and split into
    # separate array elements so docker receives them as distinct arguments.
    # e.g., "-e SSL_DOMAIN=foo" → array gets two elements: "-e" "SSL_DOMAIN=foo"
    _read_docker_args() {
        local -n _arr=$1; shift
        while IFS= read -r _line; do
            [ -z "$_line" ] && continue
            # Split "-flag value" into two elements
            if [[ "$_line" == -* && "$_line" == *" "* ]]; then
                _arr+=("${_line%% *}" "${_line#* }")
            else
                _arr+=("$_line")
            fi
        done < <("$@")
    }

    _read_docker_args all_env _ssl_env_args
    _read_docker_args all_ports _ssl_port_args

    if type app_env_args &>/dev/null; then
        _read_docker_args all_env app_env_args
    fi
    if type app_port_args &>/dev/null; then
        if ! { [ "$USE_TUNNEL" = true ] && [ -n "$REMOTE_HAPROXY_ID" ]; } && \
           ! { [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ]; }; then
            _read_docker_args all_ports app_port_args
        fi
    fi
    if type app_docker_args &>/dev/null; then
        _read_docker_args all_extra app_docker_args
    fi
    if type app_needs_host_gateway &>/dev/null && app_needs_host_gateway; then
        [[ "${OSTYPE:-linux}" != "darwin"* ]] && host_opts=(--add-host=host.docker.internal:host-gateway)
    fi

    # Tunnel mode: add CAP_NET_ADMIN and /dev/net/tun for WireGuard (full mode only)
    if [ "$USE_TUNNEL" = true ] && [ -n "$REMOTE_HAPROXY_ID" ]; then
        if [ "$TUNNEL_MODE" != "lite" ]; then
            tunnel_opts+=(--cap-add=NET_ADMIN)
            tunnel_opts+=(--device /dev/net/tun:/dev/net/tun)
            tunnel_opts+=(--sysctl net.ipv4.conf.all.src_valid_mark=1)
        fi
    fi

    docker create \
        --name "$CONTAINER_NAME" \
        --restart on-failure:5 \
        --network "$primary_net" \
        "${host_opts[@]}" \
        "${tunnel_opts[@]}" \
        -v "${DATA_VOLUME}:/data" \
        -v "${LETSENCRYPT_VOLUME}:/etc/letsencrypt" \
        "${all_ports[@]}" \
        "${all_env[@]}" \
        "${all_extra[@]}" \
        "$IMAGE_NAME" >/dev/null

    [ -n "$secondary_net" ] && docker network connect "$secondary_net" "$CONTAINER_NAME"

    if ! docker start "$CONTAINER_NAME" >/dev/null; then
        echo "ERROR: Failed to start container" >&2; exit 1
    fi
}

# ─── Wait for a TCP port ─────────────────────────────────────────────────────
_ssl_wait_for_port() {
    local container="$1" port="$2" label="$3" timeout="$4"
    local elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        if ! docker ps -q --filter "name=^${container}$" 2>/dev/null | grep -q .; then
            printf "\n"; check_fail "Container exited unexpectedly"
            docker logs "$container" 2>&1 | tail -15 >&2; return 1
        fi
        if docker exec "$container" nc -z localhost "$port" 2>/dev/null; then
            printf "\r\033[K"; return 0
        fi
        printf "\r  %s... (%ds)" "$label" "$elapsed"
        sleep 2; elapsed=$((elapsed + 2))
    done
    printf "\n"; return 1
}

# ─── SSL certificate check ───────────────────────────────────────────────────
_ssl_check_cert() {
    local container="$1" domain="$2"
    local cert_info
    cert_info=$(docker exec "$container" openssl x509 -enddate -noout \
        -in "/etc/letsencrypt/live/${domain}/fullchain.pem" 2>/dev/null | sed 's/notAfter=//')
    if [ -n "$cert_info" ]; then
        local cert_epoch now_epoch days_left
        cert_epoch=$(date -d "$cert_info" +%s 2>/dev/null || echo 0)
        now_epoch=$(date +%s)
        days_left=$(( (cert_epoch - now_epoch) / 86400 ))
        if [ "$days_left" -gt 14 ] 2>/dev/null; then
            check_pass "SSL cert expires: $cert_info ($days_left days)"
        elif [ "$days_left" -gt 0 ] 2>/dev/null; then
            check_warn "SSL cert expires: $cert_info ($days_left days — renew soon!)"
        else
            check_fail "SSL cert expired: $cert_info"
        fi
    else
        check_warn "Could not read SSL certificate"
    fi
}

# ─── Help ─────────────────────────────────────────────────────────────────────
_ssl_print_help() {
    cat <<'HELP'
SSL Configuration:
  --domain <domain>        Domain for automatic SSL (certbot)
  --domain-aliases <csv>   Comma-separated alias domains (multi-domain SSL)
  --ssl-email <email>      Email for Let's Encrypt registration
  --ssl-staging            Use Let's Encrypt staging (test certs)
  --ssl-test-mode          Self-signed cert for dev/CI
  --ssl-required <bool>    Fail if SSL setup fails (default: true)
  --ssl-https-port <port>  Backend port for HTTPS via HAProxy
  --app-http-port <port>   App HTTP port behind ssl-manager proxy
  --extra-ports <json>     Extra HAProxy port mappings (JSON array)
  --no-ssl                 Disable SSL entirely

HAProxy Configuration:
  --haproxy-host <host>    HAProxy hostname (default: haproxy)
  --haproxy-net <network>  HAProxy Docker network (default: haproxy-net)
  --haproxy-api-key <key>  Bearer token for Registration API
  --no-haproxy             Skip HAProxy, expose ports directly

Remote Tunnel:
  --remote-haproxy-id <npub>  Remote HAProxy daemon Nostr npub
  --tunnel-mode <mode>        full (WireGuard VPN) or lite (SSH -R)
  --tunnel-relay <urls>       Nostr relay URLs (comma-separated)
  --tunnel-transport <type>   udp, wss, or auto (default)
  --dyndns-provider <name>    DynDNS provider for self-managed DNS

Container:
  --container-name <name>  Container name
  --image <image>          Docker image
  --help, -h               Show this help
HELP
    type app_help &>/dev/null && { echo ""; app_help; }
}

# ═══════════════════════════════════════════════════════════════════════════════
# Main entry point — call from your app script: ssl_manager_run "$@"
# ═══════════════════════════════════════════════════════════════════════════════
ssl_manager_run() {
    # Parse arguments
    local consumed=0
    while [[ $# -gt 0 ]]; do
        # Capture return code without triggering set -e.
        # Functions return N>0 to indicate "consumed N args", 0 for "not mine".
        # set -e treats non-zero return as error, so we use "if" to suppress it.
        if _ssl_parse_arg "$@"; then consumed=0; else consumed=$?; fi
        if [ "$consumed" -gt 0 ]; then shift "$consumed"; continue; fi
        if type app_parse_args &>/dev/null; then
            if app_parse_args "$@"; then consumed=0; else consumed=$?; fi
            if [ "$consumed" -gt 0 ]; then shift "$consumed"; continue; fi
        fi
        echo "Unknown option: $1" >&2
        echo "Run with --help for usage." >&2
        exit 1
    done
    [ "$SHOW_HELP" = true ] && { echo "Usage: $(basename "$0") [options]"; echo ""; _ssl_print_help; exit 0; }

    # Validate
    if [ "$USE_TUNNEL" = true ] && [ -n "${HAPROXY_HOST:-}" ] && [ "$HAPROXY_HOST" != "haproxy" ]; then
        echo "ERROR: --remote-haproxy-id and --haproxy-host are mutually exclusive" >&2
        exit 1
    fi
    validate_port "SSL_HTTPS_PORT" "$SSL_HTTPS_PORT"
    validate_port "APP_HTTP_PORT" "$APP_HTTP_PORT"
    [ "$APP_HTTP_PORT" = "80" ] && { echo "ERROR: APP_HTTP_PORT cannot be 80" >&2; exit 1; }
    if [ -n "$SSL_DOMAIN" ] && ! printf '%s' "$SSL_DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$'; then
        printf 'ERROR: Invalid domain: %s\n' "$SSL_DOMAIN" >&2; exit 1
    fi
    if [ -n "$SSL_DOMAIN_ALIASES" ]; then
        if [ -z "$SSL_DOMAIN" ]; then
            printf 'ERROR: --domain-aliases requires --domain\n' >&2; exit 1
        fi
        IFS=',' read -ra _check_aliases <<< "$SSL_DOMAIN_ALIASES"
        for _ca in "${_check_aliases[@]}"; do
            _ca=$(echo "$_ca" | xargs)
            if [ -n "$_ca" ] && ! printf '%s' "$_ca" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$'; then
                printf 'ERROR: Invalid alias domain: %s\n' "$_ca" >&2; exit 1
            fi
        done
    fi
    type app_validate &>/dev/null && app_validate

    # Print config
    printf "\n${C_BOLD}%s${C_RESET}\n" "${APP_TITLE:-Docker Service}"
    echo "════════════════════════════════════════"
    echo "  Image:      $IMAGE_NAME"
    echo "  Container:  $CONTAINER_NAME"
    [ -n "$SSL_DOMAIN" ] && echo "  SSL Domain: $SSL_DOMAIN" || echo "  SSL:        disabled"
    if [ -n "$SSL_DOMAIN_ALIASES" ]; then echo "  Aliases:    $SSL_DOMAIN_ALIASES"; fi
    [ -n "$SSL_DOMAIN" ] && [ -n "$SSL_ADMIN_EMAIL" ] && echo "  SSL Email:  $SSL_ADMIN_EMAIL"
    if [ "$USE_TUNNEL" = true ] && [ -n "$REMOTE_HAPROXY_ID" ]; then
        echo "  Tunnel:     ${REMOTE_HAPROXY_ID:0:20}... (${TUNNEL_MODE} mode)"
        [ -n "$TUNNEL_TRANSPORT" ] && [ "$TUNNEL_TRANSPORT" != "auto" ] && echo "  Transport:  $TUNNEL_TRANSPORT"
    elif [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ]; then
        echo "  HAProxy:    $HAPROXY_HOST (via $HAPROXY_NET)"
    else
        echo "  HAProxy:    disabled (direct ports)"
    fi
    type app_print_config &>/dev/null && app_print_config
    echo ""

    # Setup
    _ssl_setup_networks
    _ssl_stop_existing
    _ssl_start_container

    # Wait for readiness
    echo "Waiting for service to start..."
    if ! _ssl_wait_for_port "$CONTAINER_NAME" "$HEALTH_PORT" "Starting up" "$HEALTH_TIMEOUT"; then
        printf "${C_RED}Service did not start within ${HEALTH_TIMEOUT}s${C_RESET}\n"
        echo "  Logs: docker logs -f $CONTAINER_NAME"; exit 1
    fi
    if [ -n "$SSL_DOMAIN" ] && [ -n "${SSL_CHECK_PORT:-}" ]; then
        _ssl_wait_for_port "$CONTAINER_NAME" "$SSL_CHECK_PORT" "SSL setup" "$HEALTH_TIMEOUT" || \
            check_warn "SSL port $SSL_CHECK_PORT not ready within timeout"
    fi

    # Health & functional checks
    echo ""
    echo "Health & Functional Checks"
    echo "────────────────────────────────────────"
    check_pass "Container running"
    check_pass "Port $HEALTH_PORT listening"
    if [ -n "$SSL_DOMAIN" ] && [ -n "${SSL_CHECK_PORT:-}" ]; then
        if docker exec "$CONTAINER_NAME" nc -z localhost "$SSL_CHECK_PORT" 2>/dev/null; then
            check_pass "SSL port $SSL_CHECK_PORT listening"
        else
            check_fail "SSL port $SSL_CHECK_PORT not listening"
        fi
        _ssl_check_cert "$CONTAINER_NAME" "$SSL_DOMAIN"
        # Check alias certs
        if [ -n "${SSL_DOMAIN_ALIASES:-}" ]; then
            IFS=',' read -ra _hc_aliases <<< "$SSL_DOMAIN_ALIASES"
            for _hca in "${_hc_aliases[@]}"; do
                _hca=$(echo "$_hca" | xargs)
                if [ -n "$_hca" ]; then _ssl_check_cert "$CONTAINER_NAME" "$_hca"; fi
            done
        fi
    fi

    # App-specific functional checks
    if type app_health_check &>/dev/null; then
        while IFS= read -r result; do
            [ -z "$result" ] && continue
            local level="${result%%:*}" msg="${result#*:}"
            case "$level" in
                pass) check_pass "$msg" ;; warn) check_warn "$msg" ;;
                fail) check_fail "$msg" ;; *)    check_pass "$result" ;;
            esac
        done < <(app_health_check "$CONTAINER_NAME")
    fi

    # Summary line
    echo "────────────────────────────────────────"
    if [ "$FAIL_COUNT" -gt 0 ]; then
        printf "${C_RED}RESULT: %d check(s) failed, %d warning(s)${C_RESET}\n" "$FAIL_COUNT" "$WARN_COUNT"
    elif [ "$WARN_COUNT" -gt 0 ]; then
        printf "${C_YELLOW}RESULT: All critical checks passed, %d warning(s)${C_RESET}\n" "$WARN_COUNT"
    else
        printf "${C_GREEN}RESULT: All checks passed${C_RESET}\n"
    fi

    # Commands
    echo ""
    echo "Service started: $CONTAINER_NAME"
    echo ""
    echo "Commands:"
    echo "  Logs:    docker logs -f \"$CONTAINER_NAME\""
    echo "  Stop:    docker stop \"$CONTAINER_NAME\""
    [ -n "$SSL_DOMAIN" ] && echo "  SSL:     docker exec \"$CONTAINER_NAME\" certbot certificates"
    type app_summary &>/dev/null && app_summary
    echo ""
}
