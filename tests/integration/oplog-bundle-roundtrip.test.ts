/**
 * #207 E2E acceptance — diagnostic for the OrbitDB CBOR decode failure
 * observed in `tests/e2e/profile-live-concurrent-sync.test.ts`.
 *
 * Reproduces the exact write/read flow that `addBundle` exercises:
 *   1. Build a typed OpLog envelope (`buildLocalEntry`) wrapping an
 *      encrypted-style Uint8Array payload.
 *   2. Encode it via `@ipld/dag-cbor` (`encodeEntry`).
 *   3. Write the bytes to OrbitDB via `db.putEntry`.
 *   4. Read back via `db.getEntry` (which calls `decodeEntry`).
 *
 * Pin: the round-trip MUST be lossless. A decode failure here proves the
 * regression is in the put/get layer (OrbitDB's internal encoding) rather
 * than in our caller-side handling.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OrbitDbAdapter } from '../../extensions/uxf/profile/orbitdb-adapter.js';
import { buildLocalEntry, decodeEntry, encodeEntry } from '../../extensions/uxf/profile/oplog-entry.js';
import { randomBytes } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
const describeOrSkip = nodeVersion >= 22 ? describe : describe.skip;

function randomKey(): string {
  return randomBytes(32).toString('hex');
}

function makeTempDir(label: string): string {
  const dir = path.join(os.tmpdir(), `oplog-roundtrip-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

describeOrSkip('OpLog bundle envelope round-trip (#207 diagnostic)', { timeout: 60_000 }, () => {
  let adapter: OrbitDbAdapter;
  let testDir: string;

  beforeAll(async () => {
    testDir = makeTempDir('main');
    adapter = new OrbitDbAdapter();
    await adapter.connect({
      privateKey: randomKey(),
      directory: testDir,
      enablePubSub: false,
      bootstrapPeers: [],
    });
  });

  afterAll(async () => {
    await adapter.close();
    cleanupDir(testDir);
  });

  it('putEntry → getEntry round-trips a bundle envelope (the actual addBundle path)', async () => {
    const key = 'tokens.bundle.bafyreitestkey';
    const fakeEncryptedPayload = new Uint8Array([0xfa, 0x11, 0xff, 0xee, 0x00, 0xc0, 0xff, 0xee]);

    const envelope = buildLocalEntry({
      type: 'cache_index',
      originated: 'system',
      payload: fakeEncryptedPayload,
    });

    // Write via the structured-entry API (the path addBundle takes).
    await adapter.putEntry(key, envelope);

    // Diagnostic: also verify the encoded bytes round-trip locally
    // (sanity check that our own encode/decode is consistent).
    const localBytes = encodeEntry(envelope);
    const localRoundTrip = decodeEntry(localBytes);
    expect(localRoundTrip.v).toBe(1);
    expect(Array.from(localRoundTrip.payload)).toEqual(Array.from(fakeEncryptedPayload));

    // Now read back via OrbitDB → decodeEntry (the path lean-snapshot
    // takes via getEncryptedRaw).
    const recovered = await adapter.getEntry(key, { trustLocalClaim: true });
    expect(recovered).not.toBeNull();
    expect(recovered!.v).toBe(1);
    expect(recovered!.type).toBe('cache_index');
    expect(Array.from(recovered!.payload)).toEqual(Array.from(fakeEncryptedPayload));
  });

  it('raw db.get returns the same bytes we put (byte-identity check)', async () => {
    const key = 'tokens.bundle.raw-byte-check';
    const envelope = buildLocalEntry({
      type: 'cache_index',
      originated: 'system',
      payload: new Uint8Array([1, 2, 3, 4, 5]),
    });
    const cborBytes = encodeEntry(envelope);
    await adapter.put(key, cborBytes);

    // Read raw bytes back. This bypasses decodeEntry.
    const raw = await adapter.get(key);
    expect(raw).not.toBeNull();

    // Compare byte-for-byte. If OrbitDB transforms the bytes (e.g.,
    // re-encodes Uint8Array via a different CBOR encoder that emits a
    // tag), the comparison fails and we have proof of the encoding
    // round-trip defect.
    expect(Array.from(raw!)).toEqual(Array.from(cborBytes));
  });

  // The #207 E2E acceptance root cause: BundleIndex.joinSnapshot.writeRemote
  // uses `db.put(key, encryptedPayloadBytes)` — RAW encrypted bytes, no envelope.
  // When the wallet later reads this key via `db.getEntry` → `decodeEntry`,
  // the encrypted payload is not valid `@ipld/dag-cbor` and decode throws
  // "tag not supported (X)" — surfacing as the ProfileLeanSnapshot warning
  // observed in the E2E test logs.
  it('REPRO: raw db.put of non-envelope bytes makes getEntry fail with CBOR decode error', async () => {
    const key = 'tokens.bundle.repro-snapshot-write';
    // Mimic what joinSnapshot.writeRemote does: write the RAW encrypted
    // payload directly (no envelope wrapper). Use bytes that look like
    // an AES-GCM ciphertext — random-looking — to trigger the same
    // decode failure observed in the failing E2E test.
    const encryptedPayloadBytes = new Uint8Array([
      // Header byte that looks like CBOR major type 6 (tagged value)
      // with an unsupported tag — triggers `@ipld/dag-cbor`'s "tag not
      // supported" branch the same way as real ciphertext.
      0xca, // major 6, minor 10 → tag 10
      0x01,
      0x02,
      0x03,
    ]);
    await adapter.put(key, encryptedPayloadBytes);

    let caught: unknown = null;
    try {
      await adapter.getEntry(key, { trustLocalClaim: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(String(caught)).toMatch(/CBOR decode|tag not supported/);
  });
});
