#!/usr/bin/env npx tsx
/**
 * UXF Inter-Wallet Transfer — Legacy outbox RESTORE script (T.6.D.2)
 *
 * Reverses {@link migrateLegacyOutbox} (T.6.D) using the on-disk backup
 * written at `${addr}.legacyOutbox.backup`. Idempotent. Operator-driven.
 *
 * # Why this exists
 *
 * T.6.D's migration is one-way at the data level — synthetic UXF entries
 * are written under `${addr}.outbox.${id}` keys and the original legacy
 * entries are deleted. If a deployment hits a regression that requires
 * rolling back to the legacy code path (post-cutover but pre-T.8.D), this
 * script is the supported recovery mechanism. It reads the backup snapshot
 * captured at migration time and re-writes each legacy `OutboxEntry` back
 * to its original `${addr}.outbox.${id}` key.
 *
 * # The C7 round-trip property
 *
 * Per UXF-TRANSFER-PROTOCOL §7.2 paragraph 5 / §7.C back-out:
 *
 *   migrate(W) → backup(W) ; restore(backup(W)) → W
 *
 * (modulo the Lamport stamps written by the migration's UXF-shape outputs,
 * which are unrelated to the legacy entries and are NOT touched here).
 *
 * **C7 PR gating**: T.8.D merge is gated on the round-trip integration test
 * `tests/integration/profile/legacy-outbox-restore-roundtrip.test.ts`
 * passing. That test plants legacy entries → migrates → restores → asserts
 * byte-identity to the original snapshot.
 *
 * # Idempotency
 *
 * Re-running the restore against a wallet whose legacy entries are already
 * present is a no-op for those entries. The script:
 *   1. Reads the backup at `${addr}.legacyOutbox.backup`.
 *   2. For each entry in the backup:
 *        a. Reads the current value at `${addr}.outbox.${id}`.
 *        b. If the parsed value is identical (legacy shape, same fields)
 *           → skip (counted as `alreadySkipped`).
 *        c. Otherwise → write the legacy entry, overwriting whatever was
 *           there (UXF synthetic, partial restore, etc.).
 *
 * The default policy is "the backup wins": any UXF-shape entry under the
 * same prefix is overwritten by the legacy form when the backup carries an
 * entry with the same id. Operators who want to preserve UXF entries
 * should inspect the backup before running this script.
 *
 * # Sentinel handling — DEFAULT: DO NOT CLEAR
 *
 * The migration sentinel (`${addr}.legacyOutbox.migrated`) is intentionally
 * NOT cleared by default. Reasoning:
 *
 *   - Restore is a recovery action; the operator presumably wants the
 *     migration to NOT re-run on the next wallet boot (otherwise the
 *     restore is immediately undone). Leaving the sentinel in place means
 *     the next boot's `migrateLegacyOutbox()` call exits as
 *     `alreadyMigrated: true` and DOES NOT touch the freshly-restored
 *     legacy entries.
 *   - If the operator's intent is "fully rewind to pre-migration state and
 *     allow the migration to run again", they pass `--clear-sentinel`.
 *     This is a stronger action and requires explicit consent.
 *
 * The CLI prints a clear note in both modes.
 *
 * # Dry-run
 *
 * `--dry-run` prints what would be restored without writing. Reads the
 * backup, classifies every entry into `would-restore | already-restored |
 * mismatch`, and prints a per-entry diff. Useful for "did the migration
 * run cleanly" forensics without committing to the rewrite.
 *
 * # CLI surface
 *
 *   npx tsx tools/restore-legacy-outbox.ts \
 *     --addr <addr> \
 *     --profile-path <path> \
 *     [--encryption-key <hex>] \
 *     [--dry-run] \
 *     [--clear-sentinel] \
 *     [--quiet]
 *
 *   --addr             Address id (the `${addr}` prefix in
 *                      `${addr}.outbox.${id}`). Required.
 *   --profile-path     Path to the OrbitDB store directory. Required for
 *                      CLI usage; ignored when called programmatically
 *                      with an explicit `db` instance.
 *   --encryption-key   AES-256 key (64 hex chars) used to decrypt the
 *                      backup. Omit for unencrypted profiles. The script
 *                      uses the same key to RE-encrypt restored values
 *                      so on-disk parity is preserved.
 *   --dry-run          Read+classify; do not write. Exits 0.
 *   --clear-sentinel   ALSO delete `${addr}.legacyOutbox.migrated` so the
 *                      migration is allowed to re-run on the next boot.
 *                      Default: keep the sentinel (recommended for
 *                      rollback).
 *   --quiet            Suppress the per-entry summary; print only the
 *                      JSON result.
 *
 * # Programmatic usage
 *
 * ```ts
 * import { restoreLegacyOutbox } from './tools/restore-legacy-outbox.js';
 *
 * const result = await restoreLegacyOutbox({
 *   addr: 'DIRECT_aabbcc_ddeeff',
 *   db: profileDatabase,        // any ProfileDatabase instance
 *   encryptionKey: null,         // or Uint8Array for encrypted profiles
 *   dryRun: false,
 *   clearSentinel: false,
 * });
 *
 * console.log(result);
 * // → { restored: 5, alreadyRestored: 0, mismatched: 0, backupNotFound: false,
 * //     sentinelCleared: false }
 * ```
 *
 * @module tools/restore-legacy-outbox
 *
 * @see profile/migration-outbox.ts          (T.6.D — the forward migration)
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md    §7.2 paragraph 5, §7.C back-out
 */

