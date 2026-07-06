#!/usr/bin/env python3
"""Report-only API-conformance harness for uxf-v2 (Phase 1 of the refactor-in-place plan).

Diffs the current tree's exported API surface (per subpath) against a frozen snapshot of
upstream sphere-sdk main v0.11.4 (commit ce758f6b), and prints per-subpath drift counts:
uxf-only (DROP/EXTENSION candidates), main-only (ADD candidates), identical, and drifted
(same name, different kind/signature). Whole subpaths that main has but uxf lacks (or vice
versa) are reported as MISSING SUBPATH / EXTENSION SUBPATH.

This script always exits 0 — it is a burn-down metric, not a gate. It becomes a blocking
gate in a later phase (see docs/uxf/uxfv2-phase-1-report.md) once the whitelisted-delta
ledger is finalized.

Usage: compare-exports.py <current-exports.json> <main-exports.json>
"""
import json
import re
import sys

# uxf entry file -> main entry file, mirroring package.json's "exports" map.
# A None uxf key means main has this subpath and uxf does not (yet) — reported as a
# missing subpath rather than a per-symbol diff.
SUBPATH_MAP = {
    ".": ("index.ts", "index.ts"),
    "/core": ("core/index.ts", "core/index.ts"),
    "/impl/browser": ("impl/browser/index.ts", "impl/browser/index.ts"),
    "/impl/browser/ipfs": ("impl/browser/ipfs.ts", "impl/browser/ipfs.ts"),
    "/impl/nodejs": ("impl/nodejs/index.ts", "impl/nodejs/index.ts"),
    "/connect": ("connect/index.ts", "connect/index.ts"),
    "/connect/browser": ("impl/browser/connect/index.ts", "impl/browser/connect/index.ts"),
    "/connect/nodejs": ("impl/nodejs/connect/index.ts", "impl/nodejs/connect/index.ts"),
    # main-only subpaths uxf does not have yet (Phase 7 ADD list, [API §3.3 A]).
    "/token-engine": (None, "token-engine/index.ts"),
    "/wallet-api": (None, "wallet-api/index.ts"),
    "/impl/shared/wallet-api": (None, "impl/shared/wallet-api/index.ts"),
}

# uxf-only subpaths main does not have — these are extension/delete candidates, not drift.
EXTENSION_SUBPATHS = {
    "/l1": "l1/index.ts",
    "/uxf": "uxf/index.ts",
    "/profile": "profile/index.ts",
    "/profile/browser": "profile/browser.ts",
    "/profile/node": "profile/node.ts",
}


def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()


def main():
    if len(sys.argv) != 3:
        print("usage: compare-exports.py <current-exports.json> <main-exports.json>", file=sys.stderr)
        sys.exit(0)  # report-only: never fail the build, even on misuse

    try:
        current = json.load(open(sys.argv[1]))
        main_ = json.load(open(sys.argv[2]))
    except Exception as e:
        print(f"Drift-vs-main: harness could not run ({e}) — report-only, not failing build")
        sys.exit(0)

    total = dict(only_main=0, only_uxf=0, identical=0, drift=0)
    missing_subpaths = []

    print("Drift-vs-main (report-only; frozen snapshot main v0.11.4 @ce758f6b):")
    for sub, (ukey, mkey) in SUBPATH_MAP.items():
        if ukey is None or ukey not in current:
            m = main_.get(mkey, [])
            missing_subpaths.append(sub)
            print(f"  {sub}: MISSING SUBPATH ({len(m)} main symbols not reachable from uxf)")
            total["only_main"] += len(m)
            continue
        m = {r["name"]: r for r in main_.get(mkey, [])}
        u = {r["name"]: r for r in current.get(ukey, [])}
        only_m = sorted(set(m) - set(u))
        only_u = sorted(set(u) - set(m))
        both = sorted(set(m) & set(u))
        identical, drift = [], []
        for n in both:
            if norm(m[n]["sig"]) == norm(u[n]["sig"]) and m[n]["kind"] == u[n]["kind"]:
                identical.append(n)
            else:
                drift.append(n)
        total["only_main"] += len(only_m)
        total["only_uxf"] += len(only_u)
        total["identical"] += len(identical)
        total["drift"] += len(drift)
        print(
            f"  {sub}: uxf-only={len(only_u)} main-only={len(only_m)} "
            f"identical={len(identical)} drifted={len(drift)}"
        )

    print()
    print("Extension/delete-candidate subpaths (main has no equivalent):")
    for sub, ukey in EXTENSION_SUBPATHS.items():
        n = len(current.get(ukey, []))
        print(f"  {sub}: {n} uxf-only symbols" if n else f"  {sub}: not present in current dump")

    print()
    print(
        f"TOTAL (11 main subpaths): uxf-only={total['only_uxf']} main-only={total['only_main']} "
        f"identical={total['identical']} drifted={total['drift']} "
        f"missing-subpaths={len(missing_subpaths)} ({', '.join(missing_subpaths) or 'none'})"
    )
    print()
    print(
        "This harness is report-only (Phase 1 of the uxf-v2 execution plan). It becomes a "
        "blocking CI gate in a later phase once the whitelisted-delta ledger is finalized — "
        "see docs/uxf/uxfv2-phase-1-report.md."
    )


if __name__ == "__main__":
    main()
