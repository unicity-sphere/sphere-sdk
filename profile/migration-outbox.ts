/**
 * UXF Inter-Wallet Transfer — Legacy outbox migration (T.6.D)
 *
 * Migrates the **per-token** legacy `OutboxEntry` records (`types/txf.ts:150`)
 * stored at OrbitDB keys `${addr}.outbox.${id}` into the **bundle-grained**
 * {@link UxfTransferOutboxEntry} form per UXF-TRANSFER-PROTOCOL §7.2.
 *
 * # Why
 *
 * The legacy outbox is per-token granular; the UXF outbox is bundle-grained.
 * A bundle that ships N tokens to one recipient created N legacy entries
 * with the same `recipientPubkey` and a tight `createdAt` clustering. The
 * §7.2 migration coalesces those into ONE synthetic UXF entry per bundle.
 *
 * # Ordering invariant (C7)
 *
 * The migration follows a strict ordering:
 *
 *   1. **gate**     — feature flag check (`features.outbox === 'dual-write' || 'uxf'`)
 *   2. **sentinel** — idempotency check (`${addr}.legacyOutbox.migrated`)
 *   3. **read**     — collect every legacy entry under `${addr}.outbox.*`
 *   4. **BACKUP**   — write `${addr}.legacyOutbox.backup` BEFORE any mutation.
 *                     This is C7's hard rule: a partial-crash run that wrote
 *                     synthetic entries but never finished the legacy clear
 *                     must remain restorable from the backup.
 *   5. **migrate**  — synthesize one {@link UxfTransferOutboxEntry} per
 *                     `(recipientPubkey, ⌊createdAt/60_000⌋)` group. Write
 *                     each via the {@link OutboxWriter} so the §7.1 Lamport
 *                     bump rule applies.
 *   6. **sentinel** — write `${addr}.legacyOutbox.migrated` so a re-run is
 *                     a no-op.
 *   7. **clear**    — delete each legacy `${addr}.outbox.${id}` entry.
 *
 * If the process crashes between steps 4 and 6, the backup is on disk and
 * the legacy entries are still present (or partially-cleared if it crashed
 * after step 7 began). The next run reads no sentinel, finds the legacy
 * entries again, and re-runs the migration. Synthetic UXF entries written
 * by the failed run are overwritten by the second run (per the OrbitDB
 * keyvalue last-write-wins per-key semantic) — the synthesized id is
 * deterministic from `(group → id)` is NOT — we use a generated UUID, so
 * a second-run synthesizes new entries with different ids. This means a
 * crash between step 5 and step 6 leaves orphan UXF entries from the
 * first run plus new entries from the second run. Documented limitation:
 * the backup is the source of truth for recovery; the operator can clear
 * orphans by inspecting the backup blob (T.6.D.2 restore script).
 *
 * # Status mapping (per §7.2 step 3)
 *
 * | Legacy status   | UXF status         | Notes                                 |
 * |-----------------|--------------------|---------------------------------------|
 * | `delivered`     | `finalized`        | spec §7.2 step 3                      |
 * | `confirmed`     | `finalized`        | spec §7.2 step 3                      |
 * | `pending`       | `sending`          | spec §7.2 step 3                      |
 * | `submitted`     | `sending`          | closest semantic match — entry was    |
 * |                 |                    | mid-flight at migration time. Spec    |
 * |                 |                    | examples are non-exhaustive.          |
 * | `failed`        | `failed-permanent` | spec §7.2 step 3                      |
 *
 * For multi-entry groups, the "most advanced" status wins:
 *
 *   1. any `delivered`/`confirmed`           → `finalized`
 *   2. else any `pending`/`submitted`        → `sending`
 *   3. else (all `failed`)                   → `failed-permanent`
 *
 * This ordering matches the §7.0 lattice — `finalized` is the most-advanced
 * hard-terminal, `sending` is mid-active, `failed-permanent` is the
 * fallback.
 *
 * # Synthetic `bundleCid` form (per §7.2 step 2)
 *
 *   - **Single-entry group**: `'txf-' + sourceTokenId`
 *   - **Multi-entry group**:  `'legacy-' + recipientPubkey + '-' + earliestCreatedAt`
 *
 * Both forms are namespaced (`txf-`, `legacy-`) so they cannot collide with
 * real IPFS CARv1 root CIDs (which start with `bafy`/`Qm`).
 *
 * # `recipientNametag` plumbing (W18)
 *
 * `recipientNametag` is a **first-class** field on
 * {@link UxfTransferOutboxEntry} (T.6.A — `types/uxf-outbox.ts:189`). The
 * migration takes the nametag from the **first** legacy entry in each group
 * that has one. Mixed groups (some with nametag, some without) preserve
 * the nametag — the canonical interpretation is "if any sender saw this
 * recipient as `@bob`, the synthetic entry remembers it." This matches
 * §7.2 paragraph 4: "MUST preserve `recipientNametag`".
 *
 * # Reasonable inline interpretations
 *
 * Several aspects of §7.2 are under-specified; this implementation chooses:
 *
 *   - **`recipient` field** (§7.2 step 2): we set it to `'@' + nametag` if
 *     a nametag is present, else `recipientPubkey`. The spec says "preserves
 *     UI display continuity" and `recipient` is the human-presented form.
 *   - **`recipientTransportPubkey`**: copied from `recipientPubkey`. The
 *     legacy code stored a chain pubkey here; transport pubkey resolution
 *     was deferred. This matches §7.2 step 2 "copied from `recipientPubkey`".
 *   - **`tokenIds`**: collected from each legacy entry's `sourceTokenId`,
 *     deduplicated, sorted lexicographically for determinism.
 *   - **`memo`**: legacy `OutboxEntry` had no memo field. Synthetic entries
 *     omit `memo` entirely.
 *   - **`error`**: if the most-advanced legacy entry has an `error`, we
 *     copy it. Otherwise omit.
 *   - **`submitRetryCount`**: `max` of legacy entries' `retryCount` (G-counter
 *     shape per §7.1 — max-merge).
 *   - **`proofErrorCount`**: 0 (legacy had no separate proof-error counter).
 *
 * # Per-feature flag gate
 *
 * The migration is a no-op unless `featureMode` is `'dual-write'` or
 * `'uxf'`. Legacy wallets without the flag (i.e. `featureMode === 'legacy'`
 * or undefined) MUST not have their outbox migrated — the legacy code paths
 * still consume the per-token form. Spec §7.A enumerates the valid feature
 * combinations; this gate is the runtime enforcement.
 *
 * @module profile/migration-outbox
 *
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md   §7.2 (canonical migration rules)
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md   §10.3 (backward compatibility)
 * @see profile/outbox-writer.ts            (T.6.A — production writer)
 * @see types/uxf-outbox.ts                 (T.6.A — UxfTransferOutboxEntry shape)
 */

