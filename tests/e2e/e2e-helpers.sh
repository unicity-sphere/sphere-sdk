#!/usr/bin/env bash
# =============================================================================
# e2e-helpers.sh — Shared infrastructure for swap e2e test suite
#
# Source this from individual test scripts:
#   source "$(dirname "${BASH_SOURCE[0]}")/e2e-helpers.sh"
# =============================================================================

SDK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# Run CLI via npx tsx from the SDK root so it works from any directory.
# The --cwd flag ensures wallet profiles are created in CLI_DIR (the workspace).
CLI_BASE="npx --prefix ${SDK_ROOT} tsx ${SDK_ROOT}/cli/index.ts"
ESCROW_REPO="${ESCROW_REPO:-https://github.com/unicity-sphere/escrow-service.git}"
ESCROW_STARTUP_TIMEOUT=120

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
PASS=0; FAIL=0
TEST_NAME="${TEST_NAME:-unnamed}"
WORKSPACE=""
ESCROW_PID=""
ESCROW_DIR=""
ESCROW_NAMETAG=""
ESCROW=""
WALLETS_TO_DELETE=""
KEEP_WALLETS=false
KEEP_WORKSPACE=false

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log()  { echo "[$(date '+%H:%M:%S')] [${TEST_NAME}] $*"; }
ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ FAIL: $*" >&2; FAIL=$((FAIL + 1)); }
die()  { echo "  ! FATAL: $*" >&2; summary; exit 1; }

summary() {
  echo ""
  echo "================================================="
  echo "  ${TEST_NAME}: ${PASS} passed, ${FAIL} failed"
  echo "================================================="
}

# ---------------------------------------------------------------------------
# parse_e2e_args — common argument parsing
# Sets: MODE, ESCROW_CMD, KEEP_WALLETS, KEEP_WORKSPACE
# ---------------------------------------------------------------------------
MODE="dev"
ESCROW_CMD=""

parse_e2e_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --escrow-cmd)   ESCROW_CMD="$2"; MODE="dev"; shift 2 ;;
      --escrow)       MODE="external"; ESCROW="${2}"; shift 2 ;;
      --keep-wallets) KEEP_WALLETS=true; shift ;;
      --keep-workspace) KEEP_WORKSPACE=true; shift ;;
      --clone)        MODE="clone"; shift ;;
      *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# setup_workspace — create temp directory
# ---------------------------------------------------------------------------
setup_workspace() {
  # Include nanoseconds + random suffix to avoid collisions when tests start in the same second
  RUN_ID="$(date +%s)$(shuf -i 100-999 -n1)"
  WORKSPACE=$(mktemp -d /tmp/swap-e2e-XXXXXX)
  CLI_DIR="$WORKSPACE"
  log "Workspace: ${WORKSPACE}"
}

