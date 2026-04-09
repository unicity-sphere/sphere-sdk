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
 *   kind: 30078 (parameterized replaceable -- custom app data)
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

/** Nostr event kind for parameterized replaceable events (NIP-33). */
const NOSTR_KIND_APP_DATA = 30078;

/** Tag value used to filter OrbitDB OpLog events on the relay. */
const OPLOG_TAG = 'orbitdb-oplog';

/** Connection timeout in milliseconds. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Maximum time to wait for EOSE (end of stored events) in milliseconds. */
const EOSE_TIMEOUT_MS = 15_000;

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
   * hex-encoded, and published as the content of a kind-30078 Nostr event.
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
      kind: NOSTR_KIND_APP_DATA,
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
      kinds: [NOSTR_KIND_APP_DATA],
      '#d': [this.config.dbAddress],
      '#t': [OPLOG_TAG],
      authors: [this.pubkey!],
      since,
    };

    return new Promise<Uint8Array[]>((resolve, reject) => {
      const events: NostrEvent[] = [];
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

        let parsed: unknown[];
        try {
          parsed = JSON.parse(String(msg.data));
        } catch {
          return;
        }

        if (!Array.isArray(parsed)) return;

        if (parsed[0] === 'EVENT' && parsed[1] === subId && parsed[2]) {
          events.push(parsed[2] as NostrEvent);
        } else if (parsed[0] === 'EOSE' && parsed[1] === subId) {
          settled = true;
          clearTimeout(timeout);
          cleanup();
          this.decryptEvents(events).then(resolve, reject);
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
          // Resolve anyway -- the event may have been accepted without OK
          resolve();
        }
      }, 5_000);

      const onMessage = (msg: MessageEvent) => {
        if (settled) return;
        let parsed: unknown[];
        try {
          parsed = JSON.parse(String(msg.data));
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

    const secp256k1Module: any = await import('@noble/curves/secp256k1.js' as string);
    const sigBytes: Uint8Array = secp256k1Module.schnorr.sign(id, this.config.transportPrivateKey);
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
}

// =============================================================================
// Utility functions
// =============================================================================

/**
 * Derive the x-only public key (32 bytes, hex) from a secp256k1 private key.
 * Nostr uses x-only (schnorr) public keys per NIP-01.
 */
async function derivePublicKeyHex(privateKeyHex: string): Promise<string> {
  const secp256k1Module: any = await import('@noble/curves/secp256k1.js' as string);
  const pubBytes: Uint8Array = secp256k1Module.schnorr.getPublicKey(privateKeyHex);
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
 */
function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Generate a random subscription ID for Nostr REQ messages.
 */
function randomSubscriptionId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return 'orbitdb_' + bytesToHex(bytes);
}