import { SphereError } from '../core/errors.js';
import { randomUUID } from '../core/utils.js';
import {
  isLegacyOutboxEntry,
  type LegacyOutboxEntry,
  type UxfOutboxStatus,
} from '../types/uxf-outbox.js';
import { decryptProfileValue, encryptProfileValue } from './encryption.js';
import { OutboxWriter, type OutboxWriteInput } from './outbox-writer.js';
import type { ProfileDatabase } from './types.js';

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * Per-feature-flag gate value (subset of `features.outbox`).
 *
 * - `'legacy'`     — pre-T.6.D wallet; migration is a no-op.
 * - `'dual-write'` — migration window; per-token legacy AND bundle-grained
 *                    UXF entries coexist briefly. Migration runs.
 * - `'uxf'`        — post-cutover; only bundle-grained UXF entries. Migration
 *                    runs (idempotent — sentinel makes the second-and-later
 *                    runs a no-op).
 *
 * @see docs/uxf/UXF-TRANSFER-IMPL-PLAN.md §7.A (feature-flag invariants)
 */
export type OutboxFeatureMode = 'legacy' | 'dual-write' | 'uxf';

/**
 * Construction-time options for {@link migrateLegacyOutbox}.
 */
export interface MigrationOptions {
  /** Address id — the `${addr}` prefix in `${addr}.outbox.${id}`. */
  readonly addr: string;
  /** OrbitDB key-value adapter — same instance the provider uses. */
  readonly db: ProfileDatabase;
  /** Production {@link OutboxWriter} — uses the same Lamport instance the
   *  caller will use after migration so the bump rule stays consistent. */
  readonly outboxWriter: OutboxWriter;
  /** AES-256 key for decrypting / re-encrypting on-disk values. Pass `null`
   *  when the wallet has no profile encryption (parity with the writer). */
  readonly encryptionKey: Uint8Array | null;
  /** Per-feature flag gate. The migration is a no-op unless this is
   *  `'dual-write'` or `'uxf'`. `undefined` is treated as `'legacy'`. */
  readonly featureMode?: OutboxFeatureMode | undefined;
  /** Optional override for `Date.now()` — primarily for tests. */
  readonly now?: () => number;
  /**
   * Optional override for the synthetic UXF entry id generator. Defaults
   * to `crypto.randomUUID()`. Tests use a deterministic counter to make
   * snapshot assertions stable.
   */
  readonly idGenerator?: () => string;
}

