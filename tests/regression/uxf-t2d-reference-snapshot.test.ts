/**
 * T.8.A — UXF T.2.D reference snapshot regression test.
 *
 * Pins the byte-identical CAR produced by the conservative-mode UXF
 * sender pipeline (`modules/payments/transfer/conservative-sender.ts`)
 * for a fully-deterministic single-coin send. Any wire format change
 * (CBOR encoding, envelope shape, ingest order, manifest layout, CID
 * derivation, hash function, content normalization) flips this test
 * red and forces an explicit ADR per the bump procedure documented in
 * `tests/fixtures/uxf-t2d-reference-snapshot/README.md`.
 *
 * Naming (W44): the fixture directory is named "uxf-t2d-reference-
 * snapshot" rather than "uxf-v1-single-coin" to avoid the false v1.0
 * wire-format claim. The snapshot pins the bytes produced AT the
 * T.2.D.2 commit; v1.0 is not yet frozen.
 *
 * Spec references:
 *  - §11.2 backward-compat bullet — "single-coin call ... produces
 *    byte-identical bundle to a v1.0-spec call → regression test
 *    against a captured fixture."
 *  - T.8.A acceptance: "Fixture committed; test passes; regenerating
 *    it requires bumping a marker and an ADR."
 *  - T.8.A acceptance: "Byte-identical assertion gated on the fixture's
 *    existence (so the test fails loudly if the fixture is moved)."
 *
 * Determinism strategy:
 *  - `Date.now()` mocked via `vi.spyOn` for the duration of the
 *    pipeline run — both `UxfPackage.create()` and
 *    `UxfPackage.ingestAll()` source `createdAt` / `updatedAt` from
 *    `Math.floor(Date.now() / 1000)`. Frozen ms epoch is stamped in
 *    the fixture's `manifest.json` (`generated.frozenEpochMs`).
 *  - `transferId` injected directly via `deps.transferId` (the
 *    orchestrator's only source of randomness; not part of the CAR
 *    but kept stable for parity with the manifest record).
 *  - All keys/salts/pubkeys are recorded in `manifest.json`; the test
 *    reads the manifest and rebuilds inputs from there rather than
 *    duplicating constants in two places.
 *
 * Regen procedure (ADR REQUIRED — see fixture README):
 *
 *     UXF_T2D_REFERENCE_SNAPSHOT_REGEN=1 \
 *       npx vitest run tests/regression/uxf-t2d-reference-snapshot.test.ts
 *
 * The env-var seam writes the freshly-produced CAR bytes to disk and
 * then re-asserts byte-identity. **Do not enable this casually** — a
 * red byte-identity assertion is a load-bearing signal that a wire
 * format change is happening.
 *
 * @module tests/regression/uxf-t2d-reference-snapshot
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
} from '../../modules/payments/transfer/conservative-sender';
import type { TokenLike } from '../../modules/payments/transfer/classify-token';
import type { PreflightFinalizeOptions } from '../../modules/payments/transfer/preflight-finalize';
import type { OracleProvider } from '../../oracle/oracle-provider';
import type { TransportProvider } from '../../transport';
import type { PeerInfo } from '../../transport/transport-provider';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
  TransferRequest,
} from '../../types';
import type { UxfTransferPayloadCar } from '../../types/uxf-transfer';
import { carBase64ToBytes } from '../../uxf/transfer-payload';
import { TOKEN_A } from '../fixtures/uxf-mock-tokens';

// =============================================================================
// 1. Fixture path resolution + manifest schema
// =============================================================================

/**
 * Marker that MUST match `manifest.json#_marker`. A monotone bump of
 * this string (from `v1` to `v2`, etc.) is the W44-mandated knob that
 * forces an ADR alongside any deliberate format change.
 */
const EXPECTED_MARKER = 'T.2.D.REFERENCE.SNAPSHOT.v3';

/** Env-var seam — when truthy, the test writes a fresh CAR to disk. */
const REGEN_ENV = 'UXF_T2D_REFERENCE_SNAPSHOT_REGEN';

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'uxf-t2d-reference-snapshot',
);

const MANIFEST_PATH = resolve(FIXTURE_DIR, 'manifest.json');
const BUNDLE_PATH = resolve(FIXTURE_DIR, 'bundle.car');

interface FixtureManifest {
  readonly _marker: string;
  readonly _note: string;
  readonly tag: string;
  readonly generated: { readonly frozenEpochMs: number; readonly frozenIso: string };
  readonly inputs: {
    readonly mnemonic: string;
    readonly saltHex: string;
    readonly transferId: string;
    readonly senderChainPubkey: string;
    readonly senderTransportPubkey: string;
    readonly recipientTransportPubkey: string;
    readonly recipientChainPubkey: string;
    readonly recipientDirectAddress: string;
    readonly tokenSourceId: string;
    readonly tokenJsonId: string;
    readonly primary: { readonly coinId: string; readonly amount: string };
  };
  readonly deliveryMode: 'force-inline';
  readonly transferMode: 'conservative';
  readonly expectedCar: { readonly fileName: string; readonly format: string };
}

