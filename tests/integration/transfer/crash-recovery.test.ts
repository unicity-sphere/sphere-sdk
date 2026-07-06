/**
 * Integration test: pre-publish persistence ordering + crash recovery
 * (T.6.E).
 *
 * **Goal**: deterministically prove the §6.3 last-paragraph + §7.0 crash-
 * recovery contract. The senders MUST commit the outbox transition into
 * `'sending'` (or `'delivered-instant'`) BEFORE dispatching the Nostr
 * publish; a crash in that window MUST leave the entry in `'sending'`
 * (so the worker re-publishes on restart) and the re-publish MUST be
 * idempotent at the recipient (same content-addressed `bundleCid`).
 *
 * **Why integration, not unit**: the contract spans three subsystems —
 * the orchestrator, the {@link OutboxWriter} (T.6.A) backed by a real
 * {@link ProfileDatabase}-shaped store, and a transport recorder — and
 * the test asserts on durable state visible to a *fresh* sender
 * instance that re-opens the same store ("restart"). Unit tests already
 * cover the per-method ordering invariant via call-order spies; this
 * harness covers the full crash → restart → resume cycle.
 *
 * **No sleeps, no real SIGKILLs**: the senders expose a `__faultInject`
 * test seam (gated to test usage by the `__` prefix) that fires hooks
 * at the §6.3-mandated checkpoints. Throwing in a hook simulates
 * process death exactly at that boundary; the orchestrator's existing
 * try/catch surfaces the throw via `transfer:failed` and the
 * outer-most `await sendXxxUxf(...)` rejects. The test then constructs
 * a *new* deps object pointing at the SAME persistent store and
 * exercises the worker-style resume path by issuing a second send with
 * a forced-equal `transferId` and verifies the bundleCid matches.
 *
 * Test matrix:
 *   1. **Conservative — crash between outbox commit and Nostr publish.**
 *      Throw in `afterOutboxCommitSending`. After the throw:
 *        - persisted entry status === 'sending' (durable record).
 *        - transport recorded ZERO publish attempts.
 *      Resume by calling sendConservativeUxf again with the same
 *      `transferId` AND the same source token; verify:
 *        - bundleCid is byte-identical to the (would-be) first send.
 *        - transport recorded EXACTLY ONE publish attempt.
 *        - final entry status === 'delivered'.
 *
 *   2. **Conservative — crash between Nostr ack and outbox commit.**
 *      Throw in `afterTransportAck`. After the throw:
 *        - persisted entry status === 'sending' (NOT 'delivered'). The
 *          ack landed but the durability anchor did not.
 *        - transport recorded EXACTLY ONE publish attempt (the original).
 *      Resume by re-issuing the same send. The test models the
 *      worker-style resume path: the recipient deduplicates via the
 *      replay-LRU (T.3.A) on the bundleCid; the local outbox
 *      eventually reaches 'delivered'.
 *
 *   3. **Instant — crash between outbox commit and Nostr publish.**
 *      Same shape as test 1, but for the instant orchestrator. Status
 *      transitions are `packaging → sending → delivered-instant`; the
 *      crash leaves the entry at `sending`.
 *
 * Spec references:
 *  - §6.3 last paragraph (pre-publish persistence ordering)
 *  - §7.0 (status transition table)
 *  - T.6.E acceptance (impl plan)
 *
 * @packageDocumentation
 */

import { describe, expect, it, vi } from 'vitest';

import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
  type OutboxCreateInput,
  type OutboxIntegrationHooks,
  type OutboxTransitionPatch,
} from '../../../extensions/uxf/pipeline/conservative-sender';
import {
  sendInstantUxf,
  type InstantCommitResult,
  type InstantOutboxHooks,
  type InstantSenderDeps,
} from '../../../extensions/uxf/pipeline/instant-sender';
import type { TokenLike } from '../../../extensions/uxf/pipeline/classify-token';
import type { PreflightFinalizeOptions } from '../../../extensions/uxf/pipeline/preflight-finalize';
import { isSphereError } from '../../../core/errors';
import { Lamport } from '../../../extensions/uxf/profile/lamport';
import { OutboxWriter } from '../../../extensions/uxf/profile/outbox-writer';
import type { ProfileDatabase } from '../../../extensions/uxf/profile/types';
import type { OracleProvider } from '../../../oracle/oracle-provider';
import type { TransportProvider } from '../../../transport';
import type { PeerInfo } from '../../../transport/transport-provider';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
  TransferRequest,
} from '../../../types';
import type {
  UxfTransferOutboxEntry,
  UxfOutboxStatus,
} from '../../../types/uxf-outbox';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

