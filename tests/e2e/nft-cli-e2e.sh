#!/usr/bin/env bash
# =============================================================================
# nft-cli-e2e.sh — End-to-end CLI test for NFT commands
#
# Exercises all NFT CLI commands (collection CRUD, mint, list, info, history,
# export/import, verify, batch mint) against real infrastructure (Nostr + aggregator).
#
# Uses a fresh one-time-use wallet profile so each run starts clean.
#
# Usage:
#   bash tests/e2e/nft-cli-e2e.sh
#   bash tests/e2e/nft-cli-e2e.sh --keep-wallet
#   NETWORK=dev bash tests/e2e/nft-cli-e2e.sh
# =============================================================================

set -euo pipefail

SDK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$SDK_ROOT"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
KEEP_WALLET=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-wallet)
      KEEP_WALLET=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--keep-wallet]" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
NETWORK="${NETWORK:-testnet}"
CLI="npm run cli --"
RUN_ID=$(date +%s)
PROFILE="e2e_nft_${RUN_ID}_$$"
WORKSPACE=$(mktemp -d /tmp/nft-e2e-XXXXXX)

# ---------------------------------------------------------------------------
# Logging / assertions
# ---------------------------------------------------------------------------
PASS=0; FAIL=0; TOTAL_STEPS=0
log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ FAIL: $*" >&2; FAIL=$((FAIL + 1)); }
die()  { echo "  ! FATAL: $*" >&2; summary; exit 1; }

summary() {
  echo ""
  echo "================================================="
  echo "  NFT CLI E2E: ${PASS} passed, ${FAIL} failed"
  echo "================================================="
}

# Run CLI command (always uses the test profile)
run_cli() {
  $CLI wallet use "$PROFILE" > /dev/null 2>&1 || { echo "WARN: wallet use failed for profile $PROFILE" >&2; }
  $CLI "$@" 2>&1
}

