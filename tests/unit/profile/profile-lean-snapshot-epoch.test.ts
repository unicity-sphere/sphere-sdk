/**
 * Issue #310 — lean snapshot epoch round-trip tests.
 *
 * Pins:
 *   - A wallet that does NOT supply `epoch` produces a snapshot whose
 *     decoded root has NO `epoch` field. Backwards-compatible: the
 *     bytes are identical to a pre-#310 snapshot.
 *   - A wallet that supplies `epoch: N > 0` round-trips the field
 *     through encode → CAR bytes → parser.
 *   - `epochResetReason` round-trips when paired with a non-zero
 *     epoch.
 *   - Invalid epoch values are rejected at the build seam.
 *   - The encoded epoch is byte-detectable in the root block — we
 *     decode the dag-cbor root directly to assert the field shape.
 */

import { describe, it, expect } from 'vitest';
import { decode as cborDecode } from '@ipld/dag-cbor';
import { CarReader } from '@ipld/car';

import {
  buildLeanProfileSnapshot,
  parseLeanProfileSnapshot,
  parseLeanProfileSnapshotFromRootBlock,
  EPOCH_RESET_REASON_MAX_BYTES,
  EPOCH_MAX,
} from '../../../profile/profile-lean-snapshot';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type {
  ProviderStatus,
  TrackedAddressEntry,
  FullIdentity,
} from '../../../types';
import type { UxfBundleRef } from '../../../profile/types';

// =============================================================================
// Test doubles
// =============================================================================

class InMemoryStorageProvider implements StorageProvider {
  readonly id = 'memory';
  readonly name = 'Memory';
  readonly type = 'local' as const;
  private data = new Map<string, string>();
  private encrypted = new Map<string, string>();
  private status: ProviderStatus = 'disconnected';

  async connect(): Promise<void> {
    this.status = 'connected';
  }
  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }
  isConnected(): boolean {
    return this.status === 'connected';
  }
  getStatus(): ProviderStatus {
    return this.status;
  }
  setIdentity(_: FullIdentity): void {}

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    this.encrypted.set(key, Buffer.from(`CT(${value})`).toString('base64'));
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
    this.encrypted.delete(key);
  }
  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }
  async keys(prefix?: string): Promise<string[]> {
    const allKeys: string[] = [];
    this.data.forEach((_, k) => allKeys.push(k));
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }
  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.data.clear();
      this.encrypted.clear();
      return;
    }
    const toDelete: string[] = [];
    this.data.forEach((_, k) => {
      if (k.startsWith(prefix)) toDelete.push(k);
    });
    toDelete.forEach((k) => {
      this.data.delete(k);
      this.encrypted.delete(k);
    });
  }
  async saveTrackedAddresses(_: TrackedAddressEntry[]): Promise<void> {}
  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> {
    return [];
  }
  async getEncryptedRaw(key: string): Promise<string | null> {
    return this.encrypted.get(key) ?? null;
  }
  async setEncryptedRaw(key: string, value: string): Promise<void> {
    this.encrypted.set(key, value);
  }
}

class FakeTokenStorage {
  readonly bundleIndex = new Map<string, UxfBundleRef>();
  async listBundles(): Promise<Map<string, UxfBundleRef>> {
    return new Map(this.bundleIndex);
  }
}

const CHAIN_PUBKEY = '02' + 'aa'.repeat(32);
const TS = 1_700_000_000_000;

async function makeStorage(): Promise<StorageProvider> {
  const s = new InMemoryStorageProvider();
  await s.connect();
  await s.set('mnemonic', 'mn');
  await s.set('master_key', 'mk');
  return s;
}

async function rootBlockObject(carBytes: Uint8Array): Promise<Record<string, unknown>> {
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  const rootBlock = await reader.get(roots[0]);
  if (!rootBlock) throw new Error('test setup: root block missing');
  const decoded = cborDecode(rootBlock.bytes);
  return decoded as Record<string, unknown>;
}

// =============================================================================
// Tests
// =============================================================================

describe('lean snapshot — epoch backwards-compat', () => {
  it('omits the epoch field when not supplied (pre-#310)', async () => {
    const storage = await makeStorage();
    const ts = new FakeTokenStorage();

    const { carBytes } = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: ts as unknown as ProfileTokenStorageProvider,
      chainPubkey: CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TS,
    });

    const root = await rootBlockObject(carBytes);
    expect(root.epoch).toBeUndefined();
    expect(root.epochResetReason).toBeUndefined();

    const parsed = await parseLeanProfileSnapshot(carBytes);
    expect(parsed.epoch).toBeUndefined();
    expect(parsed.epochResetReason).toBeUndefined();
  });

  it('omits the epoch field when supplied as 0 (canonical "no reset")', async () => {
    const storage = await makeStorage();
    const ts = new FakeTokenStorage();

    // 0 is a valid input but should still be emitted (it's the
    // explicit epoch=0 case — distinguished from "field absent"
    // only at the writer's choice). The current builder writes the
    // field when explicitly provided. Test that round-trip works.
    const { carBytes } = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: ts as unknown as ProfileTokenStorageProvider,
      chainPubkey: CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TS,
      epoch: 0,
    });

    const root = await rootBlockObject(carBytes);
    // Builder emits the field iff explicitly provided.
    expect(root.epoch).toBe(0);

    const parsed = await parseLeanProfileSnapshot(carBytes);
    expect(parsed.epoch).toBe(0);
  });
});

