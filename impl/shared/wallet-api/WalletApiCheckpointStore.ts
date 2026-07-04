/**
 * impl/shared/wallet-api/WalletApiCheckpointStore.ts — the E.4 split burn checkpoint store
 * (sphere-sdk#501 option b) over the wallet-api §16 intent-progress endpoints.
 *
 * The engine's SplitCheckpointStore port deals in opaque PLAINTEXT bytes (the checkpoint CBOR).
 * This adapter is the transport + crypto boundary: it AAD-encrypts the plaintext into the S6
 * `enc1.` envelope (AAD = `transferId:opIndex`, binding a record to its slot so a mis-served /
 * cross-intent record fails the poly1305 tag at decrypt), POSTs it via the client (signed,
 * locally backed up, content-idempotent), and decrypts the AUTHORITATIVE stored envelope back to
 * plaintext on get/put — so the engine mints from the winner's proof on a put race.
 */

import { decryptFieldBytes, encryptFieldBytes } from '../../../core/field-encryption';
import { SphereError } from '../../../core/errors';
import { SplitCheckpointLostError, type SplitCheckpointStore } from '../../../token-engine';

/** The wallet-api §16 intent-progress surface this store needs (satisfied by WalletApiClient). */
export interface CheckpointProgressPort {
  /** Append the checkpoint envelope; returns the AUTHORITATIVE stored envelope (insert-once). */
  postIntentProgress(transferId: string, opIndex: number, payloadEnvelope: string): Promise<string>;
  /** The stored checkpoint records for the intent (ascending opIndex). */
  getIntentProgress(transferId: string): Promise<readonly { opIndex: number; payload: string }[]>;
}

export class WalletApiCheckpointStore implements SplitCheckpointStore {
  public constructor(
    private readonly port: CheckpointProgressPort,
    private readonly fieldKey: Uint8Array,
  ) {}

  /** Per-slot associated data — authenticated, never stored; both sides re-derive it from context. */
  private aad(transferId: string, opIndex: number): Uint8Array {
    return new TextEncoder().encode(`${transferId}:${String(opIndex)}`);
  }

  public async put(transferId: string, opIndex: number, bytes: Uint8Array): Promise<Uint8Array> {
    const aad = this.aad(transferId, opIndex);
    const envelope = encryptFieldBytes(this.fieldKey, bytes, aad);
    const stored = await this.port.postIntentProgress(transferId, opIndex, envelope);
    return this.open(stored, aad); // decode the winner's bytes (ours or a racing resumer's)
  }

  public async get(transferId: string, opIndex: number): Promise<Uint8Array | null> {
    const record = (await this.port.getIntentProgress(transferId)).find((r) => r.opIndex === opIndex);
    if (record === undefined) return null;
    return this.open(record.payload, this.aad(transferId, opIndex));
  }

  /**
   * Decrypt a stored envelope under the slot AAD. A decrypt failure means the record was tampered,
   * mis-served for another slot, or otherwise unreadable — the checkpoint is effectively lost:
   * surface the keep-open SplitCheckpointLostError (never a raw error the caller cannot dispose).
   */
  private open(envelope: string, aad: Uint8Array): Uint8Array {
    try {
      return decryptFieldBytes(this.fieldKey, envelope, aad);
    } catch (err) {
      if (err instanceof SphereError && err.code === 'DECRYPTION_ERROR') {
        throw new SplitCheckpointLostError('split checkpoint record could not be decrypted (tampered or mis-served)', err);
      }
      throw err;
    }
  }
}
