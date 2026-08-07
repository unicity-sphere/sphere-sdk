/**
 * Shared payments-v2 unit-test doubles (PR sweep: eight hand-rolled ScopedKVs,
 * two FakeSessions, three deferreds, … collapsed here). Plumbing only — the
 * assertions stay in the suites.
 */

import type { FacadeSession } from '../../../modules/payments-v2/PaymentsFacade';
import type { CheckpointReseeder } from '../../../modules/payments-v2/compose';
import type { RegistryReader } from '../../../modules/payments-v2/inventory/InventoryView';
import type { RequestMemoCodec } from '../../../modules/payments-v2/requests/Requests';
import type { ScopedKV } from '../../../modules/payments-v2/stores';
import type { SplitCheckpointStore } from '../../../token-engine';

export interface MemoryKV extends ScopedKV {
  /** Backing store (values are JSON clones, readable directly in assertions). */
  readonly map: Map<string, unknown>;
  /** Write log: one JSON-cloned `{ key, value }` per set(). */
  readonly sets: { key: string; value: unknown }[];
  /** Fault injection: get() of any of these keys throws. */
  readonly failKeys: Set<string>;
}

/** In-memory ScopedKV: JSON round-trips both writes and reads (storage fidelity). */
export function memoryKV(opts: { seed?: Record<string, unknown>; failKeys?: string[] } = {}): MemoryKV {
  const map = new Map<string, unknown>(Object.entries(opts.seed ?? {}));
  const sets: { key: string; value: unknown }[] = [];
  const failKeys = new Set<string>(opts.failKeys ?? []);
  return {
    map,
    sets,
    failKeys,
    async get<T>(key: string): Promise<T | null> {
      if (failKeys.has(key)) throw new Error(`injected kv read failure: ${key}`);
      if (!map.has(key)) return null;
      return JSON.parse(JSON.stringify(map.get(key))) as T;
    },
    async set<T>(key: string, value: T): Promise<void> {
      const cloned = JSON.parse(JSON.stringify(value)) as unknown;
      sets.push({ key, value: cloned });
      map.set(key, cloned);
    },
    async remove(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

/** Insert-once slot map with first-write-wins reads (the E.4 store contract). */
export function memoryCheckpoints(): SplitCheckpointStore & CheckpointReseeder {
  const slots = new Map<string, Uint8Array>();
  return {
    async put(transferId, opIndex, bytes) {
      const key = `${transferId}:${String(opIndex)}`;
      const existing = slots.get(key);
      if (existing !== undefined) return existing;
      slots.set(key, Uint8Array.from(bytes));
      return bytes;
    },
    async get(transferId, opIndex) {
      return slots.get(`${transferId}:${String(opIndex)}`) ?? null;
    },
    // The in-memory store IS the slot table — it holds no separate ciphertext
    // cache to re-POST, so a reseed honestly reports "nothing cached".
    async reseedCheckpoint() {
      return false;
    },
  };
}

export class FakeSession implements FacadeSession {
  private readonly handlers = new Map<string, Set<() => void>>();
  private readonly statusHandlers = new Set<(status: 'connected' | 'degraded' | 'offline') => void>();
  private readonly epochHandlers = new Set<(epoch: string) => Promise<void>>();
  epoch = '1';
  startCalls = 0;
  stopCalls = 0;
  async start(): Promise<void> {
    this.startCalls += 1;
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
  subscribeStream(stream: 'inventory' | 'mailbox' | 'payment_requests', handler: () => void): () => void {
    let set = this.handlers.get(stream);
    if (!set) {
      set = new Set();
      this.handlers.set(stream, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }
  currentEpoch(): string {
    return this.epoch;
  }
  subscribeEpochChange(handler: (epoch: string) => Promise<void>): () => void {
    this.epochHandlers.add(handler);
    return () => this.epochHandlers.delete(handler);
  }
  subscribeStatus(handler: (status: 'connected' | 'degraded' | 'offline') => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }
  fire(stream: string): void {
    for (const handler of this.handlers.get(stream) ?? []) handler();
  }
  /** Test driver mirroring WalletApiSession.noteEpoch: restore hooks AWAITED, then every stream nudged. */
  async noteEpoch(epoch: string): Promise<void> {
    if (this.epoch === epoch) return;
    this.epoch = epoch;
    for (const handler of [...this.epochHandlers]) await handler(epoch);
    for (const stream of ['inventory', 'mailbox', 'payment_requests']) this.fire(stream);
  }
  /** Test hook: push a connection-status transition to subscribers. */
  setStatus(status: 'connected' | 'degraded' | 'offline'): void {
    for (const handler of this.statusHandlers) handler(status);
  }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let hexCounter = 0;
/** Fresh 64-hex id per call (process-unique, deterministic order). */
export function freshHex(): string {
  hexCounter += 1;
  return hexCounter.toString(16).padStart(8, '0').repeat(8);
}

export function registryStub(overrides: Partial<RegistryReader> = {}): RegistryReader {
  return {
    getSymbol: () => 'TST',
    getName: () => 'Test Coin',
    getDecimals: () => 0,
    getIconUrl: () => null,
    ...overrides,
  };
}

/** Symmetric stand-in for the ECDH bundle codec (crypto is not under test). */
export const stubRequestMemoCodec: RequestMemoCodec = {
  encrypt: (_peer, bundle) =>
    bundle.memo === undefined && bundle.senderNametag === undefined ? undefined : `x.${JSON.stringify(bundle)}`,
  decrypt: (_peer, envelope) => {
    if (!envelope.startsWith('x.')) throw new Error('not addressed here');
    return JSON.parse(envelope.slice(2)) as { memo?: string; senderNametag?: string };
  },
};