import { decryptProfileValue, encryptProfileValue } from '../extensions/uxf/profile/encryption.js';
import {
  backupKey,
  sentinelKey,
  type LegacyOutboxBackup,
} from '../extensions/uxf/profile/migration-outbox.js';
import { isLegacyOutboxEntry, type LegacyOutboxEntry } from '../extensions/uxf/types/uxf-outbox.js';
import type { ProfileDatabase } from '../extensions/uxf/profile/types.js';

// =============================================================================
// 1. Public API types
// =============================================================================

/**
 * Construction-time options for {@link restoreLegacyOutbox}.
 */
export interface RestoreOptions {
  /** Address id — the `${addr}` prefix in `${addr}.outbox.${id}`. */
  readonly addr: string;
  /** OrbitDB key-value adapter — same instance the migration used. */
  readonly db: ProfileDatabase;
  /** AES-256 key for decrypting the backup AND re-encrypting on-disk
   *  values. Pass `null` when the wallet has no profile encryption (parity
   *  with the migration writer). */
  readonly encryptionKey: Uint8Array | null;
  /** Read-only mode: classify entries but do not write. Default `false`. */
  readonly dryRun?: boolean;
  /** Also delete the migration sentinel so the migration can re-run.
   *  Default `false` — operators who want this MUST opt in explicitly. */
  readonly clearSentinel?: boolean;
}

/**
 * Per-entry classification produced by {@link restoreLegacyOutbox}.
 */
export interface RestoreEntryClassification {
  readonly key: string;
  readonly id: string;
  readonly state: 'would-restore' | 'already-restored' | 'mismatch';
  /** `true` when state is anything other than `already-restored`. The
   *  caller can sum this for a quick "did the dry-run find work to do"
   *  check. */
  readonly wouldChange: boolean;
}

/**
 * Result of a {@link restoreLegacyOutbox} call.
 */
export interface RestoreResult {
  /**
   * Number of legacy entries actually written (or that WOULD be written
   * in `dry-run` mode). In normal mode this equals the count of
   * `state === 'would-restore'` plus `state === 'mismatch'` entries.
   */
  readonly restored: number;
  /**
   * Number of entries skipped because the on-disk value already matched
   * the backup byte-for-byte (legacy-shape, same fields).
   */
  readonly alreadyRestored: number;
  /**
   * Number of entries where the on-disk key carried a non-legacy value
   * (UXF synthetic, partial migration leftover, etc.) that was overwritten
   * by the legacy form.
   */
  readonly mismatched: number;
  /**
   * `true` when no backup was found at `${addr}.legacyOutbox.backup`.
   * In this case `restored`, `alreadyRestored`, `mismatched` are all 0
   * and the per-entry log is empty.
   */
  readonly backupNotFound: boolean;
  /**
   * `true` when `--clear-sentinel` was set and the sentinel was deleted.
   * Always `false` when `clearSentinel` was unset OR when running in
   * dry-run mode.
   */
  readonly sentinelCleared: boolean;
  /**
   * `true` when this run committed no writes (because `dryRun` was set,
   * the backup was empty, or every entry was already restored).
   */
  readonly dryRun: boolean;
  /** Per-entry log; stable in backup order. */
  readonly entries: ReadonlyArray<RestoreEntryClassification>;
}

