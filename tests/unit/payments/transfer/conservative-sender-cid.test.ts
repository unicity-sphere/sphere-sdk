/**
 * Tests for `modules/payments/transfer/conservative-sender.ts` CID-pin
 * delivery path (T.4.A).
 *
 * T.2.D.2 wired the conservative-sender to the outbox state machine for
 * BOTH inline and CID branches. T.4.A completes the CID-pin path:
 *
 *  - **Pin call** — the resolver's CID branch invokes `publishToIpfs`,
 *    which is the orchestrator-injected callback that ultimately pins
 *    the CAR via the IPFS HTTP API. T.4.A asserts that:
 *      * the pin call fires for `force-cid` even on a tiny bundle;
 *      * the pin call fires for `auto`-mode-over-cap on a > 16 KiB
 *        bundle (the auto-route entry point per §3.3.1);
 *      * the pin call is idempotent (re-running with the same CAR
 *        returns the same CID without state corruption).
 *  - **Outbox lifecycle** — happy path transitions
 *    `packaging → pinned → sending → delivered` per §7.0; pin failure
 *    transitions `packaging → pinned → failed-permanent` (the new
 *    T.4.A arc, see `profile/outbox-state-machine.ts`). The orchestrator
 *    transitions `packaging → pinned` EAGERLY (before the pin call) so
 *    the §7.0 arc semantics are honoured even when pin throws.
 *  - **Strict ordering invariant** — Nostr publish MUST NEVER fire when
 *    pin fails. This is the §3.3.2 invariant: the recipient only
 *    considers the bundle delivered when it can fetch the CAR by CID,
 *    so publishing the Nostr event with an unpinned CID is worse than
 *    not publishing at all. We assert with a transport-call spy that
 *    `sendTokenTransfer` is NEVER called on the pin-failure arc.
 *  - **`senderGateways` wire field** — when a `senderGateways` hint
 *    is configured on the orchestrator deps, it is stamped onto the
 *    `UxfTransferPayloadCid` envelope (informational only — the
 *    recipient walks its own configured list per §3.3 / §9.2).
 *
 * Spec references:
 *  - §3.3   Inline vs CID delivery (force-cid / auto-over-cap routing).
 *  - §3.3.1 Per-call sender overrides; informational `senderGateways`.
 *  - §3.3.2 Pin/Nostr ordering invariants — Nostr publish MUST NOT
 *           happen if pin permanently fails.
 *  - §7.0   Outbox state machine (T.4.A `pinned → failed-permanent`
 *           arc; canonical row in `profile/outbox-state-machine.ts`).
 *  - T.4.A acceptance (impl plan).
 */

import { describe, expect, it, vi } from 'vitest';

import { AUTOMATED_CID_DELIVERY_ENABLED } from '../../../../modules/payments/transfer/limits';
import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
  type OutboxIntegrationHooks,
  type OutboxTransitionPatch,
} from '../../../../modules/payments/transfer/conservative-sender';

// Issue #393 — gate auto-CID-promotion tests on the kill-switch (see
// `modules/payments/transfer/limits.ts`).
const ifAutoCid = AUTOMATED_CID_DELIVERY_ENABLED ? it : it.skip;
import type { PreflightFinalizeOptions } from '../../../../modules/payments/transfer/preflight-finalize';
import type { TokenLike } from '../../../../modules/payments/transfer/classify-token';
import type { PublishToIpfsCallback } from '../../../../modules/payments/transfer/delivery-resolver';
import { isSphereError, SphereError } from '../../../../core/errors';
import { Lamport } from '../../../../profile/lamport';
import { OutboxWriter } from '../../../../profile/outbox-writer';
import type { ProfileDatabase } from '../../../../profile/types';
import type { OracleProvider } from '../../../../oracle/oracle-provider';
import type { TransportProvider } from '../../../../transport';
import type { PeerInfo } from '../../../../transport/transport-provider';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
  TransferRequest,
} from '../../../../types';
import type {
  UxfTransferPayloadCar,
  UxfTransferPayloadCid,
} from '../../../../types/uxf-transfer';
import { TOKEN_A } from '../../../fixtures/uxf-mock-tokens';

