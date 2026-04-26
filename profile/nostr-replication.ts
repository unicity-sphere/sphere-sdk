/**
 * Nostr-OrbitDB Replication Bridge
 *
 * Bridges OrbitDB OpLog entries to the existing Nostr relay infrastructure
 * for offline sync. When OrbitDB produces new local entries, the bridge
 * encrypts and publishes them as Nostr events (kind 30078). On startup,
 * it fetches missed entries from the relay and returns them for ingestion.
 *
 * This is a one-way persistence bridge -- NOT a full OrbitDB replication
 * protocol. It serializes raw encrypted blobs to/from Nostr events without
 * understanding OrbitDB internals.
 *
 * Nostr event format:
 *   kind: 29000 (custom — non-replaceable, all entries preserved)
 *   tags: [["d", dbAddress], ["t", "orbitdb-oplog"], ["seq", sequenceNumber]]
 *   content: hex(encrypt(serialized_entry))
 *
 * @see PROFILE-ARCHITECTURE.md Section 4.4
 * @module profile/nostr-replication
 */

import { encryptProfileValue, decryptProfileValue } from './encryption.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * Nostr event kind for OrbitDB OpLog entries.
 * Uses kind 29000 (ephemeral-ish custom range) — NOT a replaceable kind.
 * Kind 30078 was wrong: NIP-33 parameterized replaceable events retain only
 * the latest event per (pubkey, kind, d-tag) triple, which would silently
 * overwrite all previous OpLog entries. We need ALL entries preserved.
 */
const NOSTR_KIND_ORBITDB_OPLOG = 29000;

/** Tag value used to filter OrbitDB OpLog events on the relay. */
const OPLOG_TAG = 'orbitdb-oplog';

/** Connection timeout in milliseconds. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Maximum time to wait for EOSE (end of stored events) in milliseconds. */
const EOSE_TIMEOUT_MS = 15_000;

/**
 * Hard cap on events collected in a single fetchMissedEntries call.
 * Steelman: a malicious relay could emit millions of valid-looking
 * EVENT frames before EOSE, allocating memory per push until OOM.
 */
const MAX_EVENTS_PER_FETCH = 10_000;

/**
 * Hard cap on each raw message LENGTH (approximates Nostr relay
 * convention of 256K bytes). For string-type WebSocket frames, this
 * is UTF-16 code-unit count (NOT bytes — CJK input is ~3× larger
 * in actual UTF-8 bytes). Renamed from MAX_MESSAGE_BYTES to clarify
 * the unit. The cap is applied per-message at the parse boundary.
 */
const MAX_MESSAGE_LEN = 256 * 1024;

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the Nostr-OrbitDB replication bridge.
 */
export interface NostrReplicationConfig {
  /** Nostr relay WebSocket URL (e.g., `wss://relay.unicity.network`). */
  readonly relayUrl: string;

  /**
   * Wallet's transport private key (hex, 32 bytes) for signing Nostr events.
   * Must be a valid secp256k1 private key.
   */
  readonly transportPrivateKey: string;

  /**
   * Profile encryption key (32 bytes) for AES-256-GCM encryption of
   * OpLog entries before publishing to the relay.
   */
  readonly encryptionKey: Uint8Array;

  /**
   * OrbitDB database address. Used as the Nostr event `d` tag to scope
   * events to a specific database on the relay.
   */
  readonly dbAddress: string;

  /**
   * Optional WebSocket constructor for Node.js compatibility.
   * In browsers, the global `WebSocket` is used.
   */
  readonly createWebSocket?: (url: string) => WebSocket;
}

/**
 * A single Nostr event as received from the relay.
 * Only the fields relevant to this bridge are included.
 */
interface NostrEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

/**
 * Unsigned event template used to construct a publishable Nostr event.
 */
interface UnsignedEvent {
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
}

// =============================================================================
// NostrReplicationBridge
// =============================================================================

