/**
 * Tests for profile/manifest-cas.ts — UXF Transfer Protocol §5.5 step 9.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ManifestCas,
  ManifestCasConcurrentModificationError,
  type MinimalManifestStorage,
} from '../../../profile/manifest-cas';
import type {
  TokenManifestEntry,
  TokenManifestStatus,
} from '../../../profile/token-manifest';
import type { ContentHash } from '../../../extensions/uxf/bundle/types';

/** In-memory MinimalManifestStorage backed by a Map keyed `${addr}|${tokenId}`. */
class FakeManifestStorage implements MinimalManifestStorage {
  private readonly store = new Map<string, TokenManifestEntry>();
  /** Inject a one-shot concurrent-modification error on the next write. */
  throwOnNextWrite: ManifestCasConcurrentModificationError | Error | null = null;

  private k(addr: string, tokenId: string): string {
    return `${addr}|${tokenId}`;
  }

  async readEntry(
    addr: string,
    tokenId: string,
  ): Promise<TokenManifestEntry | undefined> {
    return this.store.get(this.k(addr, tokenId));
  }

  async writeEntry(
    addr: string,
    tokenId: string,
    entry: TokenManifestEntry,
  ): Promise<void> {
    if (this.throwOnNextWrite !== null) {
      const e = this.throwOnNextWrite;
      this.throwOnNextWrite = null;
      throw e;
    }
    this.store.set(this.k(addr, tokenId), entry);
  }

  /** Test helper. */
  setRaw(addr: string, tokenId: string, entry: TokenManifestEntry): void {
    this.store.set(this.k(addr, tokenId), entry);
  }
}

const ch = (s: string): ContentHash => s as ContentHash;

const makeEntry = (
  rootHash: string,
  status: TokenManifestStatus = 'valid',
): TokenManifestEntry => ({
  rootHash: ch(rootHash),
  status,
});

describe('ManifestCas', () => {
  let storage: FakeManifestStorage;
  let cas: ManifestCas;

  beforeEach(() => {
    storage = new FakeManifestStorage();
    cas = new ManifestCas(storage);
  });

  describe('insert (prev = null)', () => {
    it('succeeds when no entry exists', async () => {
      const next = makeEntry('hash-A');
      const result = await cas.update('addr1', 'tok1', null, next);
      expect(result).toEqual({ ok: true });
      expect(await storage.readEntry('addr1', 'tok1')).toEqual(next);
    });

    it('returns cas-mismatch when an entry already exists', async () => {
      storage.setRaw('addr1', 'tok1', makeEntry('hash-existing'));
      const next = makeEntry('hash-A');
      const result = await cas.update('addr1', 'tok1', null, next);
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toBe('cas-mismatch');
        expect(result.observed).toEqual({ contentHash: ch('hash-existing') });
      }
    });
  });

  describe('update (prev provided)', () => {
    it('happy path: prev hash matches → ok and writes next', async () => {
      storage.setRaw('addr1', 'tok1', makeEntry('hash-A'));
      const next = makeEntry('hash-B');
      const result = await cas.update(
        'addr1',
        'tok1',
        { contentHash: ch('hash-A') },
        next,
      );
      expect(result).toEqual({ ok: true });
      expect(await storage.readEntry('addr1', 'tok1')).toEqual(next);
    });

    it('cas-mismatch: observed differs from prev', async () => {
      storage.setRaw('addr1', 'tok1', makeEntry('hash-actual'));
      const next = makeEntry('hash-B');
      const result = await cas.update(
        'addr1',
        'tok1',
        { contentHash: ch('hash-expected') },
        next,
      );
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toBe('cas-mismatch');
        expect(result.observed).toEqual({ contentHash: ch('hash-actual') });
      }
      // Storage NOT mutated.
      expect(await storage.readEntry('addr1', 'tok1')).toEqual(
        makeEntry('hash-actual'),
      );
    });

    it('not-found: prev provided but no entry exists', async () => {
      const next = makeEntry('hash-B');
      const result = await cas.update(
        'addr1',
        'tok1',
        { contentHash: ch('hash-A') },
        next,
      );
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toBe('not-found');
        expect((result as { observed?: unknown }).observed).toBeUndefined();
      }
      expect(await storage.readEntry('addr1', 'tok1')).toBeUndefined();
    });
  });

  describe('concurrent-modification on write', () => {
    it('translates ManifestCasConcurrentModificationError to structured outcome', async () => {
      storage.setRaw('addr1', 'tok1', makeEntry('hash-A'));
      storage.throwOnNextWrite = new ManifestCasConcurrentModificationError();
      const next = makeEntry('hash-B');
      const result = await cas.update(
        'addr1',
        'tok1',
        { contentHash: ch('hash-A') },
        next,
      );
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toBe('concurrent-modification');
      }
    });

    it('also accepts duck-typed __manifestCasConflict error brand', async () => {
      storage.setRaw('addr1', 'tok1', makeEntry('hash-A'));
      const branded = Object.assign(new Error('crdt write conflict'), {
        __manifestCasConflict: true as const,
      });
      storage.throwOnNextWrite = branded;
      const next = makeEntry('hash-B');
      const result = await cas.update(
        'addr1',
        'tok1',
        { contentHash: ch('hash-A') },
        next,
      );
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toBe('concurrent-modification');
      }
    });

    it('propagates non-CAS storage errors', async () => {
      storage.setRaw('addr1', 'tok1', makeEntry('hash-A'));
      storage.throwOnNextWrite = new Error('disk full');
      const next = makeEntry('hash-B');
      await expect(
        cas.update(
          'addr1',
          'tok1',
          { contentHash: ch('hash-A') },
          next,
        ),
      ).rejects.toThrow('disk full');
    });
  });

  describe('per-instance scoping', () => {
    it('two ManifestCas instances on different storages are independent', async () => {
      const sA = new FakeManifestStorage();
      const sB = new FakeManifestStorage();
      const casA = new ManifestCas(sA);
      const casB = new ManifestCas(sB);

      await casA.update('addr', 'tok', null, makeEntry('hashA'));
      // casB sees no entry — independent state.
      const bResult = await casB.update('addr', 'tok', null, makeEntry('hashB'));
      expect(bResult).toEqual({ ok: true });

      expect((await sA.readEntry('addr', 'tok'))?.rootHash).toBe(ch('hashA'));
      expect((await sB.readEntry('addr', 'tok'))?.rootHash).toBe(ch('hashB'));
    });
  });
});