// =============================================================================
// 1. Shared fixtures + helpers (parallel of conservative-sender.test.ts)
// =============================================================================

function makeToken(id: string, fixture: Record<string, unknown>): Token {
  return {
    id,
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: '1000000',
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
    sdkData: JSON.stringify(fixture),
  };
}

function makeCommitResult(params: {
  readonly sourceTokenId: string;
  readonly fixture: Record<string, unknown>;
  readonly rewriteTokenId?: string;
}): ConservativeCommitResult {
  const f = params.fixture;
  const rewritten: Record<string, unknown> = {
    ...f,
    genesis: {
      ...((f as { genesis: Record<string, unknown> }).genesis),
      data: {
        ...((f as { genesis: { data: Record<string, unknown> } }).genesis.data),
        ...(params.rewriteTokenId !== undefined
          ? { tokenId: params.rewriteTokenId }
          : {}),
      },
    },
  };
  return {
    sourceTokenId: params.sourceTokenId,
    method: 'direct',
    requestIdHex: `req-${params.sourceTokenId}`,
    recipientTokenJson: rewritten,
  };
}

function makeOracleStub(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network',
    description: 'Test stub',
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
  _failNextSendWith: Error | null;
}

function makeTransportStub(): MockTransport {
  const calls: MockTransport['_calls'] = [];
  const stub: MockTransport = {
    _calls: calls,
    _failNextSendWith: null,
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p',
    description: 'Test stub',
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
        if (stub._failNextSendWith) {
          const err = stub._failNextSendWith;
          stub._failNextSendWith = null;
          throw err;
        }
        calls.push({ recipient, payload });
        return 'event-id';
      }),
    onTokenTransfer: vi.fn().mockReturnValue(() => undefined),
  };
  return stub;
}

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02aaaa'.padEnd(66, 'a'),
    directAddress: 'DIRECT://mock-direct',
    privateKey: '01'.repeat(32),
  };
}

function makePeerInfo(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    transportPubkey: '02bbbb'.padEnd(64, 'b'),
    chainPubkey: '02cccc'.padEnd(66, 'c'),
    directAddress: 'DIRECT://bob-direct',
    timestamp: 0,
    nametag: 'bob',
    ...overrides,
  };
}

function defaultTokenLikeForTest(token: Token): TokenLike {
  return {
    id: token.id,
    coins: [{ coinId: token.coinId, amount: BigInt(token.amount) }],
  };
}

function makeDeps(overrides: Partial<ConservativeSenderDeps> = {}): {
  readonly deps: ConservativeSenderDeps;
  readonly transport: MockTransport;
  readonly events: Array<{ type: SphereEventType; data: unknown }>;
} {
  const transport = makeTransportStub();
  const events: Array<{ type: SphereEventType; data: unknown }> = [];
  const emit = <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
    events.push({ type, data });
  };
  const deps: ConservativeSenderDeps = {
    aggregator: makeOracleStub(),
    transport,
    identity: makeIdentity(),
    senderTransportPubkey: '02bbbb'.padEnd(64, 'b'),
    emit,
    availableSources: () => [],
    selectSources: async () => [],
    preflightOptions: () => ({
      resolveRequestId: () => {
        throw new Error('resolveRequestId should not be invoked when chain is empty');
      },
      extractPendingChain: () => [],
    } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
    commitSources: async () => [],
    toTokenLike: defaultTokenLikeForTest,
    ...overrides,
  };
  return { deps, transport, events };
}

function basicRequest(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    recipient: '@bob',
    coinId: 'UCT',
    amount: '1000000',
    transferMode: 'conservative',
    ...overrides,
  };
}

/** In-memory ProfileDatabase — no OrbitDB / Helia required for these tests. */
function makeInMemoryProfileDb(): ProfileDatabase {
  const store = new Map<string, Uint8Array>();
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    put: async (key: string, value: Uint8Array) => {
      store.set(key, value);
    },
    get: async (key: string) => store.get(key) ?? null,
    del: async (key: string) => {
      store.delete(key);
    },
    all: async (prefix?: string) => {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (prefix === undefined || k.startsWith(prefix)) out.set(k, v);
      }
      return out;
    },
    close: vi.fn().mockResolvedValue(undefined),
    onReplication: () => () => undefined,
    isConnected: () => true,
  };
}

