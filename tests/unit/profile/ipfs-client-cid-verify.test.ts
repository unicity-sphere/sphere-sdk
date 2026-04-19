/**
 * Tests for CID content-address verification in profile/ipfs-client.ts.
 *
 * Without encryption on CAR payloads, the CID check is the only
 * authentication between "bytes I pinned" and "bytes a gateway hands
 * back". These tests prove the verifier catches tampered bytes, rejects
 * unsupported multihashes, and accepts legitimate content.
 */

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';
import { verifyCidMatchesBytes, fetchFromIpfs } from '../../../profile/ipfs-client';
import { ProfileError } from '../../../profile/errors';

function cidForBytes(bytes: Uint8Array): string {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest).toString();
}

describe('verifyCidMatchesBytes', () => {
  it('accepts matching bytes', () => {
    const bytes = new TextEncoder().encode('hello unicity');
    const cid = cidForBytes(bytes);
    expect(() => verifyCidMatchesBytes(cid, bytes)).not.toThrow();
  });

  it('rejects tampered bytes', () => {
    const original = new TextEncoder().encode('hello unicity');
    const cid = cidForBytes(original);
    const tampered = new TextEncoder().encode('hello adversary');
    expect(() => verifyCidMatchesBytes(cid, tampered)).toThrow(ProfileError);
  });

  it('rejects truncated bytes', () => {
    const original = new TextEncoder().encode('hello unicity');
    const cid = cidForBytes(original);
    expect(() => verifyCidMatchesBytes(cid, original.slice(0, 5))).toThrow(ProfileError);
  });

  it('rejects unparseable CID', () => {
    expect(() => verifyCidMatchesBytes('not-a-cid', new Uint8Array())).toThrow(ProfileError);
  });

  it('rejects unsupported multihash (non-sha256)', () => {
    // Build a CID with a fake multihash code (0x16 = sha3-256) so the
    // verifier's code-check fires. We don't actually compute sha3 here —
    // verifier rejects before digest comparison.
    const fakeDigest = createDigest(0x16, new Uint8Array(32));
    const cid = CID.createV1(raw.code, fakeDigest).toString();
    expect(() => verifyCidMatchesBytes(cid, new Uint8Array())).toThrow(ProfileError);
  });
});

describe('fetchFromIpfs CID verification (integration with fetch mock)', () => {
  const originalFetch = globalThis.fetch;

  function mockOnce(handler: (url: string) => Promise<Response>) {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as { url?: string }).url ?? String(input);
      return handler(url);
    };
  }

  it('rejects when gateway returns mismatched bytes (multi-gateway path tries all, then fails)', async () => {
    const good = new TextEncoder().encode('good bytes');
    const cid = cidForBytes(good);
    const evil = new TextEncoder().encode('evil tampered bytes');

    mockOnce(async (_url) => new Response(evil, { status: 200 }));
    try {
      await expect(
        fetchFromIpfs(['https://gateway.test'], cid, 1000),
      ).rejects.toThrow(ProfileError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts matching bytes', async () => {
    const bytes = new TextEncoder().encode('valid content');
    const cid = cidForBytes(bytes);

    mockOnce(async (_url) => new Response(bytes, { status: 200 }));
    try {
      const result = await fetchFromIpfs(['https://gateway.test'], cid, 1000);
      expect(new TextDecoder().decode(result)).toBe('valid content');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('multi-gateway fallback tries the next gateway when the first returns tampered bytes', async () => {
    // Regression test for steelman finding: CID-mismatch ProfileError
    // must NOT short-circuit the multi-gateway loop. A single
    // malicious/misbehaving gateway should not DoS the request when
    // another gateway can serve correct bytes.
    const good = new TextEncoder().encode('good content');
    const cid = cidForBytes(good);
    const evil = new TextEncoder().encode('tampered payload');

    mockOnce(async (url: string) => {
      if (url.includes('gateway-evil.test')) {
        return new Response(evil, { status: 200 });
      }
      if (url.includes('gateway-good.test')) {
        return new Response(good, { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    try {
      const result = await fetchFromIpfs(
        ['https://gateway-evil.test', 'https://gateway-good.test'],
        cid,
        1000,
      );
      // Must have fallen through to the second gateway.
      expect(new TextDecoder().decode(result)).toBe('good content');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails with a clear error when ALL gateways return tampered bytes', async () => {
    const good = new TextEncoder().encode('good content');
    const cid = cidForBytes(good);

    mockOnce(async (_url) => new Response(new TextEncoder().encode('bad'), { status: 200 }));
    try {
      await expect(
        fetchFromIpfs(['https://g1.test', 'https://g2.test'], cid, 1000),
      ).rejects.toThrow(ProfileError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
