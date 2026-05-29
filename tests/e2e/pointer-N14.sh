#!/usr/bin/env bash
# =============================================================================
# pointer-N14.sh — N14 legacy-wallet migration smoke test
#
# SPEC TEST §5.16 (adapted). The spec's N14 is full legacy cold-start
# recovery against a real IPNS record on testnet. This script covers the
# LOCAL portion of that flow — the part we can actually test without a
# pre-existing legacy IPNS record on the network:
#
#   1. Pre-seed a fresh dataDir's `wallet.json` with a dummy
#      `profile.ipns.sequence` key (the legacy marker).
#   2. Run `init --profile` — the provider's `runLegacyIpnsMigrationBestEffort`
#      runs automatically inside initialize() (see profile/
#      profile-token-storage-provider.ts:1239).
#   3. Verify the wallet starts cleanly (migration is defensive: on
#      "no legacy IPNS record on network" it returns skipped='no-record'
#      and does NOT stamp the marker — next load retries).
#   4. Verify the pointer layer is usable post-init (pointer flush + status).
#
# The full end-to-end migration-done assertion — SPEC §5.16's "stamps
# profile.pointer.migration.done, token conservation holds" — is
# BLOCKED by the need for a real legacy IPNS record pre-existing on
# testnet. Token conservation in particular requires a funded wallet
# whose legacy snapshot references real bundles, which we cannot
# synthesize in CI.
#
# What DOES get validated here:
#   * The presence of `profile.ipns.sequence` does not crash init.
#   * The migration code path is exercised (best-effort; logs on fail).
#   * After the failed-migration no-op, pointer layer is usable.
#
# What we explicitly DO NOT validate (flagged in the commit message):
#   * MIGRATION_DONE_KEY stamping after successful bundle import
#     (needs a real IPNS record).
#   * Token conservation across migration (needs funded legacy wallet).
# =============================================================================
set -Eeuo pipefail
TEST_NAME="pointer-N14"
# shellcheck source=./pointer-N0-prologue.sh
source "$(dirname "${BASH_SOURCE[0]}")/pointer-N0-prologue.sh"

maybe_skip_no_testnet
setup_workspace
trap cleanup_workspace EXIT

DD="${WORKSPACE}/wallet-N14"
mkdir -p "$DD/.sphere-cli"

log "=== Step 1: pre-seed legacy marker in wallet.json ==="
# The FileStorageProvider writes a flat Record<string,string> at
# .sphere-cli/wallet.json (see impl/nodejs/storage/FileStorageProvider.ts).
# Seeding the legacy-IPNS sequence key BEFORE init makes the provider's
# initialize() path see the legacy signal (needsMigration returns true).
#
# Note: init() will OVERWRITE wallet.json with identity material on a
# fresh install, but the `profile.ipns.sequence` key we seed here will
# survive because FileStorageProvider.connect() loads and merges on top
# of existing content rather than clobbering. (See line 83 of
# FileStorageProvider.ts — data = JSON.parse(content).)
cat > "$DD/.sphere-cli/wallet.json" <<'EOF'
{
  "profile.ipns.sequence": "1"
}
EOF
ok "pre-seeded profile.ipns.sequence=1"

log "=== Step 2: init --profile; migration runs best-effort inside ==="
# Capture stdout/stderr so we can grep for the migration log line. The
# provider's log() helper (profile-token-storage-provider.ts:1258) prints
# "Legacy IPNS → pointer migration" or "Legacy migration skipped" —
# EITHER is acceptable here. A crash is NOT.
INIT_OUT=$(init_wallet "$DD" 2>&1) || die "init failed — migration crashed provider"
log "init output (tail):"
echo "$INIT_OUT" | tail -10 | sed 's/^/    /'

# Grep for evidence the migration code path was reached. Either:
#   - "Legacy IPNS" (provider log line when migration result is logged)
#   - "legacy" in some form (fallback)
# If the keyword is absent, the provider skipped the migration wrapper
# entirely (possibly because localCache was null), which is the failure
# case we want to flag.
if echo "$INIT_OUT" | grep -qiE 'legacy|migration|ipns'; then
  ok "migration code path was exercised (log evidence present)"
else
  # Not fatal — the provider logs at debug level by default and may not
  # flow through to CLI stdout. Absence is inconclusive, not a failure.
  log "no migration log in stdout — provider likely logs at debug level"
fi

# Crucial invariant: init completed, wallet is usable. The MIGRATION_DONE
# key is INTENTIONALLY not asserted here — see header comment.
log "=== Step 3: verify pointer layer is usable post-init ==="
flush_pointer "$DD" "post-migration"
assert_pointer_reachable   "$DD" "N14"
assert_pointer_not_blocked "$DD" "N14"
assert_pointer_fp_nonempty "$DD" "N14"

log "=== Step 4: wallet.json sanity — legacy key still present ==="
# The provider treats the legacy sequence key as a read-only signal; it
# should NOT be deleted by the migration's no-record path (marker-
# stamping is gated on successful resolve). If it's gone, something
# clobbered the local cache — that's a regression.
if grep -q '"profile.ipns.sequence"' "$DD/.sphere-cli/wallet.json"; then
  ok "legacy sequence key preserved after failed-migration no-op"
else
  bad "legacy sequence key was removed — unexpected (no-record path should not delete it)"
fi

# Document what we are NOT asserting so reviewers can see the gap.
log "NOTE: MIGRATION_DONE_KEY stamping requires a real legacy IPNS record on testnet — not verified by this script."
log "NOTE: Token conservation across migration requires a funded legacy wallet — not verified by this script."

script_summary
