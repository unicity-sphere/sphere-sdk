/**
 * Tests for `modules/payments/transfer/conservative-sender.ts` outbox
 * integration (T.2.D.2).
 *
 * T.2.D.1 (#46fc2b5) shipped the orchestrator with a STUB outbox writer
 * that emitted a synthetic legacy {@link OutboxEntry}. T.2.D.2 replaces
 * the stub with the real per-entry-key {@link UxfTransferOutboxEntry}
 * writer. This file gates the contract:
 *
 *  - **Schema** — outbox entry persists `recipientNametag`,
 *    `bundleCid`, `mode: 'conservative'`, and the correct
 *    `deliveryMethod` ('car-over-nostr' | 'cid-over-nostr').
 *  - **Lifecycle** — status transitions follow §7.0 in order:
 *      inline:   packaging → sending → delivered
 *      cid:      packaging → pinned  → sending → delivered
 *  - **Pre-publish persistence ordering (§6.3 last paragraph)** — the
 *    OrbitDB write that sets status='sending' MUST be committed BEFORE
 *    the Nostr publish is dispatched. We assert this with a call-order
 *    spy across the outbox.transition mock and the
 *    transport.sendTokenTransfer mock.
 *  - **Failure** — transport throw arrows the entry through
 *    sending → failed-transient.
 *  - **State-machine integration** — wiring through the real
 *    {@link OutboxWriter} causes illegal transitions to throw
 *    `INVALID_OUTBOX_TRANSITION` via the T.6.C validator.
 *
 * Spec references:
 *  - §6.3 last paragraph (pre-publish persistence ordering)
 *  - §7.0 (status transition table)
 *  - T.2.D.2 acceptance (impl plan)
 */

import { describe, expect, it, vi } from 'vitest';
import { AUTOMATED_CID_DELIVERY_ENABLED } from '../../../../modules/payments/transfer/limits';
// Issue #393 — gate auto-CID-promotion tests on the kill-switch.
const ifAutoCid = AUTOMATED_CID_DELIVERY_ENABLED ? it : it.skip;

import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
  type OutboxCreateInput,
  type OutboxIntegrationHooks,
  type OutboxTransitionPatch,
} from '../../../../modules/payments/transfer/conservative-sender';
import type { PreflightFinalizeOptions } from '../../../../modules/payments/transfer/preflight-finalize';
import type { TokenLike } from '../../../../modules/payments/transfer/classify-token';
import type { PublishToIpfsCallback } from '../../../../modules/payments/transfer/delivery-resolver';
import { isSphereError } from '../../../../core/errors';
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
import {
  isUxfTransferOutboxEntry,
  type UxfTransferOutboxEntry,
} from '../../../../types/uxf-outbox';
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
    sendTokenTransfer: vi.fn().mockImplementation(async (recipient: string, payload: unknown) => {
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
    l1Address: 'alpha1mock',
    directAddress: 'DIRECT://mock-direct',
    privateKey: '01'.repeat(32),
  };
}

