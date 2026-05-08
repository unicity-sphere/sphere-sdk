/**
 * Shared fixtures for T.5.D `importInclusionProof()` + `revalidateCascadedChildren()`
 * acceptance tests.
 *
 * Exports:
 *   - {@link buildImporterHarness}        — wires an in-memory
 *     {@link InclusionProofImporter} with deterministic recorders.
 *   - {@link buildRevalidatorHarness}     — wires an in-memory
 *     {@link RevalidateCascadedRunner} with a deterministic verdict map.
 *   - per-fixture builders: `manifestEntryFor`, `queueEntryFor`,
 *     `invalidEntryFor`, `proofFor`.
 */

import {
  InclusionProofImporter,
  type ImportInclusionProofOptions,
  type ImportProofGraftCallback,
  type ImportProofOverrideCallback,
  type ImportProofQueueEntry,
  type ImportProofQueueScanner,
  type ImportableInclusionProof,
  type ProofVerifier,
} from '../../../../modules/payments/transfer/import-inclusion-proof';
import { PerTokenMutex } from '../../../../profile/per-token-mutex';
import type { PerTokenMutexStrategy } from '../../../../profile/per-token-mutex';
import {
  RevalidateCascadedRunner,
  type ChildRevalidationVerdict,
  type ChildRevalidator,
  type RevalidateCascadedOptions,
  type RevalidationCycleWarning,
  type RevalidationScannerError,
} from '../../../../modules/payments/transfer/revalidate-cascaded';
import { ManifestStore } from '../../../../profile/manifest-store';
import { ManifestCas } from '../../../../profile/manifest-cas';
import { Lamport } from '../../../../profile/lamport';
import { contentHash } from '../../../../uxf/types';
import type { ContentHash } from '../../../../uxf/types';
import type { TokenManifestEntry } from '../../../../profile/token-manifest';
import type {
  CascadeManifestScanner,
} from '../../../../modules/payments/transfer/cascade-walker';
import type { ProofVerifyStatus } from '../../../../modules/payments/transfer/proof-verifier';
import type {
  AuditEntry,
  DispositionReason,
  InvalidEntry,
} from '../../../../types/disposition';
import type { DispositionPerEntryStorage } from '../../../../profile/disposition-writer';
import type {
  SphereEventMap,
  SphereEventType,
} from '../../../../types';

export const ADDR = 'DIRECT://addr-A';
export const ADDR_ALT = 'DIRECT://addr-B';

// =============================================================================
// Manifest fake — minimal shape compatible with ManifestCas / ManifestStore.
// =============================================================================

export interface FakeManifestStorage {
  readonly entries: Map<string, TokenManifestEntry>;
  readEntry(addr: string, tokenId: string): Promise<TokenManifestEntry | undefined>;
  writeEntry(addr: string, tokenId: string, entry: TokenManifestEntry): Promise<void>;
}

export function makeFakeManifestStorage(
  initial: ReadonlyArray<{
    addr: string;
    tokenId: string;
    entry: TokenManifestEntry;
  }> = [],
): FakeManifestStorage {
  const entries = new Map<string, TokenManifestEntry>();
  for (const i of initial) {
    entries.set(`${i.addr}:${i.tokenId}`, i.entry);
  }
  return {
    entries,
    async readEntry(addr, tokenId) {
      return entries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr, tokenId, entry) {
      entries.set(`${addr}:${tokenId}`, entry);
    },
  };
}

export function makeManifestScanner(
  storage: FakeManifestStorage,
): CascadeManifestScanner {
  return {
    async readEntry(addr, tokenId) {
      return storage.readEntry(addr, tokenId);
    },
    async findChildren(addr, parentTokenId) {
      const out: string[] = [];
      const prefix = `${addr}:`;
      for (const [key, entry] of storage.entries.entries()) {
        if (!key.startsWith(prefix)) continue;
        if (entry.splitParent !== parentTokenId) continue;
        out.push(key.substring(prefix.length));
      }
      return out;
    },
  };
}

