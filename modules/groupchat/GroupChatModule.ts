/**
 * Group Chat Module (NIP-29)
 *
 * Relay-based group chat using NIP-29 protocol on a dedicated Nostr relay.
 * Embeds its own NostrClient — does NOT share the wallet's TransportProvider.
 */

import {
  NostrClient,
  NostrKeyManager,
  Filter,
  type Event,
} from '@unicitylabs/nostr-js-sdk';

import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import { hexToBytes as strictHexToBytes } from '../../core/hex';

import type {
  FullIdentity,
  SphereEventType,
  SphereEventMap,
} from '../../types';
import type { StorageProvider } from '../../storage';
import { STORAGE_KEYS_GLOBAL, STORAGE_KEYS_ADDRESS, NIP29_KINDS } from '../../constants';
import { CidRefStore, type CidRef } from '../../profile/cid-ref-store';

/**
 * Prefixes for per-groupId storage keys (PROFILE-CID-REFERENCES.md §8.5).
 *
 * Before this refactor, `group_chat_messages` and `group_chat_members` each
 * stored ALL groups' data in a single global blob. The spec calls for
 * per-groupId partitioning — each group gets its own KV key so a group's
 * state can be read/written independently, and future CID-ref migrations
 * can pin per-group rather than per-wallet-blob.
 *
 * `group_chat_groups` stays single-keyed — the spec allows this because it
 * is bounded by group count (typically <100).
 *
 * `group_chat_processed_events` stays single-keyed — it is a dedup set not
 * addressed by the spec.
 */
const GROUP_CHAT_MESSAGES_PREFIX = 'group_chat_messages:';
const GROUP_CHAT_MEMBERS_PREFIX = 'group_chat_members:';

/**
 * Pattern B index schema (PROFILE-CID-REFERENCES.md §8.4 / §8.5).
 *
 * The KV value at `group_chat_messages:<groupId>` carries a CidRef that
 * points to an index blob of this shape. Each `items[i].cid` is itself
 * a plaintext CidRef over the corresponding message's JSON. This lets
 * identical messages (same content across wallets) share one IPFS CID
 * regardless of their position in any wallet's array — the dedup unit
 * drops from "whole message list" (Pattern A) to "single message"
 * (Pattern B).
 */
const GROUP_CHAT_MESSAGES_INDEX_V = 1 as const;

/**
 * Per-item size cap for the Pattern B message fetch path (steelman
 * hardening — closes a bandwidth-DoS attack where a hostile index
 * declares oversized items pointing at attacker-controlled IPFS
 * content). Legitimate NIP-29 chat messages are text + light metadata;
 * 64 KiB is a generous bound for structured content + attachment refs.
 * Items exceeding this are skipped on load with a logger.error.
 */
const MAX_GROUP_MESSAGE_SIZE = 64 * 1024;

/**
 * Upper bound on items per index blob. A hostile index at the
 * cidRefStore.maxFetchBytes limit (50 MiB default) could otherwise
 * declare ~625k items and trigger that many parallel IPFS fetches on
 * load, exhausting file descriptors / memory / socket pool. The
 * spec's Phase-2 archive mechanism triggers at 5000 entries (§8.4);
 * 10k is double that — any legitimate group is well under this cap.
 */
const MAX_INDEX_ITEMS = 10_000;

/**
 * Concurrency cap for per-message CID fetches on load (Pattern B index).
 *
 * Before this cap, `fetched.items.map(async i => fetchJson(i))` + Promise.all
 * spawned up to MAX_INDEX_ITEMS (10k) parallel HTTP requests per group, with
 * additional fan-out across groups. With a single slow/sick gateway (e.g.
 * unicity-ipfs1.dyndns.org returning 404/502), that fan-out becomes a
 * thundering-herd: each request pins one socket for the 30s fetch timeout,
 * and the cumulative wall-time grows quadratically.
 *
 * 4 keeps the existing "parallel-not-serial" speed-up (a small batch still
 * overlaps network + decode latency) while leaving headroom for the rest of
 * the page (transport, payments, profile-storage) to make progress on shared
 * gateways. The page-freeze symptom (issue: 2026-05-29) was driven primarily
 * by this unbounded fan-out colliding with a degraded testnet gateway.
 */
const LOAD_FETCH_CONCURRENCY = 4;

/**
 * Run an async mapper across `items` with a bounded number of concurrent
 * workers. Preserves order in the output.
 *
 * Error semantics: each worker pulls items off a shared cursor and calls
 * `fn`. The expectation at every call site in this file is that `fn`
 * handles per-item errors and returns a sentinel (typically `null`)
 * rather than throwing. If `fn` does throw, the thrower's worker sets
 * `aborted` so sibling workers stop pulling NEW items from the cursor
 * — in-flight `fn` calls already dispatched still settle. The aggregate
 * promise then rejects with the first thrown error via `Promise.all`.
 *
 * This is STRICTER than `Promise.all(items.map(fn))`, which keeps
 * dispatching new work after the first rejection until it hits the end
 * of the input — that looser semantic is the exact fan-out leak this
 * helper exists to avoid (page-freeze 2026-05-29, where an unbounded
 * `Promise.all(items.map(fetchJson))` on a sick gateway issued 30 s
 * sockets per item even after the first 404).
 */
async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let aborted = false;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!aborted) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

interface GroupChatMessagesIndexItem {
  /** Stable message id (from Nostr event id). Always present for persisted messages. */
  readonly id: string;
  /** Message timestamp (ms since epoch) — lets readers sort without fetching bodies. */
  readonly ts: number;
  /** Content-addressed CID of the individual message pin. */
  readonly cid: string;
  /** Size in bytes of the pinned message content. */
  readonly size: number;
}

interface GroupChatMessagesIndex {
  readonly v: typeof GROUP_CHAT_MESSAGES_INDEX_V;
  readonly items: readonly GroupChatMessagesIndexItem[];
}

/** Pattern B index shape discriminator. Distinguishes from Pattern A
 *  (plain message array) during the dual-read migration window.
 *
 *  Structural check only at this layer — per-item field validation
 *  happens at load time (`isValidIndexItem`) so malformed items can
 *  be skipped individually rather than aborting the whole group. */
function isMessagesIndex(value: unknown): value is GroupChatMessagesIndex {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as GroupChatMessagesIndex).v === GROUP_CHAT_MESSAGES_INDEX_V &&
    Array.isArray((value as GroupChatMessagesIndex).items)
  );
}

/** Per-item validation for index items loaded from a potentially-hostile
 *  source (attacker-controlled LWW replication could plant malformed
 *  items — we fail-closed per-item rather than abort the whole group). */
function isValidIndexItem(v: unknown): v is GroupChatMessagesIndexItem {
  if (v === null || typeof v !== 'object') return false;
  const item = v as Partial<GroupChatMessagesIndexItem>;
  return (
    typeof item.id === 'string' && item.id.length > 0 &&
    typeof item.ts === 'number' && Number.isFinite(item.ts) &&
    typeof item.cid === 'string' && item.cid.length > 0 &&
    typeof item.size === 'number' && Number.isFinite(item.size) &&
    item.size >= 0
  );
}

import type {
  GroupData,
  GroupMessageData,
  GroupMemberData,
  GroupChatModuleConfig,
  CreateGroupOptions,
  GroupRole,
  GroupMessagesPage,
  GetGroupMessagesPageOptions,
} from './types';
import { GroupRole as GroupRoleEnum, GroupVisibility as GroupVisibilityEnum } from './types';

// =============================================================================
// Dependencies
// =============================================================================

export interface GroupChatModuleDependencies {
  identity: FullIdentity;
  storage: StorageProvider;
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  /**
   * Optional CID-reference store for OpLog fat-data migration
   * (PROFILE-CID-REFERENCES.md §8.5). When present, group state is
   * pinned to IPFS with a split encryption policy:
   *   - `groupChatGroups` → encrypted (per-wallet membership view)
   *   - `groupChatMembers:<groupId>` → encrypted (per-wallet view of
   *     the group, small)
   *   - `groupChatMessages:<groupId>` → PLAINTEXT (NIP-29 messages are
   *     relay-plaintext anyway; plaintext pins enable full IPFS
   *     content dedup across member wallets — a 100-member group
   *     stores each message ONCE globally instead of 100×)
   * When absent, falls back to legacy inline JSON storage.
   */
  cidRefStore?: CidRefStore;
}

// =============================================================================
// NIP-29 Filter Helper
// =============================================================================

/**
 * Extended filter data for NIP-29 queries.
 * NIP-29 uses 'h' tags for group IDs which aren't in the standard Filter type.
 */
interface Nip29FilterData {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#e'?: string[];
  '#p'?: string[];
  '#t'?: string[];
  '#d'?: string[];
  '#h'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

function createNip29Filter(data: Nip29FilterData): Filter {
  return new Filter(data as ConstructorParameters<typeof Filter>[0]);
}

// =============================================================================
// Implementation
// =============================================================================

export class GroupChatModule {
  private config: Required<GroupChatModuleConfig>;
  private deps: GroupChatModuleDependencies | null = null;

  // Nostr connection (separate from wallet relay)
  private client: NostrClient | null = null;
  private keyManager: NostrKeyManager | null = null;
  private connected = false;
  private connecting = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Subscription tracking (for cleanup)
  private subscriptionIds: string[] = [];

  // In-memory state
  private groups: Map<string, GroupData> = new Map();
  private messages: Map<string, GroupMessageData[]> = new Map(); // groupId -> messages
  private members: Map<string, GroupMemberData[]> = new Map();   // groupId -> members
  private processedEventIds: Set<string> = new Set();
  private pendingLeaves: Set<string> = new Set();

  /**
   * Orphan-cleanup tracking for per-groupId storage keys. Records which
   * groupIds currently have a per-group messages/members key in storage
   * so that, on persist, we can delete keys for groups the user has left
   * (otherwise per-group blobs would leak indefinitely).
   *
   * Populated on `load()` (from observed keys) and on each successful
   * persist (with the just-written groupIds).
   */
  private _lastWrittenMessageGroupIds: Set<string> = new Set();
  private _lastWrittenMemberGroupIds: Set<string> = new Set();

  /**
   * Memoized (plaintext JSON → CidRef) pairs for each persist target.
   * AES-GCM uses random IVs so re-pinning identical plaintext encrypted
   * produces a different CID; for plaintext pins the CID is deterministic,
   * but we still avoid the round-trip cost on unchanged state. Both paths
   * benefit from memoization.
   *
   * Groups memo: single ref (one key for the whole groups list).
   * Members memo: keyed by groupId (one ref per group).
   * Messages memo: keyed by groupId → per-group-INDEX ref (Pattern B —
   * the stored ref points at an index blob, NOT the message array
   * directly). The per-message CIDs are cached separately in
   * `_pinnedMessageCids` so identical messages don't re-pin across
   * persists.
   */
  private _lastPinnedGroupsJson: string | null = null;
  private _lastPinnedGroupsRef: CidRef | null = null;
  private _lastPinnedMembersByGroup = new Map<string, { json: string; ref: CidRef }>();
  private _lastPinnedMessagesByGroup = new Map<string, { json: string; ref: CidRef }>();

