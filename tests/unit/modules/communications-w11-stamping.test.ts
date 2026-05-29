/**
 * T-D10 regression tests for W11 originated-tag stamping in
 * CommunicationsModule. Mirrors the T-D7 (payments) and T-D9 (swap)
 * test patterns with a DM-specific twist: the directional
 * `replicated` case (SPEC §10.2.3.1) where an incoming peer message
 * cannot go through `setEntry` at the local write edge (the helper
 * validates via `assertOriginTagLocal` which REJECTS 'replicated').
 *
 * Classification matrix (see SPEC §10.2.3 and
 * profile/aggregator-pointer/originated-tag.ts):
 *
 *   trigger                              entryType      dispatch
 *   ───────────────────────────────────  ─────────────  ────────────────
 *   sendDM (outgoing user action)         dm_send       setStorageEntry
 *   markAsRead                            cache_index   setStorageEntry
 *   deleteConversation                    cache_index   setStorageEntry
 *   onReadReceipt (peer read my DM)       cache_index   setStorageEntry
 *   load() legacy migration               cache_index   setStorageEntry
 *   handleIncomingMessage (peer sent DM)  raw           plain storage.set
 *   handleIncomingMessage (self-wrap replay) raw        plain storage.set
 *
 * The `raw` path is the origin-side `'replicated'` case: the local
 * write bypasses envelope-typed classification and emits raw bytes
 * (default envelope: cache_index/system). When another wallet
 * replicates this key, OrbitDbAdapter.getEntry's receiver-authority
 * downgrade forces the tag to 'replicated' for that peer's read.
 *
 * Scope: source-level invariants + a behavioural test of a local
 * copy of the helpers. CommunicationsModule's dependency surface
 * (transport resolver, cidRefStore, storage, emitEvent, identity) is
 * heavy enough that a full-module integration test would outstrip
 * the narrow guarantee we want to pin: that each `save()` call-site
 * passes the expected entryType.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const COMMS_MODULE_PATH = path.resolve(
  __dirname,
  '../../../modules/communications/CommunicationsModule.ts',
);

describe('T-D10 CommunicationsModule W11 stamping — source-level invariant', () => {
  const source = fs.readFileSync(COMMS_MODULE_PATH, 'utf8');

  it('STORAGE_KEYS_ADDRESS.MESSAGES is never written via raw storage.set outside writeMessagesKey', () => {
    // All classified writes to the messages key route through
    // `writeMessagesKey` (which branches to setStorageEntry or raw
    // storage.set depending on entryType). A future regression that
    // reintroduces a direct `storage.set(STORAGE_KEYS_ADDRESS.MESSAGES, …)`
    // in _doSave would drop the W11 classification on all non-raw paths.
    const offenderRe =
      /storage\s*\.\s*set\s*\(\s*STORAGE_KEYS_ADDRESS\.MESSAGES\b/;
    const lines = source.split('\n');
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (offenderRe.test(lines[i])) {
        offenders.push(`line ${i + 1}: ${lines[i].trim()}`);
      }
    }
    // Expected: zero. Comments that mention the pattern textually are
    // filtered by the regex anchor on `storage.set(` followed directly
    // by the key constant — a code-shape match, not a docstring match.
    expect(offenders).toEqual([]);
  });

  it('setStorageEntry helper is present at the expected class location', () => {
    // Anchor the helper so a future refactor (rename / move) trips
    // this test rather than silently losing stamping.
    expect(source).toMatch(/private\s+async\s+setStorageEntry\s*\(/);
    // Narrow union excludes 'raw' — the raw path does NOT flow
    // through setStorageEntry (which would mis-validate a
    // 'replicated' origin tag at the local write edge).
    expect(source).toMatch(/entryType:\s*['"]dm_send['"]\s*\|/);
    expect(source).toMatch(/['"]cache_index['"]/);
  });

  it('writeMessagesKey funnel is present and routes raw vs classified paths', () => {
    // Anchor the dispatch so the receiver-authority model can't be
    // silently bypassed. `writeMessagesKey` is the ONLY function in
    // _doSave that should touch storage; all else routes through it.
    expect(source).toMatch(/private\s+async\s+writeMessagesKey\s*\(/);
    // Raw branch guard — when entryType === 'raw' we must NOT go
    // through setStorageEntry (which would mis-validate).
    expect(source).toMatch(/entryType\s*===\s*['"]raw['"]/);
  });

  it('save() accepts the three-valued entryType union', () => {
    // Anchor the parameter signature: dm_send | cache_index | raw.
    // A regression that widens or narrows this without updating
    // call-sites is caught at the TS compile step, but the grep pin
    // adds a stable source-shape invariant.
    expect(source).toMatch(
      /private\s+async\s+save\s*\(\s*[\s\S]{0,120}['"]dm_send['"]\s*\|\s*['"]cache_index['"]\s*\|\s*['"]raw['"]/,
    );
  });

  it('sendDM site classifies as dm_send (user-action write)', () => {
    // The outgoing-DM path is the canonical `dm_send` case. Match
    // the specific call site inside sendDM — the autosave branch
    // around the `this.messages.set(message.id, message)` write.
    expect(source).toMatch(
      /this\.messages\.set\s*\(\s*message\.id\s*,\s*message\s*\)\s*;[\s\S]{0,300}this\.save\s*\(\s*['"]dm_send['"]\s*\)/,
    );
  });

  it('handleIncomingMessage sites classify as raw (receiver-authority model)', () => {
    // Both branches of handleIncomingMessage — self-wrap replay
    // and genuine peer message — route through save('raw'). The
    // raw tag bypasses setStorageEntry and relies on read-time
    // downgrade to classify the entry as 'replicated' for peers.
    const rawCalls = [...source.matchAll(/this\.save\s*\(\s*['"]raw['"]\s*\)/g)];
    expect(rawCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('every save(...) call uses one of the declared entry types', () => {
    // TypeScript catches mismatches at compile time, but the grep
    // pin catches any future widening of the union that slips a new
    // tag into a call site without updating the declared set.
    const calls = [
      ...source.matchAll(/this\.save\s*\(\s*['"]([a-z_]+)['"]\s*\)/g),
    ];
    const tags = calls.map((m) => m[1]);
    const allowed = new Set(['dm_send', 'cache_index', 'raw']);
    for (const tag of tags) {
      expect(allowed.has(tag), `unexpected entryType: ${tag}`).toBe(true);
    }
    // Sanity: we expect at least 7 explicit call sites (the pre-T-D10
    // file had 7 this.save() calls). A count drop would suggest a
    // site was silently reverted to the default/no-arg signature.
    expect(tags.length).toBeGreaterThanOrEqual(7);
    // And each bucket must be populated at least once.
    expect(tags.filter((t) => t === 'dm_send').length).toBeGreaterThanOrEqual(1);
    expect(tags.filter((t) => t === 'cache_index').length).toBeGreaterThanOrEqual(1);
    expect(tags.filter((t) => t === 'raw').length).toBeGreaterThanOrEqual(1);
  });

  it('setStorageEntry falls back with once-per-provider-class logging', () => {
    // Matches the T-D7 steelman pattern — the fallback must log a
    // debug line once per provider-class so a silent loss of W11
    // stamping during a mixed-provider migration is visible in ops.
    expect(source).toMatch(/_w11FallbackLogged/);
    expect(source).toMatch(/\[W11\][\s\S]{0,120}setEntry not available/);
  });
});

describe('T-D10 setStorageEntry helper — dispatcher behaviour', () => {
  // Simulate the helper's dispatch logic directly (copy of the
  // CommunicationsModule method body). This decouples the test from
  // the heavy instantiation surface while pinning the contract:
  // setEntry is preferred when available, set is the fallback.
  async function setStorageEntry(
    storage: {
      set: (k: string, v: string) => Promise<void>;
      setEntry?: (k: string, v: string, t: string) => Promise<void>;
    },
    key: string,
    value: string,
    entryType: 'dm_send' | 'cache_index',
  ): Promise<void> {
    if (typeof storage.setEntry === 'function') {
      await storage.setEntry(key, value, entryType);
    } else {
      await storage.set(key, value);
    }
  }

  it('routes to setEntry with dm_send when the provider supports it', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'alice.messages', '[]', 'dm_send');
    expect(setEntry).toHaveBeenCalledWith('alice.messages', '[]', 'dm_send');
    expect(set).not.toHaveBeenCalled();
  });

  it('routes to setEntry with cache_index when the provider supports it', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'alice.messages', '[]', 'cache_index');
    expect(setEntry).toHaveBeenCalledWith('alice.messages', '[]', 'cache_index');
    expect(set).not.toHaveBeenCalled();
  });

  it('falls back to set when setEntry is absent', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set }, 'alice.messages', '[]', 'dm_send');
    expect(set).toHaveBeenCalledWith('alice.messages', '[]');
  });
});

describe('T-D10 writeMessagesKey — raw vs classified dispatch', () => {
  // Simulate the writeMessagesKey funnel directly. The `raw` branch
  // is the receiver-authority case: skip setStorageEntry (which
  // would reject a 'replicated' origin tag at assertOriginTagLocal)
  // and emit raw bytes so the read-time downgrade classifies the
  // envelope correctly for any peer that replicates this key.
  async function writeMessagesKey(
    storage: {
      set: (k: string, v: string) => Promise<void>;
      setEntry?: (k: string, v: string, t: string) => Promise<void>;
    },
    key: string,
    value: string,
    entryType: 'dm_send' | 'cache_index' | 'raw',
  ): Promise<void> {
    if (entryType === 'raw') {
      await storage.set(key, value);
      return;
    }
    if (typeof storage.setEntry === 'function') {
      await storage.setEntry(key, value, entryType);
    } else {
      await storage.set(key, value);
    }
  }

  it('raw path skips setEntry even when available (receiver-authority model)', async () => {
    // CRITICAL INVARIANT: the raw path MUST NOT call setEntry.
    // ProfileStorageProvider.setEntry validates via
    // assertOriginTagLocal which REJECTS 'replicated' — if this
    // test fails, an incoming-DM save would throw
    // SECURITY_ORIGIN_MISMATCH at the local write edge.
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await writeMessagesKey({ set, setEntry }, 'alice.messages', '[]', 'raw');
    expect(set).toHaveBeenCalledWith('alice.messages', '[]');
    expect(setEntry).not.toHaveBeenCalled();
  });

  it('dm_send path routes through setEntry with the correct tag', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await writeMessagesKey({ set, setEntry }, 'alice.messages', '[]', 'dm_send');
    expect(setEntry).toHaveBeenCalledWith('alice.messages', '[]', 'dm_send');
    expect(set).not.toHaveBeenCalled();
  });

  it('cache_index path routes through setEntry with the correct tag', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await writeMessagesKey({ set, setEntry }, 'alice.messages', '[]', 'cache_index');
    expect(setEntry).toHaveBeenCalledWith('alice.messages', '[]', 'cache_index');
    expect(set).not.toHaveBeenCalled();
  });

  it('raw path is a plain storage.set when setEntry is absent (same behaviour as available)', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await writeMessagesKey({ set }, 'alice.messages', '[]', 'raw');
    expect(set).toHaveBeenCalledWith('alice.messages', '[]');
  });
});
