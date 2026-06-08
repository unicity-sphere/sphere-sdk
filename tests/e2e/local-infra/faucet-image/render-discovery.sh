#!/bin/bash
# tests/e2e/local-infra/faucet-image/render-discovery.sh
#
# Reads js-faucet's log stream on stdin. Whenever a line contains the
# faucet's chain_pubkey announcement, rewrites
# /var/lib/faucet/identity.json so the nginx discovery endpoint
# advertises the current faucet identity.
#
# Idempotent — the first match wins; subsequent matches with the same
# pubkey are no-ops.

set -euo pipefail

IDENTITY_FILE="${IDENTITY_FILE:-/var/lib/faucet/identity.json}"
CURRENT_PUBKEY=
CURRENT_NAMETAG=
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

render() {
    local pubkey="$1" nametag="$2"
    local direct="DIRECT://${pubkey}"
    cat > "$TMP_DIR/identity.json" <<EOF
{
  "status": "running",
  "domain": "${SSL_DOMAIN:-localhost}",
  "network": "${UNICITY_NETWORK:-testnet}",
  "chain_pubkey": "${pubkey}",
  "direct_address": "${direct}",
  "nametag": $([ -n "$nametag" ] && printf '"%s"' "$nametag" || echo "null"),
  "supported_coins": []
}
EOF
    mv "$TMP_DIR/identity.json" "$IDENTITY_FILE"
    chmod 644 "$IDENTITY_FILE" 2>/dev/null || true
}

while IFS= read -r line; do
    # Pass the line through to stdout (so docker logs still see it).
    printf '%s\n' "$line"

    # Extract chain_pubkey from JSON-ish log lines. js-faucet logs
    # like:  {"level":"info","chain_pubkey":"02...","msg":"started"}
    pubkey=$(printf '%s\n' "$line" \
        | grep -oE '"chain_pubkey"[^,}]*' \
        | grep -oE '0[23][0-9a-fA-F]{64}' \
        | head -1 || true)

    # Also extract the nametag when it shows up. js-faucet logs:
    # {"nametag":"xaleava","msg":"nametag_verified"} after a successful
    # mint+resolve cycle. Earlier "registering_nametag" lines come BEFORE
    # the mint completes — they don't prove the nametag exists yet, so
    # we wait for nametag_verified.
    if printf '%s' "$line" | grep -q 'nametag_verified'; then
        nametag=$(printf '%s\n' "$line" \
            | grep -oE '"nametag"\s*:\s*"[^"]*"' \
            | head -1 \
            | sed -E 's/.*:\s*"([^"]*)".*/\1/' \
            || true)
        if [ -n "$nametag" ] && [ "$nametag" != "$CURRENT_NAMETAG" ]; then
            CURRENT_NAMETAG="$nametag"
            if [ -n "$CURRENT_PUBKEY" ]; then
                render "$CURRENT_PUBKEY" "$CURRENT_NAMETAG"
                printf '[faucet-discovery] nametag verified: %s\n' "$nametag" >&2
            fi
        fi
    fi

    if [ -n "$pubkey" ] && [ "$pubkey" != "$CURRENT_PUBKEY" ]; then
        CURRENT_PUBKEY="$pubkey"
        render "$CURRENT_PUBKEY" "$CURRENT_NAMETAG"
        printf '[faucet-discovery] identity updated: %s\n' "$pubkey" >&2
    fi
done