function makePeerInfo(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    transportPubkey: '02bbbb'.padEnd(64, 'b'),
    chainPubkey: '02cccc'.padEnd(66, 'c'),
    l1Address: 'alpha1bob',
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

// =============================================================================
// 2. In-memory ProfileDatabase — for OutboxWriter integration tests
// =============================================================================

/**
 * Minimal in-memory {@link ProfileDatabase} sufficient for the
 * OutboxWriter's surface area (`put`/`get`/`del`/`all`). Keeps the tests
 * decoupled from OrbitDB / Helia.
 */
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

/**
 * Build an {@link OutboxIntegrationHooks} surface backed by a real
 * {@link OutboxWriter} so the §7.0 state-machine validator (T.6.C)
 * gates every transition.
 */
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
    create: async (entry: OutboxCreateInput) => {
      await writer.write(entry);
    },
    transition: async (id: string, patch: OutboxTransitionPatch) => {
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
// 3. Schema & lifecycle — inline (CAR) delivery
// =============================================================================

describe('sendConservativeUxf outbox integration — inline delivery', () => {
  it('creates entry with packaging status carrying all required fields', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });

    const create = vi.fn().mockResolvedValue(undefined);
    const transition = vi.fn().mockResolvedValue(undefined);

    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      outbox: { create, transition },
    });

    await sendConservativeUxf(
      basicRequest({ memo: 'coffee' }),
      makePeerInfo(),
      deps,
    );

    expect(create).toHaveBeenCalledOnce();
    const created = create.mock.calls[0][0] as OutboxCreateInput;

    // Acceptance — required fields persisted on create.
    expect(created.id).toMatch(/[0-9a-f-]{36}/i); // UUID
    expect(created.status).toBe('packaging');
    expect(created.mode).toBe('conservative');
    expect(created.deliveryMethod).toBe('car-over-nostr');
    expect(typeof created.bundleCid).toBe('string');
    expect(created.bundleCid.length).toBeGreaterThan(0);
    // Loop4-e2e (round 2) — tokenIds is the recipient's genesis
    // tokenId (TOKEN_A's canonical 'aa00...0001'), NOT the
    // sender-local sourceTokenId.
    expect(created.tokenIds).toEqual([
      'aa00000000000000000000000000000000000000000000000000000000000001',
    ]);
    expect(created.recipient).toBe('@bob');
    expect(created.recipientTransportPubkey).toBe(makePeerInfo().transportPubkey);
    expect(created.recipientNametag).toBe('bob');  // W18 — preserved from PeerInfo
    expect(created.memo).toBe('coffee');
    expect(created.submitRetryCount).toBe(0);
    expect(created.proofErrorCount).toBe(0);
  });

  it('transitions packaging → sending → delivered (no pinned for inline)', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });

    const create = vi.fn().mockResolvedValue(undefined);
    const transition = vi.fn().mockResolvedValue(undefined);

    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      outbox: { create, transition },
    });

    await sendConservativeUxf(basicRequest(), makePeerInfo(), deps);

    expect(create).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledTimes(2);
    expect((transition.mock.calls[0][1] as OutboxTransitionPatch).status).toBe('sending');
    expect((transition.mock.calls[1][1] as OutboxTransitionPatch).status).toBe('delivered');
    // No 'pinned' transition for inline delivery.
    const statuses = transition.mock.calls.map((c) => (c[1] as OutboxTransitionPatch).status);
    expect(statuses).not.toContain('pinned');
  });
});

// =============================================================================
// 4. Schema & lifecycle — CID delivery
// =============================================================================

describe('sendConservativeUxf outbox integration — CID delivery', () => {
  it('creates entry with deliveryMethod=cid-over-nostr and transitions through pinned', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const publishToIpfs = vi.fn<PublishToIpfsCallback>().mockResolvedValue({
      cid: 'bafyfakemockcidv1example',
    });

    const create = vi.fn().mockResolvedValue(undefined);
    const transition = vi.fn().mockResolvedValue(undefined);

    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      outbox: { create, transition },
      publishToIpfs,
    });

    await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );

    const created = create.mock.calls[0][0] as OutboxCreateInput;
    expect(created.deliveryMethod).toBe('cid-over-nostr');

    // packaging → pinned → sending → delivered
    expect(transition).toHaveBeenCalledTimes(3);
    const statuses = transition.mock.calls.map((c) => (c[1] as OutboxTransitionPatch).status);
    expect(statuses).toEqual(['pinned', 'sending', 'delivered']);
  });

  ifAutoCid('CID delivery via auto-mode-over-cap also goes through pinned', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const publishToIpfs = vi.fn<PublishToIpfsCallback>().mockResolvedValue({
      cid: 'bafyfakemockcidv1example',
    });

    const create = vi.fn().mockResolvedValue(undefined);
    const transition = vi.fn().mockResolvedValue(undefined);

    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      outbox: { create, transition },
      publishToIpfs,
    });

    await sendConservativeUxf(
      // 1-byte cap forces auto → CID for any non-empty bundle.
      basicRequest({ delivery: { kind: 'auto', inlineCapBytes: 1 } }),
      makePeerInfo(),
      deps,
    );

    const created = create.mock.calls[0][0] as OutboxCreateInput;
    expect(created.deliveryMethod).toBe('cid-over-nostr');
    const statuses = transition.mock.calls.map((c) => (c[1] as OutboxTransitionPatch).status);
    expect(statuses).toEqual(['pinned', 'sending', 'delivered']);
  });
});

