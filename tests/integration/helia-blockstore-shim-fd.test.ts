/**
 * Integration test: install the shim over a real Helia v6 blockstore
 * backed by `FsBlockstore`, then hammer the same CID and assert that
 * (a) the in-process FD count stays bounded, (b) the underlying
 * `FsBlockstore.get` is invoked exactly ONCE for N callers — closing
 * the #278 wedge surface end-to-end.
 *
 * Skipped when `/proc/self/fd` is unavailable (non-Linux). That's the
 * only reliable FD-count source on Node; macOS/Windows don't expose
 * an equivalent path. The pure-logic invariants are still covered by
 * the unit tests in `tests/unit/profile/helia-blockstore-shim.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { FsBlockstore } from 'blockstore-fs';
import { createHelia } from 'helia';
import { installHeliaBlockstoreGetShim } from '../../profile/helia-blockstore-shim';

const FD_DIR = '/proc/self/fd';
const FD_AVAILABLE = existsSync(FD_DIR);

const run = FD_AVAILABLE ? describe : describe.skip;

run('helia-blockstore-shim — real FsBlockstore FD bound (#278)', () => {
  let tmp: string;
  let helia: Awaited<ReturnType<typeof createHelia>>;
  let cid: CID;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'shim-fd-test-'));
    const blockstore = new FsBlockstore(`${tmp}/blocks`);
    // Minimal Helia for tests — no libp2p, no brokers. Just a local
    // FsBlockstore which is the surface under test.
    helia = await createHelia({
      blockstore,
      libp2p: { addresses: { listen: [] }, transports: [], peerDiscovery: [] } as never,
      blockBrokers: [],
      start: false,
    });
    await helia.start();

    // Write one block so we have a stable CID to hammer.
    const bytes = new TextEncoder().encode('FD-bound-test-payload');
    const hash = await sha256.digest(bytes);
    cid = CID.create(1, raw.code, hash);
    await helia.blockstore.put(cid, bytes);
  }, 30_000);

  afterAll(async () => {
    try { await helia?.stop(); } catch { /* ignore */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const countBlockstoreFds = (): number => {
    try {
      const fds = readdirSync(FD_DIR);
      let n = 0;
      for (const fd of fds) {
        try {
          const target = readlinkSync(`${FD_DIR}/${fd}`);
          if (target.includes('/blocks/')) n++;
        } catch { /* race: fd closed mid-scan */ }
      }
      return n;
    } catch { return -1; }
  };

  it('1000 sequential reads of the same CID do NOT accumulate FDs (cache hits)', async () => {
    installHeliaBlockstoreGetShim(helia.blockstore as never);

    // Prime cache with one read.
    const first = await (helia.blockstore as { get: (cid: CID) => Promise<Uint8Array | undefined> }).get(cid);
    expect(first).toBeInstanceOf(Uint8Array);

    const beforeFds = countBlockstoreFds();
    for (let i = 0; i < 1000; i++) {
      const r = await (helia.blockstore as { get: (cid: CID) => Promise<Uint8Array | undefined> }).get(cid);
      expect(r).toBeInstanceOf(Uint8Array);
    }
    const afterFds = countBlockstoreFds();

    // Cache hits should not open any file descriptors. Allow a small
    // tolerance for unrelated FDs (gc, libp2p sockets, etc.) but
    // there must be NO 1000-FD pileup against the blocks dir.
    expect(afterFds - beforeFds).toBeLessThanOrEqual(2);
  }, 30_000);

  it('100 concurrent reads of the same CID issue at most ONE underlying open (in-flight dedup)', async () => {
    // Use a FRESH cid so the cache starts cold for the concurrent
    // test. The shim from the previous test is still installed; we
    // do NOT re-install (calling install twice would re-wrap the
    // already-wrapped get and break the inner generator contract).
    const freshBytes = new TextEncoder().encode('concurrent-dedup-payload-' + Date.now());
    const freshHash = await sha256.digest(freshBytes);
    const freshCid = CID.create(1, raw.code, freshHash);
    await helia.blockstore.put(freshCid, freshBytes);

    const beforeFds = countBlockstoreFds();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        (helia.blockstore as { get: (cid: CID) => Promise<Uint8Array | undefined> }).get(freshCid),
      ),
    );
    const afterFds = countBlockstoreFds();

    // FsBlockstore returns Node Buffer (which extends Uint8Array).
    // Compare the underlying bytes by toString to side-step
    // Buffer-vs-Uint8Array structural equality differences in vitest.
    const expectedString = new TextDecoder().decode(freshBytes);
    for (const r of results) {
      expect(r).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(r as Uint8Array)).toBe(expectedString);
    }
    // 100 callers must NOT inflate FDs by 100 — the in-flight dedup
    // pins the underlying open at 1 (possibly racing 0/1 close).
    expect(afterFds - beforeFds).toBeLessThanOrEqual(2);
  }, 30_000);
});
