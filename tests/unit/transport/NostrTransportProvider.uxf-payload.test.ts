/**
 * T.2.E — NostrTransportProvider UXF payload routing.
 *
 * Verifies that the transport adapter is shape-agnostic across the full
 * `TokenTransferPayload` tagged union (`types/uxf-transfer`):
 *
 *   - {@link UxfTransferPayloadCar}        (`kind: 'uxf-car'`)
 *   - {@link UxfTransferPayloadCid}        (`kind: 'uxf-cid'`)
 *   - {@link LegacyTokenTransferPayload}   (4 pre-UXF shapes)
 *
 * Outbound: `sendTokenTransfer` MUST serialize whatever shape it is given,
 * preserve the legacy `token_transfer:` content prefix (nostr-js-sdk wire
 * compat), and round-trip back through `decodeTransferPayload` to the same
 * structural value.
 *
 * Inbound: `_handleTokenTransferEvent` MUST hand the registered handler
 * the typed payload as-is. Discrimination by `kind` is the handler's job
 * (PaymentsModule downstream — see T.7.A).
 *
 * Regression: existing legacy senders that pass `{sourceToken, transferTx}`
 * (Sphere TXF single-token, currently used by `PaymentsModule.send`) MUST
 * continue to flow through the transport without alteration.
 *
 * Spec refs: §3.3.2, §10.2; UXF-TRANSFER-IMPL-PLAN.md §T.2.E.
 *
 * Implementation note: the test re-uses the existing `vi.mock` shape for
 * `@unicitylabs/nostr-js-sdk` (the production code already mocks
 * `NostrClient`); we additionally exercise the REAL `NIP04` exports by
 * spreading `...actual`. This lets us encrypt content with one identity
 * and decrypt it on the receiver side without stubbing the crypto layer
 * — an end-to-end round trip that mirrors the wire path 1:1.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocketFactory } from '../../../transport/websocket';
import {
  encodeTransferPayload,
  decodeTransferPayload,
} from '../../../uxf/transfer-payload';
import type {
  LegacySphereTxfPayload,
  UxfTransferPayloadCar,
  UxfTransferPayloadCid,
} from '../../../types/uxf-transfer';
import type {
  IncomingTokenTransfer,
  TokenTransferPayload,
} from '../../../transport/transport-provider';

// =============================================================================
// Mock NostrClient — capture publishEvent + subscribe calls
// =============================================================================
//
// We deliberately keep NIP04 / NostrKeyManager UN-mocked (via `...actual`).
// The two halves of the round trip — sender → encrypted bytes → receiver —
// thus run through the production crypto stack, exactly as in production.
// Only the relay layer (`NostrClient.publishEvent` / `subscribe`) is
// stubbed because hitting a real WebSocket would slow tests by orders of
// magnitude and offer no extra fidelity at this layer.

interface CapturedPublishedEvent {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
  pubkey: string;
  created_at: number;
  sig?: string;
}

const capturedPublishedEvents: CapturedPublishedEvent[] = [];

// Smart subscribe mock — for normal subscriptions (e.g. wallet/chat
// filters during `setIdentity`/`connect`), behave like the legacy mock
// (return a sub ID, deliver no events). For the publish-verification
// query inside `publishWithVerification`, the filter carries `ids: [...]`
// referring to one of our captured published events; in that case we
// synthesize a matching `onEvent` then `onEndOfStoredEvents` so the
// verification flow resolves immediately and `sendTokenTransfer` can
// return without retry/timeout.
//
// Without this short-circuit, every outbound test would block 15s
// (queryEvents timeout) × 3 retries × jitter, far exceeding the default
// vitest timeout.
let nextSubId = 0;
const mockSubscribe = vi.fn().mockImplementation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (filter: any, callbacks: any) => {
    const subId = `mock-sub-${++nextSubId}`;
    // Filter is a `Filter` class instance — extract the underlying object.
    const filterObj = typeof filter?.toJSON === 'function' ? filter.toJSON() : filter;
    const queryIds: string[] | undefined = Array.isArray(filterObj?.ids)
      ? filterObj.ids
      : undefined;

    if (queryIds && queryIds.length > 0) {
      // Verification query — synthesize matches from our captured set.
      // Run on a microtask so the caller (`queryEvents`) can record `subId`
      // before we settle the EOSE.
      Promise.resolve().then(() => {
        for (const ev of capturedPublishedEvents) {
          if (queryIds.includes(ev.id) && callbacks?.onEvent) {
            callbacks.onEvent(ev);
          }
        }
        if (callbacks?.onEndOfStoredEvents) {
          callbacks.onEndOfStoredEvents();
        }
      });
    }
    return subId;
  },
);
const mockUnsubscribe = vi.fn();
const mockPublishEvent = vi.fn().mockImplementation(async (sdkEvent: unknown) => {
  // The provider passes a `NostrEventClass.fromJSON(...)` instance — its
  // toJSON() / direct property access exposes the wire shape. We coerce
  // through `any` because the SDK's strict event class isn't visible in
  // the test type surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = sdkEvent as any;
  capturedPublishedEvents.push({
    id: e.id,
    kind: e.kind,
    content: e.content,
    tags: e.tags,
    pubkey: e.pubkey,
    created_at: e.created_at,
    sig: e.sig,
  });
  return e.id;
});
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi
  .fn()
  .mockReturnValue(new Set(['wss://relay1.test']));
const mockAddConnectionListener = vi.fn();

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  return {
    ...actual,
    NostrClient: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      isConnected: mockIsConnected,
      getConnectedRelays: mockGetConnectedRelays,
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      publishEvent: mockPublishEvent,
      addConnectionListener: mockAddConnectionListener,
    })),
  };
});

const { NostrTransportProvider } = await import(
  '../../../transport/NostrTransportProvider'
);
const { NostrKeyManager, NIP04 } = await import('@unicitylabs/nostr-js-sdk');

// =============================================================================
// Test fixtures — two identities (sender + receiver)
// =============================================================================
//
// The sender's `event.pubkey` field on the wire is its 32-byte x-only
// Nostr pubkey, NOT the 33-byte compressed secp256k1 pubkey. We derive
// both via `NostrKeyManager` so the values match what a real Nostr event
// would carry.

const SENDER_SK_HEX = '11'.repeat(32);
const RECEIVER_SK_HEX = '22'.repeat(32);

const senderKeyManager = NostrKeyManager.fromPrivateKey(
  Uint8Array.from(Buffer.from(SENDER_SK_HEX, 'hex')),
);
const receiverKeyManager = NostrKeyManager.fromPrivateKey(
  Uint8Array.from(Buffer.from(RECEIVER_SK_HEX, 'hex')),
);

const SENDER_NOSTR_PUBKEY = senderKeyManager.getPublicKeyHex(); // 64 hex
const RECEIVER_NOSTR_PUBKEY = receiverKeyManager.getPublicKeyHex(); // 64 hex

const RECEIVER_IDENTITY = {
  privateKey: RECEIVER_SK_HEX,
  // The L3 chainPubkey is 33 bytes (02/03 prefix + x-coord). For these
  // tests we only need the receiver's privateKey to drive NIP-04 decrypt;
  // chainPubkey is fed verbatim — the format isn't validated at this
  // layer.
  chainPubkey: '02' + 'cd'.repeat(32),
  directAddress: 'DIRECT://receiver',
};

// =============================================================================
// Helpers
// =============================================================================

function createReceiverProvider() {
  return new NostrTransportProvider({
    relays: ['wss://relay1.test'],
    createWebSocket: (() => {}) as unknown as WebSocketFactory,
    timeout: 1000,
    autoReconnect: false,
  });
}

function createSenderProvider() {
  return new NostrTransportProvider({
    relays: ['wss://relay1.test'],
    createWebSocket: (() => {}) as unknown as WebSocketFactory,
    timeout: 1000,
    autoReconnect: false,
  });
}

/**
 * Build a fake inbound TOKEN_TRANSFER event that the receiver provider
 * can decrypt with its identity. We encrypt `payloadJson` (after the
 * canonical `token_transfer:` prefix) under NIP-04 with the SENDER's
 * private key targeting the RECEIVER's pubkey — matching exactly what a
 * legitimate sender would publish.
 */
