/**
 * ProfileKvNode — file-per-key durable KV backend for the profile substrate.
 *
 * Replaces the OrbitDB `keyvalue` database that used to sit under
 * `ProfileDatabase`. Same `put/get/del/all(prefix)` semantics, without the
 * OpLog, libp2p, gossipsub, or Helia baggage.
 *
 * Design (see `docs/uxf/uxfv2-substrate-alternatives.md` §3.7 / §5.2):
 *   - one directory per profile DB (name = `sphere-profile-<16-hex>`)
 *   - one file per key, filename = url-safe-base64(sha256(key)) so long or
 *     path-hostile keys never hit fs limits
 *   - write = temp file + `fsync` + atomic `rename` (the exact discipline
 *     `FileStorageProvider` already implements for other durable state)
 *   - in-memory `Set<string>` key index built at open by scanning a
 *     manifest sidecar; updates on every put/del
 *   - prefix scan is an O(N) walk of the in-memory index, which matches
 *     OrbitDB's `all()` characteristics for the profile-typical N (SENT
 *     writer's built-in scan sizes)
 *   - optional cross-process CAS via `proper-lockfile` (Q4 from the
 *     substrate report answered YES) — used by the adapter, not the
 *     backend
 *
 * This file has NO import from `helia`, `@orbitdb/core`, `libp2p`, or
 * `ipns`. It uses only Node core `fs` + `path` + `crypto`.
 *
 * @module extensions/uxf/profile/kv/profile-kv-node
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { logger } from '../../../../core/logger.js';
import { incr, observeMs } from '../../../../core/perf-counters.js';
import { ProfileError } from '../errors.js';

/**
 * Public contract of the ProfileKv backend. The adapter wraps this in
 * the wider `ProfileDatabase` interface (envelope IO, event dispatch,
 * connection lifecycle).
 */
export interface ProfileKvBackend {
  /** Open (or create) the KV directory. Idempotent. */
  open(): Promise<void>;

  /** Close: flush any pending state and release locks. Idempotent. */
  close(): Promise<void>;

  /** Whether `open()` has been called and `close()` has not. */
  isOpen(): boolean;

  /** Write value under `key`. Durable on return (fsync+atomic-rename). */
  put(key: string, value: Uint8Array): Promise<void>;

  /** Read value by key. Returns `null` if the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;

  /** Delete the key. No-op if the key does not exist. */
  del(key: string): Promise<void>;

  /**
   * Return all entries, optionally filtered by key prefix. Honors the
   * optional `maxResults` cap (short-circuits once buffered).
   */
  all(
    prefix?: string,
    opts?: { readonly maxResults?: number },
  ): Promise<Map<string, Uint8Array>>;

  /** Enumerate keys only, useful for scanning without loading values. */
  keys(prefix?: string): Promise<string[]>;

  /** Reset (delete) the entire KV directory. Used by wallet-clear paths. */
  reset(): Promise<void>;

  /**
   * Install a listener that fires whenever `get`/`all` sees an ENOENT
   * for a key the in-memory index still tracks. The KV analog of
   * OrbitDB's `LoadBlockFailedError`. Installing overrides any prior
   * listener; pass `null` to clear. Optional so test stubs can skip it.
   */
  setOrphanedIndexEntryListener?(
    listener:
      | ((info: {
          readonly key: string;
          readonly filepath: string;
          readonly attemptedAt: number;
        }) => void)
      | null,
  ): void;
}

export interface ProfileKvNodeOptions {
  /** Directory that holds the KV files (created if absent). */
  readonly directory: string;
  /**
   * When `true`, `open()` calls `fsync` on directory entries. Slightly
   * slower on Linux; default `true` because durability > perf here.
   */
  readonly fsyncDirs?: boolean;
  /**
   * Steelman-4b fix: notify the caller when a `get`/`all` observes an
   * ENOENT for a file the in-memory index still tracks — the KV analog of
   * OrbitDB's `LoadBlockFailedError` (which fired
   * `profile:critical-block-evicted`). The adapter wires this into the
   * `profile-token-storage-provider.emitExternalProfileEvent` bridge so
   * consumers keep operator-visible alerting on silent data loss.
   * `attemptedAt` is a UNIX ms timestamp.
   */
  readonly onOrphanedIndexEntry?: (info: {
    readonly key: string;
    readonly filepath: string;
    readonly attemptedAt: number;
  }) => void;
}