/**
 * Result of a {@link migrateLegacyOutbox} call.
 */
export interface OutboxMigrationResult {
  /**
   * Number of synthetic UXF entries written. Zero when:
   *   - `featureMode` does not enable migration, OR
   *   - the sentinel was already present (re-run no-op), OR
   *   - no legacy entries existed (fresh wallet).
   */
  readonly migrated: number;
  /**
   * `true` when a sentinel was found at the start of the run. The migration
   * exited immediately without reading legacy entries or writing any
   * backup. Always `false` on the first successful run.
   */
  readonly alreadyMigrated: boolean;
  /**
   * Storage key where the legacy snapshot was written. Empty string when
   * the migration was a no-op (gate or sentinel skip).
   */
  readonly backupKey: string;
  /**
   * Number of distinct (recipientPubkey, 60s-window) groups that produced
   * a synthetic UXF entry. Equal to {@link migrated} for the success case.
   */
  readonly groups: number;
  /**
   * Number of legacy entries observed under `${addr}.outbox.*`. May exceed
   * {@link groups} if multi-token bundles were present. Includes malformed
   * entries that were skipped (counted in {@link skippedMalformed}).
   */
  readonly legacyEntries: number;
  /** Legacy entries skipped because they failed `isLegacyOutboxEntry`. */
  readonly skippedMalformed: number;
  /**
   * UXF-shape entries observed under `${addr}.outbox.*` and LEFT IN PLACE.
   * The migration NEVER deletes UXF-shape entries — those are part of the
   * dual-write window.
   */
  readonly preservedUxfEntries: number;
}

// =============================================================================
// 2. Storage key helpers
// =============================================================================

/**
 * Compute the on-disk key for the migration sentinel.
 *
 * Sentinel value shape: `{ at: number; version: 1 }` (JSON-encoded).
 *
 * Once written, this key signals "migration ran successfully — do not
 * re-run". It is intentionally NOT under the `${addr}.outbox.*` prefix
 * (which would cause it to appear in `OutboxWriter.readAll()`).
 */
export function sentinelKey(addr: string): string {
  return `${addr}.legacyOutbox.migrated`;
}

/**
 * Compute the on-disk key for the legacy backup snapshot.
 *
 * Backup value shape: a JSON object documented at
 * {@link LegacyOutboxBackup}. Restore-script consumers (T.6.D.2) read this
 * key to round-trip the snapshot.
 */
export function backupKey(addr: string): string {
  return `${addr}.legacyOutbox.backup`;
}

/**
 * Shape of the value persisted at {@link backupKey}.
 *
 * The format is intentionally explicit and self-describing so a future
 * T.6.D.2 restore script can verify the snapshot before applying it.
 */
export interface LegacyOutboxBackup {
  readonly _backupVersion: 1;
  readonly _addr: string;
  readonly _capturedAt: number;
  /**
   * Snapshot of every `${addr}.outbox.${id}` entry at the moment the
   * backup was written, in stable lexicographic-by-key order. Each entry
   * carries the original on-disk key alongside the parsed value so a
   * restore can rewrite `db.put(key, …)` directly.
   */
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: LegacyOutboxEntry }>;
}

// =============================================================================
// 3. Migration entry point
// =============================================================================

