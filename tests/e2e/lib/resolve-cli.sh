#!/usr/bin/env bash
# =============================================================================
# resolve-cli.sh — Resolve the sphere-sdk CLI binary across post-split
# layouts.
#
# The sphere-sdk CLI was extracted to its own package (@unicity-sphere/cli);
# the in-tree `cli/index.ts` no longer exists on this branch. Shell e2e
# scripts (pointer-N*.sh, swap-cli-e2e.sh, cli-storage-modes.sh,
# e2e-helpers.sh) all need a CLI to drive wallets. Centralizing the
# resolver in one place avoids the drift we hit in May 2026 where
# pointer-N0-prologue.sh and e2e-helpers.sh both shipped subtly different
# 4-step fallbacks.
#
# Sourced (NOT executed). Provides one function:
#
#   resolve_sphere_cli <SDK_ROOT> <out-var-name>
#
# On success, exports `<out-var-name>` to the resolvable command and
# returns 0. On failure, returns 1 — the caller decides whether to SKIP
# (e2e tests) or fail.
#
# Resolution order (first match wins):
#   1. $SPHERE_CLI                              — explicit env override.
#   2. $SDK_CLI_BIN                             — explicit env override.
#   3. <SDK_ROOT>/cli/index.ts                  — legacy in-tree CLI
#                                                 (pre-extraction).
#   4. <SDK_ROOT>/../sphere-cli/bin/sphere.mjs  — sibling, post-split.
#   5. <SDK_ROOT>/../sphere-cli/cli/index.ts    — sibling, very-old layout.
#   6. <SDK_ROOT>/../sphere-cli-work/sphere-cli/bin/sphere.mjs
#                                               — Unicity-Network worktree
#                                                 layout (sphere-cli-work
#                                                 wrapper around the
#                                                 sphere-cli repo).
#   7. globally-installed `sphere-cli` binary on PATH.
#   8. globally-installed `sphere`     binary on PATH.
#
# Wrapping rules:
#   - `bin/sphere.mjs` is shebanged (`#!/usr/bin/env node`) — invoke
#     directly via the absolute path; symlinks are resolved with
#     `realpath` so test logs print the real entry point.
#   - `cli/index.ts` is TypeScript — wrap with
#     `npx --prefix <repo> tsx <file>`.
#   - Global binary — invoke via the `which` lookup result.
#
# Variant note: sphere-cli's bin entries (`sphere`, `scli`,
# `sphere-cli`) all alias to `bin/sphere.mjs`. Searching for any of
# them by `command -v` is sufficient.
# =============================================================================

# Idempotent source guard.
if [[ "${UXF_RESOLVE_CLI_LOADED:-0}" == "1" ]]; then
  return 0 2>/dev/null || true
fi
export UXF_RESOLVE_CLI_LOADED=1

resolve_sphere_cli() {
  local sdk_root="$1"
  local out_var="$2"
  if [[ -z "$sdk_root" || -z "$out_var" ]]; then
    echo "[resolve-cli] usage: resolve_sphere_cli <SDK_ROOT> <out-var-name>" >&2
    return 1
  fi

  local resolved=""
  if [[ -n "${SPHERE_CLI:-}" ]]; then
    resolved="${SPHERE_CLI}"
  elif [[ -n "${SDK_CLI_BIN:-}" ]]; then
    resolved="${SDK_CLI_BIN}"
  elif [[ -f "${sdk_root}/cli/index.ts" ]]; then
    resolved="npx --prefix ${sdk_root} tsx ${sdk_root}/cli/index.ts"
  else
    local -a candidates=(
      "${sdk_root}/../sphere-cli/bin/sphere.mjs"
      "${sdk_root}/../sphere-cli/cli/index.ts"
      "${sdk_root}/../sphere-cli-work/sphere-cli/bin/sphere.mjs"
    )
    local c
    for c in "${candidates[@]}"; do
      [[ -f "$c" ]] || continue
      case "$c" in
        *.mjs)
          resolved="$(realpath "$c")"
          break
          ;;
        *.ts)
          local repo
          repo="$(cd -- "$(dirname -- "$(dirname -- "$c")")" && pwd -P)"
          resolved="npx --prefix ${repo} tsx ${c}"
          break
          ;;
      esac
    done
    if [[ -z "$resolved" ]] && command -v sphere-cli >/dev/null 2>&1; then
      resolved="$(command -v sphere-cli)"
    fi
    if [[ -z "$resolved" ]] && command -v sphere >/dev/null 2>&1; then
      resolved="$(command -v sphere)"
    fi
  fi

  if [[ -z "$resolved" ]]; then
    return 1
  fi

  printf -v "$out_var" '%s' "$resolved"
  export "$out_var"
  return 0
}

