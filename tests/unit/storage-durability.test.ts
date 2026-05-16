/**
 * Durability-marker regression tests.
 *
 * The aggregator-pointer FlagStore (SPEC §7.1.3) refuses to initialize
 * on a backend that does not advertise durable writes via the
 * DURABLE_STORAGE symbol. These tests pin that contract for the two
 * production local-cache providers, so a regression that drops the
 * marker (e.g., constructor refactor, extracted superclass) fails
 * here instead of silently disabling the pointer layer at runtime.
 *
 * We do NOT re-verify the durability guarantees themselves — those
 * are:
 *   - IndexedDB: write methods resolve on `tx.oncomplete`
 *   - File:      writeSync + fsyncSync + atomic rename
 * and are covered by their respective provider tests.
 */

import 'fake-indexeddb/auto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterAll } from 'vitest';

import { createIndexedDBStorageProvider } from '../../impl/browser/storage/IndexedDBStorageProvider';
import { createFileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { isDurableProvider } from '../../profile/aggregator-pointer';

describe('production local-cache provider durability markers', () => {
  it('IndexedDBStorageProvider advertises DURABLE_STORAGE', () => {
    const provider = createIndexedDBStorageProvider();
    expect(isDurableProvider(provider)).toBe(true);
  });

  it('FileStorageProvider advertises DURABLE_STORAGE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durability-marker-'));
    try {
      const provider = createFileStorageProvider({ dataDir: tmpDir });
      expect(isDurableProvider(provider)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Best-effort cleanup of any leaked tmp dirs from aborted runs.
  afterAll(() => {
    /* intentionally empty — the per-test try/finally handles cleanup */
  });
});