# ---------------------------------------------------------------------------
# setup_escrow — clone or copy escrow, generate .env
# ---------------------------------------------------------------------------
setup_escrow() {
  if [[ "$MODE" == "external" ]]; then
    log "Using external escrow: ${ESCROW}"
    return
  fi

  ESCROW_NAMETAG="esc-${RUN_ID}"
  ESCROW="@${ESCROW_NAMETAG}"
  ESCROW_DIR="${WORKSPACE}/escrow"

  if [[ "$MODE" == "clone" ]]; then
    log "Cloning escrow from ${ESCROW_REPO}..."
    git clone --depth 1 "$ESCROW_REPO" "$ESCROW_DIR" 2>&1 | tail -3
    (cd "$ESCROW_DIR" && npm install 2>&1 | tail -5)
  else
    if [[ -n "$ESCROW_CMD" ]]; then
      log "Running escrow-cmd..."
      export WORKSPACE
      eval "$ESCROW_CMD"
    else
      die "Dev mode requires --escrow-cmd"
    fi
    [[ -d "$ESCROW_DIR" ]] || die "escrow-cmd did not create ${ESCROW_DIR}"

    log "Patching escrow to use local SDK..."
    (cd "$ESCROW_DIR" && node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
      pkg.dependencies['@unicitylabs/sphere-sdk'] = 'file:${SDK_ROOT}';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    ")
    (cd "$ESCROW_DIR" && npm install 2>&1 | tail -5)
  fi

  # Clean pre-existing wallet data
  rm -rf "${ESCROW_DIR}/.sphere-escrow" "${ESCROW_DIR}/.escrow-data" 2>/dev/null || true

  # Generate .env
  cat > "${ESCROW_DIR}/.env" <<EOF
NODE_ENV=development
LOG_LEVEL=info
SPHERE_WALLET_PATH=./.sphere-escrow
SPHERE_NETWORK=testnet
SPHERE_NAMETAG=${ESCROW_NAMETAG}
ESCROW_DATA_DIR=./.escrow-data
MAX_PENDING_SWAPS=100
EOF
  log "Generated .env with nametag: ${ESCROW_NAMETAG}"
}

# ---------------------------------------------------------------------------
# launch_escrow — start escrow and wait for readiness
# ---------------------------------------------------------------------------
launch_escrow() {
  if [[ "$MODE" == "external" ]]; then return; fi
  [[ -d "${ESCROW_DIR}" ]] || die "setup_escrow must be called first"

  log "Launching escrow..."
  # Use setsid to create a new process group so we can kill ALL child processes
  # (npx → tsx → node) cleanly in cleanup, not just the subshell.
  setsid bash -c "cd '$ESCROW_DIR' && exec npx tsx --env-file=.env src/index.ts" > "${WORKSPACE}/escrow.log" 2>&1 &
  ESCROW_PID=$!
  log "Escrow PID: ${ESCROW_PID}"

  local elapsed=0
  while [[ $elapsed -lt $ESCROW_STARTUP_TIMEOUT ]]; do
    if ! kill -0 "$ESCROW_PID" 2>/dev/null; then
      tail -20 "${WORKSPACE}/escrow.log" 2>/dev/null || true
      die "Escrow died during startup"
    fi
    if grep -q "Escrow service started successfully" "${WORKSPACE}/escrow.log" 2>/dev/null; then
      log "Escrow ready (~${elapsed}s)"
      ok "Escrow running as ${ESCROW}"
      return
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  tail -20 "${WORKSPACE}/escrow.log" 2>/dev/null || true
  die "Escrow startup timed out (${ESCROW_STARTUP_TIMEOUT}s)"
}

# ---------------------------------------------------------------------------
# ping_escrow — verify escrow is reachable via DM round-trip
# Requires a wallet profile to be active (any profile works).
# ---------------------------------------------------------------------------
ping_escrow() {
  local profile="$1" escrow_addr="$2" max_attempts="${3:-5}"
  log "Pinging escrow ${escrow_addr}..."
  for attempt in $(seq 1 "$max_attempts"); do
    local out
    out=$(cli_as "$profile" swap-ping "$escrow_addr" 2>&1) || true
    if echo "$out" | grep -q '"escrow_address"'; then
      log "Escrow responded to ping (attempt ${attempt})"
      ok "Escrow reachable at ${escrow_addr}"
      return 0
    fi
    if [[ $attempt -lt $max_attempts ]]; then
      sleep 3
    fi
  done
  die "Escrow ${escrow_addr} did not respond to ping after ${max_attempts} attempts"
}

# ---------------------------------------------------------------------------
# cleanup — kill escrow, delete wallets, delete workspace
# ---------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  if [[ -n "$ESCROW_PID" ]]; then
    log "Stopping escrow (PID ${ESCROW_PID})..."
    # Kill the entire process group (setsid created a new group with PGID = ESCROW_PID).
    # This ensures npx → tsx → node child processes are all terminated.
    kill -- -"$ESCROW_PID" 2>/dev/null || kill "$ESCROW_PID" 2>/dev/null || true
    local w=0
    while kill -0 "$ESCROW_PID" 2>/dev/null && [[ $w -lt 5 ]]; do sleep 1; w=$((w+1)); done
    kill -9 -- -"$ESCROW_PID" 2>/dev/null || kill -9 "$ESCROW_PID" 2>/dev/null || true
  fi

  # On failure: preserve escrow log for post-mortem diagnosis.
  # Copy to a stable location that survives workspace cleanup.
  if [[ $exit_code -ne 0 || $FAIL -gt 0 ]] && [[ -n "${WORKSPACE:-}" ]]; then
    local escrow_log="${WORKSPACE}/escrow.log"
    if [[ -f "$escrow_log" ]]; then
      local preserved="/tmp/escrow-${TEST_NAME}-$(date +%s).log"
      cp "$escrow_log" "$preserved" 2>/dev/null || true
      log "Escrow log preserved: ${preserved}"
    fi
  fi

  if [[ "$KEEP_WALLETS" == "false" ]] && [[ -n "${WORKSPACE:-}" ]]; then
    for p in $WALLETS_TO_DELETE; do
      _cli wallet delete "$p" > /dev/null 2>&1 || true
    done
  fi
  if [[ "$KEEP_WORKSPACE" == "false" ]] && [[ -n "$WORKSPACE" ]]; then
    rm -rf -- "$WORKSPACE"
  else
    [[ -n "$WORKSPACE" ]] && log "Workspace preserved: ${WORKSPACE}"
  fi
  exit "$exit_code"
}

# ---------------------------------------------------------------------------
# Wallet helpers
# ---------------------------------------------------------------------------
create_wallet() {
  local profile="$1" nametag="${2:-$1}"
  _cli wallet create "$profile" --network testnet > /dev/null 2>&1
  _cli wallet use "$profile" > /dev/null 2>&1
  _cli init --nametag "$nametag" > /dev/null 2>&1
  ok "Wallet ${profile} (@${nametag})"
}

