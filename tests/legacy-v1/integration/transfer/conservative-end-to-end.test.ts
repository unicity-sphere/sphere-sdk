/**
 * §11.2 integration — End-to-end conservative-mode UXF send/receive
 * (1, 5, and 100 tokens).
 *
 * Pipeline under test (sender side, T.2.D.1):
 *   `validateTargets` → `selectSources` → `commitSources` →
 *   `UxfPackage.create` + `ingestAll` → `toCar` → `extractCarRootCid` →
 *   `resolveDelivery` → outbox transitions → `transport.sendTokenTransfer`.
 *
 * Pipeline under test (recipient side, T.3.A):
 *   `acquireBundle` → `verifyBundleStructure`.
 *
 * Each scenario runs the conservative-sender, captures the wire payload
 * the transport emitted, decodes it, and feeds it back through
 * `acquireBundle` to assert the bundle parses, verifies, and exposes the
 * exact set of `tokenIds` that were committed. This is the §11.2 first
 * bullet: "End-to-end conservative-mode send/receive: 1 token, 5 tokens,
 * 100 tokens."
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import { isReplayOutcome, acquireBundle } from '../../../extensions/uxf/pipeline/bundle-acquirer';
import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
} from '../../../extensions/uxf/pipeline/conservative-sender';
import type { PreflightFinalizeOptions } from '../../../extensions/uxf/pipeline/preflight-finalize';
import { ReplayLRU } from '../../../extensions/uxf/pipeline/replay-lru';
import type {
  UxfTransferPayload,
  UxfTransferPayloadCar,
} from '../../../extensions/uxf/types/uxf-transfer';
import type { TransferRequest } from '../../../types';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

import {
  ALICE_CHAIN_PUBKEY,
  BOB_TRANSPORT_PUBKEY,
  defaultCoinTokenLike,
  makeEventRecorder,
  makeIdentity,
  makeOracleStub,
  makePeerInfo,
  makeRecordingTransport,
  makeToken,
  rewriteFixtureTokenId,
} from './_harness';

// =============================================================================
// 1. Helpers
// =============================================================================

/**
 * Run the conservative-sender end-to-end with a synthetic N-token pool.
 * Returns the wire payload published by the transport so the recipient
 * pipeline can re-parse it.
 */