function readManifest(): FixtureManifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `T.8.A regression: fixture manifest missing at ${MANIFEST_PATH}. ` +
        `The byte-identical assertion is gated on the fixture's existence — ` +
        `if the directory was moved, restore it from git or follow the ` +
        `regen procedure documented in tests/fixtures/uxf-t2d-reference-snapshot/README.md.`,
    );
  }
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw) as FixtureManifest;
  if (parsed._marker !== EXPECTED_MARKER) {
    throw new Error(
      `T.8.A regression: fixture marker mismatch. ` +
        `manifest.json says "${parsed._marker}", test expects "${EXPECTED_MARKER}". ` +
        `If you intentionally regenerated the fixture, also bump EXPECTED_MARKER ` +
        `in this test AND open an ADR per the W44 bump procedure ` +
        `(tests/fixtures/uxf-t2d-reference-snapshot/README.md).`,
    );
  }
  return parsed;
}

// =============================================================================
// 2. Stub builders — minimal subset of `conservative-sender.test.ts`
// =============================================================================

function makeOracleStub(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network',
    description: 'T.8.A regression stub',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    initialize: vi.fn(),
    submitCommitment: vi.fn(),
    getProof: vi.fn(),
    waitForProof: vi.fn(),
    validateToken: vi.fn(),
    isSpent: vi.fn().mockResolvedValue(false),
    getTokenState: vi.fn().mockResolvedValue(null),
    getCurrentRound: vi.fn().mockResolvedValue(1),
  };
}

interface MockTransport extends TransportProvider {
  readonly _calls: Array<{ recipient: string; payload: unknown }>;
}

function makeTransportStub(): MockTransport {
  const calls: MockTransport['_calls'] = [];
  const stub: MockTransport = {
    _calls: calls,
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p',
    description: 'T.8.A regression stub',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => undefined),
    sendTokenTransfer: vi
      .fn()
      .mockImplementation(async (recipient: string, payload: unknown) => {
        calls.push({ recipient, payload });
        return 'event-id';
      }),
    onTokenTransfer: vi.fn().mockReturnValue(() => undefined),
  };
  return stub;
}

function makeIdentity(manifest: FixtureManifest): FullIdentity {
  return {
    chainPubkey: manifest.inputs.senderChainPubkey,
    l1Address: 'alpha1regression',
    directAddress: 'DIRECT://regression-sender',
    privateKey: '01'.repeat(32),
  };
}

function makePeerInfo(manifest: FixtureManifest): PeerInfo {
  return {
    transportPubkey: manifest.inputs.recipientTransportPubkey,
    chainPubkey: manifest.inputs.recipientChainPubkey,
    l1Address: 'alpha1regression-recipient',
    directAddress: manifest.inputs.recipientDirectAddress,
    timestamp: 0,
  };
}

function makeSourceToken(manifest: FixtureManifest): Token {
  return {
    id: manifest.inputs.tokenSourceId,
    coinId: manifest.inputs.primary.coinId,
    symbol: 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: manifest.inputs.primary.amount,
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
    sdkData: JSON.stringify(TOKEN_A),
  };
}

function makeCommitResult(manifest: FixtureManifest): ConservativeCommitResult {
  // Sanity: the recorded tokenJsonId in the manifest must match the
  // TOKEN_A fixture's tokenId so the bundle CID is reproducible.
  const fixtureTokenId = (
    (TOKEN_A as { genesis: { data: { tokenId: string } } }).genesis.data.tokenId
  );
  if (fixtureTokenId !== manifest.inputs.tokenJsonId) {
    throw new Error(
      `T.8.A regression: TOKEN_A.genesis.data.tokenId ("${fixtureTokenId}") ` +
        `differs from manifest.inputs.tokenJsonId ("${manifest.inputs.tokenJsonId}"). ` +
        `The fixture pins the underlying token JSON; if TOKEN_A changed, the ` +
        `manifest + bundle.car must be regenerated together.`,
    );
  }
  return {
    sourceTokenId: manifest.inputs.tokenSourceId,
    method: 'direct',
    requestIdHex: 'req-' + manifest.inputs.tokenSourceId,
    recipientTokenJson: TOKEN_A,
  };
}

function makeRequest(manifest: FixtureManifest): TransferRequest {
  return {
    recipient: '@bob',
    coinId: manifest.inputs.primary.coinId,
    amount: manifest.inputs.primary.amount,
    transferMode: manifest.transferMode,
    delivery: { kind: 'force-inline' },
  };
}

function tokenLikeProjector(token: Token): TokenLike {
  return {
    id: token.id,
    coins: [{ coinId: token.coinId, amount: BigInt(token.amount) }],
  };
}

// =============================================================================
// 3. Pipeline driver — produces the CAR bytes deterministically
// =============================================================================

/**
 * Run the conservative-sender pipeline with all-deterministic inputs
 * and return the underlying CAR bytes.
 *
 * The orchestrator wraps the CAR in a base64 envelope for inline
 * delivery; we recover the raw bytes via `carBase64ToBytes` so the
 * fixture pins the binary CAR (the substrate that Nostr / IPFS would
 * carry) rather than a base64 superficial layer.
 */
