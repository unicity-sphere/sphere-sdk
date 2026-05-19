/**
 * UXF Inter-Wallet Transfer — Profile-backed adapters for the recipient-side
 * cross-restart safety net (G3 + G7 — no-token-loss).
 *
 * Two production-ready adapters live here:
 *
 *  1. {@link OrbitDbFinalizationQueueStorageAdapter} —
 *     {@link FinalizationQueueStorage} backed by a {@link ProfileDatabase}.
 *     Records are encrypted with the profile encryption key and stamped
 *     with `_schemaVersion: 'uxf-1'` so the legacy
 *     `ProfileTokenStorageProvider.applyPerEntryDiff` path does NOT
 *     tombstone them on every save() flush (G2/G3 same-prefix-coexistence
 *     contract). Tombstones written by `FinalizationQueue.remove()` carry
 *     the canonical `{tombstoned: true, deletedAt}` shape that the
 *     wrapper already understands.
 *
 *     Closes G3: pre-fix the recipient FinalizationQueue was a
 *     `Map<string,string>` shim instantiated by
 *     `buildDefaultFinalizationWorkerRecipient`; nothing persisted across
 *     `Sphere.destroy()` / restart. The §5.5 step 6 hard polling
 *     deadline anchored at `pollStartedAt` was therefore reset on every
 *     boot — the W26 cross-restart safety net was effectively inert.
 *
 *  2. {@link OrbitDbRecipientContextStorageAdapter} — typed CRUD over the
 *     two in-memory Maps `_recipientRequestContextMap` and
 *     `_recipientFinalizationContext` on `PaymentsModule`. The record
 *     shapes are the same `RequestContext` and
 *     `RecipientFinalizationContext` PaymentsModule already constructs;
 *     this adapter owns serialization + encryption + per-tokenId /
 *     per-requestId key composition.
 *
 *     Closes G7: pre-fix these two Maps were populated when an instant-
 *     mode token arrived but never persisted, so a Sphere that crashed
 *     between enqueue and finalization could not rebuild the context
 *     the dispositionWriter VALID branch needs to flip the local Token
 *     to `'confirmed'`.
 *
 * Key shapes (all under the per-address namespace):
 *   - finalization queue:      `${addr}.finalizationQueue.${entryId}`
 *   - request context:         `${addr}.recipientContext.request.${requestId}`
 *   - finalization context:    `${addr}.recipientContext.finalization.${tokenId}`
 *
 * Tombstones use the canonical `{tombstoned: true, deletedAt}` marker
 * so the same `applyPerEntryDiff` GC path that handles outbox
 * tombstones also reaps stale recipient-context tombstones once the
 * 30-day retention window elapses.
 *
 * @module profile/finalization-queue-storage-adapter
 */

import { logger } from '../core/logger.js';
import { decryptString, encryptString } from './encryption.js';
import type { FinalizationQueueStorage } from '../modules/payments/transfer/finalization-queue.js';
import type { ProfileDatabase } from './types.js';
import { PrefixSyncWriter } from './prefix-sync-writer.js';
import type { ProfileSyncWriter } from './profile-snapshot-merge.js';

// =============================================================================
// 0. Constants — schema discriminator + key shapes
// =============================================================================

/**
 * Schema discriminator stamped on every record this module writes. The
 * companion contract is enforced in
 * `ProfileTokenStorageProvider.applyPerEntryDiff`: when the diff is
 * called with `skipForeignSchema:true`, any value carrying this
 * discriminator survives a foreign-owner save() flush. Mirrors the
 * `_schemaVersion` field on `InvalidEntry` / `AuditEntry` (G1/G2).
 */
const SCHEMA_VERSION = 'uxf-1' as const;

interface TombstoneMarker {
  readonly tombstoned: true;
  readonly deletedAt: number;
}

function isTombstone(value: unknown): value is TombstoneMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { tombstoned?: unknown }).tombstoned === true
  );
}

// =============================================================================
// 1. OrbitDbFinalizationQueueStorageAdapter (G3)
// =============================================================================

/**
 * Construction options for {@link OrbitDbFinalizationQueueStorageAdapter}.
 */
export interface OrbitDbFinalizationQueueStorageAdapterOptions {
  /** OrbitDB-backed profile database (same instance the rest of the profile uses). */
  readonly db: ProfileDatabase;
  /** AES-256 key derived from the wallet master key (see {@link deriveProfileEncryptionKey}). */
  readonly encryptionKey: Uint8Array;
}