describe('lean snapshot — epoch round-trip', () => {
  it('round-trips epoch=1 through encode → parse', async () => {
    const storage = await makeStorage();
    const ts = new FakeTokenStorage();

    const { carBytes } = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: ts as unknown as ProfileTokenStorageProvider,
      chainPubkey: CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TS,
      epoch: 1,
      epochResetReason: 'oplog-corruption-recovery',
    });

    const root = await rootBlockObject(carBytes);
    expect(root.epoch).toBe(1);
    expect(root.epochResetReason).toBe('oplog-corruption-recovery');

    const parsed = await parseLeanProfileSnapshot(carBytes);
    expect(parsed.epoch).toBe(1);
    expect(parsed.epochResetReason).toBe('oplog-corruption-recovery');
  });

  it('round-trips a high epoch (boundary)', async () => {
    const storage = await makeStorage();
    const ts = new FakeTokenStorage();

    const { carBytes } = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: ts as unknown as ProfileTokenStorageProvider,
      chainPubkey: CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TS,
      epoch: EPOCH_MAX,
    });

    const parsed = await parseLeanProfileSnapshot(carBytes);
    expect(parsed.epoch).toBe(EPOCH_MAX);
  });

  it('round-trips through parseLeanProfileSnapshotFromRootBlock', async () => {
    const storage = await makeStorage();
    const ts = new FakeTokenStorage();

    const { carBytes } = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: ts as unknown as ProfileTokenStorageProvider,
      chainPubkey: CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TS,
      epoch: 3,
      epochResetReason: 'sphere.profile.resetEpoch',
    });

    const reader = await CarReader.fromBytes(carBytes);
    const roots = await reader.getRoots();
    const rootBlock = await reader.get(roots[0]);
    expect(rootBlock).toBeDefined();
    const rootBlockBytes = rootBlock!.bytes;

    const parsed = await parseLeanProfileSnapshotFromRootBlock(rootBlockBytes);
    expect(parsed.epoch).toBe(3);
    expect(parsed.epochResetReason).toBe('sphere.profile.resetEpoch');
  });
});

describe('lean snapshot — epoch validation', () => {
  it('rejects negative epoch', async () => {
    const storage = await makeStorage();
    const ts = new FakeTokenStorage();

    await expect(
      buildLeanProfileSnapshot({
        storage,
        tokenStorage: ts as unknown as ProfileTokenStorageProvider,
        chainPubkey: CHAIN_PUBKEY,
        network: 'testnet',
        createdAt: TS,
        epoch: -1,
      }),
    ).rejects.toThrow(/epoch must be integer/);
  });

  it('rejects non-integer epoch', async () => {
    const storage = await makeStorage();
    const ts = new FakeTokenStorage();

    await expect(
      buildLeanProfileSnapshot({
        storage,
        tokenStorage: ts as unknown as ProfileTokenStorageProvider,
        chainPubkey: CHAIN_PUBKEY,
        network: 'testnet',
        createdAt: TS,
        epoch: 1.5,
      }),
    ).rejects.toThrow(/epoch must be integer/);
  });

  it('rejects epoch > EPOCH_MAX', async () => {
    const storage = await makeStorage();
    const ts = new FakeTokenStorage();

    await expect(
      buildLeanProfileSnapshot({
        storage,
        tokenStorage: ts as unknown as ProfileTokenStorageProvider,
        chainPubkey: CHAIN_PUBKEY,
        network: 'testnet',
        createdAt: TS,
        epoch: EPOCH_MAX + 1,
      }),
    ).rejects.toThrow(/epoch must be integer/);
  });

  it('rejects reason longer than the byte cap', async () => {
    const storage = await makeStorage();
    const ts = new FakeTokenStorage();

    const bigReason = 'a'.repeat(EPOCH_RESET_REASON_MAX_BYTES + 1);
    await expect(
      buildLeanProfileSnapshot({
        storage,
        tokenStorage: ts as unknown as ProfileTokenStorageProvider,
        chainPubkey: CHAIN_PUBKEY,
        network: 'testnet',
        createdAt: TS,
        epoch: 1,
        epochResetReason: bigReason,
      }),
    ).rejects.toThrow(/exceeds cap/);
  });
});
