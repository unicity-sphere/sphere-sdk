# T.2.D Reference Snapshot — UXF single-coin send

## What this is

A byte-identical CAR fixture pinning the on-the-wire UXF bundle produced
by the conservative-mode sender pipeline (`modules/payments/transfer/
conservative-sender.ts`) for a fully-deterministic single-coin send.

The fixture is a regression slot: the companion test
(`tests/regression/uxf-t2d-reference-snapshot.test.ts`) reproduces the
inputs from `manifest.json`, runs the conservative-sender pipeline, and
asserts the output bundle is byte-identical to `bundle.car`. Any wire
format change — CBOR encoding, envelope shape, ingest order, manifest
layout, CID derivation, hash function, content normalization — flips
the assertion red.

## What this is NOT (W44)

This snapshot is **NOT** a `v1.0` wire-format claim. The directory name
deliberately says "T.2.D reference snapshot" rather than
"uxf-v1-single-coin" because we do not yet have a frozen v1.0 wire
format. The on-the-wire shape is still being iterated through the T.x
implementation waves; the snapshot pins the specific bytes produced at
the T.2.D.2 commit so we notice (and decide explicitly) when the
format moves.

`spec_refs`: §11.2 backward-compat bullet — "Implementation note: the
fixture MUST be generated from a tagged commit (specify the tag in the
test) with deterministic salt, deterministic timestamp, and a recorded
mnemonic. (...) The byte-identical assertion is gated on the fixture's
existence."

## Inputs (recorded; see `manifest.json` for the canonical record)

- Mnemonic: `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about` (BIP39 canonical zero-entropy vector)
- Frozen timestamp: `2025-01-01T00:00:00Z` (epoch ms = `1735689600000`).
  Mocked via `vi.spyOn(Date, 'now')` while the package is built — both
  `UxfPackage.create()` and `ingestAll()` source `createdAt` /
  `updatedAt` from `Math.floor(Date.now() / 1000)`. With the spy active,
  the envelope timestamps fold to `1735689600` (seconds).
- Salt (token genesis): `aa000000000000000000000000000000000000000000000000000000005a1601`
  — verbatim from `TOKEN_A` in `tests/fixtures/uxf-mock-tokens.ts`.
- Source tokenId (orchestrator-side handle): `tok-1`.
- TOKEN_A's tokenId (post-rewrite is unchanged because the fixture
  uses the already-deterministic value): `aa00000000000000000000000000000000000000000000000000000000000001`.
- Sender chain pubkey (becomes `envelope.creator`):
  `02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
  (66-hex stub matching the conservative-sender unit test's `makeIdentity()`).
- Recipient transport pubkey: `02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`.
- Recipient direct address: `DIRECT://bob-direct`.
- Primary asset: `coinId='UCT'`, `amount='1000000'`.
- Delivery: `{ kind: 'force-inline' }` (the orchestrator's resolver
  packs the CAR into `carBase64` for the wire envelope; the wire
  envelope itself is NOT what we pin — we pin the underlying CAR
  bytes that feed `carBase64`).
- Transfer mode: `'conservative'`.

## Bump procedure (W44)

If the byte-identical assertion fails because of a deliberate format
change, **do not** silently regenerate the fixture. The fixture is a
regression slot; a flip means we are about to re-orient the wire
format, which is a load-bearing decision.

Required steps:

1. Open an Architecture Decision Record (ADR) under
   `docs/uxf/adr/ADR-NNNN-format-change.md` describing:
   - Which bytes shifted (envelope, manifest, element ordering, ...).
   - Why (spec amendment, dependency upgrade, deliberate refactor).
   - Backward-compatibility plan — receivers MUST still parse the old
     format until the deprecation window closes.
2. Bump `_marker` in `manifest.json` from
   `T.2.D.REFERENCE.SNAPSHOT.v1` to the next monotone identifier
   (`T.2.D.REFERENCE.SNAPSHOT.v2`, `v3`, ...). The regression test
   reads this marker; mismatched marker → test fails with a clear
   "ADR required" message.
3. Regenerate `bundle.car` by running:

   ```bash
   UXF_T2D_REFERENCE_SNAPSHOT_REGEN=1 npx vitest run tests/regression/uxf-t2d-reference-snapshot.test.ts
   ```

   The env-var seam writes the fresh CAR bytes to disk and then
   re-asserts byte-identity (the next ordinary run uses the new
   bytes as the reference).
4. Update this README with the new ADR link and a one-line note
   describing the format change.
5. Commit the regenerated fixture, updated manifest, ADR, and
   README in a single commit. Reference the ADR in the commit
   message.

## Bump history

### v2 — SMT path encoding: bigint → 32-byte bstr (fix for 256-bit overflow)

`uxf/hash.ts:prepareSmtSegments` was encoding SMT path values as native
`BigInt`, which `@ipld/dag-cbor` (cborg) attempted to write as CBOR uint.
cborg caps uint at uint64 (2^64−1) and throws
"encountered BigInt larger than allowable range" for real testnet 256-bit
paths. The original comment claimed "CBOR tag 2 bignum" but
`@ipld/dag-cbor` / the IPLD data model does not support bignum tags.

Fix (see `uxf/hash.ts::bigIntTo32Bytes`): encode the 256-bit SMT path as
a fixed-width 32-byte big-endian `Uint8Array` (CBOR bstr). This is
deterministic, IPLD-native, and matches the SPEC CDDL
`segments: [* [bstr, bstr]]`. TOKEN_A's mock paths (`0`, `1`,
`9999999999999999999`) were previously encoded as 1–8 CBOR uint bytes;
they are now encoded as 32 CBOR bstr bytes each, growing the fixture from
2408 to 2499 bytes.

`_marker` bumped to `T.2.D.REFERENCE.SNAPSHOT.v2`. ADR documented inline
in `uxf/hash.ts` (bigIntTo32Bytes comment) and in the commit message.

## File inventory

- `manifest.json` — inputs needed to reproduce the bundle, plus the
  monotone bump marker.
- `bundle.car` — the binary CARv1 produced by the conservative-sender
  pipeline given those inputs.
- `README.md` — this file.
