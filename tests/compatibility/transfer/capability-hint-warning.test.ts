/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T.8.E.2 — Cross-mode compatibility: capability-hint warning on legacy peers.
 *
 * **Scenario** (the headline §10.4 invariant): the recipient peer's
 * binding event advertises `assetKinds: ['coin']` only — i.e. a wallet
 * that does NOT support NFTs. The local sender attempts a transfer that
 * carries an NFT in `additionalAssets`. The expected behavior:
 *
 *  1. **Warning emitted** — `transfer:capability-warning` fires with the
 *     mismatched kind enumerated as `mismatchedAssetKinds: ['nft']`.
 *  2. **No auto-strip** — the sender's request remains UNCHANGED. The
 *     spec is explicit (§10.4): the capability hint is informational;
 *     the actual interop guarantee comes from the receiver's T.2.B
 *     `UNKNOWN_ASSET_KIND` reject path. Auto-stripping would silently
 *     break the sender's intent (e.g. an NFT-only batch becoming a
 *     no-op coin send).
 *
 * **Why this is a compatibility test**: the mismatch case described
 * here is a realistic in-the-wild scenario during the rollout window —
 * old peers (from the v1.0 era, pre-NFT) advertise `['coin']` either
 * explicitly or implicitly (W20 default when `assetKinds` is absent).
 * A modern sender shipping a `kind: 'nft'` entry MUST surface the
 * mismatch to its UI without quietly dropping the NFT entry; the
 * receiver will reject the UXF bundle on receipt with `UNKNOWN_ASSET_KIND`,
 * giving the sender a deterministic, observable failure mode rather
 * than a silent "send ok, recipient saw nothing" outcome.
 *
 * **What this test asserts** (vs. existing `capability-warning.test.ts`):
 *  - `capability-warning.test.ts` exhaustively covers the matrix of
 *    advertised hints (W20 default, full-capability, coin-only, wire
 *    protocol mismatches). Those tests ARE the production guard.
 *  - This compatibility test pins the headline two-axis acceptance for
 *    T.8.E.2: (a) warning fires with the documented payload shape; (b)
 *    the request object is NOT mutated. The two assertions are repeated
 *    here in compact form so a future refactor that breaks either axis
 *    fails this file too — the compat suite is the canonical contract.
 *
 * Spec references:
 *  - §10.4   Capability hints — informational only.
 *  - §T.8.B  Sender-side capability hint check (the production helper).
 *  - W20     `assetKinds` absent ⇒ default `['coin']`.
 *
 * @packageDocumentation
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { PaymentsModule } from '../../../modules/payments/PaymentsModule';
import type { PeerInfo, TransferRequest } from '../../../types';

// =============================================================================
// 1. Helpers
// =============================================================================

interface CapturedEvent {
  readonly type: string;
  readonly data: unknown;
}

interface ModuleHarness {
  readonly module: PaymentsModule;
  readonly events: CapturedEvent[];
  readonly transport: { readonly resolve: ReturnType<typeof vi.fn> };
}

/**
 * Construct a {@link PaymentsModule} with the minimum surface required
 * to invoke `maybeEmitCapabilityWarning` directly. The full
 * `initialize()` path is overkill for this compatibility test — we
 * exercise the helper at its narrowest contract surface.
 */
function createModule(opts: {
  readonly resolveResult: PeerInfo | null;
  readonly senderUxf?: boolean;
}): ModuleHarness {
  const events: CapturedEvent[] = [];
  const transport = {
    resolve: vi.fn(async (_id: string) => opts.resolveResult),
  };
  const module = new PaymentsModule({
    features: { senderUxf: opts.senderUxf ?? true },
  });
  // Inject just enough surface for the helper. The cast is the same
  // pattern used by the existing T.8.B unit test.
  (module as any).deps = {
    transport,
    emitEvent: (type: string, data: unknown) => events.push({ type, data }),
  };
  return { module, events, transport };
}

function buildPeerInfo(over: Partial<PeerInfo>): PeerInfo {
  return {
    transportPubkey: 'a'.repeat(64),
    chainPubkey: '02' + 'b'.repeat(64),
    l1Address: 'alpha1peer',
    directAddress: 'DIRECT://peer',
    timestamp: 1700000000000,
    ...over,
  };
}

async function callCheck(
  module: PaymentsModule,
  request: TransferRequest,
  mode: 'instant' | 'conservative' | 'txf' = 'instant',
): Promise<void> {
  await (module as any).maybeEmitCapabilityWarning(request, mode);
}

const NFT_BUNDLE_REQUEST: TransferRequest = {
  recipient: '@bob',
  coinId: 'UCT',
  amount: '1000000',
  additionalAssets: [{ kind: 'nft', tokenId: '0xabc123' }],
};

// =============================================================================
// 2. assetKinds=['coin'] only + sender ships NFT → warning fires
// =============================================================================

