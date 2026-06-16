/**
 * GroupChatModule — member-list ingestion scaling.
 *
 * Reproduces the global-chat freeze: on fresh import the wallet restores/joins
 * the pinned global group `general` (which everyone is a member of), and
 * fetchAndSaveMembers() inserts every member via saveMemberToMemory(), which
 * does a linear `findIndex` dedup per member — O(n^2) over the whole member
 * list. For a global group with tens of thousands of members this is a ~30s
 * synchronous main-thread block (so hard the page can't even open DevTools).
 *
 * This drives the REAL fetchAndSaveMembers() with a large synthetic member set
 * (no relay, no publish) and asserts ingestion stays O(n) — fast enough to not
 * freeze the UI.
 */
import { describe, it, expect, vi } from 'vitest';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { GroupChatModule } from '../../../modules/groupchat/GroupChatModule';
import { NIP29_KINDS } from '../../../constants';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity } from '../../../types';

const GROUP_ID = 'general';
const MEMBER_COUNT = 30_000;
// Generous ceiling: O(n) ingestion of 30k members is a few ms; the O(n^2)
// regression is multiple seconds. 1500ms cleanly separates the two.
const MAX_INGEST_MS = 1500;

function createMockStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    id: 'mock', name: 'Mock', type: 'local' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
  } as unknown as StorageProvider;
}

interface FakeEvent { id: string; pubkey: string; created_at: number; kind: number; content: string; tags: string[][]; }

function makeMembersEvent(pubkeys: string[]): FakeEvent {
  return {
    id: 'members', pubkey: 'relay', created_at: 1000, kind: NIP29_KINDS.GROUP_MEMBERS, content: '',
    tags: [['d', GROUP_ID], ...pubkeys.map((pk) => ['p', pk, '', 'member'])],
  };
}
function makeAdminsEvent(pubkeys: string[]): FakeEvent {
  return {
    id: 'admins', pubkey: 'relay', created_at: 1000, kind: NIP29_KINDS.GROUP_ADMINS, content: '',
    tags: [['d', GROUP_ID], ...pubkeys.map((pk) => ['p', pk, '', 'admin'])],
  };
}

/** Minimal NostrClient stand-in: serves the members/admins events then EOSE. */
function makeMockClient(membersEvt: FakeEvent, adminsEvt: FakeEvent) {
  let n = 0;
  return {
    subscribe(filter: { kinds?: number[] }, handlers: { onEvent: (e: FakeEvent) => void; onEndOfStoredEvents?: () => void }) {
      const id = 'sub' + n++;
      const kinds = filter.kinds ?? [];
      setTimeout(() => {
        if (kinds.includes(NIP29_KINDS.GROUP_MEMBERS)) handlers.onEvent(membersEvt);
        else if (kinds.includes(NIP29_KINDS.GROUP_ADMINS)) handlers.onEvent(adminsEvt);
        handlers.onEndOfStoredEvents?.();
      }, 0);
      return id;
    },
    unsubscribe() {},
  };
}

describe('GroupChatModule — member ingestion scaling', () => {
  it('ingests a huge global-group member list without an O(n^2) main-thread stall', async () => {
    const pubkeys = Array.from({ length: MEMBER_COUNT }, (_, i) => i.toString(16).padStart(64, '0'));
    const adminPk = 'f'.repeat(64);

    const identity: FullIdentity = {
      privateKey: '01'.padStart(64, '0'),
      chainPubkey: '02' + 'a'.repeat(64),
      l1Address: 'alpha1testdummy',
    };

    const mod = new GroupChatModule();
    mod.initialize({ identity, storage: createMockStorage(), emitEvent: vi.fn() });
    // Inject mock client so we exercise fetchAndSaveMembers without a real relay.
    (mod as unknown as { client: unknown }).client = makeMockClient(
      makeMembersEvent(pubkeys),
      makeAdminsEvent([adminPk]),
    );

    const eld = monitorEventLoopDelay({ resolution: 1 });
    eld.enable();
    const t0 = performance.now();
    await (mod as unknown as { fetchAndSaveMembers(id: string): Promise<void> }).fetchAndSaveMembers(GROUP_ID);
    const durationMs = performance.now() - t0;
    eld.disable();

    const stored = mod.getMembers(GROUP_ID);
    // eslint-disable-next-line no-console
    console.log(`[member-freeze] members=${stored.length} ingestMs=${Math.round(durationMs)} eldMaxMs=${(eld.max / 1e6).toFixed(0)}`);

    // Correctness: every member (+ the extra admin) is stored, deduped.
    expect(stored.length).toBe(MEMBER_COUNT + 1);

    // Freeze gate: ingestion must be O(n), not the original O(n^2) dedup
    // (saveMemberToMemory's per-member findIndex) which was a multi-second
    // synchronous main-thread block for a global group's full member list.
    expect(
      durationMs,
      `member ingestion took ${Math.round(durationMs)}ms — O(n^2) dedup is freezing the main thread`,
    ).toBeLessThan(MAX_INGEST_MS);
  });
});