async function buildBundleCarBytes(manifest: FixtureManifest): Promise<Uint8Array> {
  const transport = makeTransportStub();
  const events: Array<{ type: SphereEventType; data: unknown }> = [];
  const emit = <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
    events.push({ type, data });
  };
  const source = makeSourceToken(manifest);
  const commit = makeCommitResult(manifest);
  const deps: ConservativeSenderDeps = {
    aggregator: makeOracleStub(),
    transport,
    identity: makeIdentity(manifest),
    senderTransportPubkey: manifest.inputs.senderTransportPubkey,
    emit,
    availableSources: () => [source],
    selectSources: async () => [source],
    preflightOptions: () => ({
      // No pending chains in this fixture's setup, so resolveRequestId
      // is never invoked. The throwing default mirrors the unit-test
      // pattern.
      resolveRequestId: () => {
        throw new Error('resolveRequestId should not be invoked when chain is empty');
      },
      extractPendingChain: () => [],
    } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
    commitSources: async () => [commit],
    toTokenLike: tokenLikeProjector,
    transferId: manifest.inputs.transferId,
  };

  const result = await sendConservativeUxf(makeRequest(manifest), makePeerInfo(manifest), deps);
  if (result.status !== 'completed') {
    throw new Error(
      `T.8.A regression: pipeline did not reach 'completed' (status=${result.status}, ` +
        `error=${result.error ?? '<none>'})`,
    );
  }
  if (transport._calls.length !== 1) {
    throw new Error(
      `T.8.A regression: expected exactly one sendTokenTransfer call, got ${transport._calls.length}`,
    );
  }
  const payload = transport._calls[0].payload as UxfTransferPayloadCar;
  if (payload.kind !== 'uxf-car') {
    throw new Error(
      `T.8.A regression: expected uxf-car wire payload, got kind="${payload.kind}"`,
    );
  }
  return carBase64ToBytes(payload.carBase64);
}

// =============================================================================
// 4. Test
// =============================================================================

describe('T.8.A — UXF T.2.D reference snapshot (byte-identical CAR)', () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    const manifest = readManifest();
    // Freeze Date.now() for the entirety of the pipeline run so both
    // `UxfPackage.create()` and `UxfPackage.ingestAll()` stamp the
    // recorded epoch. The stamping site uses
    // `Math.floor(Date.now() / 1000)`, so any millisecond within the
    // same second is byte-equivalent — but we still pin the exact ms
    // for forensic reproducibility.
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(manifest.generated.frozenEpochMs);
  });

  afterEach(() => {
    dateNowSpy?.mockRestore();
    dateNowSpy = null;
  });

  it('produces a CAR byte-identical to the committed fixture', async () => {
    const manifest = readManifest();
    const actual = await buildBundleCarBytes(manifest);

    // Regen seam — env-var-gated, see file header for the bump procedure.
    if (process.env[REGEN_ENV] === '1') {
      writeFileSync(BUNDLE_PATH, actual);
      // Re-read after write so the comparison below is non-trivial
      // (catches "fixture written but disk still has old bytes" too).
    }

    if (!existsSync(BUNDLE_PATH)) {
      throw new Error(
        `T.8.A regression: bundle.car missing at ${BUNDLE_PATH}. ` +
          `The byte-identical assertion is gated on the fixture's existence. ` +
          `Restore from git OR run with ${REGEN_ENV}=1 (W44: opening an ADR is ` +
          `REQUIRED — see tests/fixtures/uxf-t2d-reference-snapshot/README.md).`,
      );
    }
    const expected = readFileSync(BUNDLE_PATH);

    // Byte-by-byte comparison. Buffer compare returns 0 on equality,
    // which Vitest renders as "expected 0 received N" — the diff
    // points at the byte offset of divergence in failure mode.
    const expectedBytes = new Uint8Array(
      expected.buffer,
      expected.byteOffset,
      expected.byteLength,
    );
    if (actual.byteLength !== expectedBytes.byteLength) {
      throw new Error(
        `T.8.A regression: CAR length mismatch — actual=${actual.byteLength} bytes, ` +
          `fixture=${expectedBytes.byteLength} bytes. The wire format moved; an ADR ` +
          `is required before regenerating (W44 bump procedure).`,
      );
    }
    for (let i = 0; i < actual.byteLength; i++) {
      if (actual[i] !== expectedBytes[i]) {
        throw new Error(
          `T.8.A regression: CAR byte mismatch at offset ${i} — ` +
            `actual=0x${actual[i].toString(16).padStart(2, '0')}, ` +
            `fixture=0x${expectedBytes[i].toString(16).padStart(2, '0')}. ` +
            `The wire format moved; an ADR is required before regenerating ` +
            `(W44 bump procedure — see fixture README).`,
        );
      }
    }
    // Sanity: the assertion above already implies length+content match,
    // but a final expect() keeps the test result green/red in Vitest's
    // default reporter.
    expect(actual.byteLength).toBe(expectedBytes.byteLength);
  });
});
