/**
 * Tests for `modules/payments/transfer/legacy-shape-adapter.ts` (T.7.B).
 *
 * Strategy: every SDK / verifier / storage hook is mocked. We do NOT
 * re-test the `processDisposition` engine's branch logic (covered by
 * `disposition-engine.test.ts`); instead we drive the adapter's own
 * routing logic (shape classification, per-token decomposition,
 * instant-TXF queue routing, defensive paths) and verify the
 * end-to-end mapping from each of the four §3.4 wire shapes through
 * to the resulting `DispositionRecord[]`.
 *
 * Coverage map (T.7.B acceptance criteria):
 *  - Sphere TXF `{sourceToken, transferTx}` → 1 DispositionRecord.
 *  - V6 `COMBINED_TRANSFER` with N entries → N DispositionRecords.
 *  - V5/V4 `INSTANT_SPLIT` → 1 DispositionRecord (per recipient mint).
 *  - SDK legacy `{token, proof}` → 1 DispositionRecord.
 *  - Instant-TXF (`inclusionProof: null`) → routed through
 *    {@link FinalizationQueueEnqueuer}.
 *
 * Spec references:
 *  - §3.4   Legacy wire shapes (the four detector branches).
 *  - §4.4.2 Instant-TXF (inclusionProof:null routing).
 *  - §5.3   Per-token disposition (delegated to T.3.B.2).
 *  - §10.2  Single-pipeline convergence (acceptance — same outcomes
 *           as equivalent UXF bundle).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  adaptLegacyShape,
  classifyLegacyShape,
  syntheticBundleCidFor,
  type FinalizationQueueEnqueuer,
  type LegacyShapeAdapterInput,
  type LegacyTokenEntry,
} from '../../../../extensions/uxf/pipeline/legacy-shape-adapter';
import type { ContinuityResult, TxLike } from '../../../../extensions/uxf/pipeline/continuity-walker';
import type { EvaluatePredicateResult } from '../../../../extensions/uxf/pipeline/predicate-evaluator';
import type { ProofVerifyStatus } from '../../../../extensions/uxf/pipeline/proof-verifier';
import type { VerifyAuthenticatorResult } from '../../../../extensions/uxf/pipeline/authenticator-verifier';
import type { ContentHash } from '../../../../extensions/uxf/bundle/types';
import type { LegacyTokenTransferPayload } from '../../../../types/uxf-transfer';
import type { FinalizationQueueEntry } from '../../../../extensions/uxf/pipeline/finalization-queue';

// =============================================================================
// 1. Common fixtures
// =============================================================================

const TOKEN_A = 'aa00000000000000000000000000000000000000000000000000000000000001';
const TOKEN_B = 'bb00000000000000000000000000000000000000000000000000000000000002';
const TOKEN_C = 'cc00000000000000000000000000000000000000000000000000000000000003';
const HASH_A = ('0'.repeat(62) + 'a1') as ContentHash;
const HASH_B = ('0'.repeat(62) + 'b2') as ContentHash;
const HASH_C = ('0'.repeat(62) + 'c3') as ContentHash;
const SENDER_PUBKEY =
  'fefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefe';
const STATE_HEAD = ('0'.repeat(60) + '5646') as string;
const ADDR = 'DIRECT://addr-A';

const PUBKEY = (() => {
  const k = new Uint8Array(33);
  k[0] = 0x02;
  return k;
})();

const TRUSTBASE = {} as unknown;

// =============================================================================
// 2. Hook builders — all defaults are happy-path
// =============================================================================

interface HookOverrides {
  readonly evaluatePredicate?: () => Promise<EvaluatePredicateResult>;
  readonly verifyAuthenticator?: () => Promise<VerifyAuthenticatorResult>;
  readonly walkContinuity?: (chain: ReadonlyArray<TxLike>) => ContinuityResult;
  readonly verifyProof?: () => Promise<ProofVerifyStatus>;
  readonly oracleIsSpent?: (stateHash: string) => Promise<boolean>;
  readonly readLocalManifest?: () => Promise<undefined>;
}

function happyHooks(overrides: HookOverrides = {}): Pick<
  LegacyShapeAdapterInput,
  'evaluatePredicate'
  | 'verifyAuthenticator'
  | 'walkContinuity'
  | 'verifyProof'
  | 'oracleIsSpent'
  | 'readLocalManifest'
> {
  return {
    evaluatePredicate:
      overrides.evaluatePredicate ??
      (async () => ({ ok: true, bindsToUs: true })),
    verifyAuthenticator:
      overrides.verifyAuthenticator ??
      (async () => ({ ok: true, valid: true })),
    walkContinuity:
      overrides.walkContinuity ??
      ((_chain: ReadonlyArray<TxLike>): ContinuityResult => ({ ok: true })),
    verifyProof: overrides.verifyProof ?? (async () => 'OK' as ProofVerifyStatus),
    oracleIsSpent: overrides.oracleIsSpent ?? (async () => false),
    readLocalManifest: overrides.readLocalManifest ?? (async () => undefined),
  };
}

function makeEntry(
  overrides: Partial<LegacyTokenEntry> & { tokenId: string; observedTokenContentHash: ContentHash },
): LegacyTokenEntry {
  return {
    tokenId: overrides.tokenId,
    observedTokenContentHash: overrides.observedTokenContentHash,
    chain:
      overrides.chain ?? [
        {
          sourceState: 's0',
          destinationState: 's1',
          authenticator: { kind: 'auth' },
          transactionHash: { kind: 'txh' },
          inclusionProof: { kind: 'proof' },
          requestId: 'req-1',
        },
      ],
    currentStatePredicate: overrides.currentStatePredicate ?? { kind: 'predicate' },
    currentDestinationStateHash:
      overrides.currentDestinationStateHash ?? STATE_HEAD,
  };
}

function buildInput(
  payload: LegacyTokenTransferPayload,
  entries: ReadonlyArray<LegacyTokenEntry>,
  overrides: Partial<LegacyShapeAdapterInput> = {},
): LegacyShapeAdapterInput {
  return {
    payload,
    senderTransportPubkey: SENDER_PUBKEY,
    addr: ADDR,
    ourPubkey: PUBKEY,
    trustBase: TRUSTBASE,
    extractTxLegacyChain:
      overrides.extractTxLegacyChain ?? (async () => entries),
    ...happyHooks(),
    ...overrides,
  };
}

// =============================================================================
// 3. classifyLegacyShape — direct unit tests
// =============================================================================

describe('classifyLegacyShape', () => {
  it('detects V6 COMBINED_TRANSFER', () => {
    expect(
      classifyLegacyShape({ type: 'COMBINED_TRANSFER', version: '6.0' }),
    ).toBe('combined-v6');
  });

  it('detects V5 INSTANT_SPLIT', () => {
    expect(
      classifyLegacyShape({ type: 'INSTANT_SPLIT', version: '5.0' }),
    ).toBe('instant-split-v5');
  });

  it('detects V4 INSTANT_SPLIT', () => {
    expect(
      classifyLegacyShape({ type: 'INSTANT_SPLIT', version: '4.0' }),
    ).toBe('instant-split-v4');
  });

  it('detects Sphere TXF single-token', () => {
    expect(
      classifyLegacyShape({ sourceToken: { id: 'x' }, transferTx: { tx: 'y' } }),
    ).toBe('sphere-txf');
  });

  it('detects SDK legacy {token, proof}', () => {
    expect(
      classifyLegacyShape({ token: { id: 'x' }, proof: { p: 'q' } }),
    ).toBe('sdk-legacy');
  });

  it('returns null for UXF v1.0 envelopes', () => {
    expect(
      classifyLegacyShape({
        kind: 'uxf-car',
        version: '1.0',
        mode: 'instant',
        bundleCid: 'bafy',
        tokenIds: [],
        carBase64: 'AAAA',
      }),
    ).toBe(null);
  });

  it('returns null for null / non-object inputs', () => {
    expect(classifyLegacyShape(null)).toBe(null);
    expect(classifyLegacyShape(undefined)).toBe(null);
    expect(classifyLegacyShape(42)).toBe(null);
    expect(classifyLegacyShape('not-a-payload')).toBe(null);
    expect(classifyLegacyShape([{ type: 'COMBINED_TRANSFER', version: '6.0' }])).toBe(null);
  });

  it('precedence: V6 wins over a structurally-overlapping V5', () => {
    // A pathological payload that has BOTH a top-level V6 discriminator
    // AND looks like V5 in nested fields. The classifier MUST pick V6
    // because the V6 outer envelope may legitimately embed V5 splitBundle.
    expect(
      classifyLegacyShape({
        type: 'COMBINED_TRANSFER',
        version: '6.0',
        splitBundle: { type: 'INSTANT_SPLIT', version: '5.0' },
      }),
    ).toBe('combined-v6');
  });

  it('precedence: Sphere TXF beats SDK legacy when both present', () => {
    // {sourceToken, transferTx} is checked BEFORE {token, proof}.
    expect(
      classifyLegacyShape({
        sourceToken: { id: 'x' },
        transferTx: { tx: 'y' },
        token: { id: 'z' },
        proof: { p: 'q' },
      }),
    ).toBe('sphere-txf');
  });
});

// =============================================================================
// 4. syntheticBundleCidFor — ensures stable forensic provenance
// =============================================================================

describe('syntheticBundleCidFor', () => {
  it('builds shape-prefixed CIDs for each shape', () => {
    expect(syntheticBundleCidFor('sphere-txf', TOKEN_A, null)).toContain(
      'legacy-sphere-txf-',
    );
    expect(syntheticBundleCidFor('combined-v6', TOKEN_A, 0)).toContain(
      'legacy-combined-v6-',
    );
    expect(syntheticBundleCidFor('instant-split-v5', TOKEN_A, null)).toContain(
      'legacy-instant-split-v5-',
    );
    expect(syntheticBundleCidFor('instant-split-v4', TOKEN_A, null)).toContain(
      'legacy-instant-split-v4-',
    );
    expect(syntheticBundleCidFor('sdk-legacy', TOKEN_A, null)).toContain(
      'legacy-sdk-legacy-',
    );
  });

  it('appends index when provided', () => {
    expect(syntheticBundleCidFor('combined-v6', TOKEN_A, 5)).toContain('-5');
    expect(syntheticBundleCidFor('combined-v6', TOKEN_A, null)).not.toMatch(
      /-\d+$/,
    );
  });

  it('produces stable, bounded-length output when tokenId is empty (#170 issue 6)', () => {
    // Post #170-issue-6: tokenId is hashed (SHA-256 hex) before
    // inclusion. The "no-token" literal is no longer visible in the
    // output — we verify stability + bounded length + the canonical
    // `legacy-${shape}-` prefix invariant instead. Two distinct
    // empty-tokenId calls MUST produce byte-equal output (idempotent
    // for the structural-invalid path).
    const a = syntheticBundleCidFor('sphere-txf', '', null);
    const b = syntheticBundleCidFor('sphere-txf', '', null);
    expect(a).toBe(b);
    expect(a.startsWith('legacy-sphere-txf-')).toBe(true);
    // SHA-256 hex digest is exactly 64 chars; total length:
    // 'legacy-sphere-txf-' (18) + 64 = 82.
    expect(a.length).toBe(18 + 64);
  });

  it('hashes tokenId so attacker-crafted CID prefixes cannot masquerade (#170 issue 6)', () => {
    // The pre-fix code emitted `legacy-sphere-txf-${tokenId}`, so a
    // tokenId of `bafyrei...` would yield `legacy-sphere-txf-bafyrei...`
    // that pattern-matches as a real CID in forensic logs. After the
    // fix the tokenId is SHA-256-hashed, so no attacker-controlled
    // bytes appear verbatim in the synthetic CID output.
    const malicious = 'bafyreigh2akiscaildkrbzv3nqxk3xiy5o4hqz';
    const out = syntheticBundleCidFor('sphere-txf', malicious, null);
    expect(out.startsWith('legacy-sphere-txf-')).toBe(true);
    // The malicious tokenId MUST NOT appear in the output literally.
    expect(out).not.toContain(malicious);
    expect(out.length).toBe(18 + 64);
  });
});

// =============================================================================
// 5. Sphere TXF (single-token) — 1 entry → 1 disposition
// =============================================================================

describe('Sphere TXF — {sourceToken, transferTx} shape', () => {
  it('produces exactly ONE DispositionRecord for one source token', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry = makeEntry({ tokenId: TOKEN_A, observedTokenContentHash: HASH_A });
    const out = await adaptLegacyShape(buildInput(payload, [entry]));
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('VALID');
    expect(out[0].tokenId).toBe(TOKEN_A);
    expect(out[0].observedTokenContentHash).toBe(HASH_A);
    expect(out[0].bundleCid).toContain('legacy-sphere-txf-');
    expect(out[0].senderTransportPubkey).toBe(SENDER_PUBKEY);
  });

  it('returns AUDIT(not-our-state) when predicate does not bind', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry = makeEntry({ tokenId: TOKEN_A, observedTokenContentHash: HASH_A });
    const out = await adaptLegacyShape(
      buildInput(payload, [entry], {
        evaluatePredicate: async () => ({ ok: true, bindsToUs: false }),
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('AUDIT');
    if (out[0].disposition === 'AUDIT') {
      expect(out[0].reason).toBe('not-our-state');
      expect(out[0].auditStatus).toBe('audit-not-our-state');
    }
  });

  it('returns INVALID(auth-invalid) when authenticator fails ECDSA', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry = makeEntry({ tokenId: TOKEN_A, observedTokenContentHash: HASH_A });
    const out = await adaptLegacyShape(
      buildInput(payload, [entry], {
        verifyAuthenticator: async () => ({ ok: true, valid: false }),
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('INVALID');
    if (out[0].disposition === 'INVALID') {
      expect(out[0].reason).toBe('auth-invalid');
    }
  });

  it('returns AUDIT(off-record-spend) when oracle says spent', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry = makeEntry({ tokenId: TOKEN_A, observedTokenContentHash: HASH_A });
    const out = await adaptLegacyShape(
      buildInput(payload, [entry], { oracleIsSpent: async () => true }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('AUDIT');
    if (out[0].disposition === 'AUDIT') {
      expect(out[0].reason).toBe('off-record-spend');
    }
  });

  it('returns CONFLICTING when local manifest disagrees', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry = makeEntry({ tokenId: TOKEN_A, observedTokenContentHash: HASH_A });
    // Returning a manifest with a DIFFERENT rootHash forces CONFLICTING.
    const out = await adaptLegacyShape(
      buildInput(payload, [entry], {
        readLocalManifest: async () => ({
          rootHash: ('0'.repeat(60) + 'd1d1') as ContentHash,
          status: 'valid',
        }),
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('CONFLICTING');
  });
});

// =============================================================================
// 6. V6 COMBINED_TRANSFER — N entries → N dispositions
// =============================================================================

describe('V6 COMBINED_TRANSFER — N tokens → N dispositions', () => {
  it('produces N DispositionRecords for N entries', async () => {
    const payload = {
      type: 'COMBINED_TRANSFER',
      version: '6.0',
      directTokens: [],
      totalAmount: '1000',
      coinId: 'aabb',
      senderPubkey: SENDER_PUBKEY,
    } as unknown as LegacyTokenTransferPayload;
    const entries = [
      makeEntry({ tokenId: TOKEN_A, observedTokenContentHash: HASH_A }),
      makeEntry({ tokenId: TOKEN_B, observedTokenContentHash: HASH_B }),
      makeEntry({ tokenId: TOKEN_C, observedTokenContentHash: HASH_C }),
    ];
    const out = await adaptLegacyShape(buildInput(payload, entries));
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.tokenId)).toEqual([TOKEN_A, TOKEN_B, TOKEN_C]);
    expect(out.every((r) => r.disposition === 'VALID')).toBe(true);
    // Each entry should carry a DIFFERENT synthetic bundleCid (suffixed
    // by its index) so multi-rep accounting is preserved.
    const cids = new Set(out.map((r) => r.bundleCid));
    expect(cids.size).toBe(3);
    out.forEach((r) => {
      expect(r.bundleCid).toContain('legacy-combined-v6-');
    });
  });

  it('mixed VALID + AUDIT outcomes produce both disposition types', async () => {
    const payload = {
      type: 'COMBINED_TRANSFER',
      version: '6.0',
    } as unknown as LegacyTokenTransferPayload;
    const entries = [
      makeEntry({ tokenId: TOKEN_A, observedTokenContentHash: HASH_A }),
      makeEntry({ tokenId: TOKEN_B, observedTokenContentHash: HASH_B }),
    ];
    let predicateCallCount = 0;
    const out = await adaptLegacyShape(
      buildInput(payload, entries, {
        evaluatePredicate: async () => {
          // First entry → bindsToUs:true; second → bindsToUs:false.
          predicateCallCount += 1;
          return predicateCallCount === 1
            ? { ok: true, bindsToUs: true }
            : { ok: true, bindsToUs: false };
        },
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0].disposition).toBe('VALID');
    expect(out[1].disposition).toBe('AUDIT');
  });
});

// =============================================================================
// 7. V5 / V4 INSTANT_SPLIT — 1 entry per recipient mint
// =============================================================================

describe('V5 INSTANT_SPLIT — 1 recipient mint → 1 disposition', () => {
  it('routes a V5 split-bundle to a single VALID disposition', async () => {
    const payload = {
      type: 'INSTANT_SPLIT',
      version: '5.0',
      burnTransaction: 'btx',
      recipientMintData: 'rmd',
      transferCommitment: 'tc',
    } as unknown as LegacyTokenTransferPayload;
    const entry = makeEntry({ tokenId: TOKEN_A, observedTokenContentHash: HASH_A });
    const out = await adaptLegacyShape(buildInput(payload, [entry]));
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('VALID');
    expect(out[0].bundleCid).toContain('legacy-instant-split-v5-');
  });
});

describe('V4 INSTANT_SPLIT — 1 recipient mint → 1 disposition', () => {
  it('routes a V4 split-bundle through the same path as V5', async () => {
    const payload = {
      type: 'INSTANT_SPLIT',
      version: '4.0',
      burnCommitment: 'bc',
      recipientMintData: 'rmd',
      transferCommitment: 'tc',
    } as unknown as LegacyTokenTransferPayload;
    const entry = makeEntry({ tokenId: TOKEN_A, observedTokenContentHash: HASH_A });
    const out = await adaptLegacyShape(buildInput(payload, [entry]));
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('VALID');
    expect(out[0].bundleCid).toContain('legacy-instant-split-v4-');
  });
});

// =============================================================================
// 8. SDK legacy {token, proof} — 1 entry → 1 disposition
// =============================================================================

describe('SDK legacy {token, proof} — 1 entry → 1 disposition', () => {
  it('produces ONE VALID DispositionRecord', async () => {
    const payload = {
      token: { id: TOKEN_A },
      proof: { p: 'q' },
    } as unknown as LegacyTokenTransferPayload;
    const entry = makeEntry({ tokenId: TOKEN_A, observedTokenContentHash: HASH_A });
    const out = await adaptLegacyShape(buildInput(payload, [entry]));
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('VALID');
    expect(out[0].bundleCid).toContain('legacy-sdk-legacy-');
  });
});

// =============================================================================
// 9. Instant-TXF (inclusionProof:null) — finalization-queue routing
// =============================================================================

describe('Instant-TXF — inclusionProof:null routes through finalization queue', () => {
  it('enqueues ONE entry per unfinalized tx (single-tx chain)', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry: LegacyTokenEntry = {
      tokenId: TOKEN_A,
      observedTokenContentHash: HASH_A,
      chain: [
        {
          sourceState: 's0',
          destinationState: 's1',
          authenticator: { kind: 'auth' },
          transactionHash: { kind: 'txh' },
          inclusionProof: null, // <-- INSTANT-TXF marker
          requestId: null,
          transactionHashHex: 'aa'.repeat(34),
          authenticatorHex: 'bb'.repeat(32),
        },
      ],
      currentStatePredicate: { kind: 'predicate' },
      currentDestinationStateHash: STATE_HEAD,
    };
    const enqueued: Array<{ addr: string; entry: FinalizationQueueEntry }> = [];
    const enqueue: FinalizationQueueEnqueuer = async (addr, e) => {
      enqueued.push({ addr, entry: e });
    };
    const out = await adaptLegacyShape(
      buildInput(payload, [entry], { enqueueFinalization: enqueue }),
    );
    // The disposition surfaces as PENDING (per §5.3 [E] when chain has
    // unfinalized txs) AND the queue receives one entry.
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('PENDING');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].addr).toBe(ADDR);
    expect(enqueued[0].entry.tokenId).toBe(TOKEN_A);
    expect(enqueued[0].entry.txIndex).toBe(0);
    expect(enqueued[0].entry.bundleCid).toContain('legacy-sphere-txf-');
    expect(enqueued[0].entry.source).toBe('received');
    expect(enqueued[0].entry.status).toBe('pending');
    // entryId === `${tokenId}:${txIndex}` per `entryIdFor`.
    expect(enqueued[0].entry.entryId).toBe(`${TOKEN_A}:0`);
  });

  it('enqueues K entries for K-deep chain-mode chain (mixed proven + null)', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry: LegacyTokenEntry = {
      tokenId: TOKEN_A,
      observedTokenContentHash: HASH_A,
      chain: [
        // tx 0 — already finalized (has proof)
        {
          sourceState: 's0',
          destinationState: 's1',
          authenticator: { kind: 'auth0' },
          transactionHash: { kind: 'txh0' },
          inclusionProof: { kind: 'proof0' },
          requestId: 'req-0',
        },
        // tx 1 — UNFINALIZED
        {
          sourceState: 's1',
          destinationState: 's2',
          authenticator: { kind: 'auth1' },
          transactionHash: { kind: 'txh1' },
          inclusionProof: null,
          requestId: null,
        },
        // tx 2 — UNFINALIZED
        {
          sourceState: 's2',
          destinationState: 's3',
          authenticator: { kind: 'auth2' },
          transactionHash: { kind: 'txh2' },
          inclusionProof: null,
          requestId: null,
        },
      ],
      currentStatePredicate: { kind: 'predicate' },
      currentDestinationStateHash: STATE_HEAD,
    };
    const enqueued: Array<{ addr: string; entry: FinalizationQueueEntry }> = [];
    const enqueue: FinalizationQueueEnqueuer = async (addr, e) => {
      enqueued.push({ addr, entry: e });
    };
    const out = await adaptLegacyShape(
      buildInput(payload, [entry], { enqueueFinalization: enqueue }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('PENDING');
    // The finalized tx (txIndex 0) is NOT enqueued; only txIndex 1 + 2.
    expect(enqueued).toHaveLength(2);
    expect(enqueued.map((e) => e.entry.txIndex)).toEqual([1, 2]);
    expect(enqueued.map((e) => e.entry.entryId)).toEqual([
      `${TOKEN_A}:1`,
      `${TOKEN_A}:2`,
    ]);
  });

  it('throws MISSING_FINALIZATION_QUEUE when no enqueueFinalization hook is supplied (#163)', async () => {
    // Per #163 / §4.4.2 / §5.5: an instant-TXF chain (any
    // `inclusionProof: null`) MUST be routed through the per-address
    // finalization queue. Without an enqueuer wired, the adapter
    // refuses to write a PENDING disposition — that would leave the
    // recipient permanently stuck (no worker tracking).
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry: LegacyTokenEntry = {
      tokenId: TOKEN_A,
      observedTokenContentHash: HASH_A,
      chain: [
        {
          sourceState: 's0',
          destinationState: 's1',
          authenticator: { kind: 'auth' },
          transactionHash: { kind: 'txh' },
          inclusionProof: null,
          requestId: null,
        },
      ],
      currentStatePredicate: { kind: 'predicate' },
      currentDestinationStateHash: STATE_HEAD,
    };
    // No enqueueFinalization in the input — adapter throws.
    await expect(
      adaptLegacyShape(buildInput(payload, [entry])),
    ).rejects.toThrow(/MISSING_FINALIZATION_QUEUE|finalization queue|enqueueFinalization/i);
  });

  it('throws MISSING_FINALIZATION_QUEUE when addr is missing for unfinalized chain (#163)', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry: LegacyTokenEntry = {
      tokenId: TOKEN_A,
      observedTokenContentHash: HASH_A,
      chain: [
        {
          sourceState: 's0',
          destinationState: 's1',
          authenticator: { kind: 'auth' },
          transactionHash: { kind: 'txh' },
          inclusionProof: null,
          requestId: null,
        },
      ],
      currentStatePredicate: { kind: 'predicate' },
      currentDestinationStateHash: STATE_HEAD,
    };
    const enqueue = vi.fn<FinalizationQueueEnqueuer>(async () => undefined);
    await expect(
      adaptLegacyShape(
        buildInput(payload, [entry], {
          enqueueFinalization: enqueue,
          addr: undefined,
        }),
      ),
    ).rejects.toThrow(/MISSING_FINALIZATION_QUEUE|finalization queue|addr/i);
    // The enqueue hook is never called — we throw before reaching it.
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does NOT throw when chain is fully finalized and no enqueuer wired', async () => {
    // Inverse of the throw cases: a chain with NO unfinalized txs is
    // safe to process without an enqueuer. Used by tests / pre-T.5.C
    // deployments that pin senders to conservative TXF.
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry: LegacyTokenEntry = {
      tokenId: TOKEN_A,
      observedTokenContentHash: HASH_A,
      chain: [
        {
          sourceState: 's0',
          destinationState: 's1',
          authenticator: { kind: 'auth' },
          transactionHash: { kind: 'txh' },
          inclusionProof: { kind: 'proof' }, // <-- FULLY FINALIZED
          requestId: 'req-1',
        },
      ],
      currentStatePredicate: { kind: 'predicate' },
      currentDestinationStateHash: STATE_HEAD,
    };
    const out = await adaptLegacyShape(buildInput(payload, [entry]));
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('VALID');
  });

  it('best-effort: a per-entry enqueue throw does NOT abort the rest', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry: LegacyTokenEntry = {
      tokenId: TOKEN_A,
      observedTokenContentHash: HASH_A,
      chain: [
        {
          sourceState: 's0',
          destinationState: 's1',
          authenticator: { kind: 'auth0' },
          transactionHash: { kind: 'txh0' },
          inclusionProof: null,
          requestId: null,
        },
        {
          sourceState: 's1',
          destinationState: 's2',
          authenticator: { kind: 'auth1' },
          transactionHash: { kind: 'txh1' },
          inclusionProof: null,
          requestId: null,
        },
      ],
      currentStatePredicate: { kind: 'predicate' },
      currentDestinationStateHash: STATE_HEAD,
    };
    let calls = 0;
    const enqueue: FinalizationQueueEnqueuer = async () => {
      calls += 1;
      if (calls === 1) throw new Error('orbitdb-write-failed');
    };
    const out = await adaptLegacyShape(
      buildInput(payload, [entry], { enqueueFinalization: enqueue }),
    );
    // Disposition still surfaces; both queue calls were attempted
    // despite the first throw.
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('PENDING');
    expect(calls).toBe(2);
  });
});

// =============================================================================
// 10. Defensive paths — hook throws + empty extraction
// =============================================================================

describe('defensive paths', () => {
  it('extractTxLegacyChain throw → single STRUCTURAL_INVALID record', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const out = await adaptLegacyShape(
      buildInput(payload, [], {
        extractTxLegacyChain: async () => {
          throw new Error('SDK CBOR exploded');
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('INVALID');
    if (out[0].disposition === 'INVALID') {
      expect(out[0].reason).toBe('structural');
      expect(out[0].tokenId).toBe('');
    }
  });

  it('empty entries list → single STRUCTURAL_INVALID record', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const out = await adaptLegacyShape(buildInput(payload, []));
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('INVALID');
    if (out[0].disposition === 'INVALID') {
      expect(out[0].reason).toBe('structural');
    }
  });

  it('mis-shapen entry from hook → STRUCTURAL_INVALID with salvaged tokenId', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const malformed = {
      tokenId: TOKEN_A,
      observedTokenContentHash: HASH_A,
      // chain MUST be an array; we omit it to trip isValidEntry.
    } as unknown as LegacyTokenEntry;
    const out = await adaptLegacyShape(buildInput(payload, [malformed]));
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('INVALID');
    expect(out[0].tokenId).toBe(TOKEN_A);
    expect(out[0].observedTokenContentHash).toBe(HASH_A);
  });

  it('throws on UXF v1.0 envelope (caller mis-routed)', async () => {
    const uxfPayload = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid: 'bafy',
      tokenIds: [],
      carBase64: 'AAAA',
    } as unknown as LegacyTokenTransferPayload;
    await expect(adaptLegacyShape(buildInput(uxfPayload, []))).rejects.toThrow(
      /not a recognized legacy shape/,
    );
  });

  it('throws on missing required hooks', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    // Build a partial input deliberately missing one hook.
    const partial = {
      payload,
      senderTransportPubkey: SENDER_PUBKEY,
      addr: ADDR,
      ourPubkey: PUBKEY,
      trustBase: TRUSTBASE,
      extractTxLegacyChain: async () => [],
      // evaluatePredicate omitted intentionally
    } as unknown as LegacyShapeAdapterInput;
    await expect(adaptLegacyShape(partial)).rejects.toThrow(
      /evaluatePredicate hook is required/,
    );
  });

  it('throws on missing ourPubkey', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entries: ReadonlyArray<LegacyTokenEntry> = [];
    const partial = {
      ...buildInput(payload, entries),
      ourPubkey: undefined as unknown as Uint8Array,
    } as LegacyShapeAdapterInput;
    await expect(adaptLegacyShape(partial)).rejects.toThrow(
      /ourPubkey/,
    );
  });
});

// =============================================================================
// 11. Acceptance — UXF / legacy convergence (§10.2)
// =============================================================================

describe('§10.2 single-pipeline convergence — same shape outcomes', () => {
  // The acceptance criterion: legacy-shape arrivals produce the SAME
  // disposition outcomes as an equivalent UXF bundle would. We don't
  // simulate a UXF bundle here; instead we assert each of the
  // disposition-record SHAPES the engine can return is reachable
  // through the adapter.
  it.each<[string, HookOverrides, LegacyTokenEntry['chain'][number]['inclusionProof'], string]>([
    ['VALID',          {},                                                                              { kind: 'proof' }, 'VALID'],
    ['NOT_OUR_STATE',  { evaluatePredicate: async () => ({ ok: true, bindsToUs: false }) },             { kind: 'proof' }, 'AUDIT'],
    ['AUTH_INVALID',   { verifyAuthenticator: async () => ({ ok: true, valid: false }) },               { kind: 'proof' }, 'INVALID'],
    ['CONTINUITY',     { walkContinuity: () => ({ ok: false, brokenAt: 1, reason: 'continuity-broken' as const }) }, { kind: 'proof' }, 'INVALID'],
    ['UNSPENDABLE',    { oracleIsSpent: async () => true },                                             { kind: 'proof' }, 'AUDIT'],
  ])('reaches %s outcome', async (_name, overrides, proof, expected) => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry: LegacyTokenEntry = {
      tokenId: TOKEN_A,
      observedTokenContentHash: HASH_A,
      chain: [
        {
          sourceState: 's0',
          destinationState: 's1',
          authenticator: { kind: 'auth' },
          transactionHash: { kind: 'txh' },
          inclusionProof: proof,
          requestId: 'req-1',
        },
      ],
      currentStatePredicate: { kind: 'predicate' },
      currentDestinationStateHash: STATE_HEAD,
    };
    const out = await adaptLegacyShape(buildInput(payload, [entry], overrides));
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe(expected);
  });

  it('PENDING when chain has unfinalized tx', async () => {
    const payload = {
      sourceToken: { id: TOKEN_A },
      transferTx: { tx: 'y' },
    } as unknown as LegacyTokenTransferPayload;
    const entry: LegacyTokenEntry = {
      tokenId: TOKEN_A,
      observedTokenContentHash: HASH_A,
      chain: [
        {
          sourceState: 's0',
          destinationState: 's1',
          authenticator: { kind: 'auth' },
          transactionHash: { kind: 'txh' },
          inclusionProof: null,
          requestId: null,
        },
      ],
      currentStatePredicate: { kind: 'predicate' },
      currentDestinationStateHash: STATE_HEAD,
    };
    // Per #163: instant-TXF chains require a wired enqueuer.
    const enqueue: FinalizationQueueEnqueuer = async () => undefined;
    const out = await adaptLegacyShape(
      buildInput(payload, [entry], { enqueueFinalization: enqueue }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('PENDING');
  });
});
