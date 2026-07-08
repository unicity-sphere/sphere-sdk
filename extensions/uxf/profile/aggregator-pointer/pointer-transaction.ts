/**
 * Pointer synthetic-transaction adapter (Wave 6-P2-16).
 *
 * The v2 state-transition SDK's aggregator API (`submitCertificationRequest` /
 * `getInclusionProof(stateId)`) is defined in terms of full transactions with
 * lockScripts, sourceStateHashes, transactionHashes, and unlockScripts.
 *
 * The pointer layer's commitment payload is a hand-built pair — one
 * signing-key-locked "state" per side, transaction hash = SHA256(ct) — that
 * has no real Token / MintTransaction / TransferTransaction backing it.
 *
 * To reach the v2 API surface we wrap the pointer's payload in a minimal
 * synthetic {@link ITransaction} implementation that answers the three
 * questions the SDK asks:
 *
 *   - `lockScript`        — the `EncodedPredicate` locking the state
 *                           (`SignaturePredicate(signingPubKey)` wrapped).
 *   - `sourceStateHash`   — the derived state hash (`stateHashDigest`).
 *   - `calculateTransactionHash()` — echoes back the transaction hash the
 *                                    pointer already computed (SHA256(ct)).
 *
 * `recipient`, `stateMask`, `data`, `calculateStateHash()`, and `toCBOR()` are
 * populated with dummy but well-typed values. They are consumed only by
 * transaction pipelines the pointer layer never invokes (mint/transfer
 * routing, canonical CBOR of the transaction body, predicate verifiers that
 * need the destination state). None of the aggregator paths the pointer
 * uses read these fields.
 *
 * Instantiate via {@link PointerTransaction.create} — it wraps the signing
 * pubkey into an `EncodedPredicate` internally so callers stay clean of the
 * v2 predicate ceremony.
 */

import {
  DataHash,
  EncodedPredicate,
  HashAlgorithm,
  ITransaction,
  SignaturePredicate,
} from '../../../../token-engine/sdk.js';

/**
 * Cached hash used as `PointerTransaction.calculateStateHash`'s return value —
 * pointer never inspects it, but the SDK type demands one.
 */
const ZERO_STATE_HASH = new DataHash(HashAlgorithm.SHA256, new Uint8Array(32));

export class PointerTransaction implements ITransaction {
  public readonly recipient: EncodedPredicate;
  public readonly stateMask: Uint8Array = new Uint8Array(0);
  public readonly data: Uint8Array | null = null;

  private constructor(
    public readonly lockScript: EncodedPredicate,
    public readonly sourceStateHash: DataHash,
    private readonly _transactionHash: DataHash,
  ) {
    // Recipient is unused by the pointer's aggregator paths; reuse lockScript
    // so any predicate-verifier registry lookups resolve without surprise.
    this.recipient = lockScript;
  }

  /**
   * Build a `PointerTransaction` from the pointer signing key, the derived
   * source state hash, and the SHA256(ct) transaction hash.
   *
   * @param signingPubKey Compressed secp256k1 pubkey (33 bytes) — the
   *   `SignaturePredicate` binding.
   * @param sourceStateHash Derived state hash (from `deriveStateHashDigest`).
   * @param transactionHash SHA256(ct) — the actual pointer commitment content.
   */
  static create(
    signingPubKey: Uint8Array,
    sourceStateHash: DataHash,
    transactionHash: DataHash,
  ): PointerTransaction {
    const predicate = SignaturePredicate.create(signingPubKey);
    const encoded = EncodedPredicate.fromPredicate(predicate);
    return new PointerTransaction(encoded, sourceStateHash, transactionHash);
  }

  /**
   * Build a `PointerTransaction` with a placeholder transaction hash. Useful
   * for the probe path where the caller only needs a valid `lockScript` +
   * `sourceStateHash` to derive the aggregator's `StateId`; the aggregator's
   * returned proof carries the actual committed transaction hash.
   */
  static createForStateId(
    signingPubKey: Uint8Array,
    sourceStateHash: DataHash,
  ): PointerTransaction {
    return PointerTransaction.create(signingPubKey, sourceStateHash, ZERO_STATE_HASH);
  }

  async calculateStateHash(): Promise<DataHash> {
    return ZERO_STATE_HASH;
  }

  async calculateTransactionHash(): Promise<DataHash> {
    return this._transactionHash;
  }

  toCBOR(): Uint8Array {
    // Pointer never serializes a PointerTransaction to the wire — the v2
    // aggregator receives a CertificationRequest (built by CertificationData
    // + StateId.fromCertificationData). Return an empty byte string so the
    // ITransaction contract is nominally satisfied.
    return new Uint8Array(0);
  }

  toString(): string {
    return 'PointerTransaction';
  }
}
