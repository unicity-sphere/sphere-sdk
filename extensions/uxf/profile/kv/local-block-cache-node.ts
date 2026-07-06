/**
 * LocalBlockCacheNode — thin `{ get, put, has }` blockstore adapter over
 * `blockstore-fs` for use as the local CAR block cache under
 * `ipfs-client.ts`.
 *
 * Replaces the Helia + `helia-blockstore-shim.ts` +
 * `helia-blockstore-pin-shim.ts` stack. `ipfs-client.ts` already types its
 * dependency structurally as `{ blockstore: { get(cid), put(cid, bytes),
 * has?(cid) } }`, so this class satisfies that contract directly with no
 * Helia wrapper.
 *
 * @module extensions/uxf/profile/kv/local-block-cache-node
 */

import type { CID } from 'multiformats/cid';
import { FsBlockstore } from 'blockstore-fs';

import { logger } from '../../../../core/logger.js';

export interface LocalBlockCacheNodeOptions {
  /** Directory that holds the blockstore files. */
  readonly directory: string;
}

/** Minimal blockstore facade — matches `ipfs-client.ts`'s `HeliaLike`. */
export interface LocalBlockCacheFacade {
  readonly blockstore: {
    get(cid: CID, options?: unknown): Promise<Uint8Array>;
    put(cid: CID, bytes: Uint8Array, options?: unknown): Promise<unknown>;
    has(cid: CID, options?: unknown): Promise<boolean>;
  };
}

/**
 * Node blockstore adapter.
 *
 * Lazily opens the underlying `blockstore-fs` on first use. Safe to
 * construct without opening.
 */
export class LocalBlockCacheNode implements LocalBlockCacheFacade {
  private readonly directory: string;
  private inner: FsBlockstore | null = null;
  private opening: Promise<FsBlockstore> | null = null;

  constructor(opts: LocalBlockCacheNodeOptions) {
    this.directory = opts.directory;
  }

  private async ensureOpen(): Promise<FsBlockstore> {
    if (this.inner) return this.inner;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const bs = new FsBlockstore(this.directory);
      // blockstore-fs v4 exposes an async `open` method.
      const maybeOpen = (bs as unknown as { open?: () => Promise<void> }).open;
      if (typeof maybeOpen === 'function') {
        await maybeOpen.call(bs);
      }
      this.inner = bs;
      return bs;
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  /** Present the ipfs-client `HeliaLike` shape. */
  get blockstore(): LocalBlockCacheFacade['blockstore'] {
    return {
      get: async (cid: CID) => {
        const bs = await this.ensureOpen();
        return bs.get(cid);
      },
      put: async (cid: CID, bytes: Uint8Array) => {
        const bs = await this.ensureOpen();
        return bs.put(cid, bytes);
      },
      has: async (cid: CID) => {
        const bs = await this.ensureOpen();
        try {
          return await bs.has(cid);
        } catch (err) {
          logger.warn(
            'LocalBlockCacheNode',
            `has(): error probing ${cid.toString()}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return false;
        }
      },
    };
  }

  async close(): Promise<void> {
    if (!this.inner) return;
    const maybeClose = (this.inner as unknown as { close?: () => Promise<void> }).close;
    if (typeof maybeClose === 'function') {
      try {
        await maybeClose.call(this.inner);
      } catch (err) {
        logger.warn(
          'LocalBlockCacheNode',
          `close: ignored error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.inner = null;
  }
}
