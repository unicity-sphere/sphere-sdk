/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T.8.B — Sender-side capability hint check (PaymentsModule).
 *
 * The sender consults `peerInfo.wireProtocols` and `peerInfo.assetKinds`
 * BEFORE shipping a UXF bundle. When the outbound bundle's asset kinds or
 * wire protocol are not advertised by the peer, the sender emits
 * `transfer:capability-warning` and PROCEEDS UNCHANGED — the spec is
 * explicit that the warning is informational and the actual interop
 * guarantee comes from the receiver's T.2.B `UNKNOWN_ASSET_KIND` rule.
 *
 * Spec refs: §10.4 (capability hints — informational), W20 (assetKinds
 * absent ⇒ default ['coin']), T.2.B (receiver-side UNKNOWN_ASSET_KIND
 * reject — the actual interop guarantee).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentsModule } from '../../../modules/payments/PaymentsModule';
import type { PeerInfo, TransferRequest } from '../../../types';

// =============================================================================
// Helpers
// =============================================================================

interface CapturedEvent {
  readonly type: string;
  readonly data: unknown;
}

function createModule(opts: {
  resolveResult: PeerInfo | null;
  features?: { senderUxf?: boolean };
}) {
  const events: CapturedEvent[] = [];
  const transport = {
    resolve: vi.fn(async (_id: string) => opts.resolveResult),
  };
  const module = new PaymentsModule({
    features: { senderUxf: opts.features?.senderUxf ?? true },
  });
  // Inject just enough surface for `maybeEmitCapabilityWarning` to run.
  // The full PaymentsModule.initialize() is overkill — we exercise the
  // private helper directly.
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

const COIN_ONLY_REQUEST: TransferRequest = {
  recipient: '@bob',
  coinId: 'UCT',
  amount: '1000000',
};

const NFT_BUNDLE_REQUEST: TransferRequest = {
  recipient: '@bob',
  coinId: 'UCT',
  amount: '1000000',
  additionalAssets: [
    { kind: 'nft', tokenId: '0xabc123' },
  ],
};

// =============================================================================
// Tests
// =============================================================================

describe('T.8.B — PaymentsModule.maybeEmitCapabilityWarning', () => {
  let module: PaymentsModule;
  let events: CapturedEvent[];
  let transport: { resolve: ReturnType<typeof vi.fn> };

  describe('older peer (assetKinds absent) — W20 default applies', () => {
    beforeEach(() => {
      // Older v1.0 wallet — no capability fields on the wire.
      const resolveResult = buildPeerInfo({});
      ({ module, events, transport } = createModule({ resolveResult }));
    });

    it('emits transfer:capability-warning when sender ships an NFT entry', async () => {
      await callCheck(module, NFT_BUNDLE_REQUEST);

      expect(transport.resolve).toHaveBeenCalledWith('@bob');
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('transfer:capability-warning');
      const data = events[0].data as Record<string, unknown>;
      // W20: assetKinds absent on the wire ⇒ ['coin'] applied as recipient default.
      expect(data.recipientAssetKinds).toEqual(['coin']);
      expect(data.recipientWireProtocols).toBeUndefined();
      // Outbound carries both 'coin' (primary slot) and 'nft' (additionalAssets).
      expect(data.outboundAssetKinds).toEqual(expect.arrayContaining(['coin', 'nft']));
      // 'nft' is the mismatched kind.
      expect(data.mismatchedAssetKinds).toEqual(['nft']);
      // wireProtocols absent → no negative claim, mismatch=false.
      expect(data.wireProtocolMismatch).toBe(false);
    });

    it('does NOT emit when sender ships only coin assets (W20 default = [coin] is satisfied)', async () => {
      await callCheck(module, COIN_ONLY_REQUEST);

      // No mismatch, no warning.
      expect(events.length).toBe(0);
    });

    it('does NOT auto-strip the NFT entry — request remains unchanged', async () => {
      const beforeAdditionals = NFT_BUNDLE_REQUEST.additionalAssets;
      await callCheck(module, NFT_BUNDLE_REQUEST);
      // Reference identity preserved — no defensive copy, no mutation.
      expect(NFT_BUNDLE_REQUEST.additionalAssets).toBe(beforeAdditionals);
      expect(NFT_BUNDLE_REQUEST.additionalAssets!.length).toBe(1);
    });
  });

  describe('full-capability peer (advertises coin + nft + all wire protocols)', () => {
    beforeEach(() => {
      const resolveResult = buildPeerInfo({
        wireProtocols: ['uxf-car', 'uxf-cid', 'txf'],
        assetKinds: ['coin', 'nft'],
      });
      ({ module, events } = createModule({ resolveResult }));
    });

    it('does NOT emit a warning for an NFT bundle (everything advertised)', async () => {
      await callCheck(module, NFT_BUNDLE_REQUEST);
      expect(events.length).toBe(0);
    });

    it('does NOT emit a warning for a coin-only bundle either', async () => {
      await callCheck(module, COIN_ONLY_REQUEST);
      expect(events.length).toBe(0);
    });
  });

  describe('coin-only peer (assetKinds explicitly = [coin])', () => {
    beforeEach(() => {
      const resolveResult = buildPeerInfo({
        wireProtocols: ['uxf-car', 'uxf-cid', 'txf'],
        assetKinds: ['coin'],
      });
      ({ module, events } = createModule({ resolveResult }));
    });

    it('emits transfer:capability-warning for an NFT bundle (mismatch on nft)', async () => {
      await callCheck(module, NFT_BUNDLE_REQUEST);
      expect(events.length).toBe(1);
      const data = events[0].data as Record<string, unknown>;
      expect(data.recipientAssetKinds).toEqual(['coin']);
      expect(data.mismatchedAssetKinds).toEqual(['nft']);
      // Wire protocols match — wireProtocolMismatch=false.
      expect(data.wireProtocolMismatch).toBe(false);
    });
  });

  describe('wire protocol mismatch', () => {
    it('emits a warning when peer advertises only TXF and we send via uxf-cid (instant)', async () => {
      const resolveResult = buildPeerInfo({
        wireProtocols: ['txf'],
        assetKinds: ['coin', 'nft'],
      });
      ({ module, events } = createModule({ resolveResult, features: { senderUxf: true } }));

      // instant mode + senderUxf=true → outbound = 'uxf-cid'.
      await callCheck(module, COIN_ONLY_REQUEST, 'instant');

      expect(events.length).toBe(1);
      const data = events[0].data as Record<string, unknown>;
      expect(data.outboundWireProtocol).toBe('uxf-cid');
      expect(data.wireProtocolMismatch).toBe(true);
      // No asset-kind mismatch — only the protocol axis fired.
      expect(data.mismatchedAssetKinds).toEqual([]);
    });

    it('emits a warning when peer advertises only uxf-cid and we send via uxf-car (conservative)', async () => {
      const resolveResult = buildPeerInfo({
        wireProtocols: ['uxf-cid'],
        assetKinds: ['coin', 'nft'],
      });
      ({ module, events } = createModule({ resolveResult, features: { senderUxf: true } }));

      await callCheck(module, COIN_ONLY_REQUEST, 'conservative');

      expect(events.length).toBe(1);
      const data = events[0].data as Record<string, unknown>;
      expect(data.outboundWireProtocol).toBe('uxf-car');
      expect(data.wireProtocolMismatch).toBe(true);
    });

    it('does NOT emit when wireProtocols is absent (no negative claim)', async () => {
      const resolveResult = buildPeerInfo({
        // wireProtocols intentionally undefined — empty/absent on wire.
        assetKinds: ['coin', 'nft'],
      });
      ({ module, events } = createModule({ resolveResult, features: { senderUxf: true } }));

      await callCheck(module, COIN_ONLY_REQUEST, 'instant');

      // assetKinds covers everything; wireProtocols absent → no claim.
      expect(events.length).toBe(0);
    });
  });

  describe('feature-flag interaction with outbound wire protocol resolution', () => {
    it('resolves outbound wire protocol to "txf" when senderUxf=false (legacy single-token path)', async () => {
      const resolveResult = buildPeerInfo({
        wireProtocols: ['uxf-car', 'uxf-cid'],   // peer does NOT advertise TXF
        assetKinds: ['coin', 'nft'],
      });
      ({ module, events } = createModule({ resolveResult, features: { senderUxf: false } }));

      // senderUxf=false → all modes fall through to legacy 'txf' wire shape.
      await callCheck(module, COIN_ONLY_REQUEST, 'instant');

      expect(events.length).toBe(1);
      const data = events[0].data as Record<string, unknown>;
      expect(data.outboundWireProtocol).toBe('txf');
      expect(data.wireProtocolMismatch).toBe(true);
    });
  });

  describe('peer not resolvable', () => {
    it('does NOT emit a warning when transport.resolve returns null', async () => {
      ({ module, events } = createModule({ resolveResult: null }));
      await callCheck(module, NFT_BUNDLE_REQUEST);
      // No peer info → no claims to compare against → no warning. The
      // dispatcher will surface its own error if the recipient is unknown.
      expect(events.length).toBe(0);
    });

    it('swallows resolve errors silently (capability hints are best-effort)', async () => {
      const transport = {
        resolve: vi.fn(async () => {
          throw new Error('network down');
        }),
      };
      const module = new PaymentsModule({ features: { senderUxf: true } });
      const events: CapturedEvent[] = [];
      (module as any).deps = {
        transport,
        emitEvent: (type: string, data: unknown) => events.push({ type, data }),
      };

      // Must not throw and must not emit a spurious warning.
      await expect(
        (module as any).maybeEmitCapabilityWarning(NFT_BUNDLE_REQUEST, 'instant'),
      ).resolves.toBeUndefined();
      expect(events.length).toBe(0);
    });
  });

  describe('explicitly-empty peer assetKinds (peer advertised the field as empty)', () => {
    it('treats empty as a strong "supports nothing" signal (every outbound kind mismatches)', async () => {
      const resolveResult = buildPeerInfo({
        wireProtocols: ['uxf-car', 'uxf-cid', 'txf'],
        assetKinds: [],
      });
      ({ module, events } = createModule({ resolveResult, features: { senderUxf: true } }));

      await callCheck(module, NFT_BUNDLE_REQUEST);

      expect(events.length).toBe(1);
      const data = events[0].data as Record<string, unknown>;
      // Empty advertised set → both 'coin' and 'nft' mismatch.
      expect(data.recipientAssetKinds).toEqual([]);
      expect(data.mismatchedAssetKinds).toEqual(expect.arrayContaining(['coin', 'nft']));
      expect((data.mismatchedAssetKinds as string[]).length).toBe(2);
    });
  });
});