async function buildInboundEvent(payloadJson: string): Promise<{
  id: string;
  kind: number;
  content: string;
  tags: string[][];
  pubkey: string;
  created_at: number;
  sig: string;
}> {
  const prefixed = 'token_transfer:' + payloadJson;
  const encrypted = await NIP04.encryptHex(
    prefixed,
    SENDER_SK_HEX,
    RECEIVER_NOSTR_PUBKEY,
  );
  return {
    id: 'evt-' + Math.random().toString(36).slice(2, 10),
    kind: 31113, // TOKEN_TRANSFER
    content: encrypted,
    tags: [
      ['p', RECEIVER_NOSTR_PUBKEY],
      ['type', 'token_transfer'],
    ],
    pubkey: SENDER_NOSTR_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    sig: 'a'.repeat(128),
  };
}

/** Decrypt a captured outbound event back to its plaintext (post-prefix). */
async function decryptOutbound(
  ev: CapturedPublishedEvent,
): Promise<string> {
  const decrypted = await NIP04.decryptHex(
    ev.content,
    RECEIVER_SK_HEX,
    SENDER_NOSTR_PUBKEY,
  );
  // Production receiver strips this prefix in `decryptContent`. We mirror
  // that here so the assertions can target the JSON body directly.
  if (decrypted.startsWith('token_transfer:')) {
    return decrypted.slice('token_transfer:'.length);
  }
  return decrypted;
}

