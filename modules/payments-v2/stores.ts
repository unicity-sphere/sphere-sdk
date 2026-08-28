// The complete §6 durable-state inventory. One writer per store.

import { logger } from '../../core/logger';
import type { StorageProvider } from '../../storage';

/** Generation 2 of the durable client state; renaming IS the 3.x migration
 *  (kv-generation.test.ts). Must not START with a superseded prefix — the sweep
 *  below matches by `startsWith`. */
const KV_PREFIX = 'pv2g2:';

const SUPERSEDED_KV_PREFIXES = ['pv2:'] as const;

/** Never `storage.clear()` — that takes the keys too. */
export async function sweepSupersededState(storage: StorageProvider): Promise<void> {
  for (const prefix of SUPERSEDED_KV_PREFIXES) {
    try {
      await storage.clear(prefix);
    } catch (err) {
      logger.warn('PaymentsV2', `could not clear superseded state under "${prefix}": ${String(err)}`);
    }
  }
}

export interface ScopedKV {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createScopedKV(
  storage: StorageProvider,
  network: string,
  chainPubkey: string
): ScopedKV {
  const prefix = `${KV_PREFIX}${network}:${chainPubkey}:`;
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = await storage.get(prefix + key);
      if (raw === null || raw === undefined) return null;
      return typeof raw === 'string' ? (JSON.parse(raw) as T) : (raw as T);
    },
    async set<T>(key: string, value: T): Promise<void> {
      await storage.set(prefix + key, JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      await storage.remove(prefix + key);
    },
  };
}


export interface IntentBackstopEntry {
  transferId: string;
  payloadEnvelope: string;
  requiresSeedClose: boolean;
  // #676: a locally-aborted intent is NEVER resumed.
  disposition: 'open' | 'abortPending' | 'aborted';
  createdAt: number;
}


// #621 delivery journal.
export interface DeliveryJournalEntry {
  transferId: string;
  opIndex: number;
  recipientPubkey: string;
  blobHex: string;
  memo?: string;
  // Poison budget (#517); 429 deferrals do NOT count.
  attempts: number;
  deferredUntil?: number;
  undeliverable?: boolean;
}

// §5.9 mint journal.
export interface MintJournalEntry {
  mintId: string;
  coinId: string;
  amount: string;
  tokenId: string;
  createdAt: number;
}

// #690 shortfall record.
export interface ShortfallEntry {
  transferId: string;
  remainingAmount: string;
  coinId: string;
  recipient: string;
  // Already delivered — NEVER re-send these sources.
  committedTokenIds: string[];
  createdAt: number;
}

// #441 settling link.
export interface SettlingLink {
  requestId: string;
  transferId: string;
  committed: boolean;
  createdAt: number;
}

export type StreamName = 'inventory' | 'mailbox' | 'payment_requests' | 'history';

// Cursor+epoch persist as ONE record — never two keys (#692 F10).
export interface StreamCursor {
  cursor: number | string;
  syncEpoch: string;
}

export const STORE_KEYS = {
  intentBackstop: 'intents',
  checkpointCache: 'checkpoints',
  deliveryJournal: 'delivery-journal',
  mintJournal: 'mint-journal',
  shortfalls: 'shortfalls',
  settlingLinks: 'settling',
  streamCursor: (s: StreamName) => `cursor:${s}`,
  epochLatch: 'epoch-latch',
  // §5.2 InventoryView durable overlays (#625/#679).
  suspectedSpent: 'suspected-spent',
  knownSpends: 'known-spends',
} as const;
