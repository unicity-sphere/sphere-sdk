/**
 * transport/delivery-provider.ts — the `DeliveryProvider` port (sdk-changes S7,
 * covenant §3.1-6).
 *
 * The seam that keeps the delivery rail swappable. In Unicity, a transfer —
 * after certification — is just a file handoff, so the port is deliberately
 * tiny: hand a finished token blob to a recipient, pull incoming deliveries,
 * acknowledge them. `WalletApiMailboxProvider`
 * (impl/shared/wallet-api/WalletApiMailboxProvider.ts) is the reference
 * implementation; anything that can move a file can implement it (the port
 * shape must not preclude the old Nostr transport or a future federated
 * transport — neither is a deliverable here).
 *
 * Normative shapes (sdk-changes S7):
 * - `DeliveryReceipt = { deliveryId }`
 * - `IncomingDelivery = { deliveryId, transferId?, senderPubkey?, memo?,
 *   fetchBlob(), cursor }`
 * - `deliveryId` is the **content-derived** entry id —
 *   `hex(SHA-256(tokenId bytes ‖ stateHash bytes))` — NEVER a server-assigned
 *   row id or seq (covenant §3.1-4; the contract suite asserts it). It is
 *   computed client-side ({@link computeDeliveryId}) and must equal the
 *   backend's `entry_id` (ARCHITECTURE §6).
 * - **Custody is a composition-time property, not a per-call flag**:
 *   implementations take `custody: 'inventory' | 'external'` at construction
 *   and every ack sends the corresponding `intoInventory` — delivery-only
 *   safety must never depend on remembering an option at a call site.
 * - Implementations MUST keep a **persistent `(tokenId, stateHash)` seen-set**
 *   for incoming deliveries: the recipient-side replay guard is part of the
 *   port contract, not a server promise (the recipient never trusts the
 *   backend — ARCHITECTURE §8.2). `deliveryId` is the canonical hash encoding
 *   of exactly that pair, so a persistent deliveryId set satisfies this.
 */

import { sha256 } from '@noble/hashes/sha2.js';


// =============================================================================
// Normative shapes (sdk-changes S7)
// =============================================================================

/** Receipt for a delivered blob. `deliveryId` is content-derived — see module doc. */
export interface DeliveryReceipt {
  deliveryId: string;
}

/** Options for {@link DeliveryProvider.deliver}. */
export interface DeliverOptions {
  /**
   * The send's transferId (the E.3 intent id / realization seed). Recorded
   * with the delivery so the recipient can group multi-token payments and the
   * backend can evidence-check the sender's removals (ARCHITECTURE §5.3/§6).
   */
  transferId: string;
  /** Optional human memo. Implementations encrypt it client-side (S6). */
  memo?: string;
  /**
   * The SENDER's own nametag (without a leading `@`), so the recipient can
   * render the human identity instead of a raw pubkey ("Someone"). Bundled
   * with the memo into ONE recipient-addressed (ECDH) `enc1.` envelope (S6) —
   * the operator never sees it. Attached whenever the sender has a nametag OR
   * a memo (so the nametag travels even on a memo-less transfer).
   */
  senderNametag?: string;
}

/** One incoming delivery pulled from the feed. */
export interface IncomingDelivery {
  /** Content-derived id — `hex(SHA-256(tokenId bytes ‖ stateHash bytes))`. */
  deliveryId: string;
  /** The sender's transferId, when the transport carries it. */
  transferId?: string;
  /** The sender's pubkey, when the transport carries it. */
  senderPubkey?: string;
  /** Decrypted memo (S6), when present and decryptable. */
  memo?: string;
  /**
   * The sender's nametag (without a leading `@`), decrypted from the same
   * recipient-addressed delivery envelope as {@link memo} (S6). Lets the
   * receiver render the human identity instead of a raw pubkey, with no
   * Nostr/transport lookup. Absent when the envelope carried none or could
   * not be decrypted.
   */
  senderNametag?: string;
  /** Fetch the finished token blob bytes (the encoded TokenBlob). */
  fetchBlob(): Promise<Uint8Array>;
  /** Transport-local resume cursor (opaque to callers). */
  cursor: string;
}

export type DeliveryDisposition = 'claimed' | 'rejected';

/**
 * The §9 wake streams a backend may nudge: `mailbox` (incoming deliveries),
 * `inventory` (owned-token set changed — e.g. a top-up or a claim on another
 * device), and `payment_requests` (a request created/answered). A wake on any
 * of these is a NUDGE — the consumer pulls that stream's cursor; correctness
 * never depends on the wake arriving (the poll backstop is the source of
 * truth).
 */
export type WakeStream = 'inventory' | 'mailbox' | 'payment_requests';

/**
 * True liveness of the realtime wake channel (§9), decoupled from sign-in
 * session state: `connecting`/`connected` — a socket is (being) established;
 * `reconnecting` — it dropped and is backing off to re-establish (the poll
 * backstop carries correctness meanwhile); `closed` — torn down intentionally.
 * The wake is a nudge, so this is informational for the frontend (a "live"
 * indicator) — never a correctness gate.
 */
export type WakeChannelStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * Custody mode (composition-time): `'inventory'` — acknowledged deliveries
 * enter the wallet-api inventory (the full wallet-api preset); `'external'` —
 * the app's own storage keeps custody and acks perform ZERO inventory writes
 * (the delivery-only preset, ARCHITECTURE §6 "delivery-only claim").
 */
export type DeliveryCustody = 'inventory' | 'external';

// =============================================================================
// The port
// =============================================================================