// =============================================================================
// 1. Persistent in-memory ProfileDatabase — survives a "restart"
// =============================================================================

/**
 * Minimal in-memory {@link ProfileDatabase}. The same `Map` instance
 * MUST be shared across pre-crash and post-crash {@link OutboxWriter}
 * instances — that's how we model "the OrbitDB store is durable across
 * a process restart".
 */
function makeInMemoryProfileDb(
  store: Map<string, Uint8Array> = new Map(),
): ProfileDatabase {
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
 * Build conservative-sender outbox hooks backed by a real
 * {@link OutboxWriter}, which in turn talks to the supplied
 * {@link ProfileDatabase}. Every transition flows through the §7.0
 * state-machine validator (T.6.C).
 */
function makeConservativeHooks(
  db: ProfileDatabase,
  addressId: string,
): OutboxIntegrationHooks {
  const writer = new OutboxWriter({
    db,
    encryptionKey: null,
    addressId,
    lamport: new Lamport(0),
  });
  return {
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
}

/**
 * Build instant-sender outbox hooks. The instant sender writes the full
 * record on every status transition (no `update`-shaped surface) — but
 * we still want the §7.0 validator gating, so we tunnel through the
 * writer's {@link OutboxWriter.update} when the entry already exists.
 */
function makeInstantHooks(
  db: ProfileDatabase,
  addressId: string,
): { readonly hooks: InstantOutboxHooks; readonly writer: OutboxWriter } {
  const writer = new OutboxWriter({
    db,
    encryptionKey: null,
    addressId,
    lamport: new Lamport(0),
  });
  const hooks: InstantOutboxHooks = {
    write: async (entry) => {
      const existing = await writer.readOne(entry.id);
      if (existing === null || existing.shape !== 'uxf-1') {
        await writer.write(entry);
      } else {
        // Funnel through the validated update path so illegal
        // transitions throw — the instant sender always feeds a fresh
        // record but the change set is the new status.
        await writer.update(entry.id, () => ({
          ...entry,
          _schemaVersion: 'uxf-1',
          lamport: existing.entry.lamport,
        }));
      }
    },
  };
  return { hooks, writer };
}

// =============================================================================
// 2. Shared fixtures (parallel of the unit-test fixtures)
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

interface RecordingTransport extends TransportProvider {
  readonly _calls: Array<{ recipient: string; payload: unknown }>;
}

function makeRecordingTransport(): RecordingTransport {
  const calls: RecordingTransport['_calls'] = [];
  const stub: RecordingTransport = {
    _calls: calls,
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

function makePeerInfo(): PeerInfo {
  return {
    transportPubkey: '02bbbb'.padEnd(64, 'b'),
    chainPubkey: '02cccc'.padEnd(66, 'c'),
    directAddress: 'DIRECT://bob-direct',
    timestamp: 0,
    nametag: 'bob',
  };
}

function defaultTokenLikeForTest(token: Token): TokenLike {
  return {
    id: token.id,
    coins: [{ coinId: token.coinId, amount: BigInt(token.amount) }],
  };
}

function makeConservativeCommitResult(
  sourceTokenId: string,
  fixture: Record<string, unknown>,
): ConservativeCommitResult {
  return {
    sourceTokenId,
    method: 'direct',
    requestIdHex: `req-${sourceTokenId}`,
    recipientTokenJson: fixture,
  };
}

function makeInstantCommitResult(
  sourceTokenId: string,
  fixture: Record<string, unknown>,
): InstantCommitResult {
  return {
    sourceTokenId,
    method: 'direct',
    requestIdHex: `req-${sourceTokenId}`,
    recipientTokenJson: fixture,
    tokenClass: 'coin',
    splitParentTokenId: sourceTokenId,
  };
}

function basicConservativeRequest(): TransferRequest {
  return {
    recipient: '@bob',
    coinId: 'UCT',
    amount: '1000000',
    transferMode: 'conservative',
  };
}

function basicInstantRequest(): TransferRequest {
  return {
    recipient: '@bob',
    coinId: 'UCT',
    amount: '1000000',
    transferMode: 'instant',
  };
}

function readPersistedEntry(
  store: Map<string, Uint8Array>,
  addressId: string,
  id: string,
): UxfTransferOutboxEntry | null {
  const key = `${addressId}.outbox.${id}`;
  const raw = store.get(key);
  if (!raw) return null;
  const parsed = JSON.parse(new TextDecoder().decode(raw)) as
    | UxfTransferOutboxEntry
    | { tombstoned: true };
  if ('tombstoned' in parsed) return null;
  return parsed;
}

// Sentinel error used by the fault-injection hooks. Distinct enough
// that we can assert on it explicitly — guards against false-positives
// from unrelated thrown errors.
class SimulatedCrash extends Error {
  constructor(readonly stage: string) {
    super(`SIMULATED_CRASH at ${stage}`);
    this.name = 'SimulatedCrash';
  }
}

// =============================================================================
// 3. Test 1 — conservative crash between outbox 'sending' and Nostr publish
// =============================================================================

describe('T.6.E — conservative crash between outbox commit and Nostr publish', () => {
  it('persists status="sending" before transport, leaves no transport call on crash', async () => {
    const addressId = 'DIRECT_aabbcc_ddeeff';
    const store = new Map<string, Uint8Array>();
    const db = makeInMemoryProfileDb(store);
    const transport = makeRecordingTransport();
    const source = makeToken('tok-1', TOKEN_A);
    const transferId = 'tid-conservative-1';
    const events: Array<{ type: SphereEventType; data: unknown }> = [];
    const emit = <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
      events.push({ type, data });
    };

    const baseDeps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: '02bbbb'.padEnd(64, 'b'),
      emit,
      availableSources: () => [source],
      selectSources: async () => [source],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('resolveRequestId should not be invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => [makeConservativeCommitResult('tok-1', TOKEN_A)],
      outbox: makeConservativeHooks(db, addressId),
      toTokenLike: defaultTokenLikeForTest,
      transferId,
      __faultInject: {
        afterOutboxCommitSending: () => {
          throw new SimulatedCrash('after-outbox-commit-sending');
        },
      },
    };

    let caught: unknown;
    try {
      await sendConservativeUxf(basicConservativeRequest(), makePeerInfo(), baseDeps);
    } catch (err) {
      caught = err;
    }

    // Crash propagated; transfer:failed event fired.
    expect(caught).toBeInstanceOf(SimulatedCrash);
    expect(events.filter((e) => e.type === 'transfer:failed')).toHaveLength(1);

    // Acceptance — the outbox commit IS durable (status='sending').
    // Persisted `tokenIds` is the per-commit recipient genesis tokenId
    // (commit 718ab12 / #142 Loop4 — orchestrator advertises the
    // recipient's mint, not the source). For a direct (whole-token)
    // transfer of TOKEN_A the recipient preserves the source's tokenId
    // → TOKEN_A.genesis.data.tokenId.
    const tokenAGenesisId =
      'aa00000000000000000000000000000000000000000000000000000000000001';
    const persisted = readPersistedEntry(store, addressId, transferId);
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe<UxfOutboxStatus>('sending');
    expect(persisted!.bundleCid.length).toBeGreaterThan(0);
    expect(persisted!.tokenIds).toEqual([tokenAGenesisId]);

    // Acceptance — transport recorded ZERO publish attempts.
    expect(transport._calls).toHaveLength(0);

    // -------------- RESTART --------------
    // Same store, fresh sender deps, no fault-inject. Worker-style
    // resume: the same transferId + same inputs MUST yield the same
    // bundleCid (content-addressed idempotency) and exactly ONE
    // transport publish.
    const freshTransport = makeRecordingTransport();
    const resumeEvents: Array<{ type: SphereEventType; data: unknown }> = [];
    const resumeEmit = <T extends SphereEventType>(
      type: T,
      data: SphereEventMap[T],
    ): void => {
      resumeEvents.push({ type, data });
    };
    const resumeDeps: ConservativeSenderDeps = {
      ...baseDeps,
      transport: freshTransport,
      emit: resumeEmit,
      // bundleCid-determinism fix: replay the persisted createdAt so
      // the rebuilt bundle bytes match the original. Without this the
      // envelope's Math.floor(Date.now()/1000) drifts across seconds
      // and the assertion at line 516 flakes on slow CI runs.
      bundleCreatedAt: persisted!.createdAt,
      // The resume path uses the SAME outbox writer surface but a
      // fresh writer instance, mirroring a fresh Sphere process. The
      // store is shared — the writer reads the existing 'sending'
      // entry on first update.
      outbox: makeConservativeHooks(db, addressId),
      __faultInject: undefined,
      // The §7.0 validator forbids the re-create call (`packaging`
      // arc onto an existing 'sending' entry). The worker-style
      // resume re-issues the publish and the post-ack transition,
      // not the create. We simulate that by using a thin hooks
      // wrapper that no-ops `create` for the existing entry id.
    };
    const resumeHooks = resumeDeps.outbox!;
    const resumeOutbox: OutboxIntegrationHooks = {
      create: async (entry) => {
        const existing = readPersistedEntry(store, addressId, entry.id);
        if (existing !== null) {
          // Resume: the entry already exists at 'sending'. Skip the
          // re-create — the worker would not call it. The orchestrator
          // does call create on every send, so we suppress it here to
          // model the worker resume path.
          return;
        }
        await resumeHooks.create(entry);
      },
      transition: async (id, patch) => {
        // 'sending → sending' is a self-loop (validator skips it). The
        // orchestrator transitions packaging → sending; on resume,
        // the entry is already at 'sending' so this is a no-op pass.
        const existing = readPersistedEntry(store, addressId, id);
        if (
          existing !== null &&
          existing.status === 'sending' &&
          patch.status === 'sending'
        ) {
          return;
        }
        await resumeHooks.transition(id, patch);
      },
    };
    const resumeDepsFinal: ConservativeSenderDeps = {
      ...resumeDeps,
      outbox: resumeOutbox,
    };

    const resumeResult = await sendConservativeUxf(
      basicConservativeRequest(),
      makePeerInfo(),
      resumeDepsFinal,
    );

    // Acceptance — exactly ONE publish on resume; bundleCid byte-equal
    // to the persisted (crash-time) bundleCid.
    expect(freshTransport._calls).toHaveLength(1);
    expect(resumeResult.id).toBe(transferId);
    const finalEntry = readPersistedEntry(store, addressId, transferId);
    expect(finalEntry).not.toBeNull();
    expect(finalEntry!.status).toBe<UxfOutboxStatus>('delivered');
    // Same bundleCid → same content-addressed payload → idempotent at
    // the recipient. The pre-crash and post-crash CIDs MUST match.
    expect(finalEntry!.bundleCid).toBe(persisted!.bundleCid);
  });
});

// =============================================================================
// 4. Test 2 — conservative crash between Nostr ack and outbox 'delivered'
// =============================================================================

describe('T.6.E — conservative crash between Nostr ack and outbox commit', () => {
  it('leaves status="sending" (NOT "delivered") after ack-then-crash; replay-LRU dedupes recipient', async () => {
    const addressId = 'DIRECT_aabbcc_ddeeff';
    const store = new Map<string, Uint8Array>();
    const db = makeInMemoryProfileDb(store);
    const transport = makeRecordingTransport();
    const source = makeToken('tok-1', TOKEN_A);
    const transferId = 'tid-conservative-2';

    const baseDeps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: '02bbbb'.padEnd(64, 'b'),
      emit: vi.fn(),
      availableSources: () => [source],
      selectSources: async () => [source],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('resolveRequestId should not be invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => [makeConservativeCommitResult('tok-1', TOKEN_A)],
      outbox: makeConservativeHooks(db, addressId),
      toTokenLike: defaultTokenLikeForTest,
      transferId,
      __faultInject: {
        afterTransportAck: () => {
          throw new SimulatedCrash('after-transport-ack');
        },
      },
    };

    let caught: unknown;
    try {
      await sendConservativeUxf(basicConservativeRequest(), makePeerInfo(), baseDeps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SimulatedCrash);

    // Acceptance — transport DID publish (one call), but the outbox
    // is still at 'sending' because the post-ack 'delivered'
    // transition never ran. The 'delivered' anchor is the durability
    // anchor; this is the §6.3 contract.
    expect(transport._calls).toHaveLength(1);
    const persistedAfterCrash = readPersistedEntry(store, addressId, transferId);
    expect(persistedAfterCrash).not.toBeNull();
    expect(persistedAfterCrash!.status).toBe<UxfOutboxStatus>('sending');

    // The acceptance contract says: "if ack was received but status
    // not yet committed, the next worker pass will commit". We model
    // that by re-issuing the same send. The recipient deduplicates
    // via the bundleCid (replay-LRU, T.3.A); locally, the outbox
    // converges to 'delivered'. We assert local convergence — the
    // recipient-side dedup is exercised by T.3.A's tests.
    const freshTransport = makeRecordingTransport();
    const resumeHooks = makeConservativeHooks(db, addressId);
    const resumeOutbox: OutboxIntegrationHooks = {
      create: async (entry) => {
        const existing = readPersistedEntry(store, addressId, entry.id);
        if (existing !== null) return; // resume — skip re-create
        await resumeHooks.create(entry);
      },
      transition: async (id, patch) => {
        const existing = readPersistedEntry(store, addressId, id);
        if (
          existing !== null &&
          existing.status === 'sending' &&
          patch.status === 'sending'
        ) {
          return; // self-loop — skip
        }
        await resumeHooks.transition(id, patch);
      },
    };
    const resumeDeps: ConservativeSenderDeps = {
      ...baseDeps,
      transport: freshTransport,
      emit: vi.fn(),
      // bundleCid-determinism fix: replay the persisted createdAt so
      // the bundle bytes (and CID) reproduce the original.
      bundleCreatedAt: persistedAfterCrash!.createdAt,
      outbox: resumeOutbox,
      __faultInject: undefined,
    };

    const resumeResult = await sendConservativeUxf(
      basicConservativeRequest(),
      makePeerInfo(),
      resumeDeps,
    );

    // Re-publish DOES happen on resume — the worker's job is to
    // unstick the 'sending' entry. The recipient-side dedup is the
    // responsibility of T.3.A's replay-LRU; same bundleCid → same
    // content-addressed payload → recipient ignores the second copy.
    expect(freshTransport._calls).toHaveLength(1);

    // The bundleCid on the resume publish MUST match the original.
    // We can't read the second-publish bundleCid from the recorder
    // (it's embedded in the wire payload), but the persisted outbox
    // entry's bundleCid is the canonical id, and it MUST be unchanged
    // by the resume path (same inputs → same hash).
    const finalEntry = readPersistedEntry(store, addressId, transferId);
    expect(finalEntry).not.toBeNull();
    expect(finalEntry!.status).toBe<UxfOutboxStatus>('delivered');
    expect(finalEntry!.bundleCid).toBe(persistedAfterCrash!.bundleCid);
    expect(resumeResult.id).toBe(transferId);
  });
});

// =============================================================================
// 5. Test 3 — instant crash between outbox commit and Nostr publish
// =============================================================================

describe('T.6.E — instant crash between outbox commit and Nostr publish', () => {
  it('persists status="sending" before transport; resume re-publishes same bundleCid', async () => {
    const addressId = 'DIRECT_aabbcc_ddeeff';
    const store = new Map<string, Uint8Array>();
    const db = makeInMemoryProfileDb(store);
    const transport = makeRecordingTransport();
    const source = makeToken('tok-1', TOKEN_A);
    const transferId = 'tid-instant-1';
    const { hooks: instantHooks } = makeInstantHooks(db, addressId);

    const baseDeps: InstantSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      addressId,
      senderTransportPubkey: '02bbbb'.padEnd(64, 'b'),
      emit: vi.fn(),
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [makeInstantCommitResult('tok-1', TOKEN_A)],
      outbox: instantHooks,
      toTokenLike: defaultTokenLikeForTest,
      transferId,
      __faultInject: {
        afterOutboxCommitSending: () => {
          throw new SimulatedCrash('after-outbox-commit-sending-instant');
        },
      },
    };

    let caught: unknown;
    try {
      await sendInstantUxf(basicInstantRequest(), makePeerInfo(), baseDeps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SimulatedCrash);

    const persisted = readPersistedEntry(store, addressId, transferId);
    expect(persisted).not.toBeNull();
    // §7.0 instant arc: packaging → sending → delivered-instant.
    // After the crash at afterOutboxCommitSending, status='sending'.
    expect(persisted!.status).toBe<UxfOutboxStatus>('sending');
    expect(persisted!.mode).toBe('instant');
    expect(transport._calls).toHaveLength(0);

    // -------------- RESTART --------------
    const freshTransport = makeRecordingTransport();
    const { hooks: resumeInstantHooks } = makeInstantHooks(db, addressId);
    const resumeDeps: InstantSenderDeps = {
      ...baseDeps,
      transport: freshTransport,
      emit: vi.fn(),
      // bundleCid-determinism fix: replay the persisted createdAt so
      // the rebuilt bundle reproduces the original.
      bundleCreatedAt: persisted!.createdAt,
      outbox: {
        write: async (entry) => {
          const existing = readPersistedEntry(store, addressId, entry.id);
          // Self-loop on 'sending → sending' is a no-op for the
          // validator. The instant orchestrator writes the full
          // record at every step; on resume, it'll re-write
          // 'packaging' first, which is illegal. We model the worker
          // resume path: only let the post-ack 'delivered-instant'
          // through; everything earlier is a no-op (the entry is
          // already past those states).
          if (
            existing !== null &&
            (entry.status === 'packaging' ||
              entry.status === 'sending' ||
              entry.status === 'pinned')
          ) {
            return;
          }
          await resumeInstantHooks.write(entry);
        },
      },
      __faultInject: undefined,
    };

    const resumeResult = await sendInstantUxf(
      basicInstantRequest(),
      makePeerInfo(),
      resumeDeps,
    );
    expect(resumeResult.id).toBe(transferId);
    expect(freshTransport._calls).toHaveLength(1);
    const finalEntry = readPersistedEntry(store, addressId, transferId);
    expect(finalEntry).not.toBeNull();
    expect(finalEntry!.status).toBe<UxfOutboxStatus>('delivered-instant');
    // Same bundleCid → idempotent at the recipient.
    expect(finalEntry!.bundleCid).toBe(persisted!.bundleCid);
  });
});

// =============================================================================
// 6. Sanity — without fault injection, the happy path still works end-to-end
// =============================================================================

describe('T.6.E — control: no fault injection produces a clean delivered entry', () => {
  it('conservative happy path: packaging → sending → delivered', async () => {
    const addressId = 'DIRECT_aabbcc_ddeeff';
    const store = new Map<string, Uint8Array>();
    const db = makeInMemoryProfileDb(store);
    const transport = makeRecordingTransport();
    const source = makeToken('tok-1', TOKEN_A);
    const transferId = 'tid-control-conservative';

    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: '02bbbb'.padEnd(64, 'b'),
      emit: vi.fn(),
      availableSources: () => [source],
      selectSources: async () => [source],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => [makeConservativeCommitResult('tok-1', TOKEN_A)],
      outbox: makeConservativeHooks(db, addressId),
      toTokenLike: defaultTokenLikeForTest,
      transferId,
    };

    const result = await sendConservativeUxf(
      basicConservativeRequest(),
      makePeerInfo(),
      deps,
    );
    if (isSphereError(result.error)) {
      throw new Error(`unexpected error: ${result.error}`);
    }

    expect(transport._calls).toHaveLength(1);
    const finalEntry = readPersistedEntry(store, addressId, transferId);
    expect(finalEntry).not.toBeNull();
    expect(finalEntry!.status).toBe<UxfOutboxStatus>('delivered');
  });
});