/**
 * Profile-backed implementation of {@link FinalizationQueueStorage}.
 *
 * The wrapper writes JSON-encoded values; this adapter:
 *   1. Parses the value, stamps `_schemaVersion: 'uxf-1'` on live
 *      entries (tombstones are passed through unchanged so the
 *      `applyPerEntryDiff` GC path can reap them on the standard
 *      30-day retention window), re-serializes.
 *   2. Encrypts with the profile encryption key.
 *   3. Writes via `db.put`.
 *
 * Read path mirrors the write path: decrypt → parse → return the JSON
 * string (the wrapper's `parseQueueValue` is the consumer; it tolerates
 * the `_schemaVersion` field as an extra key on the parsed object).
 */
export class OrbitDbFinalizationQueueStorageAdapter
  implements FinalizationQueueStorage
{
  private readonly db: ProfileDatabase;
  private readonly encryptionKey: Uint8Array;

  constructor(opts: OrbitDbFinalizationQueueStorageAdapterOptions) {
    this.db = opts.db;
    this.encryptionKey = opts.encryptionKey;
  }

  async readKey(key: string): Promise<string | null> {
    const raw = await this.db.get(key);
    if (raw === null) return null;
    try {
      return await decryptString(this.encryptionKey, raw as Uint8Array);
    } catch (err) {
      logger.warn(
        'OrbitDbFinalizationQueueStorageAdapter',
        `decode failed at key="${key}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async writeKey(key: string, value: string): Promise<void> {
    // Stamp `_schemaVersion` on live entries; pass tombstones through.
    let stamped: string;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown> | unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !isTombstone(parsed)
      ) {
        const withDiscriminator = {
          _schemaVersion: SCHEMA_VERSION,
          ...(parsed as Record<string, unknown>),
        };
        stamped = JSON.stringify(withDiscriminator);
      } else {
        stamped = value;
      }
    } catch {
      // Wrapper always passes valid JSON; if we ever see corrupt input
      // hand it through unmodified — the wrapper's read path will
      // surface a corrupt-slot via its `onCorruptSlot` handler.
      stamped = value;
    }
    const ciphertext = await encryptString(this.encryptionKey, stamped);
    await this.db.put(key, ciphertext);
  }

  async listByPrefix(prefix: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(prefix);
    } catch (err) {
      logger.warn(
        'OrbitDbFinalizationQueueStorageAdapter',
        `listByPrefix("${prefix}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return out;
    }
    for (const key of entries.keys()) {
      if (!key.startsWith(prefix)) continue;
      const entryId = key.slice(prefix.length);
      if (entryId.length === 0) continue;
      out.set(key, entryId);
    }
    return out;
  }

  async deleteKey(key: string): Promise<void> {
    await this.db.del(key);
  }

  // ===========================================================================
  // Item #15 Phase B.5 — full-profile-snapshot sync API
  // ===========================================================================

  /**
   * Return a {@link ProfileSyncWriter} scoped to
   * `${addressId}.finalizationQueue.*`. Each finalization-queue entry
   * is content-immutable per key (the `entryId` disambiguator ensures
   * two replicas writing the same entry produce equivalent content);
   * the merge therefore uses constant-Lamport semantics via
   * {@link PrefixSyncWriter}.
   *
   * Sticky-tombstone semantics: once a queue entry is removed on
   * either replica, the JOIN preserves the tombstone across both
   * sides. Mirrors {@link FinalizationQueue.remove}'s intent.
   */
  syncWriterFor(addressId: string): ProfileSyncWriter {
    return new PrefixSyncWriter({
      db: this.db,
      encryptionKey: this.encryptionKey,
      keyPrefix: `${addressId}.finalizationQueue.`,
      validateValue: validateUxf1Schema,
      label: 'OrbitDbFinalizationQueueStorageAdapter.sync',
    });
  }
}

// =============================================================================
// 2. OrbitDbRecipientContextStorageAdapter (G7)
// =============================================================================

/**
 * Persisted shape of a `RequestContext` record. PaymentsModule keeps an
 * in-memory `Map<string, RequestContext>` keyed on the aggregator
 * commitment-request-id. The `nextEntryRest` field is a structural
 * subset of the payload `dispositionWriter` consumes; we serialize it
 * verbatim. Forward-compatible with future extensions: unknown JSON-safe
 * fields round-trip without loss.
 */
export interface PersistedRequestContext {
  readonly transactionHash: string;
  readonly authenticator: string;
  readonly nextEntryRest: Record<string, unknown>;
}

/**
 * Persisted shape of a `RecipientFinalizationContext` record.
 *
 * Shape mirrors the in-memory definition on `PaymentsModule`. The
 * `sourceTokenJson` and `lastTxJson` fields are JSON-safe values from
 * the SDK so they round-trip through `JSON.stringify` cleanly; the
 * adapter does NOT inspect their structure.
 */
export interface PersistedFinalizationContext {
  readonly localTokenId: string;
  readonly sourceTokenJson: unknown;
  readonly lastTxJson: Record<string, unknown>;
  readonly requestIdHex: string;
}

/**
 * Construction options for {@link OrbitDbRecipientContextStorageAdapter}.
 */
export interface OrbitDbRecipientContextStorageAdapterOptions {
  readonly db: ProfileDatabase;
  readonly encryptionKey: Uint8Array;
}

/**
 * Compose the OrbitDB key for a `RequestContext` record. Public so
 * tests + the wave-G.7 diff path can compose keys for cross-cutting
 * concerns (e.g. surfacing the `_schemaVersion` discriminator from a
 * raw on-disk read).
 */
export function requestContextKey(addr: string, requestId: string): string {
  return `${addr}.recipientContext.request.${requestId}`;
}

/**
 * Compose the OrbitDB key for a `RecipientFinalizationContext` record.
 */
export function finalizationContextKey(addr: string, tokenId: string): string {
  return `${addr}.recipientContext.finalization.${tokenId}`;
}

/**
 * Compose the prefix used when scanning all finalization contexts under
 * an address (load-on-startup path).
 */
export function finalizationContextPrefix(addr: string): string {
  return `${addr}.recipientContext.finalization.`;
}

/**
 * Compose the prefix used when scanning all request contexts under an
 * address (load-on-startup path).
 */
export function requestContextPrefix(addr: string): string {
  return `${addr}.recipientContext.request.`;
}

/**
 * Profile-backed CRUD layer over the two in-memory Maps PaymentsModule
 * uses for the recipient finalization worker:
 *
 *  - `_recipientRequestContextMap` (key: requestId)
 *  - `_recipientFinalizationContext` (key: tokenId)
 *
 * Records are encrypted, stamped with `_schemaVersion: 'uxf-1'` so the
 * legacy save() diff path leaves them alone, and listed via prefix
 * scans on PaymentsModule restart so the in-memory Maps re-hydrate
 * before the recipient worker resumes.
 */
export class OrbitDbRecipientContextStorageAdapter {
  private readonly db: ProfileDatabase;
  private readonly encryptionKey: Uint8Array;

  constructor(opts: OrbitDbRecipientContextStorageAdapterOptions) {
    this.db = opts.db;
    this.encryptionKey = opts.encryptionKey;
  }

  async writeRequestContext(
    addr: string,
    requestId: string,
    record: PersistedRequestContext,
  ): Promise<void> {
    const key = requestContextKey(addr, requestId);
    const stamped = { _schemaVersion: SCHEMA_VERSION, ...record };
    const json = JSON.stringify(stamped);
    const ciphertext = await encryptString(this.encryptionKey, json);
    await this.db.put(key, ciphertext);
  }

  async readRequestContext(
    addr: string,
    requestId: string,
  ): Promise<PersistedRequestContext | undefined> {
    const key = requestContextKey(addr, requestId);
    const raw = await this.db.get(key);
    if (raw === null) return undefined;
    return this.tryDecode<PersistedRequestContext>(raw as Uint8Array, key);
  }

  async deleteRequestContext(addr: string, requestId: string): Promise<void> {
    await this.db.del(requestContextKey(addr, requestId));
  }

  async writeFinalizationContext(
    addr: string,
    tokenId: string,
    record: PersistedFinalizationContext,
  ): Promise<void> {
    const key = finalizationContextKey(addr, tokenId);
    const stamped = { _schemaVersion: SCHEMA_VERSION, ...record };
    const json = JSON.stringify(stamped);
    const ciphertext = await encryptString(this.encryptionKey, json);
    await this.db.put(key, ciphertext);
  }

  async readFinalizationContext(
    addr: string,
    tokenId: string,
  ): Promise<PersistedFinalizationContext | undefined> {
    const key = finalizationContextKey(addr, tokenId);
    const raw = await this.db.get(key);
    if (raw === null) return undefined;
    return this.tryDecode<PersistedFinalizationContext>(raw as Uint8Array, key);
  }

  async deleteFinalizationContext(addr: string, tokenId: string): Promise<void> {
    await this.db.del(finalizationContextKey(addr, tokenId));
  }

  /**
   * Enumerate every `RecipientFinalizationContext` record under `addr`.
   * Used by `PaymentsModule.initialize()` to re-hydrate the in-memory
   * `_recipientFinalizationContext` Map on restart.
   */
  async listAllFinalizationContexts(
    addr: string,
  ): Promise<Map<string, PersistedFinalizationContext>> {
    const out = new Map<string, PersistedFinalizationContext>();
    const prefix = finalizationContextPrefix(addr);
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(prefix);
    } catch (err) {
      logger.warn(
        'OrbitDbRecipientContextStorageAdapter',
        `listAllFinalizationContexts("${addr}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return out;
    }
    for (const [key, ciphertext] of entries) {
      if (!key.startsWith(prefix)) continue;
      const tokenId = key.slice(prefix.length);
      if (tokenId.length === 0) continue;
      const decoded = await this.tryDecode<PersistedFinalizationContext>(
        ciphertext,
        key,
      );
      if (decoded === undefined) continue;
      out.set(tokenId, decoded);
    }
    return out;
  }

  /**
   * Enumerate every `RequestContext` record under `addr`. Used by
   * `PaymentsModule.initialize()` to re-hydrate the in-memory
   * `_recipientRequestContextMap` on restart.
   */
  async listAllRequestContexts(
    addr: string,
  ): Promise<Map<string, PersistedRequestContext>> {
    const out = new Map<string, PersistedRequestContext>();
    const prefix = requestContextPrefix(addr);
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(prefix);
    } catch (err) {
      logger.warn(
        'OrbitDbRecipientContextStorageAdapter',
        `listAllRequestContexts("${addr}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return out;
    }
    for (const [key, ciphertext] of entries) {
      if (!key.startsWith(prefix)) continue;
      const reqId = key.slice(prefix.length);
      if (reqId.length === 0) continue;
      const decoded = await this.tryDecode<PersistedRequestContext>(
        ciphertext,
        key,
      );
      if (decoded === undefined) continue;
      out.set(reqId, decoded);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Private — encode / decode
  // ---------------------------------------------------------------------------

  private async tryDecode<T>(
    raw: Uint8Array,
    key: string,
  ): Promise<T | undefined> {
    try {
      const json = await decryptString(this.encryptionKey, raw);
      const parsed = JSON.parse(json);
      if (isTombstone(parsed)) return undefined;
      return parsed as T;
    } catch (err) {
      logger.warn(
        'OrbitDbRecipientContextStorageAdapter',
        `decode failed at key="${key}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  // ===========================================================================
  // Item #15 Phase B.5 — full-profile-snapshot sync API
  // ===========================================================================

  /**
   * Return the two {@link ProfileSyncWriter}s scoped to this address's
   * recipient-context state: one for `recipientContext.request.*` (keyed
   * by requestId) and one for `recipientContext.finalization.*` (keyed
   * by tokenId).
   *
   * Both surfaces are content-immutable per key (PaymentsModule writes
   * each requestId / tokenId exactly once during the in-flight transfer
   * lifecycle); the merge uses constant-Lamport semantics via
   * {@link PrefixSyncWriter}.
   *
   * The two sync writers are returned together because they cover the
   * same logical "recipient-context" namespace under different
   * sub-prefixes — the Phase D dispatcher invokes both per JOIN cycle.
   */
  syncWritersFor(addressId: string): {
    readonly requestContext: ProfileSyncWriter;
    readonly finalizationContext: ProfileSyncWriter;
  } {
    return {
      requestContext: new PrefixSyncWriter({
        db: this.db,
        encryptionKey: this.encryptionKey,
        keyPrefix: requestContextPrefix(addressId),
        validateValue: validateUxf1Schema,
        label: 'OrbitDbRecipientContextStorageAdapter.sync.request',
      }),
      finalizationContext: new PrefixSyncWriter({
        db: this.db,
        encryptionKey: this.encryptionKey,
        keyPrefix: finalizationContextPrefix(addressId),
        validateValue: validateUxf1Schema,
        label: 'OrbitDbRecipientContextStorageAdapter.sync.finalization',
      }),
    };
  }
}

// =============================================================================
// 2.5 Shared validator for `_schemaVersion: 'uxf-1'` stamped records
// =============================================================================

/**
 * Validator used by both adapter sync writers — accepts any decoded
 * payload that carries the `_schemaVersion: 'uxf-1'` discriminator. This
 * rejects foreign-schema entries (legacy `OutboxEntry`, raw PaymentsModule
 * outbox-style records, etc.) that may share the same key prefix during
 * the §7.2 migration window — those entries don't propagate via the
 * lean-snapshot path.
 */
function validateUxf1Schema(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object') return false;
  if (Array.isArray(parsed)) return false;
  return (parsed as { _schemaVersion?: unknown })._schemaVersion === SCHEMA_VERSION;
}

// =============================================================================
// 3. In-memory variants (for tests / non-Profile bootstraps)
// =============================================================================

/**
 * Pure-memory implementation of {@link FinalizationQueueStorage}.
 *
 * Suitable for tests and dev-mode wallets that don't bootstrap a Profile
 * stack. Mirrors the shape `buildDefaultFinalizationWorkerRecipient`
 * constructed inline previously.
 */
export class InMemoryFinalizationQueueStorageAdapter
  implements FinalizationQueueStorage
{
  private readonly entries = new Map<string, string>();

  async readKey(key: string): Promise<string | null> {
    return this.entries.has(key) ? (this.entries.get(key) ?? null) : null;
  }

  async writeKey(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async listByPrefix(prefix: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [k] of this.entries) {
      if (k.startsWith(prefix)) {
        const entryId = k.slice(prefix.length);
        if (entryId.length > 0) out.set(k, entryId);
      }
    }
    return out;
  }

  async deleteKey(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/**
 * Pure-memory implementation of the recipient-context CRUD surface.
 * Mirrors the in-memory `Map` shapes PaymentsModule uses today; suitable
 * for tests and non-Profile bootstraps.
 */
export class InMemoryRecipientContextStorageAdapter {
  private readonly requestContexts = new Map<string, PersistedRequestContext>();
  private readonly finalizationContexts = new Map<
    string,
    PersistedFinalizationContext
  >();

  async writeRequestContext(
    addr: string,
    requestId: string,
    record: PersistedRequestContext,
  ): Promise<void> {
    this.requestContexts.set(`${addr}::${requestId}`, record);
  }

  async readRequestContext(
    addr: string,
    requestId: string,
  ): Promise<PersistedRequestContext | undefined> {
    return this.requestContexts.get(`${addr}::${requestId}`);
  }

  async deleteRequestContext(addr: string, requestId: string): Promise<void> {
    this.requestContexts.delete(`${addr}::${requestId}`);
  }

  async writeFinalizationContext(
    addr: string,
    tokenId: string,
    record: PersistedFinalizationContext,
  ): Promise<void> {
    this.finalizationContexts.set(`${addr}::${tokenId}`, record);
  }

  async readFinalizationContext(
    addr: string,
    tokenId: string,
  ): Promise<PersistedFinalizationContext | undefined> {
    return this.finalizationContexts.get(`${addr}::${tokenId}`);
  }

  async deleteFinalizationContext(
    addr: string,
    tokenId: string,
  ): Promise<void> {
    this.finalizationContexts.delete(`${addr}::${tokenId}`);
  }

  async listAllFinalizationContexts(
    addr: string,
  ): Promise<Map<string, PersistedFinalizationContext>> {
    const out = new Map<string, PersistedFinalizationContext>();
    const prefix = `${addr}::`;
    for (const [k, v] of this.finalizationContexts) {
      if (k.startsWith(prefix)) {
        out.set(k.slice(prefix.length), v);
      }
    }
    return out;
  }

  async listAllRequestContexts(
    addr: string,
  ): Promise<Map<string, PersistedRequestContext>> {
    const out = new Map<string, PersistedRequestContext>();
    const prefix = `${addr}::`;
    for (const [k, v] of this.requestContexts) {
      if (k.startsWith(prefix)) {
        out.set(k.slice(prefix.length), v);
      }
    }
    return out;
  }
}

/**
 * Common interface implemented by both the OrbitDB-backed and in-memory
 * recipient-context adapters. Lets PaymentsModule consume either via a
 * single typed reference.
 */
export type RecipientContextStorageAdapter =
  | OrbitDbRecipientContextStorageAdapter
  | InMemoryRecipientContextStorageAdapter;
