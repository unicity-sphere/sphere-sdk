/**
 * FlagStore — durable key-value primitives for the pointer layer (T-B1).
 *
 * Wraps a StorageProvider and enforces:
 *   - Per-wallet key scoping (all keys prefixed by hex(signingPubKey))
 *   - Durability contract: IndexedDB transaction.oncomplete / fsync
 *   - AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME on backends that cannot guarantee
 *     durability (detected at init via `isDurable()` capability flag)
 *
 * SPEC §7.1.2, §7.1.3.
 */

import type { StorageProvider } from '../../../../storage/storage-provider.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';

/**
 * Optional capability marker.  Storage providers that guarantee write
 * durability (fsync / IndexedDB transaction.oncomplete) expose this symbol
 * as a property set to `true`.  Backends that omit it are treated as
 * non-durable and rejected at init.
 *
 * IMPORTANT: This is a module-local Symbol (NOT Symbol.for).  Only code that
 * imports `DURABLE_STORAGE` from this module can mark a backend durable.
 * A package using Symbol.for('aggregator-pointer:durable-storage') would get
 * a DIFFERENT symbol and cannot forge the durability claim.
 */
export const DURABLE_STORAGE = Symbol('aggregator-pointer:durable-storage');

export interface DurableStorageProvider extends StorageProvider {
  [DURABLE_STORAGE]: true;
}

export function isDurableProvider(sp: StorageProvider): sp is DurableStorageProvider {
  return (sp as unknown as Record<symbol, unknown>)[DURABLE_STORAGE] === true;
}

export class FlagStore {
  readonly #storage: StorageProvider;
  readonly #prefix: string; // "profile.pointer." (no trailing dot; keys add their own separator)

  private constructor(storage: StorageProvider, signingPubKeyHex: string) {
    this.#storage = storage;
    this.#prefix = `profile.pointer.${signingPubKeyHex}.`;
  }

  /**
   * Create a FlagStore for the given signing pubkey.
   *
   * Throws AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME if the storage backend
   * cannot guarantee durable writes per §7.1.3.
   */
  static create(storage: StorageProvider, signingPubKeyHex: string): FlagStore {
    if (!isDurableProvider(storage)) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.UNSUPPORTED_RUNTIME,
        `Storage backend does not guarantee durable writes (SPEC §7.1.3). ` +
          `Mark it with [DURABLE_STORAGE] = true only after verifying fsync/oncomplete semantics.`,
      );
    }
    if (!/^[0-9a-f]{66}$/.test(signingPubKeyHex)) {
      throw new RangeError(
        `signingPubKeyHex must be 66 lowercase hex chars (33-byte compressed secp256k1); got "${signingPubKeyHex}"`,
      );
    }
    return new FlagStore(storage, signingPubKeyHex);
  }

  /** Scoped key = prefix + localKey.  localKey must match /^[a-z][a-z0-9_]*$/. */
  scopedKey(localKey: string): string {
    if (!/^[a-z][a-z0-9_]*$/.test(localKey)) {
      throw new RangeError(
        `FlagStore: localKey "${localKey}" is invalid — must match /^[a-z][a-z0-9_]*$/`,
      );
    }
    return this.#prefix + localKey;
  }

  async get(localKey: string): Promise<string | null> {
    return this.#storage.get(this.scopedKey(localKey));
  }

  async set(localKey: string, value: string): Promise<void> {
    return this.#storage.set(this.scopedKey(localKey), value);
  }

  async remove(localKey: string): Promise<void> {
    return this.#storage.remove(this.scopedKey(localKey));
  }

  async has(localKey: string): Promise<boolean> {
    return this.#storage.has(this.scopedKey(localKey));
  }
}