# Extract a JSON field value (first match, handles quoted strings and numbers)
jq_field() {
  local json="$1" field="$2"
  echo "$json" | grep -oP "\"${field}\"\s*:\s*\"?\K[^\",}]+" | head -1
}

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
cleanup() {
  local exit_code=$?

  if [[ "$KEEP_WALLET" == "false" ]]; then
    log "Cleaning up test wallet: ${PROFILE}"
    $CLI wallet delete "$PROFILE" > /dev/null 2>&1 || true
  else
    log "Keeping wallet: ${PROFILE}"
  fi

  log "Removing workspace: ${WORKSPACE}"
  rm -rf -- "$WORKSPACE"

  summary

  exit "$exit_code"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
echo ""
echo "=== NFT CLI E2E Tests ==="
echo "Network:   ${NETWORK}"
echo "Profile:   ${PROFILE}"
echo "Workspace: ${WORKSPACE}"
echo "SDK root:  ${SDK_ROOT}"
echo ""

# ---------------------------------------------------------------------------
# Step 0: Create wallet and initialize
# ---------------------------------------------------------------------------
log "=== STEP 0: Create fresh wallet ==="

$CLI wallet create "$PROFILE" --network "$NETWORK" > /dev/null 2>&1
$CLI wallet use "$PROFILE" > /dev/null 2>&1
INIT_OUT=$($CLI init --nametag "$PROFILE" 2>&1) || true
log "Init output (last 3 lines):"
echo "$INIT_OUT" | tail -3

if echo "$INIT_OUT" | grep -q "DIRECT://"; then
  ok "Wallet initialized with nametag @${PROFILE}"
else
  die "Wallet initialization failed"
fi

# Wait for aggregator round to confirm nametag
sleep 3

# ===========================================================================
# Step 1: Create a collection
# ===========================================================================
log ""
log "=== STEP 1: Create collection ==="

COLLECTION_OUT=$(run_cli nft-collection-create "Test Art" "E2E test collection" \
  --max-supply 10 2>&1) || true
log "Collection create output:"
echo "$COLLECTION_OUT"

COLLECTION_ID=$(jq_field "$COLLECTION_OUT" "collectionId")

if [[ -n "$COLLECTION_ID" ]]; then
  ok "Collection created: ${COLLECTION_ID:0:16}..."
else
  die "No collectionId in output"
fi

# ===========================================================================
# Step 2: List collections
# ===========================================================================
log ""
log "=== STEP 2: List collections ==="

LIST_COLL_OUT=$(run_cli nft-collection-list --json 2>&1) || true
log "Collection list output:"
echo "$LIST_COLL_OUT"

if echo "$LIST_COLL_OUT" | grep -q "$COLLECTION_ID"; then
  ok "Created collection appears in list"
else
  fail "Created collection not found in list"
fi

# Check tokenCount is 0
TOKEN_COUNT=$(echo "$LIST_COLL_OUT" | grep -oP '"tokenCount"\s*:\s*\K[0-9]+' | head -1)
if [[ "$TOKEN_COUNT" == "0" ]]; then
  ok "Collection tokenCount is 0 (no minted NFTs yet)"
else
  fail "Expected tokenCount 0, got: ${TOKEN_COUNT:-unknown}"
fi

# ===========================================================================
# Step 3: Collection info
# ===========================================================================
log ""
log "=== STEP 3: Collection info ==="

# Use first 12 chars as prefix
COLL_PREFIX="${COLLECTION_ID:0:12}"
COLL_INFO_OUT=$(run_cli nft-collection-info "$COLL_PREFIX" 2>&1) || true
log "Collection info output:"
echo "$COLL_INFO_OUT"

COLL_NAME=$(jq_field "$COLL_INFO_OUT" "name")
if [[ "$COLL_NAME" == "Test Art" ]]; then
  ok "Collection name matches 'Test Art'"
else
  fail "Collection name mismatch: expected 'Test Art', got '${COLL_NAME:-unknown}'"
fi

MAX_SUPPLY=$(jq_field "$COLL_INFO_OUT" "maxSupply")
if [[ "$MAX_SUPPLY" == "10" ]]; then
  ok "Collection maxSupply is 10"
else
  fail "maxSupply mismatch: expected 10, got '${MAX_SUPPLY:-unknown}'"
fi

# ===========================================================================
# Step 4: Mint a standalone NFT (no collection)
# ===========================================================================
log ""
log "=== STEP 4: Mint standalone NFT ==="

MINT1_OUT=$(run_cli nft-mint "Standalone Art" "ipfs://QmTestStandalone1" \
  --description "A standalone e2e test NFT" --json 2>&1) || true
log "Mint standalone output:"
echo "$MINT1_OUT"

STANDALONE_TOKEN_ID=$(jq_field "$MINT1_OUT" "tokenId")
if [[ -n "$STANDALONE_TOKEN_ID" ]]; then
  ok "Standalone NFT minted: ${STANDALONE_TOKEN_ID:0:16}..."
else
  fail "No tokenId in standalone mint output"
fi

# Wait for aggregator confirmation
sleep 3

# ===========================================================================
# Step 5: Mint a collection NFT
# ===========================================================================
log ""
log "=== STEP 5: Mint collection NFT #1 ==="

MINT2_OUT=$(run_cli nft-mint "Collection Art #1" "ipfs://QmTestCollection1" \
  --collection "$COLL_PREFIX" \
  --attribute "Color:Blue" --attribute "Rarity:Common" \
  --json 2>&1) || true
log "Mint collection NFT #1 output:"
echo "$MINT2_OUT"

COLL_TOKEN_1=$(jq_field "$MINT2_OUT" "tokenId")
MINT2_COLL=$(jq_field "$MINT2_OUT" "collectionId")

if [[ -n "$COLL_TOKEN_1" ]]; then
  ok "Collection NFT #1 minted: ${COLL_TOKEN_1:0:16}..."
else
  fail "No tokenId in collection mint output"
fi

if [[ -n "$MINT2_COLL" ]]; then
  ok "Collection NFT #1 has collectionId"
else
  fail "No collectionId in collection mint output"
fi

# Wait for aggregator confirmation
sleep 3

# ===========================================================================
# Step 6: Mint another collection NFT (auto-increment edition)
# ===========================================================================
log ""
log "=== STEP 6: Mint collection NFT #2 ==="

MINT3_OUT=$(run_cli nft-mint "Collection Art #2" "ipfs://QmTestCollection2" \
  --collection "$COLL_PREFIX" \
  --attribute "Color:Red" --attribute "Rarity:Rare" \
  --json 2>&1) || true
log "Mint collection NFT #2 output:"
echo "$MINT3_OUT"

COLL_TOKEN_2=$(jq_field "$MINT3_OUT" "tokenId")
EDITION_2=$(jq_field "$MINT3_OUT" "edition")

if [[ -n "$COLL_TOKEN_2" ]]; then
  ok "Collection NFT #2 minted: ${COLL_TOKEN_2:0:16}..."
else
  fail "No tokenId in second collection mint output"
fi

if [[ -n "$EDITION_2" ]] && [[ "$EDITION_2" -gt 1 ]] 2>/dev/null; then
  ok "Edition auto-incremented to ${EDITION_2}"
else
  fail "Edition not auto-incremented: got '${EDITION_2:-empty}' (expected > 1)"
fi

# Wait for aggregator confirmation
sleep 3

# ===========================================================================
# Step 7: List all NFTs
# ===========================================================================
log ""
log "=== STEP 7: List all NFTs ==="

NFT_LIST_OUT=$(run_cli nft-list --json 2>&1) || true
log "NFT list output:"
echo "$NFT_LIST_OUT"

# Count NFTs (each should have a tokenId)
NFT_COUNT=$(echo "$NFT_LIST_OUT" | grep -c '"tokenId"' || true)
if [[ "$NFT_COUNT" -ge 3 ]]; then
  ok "At least 3 NFTs in wallet (found ${NFT_COUNT})"
else
  fail "Expected at least 3 NFTs, found ${NFT_COUNT}"
fi

# Test collection filter
NFT_LIST_FILTERED=$(run_cli nft-list --collection "$COLL_PREFIX" --json 2>&1) || true
FILTERED_COUNT=$(echo "$NFT_LIST_FILTERED" | grep -c '"tokenId"' || true)
if [[ "$FILTERED_COUNT" -ge 2 ]]; then
  ok "Collection filter works: ${FILTERED_COUNT} NFTs in collection"
else
  fail "Expected at least 2 NFTs in collection filter, found ${FILTERED_COUNT}"
fi

# ===========================================================================
# Step 8: NFT info
# ===========================================================================
log ""
log "=== STEP 8: NFT info ==="

# Use standalone token prefix
if [[ -n "$STANDALONE_TOKEN_ID" ]]; then
  TOKEN_PREFIX="${STANDALONE_TOKEN_ID:0:12}"
  NFT_INFO_OUT=$(run_cli nft-info "$TOKEN_PREFIX" 2>&1) || true
  log "NFT info output:"
  echo "$NFT_INFO_OUT"

  INFO_NAME=$(jq_field "$NFT_INFO_OUT" "name")
  if [[ "$INFO_NAME" == "Standalone Art" ]] || echo "$NFT_INFO_OUT" | grep -q "Standalone Art"; then
    ok "NFT info name matches 'Standalone Art'"
  else
    fail "NFT info name mismatch: got '${INFO_NAME:-unknown}'"
  fi

  if echo "$NFT_INFO_OUT" | grep -q "ipfs://QmTestStandalone1"; then
    ok "NFT info image URI matches"
  else
    fail "NFT info image URI not found"
  fi
else
  fail "Skipping NFT info — no standalone token ID"
fi

# ===========================================================================
# Step 9: NFT history
# ===========================================================================
log ""
log "=== STEP 9: NFT history ==="

if [[ -n "$STANDALONE_TOKEN_ID" ]]; then
  TOKEN_PREFIX="${STANDALONE_TOKEN_ID:0:12}"
  NFT_HIST_OUT=$(run_cli nft-history "$TOKEN_PREFIX" 2>&1) || true
  log "NFT history output:"
  echo "$NFT_HIST_OUT"

  if echo "$NFT_HIST_OUT" | grep -qi "mint"; then
    ok "Mint event appears in history"
  else
    if echo "$NFT_HIST_OUT" | grep -qi "no history\|0 events\|empty"; then
      fail "No mint event in history (history is empty)"
    else
      fail "Unexpected history output — no mint event found"
    fi
  fi
else
  fail "Skipping NFT history — no standalone token ID"
fi

# ===========================================================================
# Step 10: Send NFT (self-send)
# ===========================================================================
log ""
log "=== STEP 10: Send NFT (self-send) ==="

if [[ -n "$COLL_TOKEN_1" ]]; then
  # Resolve own direct address for self-send
  OWN_ADDR=$(echo "$INIT_OUT" | grep -oP 'DIRECT://\S+' | head -1)
  if [[ -n "$OWN_ADDR" ]]; then
    TOKEN_PREFIX="${COLL_TOKEN_1:0:12}"
    SEND_OUT=$(run_cli nft-send "$TOKEN_PREFIX" "$OWN_ADDR" 2>&1) || true
    log "NFT send output:"
    echo "$SEND_OUT"

    if echo "$SEND_OUT" | grep -qi "success\|sent\|delivered\|completed\|transfer"; then
      ok "NFT self-send completed"
    elif echo "$SEND_OUT" | grep -qi "error\|fail"; then
      fail "NFT send reported errors: $(echo "$SEND_OUT" | grep -i "error\|fail" | head -2)"
    else
      fail "NFT send output unrecognized — no success indicator"
    fi

    # Wait for confirmation then receive the self-sent token
    sleep 3
    run_cli receive --finalize 2>&1 >/dev/null || true
    sleep 2

    # Verify token still appears in wallet (self-send)
    SEND_LIST_OUT=$(run_cli nft-list --json 2>&1) || true
    if echo "$SEND_LIST_OUT" | grep -q "$COLL_TOKEN_1"; then
      ok "Self-sent NFT still appears in wallet"
    else
      fail "Self-sent NFT not found in wallet after transfer"
    fi
  else
    fail "Could not resolve own DIRECT address for self-send"
  fi
else
  fail "Skipping NFT send — no collection token ID"
fi

# ===========================================================================
# Step 11: Export NFT
# ===========================================================================
log ""
log "=== STEP 11: Export NFT ==="

EXPORT_FILE="${WORKSPACE}/exported-nft.json"

if [[ -n "$STANDALONE_TOKEN_ID" ]]; then
  TOKEN_PREFIX="${STANDALONE_TOKEN_ID:0:12}"
  EXPORT_OUT=$(run_cli nft-export "$TOKEN_PREFIX" --output "$EXPORT_FILE" 2>&1) || true
  log "Export output:"
  echo "$EXPORT_OUT"

  if [[ -f "$EXPORT_FILE" ]]; then
    # Check it's valid JSON
    if python3 -c "import json; json.load(open('${EXPORT_FILE}'))" 2>/dev/null || \
       node -e "JSON.parse(require('fs').readFileSync('${EXPORT_FILE}','utf8'))" 2>/dev/null; then
      ok "Exported valid JSON to ${EXPORT_FILE}"
    else
      fail "Exported file is not valid JSON"
    fi

    # Check for tokenType or genesis.data fields
    if grep -q "tokenType\|genesis" "$EXPORT_FILE"; then
      ok "Export contains token type/genesis data"
    else
      fail "Export missing expected token structure"
    fi
  else
    # If --output didn't work, maybe export went to stdout
    if echo "$EXPORT_OUT" | grep -q "tokenType\|genesis"; then
      ok "Export output contains token data (written to stdout)"
      echo "$EXPORT_OUT" > "$EXPORT_FILE"
    else
      fail "Export file not created and no token data in stdout"
    fi
  fi
else
  fail "Skipping NFT export — no standalone token ID"
fi

# ===========================================================================
# Step 12: Import NFT
# ===========================================================================
log ""
log "=== STEP 12: Import NFT ==="

if [[ -f "$EXPORT_FILE" ]]; then
  IMPORT_OUT=$(run_cli nft-import "$EXPORT_FILE" 2>&1) || true
  log "NFT import output:"
  echo "$IMPORT_OUT"

  if echo "$IMPORT_OUT" | grep -qi "success\|imported\|added\|token"; then
    ok "NFT import completed"
  elif echo "$IMPORT_OUT" | grep -qi "error\|fail"; then
    fail "NFT import reported errors: $(echo "$IMPORT_OUT" | grep -i "error\|fail" | head -2)"
  else
    fail "NFT import output unrecognized — no success indicator"
  fi

  # Verify imported NFT appears in list
  sleep 2
  IMPORT_LIST_OUT=$(run_cli nft-list --json 2>&1) || true
  if [[ -n "$STANDALONE_TOKEN_ID" ]] && echo "$IMPORT_LIST_OUT" | grep -q "$STANDALONE_TOKEN_ID"; then
    ok "Imported NFT appears in nft-list"
  else
    fail "Imported NFT not found in nft-list"
  fi
else
  fail "Skipping NFT import — export file does not exist"
fi

# ===========================================================================
# Step 13: Verify NFT
# ===========================================================================
log ""
log "=== STEP 13: Verify NFT ==="

if [[ -n "$STANDALONE_TOKEN_ID" ]]; then
  TOKEN_PREFIX="${STANDALONE_TOKEN_ID:0:12}"
  VERIFY_EXIT=0
  VERIFY_OUT=$(run_cli nft-verify "$TOKEN_PREFIX" 2>&1) || VERIFY_EXIT=$?
  log "Verify output (exit code: ${VERIFY_EXIT}):"
  echo "$VERIFY_OUT"

  if echo "$VERIFY_OUT" | grep -qiP '\bvalid\b' && ! echo "$VERIFY_OUT" | grep -qi "invalid"; then
    ok "NFT verification reports valid"
  elif echo "$VERIFY_OUT" | grep -qi "verified"; then
    ok "NFT verification reports verified"
  elif [[ "$VERIFY_EXIT" -ne 0 ]]; then
    fail "NFT verification exited with code ${VERIFY_EXIT}"
  else
    fail "NFT verification output unexpected: ${VERIFY_OUT}"
  fi
else
  fail "Skipping NFT verify — no standalone token ID"
fi

# ===========================================================================
# Step 14: Collection list with updated token count
# ===========================================================================
log ""
log "=== STEP 14: Collection list with updated token count ==="

# Ensure any self-sent tokens are received before counting
run_cli receive --finalize 2>&1 >/dev/null || true

LIST_COLL2_OUT=$(run_cli nft-collection-list --json 2>&1) || true
log "Collection list output (post-mint):"
echo "$LIST_COLL2_OUT"

# Extract tokenCount for our collection
# Find the block containing our collection ID and its tokenCount
UPDATED_COUNT=$(echo "$LIST_COLL2_OUT" | \
  python3 -c "
import sys, json
try:
  data = json.loads(sys.stdin.read())
  for c in data:
    if c.get('collectionId','').startswith('${COLL_PREFIX}'):
      print(c.get('tokenCount', -1))
      break
except: pass
" 2>/dev/null || echo "")

if [[ -z "$UPDATED_COUNT" ]]; then
  # Fallback: try grep
  UPDATED_COUNT=$(echo "$LIST_COLL2_OUT" | grep -oP '"tokenCount"\s*:\s*\K[0-9]+' | head -1)
fi

if [[ -n "$UPDATED_COUNT" ]] && [[ "$UPDATED_COUNT" -ge 2 ]] 2>/dev/null; then
  ok "Collection tokenCount updated to ${UPDATED_COUNT} after minting"
else
  fail "Expected tokenCount >= 2, got: ${UPDATED_COUNT:-unknown}"
fi

# ===========================================================================
# Step 15: Batch mint
# ===========================================================================
log ""
log "=== STEP 15: Batch mint ==="

BATCH_FILE="${WORKSPACE}/batch-items.json"
cat > "$BATCH_FILE" <<'BATCHEOF'
[
  {
    "name": "Batch Art #1",
    "image": "ipfs://QmBatch1",
    "description": "First batch NFT",
    "attributes": [
      { "trait_type": "Style", "value": "Abstract" }
    ]
  },
  {
    "name": "Batch Art #2",
    "image": "ipfs://QmBatch2",
    "description": "Second batch NFT",
    "attributes": [
      { "trait_type": "Style", "value": "Minimalist" }
    ]
  }
]
BATCHEOF

BATCH_OUT=$(run_cli nft-batch-mint "$BATCH_FILE" --collection "$COLL_PREFIX" 2>&1) || true
log "Batch mint output:"
echo "$BATCH_OUT"

if echo "$BATCH_OUT" | grep -qi "success\|minted\|complete"; then
  ok "Batch mint completed"
else
  if echo "$BATCH_OUT" | grep -qi "error\|fail"; then
    fail "Batch mint reported errors: $(echo "$BATCH_OUT" | grep -i "error\|fail" | head -2)"
  else
    fail "Batch mint output unrecognized — no success/minted/complete indicator"
  fi
fi

# Verify batch items appear in NFT list
sleep 3
FINAL_LIST_OUT=$(run_cli nft-list --json 2>&1) || true
FINAL_COUNT=$(echo "$FINAL_LIST_OUT" | grep -c '"tokenId"' || true)

if [[ "$FINAL_COUNT" -ge 5 ]]; then
  ok "After batch mint: ${FINAL_COUNT} NFTs total (expected >= 5)"
else
  fail "After batch mint: expected >= 5 NFTs, found ${FINAL_COUNT}"
fi

# ===========================================================================
# Done
# ===========================================================================
log ""
log "=== All steps completed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
else
  exit 0
fi
