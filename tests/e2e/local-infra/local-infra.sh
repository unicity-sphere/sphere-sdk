#!/usr/bin/env bash
# =============================================================================
# local-infra.sh — Bash-side wrapper for the local Nostr+faucet stack.
#
# Companion to tests/e2e/local-infra/global-setup.ts (the vitest entry
# point). Shell-driven e2e tests (pointer-N*.sh, swap-cli-e2e.sh) can
# `source` this file and call:
#
#   local_infra_up
#   local_infra_down
#
# The functions are idempotent — repeated calls return the cached state.
#
# Activated when E2E_LOCAL_INFRA=1. No-op otherwise so the same scripts
# run unchanged against the public testnet.
#
# What it does:
#   1. `docker compose -f tests/e2e/local-infra/docker-compose.yml up -d
#      relay` and waits for the NIP-11 doc to respond.
#   2. `docker run` the js-faucet image with --network host and the same
#      UNICITY_* env stub set the vitest harness uses (real secp256k1
#      pubkey for UNICITY_MANAGER_PUBKEY, generated via openssl).
#   3. Tails docker logs until `faucet_chain_pubkey_announced` appears
#      and exports E2E_LOCAL_FAUCET_PUBKEY.
#   4. Exports SPHERE_NOSTR_RELAYS=ws://127.0.0.1:7777 so the SDK's
#      env-override picks it up in createNodeProviders.
#
# Files written:
#   /tmp/uxf-e2e-local-infra/state.env  — `KEY=value` lines, sourceable
#                                         by sub-shells that run after
#                                         the parent already booted the
#                                         stack (e.g. run-all.sh fanning
#                                         out per-test scripts).
# =============================================================================

# Idempotent source guard
if [[ "${UXF_LOCAL_INFRA_LOADED:-0}" == "1" ]]; then
  return 0 2>/dev/null || true
fi
export UXF_LOCAL_INFRA_LOADED=1

LOCAL_INFRA_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LOCAL_INFRA_COMPOSE="${LOCAL_INFRA_DIR}/docker-compose.yml"
LOCAL_INFRA_STATE_DIR="/tmp/uxf-e2e-local-infra"
LOCAL_INFRA_STATE_FILE="${LOCAL_INFRA_STATE_DIR}/state.env"
LOCAL_INFRA_FAUCET_CONTAINER="uxf-e2e-faucet"
LOCAL_INFRA_FAUCET_IMAGE="${LOCAL_INFRA_FAUCET_IMAGE:-ghcr.io/unicitynetwork/agentic-hosting/faucet:local}"
LOCAL_INFRA_RELAY_URL="ws://127.0.0.1:7777"

# ---------------------------------------------------------------------------
# Internal: emit one log line with a consistent prefix.
# ---------------------------------------------------------------------------
_li_log() {
  echo "[local-infra-sh] $*"
}

