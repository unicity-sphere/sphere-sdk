/**
 * Shared fixtures + helpers for T.5.B.5 cascade-walker tests.
 *
 * Each acceptance test (cascade-walker-coin, cascade-walker-nft,
 * cascade-walker-race-lost-no-fire, cascade-walker-cycle-defense,
 * §6.1.1-cascade-parent-flip, cascade-visited-set-scope) imports from
 * here.
 */

import {
  CascadeWalker,
  type CascadeManifestScanner,
  type CascadeOutboxScanner,
  type CascadeWalkerOptions,
  type CascadeCycleWarning,
  type CascadeScannerError,
  type ClassifyTokenLookup,
} from '../../../../extensions/uxf/pipeline/cascade-walker';
import {
  ManifestCas,
  type MinimalManifestStorage,
} from '../../../../extensions/uxf/profile/manifest-cas';
import { contentHash } from '../../../../extensions/uxf/bundle/types';
import type { ContentHash } from '../../../../extensions/uxf/bundle/types';
import type { TokenManifestEntry } from '../../../../extensions/uxf/profile/token-manifest';
import type { SphereEventMap, SphereEventType } from '../../../../types';
import type { UxfTransferOutboxEntry } from '../../../../types/uxf-outbox';

export const ADDR = 'DIRECT://addr-A';

export interface RecordedEvent {
  readonly type: SphereEventType;
  readonly data: unknown;
}

export interface EventRecorder {
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  readonly events: ReadonlyArray<RecordedEvent>;
  readonly clear: () => void;
}

export function makeEventRecorder(): EventRecorder {
  const events: RecordedEvent[] = [];
  return {
    events,
    emit: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
      events.push({ type, data });
    },
    clear: () => {
      events.length = 0;
    },
  };
}

/**
 * In-memory MinimalManifestStorage backed by a plain Map. Tests load it
 * via {@link makeFakeManifestStorage} with a list of `(addr, tokenId,
 * entry)` triples.
 */
export interface FakeManifestStorage extends MinimalManifestStorage {
  readonly entries: Map<string, TokenManifestEntry>;
  /** Force-set an entry (no CAS). Used by parent-flip tests. */
  readonly forceSet: (
    addr: string,
    tokenId: string,
    entry: TokenManifestEntry,
  ) => void;
  /** Optional write-tap: invoked AFTER each writeEntry. Tests use this
   *  to deterministically interleave a parent-flip mid-cascade. */
  writeTap?: (addr: string, tokenId: string, entry: TokenManifestEntry) => void;
}

export function makeFakeManifestStorage(
  initial: ReadonlyArray<{
    addr: string;
    tokenId: string;
    entry: TokenManifestEntry;
  }> = [],
): FakeManifestStorage {
  const entries = new Map<string, TokenManifestEntry>();
  for (const e of initial) {
    entries.set(`${e.addr}:${e.tokenId}`, e.entry);
  }
  const storage: FakeManifestStorage = {
    entries,
    writeTap: undefined,
    forceSet: (addr, tokenId, entry) => {
      entries.set(`${addr}:${tokenId}`, entry);
    },
    async readEntry(addr, tokenId) {
      return entries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr, tokenId, entry) {
      entries.set(`${addr}:${tokenId}`, entry);
      if (storage.writeTap !== undefined) {
        storage.writeTap(addr, tokenId, entry);
      }
    },
  };
  return storage;
}

/**
 * Build a manifest scanner over a {@link FakeManifestStorage}. The
 * `findChildren` implementation does a full-scan for entries with
 * matching `splitParent` — production wires a secondary index, but a
 * full-scan is sufficient for correctness in unit tests.
 */
export function makeFakeManifestScanner(
  storage: FakeManifestStorage,
): CascadeManifestScanner {
  return {
    async readEntry(addr, tokenId) {
      return storage.readEntry(addr, tokenId);
    },
    async findChildren(addr, parentTokenId) {
      // No self-defense filter here — the cascade walker MUST defend
      // itself via the visited-set per §6.1.1 cycle defense. A
      // corrupted manifest could carry `splitParent: tokenId === self`,
      // and the walker MUST handle it.
      const out: string[] = [];
      const prefix = `${addr}:`;
      for (const [key, entry] of storage.entries.entries()) {
        if (!key.startsWith(prefix)) continue;
        if (entry.splitParent !== parentTokenId) continue;
        const tokenId = key.substring(prefix.length);
        out.push(tokenId);
      }
      return out;
    },
  };
}

/**
 * Outbox scanner over an in-memory list of UxfTransferOutboxEntry. The
 * `findEntriesByTokenId` implementation linear-scans the list; tests
 * inject the entries they need.
 */
export interface FakeOutboxScanner extends CascadeOutboxScanner {
  readonly entries: UxfTransferOutboxEntry[];
}