// =============================================================================
// 2. Programmatic entry point
// =============================================================================

/**
 * Restore legacy {@link LegacyOutboxEntry} records from the backup written
 * at `${addr}.legacyOutbox.backup` (per T.6.D's C7 step 4).
 *
 * **Idempotent**. Re-running the script after a successful restore detects
 * that every backup entry already exists at its original key and skips the
 * write.
 *
 * **Backup-wins on conflict**. If the on-disk value at
 * `${addr}.outbox.${id}` is a UXF-shape synthetic (or any other shape),
 * the legacy form from the backup overwrites it. The decision matrix:
 *
 *   | On-disk shape       | Action                    | Counted as          |
 *   |---------------------|---------------------------|---------------------|
 *   | legacy, identical   | skip                      | alreadyRestored     |
 *   | legacy, different   | overwrite                 | mismatched          |
 *   | UXF (`uxf-1`)       | overwrite                 | mismatched          |
 *   | tombstone           | overwrite                 | mismatched          |
 *   | missing             | write                     | restored (fresh)    |
 *
 * The "restored" count includes ALL writes (fresh + mismatched). The
 * separate `mismatched` field surfaces overwrites for forensic visibility.
 *
 * **Sentinel default**. Without `clearSentinel: true`, the migration
 * sentinel is preserved so the next boot's `migrateLegacyOutbox()` call
 * exits as `alreadyMigrated` and does not re-clobber the restored entries.
 * Set `clearSentinel: true` to fully rewind.
 *
 * @returns Counts and per-entry classification.
 */
export async function restoreLegacyOutbox(opts: RestoreOptions): Promise<RestoreResult> {
  validateOptions(opts);
  const dryRun = opts.dryRun === true;
  const clearSentinel = opts.clearSentinel === true;

  // ===========================================================================
  // Step 1 — read the backup. Missing → return early.
  // ===========================================================================
  const backup = await readBackup(opts);
  if (backup === null) {
    return {
      restored: 0,
      alreadyRestored: 0,
      mismatched: 0,
      backupNotFound: true,
      sentinelCleared: false,
      dryRun,
      entries: [],
    };
  }

  // ===========================================================================
  // Step 2 — classify every backup entry.
  //
  // Three states:
  //   - already-restored: on-disk value parses as a legacy entry that
  //     equals the backup field-by-field. Skip.
  //   - mismatch:         the key exists on disk but holds something
  //     other than the matching legacy entry — UXF synthetic, partial
  //     restore, tombstone, corrupt JSON, etc. Overwrite.
  //   - would-restore:    the key is absent on disk. Fresh write.
  //
  // We probe `keyExists` separately so a non-legacy shape on disk is
  // surfaced as `mismatch`, not silently classified as `would-restore`.
  // The latter would lose visibility into "this restore is overwriting
  // a UXF synthetic" — exactly the forensic signal an operator needs.
  // ===========================================================================
  const classifications: RestoreEntryClassification[] = [];
  let alreadyRestored = 0;
  let mismatched = 0;
  let writeCount = 0;

  for (const backupEntry of backup.entries) {
    const exists = await keyExists(opts, backupEntry.key);
    const onDisk = exists ? await readEntry(opts, backupEntry.key) : null;
    let state: RestoreEntryClassification['state'];

    if (exists && onDisk !== null && legacyEntriesEqual(onDisk, backupEntry.value)) {
      state = 'already-restored';
      alreadyRestored++;
    } else if (exists) {
      state = 'mismatch';
      mismatched++;
      writeCount++;
    } else {
      state = 'would-restore';
      writeCount++;
    }

    classifications.push({
      key: backupEntry.key,
      id: backupEntry.value.id,
      state,
      wouldChange: state !== 'already-restored',
    });
  }

  // ===========================================================================
  // Step 3 — write (unless dry-run).
  // ===========================================================================
  if (!dryRun) {
    for (let i = 0; i < backup.entries.length; i++) {
      const cls = classifications[i]!;
      if (cls.state === 'already-restored') continue;
      const backupEntry = backup.entries[i]!;
      await writeEntry(opts, backupEntry.key, backupEntry.value);
    }
  }

  // ===========================================================================
  // Step 4 — clear sentinel if asked (and not dry-run).
  // ===========================================================================
  let sentinelCleared = false;
  if (clearSentinel && !dryRun) {
    await opts.db.del(sentinelKey(opts.addr));
    sentinelCleared = true;
  }

  return {
    restored: writeCount,
    alreadyRestored,
    mismatched,
    backupNotFound: false,
    sentinelCleared,
    dryRun,
    entries: classifications,
  };
}