/**
 * Migrate per-token legacy {@link LegacyOutboxEntry} records to
 * bundle-grained {@link UxfTransferOutboxEntry}s per UXF-TRANSFER-PROTOCOL
 * §7.2.
 *
 * **Idempotent**: re-running on a wallet with the migration sentinel
 * present is a no-op. The function returns `{ alreadyMigrated: true }`
 * and exits before touching any keys.
 *
 * **One-way**: legacy entries are deleted in the final step. The backup
 * is the source-of-truth for restore.
 *
 * **Crash-safe**: if the process dies between the backup and the final
 * legacy-clear, the next call observes no sentinel, re-runs the migration,
 * and overwrites the backup (which is overwrite-safe by design — the
 * snapshot reflects the current legacy state at backup time).
 *
 * @returns Counts and the backup key for telemetry.
 */
export async function migrateLegacyOutbox(
  opts: MigrationOptions,
): Promise<OutboxMigrationResult> {
  validateOptions(opts);

  // ===========================================================================
  // Step 1 — feature gate.
  // ===========================================================================
  if (opts.featureMode !== 'dual-write' && opts.featureMode !== 'uxf') {
    return {
      migrated: 0,
      alreadyMigrated: false,
      backupKey: '',
      groups: 0,
      legacyEntries: 0,
      skippedMalformed: 0,
      preservedUxfEntries: 0,
    };
  }

  // ===========================================================================
  // Step 2 — sentinel idempotency check.
  // ===========================================================================
  const sentinel = await readSentinel(opts.db, opts.addr);
  if (sentinel !== null) {
    return {
      migrated: 0,
      alreadyMigrated: true,
      backupKey: backupKey(opts.addr),
      groups: 0,
      legacyEntries: 0,
      skippedMalformed: 0,
      preservedUxfEntries: 0,
    };
  }

  // ===========================================================================
  // Step 3 — read all legacy entries under `${addr}.outbox.*`.
  // ===========================================================================
  const scan = await scanLegacyEntries(opts);

  // ===========================================================================
  // Step 4 — C7 BACKUP.
  // Write the backup BEFORE any mutation. If the legacy collection is
  // empty, we still write a (trivially empty) backup — it documents the
  // run and lets a future restore distinguish "ran on empty wallet" from
  // "never ran".
  // ===========================================================================
  await writeBackup(opts, scan.legacyEntries);

  // ===========================================================================
  // Step 5 — group + synthesize + write via OutboxWriter.
  // ===========================================================================
  const groups = groupLegacyEntries(scan.legacyEntries.map((e) => e.value));
  const idGen = opts.idGenerator ?? (() => randomUUID());
  const nowFn = opts.now ?? (() => Date.now());

  let writtenCount = 0;
  for (const group of groups) {
    const synthetic = synthesize(group, idGen(), nowFn());
    await opts.outboxWriter.write(synthetic);
    writtenCount++;
  }

  // ===========================================================================
  // Step 6 — sentinel write. After this, re-runs are no-ops.
  // ===========================================================================
  await writeSentinel(opts, nowFn());

  // ===========================================================================
  // Step 7 — clear legacy entries. Each delete is independent; a partial
  // failure mid-loop leaves the sentinel in place AND some legacy entries
  // present. The next run will see the sentinel and skip — but the legacy
  // entries are no longer consulted by the production code path (which
  // reads UXF-shape only post-cutover) and the backup retains the snapshot
  // for forensic recovery.
  // ===========================================================================
  for (const e of scan.legacyEntries) {
    await opts.db.del(e.key);
  }

  return {
    migrated: writtenCount,
    alreadyMigrated: false,
    backupKey: backupKey(opts.addr),
    groups: groups.length,
    legacyEntries: scan.legacyEntries.length + scan.skippedMalformed,
    skippedMalformed: scan.skippedMalformed,
    preservedUxfEntries: scan.preservedUxfEntries,
  };
}

// =============================================================================
// 4. Validation helpers
// =============================================================================