// =============================================================================
// Disposition fake — in-memory key-value backing _invalid / _audit records.
// =============================================================================

export interface FakeDispositionStorage extends DispositionPerEntryStorage {
  readonly entries: Map<string, unknown>;
}

export function makeFakeDispositionStorage(): FakeDispositionStorage {
  const entries = new Map<string, unknown>();
  return {
    entries,
    async readRecord<T>(key: string): Promise<T | undefined> {
      const v = entries.get(key);
      return v === undefined ? undefined : (v as T);
    },
    async writeRecord<T>(key: string, value: T): Promise<void> {
      entries.set(key, value);
    },
    async listKeysWithPrefix(keyPrefix: string): Promise<ReadonlyArray<string>> {
      const out: string[] = [];
      for (const k of entries.keys()) {
        if (k.startsWith(keyPrefix)) out.push(k);
      }
      return out;
    },
  };
}

// =============================================================================
// Queue scanner fake — in-memory list with linear filter.
// =============================================================================

export interface FakeQueueScanner extends ImportProofQueueScanner {
  readonly entries: ImportProofQueueEntry[];
}

export function makeFakeQueueScanner(): FakeQueueScanner {
  const entries: ImportProofQueueEntry[] = [];
  return {
    entries,
    async lookupByTokenId(addr, tokenId) {
      void addr; // keyed by addr in production; tests use a single addr at a time
      return entries.filter((e) => e.tokenId === tokenId);
    },
  };
}

// =============================================================================
// Event recorder.
// =============================================================================

export interface RecordedEvent {
  readonly type: SphereEventType;
  readonly data: unknown;
}