/**
 * Bridges OrbitDB OpLog entries to/from a Nostr relay for offline persistence.
 *
 * Usage:
 * ```typescript
 * const bridge = new NostrReplicationBridge(config);
 * await bridge.start();
 *
 * // Publish a new OpLog entry when OrbitDB emits one
 * db.onReplication(() => bridge.publishEntry(entryBytes));
 *
 * // On startup, fetch entries missed while offline
 * const missed = await bridge.fetchMissedEntries(lastSyncTimestamp);
 *
 * await bridge.stop();
 * ```
 */
export class NostrReplicationBridge {
  // Steelman²⁸: replay-protection cache. Bounded LRU-ish set of event
  // ids we have already accepted in this session.
  static readonly SEEN_EVENT_CACHE_MAX = 10_000;
  readonly #seenEventIds = new Set<string>();

  private ws: WebSocket | null = null;
  private pubkey: string | null = null;
  private running = false;
  private subscriptionId: string | null = null;
  private sequence = 0;

  constructor(private readonly config: NostrReplicationConfig) {}

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start the bridge by connecting to the Nostr relay WebSocket.
   * The connection is kept alive for publishing events.
   *
   * @throws Error if the connection times out or fails.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.pubkey = await derivePublicKeyHex(this.config.transportPrivateKey);
    this.ws = await this.connectWebSocket();
    this.running = true;
  }

  /**
   * Stop the bridge. Unsubscribes from the relay and closes the WebSocket.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.ws && this.subscriptionId) {
      try {
        this.sendJson(['CLOSE', this.subscriptionId]);
      } catch {
        // best-effort
      }
      this.subscriptionId = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // best-effort
      }
      this.ws = null;
    }
  }

  // --------------------------------------------------------------------------
  // Publish
  // --------------------------------------------------------------------------

  /**
   * Publish an OrbitDB OpLog entry to the Nostr relay.
   *
   * The entry data is encrypted with the profile encryption key (AES-256-GCM),
   * hex-encoded, and published as the content of a kind-29000 Nostr event.
   *
   * @param entryData - Raw serialized OpLog entry bytes.
   * @throws Error if the bridge is not started or publishing fails.
   */
  async publishEntry(entryData: Uint8Array): Promise<void> {
    this.ensureRunning();

    const encrypted = await encryptProfileValue(
      this.config.encryptionKey,
      entryData,
    );
    const contentHex = bytesToHex(encrypted);

    const seq = String(this.sequence++);
    const event = await this.buildSignedEvent({
      pubkey: this.pubkey!,
      created_at: Math.floor(Date.now() / 1000),
      kind: NOSTR_KIND_ORBITDB_OPLOG,
      tags: [
        ['d', this.config.dbAddress],
        ['t', OPLOG_TAG],
        ['seq', seq],
      ],
      content: contentHex,
    });

    await this.sendAndWaitForOk(event);
  }

  // --------------------------------------------------------------------------
  // Fetch
  // --------------------------------------------------------------------------

  /**
   * Fetch all missed OpLog entries from the relay since a given timestamp.
   *
   * Sends a REQ with a filter matching the bridge's `d` tag and `since`
   * timestamp, collects events until EOSE, then decrypts and returns the
   * entry data in chronological order.
   *
   * @param since - Unix timestamp (seconds). Events created after this
   *   time are returned.
   * @returns Array of decrypted OpLog entry payloads, ordered by `created_at`.
   */
  async fetchMissedEntries(since: number): Promise<Uint8Array[]> {
    this.ensureRunning();

    const subId = randomSubscriptionId();
    const filter = {
      kinds: [NOSTR_KIND_ORBITDB_OPLOG],
      '#d': [this.config.dbAddress],
      '#t': [OPLOG_TAG],
      authors: [this.pubkey!],
      since,
    };

    return new Promise<Uint8Array[]>((resolve, reject) => {
      const events: NostrEvent[] = [];
      // Steelman⁴ remediation: count ALL parsed EVENT frames (not just
      // matching ones). Previous version's `events.length` cap only
      // counted pubkey/kind-matching events — a relay flooding with
      // EVENT frames whose pubkey/kind didn't match our filter would
      // never increment events.length, so the cap never engaged. The
      // attacker still drove full JSON.parse + filter dispatch CPU per
      // frame. Bound dispatch by ALL parsed events with a separate
      // counter, capped at MAX_EVENTS_PER_FETCH * 2 to allow some
      // legitimate filter slop.
      const TOTAL_EVENT_DISPATCH_CAP = MAX_EVENTS_PER_FETCH * 2;
      let totalParsedEvents = 0;
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('Timed out waiting for EOSE from relay'));
        }
      }, EOSE_TIMEOUT_MS);

      const onMessage = (msg: MessageEvent) => {
        if (settled) return;

        // Steelman² remediation: cap BEFORE coercion to string. The
        // previous String(msg.data) eagerly allocated a string copy
        // of the entire payload (UTF-8 decoding for Buffer/ArrayBuffer)
        // BEFORE the size cap fired — a 10MB binary frame already
        // allocated 10MB of string by the time we checked.
        const data = msg.data;
        if (typeof data === 'string') {
          if (data.length > MAX_MESSAGE_LEN) return;
        } else if (data instanceof ArrayBuffer) {
          if (data.byteLength > MAX_MESSAGE_LEN) return;
        } else if (typeof Buffer !== 'undefined' && data instanceof Buffer) {
          if (data.length > MAX_MESSAGE_LEN) return;
        }
        const raw = typeof data === 'string' ? data : String(data);
        if (raw.length > MAX_MESSAGE_LEN) return;

        let parsed: unknown[];
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }

        if (!Array.isArray(parsed)) return;

        if (parsed[0] === 'EVENT' && parsed[1] === subId) {
          // Steelman⁴ remediation: count EVERY parsed EVENT frame for our
          // subId (regardless of pubkey/kind match) so a flood of filter-
          // failing events can't drive arbitrary CPU dispatch. Bound
          // total dispatch at TOTAL_EVENT_DISPATCH_CAP.
          totalParsedEvents += 1;
          if (totalParsedEvents >= TOTAL_EVENT_DISPATCH_CAP) {
            settled = true;
            clearTimeout(timeout);
            cleanup();
            // Steelman⁵ remediation: rename `authenticCount` →
            // `collectedCount` on cap paths. At cap-engage time `events`
            // is the PRE-VERIFY array (verifyAndDecrypt was intentionally
            // skipped to avoid the verify cost on a hostile flood).
            // Telemetry consumers must distinguish "collected, not yet
            // schnorr-verified" from H.3's post-verify `authenticCount`.
            const truncErr: Error & {
              droppedCount?: number;
              collectedCount?: number;
              reason?: string;
            } = new Error(
              `Nostr fetchMissedEntries dispatch cap exceeded ` +
                `(${TOTAL_EVENT_DISPATCH_CAP} EVENT frames parsed). ` +
                `Subscription closed. Caller MUST NOT advance \`since\` — ` +
                `re-fetch missed window from a different relay.`,
            );
            truncErr.reason = 'dispatch_cap';
            truncErr.droppedCount = -1; // unknown — relay was still streaming
            truncErr.collectedCount = events.length;
            reject(truncErr);
            return;
          }
          if (!parsed[2]) return;
          const evt = parsed[2] as NostrEvent;
          // Verify event is from our wallet (relay filter is advisory — verify locally)
          if (evt.pubkey !== this.pubkey) return;
          if (evt.kind !== NOSTR_KIND_ORBITDB_OPLOG) return;
          // Steelman remediation: enforce NIP-01 id+sig check before accept.
          // A malicious relay can deliver forged EVENT frames for our
          // known pubkey; without verification we waste decrypt work
          // (memory DoS) and would accept replayed past events with
          // their genuine signatures intact. Cap also protects against
          // relay flooding 10k events between REQ and EOSE.
          if (events.length >= MAX_EVENTS_PER_FETCH) {
            // Steelman⁴ remediation: SYMMETRIC truncation handling with
            // verifyAndDecrypt's budget-exhaust path. Previous version
            // silently called verifyAndDecrypt(events).then(resolve,...)
            // — a caller advancing \`since = max(events.created_at)\`
            // would lose events 10001+ permanently. Now throws a
            // labeled error mirroring H.3, instructing the caller NOT
            // to advance \`since\`.
            settled = true;
            clearTimeout(timeout);
            cleanup();
            // Steelman⁵: collectedCount (pre-verify), not authenticCount.
            const truncErr: Error & {
              droppedCount?: number;
              collectedCount?: number;
              reason?: string;
            } = new Error(
              `Nostr fetchMissedEntries cap reached ` +
                `(${MAX_EVENTS_PER_FETCH} matching events). ` +
                `Subscription closed. Caller MUST NOT advance \`since\` — ` +
                `re-fetch missed window with a tighter time slice.`,
            );
            truncErr.reason = 'event_cap';
            truncErr.droppedCount = -1; // unknown — relay was still streaming
            truncErr.collectedCount = events.length;
            reject(truncErr);
            return;
          }
          events.push(evt);
        } else if (parsed[0] === 'EOSE' && parsed[1] === subId) {
          settled = true;
          clearTimeout(timeout);
          cleanup();
          // Verify all collected events before decrypting. Events that
          // fail id or signature verification are dropped with a
          // counter increment for operator telemetry.
          this.verifyAndDecrypt(events).then(resolve, reject);
        } else if (parsed[0] === 'NOTICE') {
          // Relay notices are informational -- do not reject
        }
      };

      const cleanup = () => {
        this.ws?.removeEventListener('message', onMessage);
        try {
          this.sendJson(['CLOSE', subId]);
        } catch {
          // best-effort
        }
      };

      this.ws!.addEventListener('message', onMessage);
      this.sendJson(['REQ', subId, filter]);
    });
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private ensureRunning(): void {
    if (!this.running || !this.ws) {
      throw new Error(
        'NostrReplicationBridge is not running. Call start() first.',
      );
    }
  }

  /**
   * Connect to the relay WebSocket and wait for the connection to open.
   */
  private connectWebSocket(): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      // Steelman²⁸ note: enforce wss:// unless SPHERE_ALLOW_INSECURE_RELAY=1.
      // Plaintext ws:// exposes the encrypted-blob signature flow to MITM
      // event injection (signatures still verify, but throughput-shaping
      // attacks become feasible). Operators in lab setups can opt in via
      // env var.
      const url = this.config.relayUrl;
      if (
        !url.toLowerCase().startsWith('wss://') &&
        process.env.SPHERE_ALLOW_INSECURE_RELAY !== '1'
      ) {
        reject(new Error(
          `Nostr relay URL must use wss:// (got "${url}"). Set ` +
            `SPHERE_ALLOW_INSECURE_RELAY=1 to allow plaintext ws://.`,
        ));
        return;
      }
      const factory = this.config.createWebSocket ?? ((url: string) => new WebSocket(url));
      const ws = factory(this.config.relayUrl);

      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`WebSocket connection to ${this.config.relayUrl} timed out`));
      }, CONNECT_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve(ws);
      });

      ws.addEventListener('error', (ev) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket connection failed: ${String(ev)}`));
      });
    });
  }

  /**
   * Send a JSON message over the WebSocket.
   */
  private sendJson(data: unknown): void {
    this.ws!.send(JSON.stringify(data));
  }

  /**
   * Publish an event and wait for the relay OK response.
   */
  private sendAndWaitForOk(event: NostrEvent): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.ws?.removeEventListener('message', onMessage);
          // Steelman remediation: previously this resolve()'d on timeout,
          // claiming success the relay never confirmed. A malicious relay
          // that accepts the EVENT frame but never replies would cause
          // the caller to treat the OpLog entry as durable — a silent
          // data-loss vector. Reject explicitly so the caller can retry
          // or escalate. Note: sending side cannot know if the event
          // was actually accepted without an OK; we choose fail-closed.
          reject(new Error('Relay did not acknowledge EVENT within 5000ms (no OK or error received)'));
        }
      }, 5_000);

      const onMessage = (msg: MessageEvent) => {
        if (settled) return;
        // Steelman² remediation: same size cap as fetchMissedEntries.
        // A malicious relay could spam multi-MB OK frames while we
        // wait for the genuine OK; without the cap this OOMs the
        // wallet. Reject oversized frames at parse time.
        const data = msg.data;
        if (typeof data === 'string') {
          if (data.length > MAX_MESSAGE_LEN) return;
        } else if (data instanceof ArrayBuffer) {
          if (data.byteLength > MAX_MESSAGE_LEN) return;
        } else if (typeof Buffer !== 'undefined' && data instanceof Buffer) {
          if (data.length > MAX_MESSAGE_LEN) return;
        }
        const raw = typeof data === 'string' ? data : String(data);
        if (raw.length > MAX_MESSAGE_LEN) return;
        let parsed: unknown[];
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        if (!Array.isArray(parsed)) return;
        if (parsed[0] === 'OK' && parsed[1] === event.id) {
          settled = true;
          clearTimeout(timeout);
          this.ws?.removeEventListener('message', onMessage);
          if (parsed[2] === true) {
            resolve();
          } else {
            reject(new Error(`Relay rejected event: ${String(parsed[3] ?? 'unknown reason')}`));
          }
        }
      };

      this.ws!.addEventListener('message', onMessage);
      this.sendJson(['EVENT', event]);
    });
  }

  /**
   * Steelman remediation: verify events (NIP-01 id + schnorr sig) BEFORE
   * decrypting. Events failing verification are dropped silently.
   *
   * Steelman² remediation: verify in chunked batches (size=64) with a
   * 5s wall-clock budget and event-loop yield between batches. Sequential
   * await over up to 10k events at ~1-2ms each pegged the main thread
   * for 10-20 seconds against a malicious relay — UI freeze.
   *
   * Steelman³ remediation: budget exhaustion is no longer silent. Throws
   * a labeled Error so the caller (and any caller that persists a
   * `since` timestamp) sees the truncation rather than treating an
   * incomplete event set as authoritative — which would silently lose
   * OpLog entries from sibling HD-synced devices on persistent caller-
   * advanced `since`. The thrown error includes the dropped count and
   * authentic count for telemetry.
   */
  private async verifyAndDecrypt(events: NostrEvent[]): Promise<Uint8Array[]> {
    const VERIFY_BATCH_SIZE = 64;
    const VERIFY_TOTAL_BUDGET_MS = 5_000;
    const startedAt = Date.now();
    const authentic: NostrEvent[] = [];
    let droppedCount = 0;
    for (let i = 0; i < events.length; i += VERIFY_BATCH_SIZE) {
      if (Date.now() - startedAt > VERIFY_TOTAL_BUDGET_MS) {
        droppedCount = events.length - i;
        break;
      }
      const batch = events.slice(i, i + VERIFY_BATCH_SIZE);
      const verdicts = await Promise.all(batch.map((evt) => this.verifyEventAuthentic(evt)));
      for (let j = 0; j < batch.length; j++) {
        if (verdicts[j]) authentic.push(batch[j]);
      }
      // Yield to the event loop between batches so UI tasks aren't starved.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (droppedCount > 0) {
      const err: Error & { droppedCount?: number; authenticCount?: number } = new Error(
        `Nostr verifyAndDecrypt budget exhausted (${VERIFY_TOTAL_BUDGET_MS}ms): ` +
          `dropped ${droppedCount} events; verified ${authentic.length}. ` +
          `Caller MUST NOT advance \`since\` — re-fetch missed window.`,
      );
      err.droppedCount = droppedCount;
      err.authenticCount = authentic.length;
      throw err;
    }
    // Steelman²⁸ warning: in-process replay-protection cache. Reject any
    // event whose id we have already accepted in this session. Without
    // this, a relay that records and replays our own past EVENT frames
    // can re-merge OpLog entries (delete-then-recreate sequences could
    // resurrect deleted state). The cache is bounded — when full, the
    // oldest half is evicted (LRU-ish) so memory is bounded under high
    // event volume.
    const replayFiltered: NostrEvent[] = [];
    for (const evt of authentic) {
      if (this.#seenEventIds.has(evt.id)) continue;
      this.#seenEventIds.add(evt.id);
      replayFiltered.push(evt);
    }
    if (this.#seenEventIds.size > NostrReplicationBridge.SEEN_EVENT_CACHE_MAX) {
      // Evict oldest half — JS Set preserves insertion order.
      const ids = [...this.#seenEventIds];
      this.#seenEventIds.clear();
      for (const id of ids.slice(ids.length / 2)) this.#seenEventIds.add(id);
    }
    return this.decryptEvents(replayFiltered);
  }

  /**
   * Decrypt a batch of Nostr events, returning the decrypted entry data
   * sorted by `created_at` ascending.
   */
  private async decryptEvents(events: NostrEvent[]): Promise<Uint8Array[]> {
    // Sort chronologically
    const sorted = [...events].sort((a, b) => a.created_at - b.created_at);

    const results: Uint8Array[] = [];
    for (const event of sorted) {
      try {
        const encrypted = hexToBytes(event.content);
        const decrypted = await decryptProfileValue(
          this.config.encryptionKey,
          encrypted,
        );
        results.push(decrypted);
      } catch {
        // Skip events that cannot be decrypted (wrong key, corrupted, etc.)
      }
    }
    return results;
  }

  /**
   * Build a signed Nostr event from an unsigned template.
   *
   * Uses the schnorr signature scheme (secp256k1) as required by NIP-01.
   * Dynamically imports `@noble/curves/secp256k1` which is a mandatory
   * sphere-sdk dependency.
   */
  private async buildSignedEvent(unsigned: UnsignedEvent): Promise<NostrEvent> {
    const serialized = JSON.stringify([
      0,
      unsigned.pubkey,
      unsigned.created_at,
      unsigned.kind,
      unsigned.tags,
      unsigned.content,
    ]);

    const { sha256 } = await import('@noble/hashes/sha2.js');
    const hash = sha256(new TextEncoder().encode(serialized));
    const id = bytesToHex(hash);

    // Steelman⁴ remediation: convert hex → bytes for schnorr.sign too.
    // Steelman²⁸ warning: WIPE the per-call privKeyBytes immediately
    // after schnorr.sign returns. Without the wipe, every publishEntry
    // leaves a 32-byte heap-resident copy of the transport key alive
    // until GC; high-frequency wallets accumulate many short-lived
    // copies. The wipe doesn't help the underlying hex-string lifetime
    // (the config slot is still alive), but it narrows the window for
    // each derived bytes copy.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secp256k1Module: any = await import('@noble/curves/secp256k1.js' as string);
    const idBytes = hexToBytes(id);
    const privKeyBytes = hexToBytes(this.config.transportPrivateKey);
    let sigBytes: Uint8Array;
    try {
      sigBytes = secp256k1Module.schnorr.sign(idBytes, privKeyBytes);
    } finally {
      privKeyBytes.fill(0);
    }
    const sig = bytesToHex(sigBytes);

    return {
      id,
      pubkey: unsigned.pubkey,
      created_at: unsigned.created_at,
      kind: unsigned.kind,
      tags: unsigned.tags,
      content: unsigned.content,
      sig,
    };
  }

  /**
   * Steelman remediation: verify incoming event per NIP-01.
   * Checks:
   *   1. `id === sha256(serialize(evt))` (event id binds the content)
   *   2. `schnorr.verify(sig, id, pubkey)` (signature binds id to key)
   *
   * A compromised or malicious relay can inject `EVENT` frames with
   * arbitrary content for known public keys. Without these checks,
   * the bridge trusts whatever the relay delivers; silently-skipped
   * decrypt failures turn into memory DoS + replay attack surface.
   */
  private async verifyEventAuthentic(evt: NostrEvent): Promise<boolean> {
    try {
      const serialized = JSON.stringify([
        0,
        evt.pubkey,
        evt.created_at,
        evt.kind,
        evt.tags,
        evt.content,
      ]);
      const { sha256 } = await import('@noble/hashes/sha2.js');
      const expectedId = bytesToHex(sha256(new TextEncoder().encode(serialized)));
      if (expectedId !== evt.id) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const secp256k1Module: any = await import('@noble/curves/secp256k1.js' as string);
      // Steelman⁴ remediation: schnorr.verify also needs Uint8Array on
      // newer @noble/curves versions. Convert hex → bytes for all three
      // arguments. Malformed-hex inputs throw inside hexToBytes which
      // is caught by the surrounding try/catch → returns false.
      const sigBytes = hexToBytes(evt.sig);
      const idBytes = hexToBytes(evt.id);
      const pubKeyBytes = hexToBytes(evt.pubkey);
      return secp256k1Module.schnorr.verify(sigBytes, idBytes, pubKeyBytes) === true;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// Utility functions
// =============================================================================

/**
 * Derive the x-only public key (32 bytes, hex) from a secp256k1 private key.
 * Nostr uses x-only (schnorr) public keys per NIP-01.
 *
 * Steelman⁴ remediation: convert hex → Uint8Array before calling schnorr.
 * Newer @noble/curves versions reject hex-string inputs to schnorr APIs;
 * the previous code only happened to work on the older string-tolerant
 * version. Converting upfront makes the call version-portable and
 * fail-loudly on malformed hex.
 */
async function derivePublicKeyHex(privateKeyHex: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const secp256k1Module: any = await import('@noble/curves/secp256k1.js' as string);
  const privKeyBytes = hexToBytes(privateKeyHex);
  const pubBytes: Uint8Array = secp256k1Module.schnorr.getPublicKey(privKeyBytes);
  return bytesToHex(pubBytes);
}

/**
 * Convert a Uint8Array to a lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return hex.join('');
}

/**
 * Convert a hex string to a Uint8Array.
 *
 * Steelman⁵ remediation: throws on malformed input (odd length, non-hex
 * chars). The previous implementation silently truncated odd-length
 * input (`len = hex.length / 2`) and coerced parseInt NaN to 0,
 * producing a wrong-size or zero-padded byte array without any
 * indication of failure. Commit I's comments at the schnorr call sites
 * (`derivePublicKeyHex`, `buildSignedEvent`, `verifyEventAuthentic`)
 * assumed throwing semantics — those assumptions are now actually
 * guaranteed by this validator.
 *
 * Throws Error if `hex.length` is odd or any character is not in
 * [0-9a-fA-F]. Empty string is treated as valid (returns empty array).
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (length ${hex.length})`);
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('hexToBytes: hex string contains non-hex characters');
  }
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Test-only export of hexToBytes for direct regression coverage of
 * the validation contract introduced in steelman⁵ commit J. Steelman⁶
 * caught that the indirect test (via verifyEventAuthentic) couldn't
 * distinguish "hexToBytes throws" from "schnorr.verify throws on
 * wrong-size bytes" — both paths fail closed via the same try/catch.
 * Direct coverage is the only way to assert the validation contract
 * itself rather than its downstream consequences.
 *
 * NOT part of the public API.
 */
export const __testInternal = {
  hexToBytes,
};

/**
 * Generate a random subscription ID for Nostr REQ messages.
 */
function randomSubscriptionId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return 'orbitdb_' + bytesToHex(bytes);
}