  /**
   * Issue #285 — `processedEvents` (NIP-29 event ID dedup ledger) memo.
   * Grows unbounded with relay activity (observed 263 KB after routine
   * use) and was the second-worst soft-warn offender behind
   * `groupChatMembers`. Pattern A encrypted pin (per-wallet view —
   * dedup across wallets has no value).
   */
  private _lastPinnedProcessedEventsJson: string | null = null;
  private _lastPinnedProcessedEventsRef: CidRef | null = null;

  /**
   * Pattern B per-message CID cache — maps a message's serialized JSON
   * to the CID it was pinned under. Lets repeated persists for the same
   * group reuse CIDs for unchanged messages (saves ~N pin round-trips
   * per re-persist when only one message was added).
   *
   * Keyed by `JSON.stringify(message)` so any semantic change (content,
   * id, metadata, anything) invalidates the memo automatically. Cache
   * entries evict when the containing group is removed from
   * `_lastPinnedMessagesByGroup` (group-leave → whole group's message
   * memos drop).
   */
  private _pinnedMessageCids = new Map<string, { cid: string; size: number }>();

  // Persistence debounce
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Single-flight chain serializing all persist work (debounced +
   * explicit-flush + destroy-path). Every `doPersistAll()` invocation
   * chains onto the previous tail via `.then()`, so two writers can
   * never race — critical under Pattern B where `persistMessages` does
   * N+1 awaits (per-message pin + index pin), leaving a wide window
   * for a fresh message to arrive mid-persist and trigger a second
   * persist that would otherwise race the in-flight one's storage.set.
   *
   * Prior failures are isolated via `.catch()` so one failed persist
   * does not block subsequent persists. Mirrors
   * PaymentsModule._saveChain and CommunicationsModule._saveChain.
   *
   * The tail is also what `destroy()` and the explicit `persistAll()`
   * await to observe "all queued persists complete."
   */
  private persistPromise: Promise<void> = Promise.resolve();

  // Relay admin cache
  private relayAdminPubkeys: Set<string> | null = null;
  private relayAdminFetchPromise: Promise<Set<string>> | null = null;

  // Listeners
  private messageHandlers: Set<(message: GroupMessageData) => void> = new Set();

  constructor(config?: GroupChatModuleConfig) {
    this.config = {
      relays: config?.relays ?? [],
      defaultMessageLimit: config?.defaultMessageLimit ?? 50,
      maxPreviousTags: config?.maxPreviousTags ?? 3,
      reconnectDelayMs: config?.reconnectDelayMs ?? 3000,
      maxReconnectAttempts: config?.maxReconnectAttempts ?? 5,
    };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  initialize(deps: GroupChatModuleDependencies): void {
    // If re-initializing (address switch), destroy old connection
    if (this.deps) {
      this.destroyConnection();
    }

    this.deps = deps;

    // Create key manager from identity
    const secretKey = strictHexToBytes(deps.identity.privateKey);
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);
  }

  async load(): Promise<void> {
    this.ensureInitialized();
    const storage = this.deps!.storage;

    // Always clear in-memory state first so stale data from a previous
    // address never leaks into the newly loaded address.
    this.groups.clear();
    this.messages.clear();
    this.members.clear();
    this.processedEventIds.clear();
    // Reset orphan-cleanup tracking — the load() below repopulates it with
    // whatever keys actually exist in storage for this address.
    this._lastWrittenMessageGroupIds.clear();
    this._lastWrittenMemberGroupIds.clear();
    // Reset CID-ref memoization — a load-from-cold-storage doesn't know
    // which CIDs were last pinned by the prior module lifecycle.
    this._lastPinnedGroupsJson = null;
    this._lastPinnedGroupsRef = null;
    this._lastPinnedMembersByGroup.clear();
    this._lastPinnedMessagesByGroup.clear();
    this._pinnedMessageCids.clear();
    this._lastPinnedProcessedEventsJson = null;
    this._lastPinnedProcessedEventsRef = null;

    // Load groups — dual-read: CID ref envelope → fetch from IPFS
    // (encrypted, requireEncrypted strict); otherwise legacy inline JSON.
    const groupsJson = await storage.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS);
    if (groupsJson) {
      const ref = CidRefStore.tryParseRef(groupsJson);
      let parsed: GroupData[] | null = null;
      if (ref) {
        if (!this.deps!.cidRefStore) {
          // Degrade rather than brick load. Symmetric to the catch below: a
          // missing cidRefStore is treated like a fetch failure — start with
          // an empty groups set; relay re-delivery repopulates. The previous
          // fatal throw bricked the whole wallet load when this happened,
          // taking down every other module's load with it (issue:
          // page-freeze 2026-05-29).
          logger.warn(
            'GroupChat',
            `[CID_REF_DEGRADE] groups key contains a CID ref (cid=${ref.cid}) ` +
              `but no cidRefStore was injected; starting fresh.`,
          );
        } else {
          try {
            parsed = await this.deps!.cidRefStore.fetchJson<GroupData[]>(
              ref,
              { requireEncrypted: true },
            );
          } catch (err) {
            logger.error('GroupChat', '[GROUP_CHAT_GROUPS] CID-ref fetch failed', err);
          }
        }
      } else {
        try {
          parsed = JSON.parse(groupsJson) as GroupData[];
        } catch (err) {
          logger.error('GroupChat', '[GROUP_CHAT_GROUPS] legacy JSON parse failed', err);
        }
      }
      if (Array.isArray(parsed)) {
        for (const g of parsed) {
          this.groups.set(g.id, g);
        }
      } else if (parsed !== null) {
        logger.error(
          'GroupChat',
          `[GROUP_CHAT_GROUPS] decoded data is not an array (got ${typeof parsed}); skipping.`,
        );
      }
    }

    // Load messages — dual-read per PROFILE-CID-REFERENCES.md §8.5.
    //
    // Strategy (post-steelman): ALWAYS consult the legacy blob when present.
    // Per-group data wins on collision (it represents the most recent
    // migration state), legacy fills in groups that weren't migrated yet.
    // This closes the partial-migration data-loss bug: if a prior migration
    // attempt wrote per-group keys for some groups but crashed before
    // others, the remaining groups still migrate on the next load rather
    // than being silently skipped because "some per-group keys exist."
    //
    // Orphan-cleanup tracking is seeded from `storage.keys(prefix)` so that
    // stale per-group keys left over from prior sessions (e.g., groups the
    // wallet has since left) are detected on the next persist and removed.
    const existingMessageKeys = await storage.keys(GROUP_CHAT_MESSAGES_PREFIX);
    for (const key of existingMessageKeys) {
      this._lastWrittenMessageGroupIds.add(key.slice(GROUP_CHAT_MESSAGES_PREFIX.length));
    }
    for (const groupId of this.groups.keys()) {
      const json = await storage.get(GROUP_CHAT_MESSAGES_PREFIX + groupId);
      if (!json) continue;
      // Dual-read layers (ordered):
      //   1. CID ref envelope → fetch content.
      //       1a. Content is Pattern B index { v:1, items: [...] }
      //           → fetch each message CID in parallel, assemble the
      //             in-memory array. Failed individual fetches are
      //             logged and skipped — other messages still load.
      //       1b. Content is a plain array (Pattern A)
      //           → use directly; migration will upgrade to B on next
      //             persist.
      //   2. Legacy inline JSON — use directly.
      //
      // No `requireEncrypted` flag — messages legitimately use plaintext
      // pins for IPFS dedup (see persistMessages doc).
      const ref = CidRefStore.tryParseRef(json);
      let assembledMessages: GroupMessageData[] | null = null;
      if (ref) {
        if (!this.deps!.cidRefStore) {
          // Degrade: skip this group's messages; relay re-delivery repopulates.
          // See [CID_REF_DEGRADE] note above the groups-key site.
          logger.warn(
            'GroupChat',
            `[CID_REF_DEGRADE] messages:${groupId} contains a CID ref ` +
              `(cid=${ref.cid}) but no cidRefStore was injected; skipping.`,
          );
          continue;
        }
        let fetched: unknown;
        try {
          fetched = await this.deps!.cidRefStore.fetchJson(ref);
        } catch (err) {
          logger.error('GroupChat', `[GROUP_MESSAGES] CID-ref fetch failed for ${groupId}`, err);
          continue;
        }

        if (isMessagesIndex(fetched)) {
          // Pattern B: resolve each message CID in parallel. Parallel
          // fetch bounds total load latency to ~max(1 message) instead
          // of N × single-fetch — matters for groups with many messages.
          //
          // Steelman hardening:
          //   * Reject oversized indexes BEFORE spawning fetches. An
          //     attacker-crafted index at the 50 MiB cidRefStore cap
          //     could declare ~625k items; without this check we'd
          //     spawn that many parallel IPFS requests.
          //   * Validate each item's shape; malformed items logged +
          //     skipped without aborting the group.
          //   * Cap per-item size at MAX_GROUP_MESSAGE_SIZE before
          //     handing to cidRefStore.fetchJson — closes the
          //     (50 MiB × N-items) bandwidth DoS where a hostile index
          //     declares item.size near the cidRefStore cap.
          if (fetched.items.length > MAX_INDEX_ITEMS) {
            logger.error(
              'GroupChat',
              `[GROUP_MESSAGES] index for ${groupId} has ${fetched.items.length} items, exceeds cap ${MAX_INDEX_ITEMS}; refusing to load.`,
            );
            continue;
          }
          const cidRefStoreRef = this.deps!.cidRefStore;
          // Bound concurrency to LOAD_FETCH_CONCURRENCY (default 4) so a
          // group with thousands of messages doesn't spawn thousands of
          // parallel HTTP requests against a single gateway. The previous
          // unbounded Promise.all(items.map(...)) was the primary driver of
          // the 404-storm freeze observed 2026-05-29 — every miss pinned a
          // socket for the 30 s fetch timeout. See LOAD_FETCH_CONCURRENCY
          // doc-comment for the rationale on the limit.
          const results = await mapWithConcurrency(fetched.items, LOAD_FETCH_CONCURRENCY, async (item) => {
            if (!isValidIndexItem(item)) {
              logger.error(
                'GroupChat',
                `[GROUP_MESSAGES] malformed index item for ${groupId}; skipping.`,
              );
              return null;
            }
            if (item.size > MAX_GROUP_MESSAGE_SIZE) {
              logger.error(
                'GroupChat',
                `[GROUP_MESSAGES] index item for ${groupId} msg=${item.id} declares size ${item.size} > cap ${MAX_GROUP_MESSAGE_SIZE}; skipping.`,
              );
              return null;
            }
            try {
              const msg = await cidRefStoreRef.fetchJson<GroupMessageData>({
                v: 1,
                cid: item.cid,
                size: item.size,
                // Use Date.now() rather than a hardcoded sentinel — the
                // synthetic ref is passed directly to fetchJson (not
                // through tryParseRef), but using a plausible wall-clock
                // value makes this resilient to any future validateRef
                // plausibility checks.
                ts: Date.now(),
                enc: false,
              });
              // Seed the per-message CID memo so the next persist can
              // skip re-pinning unchanged messages.
              this._pinnedMessageCids.set(JSON.stringify(msg), {
                cid: item.cid,
                size: item.size,
              });
              return msg;
            } catch (err) {
              logger.error(
                'GroupChat',
                `[GROUP_MESSAGES] per-message CID fetch failed for ${groupId} msg=${item.id}; skipping.`,
                err,
              );
              return null;
            }
          });
          assembledMessages = results.filter((m): m is GroupMessageData => m !== null);
          // Seed the per-group index memo so an immediate re-persist
          // doesn't re-pin the whole index for unchanged state.
          this._lastPinnedMessagesByGroup.set(groupId, {
            json: JSON.stringify(fetched),
            ref,
          });
        } else if (Array.isArray(fetched)) {
          // Pattern A content — backward compat for data written pre-#101.
          // Not seeding per-message memo because these weren't pinned
          // individually; next persist will transparently migrate to B.
          assembledMessages = fetched as GroupMessageData[];
        } else {
          logger.error(
            'GroupChat',
            `[GROUP_MESSAGES] CID-ref content for ${groupId} is neither an index nor an array (got ${typeof fetched}); skipping.`,
          );
          continue;
        }
      } else {
        // Legacy inline JSON — direct array.
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch (err) {
          logger.error(
            'GroupChat',
            `[GROUP_MESSAGES] per-group blob for ${groupId} JSON parse failed; skipping.`,
            err,
          );
          continue;
        }
        if (!Array.isArray(parsed)) {
          logger.error(
            'GroupChat',
            `[GROUP_MESSAGES] legacy data for ${groupId} is not an array (got ${typeof parsed}); skipping.`,
          );
          continue;
        }
        assembledMessages = parsed as GroupMessageData[];
      }

      if (assembledMessages !== null) {
        this.messages.set(groupId, assembledMessages);
      }
    }
    const legacyMessagesJson = await storage.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES);
    if (legacyMessagesJson) {
      // Narrow try/catch: ONLY JSON.parse goes inside the try. Errors from
      // persistMessages / storage.remove must propagate with their original
      // semantics instead of being misreported as "JSON parse failed."
      let parsed: unknown;
      let parseOk = false;
      try {
        parsed = JSON.parse(legacyMessagesJson);
        parseOk = true;
      } catch (err) {
        logger.error(
          'GroupChat',
          '[GROUP_MESSAGES_LEGACY] JSON parse failed; leaving legacy blob in place.',
          err,
        );
      }
      if (parseOk) {
        if (!Array.isArray(parsed)) {
          logger.error(
            'GroupChat',
            `[GROUP_MESSAGES_LEGACY] data is not an array (got ${typeof parsed}); leaving legacy blob in place.`,
          );
        } else {
          // Snapshot the set of groups ALREADY covered by per-group reads
          // BEFORE we start mutating this.messages. If we used
          // `this.messages.has(groupId)` inside the loop, the first legacy
          // message for g2 would populate the key, and every subsequent
          // legacy message for g2 would be wrongly skipped.
          const perGroupCovered = new Set(this.messages.keys());
          let newlyAddedCount = 0;
          for (const m of parsed as GroupMessageData[]) {
            const groupId = m?.groupId;
            if (!groupId) continue;
            // Filter: only migrate for groups the wallet is currently in.
            // Orphans (groups the user has left) are dropped — they
            // wouldn't surface in the UI anyway and migrating them would
            // pollute per-group keys forever.
            if (!this.groups.has(groupId)) continue;
            // Per-group wins on collision — only fill in groups with no
            // per-group data pre-loop.
            if (perGroupCovered.has(groupId)) continue;
            const bucket = this.messages.get(groupId) ?? [];
            if (bucket.length === 0) this.messages.set(groupId, bucket);
            bucket.push(m);
            newlyAddedCount++;
          }
          if (newlyAddedCount > 0) {
            // Write per-group keys for the groups we just filled in.
            // Throws here propagate to the caller — a persist failure is a
            // real error and should NOT be silently mislabelled as a parse
            // failure. Legacy blob stays in place; next load retries.
            await this.persistMessages();
            logger.debug(
              'GroupChat',
              `Migrated ${newlyAddedCount} legacy messages into per-group keys`,
            );
          }
          // Remove legacy only after a successful migration pass (or a
          // no-op pass if all groups were already covered). If a prior
          // partial migration left the legacy blob in place, this call
          // is idempotent. Throws propagate.
          await storage.remove(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES);
        }
      }
    }