export interface EventRecorder {
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  readonly events: RecordedEvent[];
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

// =============================================================================
// Graft + override recorders.
// =============================================================================

export interface GraftCallRecord {
  readonly addr: string;
  readonly tokenId: string;
  readonly proof: ImportableInclusionProof;
  readonly queueEntry: ImportProofQueueEntry;
}

export interface OverrideCallRecord {
  readonly addr: string;
  readonly tokenId: string;
  readonly transition: 'invalid→valid' | 'invalid→pending';
  readonly previousReason: DispositionReason;
  readonly previousInvalidEntry: InvalidEntry;
  readonly proof: ImportableInclusionProof;
  readonly resolvingQueueEntry: ImportProofQueueEntry;
  readonly requeueEntries: ReadonlyArray<ImportProofQueueEntry>;
  readonly now: number;
  readonly operatorPubkey?: string;
}

export function makeRecorders(): {
  graftCalls: GraftCallRecord[];
  overrideCalls: OverrideCallRecord[];
  graftCallback: ImportProofGraftCallback;
  overrideCallback: ImportProofOverrideCallback;
} {
  const graftCalls: GraftCallRecord[] = [];
  const overrideCalls: OverrideCallRecord[] = [];
  const graftCallback: ImportProofGraftCallback = {
    async graft(addr, tokenId, proof, queueEntry) {
      graftCalls.push({ addr, tokenId, proof, queueEntry });
    },
  };
  const overrideCallback: ImportProofOverrideCallback = {
    async applyOverride(args) {
      overrideCalls.push({
        addr: args.addr,
        tokenId: args.tokenId,
        transition: args.transition,
        previousReason: args.previousReason,
        previousInvalidEntry: args.previousInvalidEntry,
        proof: args.proof,
        resolvingQueueEntry: args.resolvingQueueEntry,
        requeueEntries: args.requeueEntries,
        now: args.now,
        operatorPubkey: args.operatorPubkey,
      });
    },
  };
  return { graftCalls, overrideCalls, graftCallback, overrideCallback };
}

// =============================================================================
// Importer harness.
// =============================================================================

export interface ImporterHarness {
  readonly importer: InclusionProofImporter;
  readonly manifest: FakeManifestStorage;
  readonly manifestStore: ManifestStore;
  readonly disposition: FakeDispositionStorage;
  readonly queue: FakeQueueScanner;
  readonly events: EventRecorder;
  readonly verifyCalls: ImportableInclusionProof[];
  readonly graftCalls: GraftCallRecord[];
  readonly overrideCalls: OverrideCallRecord[];
  /**
   * The per-tokenId mutex injected into the importer. Tests that need
   * to assert serialization (concurrent `importInclusionProof` on the
   * same `tokenId`) read the in-flight state via `mutex.isLocked` /
   * `mutex.size` and select the strategy they want via the
   * `mutexStrategy` builder option.
   */
  readonly mutex: PerTokenMutex;
}

export function buildImporterHarness(args: {
  readonly verifyResult?: ProofVerifyStatus;
  readonly verifyImpl?: ProofVerifier;
  /**
   * Optional pre-built mutex — caller sharing the mutex across multiple
   * harnesses (e.g. recipient + importer in the same Sphere) provides
   * one. Defaults to a fresh per-harness mutex.
   */
  readonly mutex?: PerTokenMutex;
  /**
   * Optional override of the mutex strategy. When omitted the
   * harness leaves `perTokenMutexStrategy` undefined so the
   * importer's own default applies — `'rpc-release'` post #153.
   * Tests that want strict-serialization assertions can set this
   * explicitly; tests that want to exercise the no-serialization
   * pass-through pass `'cas'`.
   */
  readonly mutexStrategy?: PerTokenMutexStrategy;
  /**
   * Optional override of the verify callback's behaviour to allow
   * tests to install a delay (e.g. via `vi.fakeTimers`) so the
   * concurrency window for serialization assertions is observable.
   * The wrapped fn is invoked AFTER `verifyResult` / `verifyImpl`
   * resolve, before returning to the importer.
   */
  readonly verifyHook?: (proof: ImportableInclusionProof) => Promise<void>;
} = {}): ImporterHarness {
  const manifest = makeFakeManifestStorage();
  const manifestStore = new ManifestStore({
    storage: manifest,
    lamport: new Lamport(),
    cas: new ManifestCas(manifest),
  });
  const disposition = makeFakeDispositionStorage();
  const queue = makeFakeQueueScanner();
  const events = makeEventRecorder();
  const verifyCalls: ImportableInclusionProof[] = [];

  const verifyDefault: ProofVerifier = async (proof) => {
    verifyCalls.push(proof);
    if (args.verifyHook) await args.verifyHook(proof);
    return args.verifyResult ?? 'OK';
  };
  const verifyProof: ProofVerifier = args.verifyImpl
    ? async (p) => {
        verifyCalls.push(p);
        if (args.verifyHook) await args.verifyHook(p);
        return args.verifyImpl!(p);
      }
    : verifyDefault;

  const recorders = makeRecorders();
  const mutex = args.mutex ?? new PerTokenMutex();

  const opts: ImportInclusionProofOptions = {
    manifestStore,
    dispositionStorage: disposition,
    queueScanner: queue,
    verifyProof,
    graftCallback: recorders.graftCallback,
    overrideCallback: recorders.overrideCallback,
    emit: events.emit,
    now: () => 1700000000000,
    perTokenMutex: mutex,
    // Leave undefined when the test doesn't override — the
    // importer's own default ('rpc-release' post #153) applies.
    ...(args.mutexStrategy !== undefined
      ? { perTokenMutexStrategy: args.mutexStrategy }
      : {}),
  };

  return {
    importer: new InclusionProofImporter(opts),
    manifest,
    manifestStore,
    disposition,
    queue,
    events,
    verifyCalls,
    graftCalls: recorders.graftCalls,
    overrideCalls: recorders.overrideCalls,
    mutex,
  };
}

// =============================================================================
// Revalidator harness.
// =============================================================================

export interface RevalidatorHarness {
  readonly runner: RevalidateCascadedRunner;
  readonly manifest: FakeManifestStorage;
  readonly manifestStore: ManifestStore;
  readonly verdicts: Map<string, ChildRevalidationVerdict>;
  readonly cycleWarnings: RevalidationCycleWarning[];
  readonly scannerErrors: RevalidationScannerError[];
  readonly callsByChild: string[];
}

export function buildRevalidatorHarness(args: {
  readonly verdicts?: ReadonlyMap<string, ChildRevalidationVerdict>;
  readonly defaultVerdict?: ChildRevalidationVerdict;
  readonly maxDepth?: number;
  /**
   * Optional pre-validator hook invoked BEFORE the verdict is computed.
   * Tests use this to deterministically interleave a parent-flip
   * mid-loop (so the runner's per-child fresh parent-read sees the
   * flipped state). Receives the manifest store reference so the test
   * can mutate the parent entry.
   */
  readonly beforeVerdict?: (args: {
    readonly addr: string;
    readonly parentTokenId: string;
    readonly childTokenId: string;
    readonly manifest: FakeManifestStorage;
  }) => void;
  /**
   * Optional override of the manifest scanner. When provided, REPLACES
   * the default `makeManifestScanner(storage)` — useful for tests that
   * need `findChildren` to throw deterministically.
   */
  readonly manifestScannerOverride?: import(
    '../../../../modules/payments/transfer/cascade-walker'
  ).CascadeManifestScanner;
} = {}): RevalidatorHarness {
  const manifest = makeFakeManifestStorage();
  const manifestStore = new ManifestStore({
    storage: manifest,
    lamport: new Lamport(),
    cas: new ManifestCas(manifest),
  });
  const scanner = args.manifestScannerOverride ?? makeManifestScanner(manifest);
  const verdicts = new Map<string, ChildRevalidationVerdict>(args.verdicts);
  const cycleWarnings: RevalidationCycleWarning[] = [];
  const scannerErrors: RevalidationScannerError[] = [];
  const callsByChild: string[] = [];

  const revalidateChild: ChildRevalidator = async (a) => {
    callsByChild.push(a.childTokenId);
    const verdict =
      verdicts.get(a.childTokenId) ??
      args.defaultVerdict ?? { kind: 'parent-still-invalid' };
    if (args.beforeVerdict !== undefined) {
      args.beforeVerdict({
        addr: a.addr,
        parentTokenId: a.parentTokenId,
        childTokenId: a.childTokenId,
        manifest,
      });
    }
    // Mirror production semantics: the validator OWNS the manifest
    // mutation. On `'revalidated'`, flip the child entry to status='valid'
    // (preserve splitParent for transitive walking). On
    // `'still-invalid-other'`, update the invalidReason to the new value.
    if (verdict.kind === 'revalidated') {
      const next: TokenManifestEntry = {
        ...a.childManifestEntry,
        status: 'valid',
      };
      // Strip the now-invalid invalidReason field.
      delete (next as { invalidReason?: string }).invalidReason;
      manifest.entries.set(`${a.addr}:${a.childTokenId}`, next);
    } else if (verdict.kind === 'still-invalid-other') {
      const next: TokenManifestEntry = {
        ...a.childManifestEntry,
        status: 'invalid',
        invalidReason: verdict.newReason,
      };
      manifest.entries.set(`${a.addr}:${a.childTokenId}`, next);
    }
    return verdict;
  };

  const opts: RevalidateCascadedOptions = {
    manifestScanner: scanner,
    manifestStore,
    revalidateChild,
    onCycleDetected: (w) => cycleWarnings.push(w),
    onScannerError: (e) => scannerErrors.push(e),
    maxDepth: args.maxDepth,
  };

  return {
    runner: new RevalidateCascadedRunner(opts),
    manifest,
    manifestStore,
    verdicts,
    cycleWarnings,
    scannerErrors,
    callsByChild,
  };
}

// =============================================================================
// Per-fixture builders.
// =============================================================================

export function manifestEntryFor(
  overrides: Partial<TokenManifestEntry> & { rootHashHex?: string } = {},
): TokenManifestEntry {
  const root: ContentHash =
    overrides.rootHashHex !== undefined
      ? contentHash(overrides.rootHashHex)
      : (overrides.rootHash ?? contentHash('aa'.repeat(32)));
  const { rootHashHex: _omit, ...rest } = overrides;
  void _omit;
  return {
    status: 'valid',
    ...rest,
    rootHash: root,
  };
}

export function queueEntryFor(
  overrides: Partial<ImportProofQueueEntry> & {
    tokenId?: string;
    commitmentRequestId?: string;
  } = {},
): ImportProofQueueEntry {
  return {
    entryId: overrides.entryId ?? `${overrides.tokenId ?? 't'}:${overrides.txIndex ?? 0}`,
    tokenId: overrides.tokenId ?? 't',
    commitmentRequestId: overrides.commitmentRequestId ?? 'rq-default',
    transactionHash: overrides.transactionHash ?? '0000' + 'ab'.repeat(32),
    authenticator: overrides.authenticator ?? 'authn-default',
    txIndex: overrides.txIndex ?? 0,
    status: overrides.status ?? 'pending',
  };
}

export function invalidEntryFor(
  overrides: Partial<InvalidEntry> & { tokenId: string },
): InvalidEntry {
  return {
    tokenId: overrides.tokenId,
    observedTokenContentHash:
      overrides.observedTokenContentHash ?? contentHash('aa'.repeat(32)),
    reason: overrides.reason ?? 'oracle-rejected',
    observedAt: overrides.observedAt ?? 1700000000000,
    bundleCid: overrides.bundleCid ?? 'bafy-bundle',
    senderTransportPubkey: overrides.senderTransportPubkey ?? 'sender-pk',
  };
}

export function auditEntryFor(
  overrides: Partial<AuditEntry> & { tokenId: string },
): AuditEntry {
  return {
    tokenId: overrides.tokenId,
    observedTokenContentHash:
      overrides.observedTokenContentHash ?? contentHash('aa'.repeat(32)),
    auditStatus: overrides.auditStatus ?? 'audit-not-our-state',
    reason: overrides.reason ?? 'not-our-state',
    recordedAt: overrides.recordedAt ?? 1700000000000,
    bundleCidsObserved: overrides.bundleCidsObserved ?? ['bafy-bundle'],
    promotedToManifestRef: overrides.promotedToManifestRef,
    audit_promoted_from: overrides.audit_promoted_from,
  };
}

/**
 * Map a human-readable test label to a canonical 64-char-hex tokenId
 * (Wave 3 steelman: the importer rejects non-hex tokenIds at entry to
 * `importInclusionProof`). This helper is the test-side equivalent of
 * the upstream wallet code that lower-cases the SDK tokenId before
 * passing it to the importer.
 *
 * Behavior:
 *  - Lowercases the label.
 *  - Replaces any non-hex character with '0'.
 *  - Right-pads with '0' until length is 64.
 *  - If the input is already 64-char hex, returns it unchanged.
 *
 * The mapping is deterministic but not cryptographically meaningful —
 * it exists purely so tests can use mnemonic labels (`'t-bad'`,
 * `'t-pending'`, etc.) and still satisfy the production tokenId shape.
 */
export function tk(label: string): string {
  if (/^[0-9a-f]{64}$/i.test(label)) return label;
  const cleaned = label.toLowerCase().replace(/[^0-9a-f]/g, '0');
  return cleaned.padEnd(64, '0').slice(0, 64);
}

export function proofFor(
  overrides: Partial<ImportableInclusionProof> = {},
): ImportableInclusionProof {
  return {
    requestId: overrides.requestId ?? 'rq-default',
    transactionHash: overrides.transactionHash ?? '0000' + 'ab'.repeat(32),
    authenticator: overrides.authenticator ?? 'authn-default',
    proof: overrides.proof ?? { __mock: 'proof' },
  };
}
