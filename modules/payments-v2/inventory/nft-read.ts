// §5.2 NFT reads (#785): a held token's genesis payload through the engine's
// never-throwing NFT reader, behind a facade-owned bounded LRU.

import { SphereError } from '../../../core/errors';
import { logger } from '../../../core/logger';
import type { ITokenEngine } from '../../../token-engine/engine';
import type { NftView } from '../api';
import type { StoragePort } from '../ports';

import type { InventoryView } from './InventoryView';

export const NFT_CACHE_MAX = 256;

/**
 * Token id → NFT reading, where `null` caches "not an NFT" so a list view never
 * refetches it. A genesis payload never changes for a token id, so no entry goes stale.
 */
export class NftCache {
  private readonly entries = new Map<string, NftView | null>();

  constructor(private readonly max = NFT_CACHE_MAX) {}

  /** `undefined` = not cached. A hit becomes the most recently used entry. */
  get(tokenId: string): NftView | null | undefined {
    const view = this.entries.get(tokenId);
    if (view === undefined) return undefined;
    this.entries.delete(tokenId);
    this.entries.set(tokenId, view);
    return view;
  }

  set(tokenId: string, view: NftView | null): void {
    this.entries.delete(tokenId);
    this.entries.set(tokenId, view);
    const oldest = this.entries.keys().next().value;
    if (this.entries.size > this.max && oldest !== undefined) this.entries.delete(oldest);
  }
}

export interface NftReadDeps {
  readonly engine: ITokenEngine;
  readonly view: Pick<InventoryView, 'stateHashOf'>;
  readonly storagePort: Pick<StoragePort, 'getBlobs'>;
  readonly cache: NftCache;
}

/** One held token read as an NFT; `null` = not a recognised NFT. */
export async function readNft(deps: NftReadDeps, tokenId: string): Promise<NftView | null> {
  if (deps.view.stateHashOf(tokenId) === undefined) {
    throw new SphereError(`Token ${tokenId} is not in inventory`, 'VALIDATION_ERROR');
  }
  const cached = deps.cache.get(tokenId);
  if (cached !== undefined) return cached;
  const bytes = (await deps.storagePort.getBlobs([tokenId])).get(tokenId);
  if (bytes === undefined) {
    throw new SphereError(`Token ${tokenId} has no blob in storage`, 'STORAGE_ERROR');
  }
  return decodeView(deps, tokenId, bytes);
}

/** Held ids read as NFTs, with ONE blob fetch for all cache misses. Anything unreadable is absent. */
export async function readNfts(
  deps: NftReadDeps,
  tokenIds: readonly string[]
): Promise<ReadonlyMap<string, NftView>> {
  const held = [...new Set(tokenIds)].filter((tokenId) => deps.view.stateHashOf(tokenId) !== undefined);
  const views = new Map<string, NftView | null>();
  const misses: string[] = [];
  for (const tokenId of held) {
    const cached = deps.cache.get(tokenId);
    if (cached === undefined) misses.push(tokenId);
    else views.set(tokenId, cached);
  }
  const blobs = misses.length > 0 ? await deps.storagePort.getBlobs(misses) : new Map<string, Uint8Array>();
  for (const tokenId of misses) {
    const bytes = blobs.get(tokenId);
    if (bytes !== undefined) views.set(tokenId, await decodeView(deps, tokenId, bytes).catch(() => null));
  }
  const out = new Map<string, NftView>();
  for (const tokenId of held) {
    const view = views.get(tokenId);
    if (view) out.set(tokenId, view);
  }
  return out;
}

/** Cached only once decoded: a blob that failed to decode is re-read next time, not remembered as "not an NFT". */
async function decodeView(deps: NftReadDeps, tokenId: string, bytes: Uint8Array): Promise<NftView | null> {
  let view: NftView | null;
  try {
    const token = await deps.engine.decodeToken({ tokenId, token: bytes });
    if (token.blob.tokenId !== tokenId) {
      throw new SphereError(`the blob served for ${tokenId} decodes as ${token.blob.tokenId}`, 'STORAGE_ERROR');
    }
    const reading = await deps.engine.readNft(token);
    view = reading === null ? null : { tokenId, ...reading };
  } catch (err) {
    logger.warn('PaymentsV2', `NFT read: token ${tokenId} did not decode — ${String(err)}`);
    throw err;
  }
  deps.cache.set(tokenId, view);
  return view;
}