topup_wallet() {
  local profile="$1" coin="$2" amount="$3"
  _cli wallet use "$profile" > /dev/null 2>&1
  _cli topup "$amount" "$coin" 2>&1 | tail -2
  _cli balance --finalize > /dev/null 2>&1 || true
  ok "Topup ${profile}: ${amount} ${coin}"
}

# Run CLI from the workspace so each test has its own .sphere-cli/config.json.
# This prevents parallel tests from racing on the shared config file.
CLI_DIR=""

_cli() {
  local dir="${CLI_DIR:-$WORKSPACE}"
  (cd "$dir" && $CLI_BASE "$@")
}

cli_as() {
  local profile="$1"; shift
  _cli wallet use "$profile" > /dev/null 2>&1 || true
  _cli "$@" 2>&1
}

# ---------------------------------------------------------------------------
# Swap helpers
# ---------------------------------------------------------------------------
propose_swap() {
  local alice="$1" bob_tag="$2" offer="$3" want="$4" escrow_addr="$5" timeout="${6:-3600}"
  local out
  out=$(cli_as "$alice" swap-propose \
    --to "@${bob_tag}" --offer "$offer" --want "$want" \
    --escrow "$escrow_addr" --timeout "$timeout" 2>&1) || true
  local swap_id
  swap_id=$(echo "$out" | grep -oP '"swap_id"\s*:\s*"\K[^"]+' | head -1)
  [[ -z "$swap_id" ]] && { echo "$out" >&2; die "Failed to extract swap_id"; }
  echo "$swap_id"
}

accept_swap() {
  local profile="$1" prefix="$2" max_wait="${3:-600}"
  local attempts=$((max_wait / 5))
  for i in $(seq 1 "$attempts"); do
    local try
    try=$(cli_as "$profile" swap-accept "$prefix" 2>&1) || true
    if echo "$try" | grep -qiE "Swap accepted|announced|deposit invoice"; then
      ok "Swap accepted by ${profile} (attempt ${i})"
      return 0
    fi
    sleep 5
  done
  die "Could not accept swap after ${max_wait}s"
}

deposit_swap() {
  local profile="$1" prefix="$2" max_attempts="${3:-3}"
  local out attempt=0

  while [[ $attempt -lt $max_attempts ]]; do
    attempt=$((attempt + 1))
    out=$(cli_as "$profile" swap-deposit "$prefix" 2>&1) || true
    log "deposit_swap ${profile} (attempt ${attempt}): $(echo "$out" | grep -E 'status|Error|error|Deposit|announced|Insufficient|WRONG_STATE' | head -2)" >&2

    # Success
    if echo "$out" | grep -qiE '"status".*"(completed|submitted|delivered)"'; then
      ok "${profile} deposit completed"
      return 0
    fi

    # Permanent errors — don't retry
    if echo "$out" | grep -qiE 'SWAP_NOT_FOUND|SWAP_INVALID|SWAP_WRONG_STATE|already submitted'; then
      fail "${profile} deposit failed: $(echo "$out" | grep -iE 'error|fail|Insufficient|WRONG_STATE' | head -1)"
      return 1
    fi

    # Transient errors — retry (e.g., "did not reach announced", relay timeout)
    if [[ $attempt -lt $max_attempts ]]; then
      log "deposit_swap ${profile}: transient error, retrying in 10s..." >&2
      sleep 10
    fi
  done

  # Exhausted retries
  if echo "$out" | grep -qiE 'error|fail'; then
    fail "${profile} deposit failed after ${max_attempts} attempts: $(echo "$out" | grep -iE 'error|fail' | head -1)"
  else
    fail "${profile} deposit produced unexpected output after ${max_attempts} attempts"
  fi
}

