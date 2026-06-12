/**
 * normalizeVaultNetwork + public exports (Task 8.1, finding #9, DESIGN §7.1).
 *
 * The vault NETWORK literal is canonicalized `testnet → testnet2` at the vault
 * boundary so the AEAD vault key, the wireKey and the entry AAD all derive from
 * ONE canonical literal. A wallet configured with the alias `'testnet'` and one
 * configured with `'testnet2'` therefore share vault keys — an entry sealed under
 * one opens under the other (the §7.1 network-switch re-derive).
 *
 * ⚠️ Migration-v2 trap (asserted in code comments, not weakened here): the literal
 * is canonicalized ONLY at the vault boundary (AEAD / wireKey / AAD). STORAGE
 * scoping elsewhere in the SDK is still keyed by the LITERAL network name — these
 * two facts must not be conflated.
 *
 * The public-surface half asserts the main `index.ts` re-exports the vault
 * providers, the `vault-aead` public API, `normalizeVaultNetwork`, and the
 * relevant public types (compile-checked via the `tsc --noEmit` step + the
 * runtime value checks below).
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { normalizeVaultNetwork } from '../../../storage/remote/normalize-network';
import { deriveVaultKey } from '../../../vault-aead/derive';
import { wireKey } from '../../../storage/remote/wire-key';
import { sealVaultEntry, openVaultEntry } from '../../../vault-aead/entry';

import * as sdk from '../../../index';

const PRIV = '7d'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));

describe('normalizeVaultNetwork', () => {
  it('aliases testnet → testnet2 and passes other networks through unchanged', () => {
    expect(normalizeVaultNetwork('testnet')).toBe('testnet2');
    expect(normalizeVaultNetwork('testnet2')).toBe('testnet2');
    expect(normalizeVaultNetwork('mainnet')).toBe('mainnet');
    expect(normalizeVaultNetwork('dev')).toBe('dev');
  });

  it('§7.1 round-trip: an entry sealed under the testnet alias opens after a testnet2 re-derive', () => {
    // Seal configured with the alias 'testnet'; re-derive keys configured with
    // 'testnet2'. Both go through normalizeVaultNetwork → identical canonical
    // literal → identical AEAD vault key + wireKey → the blob survives the switch.
    const sealNet = normalizeVaultNetwork('testnet');
    const openNet = normalizeVaultNetwork('testnet2');
    expect(sealNet).toBe(openNet);

    const plainKey = 'token-abc';
    const sealKey = deriveVaultKey(PRIV, sealNet);
    const openKey = deriveVaultKey(PRIV, openNet);
    expect(bytesToHex(sealKey)).toBe(bytesToHex(openKey)); // same canonical literal → same key

    const wkSeal = wireKey(PRIV, sealNet, plainKey);
    const wkOpen = wireKey(PRIV, openNet, plainKey);
    expect(wkSeal).toBe(wkOpen); // wireKey survives the alias too

    const plaintext = new TextEncoder().encode(JSON.stringify({ amount: '1000000' }));
    const payload = sealVaultEntry({
      network: sealNet,
      ownerId: PUB,
      key: wkSeal,
      version: 1,
      plaintext,
      key32: sealKey,
    });
    // The re-derived (testnet2) side opens it: same network/owner/key/version AAD.
    const opened = openVaultEntry({
      network: openNet,
      ownerId: PUB,
      key: wkOpen,
      version: 1,
      payload,
      key32: openKey,
    });
    expect(bytesToHex(opened)).toBe(bytesToHex(plaintext));
  });

  it('a NON-normalized testnet seal cannot be opened by a testnet2 re-derive (proves the alias is load-bearing)', () => {
    // Sealed with the RAW alias literal (skipping normalize) → a different AAD
    // network field → a testnet2 open throws. This is what normalizeVaultNetwork
    // prevents.
    const key = deriveVaultKey(PRIV, 'testnet2');
    const wk = wireKey(PRIV, 'testnet2', 'k');
    const pt = new TextEncoder().encode('x');
    const payload = sealVaultEntry({ network: 'testnet', ownerId: PUB, key: wk, version: 1, plaintext: pt, key32: key });
    expect(() =>
      openVaultEntry({ network: 'testnet2', ownerId: PUB, key: wk, version: 1, payload, key32: key }),
    ).toThrow();
  });
});

describe('public vault exports (index.ts)', () => {
  it('re-exports the vault providers as constructable classes', () => {
    expect(typeof sdk.RemoteTokenStorageProvider).toBe('function');
    expect(typeof sdk.CourierDeliveryProvider).toBe('function');
  });

  it('re-exports normalizeVaultNetwork', () => {
    expect(typeof sdk.normalizeVaultNetwork).toBe('function');
    expect(sdk.normalizeVaultNetwork('testnet')).toBe('testnet2');
  });

  it('re-exports the vault-aead public API', () => {
    expect(typeof sdk.seal).toBe('function');
    expect(typeof sdk.open).toBe('function');
    expect(typeof sdk.deriveVaultKey).toBe('function');
    expect(typeof sdk.deriveCourierKey).toBe('function');
    expect(typeof sdk.lengthDelim).toBe('function');
    expect(typeof sdk.u64be).toBe('function');
    expect(typeof sdk.u32be).toBe('function');
    expect(typeof sdk.assertOnCurve).toBe('function');
    expect(typeof sdk.ecdhX).toBe('function');
    expect(typeof sdk.sealVaultEntry).toBe('function');
    expect(typeof sdk.openVaultEntry).toBe('function');
    expect(typeof sdk.sealCourierEnvelope).toBe('function');
    expect(typeof sdk.openCourierEnvelope).toBe('function');
    expect(typeof sdk.packCourier).toBe('function');
    expect(typeof sdk.unpackCourier).toBe('function');
  });
});