# ---------------------------------------------------------------------------
# cli_supports_command — probe whether the resolved CLI exposes a given
# top-level command.
#
# The post-extraction `@unicity-sphere/cli` is in a phased migration:
#   - Phase 1 lifted the binary out of sphere-sdk into its own package.
#   - Phase 2 is rewiring the legacy commands (`init`, `pointer`,
#     `topup`, …) as new namespaced commands. Some of those landed
#     (`wallet init`); others haven't (`pointer status` / `pointer
#     flush` are not yet implemented at any path).
#
# Shell e2e tests that depend on the OLD top-level command shape
# (init / pointer / topup) need a way to say "I require X" and SKIP
# cleanly when X isn't there. This function probes `--help` for the
# command and returns 0 if the help text actually covers it, 1 if
# Commander.js answered "unknown command" or printed the top-level
# help instead.
#
# Usage:
#   if ! cli_supports_command "$SPHERE_CLI" pointer; then
#       echo "SKIP: CLI lacks 'pointer' command"; exit 0
#   fi
# ---------------------------------------------------------------------------
cli_supports_command() {
  local cli_cmd="$1"
  local subcommand="$2"
  if [[ -z "$cli_cmd" || -z "$subcommand" ]]; then
    echo "[resolve-cli] usage: cli_supports_command <cli> <subcommand>" >&2
    return 1
  fi
  # `<cli> <subcommand> --help` exits non-zero on unknown command in
  # most Commander.js setups. Even when it exits 0 (some shims print
  # top-level help for unknown subcommands), the help text starts
  # with "Usage: <bin> [options] [command]" — i.e., NOT naming the
  # subcommand. Combine: zero exit AND subcommand name appearing in
  # the Usage line.
  local out
  # shellcheck disable=SC2086
  if ! out=$($cli_cmd "$subcommand" --help 2>&1); then
    return 1
  fi
  if echo "$out" | grep -qE "^Usage:.*[ /]${subcommand}([ ]|$)"; then
    return 0
  fi
  if echo "$out" | grep -qiE "unknown (command|option)"; then
    return 1
  fi
  # Fall-through: top-level help printed without naming the command —
  # subcommand likely missing.
  return 1
}

# ---------------------------------------------------------------------------
# print_resolve_failure_help — emit a SKIP line + actionable hint.
# Called by sourcing scripts when resolve_sphere_cli returns non-zero.
# ---------------------------------------------------------------------------
print_resolve_failure_help() {
  local sdk_root="$1"
  cat <<EOF
SKIP: sphere-sdk CLI not available.
  Resolution order tried:
    1. \$SPHERE_CLI                              (env override)
    2. \$SDK_CLI_BIN                             (env override)
    3. ${sdk_root}/cli/index.ts                 (legacy in-tree)
    4. ${sdk_root}/../sphere-cli/bin/sphere.mjs (sibling, post-split)
    5. ${sdk_root}/../sphere-cli/cli/index.ts   (sibling, very-old)
    6. ${sdk_root}/../sphere-cli-work/sphere-cli/bin/sphere.mjs
                                                (worktree layout)
    7. \`which sphere-cli\`                     (global binary)
    8. \`which sphere\`                         (global binary)
  Install @unicity-sphere/cli globally OR point SDK_CLI_BIN at the bin path.
EOF
}
