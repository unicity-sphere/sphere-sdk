/**
 * Tests for Audit #333 H7 — ManifestCas recompute-content gate.
 *
 * Background
 * ----------
 * Before the H7 fix, `ManifestCas.update`'s precondition check compared
 * `observed.rootHash` (a string read from the entry) to
 * `prev.contentHash` (the caller's expected value). Both sides are
 * arbitrary writer-supplied labels — a CAS pass meant "the labels
 * agree", not "the content under the label is the content the caller
 * meant". An attacker writing an entry with a forged `rootHash` field
 * that doesn't match the actual pool content slipped through unchanged.
 *
 * Fix
 * ---
 *   - New optional `VerifyEntryRootFn` hook accepted via the
 *     `ManifestCas` constructor's `opts.verifyEntryRoot`.
 *   - When wired, the hook is invoked AFTER the label CAS passes and
 *     BEFORE the write. The hook fetches the content under the
 *     entry's `rootHash` (production: the UXF pool element),
 *     recomputes the hash, and asserts it matches the declaration.
 *   - On `{ ok: false }`, `update()` returns
 *     `{ ok: false, reason: 'integrity-failed', integrityDetail }`.
 *   - Optional — when omitted the CAS retains its pre-fix label-only
 *     semantics for back-compat with existing tests.
 *   - `ManifestCidRewriteCasError` widened to surface
 *     `'integrity-failed'` in its `casReason` field so the worker's
 *     outer retry loop sees the new reason as a hard CAS failure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ManifestCas,
  type MinimalManifestStorage,
  type VerifyEntryRootFn,
} from '../../../profile/manifest-cas';
import type { TokenManifestEntry } from '../../../profile/token-manifest';

// ---------------------------------------------------------------------------
// Minimal in-memory storage adapter (same shape as the existing tests
// use; intentionally self-contained so future refactors of the broader
// test file don't disturb this regression surface).
// ---------------------------------------------------------------------------

function makeMemoryStorage(): MinimalManifestStorage & {
  _map: Map<string, TokenManifestEntry>;
} {
  const m = new Map<string, TokenManifestEntry>();
  return {
    _map: m,
    async readEntry(addr: string, tokenId: string) {
      return m.get(`${addr}/${tokenId}`);
    },
    async writeEntry(addr: string, tokenId: string, entry: TokenManifestEntry) {
      m.set(`${addr}/${tokenId}`, entry);
    },
  };
}

const ADDR = 'DIRECT_aabbcc';
const TOKEN_ID = 'aa'.repeat(32);
const PREVIOUS_HASH = 'cc'.repeat(32);
const NEXT_HASH = 'dd'.repeat(32);

function makeEntry(rootHash: string): TokenManifestEntry {
  return { rootHash, status: 'valid' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit #333 H7 — ManifestCas recompute integrity', () => {
  let storage: ReturnType<typeof makeMemoryStorage>;

  beforeEach(() => {
    storage = makeMemoryStorage();
  });

  describe('verifyEntryRoot OMITTED (back-compat — label-only CAS)', () => {
    it('succeeds when the label CAS matches (no integrity check)', async () => {
      storage._map.set(`${ADDR}/${TOKEN_ID}`, makeEntry(PREVIOUS_HASH));
      const cas = new ManifestCas(storage);
      const result = await cas.update(
        ADDR,
        TOKEN_ID,
        { contentHash: PREVIOUS_HASH },
        makeEntry(NEXT_HASH),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('verifyEntryRoot wired — happy path', () => {
    it('calls the verifier AFTER label CAS and BEFORE write', async () => {
      storage._map.set(`${ADDR}/${TOKEN_ID}`, makeEntry(PREVIOUS_HASH));
      const calls: Array<{ stage: string }> = [];
      const verifier: VerifyEntryRootFn = async (a, t, entry) => {
        calls.push({ stage: 'verify' });
        expect(a).toBe(ADDR);
        expect(t).toBe(TOKEN_ID);
        expect(entry.rootHash).toBe(PREVIOUS_HASH);
        return { ok: true };
      };
      const proxied: MinimalManifestStorage = {
        readEntry: storage.readEntry.bind(storage),
        writeEntry: async (a, t, e) => {
          calls.push({ stage: 'write' });
          return storage.writeEntry(a, t, e);
        },
      };
      const cas = new ManifestCas(proxied, { verifyEntryRoot: verifier });
      const result = await cas.update(
        ADDR,
        TOKEN_ID,
        { contentHash: PREVIOUS_HASH },
        makeEntry(NEXT_HASH),
      );
      expect(result.ok).toBe(true);
      expect(calls).toEqual([{ stage: 'verify' }, { stage: 'write' }]);
    });
  });

  describe('verifyEntryRoot wired — integrity failure', () => {
    it('returns integrity-failed and does NOT write', async () => {
      storage._map.set(`${ADDR}/${TOKEN_ID}`, makeEntry(PREVIOUS_HASH));
      const verifier: VerifyEntryRootFn = async () => ({
        ok: false,
        reason: 'recomputed-hash-mismatch',
      });
      let writeCalled = false;
      const proxied: MinimalManifestStorage = {
        readEntry: storage.readEntry.bind(storage),
        writeEntry: async (a, t, e) => {
          writeCalled = true;
          return storage.writeEntry(a, t, e);
        },
      };
      const cas = new ManifestCas(proxied, { verifyEntryRoot: verifier });
      const result = await cas.update(
        ADDR,
        TOKEN_ID,
        { contentHash: PREVIOUS_HASH },
        makeEntry(NEXT_HASH),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return; // type narrowing
      expect(result.reason).toBe('integrity-failed');
      expect(result.observed?.contentHash).toBe(PREVIOUS_HASH);
      expect(result.integrityDetail).toBe('recomputed-hash-mismatch');
      // Critical: the write did NOT happen.
      expect(writeCalled).toBe(false);
      // And the storage is unchanged.
      expect(storage._map.get(`${ADDR}/${TOKEN_ID}`)).toEqual(
        makeEntry(PREVIOUS_HASH),
      );
    });
  });

  describe('verifyEntryRoot wired — skipped on prev=null path', () => {
    it('does NOT call the verifier when caller asserts no entry exists', async () => {
      let verifierCalled = false;
      const verifier: VerifyEntryRootFn = async () => {
        verifierCalled = true;
        return { ok: true };
      };
      const cas = new ManifestCas(storage, { verifyEntryRoot: verifier });
      const result = await cas.update(
        ADDR,
        TOKEN_ID,
        null,
        makeEntry(NEXT_HASH),
      );
      expect(result.ok).toBe(true);
      // No observed entry → nothing to verify integrity of.
      expect(verifierCalled).toBe(false);
    });
  });

  describe('verifyEntryRoot wired — skipped on label-CAS-mismatch', () => {
    it('does NOT call the verifier when the label CAS already failed', async () => {
      storage._map.set(`${ADDR}/${TOKEN_ID}`, makeEntry('FF'.repeat(32)));
      let verifierCalled = false;
      const verifier: VerifyEntryRootFn = async () => {
        verifierCalled = true;
        return { ok: true };
      };
      const cas = new ManifestCas(storage, { verifyEntryRoot: verifier });
      const result = await cas.update(
        ADDR,
        TOKEN_ID,
        { contentHash: PREVIOUS_HASH }, // doesn't match
        makeEntry(NEXT_HASH),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('cas-mismatch');
      // Verifier never ran — short-circuit on label mismatch.
      expect(verifierCalled).toBe(false);
    });
  });

  describe('integrity-failed reason has its own discriminator', () => {
    it('is structurally distinct from cas-mismatch / not-found / concurrent-modification', async () => {
      storage._map.set(`${ADDR}/${TOKEN_ID}`, makeEntry(PREVIOUS_HASH));
      const cas = new ManifestCas(storage, {
        verifyEntryRoot: async () => ({ ok: false, reason: 'forged' }),
      });
      const result = await cas.update(
        ADDR,
        TOKEN_ID,
        { contentHash: PREVIOUS_HASH },
        makeEntry(NEXT_HASH),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const otherReasons = [
        'cas-mismatch',
        'not-found',
        'concurrent-modification',
      ];
      expect(otherReasons).not.toContain(result.reason);
      expect(result.reason).toBe('integrity-failed');
    });
  });
});
