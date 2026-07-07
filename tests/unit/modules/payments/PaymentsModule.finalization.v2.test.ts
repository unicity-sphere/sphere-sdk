/**
 * PaymentsModule finalization semantics — Phase 6 v2 slim rebuild coverage.
 *
 * v2 collapses v1's async finalization pipeline: `submitCertificationRequest`
 * is now atomic and receive-side tokens arrive already-verifiable. The slim
 * rebuild therefore has NO finalization workers, NO pending-recovery loop,
 * NO proof-polling. The receive path is:
 *
 *     handler → decode → isOwnedBy → verify → addTokenInternal (confirmed)
 *
 * This suite locks in that contract on the branches the wave 6-P2-7
 * receive.v2 suite did NOT touch:
 *
 *   - Tokens accepted via handler land as `'confirmed'` (not `'pending'`
 *     or `'unconfirmed'`).
 *   - `verify()` returning `{ok:false}` blocks the token (no wallet
 *     mutation, no event, no history entry).
 *   - `receive()` and `receive({finalize:true})` both return an empty
 *     transfers array (the rendezvous point is a no-op in v2 slim).
 *   - `resolveUnconfirmed()` returns 0/0/0 unconditionally.
 *   - `waitForPendingOperations()` resolves immediately.
 *   - The receive path is idempotent — replay of the SAME token is a
 *     no-op on the wallet, and a subsequent `transfer:incoming` is not
 *     emitted for the replay.
 *   - Wave 6-P2-6c: memo propagates from payload → IncomingTransfer.memo.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
      getSymbol: (id: string) => id,
      getName: (id: string) => id,
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  buildIncomingTransfer,
  DEFAULT_SENDER_PUBKEY,
  makeV2Harness,
  resetTokenSeq,
} from './__fixtures__/v2-harness';
import type { IncomingTransfer } from '../../../../types';

describe('PaymentsModule finalization (v2 slim)', () => {
  beforeEach(() => {
    resetTokenSeq();
  });

  it('received token lands as confirmed (v2 has no pending finalization step)', async () => {
    const h = await makeV2Harness();
    await h.handler(buildIncomingTransfer(DEFAULT_SENDER_PUBKEY, { amount: 42n }));

    const tokens = h.module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe('confirmed');
    expect(tokens[0].amount).toBe('42');
  });

  it('verify() rejection blocks the token entirely (no event, no history, no wallet mutation)', async () => {
    const h = await makeV2Harness({
      verifyResult: { ok: false, reason: 'proof-invalid' },
    });
    const durable = await h.handler(
      buildIncomingTransfer(DEFAULT_SENDER_PUBKEY, { amount: 100n }),
    );
    // Handler still returns true (the event was processed), but the wallet
    // is untouched and no event fires.
    expect(durable).toBe(true);
    expect(h.module.getTokens()).toHaveLength(0);
    expect(h.module.getHistory()).toHaveLength(0);
    expect(h.events.find((e) => e.type === 'transfer:incoming')).toBeUndefined();
  });

  it('receive() returns an empty transfers array (v2 slim rendezvous)', async () => {
    const h = await makeV2Harness();
    // Even after real events land, receive() itself does not surface them —
    // it's a rendezvous point that returns empty in the slim rebuild.
    await h.handler(buildIncomingTransfer(DEFAULT_SENDER_PUBKEY));
    const r = await h.module.receive();
    expect(r.transfers).toEqual([]);
  });

  it('receive({finalize:true}) also returns an empty transfers array', async () => {
    const h = await makeV2Harness();
    const r = await h.module.receive({ finalize: true });
    expect(r.transfers).toEqual([]);
  });

  it('resolveUnconfirmed() returns 0/0/0 unconditionally (no pending machinery)', async () => {
    const h = await makeV2Harness();
    // Seed some received tokens.
    await h.handler(buildIncomingTransfer(DEFAULT_SENDER_PUBKEY));
    await h.handler(
      buildIncomingTransfer(DEFAULT_SENDER_PUBKEY, {
        eventId: 'nostr-2',
        amount: 50n,
      }),
    );
    // Slim rebuild reports nothing to resolve.
    const r = await h.module.resolveUnconfirmed();
    expect(r).toEqual({ resolved: 0, stillPending: 0, failed: 0, details: [] });
  });

  it('waitForPendingOperations() resolves without delay (no async pipeline)', async () => {
    const h = await makeV2Harness();
    const start = Date.now();
    await h.module.waitForPendingOperations();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('replay of the same token event is idempotent on the wallet', async () => {
    const h = await makeV2Harness();
    const event = buildIncomingTransfer(DEFAULT_SENDER_PUBKEY, { amount: 100n });

    await h.handler(event);
    const firstCount = h.module.getTokens().length;
    expect(firstCount).toBe(1);

    // Replay the SAME event. addTokenInternal dedupes by id, so no new
    // token, no second transfer:incoming for the same tokenId. History
    // MAY still get a second entry (no dedup on the receive path) — we
    // assert only the wallet-side idempotence.
    await h.handler(event);
    expect(h.module.getTokens()).toHaveLength(1);
  });

  it('memo propagates from payload → IncomingTransfer.memo (wave 6-P2-6c)', async () => {
    const h = await makeV2Harness();
    await h.handler(
      buildIncomingTransfer(DEFAULT_SENDER_PUBKEY, {
        memo: 'INV:abc123:F',
      }),
    );
    const incoming = h.events.find((e) => e.type === 'transfer:incoming');
    expect(incoming).toBeDefined();
    const payload = incoming!.data as IncomingTransfer;
    expect(payload.memo).toBe('INV:abc123:F');
  });

  it('finalization: multiple tokens in ONE event all land confirmed together', async () => {
    const h = await makeV2Harness();
    const event = buildIncomingTransfer(DEFAULT_SENDER_PUBKEY, {
      tokenCount: 3,
      amount: 25n,
    });
    await h.handler(event);
    const tokens = h.module.getTokens();
    expect(tokens).toHaveLength(3);
    tokens.forEach((t) => {
      expect(t.status).toBe('confirmed');
      expect(t.amount).toBe('25');
    });
    // Exactly one transfer:incoming event for the whole bundle.
    const incoming = h.events.filter((e) => e.type === 'transfer:incoming');
    expect(incoming).toHaveLength(1);
    const payload = incoming[0].data as IncomingTransfer;
    expect(payload.tokens).toHaveLength(3);
  });

  it('handler tolerates a token with a malformed CBOR blob (skips it, still durable)', async () => {
    const h = await makeV2Harness();
    // Build an incoming event, then corrupt the base64 CAR bytes.
    const good = buildIncomingTransfer(DEFAULT_SENDER_PUBKEY);
    const corrupted = {
      ...good,
      payload: {
        ...good.payload,
        carBase64: Buffer.from('not-valid-json').toString('base64'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    };
    const durable = await h.handler(corrupted);
    // No tokens in event → durable=true, no crash, no wallet mutation.
    expect(durable).toBe(true);
    expect(h.module.getTokens()).toHaveLength(0);
  });
});