// =============================================================================
// 3. Internal helpers
// =============================================================================

function validateOptions(opts: RestoreOptions): void {
  if (typeof opts.addr !== 'string' || opts.addr.length === 0) {
    throw new Error('restoreLegacyOutbox: addr must be a non-empty string');
  }
  if (opts.db === null || typeof opts.db !== 'object') {
    throw new Error('restoreLegacyOutbox: db must be a ProfileDatabase instance');
  }
}

/**
 * Read and parse the backup at `${addr}.legacyOutbox.backup`.
 * Returns `null` when the key is absent OR the backup is malformed.
 *
 * Treating a malformed backup as "missing" is the conservative choice:
 * an operator who explicitly invoked the restore script with garbage on
 * disk should see `backupNotFound: true` and investigate, rather than
 * have us crash with a parse error mid-restore.
 */
async function readBackup(opts: RestoreOptions): Promise<LegacyOutboxBackup | null> {
  const raw = await opts.db.get(backupKey(opts.addr));
  if (raw === null) return null;

  let plaintext: Uint8Array;
  try {
    plaintext = opts.encryptionKey
      ? await decryptProfileValue(opts.encryptionKey, raw)
      : raw;
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }

  if (!isLegacyOutboxBackup(parsed)) return null;
  return parsed;
}

/**
 * Shape guard for {@link LegacyOutboxBackup}. Strict on the discriminator
 * + container, lenient on the entries (already validated by the legacy
 * shape sniff at restore time).
 */
function isLegacyOutboxBackup(value: unknown): value is LegacyOutboxBackup {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj._backupVersion !== 1) return false;
  if (typeof obj._addr !== 'string' || obj._addr.length === 0) return false;
  if (typeof obj._capturedAt !== 'number') return false;
  if (!Array.isArray(obj.entries)) return false;
  for (const e of obj.entries) {
    if (e === null || typeof e !== 'object') return false;
    const entry = e as Record<string, unknown>;
    if (typeof entry.key !== 'string') return false;
    if (!isLegacyOutboxEntry(entry.value)) return false;
  }
  return true;
}

/**
 * Probe key existence without parsing. Used by the classifier to
 * distinguish "key absent" from "key holds a non-legacy shape" — both
 * yield `null` from {@link readEntry}, but they require different
 * states (`would-restore` vs `mismatch`) for forensic clarity.
 */
async function keyExists(opts: RestoreOptions, key: string): Promise<boolean> {
  const raw = await opts.db.get(key);
  return raw !== null;
}

/**
 * Read and decode a single legacy entry at `key`. Returns the parsed
 * value if it round-trips through the legacy shape sniff; otherwise
 * `null` (UXF-shape, tombstone, corrupt JSON, decryption failure, etc.).
 *
 * Returning `null` for non-legacy shapes is what drives the `mismatch`
 * classification: the on-disk value exists but does not equal the
 * backup, so the restore overwrites it.
 */
async function readEntry(
  opts: RestoreOptions,
  key: string,
): Promise<LegacyOutboxEntry | null> {
  const raw = await opts.db.get(key);
  if (raw === null) return null;

  let plaintext: Uint8Array;
  try {
    plaintext = opts.encryptionKey
      ? await decryptProfileValue(opts.encryptionKey, raw)
      : raw;
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }

  if (!isLegacyOutboxEntry(parsed)) return null;
  return parsed;
}

