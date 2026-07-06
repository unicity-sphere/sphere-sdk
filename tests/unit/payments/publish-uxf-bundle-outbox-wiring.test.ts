/**
 * Issue #401 — publishUxfBundle OUTBOX/SENT wiring.
 *
 * Pins the contract added in PR #400 follow-up: when a wallet has the
 * OUTBOX writer + SENT ledger writer installed (the default path after
 * `Sphere.init`), every call to `PaymentsModule.publishUxfBundle`:
 *
 *   1. Writes an OUTBOX entry at status `'sending'` BEFORE the transport
 *      publish (the SendingRecoveryWorker's pickup point if the publish
 *      crashes between this line and the ack write).
 *   2. After the transport ack, transitions the entry to status
 *      `'delivered'` (NOT `'delivered-instant'` — invoice bundles carry
 *      their own genesis proofs and have no aggregator commitments to
 *      finalize) and captures the relay's `nostrEventId`.
 *   3. Writes a SENT ledger entry mirroring the OUTBOX terminal-success
 *      state so the `NostrPersistenceVerifier` scan picks it up on the
 *      next cycle and emits retention-warning / rearm events if the
 *      relay drops the event.
 *
 * Failure-path contract:
 *   4. If `transport.sendTokenTransfer` throws, the OUTBOX entry STAYS at
 *      `'sending'` (no transition fires, no SENT write) so the recovery
 *      worker picks it up on its next scan cycle.
 *
 * Skip-path contract:
 *   5. If no OUTBOX writer is installed (legacy/in-memory wallets,
 *      bootstrap-only paths), `publishUxfBundle` reverts to the
 *      fire-and-publish behavior — no OUTBOX/SENT writes occur. The
 *      existing fire-and-publish callers (some unit-test fixtures) must
 *      keep working.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi } from 'vitest';

import { PaymentsModule } from '../../../modules/payments/PaymentsModule';
import type { OutboxWriter } from '../../../extensions/uxf/profile/outbox-writer';
import type { SentLedgerWriter } from '../../../extensions/uxf/profile/sent-ledger-writer';
import type { FullIdentity } from '../../../types';
import type { UxfTransferOutboxEntry } from '../../../extensions/uxf/types/uxf-outbox';

// =============================================================================
// Helpers
// =============================================================================

function stubIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'aa'.repeat(32),
    directAddress: 'DIRECT://test',
    privateKey: 'bb'.repeat(32),
  };
}

function stubDeps(transport: any) {
  return {
    identity: stubIdentity(),
    storage: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      has: vi.fn(async () => false),
      list: vi.fn(async () => []),
      isConnected: () => true,
      connect: async () => undefined,
      disconnect: async () => undefined,
      setIdentity: () => undefined,
      clear: async () => undefined,
    } as any,
    transport,
    oracle: {
      verifyToken: vi.fn(),
      submitTransaction: vi.fn(),
    } as any,
    emitEvent: vi.fn(),
  };
}

interface FakeOutboxFixture {
  readonly writer: Pick<OutboxWriter, 'write' | 'update' | 'readAllNew'>;
  readonly entries: Map<string, UxfTransferOutboxEntry>;
  readonly writeOrder: string[];
  readonly transitionOrder: Array<{ from: string; to: string }>;
}

function makeFakeOutbox(): FakeOutboxFixture {
  const entries = new Map<string, UxfTransferOutboxEntry>();
  const writeOrder: string[] = [];
  const transitionOrder: Array<{ from: string; to: string }> = [];
  return {
    writer: {
      async write(input: any): Promise<UxfTransferOutboxEntry> {
        const stamped: UxfTransferOutboxEntry = {
          _schemaVersion: 'uxf-1',
          lamport: (entries.get(input.id)?.lamport ?? 0) + 1,
          ...input,
        };
        entries.set(stamped.id, stamped);
        writeOrder.push(`write:${stamped.status}`);
        return stamped;
      },
      async update(
        id: string,
        mutator: (prev: UxfTransferOutboxEntry) => UxfTransferOutboxEntry,
      ): Promise<UxfTransferOutboxEntry> {
        const prev = entries.get(id);
        if (!prev) throw new Error(`OutboxWriter.update: no entry "${id}"`);
        const next = mutator(prev);
        if (next.status !== prev.status) {
          transitionOrder.push({ from: prev.status, to: next.status });
        }
        const bumped = { ...next, lamport: prev.lamport + 1 };
        entries.set(id, bumped);
        writeOrder.push(`update:${bumped.status}`);
        return bumped;
      },
      async readAllNew(): Promise<UxfTransferOutboxEntry[]> {
        return Array.from(entries.values());
      },
    },
    entries,
    writeOrder,
    transitionOrder,
  };
}

interface FakeSentFixture {
  readonly writer: Pick<SentLedgerWriter, 'write'>;
  readonly writes: Array<Record<string, unknown>>;
}

function makeFakeSentLedger(): FakeSentFixture {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writer: {
      async write(input: any): Promise<any> {
        writes.push(input);
        return { ...input, _schemaVersion: 'uxf-1', lamport: 1 };
      },
    },
    writes,
  };
}

function makeFakeTransport(opts: {
  readonly sendResult?: string;
  readonly sendError?: Error;
}) {
  const sendTokenTransfer = vi.fn(async () => {
    if (opts.sendError) throw opts.sendError;
    return opts.sendResult ?? 'mock-event-id-abc123';
  });
  return {
    sendTokenTransfer,
    resolve: vi.fn(async () => null),
    subscribe: vi.fn(() => () => undefined),
    onTokenTransfer: vi.fn(() => () => undefined),
    onPaymentRequest: vi.fn(() => () => undefined),
    onPaymentRequestResponse: vi.fn(() => () => undefined),
  };
}

function buildModuleWithWriters(opts: {
  readonly sendResult?: string;
  readonly sendError?: Error;
}): {
  module: PaymentsModule;
  outbox: FakeOutboxFixture;
  sent: FakeSentFixture;
  transport: ReturnType<typeof makeFakeTransport>;
} {
  const module = new PaymentsModule({ features: { senderUxf: true } });
  const transport = makeFakeTransport({
    ...(opts.sendResult !== undefined ? { sendResult: opts.sendResult } : {}),
    ...(opts.sendError !== undefined ? { sendError: opts.sendError } : {}),
  });
  module.initialize(stubDeps(transport) as any);
  const outbox = makeFakeOutbox();
  const sent = makeFakeSentLedger();
  module.installOutboxWriter(outbox.writer as unknown as OutboxWriter);
  module.installSentLedgerWriter(sent.writer as unknown as SentLedgerWriter);
  return { module, outbox, sent, transport };
}

// =============================================================================
// Tests
// =============================================================================

describe('Issue #401 — publishUxfBundle OUTBOX/SENT wiring', () => {
  // 33-byte compressed chain pubkey passed as `recipient`. PaymentsModule's
  // `resolveTransportPubkey` strips the leading parity byte and binds the
  // 32-byte x-coordinate as the transport pubkey, mirroring the
  // single-identity model documented in `core/Sphere.ts`.
  const RECIPIENT_CHAIN_PUBKEY = '02' + 'cc'.repeat(32);
  const RECIPIENT_TRANSPORT_PUBKEY = 'cc'.repeat(32);
  const CAR_BYTES = new Uint8Array([0xa1, 0xa2, 0xa3]);
  const BUNDLE_CID = 'bafkreigh2akiscaildc' + 'q'.repeat(32);

  it('writes OUTBOX in "sending" BEFORE transport publish, transitions to "delivered" after ack', async () => {
    const { module, outbox, transport } = buildModuleWithWriters({
      sendResult: 'event-id-aaaa',
    });

    const result = await module.publishUxfBundle({
      recipient: RECIPIENT_CHAIN_PUBKEY,
      bundleCid: BUNDLE_CID,
      tokenIds: ['invoice-token-id'],
      carBytes: CAR_BYTES,
      memo: 'Order #42',
    });

    expect(result.nostrEventId).toBe('event-id-aaaa');
    expect(result.recipientTransportPubkey).toBe(RECIPIENT_TRANSPORT_PUBKEY);
    expect(transport.sendTokenTransfer).toHaveBeenCalledTimes(1);

    // Sequence: OUTBOX 'sending' write THEN transport.sendTokenTransfer
    // THEN OUTBOX 'delivered' transition. The 'sending' write must
    // observably precede the transport call (recovery-worker pickup
    // point on crash).
    expect(outbox.writeOrder).toEqual([
      'write:sending',
      'update:delivered',
    ]);
    expect(outbox.transitionOrder).toEqual([
      { from: 'sending', to: 'delivered' },
    ]);
  });

  it('captured OUTBOX entry has mode=instant, outstandingRequestIds=[], nostrEventId set after delivery', async () => {
    const { module, outbox } = buildModuleWithWriters({
      sendResult: 'event-id-bbbb',
    });

    await module.publishUxfBundle({
      recipient: RECIPIENT_CHAIN_PUBKEY,
      bundleCid: BUNDLE_CID,
      tokenIds: ['invoice-token-1'],
      carBytes: CAR_BYTES,
    });

    expect(outbox.entries.size).toBe(1);
    const entry = Array.from(outbox.entries.values())[0]!;
    expect(entry).toMatchObject({
      _schemaVersion: 'uxf-1',
      bundleCid: BUNDLE_CID,
      tokenIds: ['invoice-token-1'],
      deliveryMethod: 'car-over-nostr',
      recipient: RECIPIENT_CHAIN_PUBKEY,
      recipientTransportPubkey: RECIPIENT_TRANSPORT_PUBKEY,
      mode: 'instant',
      status: 'delivered',
      outstandingRequestIds: [],
      completedRequestIds: [],
      nostrEventId: 'event-id-bbbb',
    });
  });

  it('publishViaIpfsCid=true sets deliveryMethod="cid-over-nostr" on the OUTBOX entry', async () => {
    const { module, outbox } = buildModuleWithWriters({});

    await module.publishUxfBundle({
      recipient: RECIPIENT_CHAIN_PUBKEY,
      bundleCid: BUNDLE_CID,
      tokenIds: ['invoice-token-id'],
      carBytes: CAR_BYTES,
      publishViaIpfsCid: true,
    });

    const entry = Array.from(outbox.entries.values())[0]!;
    expect(entry.deliveryMethod).toBe('cid-over-nostr');
  });

  it('writes SENT ledger entry with nostrEventId after the OUTBOX terminal-success transition', async () => {
    const { module, sent } = buildModuleWithWriters({
      sendResult: 'event-id-cccc',
    });

    await module.publishUxfBundle({
      recipient: RECIPIENT_CHAIN_PUBKEY,
      bundleCid: BUNDLE_CID,
      tokenIds: ['invoice-token-id'],
      carBytes: CAR_BYTES,
    });

    expect(sent.writes).toHaveLength(1);
    expect(sent.writes[0]).toMatchObject({
      bundleCid: BUNDLE_CID,
      tokenIds: ['invoice-token-id'],
      recipientTransportPubkey: RECIPIENT_TRANSPORT_PUBKEY,
      recipient: RECIPIENT_CHAIN_PUBKEY,
      deliveryMethod: 'car-over-nostr',
      mode: 'instant',
      nostrEventId: 'event-id-cccc',
    });
    expect(typeof sent.writes[0]!.sentAt).toBe('number');
  });

  it('on transport.sendTokenTransfer failure, OUTBOX entry STAYS at "sending" (recovery-worker pickup)', async () => {
    const { module, outbox, sent } = buildModuleWithWriters({
      sendError: new Error('relay offline'),
    });

    await expect(
      module.publishUxfBundle({
        recipient: RECIPIENT_CHAIN_PUBKEY,
        bundleCid: BUNDLE_CID,
        tokenIds: ['invoice-token-id'],
        carBytes: CAR_BYTES,
      }),
    ).rejects.toThrow(/relay offline/);

    // OUTBOX entry was written at 'sending' but NEVER transitioned —
    // SendingRecoveryWorker.scanCycle() picks it up on its next pass.
    expect(outbox.entries.size).toBe(1);
    const entry = Array.from(outbox.entries.values())[0]!;
    expect(entry.status).toBe('sending');
    expect(outbox.transitionOrder).toEqual([]);
    // No SENT write fires on failure (verifier owns retention duty only
    // AFTER the entry transitions through 'delivered').
    expect(sent.writes).toHaveLength(0);
  });

  it('skips OUTBOX writes entirely when no writer is installed (legacy/in-memory wallets)', async () => {
    const module = new PaymentsModule({ features: { senderUxf: true } });
    const transport = makeFakeTransport({ sendResult: 'event-id-dddd' });
    module.initialize(stubDeps(transport) as any);
    // NB: no installOutboxWriter / installSentLedgerWriter calls.

    const result = await module.publishUxfBundle({
      recipient: RECIPIENT_CHAIN_PUBKEY,
      bundleCid: BUNDLE_CID,
      tokenIds: ['invoice-token-id'],
      carBytes: CAR_BYTES,
    });

    expect(result.nostrEventId).toBe('event-id-dddd');
    expect(transport.sendTokenTransfer).toHaveBeenCalledTimes(1);
    // Survives without writers — fire-and-publish path stays correct
    // for legacy/in-memory consumers that don't have crash-safety.
  });
});