# ---------------------------------------------------------------------------
# local_infra_up — boot relay + faucet, export env vars.
#
# Honours an existing state file: if the stack was already booted by a
# parent process (e.g., a vitest globalSetup that fans out a shell test),
# this just sources the cached state and returns.
#
# On boot failure, the function returns non-zero — the caller decides
# whether to skip or fail. (Most callers `set -e` and let the script
# abort.)
# ---------------------------------------------------------------------------
local_infra_up() {
  # Skip when E2E_LOCAL_INFRA=0/unset — caller wants public testnet.
  if [[ "${E2E_LOCAL_INFRA:-0}" != "1" ]]; then
    return 0
  fi

  # Reuse cached state if a parent already booted us.
  if [[ -f "$LOCAL_INFRA_STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$LOCAL_INFRA_STATE_FILE"
    if [[ -n "${E2E_LOCAL_FAUCET_PUBKEY:-}" && -n "${SPHERE_NOSTR_RELAYS:-}" ]]; then
      _li_log "reusing existing state from $LOCAL_INFRA_STATE_FILE (relay=$SPHERE_NOSTR_RELAYS faucet=${E2E_LOCAL_FAUCET_PUBKEY:0:16}…)"
      export E2E_LOCAL_FAUCET_PUBKEY SPHERE_NOSTR_RELAYS
      return 0
    fi
    _li_log "stale state file at $LOCAL_INFRA_STATE_FILE — re-booting"
    rm -f "$LOCAL_INFRA_STATE_FILE"
  fi

  command -v docker >/dev/null 2>&1 || {
    _li_log "ERROR: docker CLI not available; cannot boot local infra"
    return 1
  }

  # 1. Relay
  _li_log "booting Nostr relay via $LOCAL_INFRA_COMPOSE…"
  if ! docker compose -f "$LOCAL_INFRA_COMPOSE" up -d relay >&2; then
    _li_log "ERROR: docker compose up failed"
    return 1
  fi

  # Wait for NIP-11 doc.
  local deadline=$((SECONDS + 60))
  local relay_healthy=0
  while (( SECONDS < deadline )); do
    if curl -sf -H "Accept: application/nostr+json" "http://127.0.0.1:7777" -o /dev/null 2>/dev/null; then
      relay_healthy=1
      break
    fi
    sleep 1
  done
  if (( relay_healthy != 1 )); then
    _li_log "ERROR: relay never became healthy within 60s"
    docker compose -f "$LOCAL_INFRA_COMPOSE" logs relay 2>&1 | tail -30 >&2
    return 1
  fi
  _li_log "relay healthy at $LOCAL_INFRA_RELAY_URL"
  export SPHERE_NOSTR_RELAYS="$LOCAL_INFRA_RELAY_URL"

  # 2. Faucet — skip if operator opts out (handy for debugging the
  # faucet by hand without the harness racing it).
  if [[ "${E2E_LOCAL_INFRA_NO_FAUCET:-0}" == "1" ]]; then
    _li_log "E2E_LOCAL_INFRA_NO_FAUCET=1 — skipping faucet boot"
    _li_state_write
    return 0
  fi

  # Verify the faucet image is locally available.
  if ! docker image inspect "$LOCAL_INFRA_FAUCET_IMAGE" >/dev/null 2>&1; then
    _li_log "ERROR: faucet image $LOCAL_INFRA_FAUCET_IMAGE not found locally."
    _li_log "       Build it first: cd /home/vrogojin && docker build -f js-faucet/Dockerfile -t $LOCAL_INFRA_FAUCET_IMAGE ."
    return 1
  fi

  # Pre-clean a leftover container.
  docker rm -f "$LOCAL_INFRA_FAUCET_CONTAINER" >/dev/null 2>&1 || true

  # Generate fake-but-valid secp256k1 pubkey for UNICITY_MANAGER_PUBKEY.
  # `openssl ecparam -name secp256k1 -genkey` produces a key; we extract
  # the public point and compress it manually. The compressed form is
  # 33 bytes: prefix (02 if y even, 03 if y odd) + 32-byte X coord.
  local fake_manager_pubkey
  fake_manager_pubkey="$(_li_random_secp256k1_pubkey)" || {
    _li_log "ERROR: failed to derive a random secp256k1 pubkey"
    return 1
  }
  local fake_manager_direct="DIRECT://${fake_manager_pubkey}"
  local boot_token="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  local instance_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  local short_id="${instance_id:0:8}"

  _li_log "spawning faucet $LOCAL_INFRA_FAUCET_CONTAINER from $LOCAL_INFRA_FAUCET_IMAGE…"
  if ! docker run -d \
      --name "$LOCAL_INFRA_FAUCET_CONTAINER" \
      --network host \
      -e "UNICITY_MANAGER_PUBKEY=${fake_manager_pubkey}" \
      -e "UNICITY_MANAGER_DIRECT_ADDRESS=${fake_manager_direct}" \
      -e "UNICITY_BOOT_TOKEN=${boot_token}" \
      -e "UNICITY_INSTANCE_ID=${instance_id}" \
      -e "UNICITY_INSTANCE_NAME=e2e-local-faucet-${short_id}" \
      -e "UNICITY_TEMPLATE_ID=faucet-agent" \
      -e "UNICITY_NETWORK=testnet" \
      -e "UNICITY_LOG_LEVEL=info" \
      -e "UNICITY_HEARTBEAT_INTERVAL_MS=60000" \
      -e "SPHERE_NOSTR_RELAYS=${LOCAL_INFRA_RELAY_URL}" \
      "$LOCAL_INFRA_FAUCET_IMAGE" >&2; then
    _li_log "ERROR: docker run failed for faucet"
    return 1
  fi

  # Tail logs for chain_pubkey announcement.
  deadline=$((SECONDS + 120))
  local faucet_pubkey=""
  while (( SECONDS < deadline )); do
    # Container alive?
    local running
    running=$(docker inspect -f '{{.State.Running}}' "$LOCAL_INFRA_FAUCET_CONTAINER" 2>/dev/null || echo "false")
    if [[ "$running" != "true" ]]; then
      _li_log "ERROR: faucet container exited prematurely"
      docker logs "$LOCAL_INFRA_FAUCET_CONTAINER" --tail 50 2>&1 >&2 || true
      return 1
    fi
    # Look for the dedicated boot signal.
    local logs_text
    logs_text=$(docker logs "$LOCAL_INFRA_FAUCET_CONTAINER" --tail 200 2>&1 || true)
    faucet_pubkey=$(echo "$logs_text" | grep -oE '"chain_pubkey":"(02|03)[0-9a-f]{64}"' | head -1 | sed 's/.*"chain_pubkey":"\([^"]*\)"/\1/')
    if [[ -n "$faucet_pubkey" ]]; then
      break
    fi
    sleep 1
  done
  if [[ -z "$faucet_pubkey" ]]; then
    _li_log "ERROR: faucet did not log chain_pubkey within 120s"
    docker logs "$LOCAL_INFRA_FAUCET_CONTAINER" --tail 50 2>&1 >&2 || true
    return 1
  fi
  _li_log "faucet ready: chain_pubkey=${faucet_pubkey:0:16}…"
  export E2E_LOCAL_FAUCET_PUBKEY="$faucet_pubkey"

  _li_state_write
  return 0
}

# ---------------------------------------------------------------------------
# local_infra_down — stop relay + faucet. Idempotent.
# ---------------------------------------------------------------------------
local_infra_down() {
  if [[ "${E2E_LOCAL_INFRA:-0}" != "1" ]]; then
    return 0
  fi
  _li_log "stopping local infra…"
  docker rm -f "$LOCAL_INFRA_FAUCET_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$LOCAL_INFRA_COMPOSE" down >/dev/null 2>&1 || true
  rm -f "$LOCAL_INFRA_STATE_FILE"
  unset E2E_LOCAL_FAUCET_PUBKEY SPHERE_NOSTR_RELAYS
  _li_log "local infra stopped."
}

# ---------------------------------------------------------------------------
# Internal: persist state for sub-shells.
# ---------------------------------------------------------------------------
_li_state_write() {
  mkdir -p "$LOCAL_INFRA_STATE_DIR"
  cat > "$LOCAL_INFRA_STATE_FILE" <<EOF
# auto-generated by tests/e2e/local-infra/local-infra.sh
export SPHERE_NOSTR_RELAYS="$SPHERE_NOSTR_RELAYS"
export E2E_LOCAL_FAUCET_PUBKEY="${E2E_LOCAL_FAUCET_PUBKEY:-}"
export E2E_LOCAL_INFRA=1
EOF
}

# ---------------------------------------------------------------------------
# Internal: derive a fresh compressed secp256k1 pubkey.
#
# Relies on `openssl ecparam` + `openssl ec` to extract the uncompressed
# point, then compresses it manually using awk (prefix 02 if y even,
# 03 if odd; keep the 32-byte X coord).
# ---------------------------------------------------------------------------
_li_random_secp256k1_pubkey() {
  command -v openssl >/dev/null 2>&1 || {
    _li_log "ERROR: openssl not on PATH; cannot derive a fake manager pubkey"
    return 1
  }
  # 1. Generate a fresh secp256k1 keypair.
  local pemkey
  pemkey=$(openssl ecparam -name secp256k1 -genkey -noout 2>/dev/null) || return 1
  # 2. Extract the uncompressed pub bytes via -pubout + -text.
  #    openssl prints "pub:" followed by colon-separated hex bytes.
  local pubhex
  pubhex=$(echo "$pemkey" | openssl ec -pubout -outform DER 2>/dev/null \
           | xxd -p -c 1000)
  # The DER blob ends with ASN.1 OCTET STRING wrapper; the last 65
  # bytes (130 hex chars) are the uncompressed point: 04 || X || Y.
  local last130="${pubhex: -130}"
  if [[ "${last130:0:2}" != "04" ]]; then
    return 1
  fi
  local x_hex="${last130:2:64}"
  local y_hex="${last130:66:64}"
  # Compress: 02 if y is even, 03 if odd. Use the LAST hex digit's
  # parity since the byte's parity is determined by its low nibble.
  local last_y_nibble="${y_hex: -1}"
  local prefix
  case "$last_y_nibble" in
    [02468aceACE]) prefix="02" ;;
    *)             prefix="03" ;;
  esac
  echo "${prefix}${x_hex}"
}

# Auto-up when sourced WITH E2E_LOCAL_INFRA=1.
if [[ "${E2E_LOCAL_INFRA:-0}" == "1" ]]; then
  if ! local_infra_up; then
    _li_log "local-infra boot failed — calling script will likely fail downstream"
  fi
fi