    // Load members — same dual-read pattern as messages.
    const existingMemberKeys = await storage.keys(GROUP_CHAT_MEMBERS_PREFIX);
    for (const key of existingMemberKeys) {
      this._lastWrittenMemberGroupIds.add(key.slice(GROUP_CHAT_MEMBERS_PREFIX.length));
    }
    for (const groupId of this.groups.keys()) {
      const json = await storage.get(GROUP_CHAT_MEMBERS_PREFIX + groupId);
      if (!json) continue;
      // Dual-read: CID ref (encrypted — requireEncrypted strict) OR
      // legacy inline JSON.
      const ref = CidRefStore.tryParseRef(json);
      let parsed: unknown = null;
      if (ref) {
        if (!this.deps!.cidRefStore) {
          // Degrade: skip this group's members; relay re-delivery repopulates.
          // See [CID_REF_DEGRADE] note above the groups-key site.
          logger.warn(
            'GroupChat',
            `[CID_REF_DEGRADE] members:${groupId} contains a CID ref ` +
              `(cid=${ref.cid}) but no cidRefStore was injected; skipping.`,
          );
          continue;
        }
        try {
          parsed = await this.deps!.cidRefStore.fetchJson(ref, { requireEncrypted: true });
        } catch (err) {
          logger.error('GroupChat', `[GROUP_MEMBERS] CID-ref fetch failed for ${groupId}`, err);
          continue;
        }
      } else {
        try {
          parsed = JSON.parse(json);
        } catch (err) {
          logger.error(
            'GroupChat',
            `[GROUP_MEMBERS] per-group blob for ${groupId} JSON parse failed; skipping.`,
            err,
          );
          continue;
        }
      }
      if (!Array.isArray(parsed)) {
        logger.error(
          'GroupChat',
          `[GROUP_MEMBERS] decoded data for ${groupId} is not an array (got ${typeof parsed}); skipping.`,
        );
        continue;
      }
      this.members.set(groupId, parsed as GroupMemberData[]);
    }
    const legacyMembersJson = await storage.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MEMBERS);
    if (legacyMembersJson) {
      // Narrow try/catch — see messages-legacy block above for rationale.
      let parsed: unknown;
      let parseOk = false;
      try {
        parsed = JSON.parse(legacyMembersJson);
        parseOk = true;
      } catch (err) {
        logger.error(
          'GroupChat',
          '[GROUP_MEMBERS_LEGACY] JSON parse failed; leaving legacy blob in place.',
          err,
        );
      }
      if (parseOk) {
        if (!Array.isArray(parsed)) {
          logger.error(
            'GroupChat',
            `[GROUP_MEMBERS_LEGACY] data is not an array (got ${typeof parsed}); leaving legacy blob in place.`,
          );
        } else {
          const perGroupCovered = new Set(this.members.keys());
          let newlyAddedCount = 0;
          for (const m of parsed as GroupMemberData[]) {
            const groupId = m?.groupId;
            if (!groupId) continue;
            if (!this.groups.has(groupId)) continue;
            if (perGroupCovered.has(groupId)) continue;
            const bucket = this.members.get(groupId) ?? [];
            if (bucket.length === 0) this.members.set(groupId, bucket);
            bucket.push(m);
            newlyAddedCount++;
          }
          if (newlyAddedCount > 0) {
            await this.persistMembers();
            logger.debug(
              'GroupChat',
              `Migrated ${newlyAddedCount} legacy members into per-group keys`,
            );
          }
          await storage.remove(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MEMBERS);
        }
      }
    }

    // Load processed event IDs — dual-read (CID ref envelope encrypted →
    // fetch from IPFS, requireEncrypted strict; OR legacy inline JSON).
    // Symmetric to the persistProcessedEvents() write path (#285 §8.5).
    const processedJson = await storage.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS);
    if (processedJson) {
      const ref = CidRefStore.tryParseRef(processedJson);
      let parsed: string[] | null = null;
      if (ref) {
        if (!this.deps!.cidRefStore) {
          // Degrade: start with an empty processed-events set; relay
          // re-delivery repopulates via idempotent event handlers. See
          // [CID_REF_DEGRADE] note above the groups-key site.
          logger.warn(
            'GroupChat',
            `[CID_REF_DEGRADE] processedEvents key contains a CID ref ` +
              `(cid=${ref.cid}) but no cidRefStore was injected; ` +
              `starting fresh.`,
          );
        } else {
          try {
            parsed = await this.deps!.cidRefStore.fetchJson<string[]>(
              ref,
              { requireEncrypted: true },
            );
          } catch (err) {
            // Best-effort: continue with empty set rather than poisoning load.
            // The ledger is recoverable — relay re-delivery will re-populate
            // on the next sync (worst case: a few duplicate event-handler
            // dispatches; the handlers themselves are idempotent).
            logger.error(
              'GroupChat',
              '[GROUP_CHAT_PROCESSED_EVENTS] CID-ref fetch failed; starting fresh',
              err,
            );
          }
        }
      } else {
        try {
          parsed = JSON.parse(processedJson) as string[];
        } catch {
          // Start fresh on legacy parse failure (same semantic as pre-#285).
        }
      }
      if (Array.isArray(parsed)) {
        this.processedEventIds = new Set(parsed);
      } else if (parsed !== null) {
        logger.error(
          'GroupChat',
          `[GROUP_CHAT_PROCESSED_EVENTS] decoded data is not an array (got ${typeof parsed}); starting fresh.`,
        );
      }
    }
  }

  destroy(): void {
    this.destroyConnection();

    // Flush any pending debounced persist before clearing state. The
    // persist is chained onto the existing persistPromise so it runs
    // strictly AFTER any in-flight one, guaranteeing the final writes
    // reflect the last-known state. Fire-and-forget (not awaited) — the
    // chain head holds all in-flight work and will resolve independently.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      if (this.deps) {
        this.persistPromise = this.persistPromise
          .catch(() => { /* isolate prior */ })
          .then(() => this.doPersistAll())
          .catch((err) =>
            logger.debug('GroupChat', 'Persist on destroy failed', err),
          );
      }
    }

    this.groups.clear();
    this.messages.clear();
    this.members.clear();
    this.processedEventIds.clear();
    this.pendingLeaves.clear();
    this.messageHandlers.clear();
    this.relayAdminPubkeys = null;
    this.relayAdminFetchPromise = null;
    // Reset chain tail to a fresh resolved promise — any in-flight
    // persist queued above still holds its own reference and completes
    // independently, but future schedulePersist() calls on a re-init
    // start from a clean tail.
    this.persistPromise = Promise.resolve();
    this.deps = null;
  }

  private destroyConnection(): void {
    // Cancel pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Unsubscribe all active subscriptions
    if (this.client) {
      for (const subId of this.subscriptionIds) {
        try { this.client.unsubscribe(subId); } catch (err) { logger.debug('GroupChat', 'Failed to unsubscribe', err); }
      }
      this.subscriptionIds = [];
      try {
        this.client.disconnect();
      } catch (err) {
        logger.debug('GroupChat', 'Failed to disconnect', err);
      }
      this.client = null;
    }
    this.connected = false;
    this.connecting = false;
    this.connectPromise = null;
    this.reconnectAttempts = 0;
    this.keyManager = null;
  }

  // ===========================================================================
  // Connection
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.connected) {
      // Already connected — refresh subscriptions for the current address
      // (e.g., after load() switched to a different address's data).
      await this.refreshSubscriptions();
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connecting = true;
    this.connectPromise = this.doConnect().finally(() => {
      this.connecting = false;
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  getConnectionStatus(): boolean {
    return this.connected;
  }

  /**
   * Refresh subscriptions after load() switched to a different address.
   * Clears old subscriptions, restores groups if needed, and re-subscribes.
   */
  private async refreshSubscriptions(): Promise<void> {
    if (!this.client) return;

    // Clear old subscriptions (for previous address's groups)
    for (const subId of this.subscriptionIds) {
      try { this.client.unsubscribe(subId); } catch (err) { logger.debug('GroupChat', 'Failed to unsubscribe', err); }
    }
    this.subscriptionIds = [];

    // Update key manager for new identity
    const secretKey = strictHexToBytes(this.deps!.identity.privateKey);
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);

    if (this.groups.size === 0) {
      await this.restoreJoinedGroups();
    } else {
      await this.subscribeToJoinedGroups();
    }

    this.deps!.emitEvent('groupchat:connection', { connected: true });
  }

  private async doConnect(): Promise<void> {
    this.ensureInitialized();

    if (!this.keyManager) {
      const secretKey = strictHexToBytes(this.deps!.identity.privateKey);
      this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);
    }

    // Check relay URL change and clear stale data
    const primaryRelay = this.config.relays[0];
    if (primaryRelay) {
      await this.checkAndClearOnRelayChange(primaryRelay);
    }

    this.client = new NostrClient(this.keyManager);

    try {
      await this.client.connect(...this.config.relays);
      this.connected = true;
      this.reconnectAttempts = 0;

      // Check if we have local groups
      if (this.groups.size === 0) {
        // No local groups — try to restore from relay (e.g., after wallet import)
        await this.restoreJoinedGroups();
      } else {
        // Subscribe to events for existing joined groups
        await this.subscribeToJoinedGroups();
      }

      // Emit connection event AFTER groups are loaded/subscribed,
      // so consumers don't query getGroups() while restoreJoinedGroups() is still running.
      this.deps!.emitEvent('groupchat:connection', { connected: true });
      this.deps!.emitEvent('groupchat:ready', { groupCount: this.groups.size });
    } catch (error) {
      logger.error('GroupChat', 'Failed to connect to relays', error);
      this.deps!.emitEvent('groupchat:connection', { connected: false });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.error('GroupChat', 'Max reconnection attempts reached');
      return;
    }

    // Exponential backoff: base * 2^attempt, capped at base * 16
    const maxDelay = this.config.reconnectDelayMs * 16;
    const delay = Math.min(this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts), maxDelay);
    this.reconnectAttempts++;

    logger.debug('GroupChat', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.deps) { // Guard against post-destroy fire
        this.connect().catch((err) => logger.error('GroupChat', 'Reconnect failed:', err));
      }
    }, delay);
  }

  // ===========================================================================
  // Subscription Management
  // ===========================================================================

  private async subscribeToJoinedGroups(): Promise<void> {
    if (!this.client) return;

    const groupIds = Array.from(this.groups.keys());
    if (groupIds.length === 0) return;

    // Use the latest known event timestamp as the `since` floor for messages
    // so the relay only sends events newer than what we already have.
    // Metadata/moderation subscriptions intentionally omit `since`:
    //  - Metadata kinds (39xxx) are replaceable — at most one event per group per kind
    //  - Moderation events must not be missed (e.g., kicks that occurred while offline)
    const sinceTimestamp = this.getLatestKnownTimestamp(groupIds);

    // Subscribe to group messages
    this.trackSubscription(
      createNip29Filter({
        kinds: [NIP29_KINDS.CHAT_MESSAGE, NIP29_KINDS.THREAD_ROOT, NIP29_KINDS.THREAD_REPLY],
        '#h': groupIds,
        ...(sinceTimestamp ? { since: sinceTimestamp } : {}),
      }),
      { onEvent: (event: Event) => this.handleGroupEvent(event) },
    );

    // Subscribe to group metadata changes (replaceable events — small volume, no since)
    this.trackSubscription(
      createNip29Filter({
        kinds: [NIP29_KINDS.GROUP_METADATA, NIP29_KINDS.GROUP_ADMINS],
        '#d': groupIds,
      }),
      { onEvent: (event: Event) => this.handleMetadataEvent(event) },
    );

    // Subscribe to moderation events (no since — must not miss offline kicks/deletes)
    this.trackSubscription(
      createNip29Filter({
        kinds: [NIP29_KINDS.DELETE_EVENT, NIP29_KINDS.REMOVE_USER, NIP29_KINDS.DELETE_GROUP],
        '#h': groupIds,
      }),
      { onEvent: (event: Event) => this.handleModerationEvent(event) },
    );
  }

  private subscribeToGroup(groupId: string): void {
    if (!this.client) return;

    const sinceTimestamp = this.getLatestKnownTimestamp([groupId]);

    this.trackSubscription(
      createNip29Filter({
        kinds: [NIP29_KINDS.CHAT_MESSAGE, NIP29_KINDS.THREAD_ROOT, NIP29_KINDS.THREAD_REPLY],
        '#h': [groupId],
        ...(sinceTimestamp ? { since: sinceTimestamp } : {}),
      }),
      { onEvent: (event: Event) => this.handleGroupEvent(event) },
    );

    this.trackSubscription(
      createNip29Filter({
        kinds: [NIP29_KINDS.DELETE_EVENT, NIP29_KINDS.REMOVE_USER, NIP29_KINDS.DELETE_GROUP],
        '#h': [groupId],
      }),
      { onEvent: (event: Event) => this.handleModerationEvent(event) },
    );
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  private handleGroupEvent(event: Event): void {
    if (this.processedEventIds.has(event.id)) return;

    const groupId = this.getGroupIdFromEvent(event);
    if (!groupId) return;

    const group = this.groups.get(groupId);
    if (!group) return;

    const { text: content, senderNametag } = this.unwrapMessageContent(event.content);

    const message: GroupMessageData = {
      id: event.id,
      groupId,
      content,
      timestamp: event.created_at * 1000,
      senderPubkey: event.pubkey,
      senderNametag: senderNametag || undefined,
      replyToId: this.extractReplyTo(event),
      previousIds: this.extractPreviousIds(event),
    };

    this.saveMessageToMemory(message);
    this.addProcessedEventId(event.id);

    // Update or create member with nametag from this message
    if (senderNametag) {
      this.updateMemberNametag(groupId, event.pubkey, senderNametag, event.created_at * 1000);
    }

    // Update group last message and unread count
    this.updateGroupLastMessage(groupId, content.slice(0, 100), message.timestamp);
    const myPubkey = this.getMyPublicKey();
    if (event.pubkey !== myPubkey) {
      group.unreadCount = (group.unreadCount || 0) + 1;
    }

    // Emit event and notify listeners
    this.deps!.emitEvent('groupchat:message', message);
    this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
    for (const handler of this.messageHandlers) {
      try { handler(message); } catch { /* ignore handler errors */ }
    }

    this.schedulePersist();
  }

  private handleMetadataEvent(event: Event): void {
    const groupId = this.getGroupIdFromMetadataEvent(event);
    if (!groupId) return;

    const group = this.groups.get(groupId);
    if (!group) return;

    if (event.kind === NIP29_KINDS.GROUP_METADATA) {
      if (event.content && event.content.trim()) {
        try {
          const metadata = JSON.parse(event.content);
          group.name = metadata.name || group.name;
          group.description = metadata.about || group.description;
          group.picture = metadata.picture || group.picture;
          if (metadata['write-restricted'] === true) group.writeRestricted = true;
          else group.writeRestricted = undefined;
        } catch {
          // Skip malformed JSON content
        }
      }
      // Tags are relay-authoritative and override JSON content
      for (const tag of event.tags) {
        if (tag[0] === 'write-restricted') group.writeRestricted = true;
      }
      group.updatedAt = event.created_at * 1000;
      this.groups.set(groupId, group);
      this.schedulePersist();
    } else if (event.kind === NIP29_KINDS.GROUP_ADMINS) {
      this.updateAdminsFromEvent(groupId, event);
    }
  }

  private handleModerationEvent(event: Event): void {
    const groupId = this.getGroupIdFromEvent(event);
    if (!groupId) return;

    const group = this.groups.get(groupId);
    if (!group) return;

    if (event.kind === NIP29_KINDS.DELETE_EVENT) {
      const eTags = event.tags.filter((t: string[]) => t[0] === 'e');
      for (const tag of eTags) {
        const messageId = tag[1];
        if (messageId) {
          this.deleteMessageFromMemory(groupId, messageId);
        }
      }
      this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
      this.schedulePersist();
    } else if (event.kind === NIP29_KINDS.REMOVE_USER) {
      if (this.processedEventIds.has(event.id)) return;

      // Ignore events before we joined
      const eventTimestampMs = event.created_at * 1000;
      if (group.localJoinedAt && eventTimestampMs < group.localJoinedAt) {
        this.addProcessedEventId(event.id);
        return;
      }

      this.addProcessedEventId(event.id);

      const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
      const myPubkey = this.getMyPublicKey();

      for (const tag of pTags) {
        const removedPubkey = tag[1];
        if (!removedPubkey) continue;

        if (removedPubkey === myPubkey) {
          if (this.pendingLeaves.has(groupId)) {
            // Voluntary leave
            this.pendingLeaves.delete(groupId);
            this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
          } else {
            // Kicked by admin
            const groupName = group.name || groupId;
            this.removeGroupFromMemory(groupId);
            this.deps!.emitEvent('groupchat:kicked', { groupId, groupName });
            this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
          }
        } else {
          // Someone else was kicked
          this.removeMemberFromMemory(groupId, removedPubkey);
        }
      }
      this.schedulePersist();
    } else if (event.kind === NIP29_KINDS.DELETE_GROUP) {
      if (this.processedEventIds.has(event.id)) return;

      const deleteTimestampMs = event.created_at * 1000;
      if (deleteTimestampMs < group.createdAt) {
        this.addProcessedEventId(event.id);
        return;
      }

      this.addProcessedEventId(event.id);

      const groupName = group.name || groupId;
      this.removeGroupFromMemory(groupId);
      this.deps!.emitEvent('groupchat:group_deleted', { groupId, groupName });
      this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
      this.schedulePersist();
    }
  }

  private updateAdminsFromEvent(groupId: string, event: Event): void {
    const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
    const existingMembers = this.members.get(groupId) || [];

    for (const tag of pTags) {
      const pubkey = tag[1];
      const existing = existingMembers.find((m) => m.pubkey === pubkey);

      if (existing) {
        existing.role = GroupRoleEnum.ADMIN;
        this.saveMemberToMemory(existing);
      } else {
        this.saveMemberToMemory({
          pubkey,
          groupId,
          role: GroupRoleEnum.ADMIN,
          joinedAt: event.created_at * 1000,
        });
      }
    }
    this.schedulePersist();
  }

  // ===========================================================================
  // Group Membership Restoration
  // ===========================================================================

  private async restoreJoinedGroups(): Promise<GroupData[]> {
    if (!this.client) return [];

    const myPubkey = this.getMyPublicKey();
    if (!myPubkey) return [];

    const groupIdsWithMembership = new Set<string>();

    await this.oneshotSubscription(
      createNip29Filter({ kinds: [NIP29_KINDS.GROUP_MEMBERS], '#p': [myPubkey] }),
      {
        onEvent: (event: Event) => {
          const groupId = this.getGroupIdFromMetadataEvent(event);
          if (groupId) {
            groupIdsWithMembership.add(groupId);
          }
        },
        onComplete: () => {},
        timeoutMs: 15000,
        timeoutLabel: 'restoreJoinedGroups',
      },
    );

    if (groupIdsWithMembership.size === 0) return [];

    const restoredGroups: GroupData[] = [];

    await Promise.all(
      Array.from(groupIdsWithMembership).map(async (groupId) => {
        if (this.groups.has(groupId)) return;

        try {
          const group = await this.fetchGroupMetadataInternal(groupId);
          if (group) {
            this.groups.set(groupId, group);
            restoredGroups.push(group);

            await Promise.all([
              this.fetchAndSaveMembers(groupId),
              this.fetchMessages(groupId),
            ]);
          }
        } catch (error) {
          logger.warn('GroupChat', 'Failed to restore group', groupId, error);
        }
      }),
    );

    if (restoredGroups.length > 0) {
      await this.subscribeToJoinedGroups();
      this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
      this.schedulePersist();
    }

    return restoredGroups;
  }

  // ===========================================================================
  // Public API — Groups
  // ===========================================================================

  async fetchAvailableGroups(): Promise<GroupData[]> {
    await this.ensureConnected();
    if (!this.client) return [];

    const groupsMap = new Map<string, GroupData>();

    await this.oneshotSubscription(
      new Filter({ kinds: [NIP29_KINDS.GROUP_METADATA] }),
      {
        onEvent: (event: Event) => {
          const group = this.parseGroupMetadata(event);
          if (group && group.visibility === GroupVisibilityEnum.PUBLIC) {
            const existing = groupsMap.get(group.id);
            if (!existing || group.createdAt > existing.createdAt) {
              groupsMap.set(group.id, group);
            }
          }
        },
        onComplete: () => {},
        timeoutMs: 10000,
        timeoutLabel: 'fetchAvailableGroups(metadata)',
      },
    );

    return Array.from(groupsMap.values());
  }

  async joinGroup(groupId: string, inviteCode?: string): Promise<boolean> {
    await this.ensureConnected();
    if (!this.client) return false;

    try {
      let group = await this.fetchGroupMetadataInternal(groupId);

      if (!group && !inviteCode) return false;

      const tags: string[][] = [['h', groupId]];
      if (inviteCode) tags.push(['code', inviteCode]);

      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.JOIN_REQUEST,
        tags,
        content: '',
      });

      if (eventId) {
        // For hidden groups, fetch metadata now that we're a member
        if (!group) {
          group = await this.fetchGroupMetadataInternal(groupId);
          if (!group) return false;
        }

        group.localJoinedAt = Date.now();
        this.groups.set(groupId, group);
        this.subscribeToGroup(groupId);

        await Promise.all([
          this.fetchMessages(groupId),
          this.fetchAndSaveMembers(groupId),
        ]);

        this.deps!.emitEvent('groupchat:joined', { groupId, groupName: group.name });
        this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
        this.persistAll();
        return true;
      }

      return false;
    } catch (error) {
      // Handle "already a member" as success
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already a member')) {
        const group = await this.fetchGroupMetadataInternal(groupId);
        if (group) {
          group.localJoinedAt = Date.now();
          this.groups.set(groupId, group);
          this.subscribeToGroup(groupId);
          await Promise.all([
            this.fetchMessages(groupId),
            this.fetchAndSaveMembers(groupId),
          ]);
          this.deps!.emitEvent('groupchat:joined', { groupId, groupName: group.name });
          this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
          this.persistAll();
          return true;
        }
      }
      logger.error('GroupChat', 'Failed to join group', error);
      return false;
    }
  }

  async leaveGroup(groupId: string): Promise<boolean> {
    await this.ensureConnected();
    if (!this.client) return false;

    try {
      this.pendingLeaves.add(groupId);

      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.LEAVE_REQUEST,
        tags: [['h', groupId]],
        content: '',
      });

      if (eventId) {
        this.removeGroupFromMemory(groupId);
        this.deps!.emitEvent('groupchat:left', { groupId });
        this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
        this.persistAll();
        return true;
      }

      this.pendingLeaves.delete(groupId);
      return false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('group not found') || msg.includes('not a member')) {
        this.removeGroupFromMemory(groupId);
        this.persistAll();
        return true;
      }
      logger.error('GroupChat', 'Failed to leave group', error);
      return false;
    }
  }

  async createGroup(options: CreateGroupOptions): Promise<GroupData | null> {
    await this.ensureConnected();
    if (!this.client) return null;

    const creatorPubkey = this.getMyPublicKey();
    if (!creatorPubkey) return null;

    const proposedGroupId = options.name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20) || this.randomId();

    try {
      const isPrivate = options.visibility === GroupVisibilityEnum.PRIVATE;

      // Publish CREATE_GROUP first, then fetch the metadata.
      // The relay creates the group synchronously, so by the time the OK
      // response arrives the GROUP_METADATA event is queryable.
      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.CREATE_GROUP,
        tags: [['h', proposedGroupId]],
        content: JSON.stringify({
          name: options.name,
          about: options.description,
          picture: options.picture,
          closed: true,
          private: isPrivate,
          hidden: isPrivate,
          ...(options.writeRestricted ? { 'write-restricted': true } : {}),
        }),
      });

      if (!eventId) return null;

      // Fetch the group metadata the relay created for us
      let group = await this.fetchGroupMetadataInternal(proposedGroupId);

      if (!group) {
        // Fallback: build group data from what we know
        group = {
          id: proposedGroupId,
          relayUrl: this.config.relays[0] || '',
          name: options.name,
          description: options.description,
          visibility: options.visibility || GroupVisibilityEnum.PUBLIC,
          createdAt: Date.now(),
          memberCount: 1,
        };
      }

      if (!group.name || group.name === 'Unnamed Group') {
        group.name = options.name;
      }
      if (options.description && !group.description) {
        group.description = options.description;
      }
      group.visibility = options.visibility || GroupVisibilityEnum.PUBLIC;
      group.memberCount = 1;

      this.groups.set(group.id, group);

      this.subscribeToGroup(group.id);

      this.client!.createAndPublishEvent({
        kind: NIP29_KINDS.JOIN_REQUEST,
        tags: [['h', group.id]],
        content: '',
      }).catch((err) => logger.debug('GroupChat', 'Background operation failed', err));

      // Fetch member/admin lists, then ensure creator is always admin.
      // The fetch can return incomplete data if the relay hasn't indexed
      // the admin event yet, so we re-assert after.
      await this.fetchAndSaveMembers(group.id).catch((err) => logger.debug('GroupChat', 'Failed to fetch members', group.id, err));
      this.saveMemberToMemory({
        pubkey: creatorPubkey,
        groupId: group.id,
        role: GroupRoleEnum.ADMIN,
        joinedAt: Date.now(),
      });

      this.deps!.emitEvent('groupchat:joined', { groupId: group.id, groupName: group.name });
      this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
      this.schedulePersist();

      return group;
    } catch (error) {
      logger.error('GroupChat', 'Failed to create group', error);
      return null;
    }
  }

  async deleteGroup(groupId: string): Promise<boolean> {
    await this.ensureConnected();
    if (!this.client) return false;

    const group = this.groups.get(groupId);
    if (!group) return false;

    // Relay admins can delete public groups; group admins can delete their own groups
    const canDelete = await this.canModerateGroup(groupId);
    if (!canDelete) return false;

    try {
      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.DELETE_GROUP,
        tags: [['h', groupId]],
        content: '',
      });

      if (eventId) {
        const groupName = group.name || groupId;
        this.removeGroupFromMemory(groupId);
        this.deps!.emitEvent('groupchat:group_deleted', { groupId, groupName });
        this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
        this.persistAll();
        return true;
      }
      return false;
    } catch (error) {
      logger.error('GroupChat', 'Failed to delete group', error);
      return false;
    }
  }

  async createInvite(groupId: string): Promise<string | null> {
    await this.ensureConnected();
    if (!this.client) return null;

    if (!this.isCurrentUserAdmin(groupId)) return null;

    try {
      const inviteCode = this.randomId();

      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.CREATE_INVITE,
        tags: [
          ['h', groupId],
          ['code', inviteCode],
        ],
        content: '',
      });

      return eventId ? inviteCode : null;
    } catch (error) {
      logger.error('GroupChat', 'Failed to create invite', error);
      return null;
    }
  }

  // ===========================================================================
  // Public API — Messages
  // ===========================================================================

  async sendMessage(
    groupId: string,
    content: string,
    replyToId?: string,
  ): Promise<GroupMessageData | null> {
    await this.ensureConnected();
    if (!this.client) return null;

    const group = this.groups.get(groupId);
    if (!group) return null;

    try {
      const senderNametag = this.deps!.identity.nametag || null;
      const kind = replyToId ? NIP29_KINDS.THREAD_REPLY : NIP29_KINDS.CHAT_MESSAGE;

      const tags: string[][] = [['h', groupId]];

      // Add previous message IDs for ordering
      const groupMessages = this.messages.get(groupId) || [];
      const recentIds = groupMessages
        .slice(-this.config.maxPreviousTags)
        .map((m) => (m.id || '').slice(0, 8))
        .filter(Boolean);
      if (recentIds.length > 0) {
        tags.push(['previous', ...recentIds]);
      }

      if (replyToId) {
        tags.push(['e', replyToId, '', 'reply']);
      }

      const wrappedContent = this.wrapMessageContent(content, senderNametag);

      const eventId = await this.client.createAndPublishEvent({
        kind,
        tags,
        content: wrappedContent,
      });

      if (eventId) {
        const myPubkey = this.getMyPublicKey();
        const message: GroupMessageData = {
          id: eventId,
          groupId,
          content,
          timestamp: Date.now(),
          senderPubkey: myPubkey || '',
          senderNametag: senderNametag || undefined,
          replyToId,
          previousIds: recentIds,
        };

        this.saveMessageToMemory(message);
        this.addProcessedEventId(eventId);
        this.updateGroupLastMessage(groupId, content.slice(0, 100), message.timestamp);
        this.persistAll();
        return message;
      }
      return null;
    } catch (error) {
      logger.error('GroupChat', 'Failed to send message', error);
      return null;
    }
  }

  async fetchMessages(
    groupId: string,
    since?: number,
    limit?: number,
  ): Promise<GroupMessageData[]> {
    await this.ensureConnected();
    if (!this.client) return [];

    const fetchedMessages: GroupMessageData[] = [];
    const filterData: Nip29FilterData = {
      kinds: [NIP29_KINDS.CHAT_MESSAGE, NIP29_KINDS.THREAD_ROOT, NIP29_KINDS.THREAD_REPLY],
      '#h': [groupId],
    };

    if (since) filterData.since = Math.floor(since / 1000);
    if (limit) filterData.limit = limit;
    if (!limit && !since) filterData.limit = this.config.defaultMessageLimit;

    return this.oneshotSubscription(createNip29Filter(filterData), {
      onEvent: (event: Event) => {
        const { text: content, senderNametag } = this.unwrapMessageContent(event.content);

        const message: GroupMessageData = {
          id: event.id,
          groupId,
          content,
          timestamp: event.created_at * 1000,
          senderPubkey: event.pubkey,
          senderNametag: senderNametag || undefined,
          replyToId: this.extractReplyTo(event),
          previousIds: this.extractPreviousIds(event),
        };

        fetchedMessages.push(message);
        this.saveMessageToMemory(message);
        this.addProcessedEventId(event.id);

        if (senderNametag) {
          this.updateMemberNametag(groupId, event.pubkey, senderNametag, event.created_at * 1000);
        }
      },
      onComplete: () => {
        this.schedulePersist();
        return fetchedMessages;
      },
      timeoutMs: 10000,
      timeoutLabel: `fetchMessages(${groupId})`,
    });
  }

  // ===========================================================================
  // Public API — Queries (from local state)
  // ===========================================================================

  getGroups(): GroupData[] {
    return Array.from(this.groups.values())
      .sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
  }

  getGroup(groupId: string): GroupData | null {
    return this.groups.get(groupId) || null;
  }

  getMessages(groupId: string): GroupMessageData[] {
    return (this.messages.get(groupId) || [])
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  getMessagesPage(groupId: string, options?: GetGroupMessagesPageOptions): GroupMessagesPage {
    const limit = options?.limit ?? 20;
    const before = options?.before ?? Infinity;
    const groupMessages = this.messages.get(groupId) ?? [];

    const filtered = groupMessages
      .filter(m => m.timestamp < before)
      .sort((a, b) => b.timestamp - a.timestamp); // newest first

    const page = filtered.slice(0, limit);
    return {
      messages: page.reverse(), // chronological order
      hasMore: filtered.length > limit,
      oldestTimestamp: page.length > 0 ? page[0].timestamp : null,
    };
  }

  getMembers(groupId: string): GroupMemberData[] {
    return (this.members.get(groupId) || [])
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  getMember(groupId: string, pubkey: string): GroupMemberData | null {
    const members = this.members.get(groupId) || [];
    return members.find((m) => m.pubkey === pubkey) || null;
  }

  getTotalUnreadCount(): number {
    let total = 0;
    for (const group of this.groups.values()) {
      total += group.unreadCount || 0;
    }
    return total;
  }

  markGroupAsRead(groupId: string): void {
    const group = this.groups.get(groupId);
    if (group && (group.unreadCount || 0) > 0) {
      group.unreadCount = 0;
      this.groups.set(groupId, group);
      this.schedulePersist();
    }
  }

  // ===========================================================================
  // Public API — Admin
  // ===========================================================================

  async kickUser(groupId: string, userPubkey: string, reason?: string): Promise<boolean> {
    await this.ensureConnected();
    if (!this.client) return false;

    const canModerate = await this.canModerateGroup(groupId);
    if (!canModerate) return false;

    const myPubkey = this.getMyPublicKey();
    if (myPubkey === userPubkey) return false;

    try {
      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.REMOVE_USER,
        tags: [['h', groupId], ['p', userPubkey]],
        content: reason || '',
      });

      if (eventId) {
        this.removeMemberFromMemory(groupId, userPubkey);
        this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
        this.schedulePersist();
        return true;
      }
      return false;
    } catch (error) {
      logger.error('GroupChat', 'Failed to kick user', error);
      return false;
    }
  }

  async deleteMessage(groupId: string, messageId: string): Promise<boolean> {
    await this.ensureConnected();
    if (!this.client) return false;

    const canModerate = await this.canModerateGroup(groupId);
    if (!canModerate) return false;

    try {
      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.DELETE_EVENT,
        tags: [['h', groupId], ['e', messageId]],
        content: '',
      });

      if (eventId) {
        this.deleteMessageFromMemory(groupId, messageId);
        this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
        this.schedulePersist();
        return true;
      }
      return false;
    } catch (error) {
      logger.error('GroupChat', 'Failed to delete message', error);
      return false;
    }
  }

  isCurrentUserAdmin(groupId: string): boolean {
    const myPubkey = this.getMyPublicKey();
    if (!myPubkey) return false;

    const member = this.getMember(groupId, myPubkey);
    return member?.role === GroupRoleEnum.ADMIN;
  }

  isCurrentUserModerator(groupId: string): boolean {
    const myPubkey = this.getMyPublicKey();
    if (!myPubkey) return false;

    const member = this.getMember(groupId, myPubkey);
    return member?.role === GroupRoleEnum.ADMIN || member?.role === GroupRoleEnum.MODERATOR;
  }

  /**
   * Check if current user can moderate a group:
   * - Group admin/moderator can always moderate their group
   * - Relay admins can moderate public groups
   */
  async canModerateGroup(groupId: string): Promise<boolean> {
    if (this.isCurrentUserAdmin(groupId) || this.isCurrentUserModerator(groupId)) {
      return true;
    }
    const group = this.groups.get(groupId);
    if (group && group.visibility === GroupVisibilityEnum.PUBLIC) {
      return this.isCurrentUserRelayAdmin();
    }
    return false;
  }

  async isCurrentUserRelayAdmin(): Promise<boolean> {
    const myPubkey = this.getMyPublicKey();
    if (!myPubkey) return false;

    const admins = await this.fetchRelayAdmins();
    return admins.has(myPubkey);
  }

  /**
   * Check if current user can write messages to a group.
   * For write-restricted groups, only admins/moderators can post.
   * For normal groups, any member can post.
   */
  canWriteToGroup(groupId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    if (!group.writeRestricted) return true;
    return this.isCurrentUserModerator(groupId);
  }

  getCurrentUserRole(groupId: string): GroupRole | null {
    const myPubkey = this.getMyPublicKey();
    if (!myPubkey) return null;

    const member = this.getMember(groupId, myPubkey);
    return member?.role || null;
  }

  // ===========================================================================
  // Public API — Listeners
  // ===========================================================================

  onMessage(handler: (message: GroupMessageData) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  // ===========================================================================
  // Public API — Utilities
  // ===========================================================================

  getRelayUrls(): string[] {
    return this.config.relays;
  }

  getMyPublicKey(): string | null {
    return this.keyManager?.getPublicKeyHex() || null;
  }

  /**
   * Returns the latest message timestamp (in Nostr seconds) across the given groups,
   * or 0 if no messages exist.  Used to set `since` on subscriptions so the relay
   * only sends events we don't already have.
   */
  private getLatestKnownTimestamp(groupIds: string[]): number {
    let latest = 0;
    for (const gid of groupIds) {
      const msgs = this.messages.get(gid);
      if (!msgs) continue;
      for (const m of msgs) {
        const ts = Math.floor(m.timestamp / 1000);
        if (ts > latest) latest = ts;
      }
    }
    return latest;
  }

  // ===========================================================================
  // Private — Relay Admin
  // ===========================================================================

  private async fetchRelayAdmins(): Promise<Set<string>> {
    if (this.relayAdminPubkeys) return this.relayAdminPubkeys;
    if (this.relayAdminFetchPromise) return this.relayAdminFetchPromise;

    this.relayAdminFetchPromise = this.doFetchRelayAdmins();
    const result = await this.relayAdminFetchPromise;
    this.relayAdminFetchPromise = null;
    return result;
  }

  private async doFetchRelayAdmins(): Promise<Set<string>> {
    await this.ensureConnected();
    if (!this.client) return new Set();

    const adminPubkeys = new Set<string>();
    return this.oneshotSubscription(
      new Filter({ kinds: [NIP29_KINDS.GROUP_ADMINS], '#d': ['', '_'] }),
      {
        onEvent: (event: Event) => {
          const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
          for (const tag of pTags) {
            if (tag[1]) adminPubkeys.add(tag[1]);
          }
        },
        onComplete: () => {
          this.relayAdminPubkeys = adminPubkeys;
          return adminPubkeys;
        },
      },
    );
  }

  // ===========================================================================
  // Private — Fetch Helpers
  // ===========================================================================

  private async fetchGroupMetadataInternal(groupId: string): Promise<GroupData | null> {
    if (!this.client) return null;

    let result: GroupData | null = null;
    return this.oneshotSubscription(
      new Filter({ kinds: [NIP29_KINDS.GROUP_METADATA], '#d': [groupId] }),
      {
        onEvent: (event: Event) => {
          if (!result) result = this.parseGroupMetadata(event);
        },
        onComplete: () => result,
      },
    );
  }

  private async fetchAndSaveMembers(groupId: string): Promise<void> {
    const [members, adminPubkeys] = await Promise.all([
      this.fetchGroupMembersInternal(groupId),
      this.fetchGroupAdminsInternal(groupId),
    ]);

    for (const member of members) {
      if (adminPubkeys.includes(member.pubkey)) {
        member.role = GroupRoleEnum.ADMIN;
      }
      this.saveMemberToMemory(member);
    }

    // Save admins not in member list
    for (const pubkey of adminPubkeys) {
      const existing = (this.members.get(groupId) || []).find((m) => m.pubkey === pubkey);
      if (!existing) {
        this.saveMemberToMemory({
          pubkey,
          groupId,
          role: GroupRoleEnum.ADMIN,
          joinedAt: Date.now(),
        });
      }
    }

    this.schedulePersist();
  }

  private async fetchGroupMembersInternal(groupId: string): Promise<GroupMemberData[]> {
    if (!this.client) return [];

    const members: GroupMemberData[] = [];
    return this.oneshotSubscription(
      new Filter({ kinds: [NIP29_KINDS.GROUP_MEMBERS], '#d': [groupId] }),
      {
        onEvent: (event: Event) => {
          const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
          for (const tag of pTags) {
            members.push({
              pubkey: tag[1],
              groupId,
              role: (tag[3] as GroupRole) || GroupRoleEnum.MEMBER,
              joinedAt: event.created_at * 1000,
            });
          }
        },
        onComplete: () => members,
      },
    );
  }

  private async fetchGroupAdminsInternal(groupId: string): Promise<string[]> {
    if (!this.client) return [];

    const adminPubkeys: string[] = [];
    return this.oneshotSubscription(
      new Filter({ kinds: [NIP29_KINDS.GROUP_ADMINS], '#d': [groupId] }),
      {
        onEvent: (event: Event) => {
          const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
          for (const tag of pTags) {
            if (tag[1] && !adminPubkeys.includes(tag[1])) {
              adminPubkeys.push(tag[1]);
            }
          }
        },
        onComplete: () => adminPubkeys,
      },
    );
  }

  // ===========================================================================
  // Private — In-Memory State Helpers
  // ===========================================================================

  private saveMessageToMemory(message: GroupMessageData): void {
    const groupId = message.groupId;
    if (!this.messages.has(groupId)) {
      this.messages.set(groupId, []);
    }
    const msgs = this.messages.get(groupId)!;
    const idx = msgs.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      msgs[idx] = message;
    } else {
      msgs.push(message);
      // Prune oldest messages beyond limit (keep 2x defaultMessageLimit for scroll-back)
      const maxMessages = this.config.defaultMessageLimit * 2;
      if (msgs.length > maxMessages) {
        msgs.splice(0, msgs.length - maxMessages);
      }
    }
  }

  private deleteMessageFromMemory(groupId: string, messageId: string): void {
    const msgs = this.messages.get(groupId);
    if (msgs) {
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx >= 0) msgs.splice(idx, 1);
    }
  }

  private saveMemberToMemory(member: GroupMemberData): void {
    const groupId = member.groupId;
    if (!this.members.has(groupId)) {
      this.members.set(groupId, []);
    }
    const mems = this.members.get(groupId)!;
    const idx = mems.findIndex((m) => m.pubkey === member.pubkey);
    if (idx >= 0) {
      mems[idx] = member;
    } else {
      mems.push(member);
    }
  }

  private removeMemberFromMemory(groupId: string, pubkey: string): void {
    const mems = this.members.get(groupId);
    if (mems) {
      const idx = mems.findIndex((m) => m.pubkey === pubkey);
      if (idx >= 0) mems.splice(idx, 1);
    }
    // Update member count
    const group = this.groups.get(groupId);
    if (group) {
      group.memberCount = (this.members.get(groupId) || []).length;
      this.groups.set(groupId, group);
    }
  }

  private removeGroupFromMemory(groupId: string): void {
    this.groups.delete(groupId);
    this.messages.delete(groupId);
    this.members.delete(groupId);
  }

  private updateGroupLastMessage(groupId: string, text: string, timestamp: number): void {
    const group = this.groups.get(groupId);
    if (group && timestamp >= (group.lastMessageTime || 0)) {
      group.lastMessageText = text;
      group.lastMessageTime = timestamp;
      this.groups.set(groupId, group);
    }
  }

  private updateMemberNametag(
    groupId: string,
    pubkey: string,
    nametag: string,
    joinedAt: number,
  ): void {
    const members = this.members.get(groupId) || [];
    const existing = members.find((m) => m.pubkey === pubkey);

    if (existing) {
      if (existing.nametag !== nametag) {
        existing.nametag = nametag;
        this.saveMemberToMemory(existing);
      }
    } else {
      this.saveMemberToMemory({
        pubkey,
        groupId,
        role: GroupRoleEnum.MEMBER,
        nametag,
        joinedAt,
      });
    }
  }

  private addProcessedEventId(eventId: string): void {
    this.processedEventIds.add(eventId);
    // Prune oldest half when limit exceeded — avoids rebuilding on every insert
    if (this.processedEventIds.size > 10000) {
      let toDelete = 5000;
      for (const id of this.processedEventIds) {
        if (toDelete-- <= 0) break;
        this.processedEventIds.delete(id);
      }
    }
  }

  // ===========================================================================
  // Private — Persistence
  // ===========================================================================

  /** Schedule a debounced persist (coalesces rapid event bursts). */
  private schedulePersist(): void {
    if (this.persistTimer) return; // Already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      // Chain onto the existing persistPromise so we can't race an
      // in-flight persist. Errors from prior persists are isolated
      // (.catch) so one failed attempt doesn't block subsequent ones;
      // errors from THIS persist get logged here.
      this.persistPromise = this.persistPromise
        .catch(() => { /* isolate prior failure */ })
        .then(() => this.doPersistAll())
        .catch((err) => {
          logger.error('GroupChat', 'Persistence error:', err);
        });
    }, 200);
  }

  /** Persist immediately (for explicit flush points).
   *
   *  Joins the persist chain like `schedulePersist` but returns a
   *  promise that resolves (or rejects) with THIS persist's outcome,
   *  so explicit-flush callers see real errors instead of the
   *  log-and-swallow treatment applied to the background chain. */
  private async persistAll(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // Build the chained persist. Prior-failure isolation on entry so a
    // broken background persist doesn't poison the explicit flush.
    const mine = this.persistPromise
      .catch(() => { /* isolate prior failure */ })
      .then(() => this.doPersistAll());
    // Advance the shared tail so the next scheduled/explicit persist
    // chains onto us. Swallow errors on the shared tail (they're
    // surfaced via `mine` to the direct caller).
    this.persistPromise = mine.catch(() => { /* isolated */ });
    await mine;
  }

  private async doPersistAll(): Promise<void> {
    await Promise.all([
      this.persistGroups(),
      this.persistMessages(),
      this.persistMembers(),
      this.persistProcessedEvents(),
    ]);
  }

  private async persistGroups(): Promise<void> {
    if (!this.deps) return;
    const data = Array.from(this.groups.values());
    const cidRefStore = this.deps.cidRefStore;

    if (cidRefStore) {
      const json = JSON.stringify(data);
      // Memo hit — identical plaintext reuses the cached ref instead of
      // re-pinning. For encrypted pins, re-pinning would produce a fresh
      // CID (random IV) even on unchanged plaintext — wasted IPFS churn.
      if (this._lastPinnedGroupsRef && this._lastPinnedGroupsJson === json) {
        await this.deps.storage.set(
          STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS,
          CidRefStore.stringifyRef(this._lastPinnedGroupsRef),
        );
        return;
      }
      // Groups list is per-wallet membership view — ENCRYPTED.
      const ref = await cidRefStore.pinJson(data);
      await this.deps.storage.set(
        STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS,
        CidRefStore.stringifyRef(ref),
      );
      this._lastPinnedGroupsJson = json;
      this._lastPinnedGroupsRef = ref;
      return;
    }

    // Legacy inline path.
    await this.deps.storage.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(data));
  }

  /**
   * Write messages partitioned by groupId. See GROUP_CHAT_MESSAGES_PREFIX
   * comment for the storage-layout rationale (PROFILE-CID-REFERENCES.md
   * §8.5). On each persist:
   *   1. Write a per-group key for every groupId currently in memory
   *      (via CID ref when cidRefStore is available, inline JSON otherwise).
   *   2. Delete per-group keys for groupIds that were written on a previous
   *      persist but are no longer present (e.g., after leave-group).
   *      Without this, orphaned blobs would leak indefinitely.
   *
   * **Encryption policy: PLAINTEXT PINS.** Group-chat messages transit
   * through the Nostr relay as plaintext (signed but unencrypted —
   * grep the module for `NIP17|giftWrap|encrypt|decrypt` to verify zero
   * hits). Per-wallet AES-GCM encryption on IPFS under that threat model
   * buys no real privacy and defeats content-addressed dedup (random
   * IV → 100 members produce 100 different CIDs for the same message).
   * Plaintext pins make one CID serve all members of a group.
   */
  private async persistMessages(): Promise<void> {
    if (!this.deps) return;
    const storage = this.deps.storage;
    const cidRefStore = this.deps.cidRefStore;

    const current = new Set<string>();
    for (const [groupId, msgs] of this.messages) {
      const key = GROUP_CHAT_MESSAGES_PREFIX + groupId;

      if (cidRefStore) {
        // Pattern B: pin each message individually, build an index of
        // {id, ts, cid, size}, pin the index, write its ref. The dedup
        // unit is the individual message — Alice's [m1,m2,m3] and
        // Bob's [m1,m3,m2] share message CIDs even though the array
        // orders differ.
        //
        // Messages without an `id` (transient optimistic state, should
        // not exist in this.messages but the type permits undefined)
        // are skipped — they'll persist next round once they get an id.
        const indexItems: GroupChatMessagesIndexItem[] = [];
        for (const m of msgs) {
          if (!m.id) continue;
          const messageJson = JSON.stringify(m);
          let cachedPin = this._pinnedMessageCids.get(messageJson);
          if (!cachedPin) {
            const ref = await cidRefStore.pinJson(m, { encrypted: false });
            cachedPin = { cid: ref.cid, size: ref.size };
            this._pinnedMessageCids.set(messageJson, cachedPin);
          }
          indexItems.push({
            id: m.id,
            ts: m.timestamp,
            cid: cachedPin.cid,
            size: cachedPin.size,
          });
        }
        const index: GroupChatMessagesIndex = {
          v: GROUP_CHAT_MESSAGES_INDEX_V,
          items: indexItems,
        };
        const indexJson = JSON.stringify(index);

        // Per-group index-ref memo — same plaintext → same CID, so
        // unchanged state reuses the ref without a pin round-trip.
        const cached = this._lastPinnedMessagesByGroup.get(groupId);
        if (cached && cached.json === indexJson) {
          await storage.set(key, CidRefStore.stringifyRef(cached.ref));
        } else {
          const indexRef = await cidRefStore.pinJson(index, { encrypted: false });
          await storage.set(key, CidRefStore.stringifyRef(indexRef));
          this._lastPinnedMessagesByGroup.set(groupId, { json: indexJson, ref: indexRef });
        }
      } else {
        // Legacy inline fallback when no cidRefStore is available —
        // unchanged from pre-Pattern-B behaviour.
        await storage.set(key, JSON.stringify(msgs));
      }
      current.add(groupId);
    }
    // Orphan cleanup — groups dropped since the last persist.
    for (const oldId of this._lastWrittenMessageGroupIds) {
      if (!current.has(oldId)) {
        await storage.remove(GROUP_CHAT_MESSAGES_PREFIX + oldId);
        // Evict the orphan's memo so a future rejoin forces a fresh pin.
        // The per-message CID cache is shared across groups and is not
        // invalidated by single-group eviction — identical messages in
        // a later group rejoin dedup correctly. (Cache-level GC is the
        // Phase-2 pin-ledger workstream's concern.)
        this._lastPinnedMessagesByGroup.delete(oldId);
      }
    }
    this._lastWrittenMessageGroupIds = current;
  }

  /**
   * Write members partitioned by groupId. Encryption policy: ENCRYPTED
   * (per-wallet). Member lists are this wallet's view of group membership
   * at a point in time and don't share the "all members see identical
   * content verbatim" property of messages — dedup wouldn't help. Apply
   * the default wallet-key AES-GCM encryption for consistency with every
   * other CID-refs migration in the suite.
   */
  private async persistMembers(): Promise<void> {
    if (!this.deps) return;
    const storage = this.deps.storage;
    const cidRefStore = this.deps.cidRefStore;

    const current = new Set<string>();
    for (const [groupId, mems] of this.members) {
      const key = GROUP_CHAT_MEMBERS_PREFIX + groupId;

      if (cidRefStore) {
        const json = JSON.stringify(mems);
        const cached = this._lastPinnedMembersByGroup.get(groupId);
        if (cached && cached.json === json) {
          await storage.set(key, CidRefStore.stringifyRef(cached.ref));
        } else {
          // Encrypted (default — omit the `encrypted` option).
          const ref = await cidRefStore.pinJson(mems);
          await storage.set(key, CidRefStore.stringifyRef(ref));
          this._lastPinnedMembersByGroup.set(groupId, { json, ref });
        }
      } else {
        await storage.set(key, JSON.stringify(mems));
      }
      current.add(groupId);
    }
    for (const oldId of this._lastWrittenMemberGroupIds) {
      if (!current.has(oldId)) {
        await storage.remove(GROUP_CHAT_MEMBERS_PREFIX + oldId);
        this._lastPinnedMembersByGroup.delete(oldId);
      }
    }
    this._lastWrittenMemberGroupIds = current;
  }

  /**
   * Persist the NIP-29 event ID dedup ledger. The ledger grows
   * unbounded with relay activity — observed 263 KB on routine sphere.telco
   * use, which was the second-worst PAYLOAD-SIZE soft-warn after
   * `groupChatMembers` (issue #285).
   *
   * Encryption policy: ENCRYPTED. The ledger is a per-wallet privacy
   * footprint (it reveals which NIP-29 events this wallet has
   * processed — including private/invite-only groups). Dedup across
   * wallets is not a goal; the canonical-content-addressed property
   * of plaintext pins would actively leak group-membership signal to
   * any IPFS observer.
   */
  private async persistProcessedEvents(): Promise<void> {
    if (!this.deps) return;
    const arr = Array.from(this.processedEventIds);
    const cidRefStore = this.deps.cidRefStore;

    if (cidRefStore) {
      const json = JSON.stringify(arr);
      // Memo: identical plaintext (no new processed event since last
      // persist) reuses the previous ref. AES-GCM uses random IVs so
      // re-pinning would produce a fresh CID — wasted IPFS churn.
      if (
        this._lastPinnedProcessedEventsRef &&
        this._lastPinnedProcessedEventsJson === json
      ) {
        await this.deps.storage.set(
          STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS,
          CidRefStore.stringifyRef(this._lastPinnedProcessedEventsRef),
        );
        return;
      }
      const ref = await cidRefStore.pinJson(arr);
      await this.deps.storage.set(
        STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS,
        CidRefStore.stringifyRef(ref),
      );
      // Update memo AFTER storage.set lands so a failed set does not
      // leave us pointing at a CID the caller thinks is live.
      this._lastPinnedProcessedEventsJson = json;
      this._lastPinnedProcessedEventsRef = ref;
      return;
    }

    // Legacy inline fallback when no cidRefStore is available.
    await this.deps.storage.set(
      STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS,
      JSON.stringify(arr),
    );
  }

  // ===========================================================================
  // Private — Relay URL Change Detection
  // ===========================================================================

  private async checkAndClearOnRelayChange(currentRelayUrl: string): Promise<void> {
    if (!this.deps) return;

    const stored = await this.deps.storage.get(STORAGE_KEYS_GLOBAL.GROUP_CHAT_RELAY_URL);

    if (stored && stored !== currentRelayUrl) {
      // Relay changed — clear stale data
      this.groups.clear();
      this.messages.clear();
      this.members.clear();
      this.processedEventIds.clear();
      await this.persistAll();
    }

    // Also check if stored groups have different relay URL
    if (!stored) {
      for (const group of this.groups.values()) {
        if (group.relayUrl && group.relayUrl !== currentRelayUrl) {
          this.groups.clear();
          this.messages.clear();
          this.members.clear();
          this.processedEventIds.clear();
          await this.persistAll();
          break;
        }
      }
    }

    await this.deps.storage.set(STORAGE_KEYS_GLOBAL.GROUP_CHAT_RELAY_URL, currentRelayUrl);
  }

  // ===========================================================================
  // Private — Message Content Wrapping
  // ===========================================================================

  private wrapMessageContent(content: string, senderNametag: string | null): string {
    if (senderNametag) {
      return JSON.stringify({ senderNametag, text: content });
    }
    return content;
  }

  private unwrapMessageContent(content: string): { text: string; senderNametag: string | null } {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed.text !== undefined) {
        return { text: parsed.text, senderNametag: parsed.senderNametag || null };
      }
    } catch {
      // Not JSON
    }
    return { text: content, senderNametag: null };
  }

  // ===========================================================================
  // Private — Event Tag Helpers
  // ===========================================================================

  private getGroupIdFromEvent(event: Event): string | null {
    const hTag = event.tags.find((t: string[]) => t[0] === 'h');
    return hTag ? hTag[1] : null;
  }

  private getGroupIdFromMetadataEvent(event: Event): string | null {
    const dTag = event.tags.find((t: string[]) => t[0] === 'd');
    if (dTag?.[1]) return dTag[1];
    const hTag = event.tags.find((t: string[]) => t[0] === 'h');
    return hTag?.[1] ?? null;
  }

  private extractReplyTo(event: Event): string | undefined {
    const eTag = event.tags.find((t: string[]) => t[0] === 'e' && t[3] === 'reply');
    return eTag ? eTag[1] : undefined;
  }

  private extractPreviousIds(event: Event): string[] | undefined {
    const previousTag = event.tags.find((t: string[]) => t[0] === 'previous');
    return previousTag ? previousTag.slice(1) : undefined;
  }

  private parseGroupMetadata(event: Event): GroupData | null {
    try {
      const groupId = this.getGroupIdFromMetadataEvent(event);
      if (!groupId) return null;

      let name = 'Unnamed Group';
      let description: string | undefined;
      let picture: string | undefined;
      let memberCount: number | undefined;
      let isPrivate = false;
      let writeRestricted = false;

      if (event.content && event.content.trim()) {
        try {
          const metadata = JSON.parse(event.content);
          name = metadata.name || name;
          description = metadata.about || metadata.description;
          picture = metadata.picture;
          isPrivate = metadata.private === true;
          if (metadata['write-restricted'] === true) writeRestricted = true;
        } catch {
          // Not JSON, check tags
        }
      }

      for (const tag of event.tags) {
        if (tag[0] === 'name' && tag[1]) name = tag[1];
        if (tag[0] === 'about' && tag[1]) description = tag[1];
        if (tag[0] === 'picture' && tag[1]) picture = tag[1];
        if (tag[0] === 'private') isPrivate = true;
        if (tag[0] === 'public' && tag[1] === 'false') isPrivate = true;
        if (tag[0] === 'write-restricted') writeRestricted = true;
        if (tag[0] === 'member_count' && tag[1]) memberCount = parseInt(tag[1], 10) || undefined;
      }

      return {
        id: groupId,
        relayUrl: this.config.relays[0] || '',
        name,
        description,
        picture,
        memberCount,
        visibility: isPrivate ? GroupVisibilityEnum.PRIVATE : GroupVisibilityEnum.PUBLIC,
        writeRestricted: writeRestricted || undefined,
        createdAt: event.created_at * 1000,
      };
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // Private — Utility
  // ===========================================================================

  /** Subscribe and track the subscription ID for cleanup. */
  private trackSubscription(filter: Filter, handlers: { onEvent: (event: Event) => void; onEndOfStoredEvents?: () => void }): string {
    const subId = this.client!.subscribe(filter, {
      onEvent: handlers.onEvent,
      onEndOfStoredEvents: handlers.onEndOfStoredEvents ?? (() => {}),
    });
    this.subscriptionIds.push(subId);
    return subId;
  }

  /** Subscribe for a one-shot fetch, auto-unsubscribe on EOSE or timeout. */
  private oneshotSubscription<T>(
    filter: Filter,
    opts: {
      onEvent: (event: Event) => void;
      onComplete: () => T;
      timeoutMs?: number;
      timeoutLabel?: string;
    },
  ): Promise<T> {
    return new Promise((resolve) => {
      let done = false;
      const state: { subId?: string } = {};

      const finish = () => {
        if (done) return;
        done = true;
        if (state.subId) {
          try { this.client!.unsubscribe(state.subId); } catch (err) { logger.debug('GroupChat', 'Failed to unsubscribe', err); }
          const idx = this.subscriptionIds.indexOf(state.subId);
          if (idx >= 0) this.subscriptionIds.splice(idx, 1);
        }
        resolve(opts.onComplete());
      };

      const subId = this.client!.subscribe(filter, {
        onEvent: (event: Event) => { if (!done) opts.onEvent(event); },
        onEndOfStoredEvents: finish,
      });
      state.subId = subId;
      this.subscriptionIds.push(subId);

      setTimeout(() => {
        if (!done && opts.timeoutLabel) {
          logger.warn('GroupChat', `${opts.timeoutLabel} timed out`);
        }
        finish();
      }, opts.timeoutMs ?? 5000);
    });
  }

  private ensureInitialized(): void {
    if (!this.deps) {
      throw new SphereError('GroupChatModule not initialized', 'NOT_INITIALIZED');
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private randomId(): string {
    const bytes = new Uint8Array(8);
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createGroupChatModule(config?: GroupChatModuleConfig): GroupChatModule {
  return new GroupChatModule(config);
}
