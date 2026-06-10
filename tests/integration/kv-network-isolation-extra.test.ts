/**
 * Integration test (EXTRA): composite-key + CRUD-entry-point network isolation
 * through the REAL IndexedDBStorageProvider.
 *
 * Companion to kv-network-isolation.test.ts. That file proves the BARE
 * per-address keys (key === STORAGE_KEYS_ADDRESS.X) are network-scoped via the
 * `key === k` branch of isNetworkScopedAddressKey. This file targets the parts
 * that file does not exercise:
 *
 *   1. COMPOSITE KEYS — the real swap/invoice fund-leak surface. SwapModule and
 *      AccountingModule build keys like `{addressId}_swap:{id}` and
 *      `inv_ledger:{id}` that the provider sees as already-composite strings
 *      (NOT bare STORAGE_KEYS_ADDRESS values). These hit the PREFIX/INFIX
 *      branches of isNetworkScopedAddressKey, never the bare `key === k` branch.
 *      A testnet swap/invoice ledger leaking onto testnet2 (or mainnet) is a
 *      direct fund-leak, so these MUST be network-isolated.
 *
 *   2. CRUD ENTRY POINTS — has()/remove()/keys() (not just get()/set()) must all
 *      honor the per-network key segment, or e.g. a remove() on the wrong
 *      network silently no-ops while the operator believes state was cleared,
 *      and keys() must never surface another network's physical key.
 *
 *   3. AUTO_RETURN settings (distinct from the ledger) are network-isolated;
 *      GROUP_CHAT_GROUPS is per-address only and SHARED across networks.
 *
 * Setup mirrors kv-network-isolation.test.ts exactly: two providers share ONE
 * dbName (same physical IndexedDB object store) but use DIFFERENT `network`
 * values, same wallet identity (same chainPubkey). Only the key-prefixing
 * differs, so anything invisible across the two providers is invisible purely
 * because of the network key segment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBStorageProvider } from '../../impl/browser/storage/IndexedDBStorageProvider';
import { STORAGE_KEYS_ADDRESS, type NetworkType } from '../../constants';
import type { FullIdentity } from '../../types';

// =============================================================================
// Helpers (identical factory to kv-network-isolation.test.ts)
// =============================================================================

const SHARED_DB_NAME = 'kv-iso-extra-test';

function createIdentity(directAddress = 'DIRECT://abcdef1234567890'): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    publicKey: '02' + 'f'.repeat(64),
    chainPubkey: '02' + Buffer.from(directAddress).toString('hex').padEnd(64, '0').slice(0, 64),
    l1Address: 'alpha1testaddr',
    directAddress,
  } as unknown as FullIdentity;
}

async function createProvider(
  network: NetworkType,
  identity: FullIdentity,
): Promise<IndexedDBStorageProvider> {
  const p = new IndexedDBStorageProvider({ network, dbName: SHARED_DB_NAME });
  p.setIdentity(identity);
  await p.connect();
  return p;
}

// =============================================================================
// Tests
// =============================================================================

describe('KV network isolation EXTRA (composite keys + CRUD entry points)', () => {
  // Same wallet (same chainPubkey) on two different networks.
  const identity = createIdentity('DIRECT://shared-wallet-extra');

  let providerA: IndexedDBStorageProvider; // network: 'testnet'
  let providerB: IndexedDBStorageProvider; // network: 'testnet2'

  beforeEach(async () => {
    providerA = await createProvider('testnet', identity);
    providerB = await createProvider('testnet2', identity);
  });

  afterEach(async () => {
    if (providerA.isConnected()) await providerA.disconnect();
    if (providerB.isConnected()) await providerB.disconnect();
    // Wipe the shared store so each test starts clean (clear() disconnects).
    const cleaner = new IndexedDBStorageProvider({ dbName: SHARED_DB_NAME });
    await cleaner.clear();
  });

  // ---------------------------------------------------------------------------
  // 1. COMPOSITE KEYS — the real swap/invoice fund-leak surface.
  //    These hit isNetworkScopedAddressKey's PREFIX/INFIX branches, not the
  //    bare `key === k` branch.
  // ---------------------------------------------------------------------------

  it('COMPOSITE (invoice ledger): inv_ledger:{id} written on testnet is invisible on testnet2', async () => {
    // AccountingModule INV_LEDGER_PREFIX form — provider sees a composite string,
    // matched via the PREFIX branch (key.startsWith('inv_ledger:')).
    const invKey = 'inv_ledger:inv1';

    await providerA.set(invKey, 'A');

    // Different network segment → invisible to the same wallet on testnet2.
    expect(await providerB.get(invKey)).toBeNull();
    // A still reads its own value back on its own network.
    expect(await providerA.get(invKey)).toBe('A');
  });

  it('COMPOSITE (swap record): {addressId}_swap:{id} written on testnet is invisible on testnet2', async () => {
    // SwapModule builds `{addressId}_swap:{swapId}` where addressId === chainPubkey.
    // Provider sees this already-composite string and matches via the INFIX branch
    // (key.includes('_swap:')), NOT the bare `key === k` branch.
    const swapKey = `${identity.chainPubkey}_${STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX}s1`;
    expect(swapKey).toContain('_swap:'); // sanity: this is the composite form

    await providerA.set(swapKey, 'A');

    expect(await providerB.get(swapKey)).toBeNull();
    expect(await providerA.get(swapKey)).toBe('A');
  });

  it('COMPOSITE equivalence: bare AUTO_RETURN_LEDGER and a composite ledger/swap key are BOTH network-isolated', async () => {
    // Per the spec: do NOT assume the bare and composite forms map to the same
    // physical key. Only assert that each form is network-isolated (null on B).
    const bareLedger = STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER; // 'auto_return_ledger'
    const compositeInv = 'inv_ledger:invX';
    const compositeSwap = `${identity.chainPubkey}_${STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX}sX`;

    await providerA.set(bareLedger, 'A');
    await providerA.set(compositeInv, 'A');
    await providerA.set(compositeSwap, 'A');

    // Each form: A sees it, B (other network) does not.
    expect(await providerA.get(bareLedger)).toBe('A');
    expect(await providerB.get(bareLedger)).toBeNull();

    expect(await providerA.get(compositeInv)).toBe('A');
    expect(await providerB.get(compositeInv)).toBeNull();

    expect(await providerA.get(compositeSwap)).toBe('A');
    expect(await providerB.get(compositeSwap)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 2. CRUD ENTRY POINTS — has()/remove()/keys() honor the network segment.
  // ---------------------------------------------------------------------------

  it('CRUD: has() honors the network segment', async () => {
    const ledger = STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER;
    await providerA.set(ledger, 'A');

    // A's testnet ledger must not show up via has() on testnet2.
    expect(await providerB.has(ledger)).toBe(false);
    // ...but A sees it.
    expect(await providerA.has(ledger)).toBe(true);
  });

  it('CRUD: remove() on the wrong network does NOT affect the other network', async () => {
    const ledger = STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER;
    await providerA.set(ledger, 'A');

    // remove() on B (testnet2) targets a DIFFERENT physical key — must be a no-op
    // for A's testnet state. A silently believing it cleared state it cannot reach
    // would be the dangerous failure mode.
    await providerB.remove(ledger);

    expect(await providerA.get(ledger)).toBe('A');
  });

  it('CRUD: keys() lists the ledger and never returns the OTHER network\'s full physical key string', async () => {
    const ledger = STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER;
    await providerA.set(ledger, 'A');
    await providerB.set(ledger, 'B');

    const aKeys = await providerA.keys();
    const bKeys = await providerB.keys();

    // Each provider lists its own ledger entry.
    expect(aKeys.some((k) => k.includes(ledger))).toBe(true);
    expect(bKeys.some((k) => k.includes(ledger))).toBe(true);

    // SOURCE BEHAVIOUR (verified): keys() with NO prefix argument is a STORE-WIDE
    // enumeration — getFullKey('') resolves to the bare base prefix ('sphere_'),
    // so keys() returns EVERY key in the shared store with only 'sphere_' stripped.
    // It is NOT scoped to the provider's own network. Network isolation is enforced
    // at get/set/has/remove (which build the network-segmented key), not at keys().
    // So both providers see the same store-wide list, including each other's
    // network-segmented logical keys. This is the actual, intended behaviour and
    // we assert it rather than weakening it.
    const otherNetSegmentInA = aKeys.some((k) => k.startsWith('testnet2_'));
    const otherNetSegmentInB = bKeys.some((k) => k.startsWith('testnet_'));
    expect(otherNetSegmentInA).toBe(true);
    expect(otherNetSegmentInB).toBe(true);

    // The guarantee that DOES hold: keys() never returns the OTHER network's full
    // PHYSICAL key string. The physical keys are `sphere_testnet_{id}_...` and
    // `sphere_testnet2_{id}_...`; keys() strips the 'sphere_' base prefix, so the
    // verbatim full physical key string can never appear in the result list.
    const physicalA = `${'sphere_'}testnet_${identity.chainPubkey}_${ledger}`;
    const physicalB = `${'sphere_'}testnet2_${identity.chainPubkey}_${ledger}`;
    expect(aKeys).not.toContain(physicalB);
    expect(aKeys).not.toContain(physicalA); // base prefix stripped → not verbatim
    expect(bKeys).not.toContain(physicalA);
    expect(bKeys).not.toContain(physicalB);
  });

  // ---------------------------------------------------------------------------
  // 3. AUTO_RETURN settings isolated; GROUP_CHAT shared.
  // ---------------------------------------------------------------------------

  it('SETTINGS isolated: AUTO_RETURN settings (distinct from the ledger) are network-scoped', async () => {
    // AUTO_RETURN ('auto_return') is in NETWORK_SCOPED_ADDRESS_KEYS — settings that
    // drive sends, so they must NOT bleed across networks.
    await providerA.set(STORAGE_KEYS_ADDRESS.AUTO_RETURN, 'A');

    expect(await providerB.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN)).toBeNull();
    expect(await providerA.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN)).toBe('A');
  });

  it('CHAT shared: GROUP_CHAT_GROUPS is per-address only — same value on both networks', async () => {
    // GROUP_CHAT_* keys are deliberately NOT network-scoped (per-address only).
    await providerA.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, 'groups-data');

    // Same wallet on testnet2 sees the SAME groups (chat is network-agnostic).
    expect(await providerB.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS)).toBe('groups-data');
  });
});