function validateOptions(opts: MigrationOptions): void {
  if (typeof opts.addr !== 'string' || opts.addr.length === 0) {
    throw new SphereError(
      'migrateLegacyOutbox: addr must be a non-empty string',
      'VALIDATION_ERROR',
    );
  }
  if (opts.db === null || typeof opts.db !== 'object') {
    throw new SphereError(
      'migrateLegacyOutbox: db must be a ProfileDatabase instance',
      'VALIDATION_ERROR',
    );
  }
  if (!(opts.outboxWriter instanceof OutboxWriter)) {
    throw new SphereError(
      'migrateLegacyOutbox: outboxWriter must be an OutboxWriter instance',
      'VALIDATION_ERROR',
    );
  }
}

// =============================================================================
// 5. Sentinel I/O
// =============================================================================

interface SentinelValue {
  readonly at: number;
  readonly version: 1;
}

async function readSentinel(
  db: ProfileDatabase,
  addr: string,
): Promise<SentinelValue | null> {
  const raw = await db.get(sentinelKey(addr));
  if (raw === null) return null;
  // Sentinel is intentionally UNENCRYPTED — it is a simple flag and the
  // restore script must be able to detect its presence without holding the
  // encryption key. The body is plain JSON.
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      (parsed as { version: unknown }).version === 1
    ) {
      return parsed as SentinelValue;
    }
  } catch {
    // Corrupt sentinel — treat as "no sentinel" so the migration re-runs.
    // This is the safer failure mode: the worst case is a redundant
    // backup write, never silent data loss.
  }
  return null;
}

async function writeSentinel(
  opts: MigrationOptions,
  at: number,
): Promise<void> {
  const value: SentinelValue = { at, version: 1 };
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  await opts.db.put(sentinelKey(opts.addr), encoded);
}

// =============================================================================
// 6. Backup I/O
// =============================================================================

async function writeBackup(
  opts: MigrationOptions,
  legacyEntries: ReadonlyArray<{ readonly key: string; readonly value: LegacyOutboxEntry }>,
): Promise<void> {
  const nowFn = opts.now ?? (() => Date.now());
  const snapshot: LegacyOutboxBackup = {
    _backupVersion: 1,
    _addr: opts.addr,
    _capturedAt: nowFn(),
    // Sort by key for determinism — restore scripts can diff snapshots.
    entries: [...legacyEntries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(snapshot));
  // Encrypt the backup if a key is configured — it contains recipient
  // pubkeys and amounts which are sensitive. Parity with the rest of the
  // profile encryption model.
  const toWrite = opts.encryptionKey
    ? await encryptProfileValue(opts.encryptionKey, encoded)
    : encoded;
  await opts.db.put(backupKey(opts.addr), toWrite);
}

// =============================================================================
// 7. Legacy entry scan
// =============================================================================

interface LegacyScanResult {
  readonly legacyEntries: ReadonlyArray<{ readonly key: string; readonly value: LegacyOutboxEntry }>;
  readonly skippedMalformed: number;
  readonly preservedUxfEntries: number;
}

async function scanLegacyEntries(opts: MigrationOptions): Promise<LegacyScanResult> {
  const prefix = `${opts.addr}.outbox.`;
  const legacyEntries: { key: string; value: LegacyOutboxEntry }[] = [];
  let skippedMalformed = 0;
  let preservedUxfEntries = 0;

  let raw: Map<string, Uint8Array>;
  try {
    raw = await opts.db.all(prefix);
  } catch {
    // Treat scan failure as "no legacy entries". Conservative: leaving
    // legacy entries in place is safer than deleting them under partial
    // information.
    return { legacyEntries: [], skippedMalformed: 0, preservedUxfEntries: 0 };
  }

  for (const [key, value] of raw) {
    if (!key.startsWith(prefix)) continue;
    const decoded = await decodeEntry(opts, value);
    if (decoded === null) {
      // Tombstones, corrupt JSON, decryption failures — skip silently.
      // They are not legacy-shape data we can migrate; leaving them in
      // place is harmless because the post-cutover code won't read them.
      skippedMalformed++;
      continue;
    }
    if (isLegacyOutboxEntry(decoded)) {
      legacyEntries.push({ key, value: decoded });
      continue;
    }
    // UXF-shape entry under the same prefix (e.g. dual-write window).
    // Preserve it — the migration is purely additive over the new shape.
    if (isUxfLikeShape(decoded)) {
      preservedUxfEntries++;
      continue;
    }
    skippedMalformed++;
  }

  return { legacyEntries, skippedMalformed, preservedUxfEntries };
}

/**
 * Lightweight shape sniff for UXF-1 entries. The full guard is in
 * `types/uxf-outbox.ts` but we only need the discriminator here, and
 * importing it would couple this module to a guard that may evolve.
 */
function isUxfLikeShape(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    '_schemaVersion' in value &&
    (value as { _schemaVersion: unknown })._schemaVersion === 'uxf-1'
  );
}

