/**
 * tests/support/wallet-api-test-helpers.ts — shared fixtures for the S1/S2
 * tests: synthetic token blobs, in-memory key-value stores, and identities.
 *
 * Synthetic tokens use the real sphere `TokenBlob` envelope (CBOR tag 39051)
 * with an inner-token payload of JSON `{ assets, salt }` bytes — the format
 * the fake server's default `decodeAssets` port reads. The REAL backend
 * decodes the value via SpherePaymentData inside an SDK-verified v2 token
 * (ARCHITECTURE §8.2); these fixtures exercise the storage/wire contracts
 * without an aggregator.
 */

import { getPublicKey } from '../../core/crypto';
import { decodeTokenBlob, encodeTokenBlob } from '../../token-engine/token-blob';
import { sha256 } from '@noble/hashes/sha2.js';
import type { TokenBlob } from '../../token-engine/types';
import type { TxfStorageDataBase } from '../../storage';
import type { KeyValueStore } from '../../wallet-api';

let tokenCounter = 0;

export interface TestToken {
  tokenId: string;
  coinId: string;
  amount: bigint;
  blob: TokenBlob;
  /** `encodeTokenBlob(blob)` — the bytes uploaded to the blob store. */
  bytes: Uint8Array;
  /** Hex of {@link bytes} — the stored UI token's `sdkData`. */
  blobHex: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function makeTestToken(opts: { tokenId?: string; coinId?: string; amount?: bigint } = {}): TestToken {
  tokenCounter += 1;
  const tokenId =
    opts.tokenId ?? `${tokenCounter.toString(16).padStart(8, '0')}${'ab'.repeat(28)}`;
  const coinId = opts.coinId ?? 'c0'.repeat(32);
  const amount = opts.amount ?? 1000n;
  // Self-describing inner bytes (tokenId included): the wallet-api WIRE
  // carries the INNER bytes (§5.2/§8.2 — never the 39051 envelope), so the
  // fake world's raw-bytes derivations need the id in-band, like the real
  // SDK token carries its own id.
  const inner = new TextEncoder().encode(
    JSON.stringify({ tokenId, assets: [{ coinId, amount: amount.toString() }], salt: tokenCounter })
  );
  const blob: TokenBlob = { v: 1, network: 3, tokenId, token: inner };
  const bytes = encodeTokenBlob(blob);
  return { tokenId, coinId, amount, blob, bytes, blobHex: bytesToHex(bytes) };
}

/**
 * Build a whole-blob storage snapshot containing the given tokens as v2 UI
 * token records (the shape PaymentsModule persists — see
 * serialization/txf-serializer.ts).
 */
export function buildTxfData(tokens: TestToken[]): TxfStorageDataBase {
  const data: TxfStorageDataBase = {
    _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() },
  };
  for (const t of tokens) {
    data[`_${t.tokenId}`] = {
      id: `v2_${t.tokenId}`,
      coinId: t.coinId,
      symbol: 'TST',
      name: 'Test token',
      decimals: 0,
      amount: t.amount.toString(),
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: t.blobHex,
    };
  }
  return data;
}

/** In-memory KeyValueStore (the client/provider persistence seam). */
export class MemoryKeyValueStore implements KeyValueStore {
  readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/** Deterministic test identity n (secp256k1). */
export function testIdentity(n: number): { privateKey: string; chainPubkey: string } {
  const privateKey = (n + 1).toString(16).padStart(64, '0');
  return { privateKey, chainPubkey: getPublicKey(privateKey) };
}

/**
 * Fake-world delivery-key derivation — mirrors FakeTokenEngine.deliveryKeys
 * (sha256 over inner token bytes). Bind into standalone-constructed providers;
 * the REAL SDK derivation is pinned by delivery-keys.test.ts + the harness.
 */
export function fakeDeliveryKeys(blobBytes: Uint8Array): Promise<{ tokenId: string; stateHash: string }> {
  // Tolerant like the real derivation (token-engine/blob-keys.ts): envelope
  // bytes (the cross-port blob form) or raw wire bytes (§5.2/§8.2 — what the
  // wallet-api serves) derive the identical pair for the same token.
  try {
    const blob = decodeTokenBlob(blobBytes);
    const hex = Array.from(sha256(blob.token), (b) => b.toString(16).padStart(2, '0')).join('');
    return Promise.resolve({ tokenId: blob.tokenId, stateHash: hex });
  } catch {
    const parsed = JSON.parse(new TextDecoder().decode(blobBytes)) as { tokenId?: unknown };
    if (typeof parsed.tokenId !== 'string') throw new Error('fakeDeliveryKeys: bytes carry no tokenId');
    const hex = Array.from(sha256(blobBytes), (b) => b.toString(16).padStart(2, '0')).join('');
    return Promise.resolve({ tokenId: parsed.tokenId, stateHash: hex });
  }
}