function makeWriterBackedHooks(addressId: string): {
  readonly hooks: OutboxIntegrationHooks;
  readonly writer: OutboxWriter;
  readonly db: ProfileDatabase;
} {
  const db = makeInMemoryProfileDb();
  const writer = new OutboxWriter({
    db,
    encryptionKey: null,
    addressId,
    lamport: new Lamport(0),
  });
  const hooks: OutboxIntegrationHooks = {
    create: async (entry) => {
      await writer.write(entry);
    },
    transition: async (id, patch) => {
      await writer.update(id, (prev) => ({
        ...prev,
        ...patch,
        updatedAt: Date.now(),
      }));
    },
  };
  return { hooks, writer, db };
}

// =============================================================================
// 2. Force-cid for tiny bundle — pin called + outbox lifecycle
// =============================================================================

describe('sendConservativeUxf CID — force-cid for tiny bundles', () => {
  it('invokes publishToIpfs once and ships uxf-cid envelope (single-token)', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockResolvedValue({ cid: 'bafytinybundlecidv1example' });

    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      publishToIpfs,
    });

    const result = await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );

    expect(result.status).toBe('completed');
    expect(publishToIpfs).toHaveBeenCalledOnce();
    expect(transport._calls).toHaveLength(1);
    const payload = transport._calls[0].payload as UxfTransferPayloadCid;
    expect(payload.kind).toBe('uxf-cid');
    expect(payload.bundleCid.length).toBeGreaterThan(0);
    expect((payload as { carBase64?: unknown }).carBase64).toBeUndefined();
  });

  it('outbox transitions packaging → pinned → sending → delivered', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockResolvedValue({ cid: 'bafytinybundlecidv1example' });

    const create = vi.fn().mockResolvedValue(undefined);
    const transition = vi.fn().mockResolvedValue(undefined);

    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      publishToIpfs,
      outbox: { create, transition },
    });

    await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].deliveryMethod).toBe('cid-over-nostr');
    expect(create.mock.calls[0][0].status).toBe('packaging');

    const statuses = transition.mock.calls.map(
      (c) => (c[1] as OutboxTransitionPatch).status,
    );
    expect(statuses).toEqual(['pinned', 'sending', 'delivered']);
  });
});

// =============================================================================
// 3. Auto-route → CID for > 16 KiB bundle
// =============================================================================