async function decodeEntry(
  opts: MigrationOptions,
  raw: Uint8Array,
): Promise<unknown | null> {
  let plaintextBytes: Uint8Array;
  try {
    plaintextBytes = opts.encryptionKey
      ? await decryptProfileValue(opts.encryptionKey, raw)
      : raw;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintextBytes));
  } catch {
    return null;
  }
  // Tombstone: skip.
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'tombstoned' in parsed &&
    (parsed as { tombstoned: unknown }).tombstoned === true
  ) {
    return null;
  }
  return parsed;
}

// =============================================================================
// 8. Grouping (§7.2 step 1)
// =============================================================================

/**
 * Window length for the `(recipientPubkey, createdAt-window)` grouping rule.
 * Spec §7.2: "entries created within 60s for the same recipient become a
 * single bundle."
 */
const GROUP_WINDOW_MS = 60_000;

interface LegacyGroup {
  readonly recipientPubkey: string;
  readonly windowKey: number;
  readonly entries: ReadonlyArray<LegacyOutboxEntry>;
}

/**
 * Group legacy entries by `(recipientPubkey, ⌊createdAt / 60_000⌋)`.
 *
 * Returns groups in deterministic order (sorted by windowKey, then by
 * recipientPubkey, then by tokenIds list). Determinism matters because
 * the synthesized `bundleCid` for a multi-entry group includes the
 * earliest createdAt — but the WRITE ORDER also affects Lamport stamps.
 * Stable input order yields stable Lamport assignments, which simplifies
 * test assertions.
 *
 * Within each group, entries are sorted by `createdAt` ascending so the
 * "earliest createdAt" rule for multi-entry `bundleCid` is well-defined.
 */
function groupLegacyEntries(
  entries: ReadonlyArray<LegacyOutboxEntry>,
): ReadonlyArray<LegacyGroup> {
  const buckets = new Map<string, LegacyOutboxEntry[]>();
  for (const e of entries) {
    const windowKey = Math.floor(e.createdAt / GROUP_WINDOW_MS);
    const k = `${e.recipientPubkey}::${windowKey}`;
    let list = buckets.get(k);
    if (list === undefined) {
      list = [];
      buckets.set(k, list);
    }
    list.push(e);
  }

  const out: LegacyGroup[] = [];
  for (const [k, list] of buckets) {
    const [recipientPubkey, windowKeyStr] = k.split('::', 2);
    const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt);
    out.push({
      recipientPubkey: recipientPubkey ?? '',
      windowKey: Number(windowKeyStr),
      entries: sorted,
    });
  }

  // Deterministic group order: by windowKey, then recipientPubkey.
  out.sort((a, b) => {
    if (a.windowKey !== b.windowKey) return a.windowKey - b.windowKey;
    if (a.recipientPubkey < b.recipientPubkey) return -1;
    if (a.recipientPubkey > b.recipientPubkey) return 1;
    return 0;
  });

  return out;
}

// =============================================================================
// 9. Synthesis (§7.2 step 2-3)
// =============================================================================

/**
 * Synthesize a single {@link OutboxWriteInput} for a legacy group. The
 * `OutboxWriter` will stamp `_schemaVersion: 'uxf-1'` and the Lamport.
 */
