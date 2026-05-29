/**
 * E2E Test: Profile (OrbitDB) Invoice Token Durability — Issue #234
 *
 * Reproduces the failure mode from `manual-test-full-recovery.sh §C.1b`:
 * an invoice token minted in one process is not visible to the next
 * process started on the same wallet/dataDir.
 *
 * The test verifies that the invoice token survives a destroy()+recreate
 * cycle on the same dataDir+tokensDir. The cross-process variant in the
 * manual-test script exercises the same SDK durability surface — both
 * paths share the same Profile flush/load semantics.
 *
 * Diagnostic findings while building this test (recorded inline as
 * comments for future operators):
 *
 *   - The mint succeeds; PaymentsModule.addToken writes the invoice
 *     into ProfileTokenStorageProvider.pendingData.
 *   - The flush succeeds: the CAR is pinned via HTTP to the configured
 *     IPFS gateways and the bundle CID is written to the shared
 *     OrbitDbAdapter via bundleIndex.addBundle.
 *   - The bundle CID PERSISTS in OrbitDB across destroy/restart.
 *   - Pre-#236: the next process's load() resolved that CID through
 *     IPFS HTTP gateways and depended on ~15s gateway propagation.
 *
 * Issue #236 — cross-process durability without gateway propagation.
 * `pinCarBlocksToIpfs` now writes every block to the local Helia
 * blockstore (managed by `OrbitDbAdapter`) before the HTTP pin, and
 * `fetchCarFromIpfs` consults the same blockstore first on the fetch
 * path. Both phases of this test share the same `dataDir` and re-open
 * Helia on the persisted on-disk store, so the post-destroy re-init
 * reads blocks locally with NO HTTP gateway round-trip — propagation
 * lag is no longer in the critical path. The 15s wait that PR #235
 * needed to buffer gateway propagation is now redundant.
 *
 * Required infra: aggregator (L3 mint) + ipfs (Profile CAR pin).
 *
 * Run with: `npm run test:e2e`.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { Sphere } from '../../core/Sphere';
import { makeTempDirs, ensureTrustbase } from './helpers';
import { makeProfileProviders, unwrapProfileProviders } from './profile-helpers';
import { preflightSkip } from './lib/preflight';

const SKIP_INFRA = preflightSkip(
  ['aggregator', 'ipfs'],
  'profile-invoice-durability-234',
);

describe.skipIf(SKIP_INFRA)(
  'Profile (OrbitDB) Invoice Token Durability — Issue #234',
  () => {
    const cleanupDirs: string[] = [];
    const spheres: Sphere[] = [];

    afterAll(async () => {
      for (const s of spheres) {
        try {
          await s.destroy();
        } catch {
          /* cleanup */
        }
      }
      spheres.length = 0;
      for (const d of cleanupDirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* cleanup */
        }
      }
      cleanupDirs.length = 0;
    });

    it('invoice token minted then destroy()ed survives re-init on same dirs', async () => {
      const dirs = makeTempDirs('issue-234-durability');
      cleanupDirs.push(dirs.base);
      await ensureTrustbase(dirs.dataDir);

      // ---------------- Phase 1: mint invoice + destroy ----------------
      // Suppress auto-flush so awaitNextFlush below drives the exact
      // moment of CAR pin + OrbitDB ref-write.
      const providersA = makeProfileProviders(dirs, { flushDebounceMs: 300_000 });
      console.log('\n[Issue #234] Phase 1: init wallet with accounting...');
      const initResult = await Sphere.init({
        ...providersA,
        autoGenerate: true,
        accounting: true,
      });
      const sphereA = initResult.sphere;
      spheres.push(sphereA);
      expect(initResult.created).toBe(true);
      expect(initResult.generatedMnemonic).toBeTruthy();
      const mnemonic = initResult.generatedMnemonic!;
      const directAddress = sphereA.identity!.directAddress!;
      console.log(`  Wallet A: ${sphereA.identity!.l1Address}`);

      console.log('  Minting invoice for 11000000 UCT to self...');
      const invResult = await sphereA.accounting!.createInvoice({
        targets: [
          {
            address: directAddress,
            assets: [{ coin: ['UCT', '11000000'] }],
          },
        ],
        memo: 'issue-234 cross-process durability repro',
      });
      expect(invResult.success).toBe(true);
      expect(invResult.invoiceId).toBeTruthy();
      const invoiceId = invResult.invoiceId!;
      console.log(`  Minted invoice: ${invoiceId}`);

      const tokensBeforeDestroy = sphereA.payments.getTokens();
      expect(
        tokensBeforeDestroy.some((t) => t.id === invoiceId),
        `invoice token ${invoiceId} should be in payments storage right after mint`,
      ).toBe(true);

      // Force the in-flight write all the way through pin+ref-write.
      const tokenStorageA = unwrapProfileProviders(providersA).tokenStorage;
      await tokenStorageA.awaitNextFlush(60_000);

      console.log('  Destroying sphereA...');
      await sphereA.destroy();
      spheres.splice(spheres.indexOf(sphereA), 1);

      // Issue #236 — no propagation buffer required. Helia's on-disk
      // blockstore persists across the destroy() above and re-opens
      // when Phase 2's `OrbitDbAdapter.connect()` recreates Helia with
      // the same `directory`. The next `tokenStorage.load()` reads the
      // bundle blocks from local Helia synchronously, regardless of
      // HTTP gateway propagation. Removing this wait is the primary
      // acceptance signal for issue #236.

      // ---------------- Phase 2: re-init on the SAME dirs --------------
      console.log('\n[Issue #234] Phase 2: re-init on SAME dirs...');
      const providersB = makeProfileProviders(dirs);
      const reInitResult = await Sphere.init({
        ...providersB,
        mnemonic,
        accounting: true,
      });
      const sphereB = reInitResult.sphere;
      spheres.push(sphereB);
      expect(
        reInitResult.created,
        'second init should LOAD (wallet exists on disk), not CREATE',
      ).toBe(false);
      console.log(`  Wallet B (re-loaded): ${sphereB.identity!.l1Address}`);

      const tokensAfterReload = sphereB.payments.getTokens();
      const invoicesAfterReload = await sphereB.accounting!.getInvoices();
      console.log(
        `  Post-reload: ${tokensAfterReload.length} tokens, ${invoicesAfterReload.length} invoices`,
      );

      expect(
        tokensAfterReload.some((t) => t.id === invoiceId),
        `Issue #234: invoice token ${invoiceId} must survive destroy + re-init`,
      ).toBe(true);
      expect(
        invoicesAfterReload.some((i) => i.invoiceId === invoiceId),
        `Issue #234: invoice ref ${invoiceId} must survive destroy + re-init`,
      ).toBe(true);

      console.log('[Issue #234] PASSED');
    }, 180_000);
  },
);