wait_swap_progress() {
  local profile="$1" prefix="$2" targets="$3" stale_timeout="${4:-300}"
  local max_elapsed=$((stale_timeout * 3))  # absolute cap: 3x staleness timeout
  local elapsed=0 progress="" last_progress="" last_change_at=0
  last_change_at=$(date +%s)

  while [[ $elapsed -lt $max_elapsed ]]; do
    local out
    out=$(cli_as "$profile" swap-status "$prefix" 2>&1) || true
    progress=$({ echo "$out" | grep -oP '\b(proposed|accepted|announced|depositing|awaiting_counter|concluding|completed|failed|cancelled)\b' || true; } | tail -1)
    [[ -z "$progress" ]] && echo "$out" | grep -qi "no swap found" && progress="pruned"

    log "[${elapsed}s] ${profile}: ${progress:-unknown}" >&2

    # Target reached
    if echo "$progress" | grep -qE "^(${targets})$"; then
      echo "$progress"
      return 0
    fi

    # Track state changes — reset staleness timer on any progress
    if [[ "$progress" != "$last_progress" && -n "$progress" ]]; then
      last_progress="$progress"
      last_change_at=$(date +%s)
    fi

    # Staleness check: if state hasn't changed for stale_timeout, give up.
    # This means the swap is stuck — not making any forward progress.
    local now
    now=$(date +%s)
    local stale_for=$(( now - last_change_at ))
    if [[ $stale_for -ge $stale_timeout ]]; then
      log "Swap stale for ${stale_for}s (no state change) — giving up" >&2
      echo "${progress:-unknown}"
      return 1
    fi

    # Adaptive poll: fast at first, slow down after 30s
    if [[ $elapsed -lt 30 ]]; then
      sleep 3
      elapsed=$((elapsed + 3))
    else
      sleep 5
      elapsed=$((elapsed + 5))
    fi
  done
}

get_deposit_invoice_id() {
  local profile="$1" prefix="$2"
  local out
  out=$(cli_as "$profile" swap-status "$prefix" 2>&1) || true
  echo "$out" | grep -oP '"depositInvoiceId"\s*:\s*"\K[^"]+' | head -1
}

# ---------------------------------------------------------------------------
# Balance assertion helpers
# ---------------------------------------------------------------------------

# get_coin_token_count <profile> <symbol>
# Returns the number of tokens held for a given coin symbol.
# Parses balance output: "BTC: 0.00000010 (2 tokens)" → 2
get_coin_token_count() {
  local profile="$1" symbol="$2"
  local out
  out=$(cli_as "$profile" balance --no-sync 2>&1) || true
  # Match: "BTC: 0.00000010 (2 tokens)" or "BTC: 0.00000005 (1 token)"
  echo "$out" | grep "^${symbol}:" | sed -n 's/.*(\([0-9]*\) token.*/\1/p' | head -1
}

# get_coin_amount <profile> <symbol>
# Returns the total raw integer amount for a given coin symbol.
# Sums amounts across all tokens of that coin.
# Uses a dedicated CLI query: `tokens --no-sync` and parses output.
get_coin_amount() {
  local profile="$1" symbol="$2"
  local out total=0
  out=$(cli_as "$profile" tokens --no-sync 2>&1) || true
  # tokens output format:
  #   Coin: BTC (abcd1234...)
  #   Amount: 0.00000010 BTC
  # We need to match the coin line, then extract from the Amount line.
  # Since amounts are formatted as human-readable decimals, and we need raw
  # integer amounts, we use the balance line format instead.
  # Balance format: "BTC: 0.00000010 (2 tokens)"
  # The displayed value = raw_amount / 10^decimals
  # For swap assertions, we compare token counts which proves splitting.
  #
  # Alternative: use the balance confirmedAmount + unconfirmedAmount fields.
  # For simplicity, extract the formatted balance and compare as strings.
  out=$(cli_as "$profile" balance --no-sync 2>&1) || true
  echo "$out" | grep "^${symbol}:" | sed -n "s/^${symbol}: \([0-9.]*\).*/\1/p" | head -1
}

# assert_coin_present <profile> <symbol> <label>
# Asserts that the wallet has at least one token of the given coin.
assert_coin_present() {
  local profile="$1" symbol="$2" label="$3"
  local count
  count=$(get_coin_token_count "$profile" "$symbol")
  if [[ -n "$count" && "$count" -gt 0 ]]; then
    ok "${label}: has ${symbol} (${count} token(s))"
  else
    fail "${label}: missing ${symbol} — expected at least 1 token"
  fi
}

# assert_coin_token_count <profile> <symbol> <expected_count> <label>
# Asserts that the wallet has exactly the expected number of tokens for a coin.
assert_coin_token_count() {
  local profile="$1" symbol="$2" expected="$3" label="$4"
  local count
  count=$(get_coin_token_count "$profile" "$symbol")
  if [[ "${count:-0}" -eq "$expected" ]]; then
    ok "${label}: ${symbol} has ${count} token(s)"
  else
    fail "${label}: ${symbol} expected ${expected} token(s), got ${count:-0}"
  fi
}

# assert_deposit_change <profile> <symbol> <label>
# After a deposit that required a token split, asserts that the change
# token exists (i.e., the wallet still holds the original coin).
# This is the critical assertion: deposit must NOT consume the entire token.
assert_deposit_change() {
  local profile="$1" symbol="$2" label="$3"
  local count
  count=$(get_coin_token_count "$profile" "$symbol")
  if [[ -n "$count" && "$count" -ge 1 ]]; then
    ok "${label}: change token preserved (${count} ${symbol} token(s) remaining)"
  else
    fail "${label}: change token MISSING — deposit consumed entire ${symbol} token"
  fi
}