// =============================================================================
// Tests
// =============================================================================

describe('NostrTransportProvider — UXF payload routing (T.2.E)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedPublishedEvents.length = 0;
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
  });

  // -------------------------------------------------------------------------
  // Outbound — encoding accepts every shape in the union
  // -------------------------------------------------------------------------

  describe('sendTokenTransfer — outbound encoding', () => {
    it('serializes a uxf-car payload through encodeTransferPayload', async () => {
      const provider = createSenderProvider();
      await provider.setIdentity({
        privateKey: SENDER_SK_HEX,
        chainPubkey: '02' + 'aa'.repeat(32),
      });
      await provider.connect();

      // A bafy-prefixed CIDv1 base32 string. Not validated at this layer
      // (T.3.A `pkg.verify()` does the real CAR-root check); the encoder
      // is byte-deterministic only.
      const carPayload: UxfTransferPayloadCar = {
        kind: 'uxf-car',
        version: '1.0',
        mode: 'instant',
        bundleCid:
          'bafy2bzaceaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        tokenIds: ['0xdeadbeef'],
        carBase64: 'dGVzdENBUg==', // base64('testCAR')
        memo: 'hello UXF-CAR',
      };

      await provider.sendTokenTransfer(RECEIVER_NOSTR_PUBKEY, carPayload);

      expect(capturedPublishedEvents).toHaveLength(1);
      const captured = capturedPublishedEvents[0];
      expect(captured.kind).toBe(31113);
      // The `p` tag MUST carry the recipient pubkey (subscription filter).
      expect(captured.tags.some((t) => t[0] === 'p' && t[1] === RECEIVER_NOSTR_PUBKEY))
        .toBe(true);

      const plaintext = await decryptOutbound(captured);
      // Round-trip through the canonical decoder must preserve every field.
      const roundTripped = decodeTransferPayload(plaintext);
      expect(roundTripped).toEqual(carPayload);
      // Byte-equality with the canonical encoder output proves we didn't
      // accidentally fall through to plain JSON.stringify.
      expect(plaintext).toBe(encodeTransferPayload(carPayload));
    });

    it('serializes a uxf-cid payload through encodeTransferPayload', async () => {
      const provider = createSenderProvider();
      await provider.setIdentity({
        privateKey: SENDER_SK_HEX,
        chainPubkey: '02' + 'aa'.repeat(32),
      });
      await provider.connect();

      const cidPayload: UxfTransferPayloadCid = {
        kind: 'uxf-cid',
        version: '1.0',
        mode: 'conservative',
        bundleCid:
          'bafy2bzacebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        tokenIds: ['0x1234abcd', '0x5678ef01'],
        senderGateways: ['https://ipfs.example/'],
      };

      await provider.sendTokenTransfer(RECEIVER_NOSTR_PUBKEY, cidPayload);

      expect(capturedPublishedEvents).toHaveLength(1);
      const captured = capturedPublishedEvents[0];
      const plaintext = await decryptOutbound(captured);
      const roundTripped = decodeTransferPayload(plaintext);
      expect(roundTripped).toEqual(cidPayload);
      expect(plaintext).toBe(encodeTransferPayload(cidPayload));
    });

    it('regression: serializes a legacy {sourceToken, transferTx} payload', async () => {
      const provider = createSenderProvider();
      await provider.setIdentity({
        privateKey: SENDER_SK_HEX,
        chainPubkey: '02' + 'aa'.repeat(32),
      });
      await provider.connect();

      // The exact shape PaymentsModule emits today (Sphere TXF single-token).
      const legacyPayload: LegacySphereTxfPayload = {
        sourceToken: '{"token":"json"}',
        transferTx: '{"transferTx":"json"}',
        memo: 'legacy regression',
      };

      await provider.sendTokenTransfer(
        RECEIVER_NOSTR_PUBKEY,
        legacyPayload as TokenTransferPayload,
      );

      expect(capturedPublishedEvents).toHaveLength(1);
      const plaintext = await decryptOutbound(capturedPublishedEvents[0]);
      const parsed = JSON.parse(plaintext) as LegacySphereTxfPayload;
      // The canonical encoder alphabetically sorts keys for legacy shapes;
      // we don't pin key order here — only that the round-trip preserves
      // every field bit-for-bit.
      expect(parsed.sourceToken).toBe(legacyPayload.sourceToken);
      expect(parsed.transferTx).toBe(legacyPayload.transferTx);
      expect(parsed.memo).toBe(legacyPayload.memo);
    });

    it('preserves the legacy "token_transfer:" content prefix on every shape', async () => {
      const provider = createSenderProvider();
      await provider.setIdentity({
        privateKey: SENDER_SK_HEX,
        chainPubkey: '02' + 'aa'.repeat(32),
      });
      await provider.connect();

      const carPayload: UxfTransferPayloadCar = {
        kind: 'uxf-car',
        version: '1.0',
        mode: 'instant',
        bundleCid: 'bafy2bzaceaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        tokenIds: [],
        carBase64: '',
      };

      await provider.sendTokenTransfer(RECEIVER_NOSTR_PUBKEY, carPayload);

      // Decrypt WITHOUT stripping the prefix — verify it's there verbatim.
      const captured = capturedPublishedEvents[0];
      const decrypted = await NIP04.decryptHex(
        captured.content,
        RECEIVER_SK_HEX,
        SENDER_NOSTR_PUBKEY,
      );
      expect(decrypted.startsWith('token_transfer:')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Inbound — handler receives the typed payload, discrimination is downstream
  // -------------------------------------------------------------------------

  describe('handleTokenTransfer — inbound decoding', () => {
    async function setupReceiver() {
      const provider = createReceiverProvider();
      await provider.setIdentity(RECEIVER_IDENTITY);
      await provider.connect();
      const captured: IncomingTokenTransfer[] = [];
      provider.onTokenTransfer((t) => {
        captured.push(t);
      });
      return { provider, captured };
    }

    it('routes an inbound uxf-car event to the handler with kind=uxf-car', async () => {
      const { provider, captured } = await setupReceiver();

      const carPayload: UxfTransferPayloadCar = {
        kind: 'uxf-car',
        version: '1.0',
        mode: 'instant',
        bundleCid: 'bafy2bzacedeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        tokenIds: ['0xabc'],
        carBase64: 'aGVsbG8=',
        memo: 'inbound car',
      };
      const event = await buildInboundEvent(encodeTransferPayload(carPayload));

      // Drive the inbound dispatch path directly. Production wires this to
      // the NostrClient subscribe `onEvent` callback; calling `handleEvent`
      // directly tests the same code path (handle*Event → decrypt → decode
      // → fan-out to handlers) without needing a real relay.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (provider as any).handleEvent(event);

      expect(captured).toHaveLength(1);
      expect(captured[0].senderTransportPubkey).toBe(SENDER_NOSTR_PUBKEY);
      expect(captured[0].payload).toEqual(carPayload);
    });

    it('routes an inbound uxf-cid event to the handler with kind=uxf-cid', async () => {
      const { provider, captured } = await setupReceiver();

      const cidPayload: UxfTransferPayloadCid = {
        kind: 'uxf-cid',
        version: '1.0',
        mode: 'conservative',
        bundleCid: 'bafy2bzaceffffffffffffffffffffffffffffffffffffffffffffffff',
        tokenIds: ['0x111', '0x222'],
        sender: {
          transportPubkey: SENDER_NOSTR_PUBKEY,
          nametag: 'alice',
        },
      };
      const event = await buildInboundEvent(encodeTransferPayload(cidPayload));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (provider as any).handleEvent(event);

      expect(captured).toHaveLength(1);
      expect(captured[0].payload).toEqual(cidPayload);
    });

    it('routes an inbound legacy {sourceToken, transferTx} event to the handler unchanged', async () => {
      const { provider, captured } = await setupReceiver();

      const legacy: LegacySphereTxfPayload = {
        sourceToken: '{"foo":1}',
        transferTx: '{"bar":2}',
        memo: 'legacy inbound',
      };
      // Use the canonical encoder so byte ordering matches what a UXF-aware
      // sender would produce. The shape itself has no `kind` discriminator,
      // so the receiver MUST recognize it via `isLegacyTokenTransferPayload`.
      const event = await buildInboundEvent(encodeTransferPayload(legacy));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (provider as any).handleEvent(event);

      expect(captured).toHaveLength(1);
      const got = captured[0].payload as LegacySphereTxfPayload;
      expect(got.sourceToken).toBe(legacy.sourceToken);
      expect(got.transferTx).toBe(legacy.transferTx);
      expect(got.memo).toBe(legacy.memo);
      // Critical: the legacy shape must NOT have acquired a `kind` discriminator
      // — otherwise a downstream handler would try to route it as UXF.
      expect((got as { kind?: unknown }).kind).toBeUndefined();
    });

    it('drops malformed (non-JSON) content without crashing or invoking the handler', async () => {
      const { provider, captured } = await setupReceiver();

      // Hand-craft a TOKEN_TRANSFER event whose content (after decrypt) is
      // garbage. Encrypt the literal string `not-json{` so the receiver's
      // `decryptContent` returns it verbatim, and `decodeTransferPayload`
      // throws BUNDLE_REJECTED_MALFORMED_ENVELOPE — which the outer
      // `handleEvent` catches.
      const event = await buildInboundEvent('not-json{');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((provider as any).handleEvent(event)).resolves.toBeUndefined();
      expect(captured).toHaveLength(0);
    });

    it('drops payloads with an unknown `kind` discriminator without invoking the handler', async () => {
      const { provider, captured } = await setupReceiver();

      // A JSON object with `kind: 'uxf-future'` — well-formed JSON but
      // not part of the v1.0 union. `isUxfTransferPayload` returns false
      // for any unknown kind (paranoid by design — see types/uxf-transfer.ts
      // §5).
      const futurePayload = JSON.stringify({
        kind: 'uxf-future',
        version: '1.0',
        mode: 'instant',
        bundleCid: 'bafy2bzace000000000000000000000000000000000000000000000000',
        tokenIds: [],
      });
      const event = await buildInboundEvent(futurePayload);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (provider as any).handleEvent(event);
      expect(captured).toHaveLength(0);
    });

    it('drops a UXF payload with a wrong version literal without invoking the handler', async () => {
      const { provider, captured } = await setupReceiver();

      // A UXF-CAR with the future version `'2.0'`. `isUxfTransferPayloadCar`
      // requires the literal `'1.0'`, so this is a hard reject (T.1.A
      // §5 — defense against silent forward-compat misclassification).
      const futureVersion = JSON.stringify({
        kind: 'uxf-car',
        version: '2.0',
        mode: 'instant',
        bundleCid: 'bafy2bzaceaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        tokenIds: [],
        carBase64: '',
      });
      const event = await buildInboundEvent(futureVersion);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (provider as any).handleEvent(event);
      expect(captured).toHaveLength(0);
    });
  });
});