/**
 * Write a legacy entry to `key` using the same encryption posture as
 * the migration backup (encrypted iff `encryptionKey` is set).
 *
 * **Byte-identity contract**: the JSON serialization here uses
 * `JSON.stringify(value)` which preserves the property-order and
 * scalar-form of the source object. Combined with a backup that was
 * itself written via `JSON.stringify(snapshot)` at migration time,
 * the round-trip preserves the original on-disk plaintext. Encryption
 * uses a fresh IV per call (AES-GCM), so the CIPHERTEXT bytes will
 * differ run-to-run; the PLAINTEXT bytes round-trip exactly.
 */
async function writeEntry(
  opts: RestoreOptions,
  key: string,
  value: LegacyOutboxEntry,
): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const toWrite = opts.encryptionKey
    ? await encryptProfileValue(opts.encryptionKey, encoded)
    : encoded;
  await opts.db.put(key, toWrite);
}

/**
 * Field-by-field equality for two parsed legacy entries.
 *
 * Why not `JSON.stringify(a) === JSON.stringify(b)`? Property order can
 * differ between the in-memory representation and the on-disk value
 * (especially when the operator manually edited the backup). The
 * discriminating fields are the documented contract; comparing them
 * structurally avoids false-positives on cosmetic ordering changes.
 *
 * The `recipientNametag`, `error`, `retryCount` fields are optional;
 * `undefined` and absent both count as "no value" and compare equal.
 */
function legacyEntriesEqual(a: LegacyOutboxEntry, b: LegacyOutboxEntry): boolean {
  if (a.id !== b.id) return false;
  if (a.status !== b.status) return false;
  if (a.sourceTokenId !== b.sourceTokenId) return false;
  if (a.salt !== b.salt) return false;
  if (a.commitmentJson !== b.commitmentJson) return false;
  if (a.recipientPubkey !== b.recipientPubkey) return false;
  if (a.amount !== b.amount) return false;
  if (a.createdAt !== b.createdAt) return false;
  if (a.updatedAt !== b.updatedAt) return false;
  if ((a.recipientNametag ?? null) !== (b.recipientNametag ?? null)) return false;
  if ((a.error ?? null) !== (b.error ?? null)) return false;
  if ((a.retryCount ?? null) !== (b.retryCount ?? null)) return false;
  return true;
}

// =============================================================================
// 4. CLI entry point
// =============================================================================

/**
 * CLI argument parser — minimal, intentional. Returns a typed shape OR
 * an error message. Callers exit on error.
 */
interface CliArgs {
  readonly addr: string;
  readonly profilePath: string;
  readonly encryptionKey: Uint8Array | null;
  readonly dryRun: boolean;
  readonly clearSentinel: boolean;
  readonly quiet: boolean;
}

export function parseCliArgs(argv: ReadonlyArray<string>): CliArgs | { readonly error: string } {
  let addr: string | undefined;
  let profilePath: string | undefined;
  let encryptionKeyHex: string | undefined;
  let dryRun = false;
  let clearSentinel = false;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--addr') {
      addr = argv[++i];
    } else if (arg === '--profile-path') {
      profilePath = argv[++i];
    } else if (arg === '--encryption-key') {
      encryptionKeyHex = argv[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--clear-sentinel') {
      clearSentinel = true;
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'HELP' };
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }

  if (typeof addr !== 'string' || addr.length === 0) {
    return { error: '--addr is required' };
  }
  if (typeof profilePath !== 'string' || profilePath.length === 0) {
    return { error: '--profile-path is required' };
  }

  let encryptionKey: Uint8Array | null = null;
  if (typeof encryptionKeyHex === 'string') {
    if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
      return {
        error: '--encryption-key must be 64 hex characters (32 bytes)',
      };
    }
    encryptionKey = hexToBytes(encryptionKeyHex);
  }

  return { addr, profilePath, encryptionKey, dryRun, clearSentinel, quiet };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const HELP_TEXT = `\
usage: npx tsx tools/restore-legacy-outbox.ts \\
         --addr <addr> --profile-path <path> \\
         [--encryption-key <hex>] [--dry-run] \\
         [--clear-sentinel] [--quiet]

Restore legacy outbox entries from the T.6.D backup snapshot.

Options:
  --addr <addr>              Required. Address id, e.g. DIRECT_aabbcc_ddeeff
  --profile-path <path>      Required. OrbitDB store directory.
  --encryption-key <hex>     Optional. AES-256 key (64 hex chars).
  --dry-run                  Classify only; do not write.
  --clear-sentinel           Also delete \${addr}.legacyOutbox.migrated so
                             the migration is allowed to re-run on the
                             next boot. Default: keep the sentinel.
  --quiet                    Print JSON result only.

Exit codes:
  0  success (or backup not found, with diagnostic stderr)
  1  invalid arguments / runtime error
`;