describe('sendConservativeUxf CID — auto-route over inline cap', () => {
  ifAutoCid('routes to CID branch and exposes uxf-cid payload (>16 KiB simulated)', async () => {
    // The default `MAX_INLINE_CAR_BYTES` is 16 KiB. We can deterministically
    // exercise the auto-over-cap branch by using a 1-byte cap — any
    // non-empty CAR exceeds it. This preserves the spec guarantee
    // ("> 16 KiB → CID") without bloating the test fixture: we are
    // verifying the auto-route DECISION engine, not the concrete byte
    // boundary (which has its own tests in delivery-resolver.test.ts).
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockResolvedValue({ cid: 'bafyautocidv1example' });

    const create = vi.fn().mockResolvedValue(undefined);
    const transition = vi.fn().mockResolvedValue(undefined);

    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      publishToIpfs,
      outbox: { create, transition },
    });

    const result = await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'auto', inlineCapBytes: 1 } }),
      makePeerInfo(),
      deps,
    );

    expect(result.status).toBe('completed');
    expect(publishToIpfs).toHaveBeenCalledOnce();

    expect(transport._calls).toHaveLength(1);
    const payload = transport._calls[0].payload as UxfTransferPayloadCid;
    expect(payload.kind).toBe('uxf-cid');

    const statuses = transition.mock.calls.map(
      (c) => (c[1] as OutboxTransitionPatch).status,
    );
    expect(statuses).toEqual(['pinned', 'sending', 'delivered']);
  });

  ifAutoCid('large multi-token bundle (>RELAY_SAFE_CAP_BYTES) auto-routes to CID with default delivery', async () => {
    // Build a multi-token bundle that exceeds the default
    // RELAY_SAFE_CAP_BYTES inline cap. Issue #394 raised this default
    // from 16 KiB to 96 KiB; issue #394b raised it again to 512 KiB
    // (today's Nostr relays comfortably carry up to ~1 MiB; 512 KiB
    // is the half-of-1-MiB safety budget). Each TOKEN_A serializes to
    // roughly ~0.9 KiB post-CAR; 640 distinct copies (~576 KiB)
    // cleanly clears the 512 KiB cap.
    const N = 640;
    const sources = Array.from({ length: N }, (_, i) => makeToken(`tok-${i}`, TOKEN_A));
    const commitResults = sources.map((s, i) =>
      makeCommitResult({
        sourceTokenId: s.id,
        fixture: TOKEN_A,
        rewriteTokenId: i.toString(16).padStart(64, '0'),
      }),
    );
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockResolvedValue({ cid: 'bafylargebundlev1example' });

    const { deps, transport } = makeDeps({
      availableSources: () => sources,
      selectSources: async () => sources,
      commitSources: async () => commitResults,
      publishToIpfs,
    });

    // Default delivery (no `delivery` field) → strategy = { kind: 'auto' }
    // → auto-route picks CID because the bundle CAR > RELAY_SAFE_CAP_BYTES.
    await sendConservativeUxf(
      basicRequest({ amount: (1_000_000 * N).toString() }),
      makePeerInfo(),
      deps,
    );

    expect(publishToIpfs).toHaveBeenCalledOnce();
    expect(transport._calls).toHaveLength(1);
    const payload = transport._calls[0].payload as UxfTransferPayloadCid;
    expect(payload.kind).toBe('uxf-cid');
    // Verify the published CAR genuinely exceeded 512 KiB (regression
    // gate against future fixture shrinkage that would silently route
    // through the inline branch under the post-#394b RELAY_SAFE_CAP_BYTES
    // cap).
    const carBytesArg = publishToIpfs.mock.calls[0][0];
    expect(carBytesArg.byteLength).toBeGreaterThan(512 * 1024);
  });
});

// =============================================================================
// 4. Pin failure — outbox `pinned → failed-permanent`, no Nostr publish
// =============================================================================

describe('sendConservativeUxf CID — pin failure path (T.4.A invariant)', () => {
  it('transitions pinned → failed-permanent and NEVER publishes to Nostr', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const pinError = new Error('pin failed: out of disk');
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockRejectedValue(pinError);

    const create = vi.fn().mockResolvedValue(undefined);
    const transition = vi.fn().mockResolvedValue(undefined);

    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      publishToIpfs,
      outbox: { create, transition },
    });

    let caught: unknown;
    try {
      await sendConservativeUxf(
        basicRequest({ delivery: { kind: 'force-cid' } }),
        makePeerInfo(),
        deps,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(pinError);

    // Outbox lifecycle on pin failure: packaging → pinned → failed-permanent.
    expect(create).toHaveBeenCalledOnce();
    const statuses = transition.mock.calls.map(
      (c) => (c[1] as OutboxTransitionPatch).status,
    );
    expect(statuses).toEqual(['pinned', 'failed-permanent']);

    // The failed-permanent patch carries the underlying pin error
    // message for forensic preservation.
    const lastPatch = transition.mock.calls[1][1] as OutboxTransitionPatch;
    expect(lastPatch.error).toContain('out of disk');

    // §3.3.2 INVARIANT — Nostr publish MUST NOT happen on pin failure.
    expect(transport._calls).toHaveLength(0);
    expect(transport.sendTokenTransfer).not.toHaveBeenCalled();
  });

  it('emits transfer:failed and re-throws the pin error verbatim', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    // A SphereError flavour to exercise the structured error path.
    const pinError = new SphereError(
      'IPFS gateway unavailable',
      'NETWORK_ERROR',
    );
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockRejectedValue(pinError);

    const { deps, events } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      publishToIpfs,
      outbox: { create: vi.fn(), transition: vi.fn() },
    });

    let caught: unknown;
    try {
      await sendConservativeUxf(
        basicRequest({ delivery: { kind: 'force-cid' } }),
        makePeerInfo(),
        deps,
      );
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) {
      throw new Error(`expected SphereError; got ${String(caught)}`);
    }
    expect(caught.code).toBe('NETWORK_ERROR');

    // transfer:failed emitted exactly once with the orchestrator's
    // result envelope.
    const failed = events.filter((e) => e.type === 'transfer:failed');
    expect(failed).toHaveLength(1);
  });

  it('integration: real OutboxWriter records pinned → failed-permanent on disk', async () => {
    // Wires the real OutboxWriter (T.6.A) so the §7.0 state-machine
    // validator (T.6.C) gates every transition. Confirms the new
    // `pinned → failed-permanent` arc is accepted end-to-end.
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const pinError = new Error('pin failed: gateway timeout');
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockRejectedValue(pinError);

    const { hooks, writer } = makeWriterBackedHooks('DIRECT_aabbcc_ddeeff');

    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      publishToIpfs,
      outbox: hooks,
    });

    let caught: unknown;
    try {
      await sendConservativeUxf(
        basicRequest({ delivery: { kind: 'force-cid' }, memo: 'pin-failure' }),
        makePeerInfo(),
        deps,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();

    // The orchestrator returns `transferId` in the result envelope
    // before the throw; we don't have it here so we read all entries
    // off disk — exactly one was created by this test run.
    const entries = await writer.readAll();
    expect(entries).toHaveLength(1);
    const persisted = entries[0];
    if (persisted.shape !== 'uxf-1') {
      throw new Error('expected uxf-1 shape on disk');
    }
    expect(persisted.entry.status).toBe('failed-permanent');
    expect(persisted.entry.deliveryMethod).toBe('cid-over-nostr');

    // Nostr publish never fired.
    expect(transport._calls).toHaveLength(0);
  });
});

