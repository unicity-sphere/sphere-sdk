/**
 * Integration tests for profile/token-storage-migration.ts (Issue #286).
 *
 * Uses real `FileTokenStorageProvider` + `FileStorageProvider` (no
 * IPFS, no OrbitDB) to verify the migration helper at the storage-
 * provider boundary. The Profile-backed providers are exercised only
 * by the unit test (Profile setup is heavy) — the file-based
 * integration is the closest representative we can run in CI without
 * spinning IPFS gateways.
 *
 * The integration test focuses on two scenarios:
 *   - End-to-end round-trip: legacy → "target" → reverse legacy → bytes
 *     preserved (the acceptance scenario from the issue body).
 *   - Replay of the sphere.telco PR #305 regression: a fresh target
 *     provider with no migration sees no tokens; the same target after
 *     migration sees the original token set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileTokenStorageProvider } from '../../../impl/nodejs/storage/FileTokenStorageProvider';
import { FileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import {
  migrateLegacyToProfile,
  migrateProfileToLegacy,
  isTokenStorageMigrationComplete,
} from '../../../extensions/uxf/profile/token-storage-migration';
import type { FullIdentity } from '../../../types';
import type { TxfToken } from '../../../types/txf';
import type { TxfStorageDataBase } from '../../../storage';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDENTITY: FullIdentity = {
  privateKey: '00' + '11'.repeat(31),
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://test',
  nametag: 'testuser',
};

function buildTxfToken(tokenId: string): TxfToken {
  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId,
        tokenType: '01'.repeat(32),
        coinData: [['UCT_HEX', '1000']],
        tokenData: '',
        salt: '55'.repeat(32),
        recipient: 'DIRECT://test',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: '02' + 'aa'.repeat(32),
          signature: '30' + '44'.repeat(35),
          stateHash: '0000' + 'a'.repeat(64),
        },
        merkleTreePath: { root: '00'.repeat(32), steps: [] },
        transactionHash: 'cd'.repeat(32),
        unicityCertificate: 'ab'.repeat(32),
      },
    },
    state: { data: '', predicate: 'de'.repeat(32) },
    transactions: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateTokenStorage — file-storage integration', () => {
  let sourceDir: string;
  let targetDir: string;
  let kvDir: string;

  beforeEach(() => {
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-src-'));
    targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-tgt-'));
    kvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-kv-'));
  });

  afterEach(() => {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(kvDir, { recursive: true, force: true });
  });

  it('end-to-end migrates a populated legacy provider to a fresh target', async () => {
    // Stage 1: seed the source provider with two tokens.
    const source = new FileTokenStorageProvider({ tokensDir: sourceDir });
    source.setIdentity(IDENTITY);
    await source.initialize();

    const tokenA = '0' + 'a'.repeat(63);
    const tokenB = '0' + 'b'.repeat(63);
    const seedData: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: IDENTITY.l1Address,
        formatVersion: '2.0',
        updatedAt: Date.now(),
      },
      [`_${tokenA}`]: buildTxfToken(tokenA),
      [`_${tokenB}`]: buildTxfToken(tokenB),
      _tombstones: [
        { tokenId: 'old', stateHash: 'x', timestamp: Date.now() },
      ],
    };
    await source.save(seedData);
    await source.shutdown();

    // Stage 2: spin up source and a fresh target. The target should
    // start empty — this models the PR #305 regression (a wallet that
    // swapped tokenStorage to a fresh provider and saw balance go to 0).
    const sourceReadOnly = new FileTokenStorageProvider({ tokensDir: sourceDir });
    sourceReadOnly.setIdentity(IDENTITY);
    await sourceReadOnly.initialize();

    const target = new FileTokenStorageProvider({ tokensDir: targetDir });
    target.setIdentity(IDENTITY);
    await target.initialize();

    // Pre-migration baseline — target sees nothing (the regression).
    const preLoad = await target.load();
    expect(preLoad.success).toBe(true);
    const preTokenKeys = Object.keys(preLoad.data ?? {}).filter(
      (k) => k.startsWith('_') && k !== '_meta' && k !== '_tombstones',
    );
    expect(preTokenKeys.length).toBe(0);

    // Stage 3: migrate. Use the convenience wrapper.
    const kv = new FileStorageProvider({ dataDir: kvDir });
    kv.setIdentity(IDENTITY);
    await kv.connect();

    const result = await migrateLegacyToProfile({
      legacy: sourceReadOnly,
      // FileTokenStorageProvider is a stand-in for the Profile target —
      // we exercise the migration helper at the TokenStorageProvider
      // boundary, so any provider works for the storage round-trip
      // contract. Profile-specific behavior (CAR encoding, OpLog
      // caps) is covered by the Profile unit tests.
      profile: target,
      identity: IDENTITY,
      markerStorage: kv,
    });

    expect(result.success).toBe(true);
    expect(result.skippedDueToMarker).toBe(false);
    expect(result.tokensMigrated).toBe(2);
    expect(result.tombstonesMigrated).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Stage 4: re-open target and confirm tokens are visible.
    const targetReload = new FileTokenStorageProvider({ tokensDir: targetDir });
    targetReload.setIdentity(IDENTITY);
    await targetReload.initialize();
    const postLoad = await targetReload.load();
    expect(postLoad.success).toBe(true);
    expect(postLoad.data?.[`_${tokenA}`]).toBeDefined();
    expect(postLoad.data?.[`_${tokenB}`]).toBeDefined();
    expect(postLoad.data?._tombstones).toHaveLength(1);

    // Stage 5: marker is set; re-running is a no-op.
    expect(
      await isTokenStorageMigrationComplete({
        markerStorage: kv,
        direction: 'legacy-to-profile',
        identity: IDENTITY,
      }),
    ).toBe(true);

    const secondRun = await migrateLegacyToProfile({
      legacy: sourceReadOnly,
      profile: target,
      identity: IDENTITY,
      markerStorage: kv,
    });
    expect(secondRun.skippedDueToMarker).toBe(true);
    expect(secondRun.tokensMigrated).toBe(0);

    // Cleanup
    await sourceReadOnly.shutdown();
    await target.shutdown();
    await targetReload.shutdown();
    await kv.disconnect();
  });

  it('reverse migration (profile → legacy) preserves token payload bytes', async () => {
    // Seed source
    const source = new FileTokenStorageProvider({ tokensDir: sourceDir });
    source.setIdentity(IDENTITY);
    await source.initialize();

    const tokenA = '0' + 'a'.repeat(63);
    const seed: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: IDENTITY.l1Address,
        formatVersion: '2.0',
        updatedAt: 1000,
      },
      [`_${tokenA}`]: buildTxfToken(tokenA),
    };
    await source.save(seed);
    await source.shutdown();

    // Migrate forward (legacy → "profile")
    const sourceReadOnly = new FileTokenStorageProvider({ tokensDir: sourceDir });
    sourceReadOnly.setIdentity(IDENTITY);
    await sourceReadOnly.initialize();
    const profileLike = new FileTokenStorageProvider({ tokensDir: targetDir });
    profileLike.setIdentity(IDENTITY);
    await profileLike.initialize();

    await migrateLegacyToProfile({
      legacy: sourceReadOnly,
      profile: profileLike,
      identity: IDENTITY,
    });

    // Now reverse: profile-like → fresh legacy
    const reverseLegacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-rev-'));
    try {
      const reverseLegacy = new FileTokenStorageProvider({ tokensDir: reverseLegacyDir });
      reverseLegacy.setIdentity(IDENTITY);
      await reverseLegacy.initialize();

      const result = await migrateProfileToLegacy({
        profile: profileLike,
        legacy: reverseLegacy,
        identity: IDENTITY,
      });
      expect(result.success).toBe(true);
      expect(result.direction).toBe('profile-to-legacy');
      expect(result.tokensMigrated).toBe(1);

      // Verify the reverse legacy provider sees the token after reload.
      await reverseLegacy.shutdown();
      const reverseReload = new FileTokenStorageProvider({ tokensDir: reverseLegacyDir });
      reverseReload.setIdentity(IDENTITY);
      await reverseReload.initialize();
      const final = await reverseReload.load();
      expect(final.success).toBe(true);
      expect(final.data?.[`_${tokenA}`]).toBeDefined();

      // The payload bytes match the seed (excluding _meta.updatedAt
      // which the migration refreshes).
      expect(final.data?.[`_${tokenA}`]).toEqual(seed[`_${tokenA}`]);

      await reverseReload.shutdown();
    } finally {
      fs.rmSync(reverseLegacyDir, { recursive: true, force: true });
    }

    await sourceReadOnly.shutdown();
    await profileLike.shutdown();
  });

  it('rerunning after marker clear re-migrates fresh source data', async () => {
    const source = new FileTokenStorageProvider({ tokensDir: sourceDir });
    source.setIdentity(IDENTITY);
    await source.initialize();
    const tokenA = '0' + 'a'.repeat(63);
    await source.save({
      _meta: {
        version: 1,
        address: IDENTITY.l1Address,
        formatVersion: '2.0',
        updatedAt: 1,
      },
      [`_${tokenA}`]: buildTxfToken(tokenA),
    } as TxfStorageDataBase);

    const target = new FileTokenStorageProvider({ tokensDir: targetDir });
    target.setIdentity(IDENTITY);
    await target.initialize();

    const kv = new FileStorageProvider({ dataDir: kvDir });
    kv.setIdentity(IDENTITY);
    await kv.connect();

    // First run
    await migrateLegacyToProfile({
      legacy: source,
      profile: target,
      identity: IDENTITY,
      markerStorage: kv,
    });

    // Add a second token to source
    const tokenB = '0' + 'b'.repeat(63);
    const sourceData = (await source.load()).data!;
    sourceData[`_${tokenB}` as keyof TxfStorageDataBase] = buildTxfToken(tokenB);
    await source.save(sourceData);

    // Second run with marker present — skipped.
    const skipped = await migrateLegacyToProfile({
      legacy: source,
      profile: target,
      identity: IDENTITY,
      markerStorage: kv,
    });
    expect(skipped.skippedDueToMarker).toBe(true);

    // Now force-rerun → tokenB is migrated.
    const forced = await migrateLegacyToProfile({
      legacy: source,
      profile: target,
      identity: IDENTITY,
      markerStorage: kv,
      force: true,
    });
    expect(forced.skippedDueToMarker).toBe(false);
    expect(forced.tokensMigrated).toBe(2);

    await source.shutdown();
    await target.shutdown();
    await kv.disconnect();
  });
});
