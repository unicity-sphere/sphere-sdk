/**
 * Manifest compare-and-swap helper — UXF Transfer Protocol §5.5 step 9.
 *
 * Provides a typed CAS primitive over a manifest entry's content hash,
 * implementing the protocol's preferred lock-vs-RPC strategy:
 *
 * > **CAS-based** (preferred): no lock is held; each transition is a
 * > compare-and-swap on the manifest entry's content hash. Conflicts
 * > surface as CAS failure → retry from the latest state. Works
 * > correctly across slow RPCs because no global lock is held.
 *
 * **Storage-backend abstraction**: the §5.5 step 9 path needs to read
 * the current manifest entry, compare its content hash to a snapshot
 * that the worker captured before issuing slow RPCs, and swap in the
 * new entry only if the hash matches. The actual OrbitDB read/write
 * is provided by an injected `MinimalManifestStorage`. T.5.C will
 * adapt this interface to the live `ProfileTokenStorageProvider` /
 * `OrbitDbAdapter`.
 *
 * **Per-instance scoping**: this class holds NO module-level state.
 * Each `Sphere` constructs its own `ManifestCas` with its own injected
 * storage. Destroy-recreate is safe.
 */

import type { ContentHash } from '../uxf/types';
import type { TokenManifestEntry } from './token-manifest';

/**
 * Minimal abstraction over manifest entry storage required by
 * `ManifestCas`. T.5.C will adapt the live provider (e.g. an
 * `OrbitDbAdapter`-backed manifest store) to this interface.
 *
 * **Why a minimal local interface vs. reaching into existing
 * providers?** The §5.5 step 9 CAS path only needs two operations
 * (read, conditional-write). Pinning the contract here keeps T.5.C
 * free to evolve the provider's broader surface without breaking
 * the CAS implementation, and lets unit tests mock the backend
 * trivially.
 */
export interface MinimalManifestStorage {
  /**
   * Read the current manifest entry for `(addr, tokenId)`. Returns
   * `undefined` if no entry exists yet for this token under this
   * address (e.g. the first ingest). Implementations MUST observe
   * the latest committed value (no caching layered above the
   * underlying CRDT view).
   */
  readEntry(
    addr: string,
    tokenId: string,
  ): Promise<TokenManifestEntry | undefined>;

  /**
   * Unconditionally write a manifest entry for `(addr, tokenId)`.
   * `ManifestCas.update` ONLY calls this after confirming the CAS
   * precondition matches; this method itself does NOT enforce CAS.
   *
   * Implementations MAY surface OrbitDB-level write conflicts via
   * a thrown error; `ManifestCas.update` translates a thrown
   * `concurrent-modification`-tagged error into a structured CAS
   * failure outcome (see {@link ManifestCasConcurrentModificationError}).
   */
  writeEntry(
    addr: string,
    tokenId: string,
    entry: TokenManifestEntry,
  ): Promise<void>;
}

/**
 * Storage implementations may throw an instance of this class to
 * signal that the underlying CRDT detected a concurrent write. The
 * `ManifestCas.update` wrapper catches the brand and converts to the
 * structured `concurrent-modification` outcome rather than letting
 * the error escape.
 */
export class ManifestCasConcurrentModificationError extends Error {
  readonly __manifestCasConflict = true as const;
  constructor(message: string = 'concurrent manifest modification detected') {
    super(message);
    this.name = 'ManifestCasConcurrentModificationError';
  }
}

/** Discriminated outcome of a `ManifestCas.update` call. */
export type ManifestCasResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'cas-mismatch' | 'not-found' | 'concurrent-modification';
      /** When `reason === 'cas-mismatch'`, the actually-observed entry
       *  (so the caller can retry against the latest state). Omitted
       *  for `'not-found'` and `'concurrent-modification'`. */
      readonly observed?: { readonly contentHash: ContentHash };
    };

/**
 * Compare-and-swap helper over manifest entries.
 *
 * **CAS strength depends on the injected storage.** This class enforces
 * the read-then-conditional-write protocol locally — but the swap is
 * truly atomic only if the underlying `MinimalManifestStorage` raises
 * `ManifestCasConcurrentModificationError` (or sets `__manifestCasConflict:
 * true` on a thrown error) when its backend detects a write race between
 * our read and our write. If the storage adapter is purely optimistic
 * (last-writer-wins, no conflict detection), CAS reduces to last-write-
 * wins and ultimate convergence relies on the §7.1 CRDT merger's Lamport
 * tie-break in `outbox-merger`. The `ProfileTokenStorageProvider` /
 * `OrbitDbAdapter` adapter T.5.C wires up SHOULD raise the typed error
 * on log-replay conflict; verify when wiring.
 */
export class ManifestCas {
  constructor(private readonly storage: MinimalManifestStorage) {}

  /**
   * Atomic-from-the-caller's-perspective compare-and-swap on the
   * manifest entry for `(addr, tokenId)`.
   *
   * @param addr  The wallet address whose manifest is being updated.
   * @param tokenId The token whose entry is being updated.
   * @param prev  The expected current state. Two distinguished cases:
   *              - `null` → caller asserts NO entry currently exists
   *                for this `tokenId`. If one does, `cas-mismatch`.
   *              - `{ contentHash }` → caller asserts the current
   *                entry has exactly this `rootHash`. If it does not
   *                (or no entry exists), `cas-mismatch` / `not-found`.
   * @param next  The new entry to install on success.
   *
   * @returns `{ ok: true }` on success, otherwise a structured
   *   failure with a `reason` discriminator.
   */
  async update(
    addr: string,
    tokenId: string,
    prev: { readonly contentHash: ContentHash } | null,
    next: TokenManifestEntry,
  ): Promise<ManifestCasResult> {
    // Step 1: read current.
    const observed = await this.storage.readEntry(addr, tokenId);

    // Step 2: precondition check.
    if (prev === null) {
      // Caller asserts no entry exists.
      if (observed !== undefined) {
        return {
          ok: false,
          reason: 'cas-mismatch',
          observed: { contentHash: observed.rootHash },
        };
      }
    } else {
      // Caller asserts an entry with `prev.contentHash` exists.
      if (observed === undefined) {
        return { ok: false, reason: 'not-found' };
      }
      if (observed.rootHash !== prev.contentHash) {
        return {
          ok: false,
          reason: 'cas-mismatch',
          observed: { contentHash: observed.rootHash },
        };
      }
    }

    // Step 3: conditional write. The underlying storage MAY still
    // detect a concurrent write between our read above and this write
    // (e.g. OrbitDB log replay race). Translate that to the structured
    // 'concurrent-modification' outcome.
    try {
      await this.storage.writeEntry(addr, tokenId, next);
      return { ok: true };
    } catch (err) {
      if (
        err instanceof ManifestCasConcurrentModificationError ||
        (typeof err === 'object' &&
          err !== null &&
          (err as { __manifestCasConflict?: unknown }).__manifestCasConflict === true)
      ) {
        return { ok: false, reason: 'concurrent-modification' };
      }
      // Any other error is a real failure — propagate.
      throw err;
    }
  }
}
