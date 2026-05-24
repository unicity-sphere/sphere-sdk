#!/usr/bin/env bash
#
# manual-test-full-recovery-keep.sh — non-destructive wrapper for
# manual-test-full-recovery.sh. Used for #247 triage where the script's
# moving failure mode requires post-mortem inspection of the workspace.
#
# Differences vs the underlying script:
#   - `KEEP=1` so the workspace + daemon state survive the run (no rm -rf).
#   - Per-run `SPHERE_FULL_TEST_DIR` rooted under
#     `$HOME/sphere-full-test-keep/<utc-stamp>/` so consecutive runs don't
#     stomp each other.
#   - stdout + stderr tee'd to `<workspace>/run.log` so the full transcript
#     is captured alongside the script's own per-step snapshots.
#   - Exit code preserved (the underlying script's `trap teardown EXIT`
#     returns the rc).
#   - On exit, prints workspace path, exit code, and a `pkill` hint so the
#     operator can clean up the daemons left running.
#
# Usage:
#   ./manual-test-full-recovery-keep.sh          # one-shot run
#   ./manual-test-full-recovery-keep.sh 2>&1 | tee run.log  # external tee
#
# Env overrides:
#   KEEP_ROOT=/path/to/root   override the per-run workspace root
#                              (default: $HOME/sphere-full-test-keep/$STAMP)
#   SUFFIX=alice-123          per-run nametag suffix (default: epoch + $$)
#
# After the run:
#   - cd "$WORKSPACE" and inspect `peer1/`, `peer2-alice/`, `peer2-bob/`
#     and `snapshots/`.
#   - Daemons are still running (KEEP=1 skips teardown). Either restart
#     them via `sphere daemon stop` from each peer dir, or:
#         pkill -f 'sphere daemon' ; pkill -f 'sphere-daemon'
#   - `rm -rf "$WORKSPACE"` when done.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
WRAPPED="$SCRIPT_DIR/manual-test-full-recovery.sh"

if [[ ! -x "$WRAPPED" ]]; then
  echo "FATAL: cannot find $WRAPPED (or not executable)" >&2
  exit 2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKSPACE="${KEEP_ROOT:-$HOME/sphere-full-test-keep/$STAMP}"
mkdir -p "$WORKSPACE"
LOG="$WORKSPACE/run.log"

echo "=== manual-test-full-recovery-keep ==="
echo "  Workspace : $WORKSPACE"
echo "  Log       : $LOG"
echo "  Wrapped   : $WRAPPED"
echo "  Stamp     : $STAMP"
echo

# Final hint on exit. Trap fires AFTER the wrapped script's own trap, so
# its rc is the script's rc (preserved via `set -e` propagation through
# the explicit `RC=$? || true` capture below).
on_exit() {
  local rc=$?
  echo
  echo "=== KEEP wrapper finished ==="
  echo "  Workspace : $WORKSPACE  (left in place — KEEP=1)"
  echo "  Log       : $LOG"
  echo "  Exit code : $rc"
  echo "  Cleanup   : pkill -f 'sphere daemon' ; pkill -f 'sphere-daemon' ; rm -rf $WORKSPACE"
  echo
  return $rc
}
trap on_exit EXIT

# Run the wrapped script with KEEP=1 + workspace override. Tee both
# streams so the log file captures everything. `bash -c` ensures the
# environment passes through cleanly without subshell quoting issues.
export KEEP=1
export SPHERE_FULL_TEST_DIR="$WORKSPACE"

# `set -o pipefail` propagates the script's rc through the tee.
set -o pipefail
"$WRAPPED" "$@" 2>&1 | tee "$LOG"
