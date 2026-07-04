/**
 * WalletApiCheckpointStore (E.4, sphere-sdk#501) — the SplitCheckpointStore adapter over the
 * wallet-api §16 intent-progress surface. Verifies the crypto/adopt boundary: AAD-bound
 * encryption round-trips, a mis-served (cross-slot) record fails at decrypt as a keep-open
 * SplitCheckpointLostError, insert-once put returns the WINNER's bytes (adopt), and get is null
 * when the slot is empty.
 */
import { describe, expect, it } from 'vitest';

import { deriveFieldEncryptionKey, decryptFieldBytes } from '../../../core/field-encryption';
import { SplitCheckpointLostError } from '../../../token-engine';
import {
  WalletApiCheckpointStore,
  type CheckpointProgressPort,
} from '../../../impl/shared/wallet-api/WalletApiCheckpointStore';

const PRIV = 'a1'.repeat(32);

/** An in-memory §16 progress backend: insert-once first-write-wins per (transferId, opIndex). */
class InMemoryProgressPort implements CheckpointProgressPort {
  public readonly slots = new Map<string, { opIndex: number; payload: string }[]>();

  public postIntentProgress(transferId: string, opIndex: number, payloadEnvelope: string): Promise<string> {
    const records = this.slots.get(transferId) ?? [];
    this.slots.set(transferId, records);
    const existing = records.find((r) => r.opIndex === opIndex);
    if (existing) return Promise.resolve(existing.payload); // first-write-wins
    records.push({ opIndex, payload: payloadEnvelope });
    return Promise.resolve(payloadEnvelope);
  }

  public getIntentProgress(transferId: string): Promise<readonly { opIndex: number; payload: string }[]> {
    return Promise.resolve(this.slots.get(transferId) ?? []);
  }
}

describe('WalletApiCheckpointStore (E.4)', () => {
  const key = deriveFieldEncryptionKey(PRIV);
  const CKPT = new Uint8Array([0xca, 0xfe, 0x00, 0x80, 0x13, 0x37]); // non-UTF-8 checkpoint bytes

  it('round-trips a checkpoint: put then get returns the exact plaintext bytes', async () => {
    const port = new InMemoryProgressPort();
    const store = new WalletApiCheckpointStore(port, key);

    const put = await store.put('transfer-1', 0, CKPT);
    expect(Array.from(put)).toEqual(Array.from(CKPT));

    const got = await store.get('transfer-1', 0);
    expect(got).not.toBeNull();
    expect(Array.from(got as Uint8Array)).toEqual(Array.from(CKPT));

    // What actually crossed the wire is an enc1. envelope, not the plaintext.
    const stored = port.slots.get('transfer-1')![0].payload;
    expect(stored.startsWith('enc1.')).toBe(true);
  });

  it('get returns null when the slot is empty', async () => {
    const store = new WalletApiCheckpointStore(new InMemoryProgressPort(), key);
    expect(await store.get('transfer-x', 0)).toBeNull();
  });

  it('binds the record to its slot: a record mis-served for a different opIndex fails at decrypt', async () => {
    const port = new InMemoryProgressPort();
    const store = new WalletApiCheckpointStore(port, key);
    await store.put('transfer-1', 0, CKPT);

    // Simulate a malicious/buggy server serving slot 0's envelope under slot 1 (opIndex 1).
    const misServed = port.slots.get('transfer-1')![0].payload;
    port.slots.set('transfer-1', [{ opIndex: 1, payload: misServed }]);

    await expect(store.get('transfer-1', 1)).rejects.toBeInstanceOf(SplitCheckpointLostError);
    await expect(store.get('transfer-1', 1)).rejects.toThrow(/could not be decrypted/);
  });

  it('a record mis-served for a different transferId also fails at decrypt (cross-intent replay)', async () => {
    const portA = new InMemoryProgressPort();
    const storeA = new WalletApiCheckpointStore(portA, key);
    await storeA.put('transfer-A', 0, CKPT);
    const aEnvelope = portA.slots.get('transfer-A')![0].payload;

    // Serve intent A's envelope as intent B's slot 0.
    const portB = new InMemoryProgressPort();
    portB.slots.set('transfer-B', [{ opIndex: 0, payload: aEnvelope }]);
    const storeB = new WalletApiCheckpointStore(portB, key);
    await expect(storeB.get('transfer-B', 0)).rejects.toBeInstanceOf(SplitCheckpointLostError);
  });

  it('insert-once adopt: a second put with different bytes returns the FIRST writer bytes', async () => {
    const port = new InMemoryProgressPort();
    const store = new WalletApiCheckpointStore(port, key);

    const winner = new Uint8Array([1, 2, 3]);
    const loserBytes = new Uint8Array([9, 9, 9]);
    await store.put('transfer-1', 0, winner);

    // The loser encrypts DIFFERENT plaintext, but the server's first-write-wins returns the winner
    // envelope; the adapter decrypts it → the loser must adopt the WINNER's bytes.
    const adopted = await store.put('transfer-1', 0, loserBytes);
    expect(Array.from(adopted)).toEqual(Array.from(winner));
  });

  it('encrypts once per put (a fresh random nonce) but the SAME plaintext decrypts identically', async () => {
    const port = new InMemoryProgressPort();
    const store = new WalletApiCheckpointStore(port, key);
    await store.put('transfer-1', 0, CKPT);
    const envelope = port.slots.get('transfer-1')![0].payload;
    // AAD is transferId:opIndex — decrypting with the same AAD recovers the plaintext.
    const aad = new TextEncoder().encode('transfer-1:0');
    expect(Array.from(decryptFieldBytes(key, envelope, aad))).toEqual(Array.from(CKPT));
  });
});
