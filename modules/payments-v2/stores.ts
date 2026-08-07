// The complete §6 durable-state inventory. One writer per store.

import type { StorageProvider } from '../../storage';

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
  const prefix = `pv2:${network}:${chainPubkey}:`;
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
