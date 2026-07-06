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

/**
 * Materialize a blockstore-fs / blockstore-idb v4 `get()` return value
 * (Generator | AsyncGenerator of Uint8Array chunks) into a single
 * `Uint8Array`. Falls through unchanged if the underlying store already
 * returns a plain `Uint8Array` (older versions / mocks).
 */
export async function concatChunks(
  input:
    | Uint8Array
    | Generator<Uint8Array>
    | AsyncGenerator<Uint8Array>
    | Iterable<Uint8Array>
    | AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of input as AsyncIterable<Uint8Array>) {
    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    chunks.push(view);
    total += view.byteLength;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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
        const chunks = bs.get(cid);
        // blockstore v4 returns Generator|AsyncGenerator<Uint8Array>; the
        // HeliaLike consumers expect a single Uint8Array, so materialize.
        return concatChunks(chunks);
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