// =============================================================================
// 5. senderGateways hint — wire payload exposure
// =============================================================================

describe('sendConservativeUxf CID — senderGateways hint', () => {
  it('stamps configured senderGateways onto the uxf-cid envelope', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockResolvedValue({ cid: 'bafygwhintv1example' });

    const gateways = [
      'https://ipfs.example.com',
      'https://w3s.link',
      'http://127.0.0.1:8080',
    ] as const;

    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      publishToIpfs,
      senderGateways: gateways,
    });

    await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );

    expect(transport._calls).toHaveLength(1);
    const payload = transport._calls[0].payload as UxfTransferPayloadCid;
    expect(payload.kind).toBe('uxf-cid');
    expect(payload.senderGateways).toEqual([...gateways]);
  });

  it('omits senderGateways when no list is configured', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockResolvedValue({ cid: 'bafynogwhint' });

    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      publishToIpfs,
      // senderGateways intentionally omitted.
    });

    await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );

    const payload = transport._calls[0].payload as UxfTransferPayloadCid;
    expect(payload.senderGateways).toBeUndefined();
  });

  it('omits senderGateways when configured list is empty', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockResolvedValue({ cid: 'bafyemptyhintv1' });

    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      publishToIpfs,
      senderGateways: [],
    });

    await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );

    const payload = transport._calls[0].payload as UxfTransferPayloadCid;
    expect(payload.senderGateways).toBeUndefined();
  });

  it('inline (uxf-car) payload never carries senderGateways', async () => {
    // Sanity check — even if the deps include a senderGateways hint,
    // the field is part of the `uxf-cid` shape only; inline deliveries
    // ignore it entirely.
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });

    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      senderGateways: ['https://ipfs.example.com'],
      // No publishToIpfs → forced into inline branch via default delivery.
    });

    await sendConservativeUxf(basicRequest(), makePeerInfo(), deps);

    expect(transport._calls).toHaveLength(1);
    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    expect(payload.kind).toBe('uxf-car');
    expect(
      (payload as unknown as { senderGateways?: unknown }).senderGateways,
    ).toBeUndefined();
  });
});

// =============================================================================
// 6. Pin idempotency — repeated calls with same CAR yield same CID
// =============================================================================