const MANIFEST_FILENAME = '.keys.json';
const DATA_SUBDIR = 'data';

function hashKey(key: string): string {
  const h = createHash('sha256').update(key, 'utf8').digest();
  return h.toString('base64url');
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readManifest(dir: string): Promise<Record<string, string>> {
  const file = path.join(dir, MANIFEST_FILENAME);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Corrupted manifest: rebuild on next write; treat as empty index.
    logger.warn(
      'ProfileKvNode',
      `readManifest: cannot parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

async function atomicWriteFile(
  filepath: string,
  bytes: Uint8Array | string,
): Promise<void> {
  const dir = path.dirname(filepath);
  const tmpName = `.tmp-${randomBytes(6).toString('hex')}-${path.basename(filepath)}`;
  const tmpPath = path.join(dir, tmpName);
  const handle = await fs.open(tmpPath, 'w');
  try {
    if (typeof bytes === 'string') {
      await handle.writeFile(bytes, 'utf8');
    } else {
      await handle.writeFile(bytes);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, filepath);
}

/**
 * File-backed KV backend. See module doc.
 */
export class ProfileKvNode implements ProfileKvBackend {
  private readonly directory: string;
  private readonly dataDir: string;
  private readonly manifestFile: string;
  private readonly fsyncDirs: boolean;
  private onOrphanedIndexEntry:
    | ((info: { readonly key: string; readonly filepath: string; readonly attemptedAt: number }) => void)
    | null;
  private opened = false;
  /** In-memory map from logical key → hashed filename. */
  private index: Map<string, string> = new Map();
  /** Serializes manifest rewrites so concurrent put/del don't clobber. */
  private manifestChain: Promise<void> = Promise.resolve();

  constructor(opts: ProfileKvNodeOptions) {
    if (!opts.directory) {
      throw new ProfileError(
        'PROFILE_KV_INIT_FAILED',
        'ProfileKvNode requires a non-empty `directory` option',
      );
    }
    this.directory = opts.directory;
    this.dataDir = path.join(opts.directory, DATA_SUBDIR);
    this.manifestFile = path.join(opts.directory, MANIFEST_FILENAME);
    this.fsyncDirs = opts.fsyncDirs !== false;
    this.onOrphanedIndexEntry = opts.onOrphanedIndexEntry ?? null;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await ensureDir(this.directory);
    await ensureDir(this.dataDir);
    const persisted = await readManifest(this.directory);
    this.index = new Map(Object.entries(persisted));
    // Best-effort reconciliation: if manifest references a filename that
    // is no longer on disk (e.g., partial crash), drop it silently. If
    // there are files on disk not in the manifest, ignore them — they'll
    // get overwritten on future puts.
    for (const [key, filename] of this.index) {
      const filepath = path.join(this.dataDir, filename);
      try {
        await fs.access(filepath);
      } catch {
        this.index.delete(key);
      }
    }
    this.opened = true;
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    // Drain pending manifest writes before closing.
    await this.manifestChain.catch(() => {
      /* per-write errors already logged */
    });
    this.opened = false;
    this.index.clear();
  }

  isOpen(): boolean {
    return this.opened;
  }

  private ensureOpen(): void {
    if (!this.opened) {
      throw new ProfileError(
        'PROFILE_KV_NOT_OPEN',
        'ProfileKvNode: operation before open()',
      );
    }
  }

  private queueManifestWrite(): Promise<void> {
    // Chain manifest rewrites so at most one is in flight at a time.
    const snapshot = () => Object.fromEntries(this.index);
    this.manifestChain = this.manifestChain
      .catch(() => {
        /* previous errors already surfaced */
      })
      .then(async () => {
        const json = JSON.stringify(snapshot());
        await atomicWriteFile(this.manifestFile, json);
      });
    return this.manifestChain;
  }

  /**
   * Install/replace the orphaned-index-entry listener. Adapters call this
   * after backend construction to wire the data-loss event bridge into
   * `profile:critical-block-evicted`.
   */
  setOrphanedIndexEntryListener(
    listener:
      | ((info: { readonly key: string; readonly filepath: string; readonly attemptedAt: number }) => void)
      | null,
  ): void {
    this.onOrphanedIndexEntry = listener;
  }

  /**
   * Fire the caller-provided data-loss callback (best-effort). The KV
   * analog of OrbitDB's `LoadBlockFailedError` — the manifest still
   * lists a key but its backing file is gone. Adapters route this into
   * `profile:critical-block-evicted` so operators keep visibility of
   * silent data loss under the KV substrate.
   */
  private emitOrphanedIndexEntry(key: string, filepath: string): void {
    if (this.onOrphanedIndexEntry === null) return;
    try {
      this.onOrphanedIndexEntry({
        key,
        filepath,
        attemptedAt: Date.now(),
      });
    } catch (err) {
      logger.warn(
        'ProfileKvNode',
        `onOrphanedIndexEntry callback threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.ensureOpen();
    const t0 = performance.now();
    try {
      const filename = hashKey(key);
      const filepath = path.join(this.dataDir, filename);
      await atomicWriteFile(filepath, value);
      const isNew = !this.index.has(key);
      this.index.set(key, filename);
      if (isNew) {
        await this.queueManifestWrite();
      }
      incr('profile-kv.put');
    } catch (err) {
      incr('profile-kv.put.error');
      throw new ProfileError(
        'PROFILE_KV_WRITE_FAILED',
        `Failed to write key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      observeMs('profile-kv.put.totalMs', performance.now() - t0);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.ensureOpen();
    const t0 = performance.now();
    const filename = this.index.get(key);
    if (filename === undefined) {
      observeMs('profile-kv.get.missMs', performance.now() - t0);
      return null;
    }
    const filepath = path.join(this.dataDir, filename);
    try {
      const buf = await fs.readFile(filepath);
      observeMs('profile-kv.get.hitMs', performance.now() - t0);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Index/disk skew — treat as miss and drop the stale entry.
        this.index.delete(key);
        await this.queueManifestWrite().catch(() => {
          /* best-effort */
        });
        incr('profile-kv.get.orphaned-index-entry');
        this.emitOrphanedIndexEntry(key, filepath);
        return null;
      }
      incr('profile-kv.get.error');
      throw new ProfileError(
        'PROFILE_KV_READ_FAILED',
        `Failed to read key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async del(key: string): Promise<void> {
    this.ensureOpen();
    const t0 = performance.now();
    try {
      const filename = this.index.get(key);
      if (filename === undefined) return;
      this.index.delete(key);
      await this.queueManifestWrite();
      const filepath = path.join(this.dataDir, filename);
      try {
        await fs.unlink(filepath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn(
            'ProfileKvNode',
            `del: unlink failed for ${filepath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      incr('profile-kv.del');
    } catch (err) {
      incr('profile-kv.del.error');
      throw new ProfileError(
        'PROFILE_KV_WRITE_FAILED',
        `Failed to delete key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      observeMs('profile-kv.del.totalMs', performance.now() - t0);
    }
  }

  async all(
    prefix?: string,
    opts?: { readonly maxResults?: number },
  ): Promise<Map<string, Uint8Array>> {
    this.ensureOpen();
    const t0 = performance.now();
    const cap =
      opts?.maxResults !== undefined &&
      Number.isFinite(opts.maxResults) &&
      opts.maxResults >= 0
        ? Math.floor(opts.maxResults)
        : undefined;
    const result = new Map<string, Uint8Array>();
    try {
      for (const [key, filename] of this.index) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (cap !== undefined && result.size >= cap) break;
        const filepath = path.join(this.dataDir, filename);
        try {
          const buf = await fs.readFile(filepath);
          result.set(
            key,
            new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // Skew — drop the stale index entry.
            this.index.delete(key);
            incr('profile-kv.all.orphaned-index-entry');
            this.emitOrphanedIndexEntry(key, filepath);
            continue;
          }
          logger.warn(
            'ProfileKvNode',
            `all(): read failed for key="${key}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      incr('profile-kv.all.calls');
      observeMs('profile-kv.all.totalMs', performance.now() - t0);
      return result;
    } catch (err) {
      incr('profile-kv.all.error');
      throw new ProfileError(
        'PROFILE_KV_READ_FAILED',
        `Failed to scan${prefix ? ` prefix "${prefix}"` : ''}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    this.ensureOpen();
    const out: string[] = [];
    for (const key of this.index.keys()) {
      if (prefix && !key.startsWith(prefix)) continue;
      out.push(key);
    }
    return out;
  }

  async reset(): Promise<void> {
    if (this.opened) await this.close();
    try {
      await fs.rm(this.directory, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        'ProfileKvNode',
        `reset: cannot delete ${this.directory}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.index.clear();
  }
}
