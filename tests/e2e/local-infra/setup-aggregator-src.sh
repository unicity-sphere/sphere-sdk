#!/usr/bin/env bash
# =============================================================================
# Fetch a pinned aggregator-go checkout for the local e2e Docker build.
#
# The full-local-stack mode (E2E_FULL_LOCAL_STACK=1) needs the aggregator-go
# source to build a local Docker image — we deliberately do NOT depend on a
# published GHCR image so the stack is self-contained. This script idempotently
# clones (or fetches into) tests/e2e/local-infra/.aggregator-go at the pinned
# commit declared in AGGREGATOR_GO_COMMIT below.
#
# Idempotence: if .aggregator-go already exists AND is at the pinned commit,
# this script is a no-op. If it exists at a different commit, the script
# fetches and checks out the pin (preserving local fixtures). If it doesn't
# exist, it does a shallow clone.
#
# Override the source path: set E2E_AGGREGATOR_GO_PATH to an existing
# checkout (e.g., a dev's local working copy). The script verifies the path
# exists + has a Dockerfile but does not enforce the commit pin in that mode
# — dev override is meant to be flexible.
#
# Override the upstream: set E2E_AGGREGATOR_GO_REPO. Useful for forks.
#
# Pin bump: edit AGGREGATOR_GO_COMMIT below, then re-run a representative
# e2e suite to validate the new aggregator version round-trips inclusion
# proofs that the SDK's verifier accepts.
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Pinned versions
# -----------------------------------------------------------------------------
AGGREGATOR_GO_REPO="${E2E_AGGREGATOR_GO_REPO:-https://github.com/unicitynetwork/aggregator-go.git}"
AGGREGATOR_GO_COMMIT="${E2E_AGGREGATOR_GO_COMMIT:-34d31d0bda0df498ef20505c2bf5bac611d7ce89}"

# -----------------------------------------------------------------------------
# Paths
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CHECKOUT_DIR="${SCRIPT_DIR}/.aggregator-go"
CHECKOUT_DIR="${E2E_AGGREGATOR_GO_PATH:-${DEFAULT_CHECKOUT_DIR}}"

log() {
  echo "[setup-aggregator-src] $*" >&2
}

# -----------------------------------------------------------------------------
# Dev override path — caller pointed us at an existing checkout
# -----------------------------------------------------------------------------
if [[ -n "${E2E_AGGREGATOR_GO_PATH:-}" ]]; then
  if [[ ! -d "${CHECKOUT_DIR}" ]]; then
    log "ERROR: E2E_AGGREGATOR_GO_PATH=${CHECKOUT_DIR} is set but the directory does not exist."
    exit 1
  fi
  if [[ ! -f "${CHECKOUT_DIR}/Dockerfile" ]]; then
    log "ERROR: ${CHECKOUT_DIR}/Dockerfile not found — that doesn't look like an aggregator-go checkout."
    exit 1
  fi
  log "using dev override at ${CHECKOUT_DIR} (commit pin NOT enforced)"
  echo "${CHECKOUT_DIR}"
  exit 0
fi

# -----------------------------------------------------------------------------
# Standard path — manage our own checkout under .aggregator-go
# -----------------------------------------------------------------------------
if [[ -d "${CHECKOUT_DIR}/.git" ]]; then
  current_commit="$(git -C "${CHECKOUT_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)"
  if [[ "${current_commit}" == "${AGGREGATOR_GO_COMMIT}" ]]; then
    log "checkout up-to-date at ${AGGREGATOR_GO_COMMIT}"
    echo "${CHECKOUT_DIR}"
    exit 0
  fi
  log "checkout at ${current_commit:0:12}, fetching pin ${AGGREGATOR_GO_COMMIT:0:12}…"
  git -C "${CHECKOUT_DIR}" fetch --depth=1 origin "${AGGREGATOR_GO_COMMIT}" >&2
  git -C "${CHECKOUT_DIR}" checkout --detach "${AGGREGATOR_GO_COMMIT}" >&2
else
  log "cloning ${AGGREGATOR_GO_REPO} @ ${AGGREGATOR_GO_COMMIT:0:12} into ${CHECKOUT_DIR}…"
  # `git clone --depth 1 <ref>` doesn't accept commit hashes directly on
  # older gits; init + fetch is the portable way to pin to a SHA.
  mkdir -p "${CHECKOUT_DIR}"
  git -C "${CHECKOUT_DIR}" init -q
  git -C "${CHECKOUT_DIR}" remote add origin "${AGGREGATOR_GO_REPO}"
  git -C "${CHECKOUT_DIR}" fetch --depth=1 origin "${AGGREGATOR_GO_COMMIT}" >&2
  git -C "${CHECKOUT_DIR}" checkout --detach FETCH_HEAD >&2
fi

log "ready at ${CHECKOUT_DIR} (commit ${AGGREGATOR_GO_COMMIT:0:12})"
echo "${CHECKOUT_DIR}"