describe('sendConservativeUxf CID — pin idempotency', () => {
  it('two sends with the same bundle yield the same CID without state corruption', async () => {
    // The orchestrator dispatches one pin per `send()` call. Repeated
    // sends of the SAME bundle MUST be safe — the IPFS layer treats
    // pinning an already-pinned CID as a no-op (Kubo's `?pin=true`
    // and Helia's `pinning.add` are both idempotent at the HTTP API).
    // Our `publishToIpfs` callback wraps that idempotency; here we
    // simulate it by returning the same CID for both calls and
    // asserting the orchestrator does not bail out, leak state, or
    // double-publish.
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });

    const sharedCid = 'bafyidempotentcidv1example';
    const seenCarBytes: Uint8Array[] = [];
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockImplementation(async (carBytes: Uint8Array) => {
        seenCarBytes.push(carBytes);
        // Deterministic same-CID return for the same content — mirrors
        // the IPFS layer's content-addressing guarantee.
        return { cid: sharedCid };
      });

    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      publishToIpfs,
    });

    // First send — pin called once.
    const r1 = await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );
    // Second send — pin called again (same CAR, same CID).
    const r2 = await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );

    expect(r1.status).toBe('completed');
    expect(r2.status).toBe('completed');
    expect(publishToIpfs).toHaveBeenCalledTimes(2);

    // Same content → same `bundleCid` on both sends (the wire payload's
    // `bundleCid` is derived from the CAR root via `extractCarRootCid`,
    // not the publisher's return value — content-addressing guarantees
    // determinism). The publisher's CID return value is consumed
    // internally by `resolveDelivery` for verification but is NOT what
    // travels on the wire.
    const p1 = transport._calls[0].payload as UxfTransferPayloadCid;
    const p2 = transport._calls[1].payload as UxfTransferPayloadCid;
    expect(p1.bundleCid).toBe(p2.bundleCid);
    expect(p1.bundleCid.length).toBeGreaterThan(0);

    // The recipient and tokenIds repeat too — the test guards against
    // accidental orchestrator state mutation between calls.
    expect(p1.tokenIds).toEqual(p2.tokenIds);

    // CAR bytes presented to the publisher are byte-identical (the
    // `tokenId`-rewrites and lex-min ordering guarantee determinism).
    expect(seenCarBytes).toHaveLength(2);
    expect(seenCarBytes[0]).toEqual(seenCarBytes[1]);
  });
});

// =============================================================================
// 7. Pre-publish ordering invariant — pin succeeds → publish; pin fails → no publish
// =============================================================================

describe('sendConservativeUxf CID — pin / publish ordering invariant', () => {
  it('successful pin → outbox sending → Nostr publish (transition:sending strictly precedes send)', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commit = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const publishToIpfs = vi
      .fn<PublishToIpfsCallback>()
      .mockResolvedValue({ cid: 'bafyorderv1' });

    const order: string[] = [];
    const create = vi.fn().mockImplementation(async () => {
      order.push('create');
    });
    const transition = vi
      .fn()
      .mockImplementation(async (_id: string, patch: OutboxTransitionPatch) => {
        order.push(`transition:${patch.status}`);
      });
    const wrappedPublishToIpfs: PublishToIpfsCallback = async (carBytes) => {
      order.push('pin');
      return await publishToIpfs(carBytes);
    };

    const transport = makeTransportStub();
    const origSend = transport.sendTokenTransfer;
    transport.sendTokenTransfer = vi
      .fn()
      .mockImplementation(async (recipient: string, payload: unknown) => {
        order.push('send');
        return await origSend(recipient, payload);
      }) as MockTransport['sendTokenTransfer'];

    const { deps } = makeDeps({
      transport,
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commit],
      outbox: { create, transition },
      publishToIpfs: wrappedPublishToIpfs,
    });

    await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );

    // The eager `packaging → pinned` happens BEFORE the pin call so
    // a §7.0 arc is reachable on pin failure. The full happy-path
    // ordering is therefore:
    //   create → transition:pinned → pin → transition:sending → send → transition:delivered
    expect(order).toEqual([
      'create',
      'transition:pinned',
      'pin',
      'transition:sending',
      'send',
      'transition:delivered',
    ]);
  });
});
