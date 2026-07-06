/**
 * LocalBlockCacheBrowser — thin `{ get, put, has }` blockstore adapter
 * over `blockstore-idb` for use as the local CAR block cache under
 * `ipfs-client.ts` in browser runtimes.
 *
 * Replaces the Helia + browser blockstore-idb shim stack. `ipfs-client.ts`
 * already types its dependency structurally as `{ blockstore: { get, put,
 * has? } }`, so this class satisfies that contract directly.
 *
 * @module extensions/uxf/profile/kv/local-block-cache-browser
 */

import type { CID } from 'multiformats/cid';
import { IDBBlockstore } from 'blockstore-idb';

import { logger } from '../../../../core/logger.js';
import type { LocalBlockCacheFacade } from './local-block-cache-node.js';

export interface LocalBlockCacheBrowserOptions {
  /** IndexedDB database name for the blockstore. */
  readonly dbName: string;
}

/**
 * Browser blockstore adapter — lazy-opens the underlying `blockstore-idb`.
 */
export class LocalBlockCacheBrowser implements LocalBlockCacheFacade {
  private readonly dbName: string;
  private inner: IDBBlockstore | null = null;
  private opening: Promise<IDBBlockstore> | null = null;

  constructor(opts: LocalBlockCacheBrowserOptions) {
    this.dbName = opts.dbName;
  }

  private async ensureOpen(): Promise<IDBBlockstore> {
    if (this.inner) return this.inner;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const bs = new IDBBlockstore(this.dbName);
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
            'LocalBlockCacheBrowser',
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
          'LocalBlockCacheBrowser',
          `close: ignored error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.inner = null;
  }
}
