/**
 * Tests for the §5.5 step 9 re-evaluator entry-point (W5).
 *
 * Verifies the {@link revaluate} function's [B]/[D]/[E] re-run paths:
 *
 *  - [B] predicate binds → pass-through to [D]
 *  - [B] predicate fails (bindsToUs:false) → AUDIT(`not-our-state`)
 *  - [B] predicate hook throws → STRUCTURAL_INVALID(`predicate-eval`)
 *  - [D] no local manifest entry / matching head → pass-through to [E]
 *  - [D] divergent local head → CONFLICTING with merged conflictingHeads
 *  - [D] local manifest read throws → STRUCTURAL_INVALID
 *  - [E] isSpent=false → VALID
 *  - [E] isSpent=true → AUDIT(`off-record-spend`)
 *  - [E] oracle.isSpent throws → STRUCTURAL_INVALID
 *  - hydrate throw → STRUCTURAL_INVALID
 *  - residual unfinalized tx (caller bug) → STRUCTURAL_INVALID
 *
 * Spec refs: §5.5 step 9 (queue-drain → status transition), W5.
 */

import { describe, expect, it } from 'vitest';

import {
  revaluate,
  type DispositionRevaluateInput,
  type HydratedChain,
  type HydratedTx,
} from '../../../../modules/payments/transfer/disposition-engine';
import type { ManifestEntryDelta } from '../../../../types/disposition';
import type { ContentHash, UxfElement } from '../../../../extensions/uxf/bundle/types';

const TOKEN_ID =
  'aa00000000000000000000000000000000000000000000000000000000000001';
const TOKEN_ROOT_HASH =
  '00000000000000000000000000000000000000000000000000000000000000a1' as ContentHash;
const ALT_HEAD_HASH =
  '00000000000000000000000000000000000000000000000000000000000000a2' as ContentHash;
const BUNDLE_CID =
  'bafytest00000000000000000000000000000000000000000000000000000001';
const SENDER_PUBKEY =
  'fefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefe';
const STATE_HASH =
  '0000000000000000000000000000000000000000000000000000000000005646';

const PUBKEY = new Uint8Array(33);
PUBKEY[0] = 0x02;

const POOL = new Map<ContentHash, UxfElement>();

function tx(opts: { hasProof?: boolean } = {}): HydratedTx {
  return {
    sourceState: 's0',
    destinationState: 's1',
    authenticator: { kind: 'auth' },
    transactionHash: { kind: 'txh' },
    inclusionProof:
      (opts.hasProof ?? true) ? ({ kind: 'proof' } as unknown) : null,
    requestId: (opts.hasProof ?? true) ? ({ kind: 'req' } as unknown) : null,
  };
}

function chain(opts: { txs?: ReadonlyArray<HydratedTx> } = {}): HydratedChain {
  return {
    tokenId: TOKEN_ID,
    tokenRootHash: TOKEN_ROOT_HASH,
    chain: opts.txs ?? [tx({ hasProof: true })],
    currentStatePredicate: { kind: 'predicate' },
    currentDestinationStateHash: STATE_HASH,
  };
}

interface BuildOverrides {
  readonly chain?: HydratedChain;
  readonly hydrateThrow?: unknown;
  readonly bindsToUs?: boolean;
  readonly predicateOk?: boolean;
  readonly predicateThrow?: unknown;
  readonly localManifest?: ManifestEntryDelta;
  readonly localManifestThrow?: unknown;
  readonly oracleIsSpent?: boolean;
  readonly oracleThrow?: unknown;
}

function buildInput(o: BuildOverrides = {}): DispositionRevaluateInput {
  const c = o.chain ?? chain();
  return {
    tokenRootHash: TOKEN_ROOT_HASH,
    pool: POOL,
    bundleCidForProvenance: BUNDLE_CID,
    senderTransportPubkeyForProvenance: SENDER_PUBKEY,
    ourPubkey: PUBKEY,
    hydrateChain: async () => {
      if (o.hydrateThrow !== undefined) throw o.hydrateThrow;
      return c;
    },
    readLocalManifest: async () => {
      if (o.localManifestThrow !== undefined) throw o.localManifestThrow;
      return o.localManifest;
    },
    evaluatePredicate: async () => {
      if (o.predicateThrow !== undefined) throw o.predicateThrow;
      if (o.predicateOk === false) {
        return { ok: false, threw: true, error: new Error('predicate boom') };
      }
      return { ok: true, bindsToUs: o.bindsToUs ?? true };
    },
    oracleIsSpent: async () => {
      if (o.oracleThrow !== undefined) throw o.oracleThrow;
      return o.oracleIsSpent ?? false;
    },
  };
}