async function runConservativeSendN(tokenCount: number): Promise<{
  readonly payload: UxfTransferPayloadCar;
  readonly events: ReturnType<typeof makeEventRecorder>;
  readonly canonicalTokenIds: ReadonlyArray<string>;
}> {
  // Build N source tokens with distinct ids; rewrite each fixture's
  // genesis tokenId so the UXF pool keeps them as N distinct entries
  // (UxfPackage is content-addressed; identical fixtures collapse).
  //
  // Critical alignment: the orchestrator-side `sourceTokenId` MUST equal
  // the canonical 64-hex tokenId carried in the CAR's pool — that is
  // what the verifier surfaces in `claimedTokens[].tokenId`. Using a
  // distinct orchestrator handle (`tok-1`, ...) would publish those
  // handles in `payload.tokenIds` while the pool carries the 64-hex
  // ids, causing a CLAIMED-MISSING verifier outcome.
  const sources = Array.from({ length: tokenCount }, (_, i) => {
    // Pad for a stable 4-hex serial, then fill remaining nibbles with
    // a deterministic pattern so the 64-hex stays well-formed.
    const serial = (i + 1).toString(16).padStart(4, '0');
    const idHex = `aa${serial}${'0'.repeat(58)}`;
    const fixture = rewriteFixtureTokenId(TOKEN_A, idHex);
    return {
      token: makeToken({ id: idHex, fixture }),
      fixture,
      idHex,
    };
  });

  const commitResults: ConservativeCommitResult[] = sources.map((s) => ({
    sourceTokenId: s.idHex,
    method: 'direct',
    requestIdHex: `req-${s.idHex}`,
    recipientTokenJson: s.fixture,
  }));

  const transport = makeRecordingTransport();
  const events = makeEventRecorder();

  const deps: ConservativeSenderDeps = {
    aggregator: makeOracleStub(),
    transport,
    identity: makeIdentity(),
    senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
    emit: events.emit,
    availableSources: () => sources.map((s) => s.token),
    selectSources: async () => sources.map((s) => s.token),
    preflightOptions: () => ({
      resolveRequestId: () => {
        throw new Error('resolveRequestId should not be invoked');
      },
      extractPendingChain: () => [],
    } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
    commitSources: async () => commitResults,
    toTokenLike: defaultCoinTokenLike,
  };

  const request: TransferRequest = {
    recipient: '@bob',
    coinId: 'UCT',
    // Total amount across N tokens (1_000_000 each).
    amount: String(1_000_000 * tokenCount),
    transferMode: 'conservative',
    // Force inline so a tiny 1-token bundle does NOT need an IPFS
    // publisher; the 100-token bundle obviously exceeds the default
    // 16 KiB cap so we widen it to the relay-safe ceiling for the auto
    // path. force-inline lifts the auto-cap entirely (subject to relay
    // ceiling).
    delivery: { kind: 'force-inline' },
  };

  const result = await sendConservativeUxf(request, makePeerInfo(), deps);
  expect(result.status).toBe('completed');
  expect(transport._calls).toHaveLength(1);

  const payload = transport._calls[0].payload as UxfTransferPayloadCar;
  expect(payload.kind).toBe('uxf-car');
  expect(payload.mode).toBe('conservative');
  return {
    payload,
    events,
    canonicalTokenIds: sources.map((s) => s.idHex),
  };
}

/**
 * Recipient roundtrip: parse the wire payload via `acquireBundle` and
 * return the verified bundle.
 */
async function recipientRoundtrip(
  payload: UxfTransferPayload,
): Promise<{ readonly tokenIds: ReadonlyArray<string>; readonly bundleCid: string }> {
  const lru = new ReplayLRU();
  // The acquirer requires the AUTHENTICATED transport pubkey of the
  // sender (Nostr event author). In the test harness, the sender's
  // transportPubkey is BOB_TRANSPORT_PUBKEY (we re-use BOB's slot for
  // the sender's signing key; the LRU bucket key is the only thing
  // this drives).
  const result = await acquireBundle(payload, ALICE_CHAIN_PUBKEY, lru);
  if (isReplayOutcome(result)) {
    throw new Error('unreachable: first arrival');
  }
  expect(result.verified).toBe(true);
  return {
    tokenIds: result.claimedTokens.map((r) => r.tokenId),
    bundleCid: result.bundleCid,
  };
}

// =============================================================================
// 2. Tests — 1 token, 5 tokens, 100 tokens
// =============================================================================

describe('§11.2 — conservative-mode end-to-end (1 token)', () => {
  it('sender pipeline emits uxf-car payload; recipient verifies and surfaces 1 tokenId', async () => {
    const { payload, events } = await runConservativeSendN(1);

    expect(payload.tokenIds).toHaveLength(1);
    expect(typeof payload.bundleCid).toBe('string');
    expect(payload.bundleCid.length).toBeGreaterThan(0);
    expect(typeof payload.carBase64).toBe('string');
    expect(payload.carBase64.length).toBeGreaterThan(0);

    // sender event: transfer:confirmed exactly once.
    expect(events.count('transfer:confirmed')).toBe(1);
    expect(events.count('transfer:failed')).toBe(0);

    // Recipient roundtrip — the bundleCid in the wire envelope MUST
    // equal the bundleCid the verifier derives from the embedded CAR.
    const verified = await recipientRoundtrip(payload);
    expect(verified.bundleCid).toBe(payload.bundleCid);
    // The single ingested token surfaces with its rewritten 64-hex id
    // (NOT the orchestrator-side `tok-1` handle — that's the source
    // tokenId, distinct from the CAR-embedded canonical tokenId).
    expect(verified.tokenIds).toHaveLength(1);
  });
});

describe('§11.2 — conservative-mode end-to-end (5 tokens)', () => {
  it('bundle carries 5 distinct tokenIds; lex-min ordering on the wire', async () => {
    const { payload, events, canonicalTokenIds } = await runConservativeSendN(5);

    expect(payload.tokenIds).toHaveLength(5);
    expect(payload.mode).toBe('conservative');
    expect(events.count('transfer:confirmed')).toBe(1);
    expect(events.count('transfer:failed')).toBe(0);

    // §4.2 acceptance: bundle-internal token order is deterministic
    // (lex-ascending by sourceTokenId — the canonical 64-hex ids).
    const sortedAsc = [...canonicalTokenIds].sort();
    expect([...payload.tokenIds]).toEqual(sortedAsc);

    const verified = await recipientRoundtrip(payload);
    expect(verified.tokenIds).toHaveLength(5);
    expect(verified.bundleCid).toBe(payload.bundleCid);
    expect([...verified.tokenIds].sort()).toEqual(sortedAsc);
  });
});

describe('§11.2 — conservative-mode end-to-end (100 tokens)', () => {
  it('bundle carries 100 tokenIds; verifier accepts; bundleCid stable', async () => {
    const { payload, events, canonicalTokenIds } = await runConservativeSendN(100);

    expect(payload.tokenIds).toHaveLength(100);
    expect(events.count('transfer:confirmed')).toBe(1);
    expect(events.count('transfer:failed')).toBe(0);

    // §4.2 acceptance: lex-ascending order on the wire.
    const sortedAsc = [...canonicalTokenIds].sort();
    expect([...payload.tokenIds]).toEqual(sortedAsc);

    // Verify recipient consumes the 100-token bundle without rejecting.
    const verified = await recipientRoundtrip(payload);
    expect(verified.tokenIds).toHaveLength(100);
    // Same bundleCid → content-addressed idempotency anchor.
    expect(verified.bundleCid).toBe(payload.bundleCid);
    expect([...verified.tokenIds].sort()).toEqual(sortedAsc);
  });
});

// =============================================================================
// 3. Replay LRU regression — second arrival of same bundleCid is short-circuit
// =============================================================================

describe('§11.2 — conservative-mode replay short-circuit (§5.6)', () => {
  it('re-arrival of identical bundleCid produces a ReplayOutcome (no re-verification)', async () => {
    const { payload } = await runConservativeSendN(1);

    const lru = new ReplayLRU();
    // First arrival — verifies normally.
    const first = await acquireBundle(payload, ALICE_CHAIN_PUBKEY, lru);
    expect(isReplayOutcome(first)).toBe(false);

    // Second arrival — same (sender, bundleCid) → short-circuit.
    const second = await acquireBundle(payload, ALICE_CHAIN_PUBKEY, lru);
    expect(isReplayOutcome(second)).toBe(true);
    if (isReplayOutcome(second)) {
      expect(second.bundleCid).toBe(payload.bundleCid);
    }
  });
});