// =============================================================================
// 5. Pre-publish persistence ordering — §6.3 last paragraph (INVARIANT)
// =============================================================================

describe('sendConservativeUxf outbox integration — pre-publish ordering invariant', () => {
  it('commits status=sending BEFORE transport.sendTokenTransfer is invoked', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });

    // Single shared call-order log: every event from outbox + transport
    // appended in the exact order they fire. The invariant is captured
    // by the relative position of 'transition:sending' vs 'send'.
    const order: string[] = [];

    const create = vi.fn().mockImplementation(async () => {
      order.push('create');
    });
    const transition = vi
      .fn()
      .mockImplementation(async (_id: string, patch: OutboxTransitionPatch) => {
        order.push(`transition:${patch.status}`);
      });

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
      commitSources: async () => [commitResult],
      outbox: { create, transition },
    });

    await sendConservativeUxf(basicRequest(), makePeerInfo(), deps);

    // The invariant: 'transition:sending' appears in the log STRICTLY
    // BEFORE 'send'. This is the §6.3 ordering rule.
    const sendIdx = order.indexOf('send');
    const sendingIdx = order.indexOf('transition:sending');
    expect(sendIdx).toBeGreaterThan(-1);
    expect(sendingIdx).toBeGreaterThan(-1);
    expect(sendingIdx).toBeLessThan(sendIdx);

    // Full order matches the §7.0 happy path for inline delivery.
    expect(order).toEqual([
      'create',
      'transition:sending',
      'send',
      'transition:delivered',
    ]);
  });

  it('CID delivery still respects ordering: pinned → sending happens BEFORE send', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });
    const publishToIpfs = vi.fn<PublishToIpfsCallback>().mockResolvedValue({
      cid: 'bafyfakemockcidv1example',
    });

    const order: string[] = [];
    const create = vi.fn().mockImplementation(async () => {
      order.push('create');
    });
    const transition = vi
      .fn()
      .mockImplementation(async (_id: string, patch: OutboxTransitionPatch) => {
        order.push(`transition:${patch.status}`);
      });

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
      commitSources: async () => [commitResult],
      outbox: { create, transition },
      publishToIpfs,
    });

    await sendConservativeUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );

    const sendIdx = order.indexOf('send');
    const sendingIdx = order.indexOf('transition:sending');
    expect(sendingIdx).toBeLessThan(sendIdx);

    expect(order).toEqual([
      'create',
      'transition:pinned',
      'transition:sending',
      'send',
      'transition:delivered',
    ]);
  });
});

// =============================================================================
// 6. Failure path — transport rejection → failed-transient
// =============================================================================

describe('sendConservativeUxf outbox integration — transport error path', () => {
  it('transitions sending → failed-transient on transport throw', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });

    const create = vi.fn().mockResolvedValue(undefined);
    const transition = vi.fn().mockResolvedValue(undefined);

    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      outbox: { create, transition },
    });
    transport._failNextSendWith = new Error('relay rejected: network down');

    let caught: unknown;
    try {
      await sendConservativeUxf(basicRequest(), makePeerInfo(), deps);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) {
      throw new Error(`expected SphereError; got ${String(caught)}`);
    }
    expect(caught.code).toBe('TRANSPORT_ERROR');

    // Sequence: packaging → sending (pre-publish) → failed-transient (post-error).
    // No 'delivered' transition because the publish itself threw.
    const statuses = transition.mock.calls.map((c) => (c[1] as OutboxTransitionPatch).status);
    expect(statuses).toEqual(['sending', 'failed-transient']);

    // The failed-transient patch carries the underlying transport error
    // message for forensic preservation.
    const lastPatch = transition.mock.calls[1][1] as OutboxTransitionPatch;
    expect(lastPatch.error).toContain('relay rejected');
  });
});