function synthesize(group: LegacyGroup, syntheticId: string, nowMs: number): OutboxWriteInput {
  if (group.entries.length === 0) {
    // Defensive — `groupLegacyEntries` never produces empty groups.
    throw new SphereError(
      'migrateLegacyOutbox: empty legacy group cannot be synthesized',
      'VALIDATION_ERROR',
    );
  }

  const earliest = group.entries[0]!; // sorted ascending by createdAt
  const latest = group.entries[group.entries.length - 1]!;

  // bundleCid form per §7.2 step 2.
  const bundleCid =
    group.entries.length === 1
      ? `txf-${earliest.sourceTokenId}`
      : `legacy-${group.recipientPubkey}-${earliest.createdAt}`;

  // tokenIds: dedupe and sort for determinism.
  const tokenIdSet = new Set<string>();
  for (const e of group.entries) tokenIdSet.add(e.sourceTokenId);
  const tokenIds = [...tokenIdSet].sort();

  // recipientNametag — first non-empty wins (§7.2 paragraph 4 / W18).
  const recipientNametag = pickFirstNametag(group.entries);

  // recipient field — prefer @nametag for UI continuity per §7.2 step 2.
  const recipient = recipientNametag !== undefined
    ? `@${recipientNametag}`
    : group.recipientPubkey;

  // Most-advanced status across the group (§7.2 step 3).
  const status = collapseStatus(group.entries.map((e) => e.status));

  // Error: take the most-recent error from the group, if any.
  const error = pickError(group.entries);

  // submitRetryCount: G-counter shape — max-merge per §7.1.
  const submitRetryCount = group.entries.reduce(
    (acc, e) => Math.max(acc, e.retryCount ?? 0),
    0,
  );

  const result: OutboxWriteInput = {
    id: syntheticId,
    bundleCid,
    tokenIds,
    deliveryMethod: 'txf-legacy',
    recipient,
    recipientTransportPubkey: group.recipientPubkey, // §7.2 step 2 — copied verbatim.
    mode: 'txf', // §7.2 step 2 — legacy was always TXF wire shape.
    status,
    submitRetryCount,
    proofErrorCount: 0,
    createdAt: earliest.createdAt,
    updatedAt: Math.max(latest.updatedAt, nowMs),
    ...(recipientNametag !== undefined ? { recipientNametag } : {}),
    ...(error !== undefined ? { error } : {}),
  };

  return result;
}

function pickFirstNametag(
  entries: ReadonlyArray<LegacyOutboxEntry>,
): string | undefined {
  for (const e of entries) {
    if (typeof e.recipientNametag === 'string' && e.recipientNametag.length > 0) {
      return e.recipientNametag;
    }
  }
  return undefined;
}

function pickError(
  entries: ReadonlyArray<LegacyOutboxEntry>,
): string | undefined {
  // Prefer error from the most-recently-updated entry that has one. This
  // mirrors the §7.1 conflict-resolution intuition for the `error` field
  // ("the more-advanced status wins; among equal-status replicas, the
  // earlier Lamport's error is preserved") — at migration time we have no
  // Lamport, so updatedAt-DESC is the closest proxy.
  const sortedDesc = [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const e of sortedDesc) {
    if (typeof e.error === 'string' && e.error.length > 0) {
      return e.error;
    }
  }
  return undefined;
}

/**
 * Collapse legacy status set → most-advanced UXF status.
 *
 * Ordering (most-advanced first):
 *   1. any `delivered` / `confirmed` → `'finalized'`
 *   2. any `pending`   / `submitted` → `'sending'`
 *   3. all `failed`                  → `'failed-permanent'`
 *
 * Mixed `failed` + `pending` falls into (2) — `'sending'`. Documented
 * choice: the wallet should re-attempt rather than freeze on the failed
 * record, matching the §7.0 partition rule "active wins over soft-terminal".
 */
function collapseStatus(
  legacyStatuses: ReadonlyArray<LegacyOutboxEntry['status']>,
): UxfOutboxStatus {
  let sawAdvanced = false;
  let sawActive = false;
  let sawFailed = false;
  for (const s of legacyStatuses) {
    if (s === 'delivered' || s === 'confirmed') sawAdvanced = true;
    else if (s === 'pending' || s === 'submitted') sawActive = true;
    else if (s === 'failed') sawFailed = true;
  }
  if (sawAdvanced) return 'finalized';
  if (sawActive) return 'sending';
  if (sawFailed) return 'failed-permanent';
  // Defensive fallback — `groupLegacyEntries` should never produce an empty
  // status array, but if it did, the safest assumption is "wallet may want
  // to retry this", i.e. `'sending'`.
  return 'sending';
}