export interface DeliveryProvider {
  /** Composition-time custody property — never a per-call flag (S7). */
  readonly custody: DeliveryCustody;

  /**
   * Bind the wallet identity (optional — implementations that authenticate or
   * encrypt per-wallet need it; mirrors `TokenStorageProvider.setIdentity`).
   */
  setIdentity?(identity: { privateKey: string; chainPubkey: string }): void;

  /**
   * Hand a finished token blob to a recipient. `recipientPubkey` is the
   * recipient's CHAIN pubkey (33-byte compressed secp256k1, hex) — the
   * canonical Unicity identity (ARCHITECTURE §4); transports that address
   * recipients differently resolve it themselves.
   *
   * MUST be idempotent per (token, state): re-delivering the same finished
   * blob — including after the recipient claimed — succeeds and returns the
   * same content-derived `deliveryId` (ARCHITECTURE §6 deposit idempotency).
   */
  deliver(recipientPubkey: string, blob: Uint8Array, options: DeliverOptions): Promise<DeliveryReceipt>;

  /**
   * Pull-based feed of incoming deliveries since the given transport-local
   * cursor (or the provider's persisted cursor when omitted). Yields only
   * deliveries not yet in the persistent seen-set; completes when the feed is
   * drained — callers re-invoke on poll/wake. Feeds the existing
   * transport-agnostic `handleV2Transfer` (sdk-changes S3).
   */
  incoming(sinceCursor?: string): AsyncIterable<IncomingDelivery>;

  /**
   * Acknowledge a delivery: `'claimed'` accepts it (with the provider's
   * composition-time custody), `'rejected'` marks it locally-unverifiable —
   * terminal for discovery only (the entry stays claimable server-side and
   * its blob is retained — ARCHITECTURE §6). Both record the delivery in the
   * persistent seen-set.
   */
  ack(deliveryId: string, disposition: DeliveryDisposition): Promise<void>;

  /**
   * Optional wake hook: `callback` fires with the {@link WakeStream} that was
   * nudged when new data may be available on it (e.g. a WS nudge — never a
   * correctness dependency, ARCHITECTURE §9). The wallet-api wake socket
   * multiplexes all three owner streams (`mailbox` | `inventory` |
   * `payment_requests`); the consumer routes each to that stream's pull.
   *
   * The underlying socket SELF-HEALS (§9): it reconnects with backoff on any
   * drop and a liveness watchdog force-reconnects a half-open socket. On every
   * (re)connect the consumer MUST run a full catch-up pull of every stream —
   * wakes missed while the socket was dead are not replayed — so `callback`
   * fires once for EACH stream on (re)connect (a synthetic catch-up nudge).
   * `onStatus` (optional) surfaces true socket liveness for the frontend,
   * decoupled from sign-in state. Returns an unsubscribe function.
   */
  onWake?(
    callback: (stream: WakeStream) => void,
    onStatus?: (status: WakeChannelStatus) => void
  ): () => void;

  /**
   * Late-bind the backend-true (tokenId, stateHash) derivation —
   * `ITokenEngine.deliveryKeys`. Compositions are engine-less (the engine is
   * built later); the module that owns both (PaymentsModule) binds this at
   * init. Implementations that derive ids (S7) MUST use it and fail loudly if
   * unbound; transports that don't derive may omit the method.
   */
  bindDeliveryKeys?(derive: (blobBytes: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>): void;
}

// =============================================================================
// deliveryId derivation (the backend's entry_id formula — ARCHITECTURE §6)
// =============================================================================

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The content-derived delivery id:
 * `hex(SHA-256(tokenId bytes ‖ stateHash bytes))` — identical to the
 * backend's `entry_id` (ARCHITECTURE §6), computed client-side so no
 * implementation can substitute a server row id (covenant §3.1-4).
 *
 * @param tokenIdHex - genesis-stable 64-hex token id
 * @param stateHashHex - the SDK's per-state hash (DataHash imprint, hex) — the
 *   backend's `state_hash` (wallet-api validation/chain.ts); NEVER a plain
 *   sha256 over the token bytes (that variant 422s on deposit).
 */
export function computeDeliveryId(tokenIdHex: string, stateHashHex: string): string {
  const tokenId = hexToBytes(tokenIdHex);
  const stateHash = hexToBytes(stateHashHex);
  const joined = new Uint8Array(tokenId.length + stateHash.length);
  joined.set(tokenId, 0);
  joined.set(stateHash, tokenId.length);
  return bytesToHex(sha256(joined));
}

/** Full delivery keys: the engine-derived pair + the composed deliveryId. */
export interface DeliveryBlobKeys {
  /** Genesis-stable 64-hex token id (from the TokenBlob envelope). */
  tokenId: string;
  /** Per-state hash: `hex(SHA-256(inner token bytes))` — changes every transfer. */
  stateHash: string;
  /** {@link computeDeliveryId} of the two above. */
  deliveryId: string;
}

/**
 * Derive (tokenId, stateHash, deliveryId) from encoded TokenBlob bytes.
 * Throws when the bytes are not a decodable TokenBlob.
 */
/**
 * Compose full delivery keys from an engine-derived (tokenId, stateHash) pair.
 * The pair MUST come from `ITokenEngine.deliveryKeys` (the backend-true SDK
 * derivation) — the port module deliberately cannot decode tokens itself.
 */
export function composeDeliveryKeys(keys: { tokenId: string; stateHash: string }): DeliveryBlobKeys {
  return { ...keys, deliveryId: computeDeliveryId(keys.tokenId, keys.stateHash) };
}
