/**
 * GroupChatModule — global-chat backlog freeze reproduction (relay e2e)
 *
 * WHY THIS EXISTS
 * ---------------
 * Enabling group chat in the Sphere wallet froze the UI: on first connect the
 * client auto-joins the pinned global groups (`announcements`, `general`) and
 * `subscribeToJoinedGroups()` issues a NIP-29 message REQ with **no `limit`**
 * (and no `since`, because nothing is stored yet). A busy global group then
 * replays its ENTIRE history in one burst, and every event runs synchronously
 * through `handleGroupEvent` (JSON.parse + saveMessageToMemory + two emitEvent
 * fan-outs) on the main thread with no chunking/yielding. Backlog volume × the
 * per-event synchronous work = a dead UI until the dump finishes.
 *
 * This test reproduces that against the REAL relay so we can SEE what stalls,
 * then locks in the fix contract: the initial backlog must be BOUNDED, not the
 * whole history.
 *
 * HOW TO RUN
 * ----------
 *   npm run test:relay -- groupchat-backlog-freeze
 *   # or point at another relay:
 *   RELAY_URL=wss://sphere-relay.unicity.network npm run test:relay -- groupchat-backlog-freeze
 *
 * Defaults to the real production relay because the freeze only manifests
 * against a group that actually has a large stored history (an empty Docker
 * relay can't reproduce it).
 */
import { describe, it, expect } from 'vitest';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { NostrKeyManager } from '@unicitylabs/nostr-js-sdk';

import { GroupChatModule } from '../../modules/groupchat/GroupChatModule';
import { GroupVisibility } from '../../modules/groupchat/types';
import type { GroupData } from '../../modules/groupchat/types';
import type { StorageProvider } from '../../storage';
import type {
  FullIdentity,
  SphereEventType,
  SphereEventMap,
  TrackedAddressEntry,
  ProviderStatus,
} from '../../types';
import { STORAGE_KEYS_ADDRESS, STORAGE_KEYS_GLOBAL } from '../../constants';

// =============================================================================
// Config
// =============================================================================

/** The real global chat lives here; override with RELAY_URL to target another. */
const RELAY_URL = process.env.RELAY_URL ?? 'wss://sphere-relay.unicity.network';

/** The busiest pinned global group — the one that actually has a big backlog. */
const GLOBAL_GROUP_ID = process.env.GROUP_ID ?? 'general';

/**
 * The fix contract: the first connect must request a BOUNDED backlog
 * (config.defaultMessageLimit, currently 50), not the entire history.
 * Allow a small margin for live messages that land during the quiet window.
 */
const DEFAULT_MESSAGE_LIMIT = 50;
const LIVE_TRAFFIC_TOLERANCE = 25;
const MAX_INITIAL_BACKLOG = DEFAULT_MESSAGE_LIMIT + LIVE_TRAFFIC_TOLERANCE;

/** Treat the backlog as drained once no new message arrives for this long. */
const QUIET_MS = 2500;
/** Hard cap on how long we wait for the backlog burst to settle. */
const SETTLE_HARD_CAP_MS = 90_000;

// A fixed, valid (non-zero, < n) secp256k1 scalar for the read-only test user.
const TEST_PRIVATE_KEY = '00000000000000000000000000000000000000000000000000000000000000a1';

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class InMemoryStorageProvider implements StorageProvider {
  readonly id = 'memory';
  readonly name = 'Memory';
  readonly type = 'local' as const;
  private data = new Map<string, string>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  getStatus(): ProviderStatus { return 'connected'; }
  setIdentity(): void {}
  async get(key: string): Promise<string | null> { return this.data.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.data.set(key, value); }
  async remove(key: string): Promise<void> { this.data.delete(key); }
  async has(key: string): Promise<boolean> { return this.data.has(key); }
  async keys(prefix?: string): Promise<string[]> {
    const all: string[] = [];
    this.data.forEach((_, k) => all.push(k));
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  }
  async clear(prefix?: string): Promise<void> {
    if (!prefix) { this.data.clear(); return; }
    const toDelete: string[] = [];
    this.data.forEach((_, k) => { if (k.startsWith(prefix)) toDelete.push(k); });
    toDelete.forEach((k) => this.data.delete(k));
  }
  async saveTrackedAddresses(): Promise<void> {}
  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> { return []; }
}

