/**
 * Tests for `profile/disposition-writer.ts` — UXF Transfer Protocol
 * §5.3 / §5.4 / §6.1 (T.3.C).
 *
 * Covers:
 *   1. VALID disposition → manifest store upsert.
 *   2. PENDING disposition → manifest with status='pending'.
 *   3. CONFLICTING disposition → manifest with conflictingHeads + lex-min
 *      hint reflected upstream.
 *   4. INVALID disposition → `_invalid` per-entry-key write.
 *   5. INVALID with reason='client-error' → routes to `_invalid` AND
 *      emits `transfer:operator-alert` (C13).
 *   6. AUDIT disposition → `_audit` per-entry-key write.
 *   7. Same tokenId in two bundles with different observedTokenContentHash
 *      → two distinct invalid records (multi-rep keying).
 *   8. Re-arrival of same audit (same tokenId + observedTokenContentHash)
 *      with NEW bundleCid → bundleCidsObserved accumulates.
 *   9. Promotion: promoteAuditEntry sets audit-promoted + manifest gets
 *      audit_promoted_from; audit record NOT deleted.
 *  10. Promotion preserves audit-promoted on re-arrival (no regression).
 *  11. Constructor / write validation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DispositionWriter,
  auditKeyFor,
  invalidKeyFor,
  mergeAuditEntry,
  type DispositionEventEmitter,
  type DispositionPerEntryStorage,
} from '../../../profile/disposition-writer.js';
import { ManifestStore } from '../../../profile/manifest-store.js';
import {
  type MinimalManifestStorage,
} from '../../../profile/manifest-cas.js';
import { Lamport } from '../../../profile/lamport.js';
import { SphereError } from '../../../core/errors.js';
import type {
  TokenManifestEntry,
} from '../../../profile/token-manifest.js';
import type {
  AuditEntry,
  DispositionRecord,
  InvalidEntry,
} from '../../../types/disposition.js';
import type {
  SphereEventMap,
  SphereEventType,
} from '../../../types/index.js';
import type { ContentHash } from '../../../uxf/types.js';

// =============================================================================
// Fixtures
// =============================================================================

const ADDR = 'DIRECT_aabbcc_ddeeff';
const TOKEN_A = '0xtokenA';
const TOKEN_B = '0xtokenB';
const HASH_X = 'x'.repeat(64);
const HASH_Y = 'y'.repeat(64);
const ROOT = 'r'.repeat(64);
const ROOT_2 = 's'.repeat(64);
const SENDER_PUBKEY = 'a'.repeat(64);
const BUNDLE_CID_1 = 'bafy-bundle-1';
const BUNDLE_CID_2 = 'bafy-bundle-2';

const ch = (s: string): ContentHash => s as ContentHash;

class FakePerEntryStorage implements DispositionPerEntryStorage {
  readonly store = new Map<string, unknown>();

  async readRecord<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }

  async writeRecord<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
}

class FakeManifestStorage implements MinimalManifestStorage {
  readonly store = new Map<string, TokenManifestEntry>();

  private k(addr: string, tokenId: string): string {
    return `${addr}|${tokenId}`;
  }

  async readEntry(addr: string, tokenId: string): Promise<TokenManifestEntry | undefined> {
    return this.store.get(this.k(addr, tokenId));
  }

  async writeEntry(addr: string, tokenId: string, entry: TokenManifestEntry): Promise<void> {
    this.store.set(this.k(addr, tokenId), entry);
  }

  setRaw(addr: string, tokenId: string, entry: TokenManifestEntry): void {
    this.store.set(this.k(addr, tokenId), entry);
  }
}

interface RecordedEvent {
  readonly type: SphereEventType;
  readonly payload: SphereEventMap[SphereEventType];
}

function makeRecorder(): {
  readonly emit: DispositionEventEmitter;
  readonly events: RecordedEvent[];
} {
  const events: RecordedEvent[] = [];
  const emit: DispositionEventEmitter = (type, payload) => {
    events.push({ type, payload });
  };
  return { emit, events };
}

function makeWriter(
  perEntry: FakePerEntryStorage,
  manifestStorage: FakeManifestStorage,
  emit: DispositionEventEmitter,
  now: () => number = () => 1_700_000_000_000,
): DispositionWriter {
  const manifestStore = new ManifestStore({
    storage: manifestStorage,
    lamport: new Lamport(),
  });
  return new DispositionWriter({
    storage: perEntry,
    manifestStore,
    emit,
    now,
  });
}

const validRecord = (
  overrides: Partial<
    Extract<DispositionRecord, { disposition: 'VALID' }>
  > = {},
): Extract<DispositionRecord, { disposition: 'VALID' }> => ({
  disposition: 'VALID',
  tokenId: TOKEN_A,
  observedTokenContentHash: ch(HASH_X),
  bundleCid: BUNDLE_CID_1,
  senderTransportPubkey: SENDER_PUBKEY,
  manifest: {
    rootHash: ch(ROOT),
    status: 'valid',
  },
  ...overrides,
});

const pendingRecord = (): Extract<
  DispositionRecord,
  { disposition: 'PENDING' }
> => ({
  disposition: 'PENDING',
  tokenId: TOKEN_A,
  observedTokenContentHash: ch(HASH_X),
  bundleCid: BUNDLE_CID_1,
  senderTransportPubkey: SENDER_PUBKEY,
  manifest: {
    rootHash: ch(ROOT),
    status: 'pending',
  },
});

const conflictingRecord = (): Extract<
  DispositionRecord,
  { disposition: 'CONFLICTING' }
> => ({
  disposition: 'CONFLICTING',
  tokenId: TOKEN_A,
  observedTokenContentHash: ch(HASH_X),
  bundleCid: BUNDLE_CID_1,
  senderTransportPubkey: SENDER_PUBKEY,
  manifest: {
    rootHash: ch(ROOT),
    status: 'conflicting',
  },
  conflictingHeads: [ch(ROOT), ch(ROOT_2)],
});

const invalidRecord = (
  overrides: Partial<
    Extract<DispositionRecord, { disposition: 'INVALID' }>
  > = {},
): Extract<DispositionRecord, { disposition: 'INVALID' }> => ({
  disposition: 'INVALID',
  tokenId: TOKEN_A,
  observedTokenContentHash: ch(HASH_X),
  bundleCid: BUNDLE_CID_1,
  senderTransportPubkey: SENDER_PUBKEY,
  reason: 'proof-invalid',
  ...overrides,
});

const auditRecord = (
  overrides: Partial<
    Extract<DispositionRecord, { disposition: 'AUDIT' }>
  > = {},
): Extract<DispositionRecord, { disposition: 'AUDIT' }> => ({
  disposition: 'AUDIT',
  tokenId: TOKEN_A,
  observedTokenContentHash: ch(HASH_X),
  bundleCid: BUNDLE_CID_1,
  senderTransportPubkey: SENDER_PUBKEY,
  auditStatus: 'audit-not-our-state',
  reason: 'not-our-state',
  ...overrides,
});

// =============================================================================
// 1. VALID / PENDING / CONFLICTING — manifest writes
// =============================================================================

describe('DispositionWriter — manifest writes', () => {
  let perEntry: FakePerEntryStorage;
  let manifest: FakeManifestStorage;
  let writer: DispositionWriter;
  let recorder: ReturnType<typeof makeRecorder>;

  beforeEach(() => {
    perEntry = new FakePerEntryStorage();
    manifest = new FakeManifestStorage();
    recorder = makeRecorder();
    writer = makeWriter(perEntry, manifest, recorder.emit);
  });

  it('VALID disposition writes to manifest store with status=valid', async () => {
    await writer.write(ADDR, validRecord());
    const stored = await manifest.readEntry(ADDR, TOKEN_A);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe('valid');
    expect(stored?.rootHash).toBe(ch(ROOT));
    expect(stored?.bundleCid).toBe(BUNDLE_CID_1);
    expect(stored?.senderTransportPubkey).toBe(SENDER_PUBKEY);
    // Lamport stamped by store on first write.
    expect(stored?.lamport).toBe(1);
    // No invalid/audit per-entry record written.
    expect(perEntry.store.size).toBe(0);
    expect(recorder.events).toHaveLength(0);
  });

  it('PENDING disposition writes to manifest with status=pending', async () => {
    await writer.write(ADDR, pendingRecord());
    const stored = await manifest.readEntry(ADDR, TOKEN_A);
    expect(stored?.status).toBe('pending');
  });

  it('CONFLICTING disposition writes manifest with conflictingHeads union', async () => {
    await writer.write(ADDR, conflictingRecord());
    const stored = await manifest.readEntry(ADDR, TOKEN_A);
    expect(stored?.status).toBe('conflicting');
    // conflictingHeads is the union (sorted) of the upstream-supplied heads.
    expect(stored?.conflictingHeads).toEqual([ch(ROOT), ch(ROOT_2)]);
  });
});

// =============================================================================
// 2. INVALID — multi-rep keying + C13 client-error path
// =============================================================================

describe('DispositionWriter — INVALID disposition', () => {
  let perEntry: FakePerEntryStorage;
  let manifest: FakeManifestStorage;
  let writer: DispositionWriter;
  let recorder: ReturnType<typeof makeRecorder>;

  beforeEach(() => {
    perEntry = new FakePerEntryStorage();
    manifest = new FakeManifestStorage();
    recorder = makeRecorder();
    writer = makeWriter(perEntry, manifest, recorder.emit);
  });

  it('writes to ${addr}.invalid.${tokenId}.${observedTokenContentHash}', async () => {
    await writer.write(ADDR, invalidRecord());
    const key = invalidKeyFor(ADDR, TOKEN_A, ch(HASH_X));
    expect(key).toBe(`${ADDR}.invalid.${TOKEN_A}.${HASH_X}`);
    const stored = perEntry.store.get(key) as InvalidEntry | undefined;
    expect(stored).toBeDefined();
    expect(stored?.tokenId).toBe(TOKEN_A);
    expect(stored?.observedTokenContentHash).toBe(ch(HASH_X));
    expect(stored?.reason).toBe('proof-invalid');
    expect(stored?.bundleCid).toBe(BUNDLE_CID_1);
    expect(stored?.senderTransportPubkey).toBe(SENDER_PUBKEY);
    expect(stored?.observedAt).toBeTypeOf('number');
    // Did NOT touch manifest.
    expect(manifest.store.size).toBe(0);
    // No operator-alert (this is `proof-invalid`, not `client-error`).
    expect(recorder.events).toHaveLength(0);
  });

  it('two distinct bundles with different observedTokenContentHash → two records', async () => {
    await writer.write(ADDR, invalidRecord({ observedTokenContentHash: ch(HASH_X), bundleCid: BUNDLE_CID_1 }));
    await writer.write(ADDR, invalidRecord({ observedTokenContentHash: ch(HASH_Y), bundleCid: BUNDLE_CID_2 }));

    const keyX = invalidKeyFor(ADDR, TOKEN_A, ch(HASH_X));
    const keyY = invalidKeyFor(ADDR, TOKEN_A, ch(HASH_Y));
    expect(keyX).not.toBe(keyY);
    const recX = perEntry.store.get(keyX) as InvalidEntry;
    const recY = perEntry.store.get(keyY) as InvalidEntry;
    expect(recX.bundleCid).toBe(BUNDLE_CID_1);
    expect(recY.bundleCid).toBe(BUNDLE_CID_2);
  });

  it('idempotent on identical re-arrival (same composite key)', async () => {
    await writer.write(ADDR, invalidRecord());
    await writer.write(ADDR, invalidRecord());
    expect(perEntry.store.size).toBe(1);
  });

  it('C13: client-error reason → write to _invalid AND emit operator-alert', async () => {
    await writer.write(
      ADDR,
      invalidRecord({ reason: 'client-error' }),
    );
    const key = invalidKeyFor(ADDR, TOKEN_A, ch(HASH_X));
    const stored = perEntry.store.get(key) as InvalidEntry;
    expect(stored.reason).toBe('client-error');

    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0].type).toBe('transfer:operator-alert');
    const payload = recorder.events[0].payload as SphereEventMap['transfer:operator-alert'];
    expect(payload.code).toBe('client-error');
    expect(payload.tokenId).toBe(TOKEN_A);
    expect(payload.bundleCid).toBe(BUNDLE_CID_1);
    expect(payload.observedTokenContentHash).toBe(ch(HASH_X));
    expect(payload.message).toMatch(/CLIENT BUG/i);
  });

  it('non-client-error reasons do NOT emit operator-alert', async () => {
    const reasons = [
      'proof-invalid',
      'auth-invalid',
      'continuity-broken',
      'oracle-rejected',
      'belief-divergence',
      'race-lost',
    ] as const;
    for (const reason of reasons) {
      recorder.events.length = 0;
      await writer.write(
        ADDR,
        invalidRecord({
          reason,
          observedTokenContentHash: ch(reason.padEnd(64, '0')),
        }),
      );
      expect(recorder.events).toHaveLength(0);
    }
  });
});

// =============================================================================
// 3. AUDIT — multi-rep keying + accumulator semantics
// =============================================================================

describe('DispositionWriter — AUDIT disposition', () => {
  let perEntry: FakePerEntryStorage;
  let manifest: FakeManifestStorage;
  let writer: DispositionWriter;
  let recorder: ReturnType<typeof makeRecorder>;

  beforeEach(() => {
    perEntry = new FakePerEntryStorage();
    manifest = new FakeManifestStorage();
    recorder = makeRecorder();
    writer = makeWriter(perEntry, manifest, recorder.emit);
  });

  it('writes to ${addr}.audit.${tokenId}.${observedTokenContentHash}', async () => {
    await writer.write(ADDR, auditRecord());
    const key = auditKeyFor(ADDR, TOKEN_A, ch(HASH_X));
    expect(key).toBe(`${ADDR}.audit.${TOKEN_A}.${HASH_X}`);
    const stored = perEntry.store.get(key) as AuditEntry;
    expect(stored.tokenId).toBe(TOKEN_A);
    expect(stored.observedTokenContentHash).toBe(ch(HASH_X));
    expect(stored.auditStatus).toBe('audit-not-our-state');
    expect(stored.reason).toBe('not-our-state');
    expect(stored.bundleCidsObserved).toEqual([BUNDLE_CID_1]);
    // Did NOT touch manifest.
    expect(manifest.store.size).toBe(0);
  });

  it('two distinct bundles with different observedTokenContentHash → two records', async () => {
    await writer.write(ADDR, auditRecord({ observedTokenContentHash: ch(HASH_X), bundleCid: BUNDLE_CID_1 }));
    await writer.write(ADDR, auditRecord({ observedTokenContentHash: ch(HASH_Y), bundleCid: BUNDLE_CID_2 }));

    const keyX = auditKeyFor(ADDR, TOKEN_A, ch(HASH_X));
    const keyY = auditKeyFor(ADDR, TOKEN_A, ch(HASH_Y));
    expect(keyX).not.toBe(keyY);
  });

  it('re-arrival of same key with NEW bundleCid accumulates bundleCidsObserved', async () => {
    await writer.write(
      ADDR,
      auditRecord({
        observedTokenContentHash: ch(HASH_X),
        bundleCid: BUNDLE_CID_1,
      }),
    );
    await writer.write(
      ADDR,
      auditRecord({
        observedTokenContentHash: ch(HASH_X),
        bundleCid: BUNDLE_CID_2,
      }),
    );
    const key = auditKeyFor(ADDR, TOKEN_A, ch(HASH_X));
    const stored = perEntry.store.get(key) as AuditEntry;
    expect(stored.bundleCidsObserved).toEqual([BUNDLE_CID_1, BUNDLE_CID_2]);
  });

  it('re-arrival on already-promoted record does NOT regress auditStatus', async () => {
    // First write: audit-not-our-state.
    await writer.write(ADDR, auditRecord());
    const key = auditKeyFor(ADDR, TOKEN_A, ch(HASH_X));
    let stored = perEntry.store.get(key) as AuditEntry;
    expect(stored.auditStatus).toBe('audit-not-our-state');

    // Manually promote (simulating successful promotion).
    perEntry.store.set(key, {
      ...stored,
      auditStatus: 'audit-promoted',
      promotedToManifestRef: ch(ROOT),
    } as AuditEntry);

    // Re-arrival of the SAME (tokenId, observedTokenContentHash) — even
    // with auditStatus claiming 'audit-not-our-state' on the incoming
    // record — must NOT regress the stored status.
    await writer.write(
      ADDR,
      auditRecord({ bundleCid: BUNDLE_CID_2 }),
    );
    stored = perEntry.store.get(key) as AuditEntry;
    expect(stored.auditStatus).toBe('audit-promoted');
    expect(stored.promotedToManifestRef).toBe(ch(ROOT));
  });
});

// =============================================================================
// 4. mergeAuditEntry — pure helper
// =============================================================================

describe('mergeAuditEntry — pure helper', () => {
  it('seeds a fresh entry from the incoming record when prev is undefined', () => {
    const merged = mergeAuditEntry(undefined, auditRecord(), 5_000);
    expect(merged.tokenId).toBe(TOKEN_A);
    expect(merged.observedTokenContentHash).toBe(ch(HASH_X));
    expect(merged.auditStatus).toBe('audit-not-our-state');
    expect(merged.bundleCidsObserved).toEqual([BUNDLE_CID_1]);
    expect(merged.recordedAt).toBe(5_000);
  });

  it('preserves recordedAt across re-arrivals', () => {
    const prev: AuditEntry = {
      tokenId: TOKEN_A,
      observedTokenContentHash: ch(HASH_X),
      auditStatus: 'audit-not-our-state',
      reason: 'not-our-state',
      recordedAt: 1_000,
      bundleCidsObserved: [BUNDLE_CID_1],
    };
    const merged = mergeAuditEntry(
      prev,
      auditRecord({ bundleCid: BUNDLE_CID_2 }),
      9_999,
    );
    expect(merged.recordedAt).toBe(1_000);
    expect(merged.bundleCidsObserved).toEqual([BUNDLE_CID_1, BUNDLE_CID_2]);
  });

  it('preserves audit-promoted status and promotedToManifestRef', () => {
    const prev: AuditEntry = {
      tokenId: TOKEN_A,
      observedTokenContentHash: ch(HASH_X),
      auditStatus: 'audit-promoted',
      reason: 'not-our-state',
      recordedAt: 1_000,
      bundleCidsObserved: [BUNDLE_CID_1],
      promotedToManifestRef: ch(ROOT),
    };
    const merged = mergeAuditEntry(
      prev,
      auditRecord({ bundleCid: BUNDLE_CID_2 }),
      9_999,
    );
    expect(merged.auditStatus).toBe('audit-promoted');
    expect(merged.promotedToManifestRef).toBe(ch(ROOT));
  });
});

// =============================================================================
// 5. Promotion flow
// =============================================================================

describe('DispositionWriter.promoteAuditEntry', () => {
  let perEntry: FakePerEntryStorage;
  let manifest: FakeManifestStorage;
  let writer: DispositionWriter;
  let recorder: ReturnType<typeof makeRecorder>;

  beforeEach(() => {
    perEntry = new FakePerEntryStorage();
    manifest = new FakeManifestStorage();
    recorder = makeRecorder();
    writer = makeWriter(perEntry, manifest, recorder.emit);
  });

  it('sets audit-promoted + promotedToManifestRef AND audit_promoted_from on manifest', async () => {
    // Seed an audit record.
    await writer.write(ADDR, auditRecord());
    const auditKey = auditKeyFor(ADDR, TOKEN_A, ch(HASH_X));
    const auditBefore = perEntry.store.get(auditKey) as AuditEntry;
    expect(auditBefore.auditStatus).toBe('audit-not-our-state');

    // Promote.
    const manifestEntry: TokenManifestEntry = {
      rootHash: ch(ROOT),
      status: 'valid',
      bundleCid: BUNDLE_CID_2,
      senderTransportPubkey: SENDER_PUBKEY,
    };
    await writer.promoteAuditEntry(ADDR, TOKEN_A, ch(HASH_X), manifestEntry);

    // Audit record updated in place (NOT deleted).
    const auditAfter = perEntry.store.get(auditKey) as AuditEntry;
    expect(auditAfter).toBeDefined();
    expect(auditAfter.auditStatus).toBe('audit-promoted');
    expect(auditAfter.promotedToManifestRef).toBe(ch(ROOT));

    // Manifest entry has audit_promoted_from set to [auditKey].
    const stored = await manifest.readEntry(ADDR, TOKEN_A);
    expect(stored?.audit_promoted_from).toEqual([auditKey]);
    expect(stored?.rootHash).toBe(ch(ROOT));
  });

  it('audit record is NOT deleted on promotion', async () => {
    await writer.write(ADDR, auditRecord());
    const auditKey = auditKeyFor(ADDR, TOKEN_A, ch(HASH_X));

    const manifestEntry: TokenManifestEntry = {
      rootHash: ch(ROOT),
      status: 'valid',
    };
    await writer.promoteAuditEntry(ADDR, TOKEN_A, ch(HASH_X), manifestEntry);

    expect(perEntry.store.has(auditKey)).toBe(true);
  });

  it('promotion is idempotent on the same audit key (no duplication)', async () => {
    await writer.write(ADDR, auditRecord());
    const manifestEntry: TokenManifestEntry = {
      rootHash: ch(ROOT),
      status: 'valid',
    };
    await writer.promoteAuditEntry(ADDR, TOKEN_A, ch(HASH_X), manifestEntry);
    await writer.promoteAuditEntry(ADDR, TOKEN_A, ch(HASH_X), manifestEntry);

    const stored = await manifest.readEntry(ADDR, TOKEN_A);
    const auditKey = auditKeyFor(ADDR, TOKEN_A, ch(HASH_X));
    expect(stored?.audit_promoted_from).toEqual([auditKey]);
  });

  it('multiple distinct audit promotions accumulate via set-OR', async () => {
    // Seed two distinct audit records (different observedTokenContentHash).
    await writer.write(
      ADDR,
      auditRecord({ observedTokenContentHash: ch(HASH_X), bundleCid: BUNDLE_CID_1 }),
    );
    await writer.write(
      ADDR,
      auditRecord({ observedTokenContentHash: ch(HASH_Y), bundleCid: BUNDLE_CID_2 }),
    );

    const manifestEntry: TokenManifestEntry = {
      rootHash: ch(ROOT),
      status: 'valid',
    };

    await writer.promoteAuditEntry(ADDR, TOKEN_A, ch(HASH_X), manifestEntry);
    await writer.promoteAuditEntry(ADDR, TOKEN_A, ch(HASH_Y), manifestEntry);

    const stored = await manifest.readEntry(ADDR, TOKEN_A);
    expect(stored?.audit_promoted_from).toEqual([
      auditKeyFor(ADDR, TOKEN_A, ch(HASH_X)),
      auditKeyFor(ADDR, TOKEN_A, ch(HASH_Y)),
    ]);
  });

  it('throws VALIDATION_ERROR when no audit record exists at the key', async () => {
    await expect(
      writer.promoteAuditEntry(ADDR, TOKEN_A, ch(HASH_X), {
        rootHash: ch(ROOT),
        status: 'valid',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws VALIDATION_ERROR on empty addr / tokenId', async () => {
    await expect(
      writer.promoteAuditEntry('', TOKEN_A, ch(HASH_X), {
        rootHash: ch(ROOT),
        status: 'valid',
      }),
    ).rejects.toThrow(SphereError);
    await expect(
      writer.promoteAuditEntry(ADDR, '', ch(HASH_X), {
        rootHash: ch(ROOT),
        status: 'valid',
      }),
    ).rejects.toThrow(SphereError);
  });
});

// =============================================================================
// 6. write-level validation
// =============================================================================

describe('DispositionWriter.write validation', () => {
  let writer: DispositionWriter;

  beforeEach(() => {
    writer = makeWriter(
      new FakePerEntryStorage(),
      new FakeManifestStorage(),
      () => {},
    );
  });

  it('rejects empty addr', async () => {
    await expect(writer.write('', validRecord())).rejects.toThrow(SphereError);
  });
});

// =============================================================================
// 7. Cross-token isolation — TOKEN_B audit doesn't bleed into TOKEN_A
// =============================================================================

describe('Cross-token isolation', () => {
  it('different tokenIds produce distinct keys', async () => {
    const perEntry = new FakePerEntryStorage();
    const manifest = new FakeManifestStorage();
    const writer = makeWriter(perEntry, manifest, () => {});

    await writer.write(
      ADDR,
      auditRecord({ tokenId: TOKEN_A, observedTokenContentHash: ch(HASH_X) }),
    );
    await writer.write(
      ADDR,
      auditRecord({ tokenId: TOKEN_B, observedTokenContentHash: ch(HASH_X) }),
    );

    const keyA = auditKeyFor(ADDR, TOKEN_A, ch(HASH_X));
    const keyB = auditKeyFor(ADDR, TOKEN_B, ch(HASH_X));
    expect(keyA).not.toBe(keyB);
    expect(perEntry.store.has(keyA)).toBe(true);
    expect(perEntry.store.has(keyB)).toBe(true);
  });
});
