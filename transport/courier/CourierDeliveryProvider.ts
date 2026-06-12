/**
 * CourierDeliveryProvider — the reference {@link TokenDeliveryTransport} over the
 * Token-Vault v2 courier endpoints (DESIGN §3, §6).
 *
 * It seals each transfer into a courier envelope (ECDH-derived key, AAD-bound
 * entryId) and exchanges it via deposit / receive / ack / sent. Resolution
 * (nametag→pubkey via Nostr) is a SEPARATE concern handled before delivery — the
 * courier addresses purely by `recipientChainPubkey`.
 *
 * The provider talks to the courier through an injected {@link CourierHttpClient}
 * (the swap seam): the Phase 5 tests inject the in-process fake server; Phase 8.3
 * injects a real fetch+JWT client against `vaultUrl`. The incoming path feeds the
 * EXISTING `handleV2Transfer` (verify + isOwnedBy + dedup) unchanged via an
 * injected {@link V2TransferSink}.
 */

import type { FullIdentity } from '../../types';
import type { V2TransferPayload } from '../../types/v2-transfer';
import { sealCourierEnvelope } from '../../vault-aead/courier';
import { courierEntryId } from './entryId';
import type {
  CourierHttpClient,
  DeliveryHandle,
  TokenDeliveryCapabilities,
  TokenDeliveryTransport,
  TokenEnvelope,
} from './types';

/**
 * Sink for a decoded incoming transfer — bound by PaymentsModule to its existing
 * `handleV2Transfer(payload, senderPubkey)` so the receive path is unchanged.
 */
export type V2TransferSink = (payload: V2TransferPayload, senderPubkey: string) => Promise<void>;

/** Minimal persistent KV the journal needs (matches PaymentsModule storage). */
export interface CourierJournalStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface CourierDeliveryConfig {
  /** Vault/courier base URL — `NETWORKS[network].vaultUrl`. */
  vaultUrl: string;
  /** Canonical network name (DESIGN §7.1 — `testnet2` / `mainnet`). */
  network: string;
  /** Swap seam: build a courier client scoped to the authenticated caller. */
  httpClientFactory: (ownerId: string) => CourierHttpClient;
  /** Durable journal (ACK-PENDING, read pointer, sent watermark). */
  journal: CourierJournalStore;
  /** Feeds decoded incoming transfers into the existing handleV2Transfer path. */
  onV2Transfer: V2TransferSink;
  /** Max envelope bytes the courier accepts (DESIGN §6.6 default 16 MiB). */
  maxBytes?: number;
}

export class CourierDeliveryProvider implements TokenDeliveryTransport {
  readonly id = 'courier-delivery';
  readonly name = 'Courier Delivery (Vault v2)';
  readonly type = 'network' as const;

  readonly capabilities: TokenDeliveryCapabilities;

  private readonly config: CourierDeliveryConfig;
  private identity: FullIdentity | null = null;

  constructor(config: CourierDeliveryConfig) {
    this.config = config;
    this.capabilities = {
      async: true,
      ack: true,
      addressing: 'pubkey',
      maxBytes: config.maxBytes ?? 16 * 1024 * 1024,
    };
  }

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
  }

  // ===========================================================================
  // Deposit (Task 5.1)
  // ===========================================================================

  /**
   * Seal the envelope to the recipient (ECDH key, AAD-bound entryId), pack the
   * `base64(nonce24‖ct)` ciphertext, and POST `/v1/courier/deposit`. The caller
   * (sender) is `this.identity.chainPubkey`; the server keys dedup on
   * `(recipientPubkey, entryId)`.
   */
  async deposit(envelope: TokenEnvelope): Promise<DeliveryHandle> {
    const me = this.requireIdentity();
    const entryId = courierEntryId(me.privateKey, envelope.recipientChainPubkey, envelope.tokenBlobHex);
    const ciphertext = this.sealEnvelope(me, envelope, entryId);
    const client = this.config.httpClientFactory(me.chainPubkey);
    const res = await client.deposit({
      recipientPubkey: envelope.recipientChainPubkey,
      entryId,
      transferId: envelope.transferId,
      ciphertext,
      // hint stays undefined here — a single base64 SCALAR when present (never an object).
    });
    return {
      entryId: res.entryId,
      transferId: envelope.transferId,
      recipientChainPubkey: envelope.recipientChainPubkey,
      sentSeq: res.sentSeq,
    };
  }

  /**
   * Seal the V2_TRANSFER payload as a courier envelope; returns the packed
   * `base64(nonce24‖ct)` on-wire `ciphertext`.
   */
  private sealEnvelope(me: FullIdentity, envelope: TokenEnvelope, entryId: string): string {
    const payload: V2TransferPayload = {
      type: 'V2_TRANSFER',
      version: '2.0',
      tokenBlob: envelope.tokenBlobHex,
      memo: envelope.memo,
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    return sealCourierEnvelope({
      network: this.config.network,
      senderPriv: me.privateKey,
      senderPubkey: me.chainPubkey,
      recipientPubkey: envelope.recipientChainPubkey,
      entryId,
      plaintext,
    });
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private requireIdentity(): FullIdentity {
    if (!this.identity) {
      throw new Error('CourierDeliveryProvider: setIdentity() must be called before use');
    }
    return this.identity;
  }
}