describe('Capability hint warning — coin-only peer + NFT outbound', () => {
  let harness: ModuleHarness;

  describe('peer explicitly advertises assetKinds=[coin]', () => {
    beforeEach(() => {
      const resolveResult = buildPeerInfo({
        wireProtocols: ['uxf-car', 'uxf-cid', 'txf'],
        // The headline T.8.E.2 case: peer says coin-only.
        assetKinds: ['coin'],
      });
      harness = createModule({ resolveResult });
    });

    it('emits transfer:capability-warning with mismatchedAssetKinds=[nft]', async () => {
      await callCheck(harness.module, NFT_BUNDLE_REQUEST);

      expect(harness.transport.resolve).toHaveBeenCalledWith('@bob');
      expect(harness.events.length).toBe(1);

      const evt = harness.events[0]!;
      expect(evt.type).toBe('transfer:capability-warning');

      const data = evt.data as Record<string, unknown>;
      // The headline acceptance: 'nft' is the lone mismatched kind.
      expect(data.mismatchedAssetKinds).toEqual(['nft']);
      expect(data.recipientAssetKinds).toEqual(['coin']);
      // Outbound carries the primary 'coin' slot AND the additional 'nft'.
      expect(data.outboundAssetKinds).toEqual(
        expect.arrayContaining(['coin', 'nft']),
      );
      // No wire-protocol axis fired (peer advertises uxf-car/uxf-cid/txf,
      // and the sender's outbound is one of them).
      expect(data.wireProtocolMismatch).toBe(false);
    });

    it('does NOT auto-strip the NFT entry — request object remains unchanged', async () => {
      // Capture the additionalAssets array IDENTITY before the call. The
      // production helper is a read-only inspector; any auto-strip would
      // either replace the array (identity changes) or splice into it
      // (length / contents change).
      const beforeAdditionals = NFT_BUNDLE_REQUEST.additionalAssets;
      const beforeLength = NFT_BUNDLE_REQUEST.additionalAssets!.length;
      const beforeFirstEntry = NFT_BUNDLE_REQUEST.additionalAssets![0];

      await callCheck(harness.module, NFT_BUNDLE_REQUEST);

      // Identity preserved (no defensive copy, no replacement).
      expect(NFT_BUNDLE_REQUEST.additionalAssets).toBe(beforeAdditionals);
      // Length preserved (no splice).
      expect(NFT_BUNDLE_REQUEST.additionalAssets!.length).toBe(beforeLength);
      // The NFT entry is still the first (and only) additional asset.
      expect(NFT_BUNDLE_REQUEST.additionalAssets![0]).toBe(beforeFirstEntry);
      expect(NFT_BUNDLE_REQUEST.additionalAssets![0]).toEqual({
        kind: 'nft',
        tokenId: '0xabc123',
      });
    });

    it('warning carries the recipient transport pubkey for UI correlation', async () => {
      await callCheck(harness.module, NFT_BUNDLE_REQUEST);
      const data = harness.events[0]!.data as Record<string, unknown>;
      expect(data.recipientTransportPubkey).toBe('a'.repeat(64));
    });
  });

  describe('peer omits assetKinds entirely (W20 default applies — older v1.0 wallet)', () => {
    beforeEach(() => {
      // No `assetKinds` field on the wire — W20 says default to ['coin'].
      const resolveResult = buildPeerInfo({});
      harness = createModule({ resolveResult });
    });

    it('still emits a warning for the NFT entry — W20 default is the same as explicit [coin]', async () => {
      await callCheck(harness.module, NFT_BUNDLE_REQUEST);

      expect(harness.events.length).toBe(1);
      const data = harness.events[0]!.data as Record<string, unknown>;
      expect(data.mismatchedAssetKinds).toEqual(['nft']);
      // recipientAssetKinds carries the W20 default — diagnostic clarity.
      expect(data.recipientAssetKinds).toEqual(['coin']);
      // No wireProtocols field on the wire either ⇒ no negative claim.
      expect(data.recipientWireProtocols).toBeUndefined();
      expect(data.wireProtocolMismatch).toBe(false);
    });

    it('does NOT auto-strip the NFT entry under the W20 default either', async () => {
      const beforeAdditionals = NFT_BUNDLE_REQUEST.additionalAssets;
      await callCheck(harness.module, NFT_BUNDLE_REQUEST);
      expect(NFT_BUNDLE_REQUEST.additionalAssets).toBe(beforeAdditionals);
      expect(NFT_BUNDLE_REQUEST.additionalAssets![0].kind).toBe('nft');
    });
  });
});

// =============================================================================
// 3. Negative cases — capability-mismatched peers do NOT block the send
// =============================================================================

describe('Capability hint warning — does not block the dispatcher', () => {
  it('a coin-only outbound to a coin-only peer produces NO warning', async () => {
    const resolveResult = buildPeerInfo({
      wireProtocols: ['uxf-car', 'uxf-cid', 'txf'],
      assetKinds: ['coin'],
    });
    const harness = createModule({ resolveResult });

    const COIN_ONLY_REQUEST: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000000',
    };
    await callCheck(harness.module, COIN_ONLY_REQUEST);
    // Both axes match → no warning.
    expect(harness.events.length).toBe(0);
  });

  it('emits a warning even on TXF mode (legacy wire) when peer is coin-only and NFT shipped', async () => {
    // Even when the sender opts into legacy `txf` mode (where the wire
    // shape doesn't carry NFTs natively in a single event — txf-sender.ts
    // ships per-token), the helper still inspects the request's full
    // asset profile. The receiver-side reject is the authoritative
    // guarantee; the warning is a UX affordance.
    const resolveResult = buildPeerInfo({
      wireProtocols: ['txf'],
      assetKinds: ['coin'],
    });
    const harness = createModule({ resolveResult, senderUxf: false });

    await callCheck(harness.module, NFT_BUNDLE_REQUEST, 'txf');

    expect(harness.events.length).toBe(1);
    const data = harness.events[0]!.data as Record<string, unknown>;
    expect(data.mismatchedAssetKinds).toEqual(['nft']);
    // outboundWireProtocol resolves to 'txf' here (senderUxf=false +
    // mode='txf' both push to the legacy single-token wire shape).
    expect(data.outboundWireProtocol).toBe('txf');
    // wireProtocols match — no protocol axis warning.
    expect(data.wireProtocolMismatch).toBe(false);
  });
});