function getXOnlyPubkey(privateKeyHex: string): string {
  const km = NostrKeyManager.fromPrivateKey(Buffer.from(privateKeyHex, 'hex'));
  return km.getPublicKeyHex();
}

/**
 * Seed storage so the module already "knows" the global group, forcing the
 * production `subscribeToJoinedGroups()` path (groups.size > 0) rather than the
 * relay-restore path. Also seed the relay URL so checkAndClearOnRelayChange()
 * doesn't wipe the seeded group.
 */
async function seedGlobalGroup(storage: InMemoryStorageProvider): Promise<void> {
  const group: GroupData = {
    id: GLOBAL_GROUP_ID,
    relayUrl: RELAY_URL,
    name: GLOBAL_GROUP_ID,
    visibility: GroupVisibility.PUBLIC,
    createdAt: 1,
  };
  await storage.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([group]));
  await storage.set(STORAGE_KEYS_GLOBAL.GROUP_CHAT_RELAY_URL, RELAY_URL);
}

async function connectWithRetry(module: GroupChatModule, maxAttempts = 15): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await module.connect();
      if (module.getConnectionStatus()) return;
    } catch { /* swallow and retry */ }
    await sleep(1000);
  }
  throw new Error(`Failed to connect to relay ${RELAY_URL} after retries`);
}

// =============================================================================
// Test
// =============================================================================

describe('GroupChatModule — global-chat backlog freeze', () => {
  it(
    'bounds the initial backlog instead of replaying the entire global history',
    async () => {
      const storage = new InMemoryStorageProvider();
      await seedGlobalGroup(storage);

      const identity: FullIdentity = {
        privateKey: TEST_PRIVATE_KEY,
        chainPubkey: '02' + getXOnlyPubkey(TEST_PRIVATE_KEY),
      };

      const events: Array<{ type: string; data: unknown }> = [];
      const emitEvent = <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
        events.push({ type, data });
      };

      const module = new GroupChatModule({ relays: [RELAY_URL] });
      module.initialize({ identity, storage, emitEvent });
      await module.load();

      // --- Instrument: count ingested messages + max main-thread (event-loop) stall.
      let count = 0;
      let firstAt = 0;
      let lastAt = 0;
      const unsub = module.onMessage(() => {
        count++;
        const now = Date.now();
        if (count === 1) firstAt = now;
        lastAt = now;
      });

      const eld = monitorEventLoopDelay({ resolution: 1 });
      eld.enable();
      const connectStart = Date.now();

      await connectWithRetry(module);

      // Wait until the backlog burst drains (quiet window) or we hit the cap.
      const waitStart = Date.now();
      while (Date.now() - waitStart < SETTLE_HARD_CAP_MS) {
        await sleep(250);
        if (count > 0 && Date.now() - lastAt > QUIET_MS) break;
      }

      eld.disable();
      unsub();
      module.destroy?.();

      const ingestMs = firstAt && lastAt ? lastAt - firstAt : 0;
      const report = {
        relay: RELAY_URL,
        group: GLOBAL_GROUP_ID,
        backlogMessages: count,
        connectToFirstMsgMs: firstAt ? firstAt - connectStart : null,
        backlogIngestMs: ingestMs,
        eventLoopMaxMs: +(eld.max / 1e6).toFixed(1),
        eventLoopP99Ms: +(eld.percentile(99) / 1e6).toFixed(1),
        eventLoopMeanMs: +(eld.mean / 1e6).toFixed(2),
        groupchatMessageEmits: events.filter((e) => e.type === 'groupchat:message').length,
      };
      // Always surface the numbers so we can SEE what stalls, pass or fail.
      console.log('[backlog-freeze] ' + JSON.stringify(report, null, 2));

      // Sanity: we actually received the backlog (0 ⇒ relay needs auth/membership;
      // that's a different finding worth failing loudly on).
      expect(count, 'received no messages — relay may require auth/membership to read').toBeGreaterThan(0);

      // FIX CONTRACT (red until the subscription is bounded): the initial load
      // must NOT stream the entire global history.
      expect(
        count,
        `initial backlog of ${count} msgs exceeds the bounded limit — global history is being fully replayed on connect`,
      ).toBeLessThanOrEqual(MAX_INITIAL_BACKLOG);
    },
    SETTLE_HARD_CAP_MS + 60_000,
  );
});