/**
 * Construct a {@link ProfileDatabase} from a profile path. Implementation
 * is deferred to the runtime — production callers wire `OrbitDbAdapter`,
 * tests inject a mock.
 *
 * The CLI dynamically imports the ProfileKv modules so the unit tests
 * (which never reach this branch) do not pull in the KV / blockstore
 * tree at test-collection time.
 */
async function openProductionDatabase(profilePath: string): Promise<ProfileDatabase> {
  const adapterMod = (await import('../extensions/uxf/profile/kv/profile-kv-adapter.js')) as {
    ProfileKvAdapter: new (opts: unknown) => ProfileDatabase;
  };
  const kvMod = (await import('../extensions/uxf/profile/kv/profile-kv-node.js')) as {
    ProfileKvNode: new (opts: { directory: string }) => unknown;
  };
  const cacheMod = (await import('../extensions/uxf/profile/kv/local-block-cache-node.js')) as {
    LocalBlockCacheNode: new (opts: { directory: string }) => unknown;
  };
  const db = new adapterMod.ProfileKvAdapter({
    backendFactory: (shortName: string) =>
      new kvMod.ProfileKvNode({ directory: `${profilePath}/kv-${shortName}` }),
    blockCacheFactory: (shortName: string) =>
      new cacheMod.LocalBlockCacheNode({ directory: `${profilePath}/kv-${shortName}/blocks` }),
  });
  await db.connect({ directory: profilePath });
  return db;
}

/**
 * CLI main — invoked when this file is run directly via `npx tsx`.
 *
 * Exported so tests can drive it without spawning a subprocess.
 */
export async function main(
  argv: ReadonlyArray<string>,
  io: {
    readonly stdout: (s: string) => void;
    readonly stderr: (s: string) => void;
    readonly openDb?: (profilePath: string) => Promise<ProfileDatabase>;
  } = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  },
): Promise<number> {
  const parsed = parseCliArgs(argv);
  if ('error' in parsed) {
    if (parsed.error === 'HELP') {
      io.stdout(HELP_TEXT);
      return 0;
    }
    io.stderr(`error: ${parsed.error}\n\n${HELP_TEXT}`);
    return 1;
  }

  const opener = io.openDb ?? openProductionDatabase;
  let db: ProfileDatabase;
  try {
    db = await opener(parsed.profilePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`error: failed to open profile database: ${msg}\n`);
    return 1;
  }

  let result: RestoreResult;
  try {
    result = await restoreLegacyOutbox({
      addr: parsed.addr,
      db,
      encryptionKey: parsed.encryptionKey,
      dryRun: parsed.dryRun,
      clearSentinel: parsed.clearSentinel,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`error: restore failed: ${msg}\n`);
    try {
      await db.close();
    } catch {
      /* best-effort */
    }
    return 1;
  }

  try {
    await db.close();
  } catch {
    /* best-effort cleanup */
  }

  if (!parsed.quiet) {
    if (result.backupNotFound) {
      io.stderr(
        `note: no backup found at \${addr}.legacyOutbox.backup — nothing to restore\n`,
      );
    } else {
      io.stdout(`Address: ${parsed.addr}\n`);
      io.stdout(`Mode:    ${result.dryRun ? 'dry-run' : 'commit'}\n`);
      io.stdout(`Sentinel: ${result.sentinelCleared ? 'cleared' : 'preserved'}\n`);
      for (const entry of result.entries) {
        io.stdout(`  [${entry.state}] ${entry.id}\n`);
      }
    }
  }

  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

// Standard ESM idiom: detect direct invocation. When imported, this
// branch is skipped.
if (
  typeof process !== 'undefined' &&
  typeof import.meta !== 'undefined' &&
  // `process.argv[1]` is the entry point; `import.meta.url` is this file.
  // When they reference the same file (modulo file://), we are running
  // directly and should invoke main().
  import.meta.url === `file://${process.argv[1] ?? ''}`
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