export function makeFakeOutboxScanner(
  initial: ReadonlyArray<UxfTransferOutboxEntry> = [],
): FakeOutboxScanner {
  const entries: UxfTransferOutboxEntry[] = [...initial];
  return {
    entries,
    async findEntriesByTokenId(tokenId) {
      return entries.filter((e) => e.tokenIds.includes(tokenId));
    },
  };
}

/**
 * Default classify lookup: derives class from a per-test fixture map
 * keyed by tokenId. Tests build the map up-front; the lookup returns
 * `null` for unknown ids (cascade walker treats this as no-op).
 */
export function makeFakeClassifyLookup(
  classes: Record<string, 'coin' | 'nft'>,
): ClassifyTokenLookup {
  return async (_addr, tokenId) => classes[tokenId] ?? null;
}

/** Build a TokenManifestEntry for tests with optional overrides. */
export function makeManifestEntry(
  overrides: Partial<TokenManifestEntry> & { rootHashHex?: string } = {},
): TokenManifestEntry {
  const root: ContentHash =
    overrides.rootHashHex !== undefined
      ? contentHash(overrides.rootHashHex)
      : (overrides.rootHash ?? contentHash('aa'.repeat(32)));
  // Drop our helper-only field so the spread doesn't carry it onto the
  // canonical entry.
  const { rootHashHex: _omit, ...rest } = overrides;
  void _omit;
  return {
    status: 'valid',
    ...rest,
    rootHash: root,
  };
}

/** Build a default UxfTransferOutboxEntry for tests with overrides. */
export function makeOutboxEntry(
  overrides: Partial<UxfTransferOutboxEntry> & { tokenIds?: string[] } = {},
): UxfTransferOutboxEntry {
  return {
    _schemaVersion: 'uxf-1',
    id: overrides.id ?? `outbox-${Math.random().toString(36).slice(2, 10)}`,
    bundleCid: 'bafy-bundle',
    tokenIds: overrides.tokenIds ?? ['token-x'],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'recipient-pk',
    mode: 'instant',
    status: 'delivered-instant',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    lamport: 1,
    ...overrides,
  };
}

export interface WalkerHarness {
  readonly walker: CascadeWalker;
  readonly events: EventRecorder;
  readonly storage: FakeManifestStorage;
  readonly scanner: CascadeManifestScanner;
  readonly outbox: FakeOutboxScanner;
  readonly cycleWarnings: CascadeCycleWarning[];
  readonly scannerErrors: CascadeScannerError[];
}

export function buildWalker(args: {
  readonly storage?: FakeManifestStorage;
  readonly outbox?: FakeOutboxScanner;
  readonly classes?: Record<string, 'coin' | 'nft'>;
  readonly classifyToken?: ClassifyTokenLookup;
  readonly maxDepth?: number;
  /**
   * Optional override of the manifest scanner. When provided, it
   * REPLACES the default `makeFakeManifestScanner(storage)` — useful
   * for tests that need `findChildren` to throw deterministically.
   */
  readonly manifestScanner?: CascadeManifestScanner;
  /**
   * Optional override of the outbox scanner. When provided, REPLACES
   * the default in-memory fake — useful for tests that need
   * `findEntriesByTokenId` to throw deterministically.
   */
  readonly outboxScanner?: CascadeOutboxScanner;
} = {}): WalkerHarness {
  const storage = args.storage ?? makeFakeManifestStorage();
  const defaultScanner = makeFakeManifestScanner(storage);
  const scanner = args.manifestScanner ?? defaultScanner;
  const outbox = args.outbox ?? makeFakeOutboxScanner();
  const outboxScanner = args.outboxScanner ?? outbox;
  const events = makeEventRecorder();
  const cycleWarnings: CascadeCycleWarning[] = [];
  const scannerErrors: CascadeScannerError[] = [];
  const manifestCas = new ManifestCas(storage);
  const classifyTokenLookup =
    args.classifyToken ?? makeFakeClassifyLookup(args.classes ?? {});

  const opts: CascadeWalkerOptions = {
    manifestScanner: scanner,
    manifestCas,
    outboxScanner,
    classifyToken: classifyTokenLookup,
    emit: events.emit,
    onCycleDetected: (w) => cycleWarnings.push(w),
    onScannerError: (e) => scannerErrors.push(e),
    maxDepth: args.maxDepth,
  };
  const walker = new CascadeWalker(opts);

  return { walker, events, storage, scanner, outbox, cycleWarnings, scannerErrors };
}

export {
  CascadeWalker,
  type CascadeWalkerOptions,
  type CascadeManifestScanner,
  type CascadeOutboxScanner,
  type CascadeCycleWarning,
  type CascadeScannerError,
  type ClassifyTokenLookup,
};