// =============================================================================
// 7. Real OutboxWriter integration — state-machine validator gates writes
// =============================================================================

describe('sendConservativeUxf outbox integration — real OutboxWriter (T.6.A) wiring', () => {
  it('persists a valid UxfTransferOutboxEntry through the full happy path', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({ sourceTokenId: 'tok-1', fixture: TOKEN_A });

    const { hooks, writer } = makeWriterBackedHooks('DIRECT_aabbcc_ddeeff');

    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      outbox: hooks,
    });

    const result = await sendConservativeUxf(
      basicRequest({ memo: 'invoice 123' }),
      makePeerInfo(),
      deps,
    );

    // Final entry on disk has status='delivered' and validates against
    // the runtime guard (proves §7.0 invariants held end-to-end).
    const persisted = await writer.readOne(result.id);
    expect(persisted).not.toBeNull();
    if (!persisted || persisted.shape !== 'uxf-1') {
      throw new Error('expected uxf-1 entry on disk');
    }
    const entry: UxfTransferOutboxEntry = persisted.entry;
    expect(isUxfTransferOutboxEntry(entry)).toBe(true);
    expect(entry.status).toBe('delivered');
    expect(entry.mode).toBe('conservative');
    expect(entry.deliveryMethod).toBe('car-over-nostr');
    expect(entry.recipientNametag).toBe('bob');
    expect(entry.recipient).toBe('@bob');
    // Loop4-e2e (round 2) — tokenIds is the recipient's genesis
    // tokenId (TOKEN_A's canonical 'aa00...0001').
    expect(entry.tokenIds).toEqual([
      'aa00000000000000000000000000000000000000000000000000000000000001',
    ]);
    expect(entry.bundleCid.length).toBeGreaterThan(0);
    expect(entry.memo).toBe('invoice 123');
    // Lamport bumped through the lifecycle: create + 3 updates (sending,
    // delivered for inline; the transitions all bump). 1 + 2 = 3 writes
    // → lamport >= 3 (allow growth from race-internal observed remotes).
    expect(entry.lamport).toBeGreaterThanOrEqual(3);
    expect(entry._schemaVersion).toBe('uxf-1');
  });

  it('rejects illegal transitions via the §7.0 validator (T.6.C integration)', async () => {
    // Writer-backed hooks expose the `update()` validator. We craft a
    // hooks surface that invokes an ILLEGAL transition (delivered →
    // packaging) and confirm the validator throws.
    const { writer, hooks } = makeWriterBackedHooks('DIRECT_aabbcc_ddeeff');

    // Seed an entry at status='delivered'. We do this via the writer's
    // own write() (no validator on raw write), then attempt an illegal
    // transition via the orchestrator-shaped hooks.update().
    await writer.write({
      id: 'fake-id',
      bundleCid: 'bafyfake',
      tokenIds: ['tok-1'],
      deliveryMethod: 'car-over-nostr',
      recipient: '@bob',
      recipientTransportPubkey: '02bbbb'.padEnd(64, 'b'),
      mode: 'conservative',
      status: 'delivered',
      createdAt: 0,
      updatedAt: 0,
      submitRetryCount: 0,
      proofErrorCount: 0,
    });

    let caught: unknown;
    try {
      await hooks.transition('fake-id', { status: 'packaging' });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) {
      throw new Error(`expected SphereError; got ${String(caught)}`);
    }
    expect(caught.code).toBe('INVALID_OUTBOX_TRANSITION');
  });
});
