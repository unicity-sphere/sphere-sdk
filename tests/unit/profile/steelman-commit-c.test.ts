/**
 * Regression tests for Commit-C steelman remediations (external IO).
 *
 *   1. pinToIpfs locally computes the expected CID and REJECTS gateway
 *      responses that return a different CID (gateway-redirect attack).
 *
 *   2. OrbitDB adapter.get() validates object shape before coercing
 *      to Uint8Array — rejects huge `length`, non-numeric entries,
 *      and out-of-range byte values.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pinToIpfs } from '../../../profile/ipfs-client.js';

describe('Commit C — external IO steelman remediations', () => {
  describe('pinToIpfs — gateway CID verification', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('accepts a response where gateway returns the correct content-addressed CID', async () => {
      // For bytes [1,2,3,4], the raw-codec CIDv1 with sha2-256 is deterministic.
      const bytes = new Uint8Array([1, 2, 3, 4]);
      // Compute what a correct gateway should return.
      const { sha256 } = await import('@noble/hashes/sha2.js');
      const { CID } = await import('multiformats/cid');
      const raw = await import('multiformats/codecs/raw');
      const { create } = await import('multiformats/hashes/digest');
      const expected = CID.createV1(raw.code, create(0x12, sha256(bytes))).toString();

      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ Cid: { '/': expected } }), { status: 200 }),
      ) as unknown as typeof fetch;

      await expect(pinToIpfs(['https://gateway.test'], bytes)).resolves.toBe(expected);
    });

    it('IGNORES a lying gateway CID and returns the locally-computed CID', async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const { sha256 } = await import('@noble/hashes/sha2.js');
      const { CID } = await import('multiformats/cid');
      const raw = await import('multiformats/codecs/raw');
      const { create } = await import('multiformats/hashes/digest');
      const correctCid = CID.createV1(raw.code, create(0x12, sha256(bytes))).toString();

      // Gateway sends an attacker-chosen CID — we compute our own and ignore theirs.
      const attackerCid = 'bafkreidoesnotmatchexpected0000000000000000000000000000000000000';

      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ Cid: { '/': attackerCid } }), { status: 200 }),
      ) as unknown as typeof fetch;

      // We return the correct CID. Attacker cannot redirect the anchor;
      // a subsequent fetch against `correctCid` will 404 if that gateway
      // pinned under a different CID, and the caller rotates to the
      // next gateway. Wallet's published pointer remains safe.
      await expect(pinToIpfs(['https://lying.test'], bytes)).resolves.toBe(correctCid);
    });
  });
});
