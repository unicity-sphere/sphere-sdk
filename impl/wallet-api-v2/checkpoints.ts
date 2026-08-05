// P3b: the E.4 split checkpoint store over the §16 intent-progress endpoints.
// ENCRYPT ONCE: ciphertext is persisted to ScopedKV BEFORE the first POST and
// every retry re-POSTs the byte-identical envelope (a fresh AEAD nonce would
// break the slot's content idempotency). put() resolves with the STORED
// envelope's plaintext — the slot winner's bytes (insert-once, first-write-wins).

import { SphereError } from '../../core/errors';
import { decryptFieldBytes, encryptFieldBytes } from '../../core/field-encryption';
import { progressSignMessage } from '../../core/wallet-api-protocol';
import { SplitCheckpointLostError, type SplitCheckpointStore } from '../../token-engine';
import { STORE_KEYS, type ScopedKV } from '../../modules/payments-v2/stores';
import type { WalletApiV2Client } from './client';

export type CheckpointClient = Pick<WalletApiV2Client, 'postProgress' | 'getProgress'>;

/** The signed §16 message binding a progress append to its exact envelope bytes. */
export { progressSignMessage as progressMessage } from '../../core/wallet-api-protocol';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export interface WalletApiSplitCheckpointStoreConfig {
  client: CheckpointClient;
  kv: ScopedKV;
  /** S6 self-scoped field key (`deriveFieldEncryptionKey`). */
  fieldKey: Uint8Array;
  /** Signs the wallet-api.progress.v1 message with the chain key. */
  signProgress: (message: string) => string | Promise<string>;
}

export class WalletApiSplitCheckpointStore implements SplitCheckpointStore {
  constructor(private readonly config: WalletApiSplitCheckpointStoreConfig) {}

  private cacheKey(transferId: string, opIndex: number): string {
    return `${STORE_KEYS.checkpointCache}:${transferId}:${String(opIndex)}`;
  }

  private aad(transferId: string, opIndex: number): Uint8Array {
    return utf8(`${transferId}:${String(opIndex)}`);
  }

  async put(transferId: string, opIndex: number, bytes: Uint8Array): Promise<Uint8Array> {
    const { client, kv, fieldKey, signProgress } = this.config;
    const aad = this.aad(transferId, opIndex);
    const cacheKey = this.cacheKey(transferId, opIndex);
    let envelope = await kv.get<string>(cacheKey);
    if (envelope === null) {
      envelope = encryptFieldBytes(fieldKey, bytes, aad);
      await kv.set(cacheKey, envelope);
    }
    const signature = await signProgress(progressSignMessage(transferId, opIndex, envelope));
    const record = await client.postProgress(transferId, opIndex, envelope, signature);
    return this.open(record.payload, aad);
  }

  async get(transferId: string, opIndex: number): Promise<Uint8Array | null> {
    const records = await this.config.client.getProgress(transferId);
    const record = records.find((r) => r.opIndex === opIndex);
    if (record === undefined) return null;
    return this.open(record.payload, this.aad(transferId, opIndex));
  }

  private open(envelope: string, aad: Uint8Array): Uint8Array {
    try {
      return decryptFieldBytes(this.config.fieldKey, envelope, aad);
    } catch (err) {
      if (err instanceof SphereError && err.code === 'DECRYPTION_ERROR') {
        throw new SplitCheckpointLostError(
          'split checkpoint record could not be decrypted (tampered or mis-served)',
          err
        );
      }
      throw err;
    }
  }
}