describe('revaluate — happy paths', () => {
  it('VALID — all checks pass', async () => {
    const r = await revaluate(buildInput());
    expect(r.disposition).toBe('VALID');
    expect(r.tokenId).toBe(TOKEN_ID);
    if (r.disposition === 'VALID') {
      expect(r.manifest.status).toBe('valid');
      // Chain head is last tx destinationState (#162) — default
      // single-tx builder uses dst='s1'.
      expect(r.manifest.rootHash).toBe('s1');
      expect(r.bundleCid).toBe(BUNDLE_CID);
      expect(r.senderTransportPubkey).toBe(SENDER_PUBKEY);
    }
  });

  it('VALID even with local manifest matching the new head', async () => {
    const r = await revaluate(
      buildInput({
        // Match the new head (last tx destinationState='s1').
        localManifest: { rootHash: 's1' as ContentHash, status: 'pending' },
      }),
    );
    expect(r.disposition).toBe('VALID');
  });
});

describe('revaluate — [B] predicate fails', () => {
  it('AUDIT(not-our-state) when bindsToUs:false', async () => {
    const r = await revaluate(buildInput({ bindsToUs: false }));
    expect(r.disposition).toBe('AUDIT');
    if (r.disposition === 'AUDIT') {
      expect(r.reason).toBe('not-our-state');
      expect(r.auditStatus).toBe('audit-not-our-state');
    }
  });

  it('STRUCTURAL_INVALID(predicate-eval) when predicate hook throws', async () => {
    const r = await revaluate(
      buildInput({ predicateThrow: new Error('boom') }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('predicate-eval');
    }
  });

  it('STRUCTURAL_INVALID(predicate-eval) when predicate result is ok:false', async () => {
    const r = await revaluate(buildInput({ predicateOk: false }));
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('predicate-eval');
    }
  });
});

describe('revaluate — [D] conflict check', () => {
  it('CONFLICTING when local manifest has divergent head', async () => {
    const r = await revaluate(
      buildInput({
        localManifest: { rootHash: ALT_HEAD_HASH, status: 'valid' },
      }),
    );
    expect(r.disposition).toBe('CONFLICTING');
    if (r.disposition === 'CONFLICTING') {
      expect(r.conflictingHeads).toContain(ALT_HEAD_HASH);
      // Chain head is last tx destinationState (#162) — default
      // single-tx builder uses dst='s1'.
      expect(r.manifest.rootHash).toBe('s1');
      expect(r.manifest.status).toBe('conflicting');
    }
  });

  it('STRUCTURAL_INVALID when readLocalManifest throws', async () => {
    const r = await revaluate(
      buildInput({ localManifestThrow: new Error('storage corrupt') }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('structural');
    }
  });

  it('local manifest already invalid does NOT surface CONFLICTING', async () => {
    const r = await revaluate(
      buildInput({
        localManifest: {
          rootHash: ALT_HEAD_HASH,
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        },
      }),
    );
    // §5.6 idempotency: invalid status is monotonic — disposition
    // engine should let [E] proceed; the writer's merger handles the
    // monotonic-invalid invariant.
    expect(r.disposition).toBe('VALID');
  });
});

describe('revaluate — [E] spent check', () => {
  it('AUDIT(off-record-spend) when isSpent=true', async () => {
    const r = await revaluate(buildInput({ oracleIsSpent: true }));
    expect(r.disposition).toBe('AUDIT');
    if (r.disposition === 'AUDIT') {
      expect(r.reason).toBe('off-record-spend');
      expect(r.auditStatus).toBe('audit-off-record-spend');
    }
  });

  it('STRUCTURAL_INVALID when oracle.isSpent throws', async () => {
    const r = await revaluate(
      buildInput({ oracleThrow: new Error('aggregator offline') }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('structural');
    }
  });
});

describe('revaluate — defensive paths', () => {
  it('hydrate throw → STRUCTURAL_INVALID', async () => {
    const r = await revaluate(
      buildInput({ hydrateThrow: new Error('hydration failed') }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('structural');
    }
  });

  it('residual unfinalized tx → STRUCTURAL_INVALID (caller bug)', async () => {
    // §5.5 step 9 invariant: caller must drain the queue first. If the
    // chain still has unfinalized txs, route to STRUCTURAL_INVALID.
    const r = await revaluate(
      buildInput({
        chain: chain({
          txs: [tx({ hasProof: true }), tx({ hasProof: false })],
        }),
      }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('structural');
    }
  });

  it('empty tokenId from hydration → STRUCTURAL_INVALID', async () => {
    const c: HydratedChain = {
      tokenId: '',
      tokenRootHash: TOKEN_ROOT_HASH,
      chain: [],
      currentStatePredicate: { kind: 'predicate' },
      currentDestinationStateHash: STATE_HASH,
    };
    const r = await revaluate(buildInput({ chain: c }));
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('structural');
    }
  });
});
