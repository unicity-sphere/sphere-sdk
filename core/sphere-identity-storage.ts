/**
 * Sphere identity + wallet-key storage — Wave 6-P2-8b extraction from
 * `core/Sphere.ts`.
 *
 * Owns the wallet's key-material persistence and identity derivation
 * boot path:
 *   - {@link storeMnemonicImpl} / {@link storeMasterKeyImpl} — Wave G.6
 *     transactional persistence (setMany-preferred, F.56 fallback with
 *     I.3 in-memory rollback).
 *   - {@link finalizeWalletCreationImpl} — WALLET_EXISTS marker after
 *     successful create/import.
 *   - {@link loadIdentityFromStorageImpl} — cold load path with
 *     Issue #309 primary→fallback identity read + Steelman⁵² partial-
 *     write corruption detector.
 *   - {@link initializeIdentityFromMnemonicImpl} /
 *     {@link initializeIdentityFromMasterKeyImpl} — derive the in-memory
 *     Identity from the persisted secret.
 *
 * Behavior-preserving: bodies moved verbatim behind an
 * {@link IdentityStorageHost} shim. Every JSDoc + inline comment on the
 * moved methods is preserved. Sphere.ts retains thin private
 * delegators.
 */

import { logger } from './logger';
import { SphereError } from './errors';
import {
  identityFromMnemonicSync,
  deriveKeyAtPath,
  getPublicKey,
  sha256,
  publicKeyToAddress,
  generateAddressFromMasterKey,
  type MasterKey,
  type AddressInfo,
} from './crypto';
import {
  STORAGE_KEYS_GLOBAL,
  DEFAULT_BASE_PATH,
} from '../constants';
import type {
  StorageProvider,
} from '../storage';
import type {
  FullIdentity,
  TrackedAddress,
  DerivationMode,
  WalletSource,
} from '../types';
import { deriveL3PredicateAddress } from './Sphere';

/** Mutable version of FullIdentity — matches Sphere's internal alias. */
export type MutableFullIdentity = {
  -readonly [K in keyof FullIdentity]: FullIdentity[K];
};

/**
 * Host shim for the identity-storage ops. Mirrors the Sphere-private
 * state and helpers the moved methods reach for. Multiple fields are
 * mutable — the storeMnemonic / storeMasterKey I.3 snapshot-and-
 * restore pattern requires read + write access, and the loadIdentity
 * path writes the derived identity fields back onto the class.
 */
export interface IdentityStorageHost {
  readonly _storage: StorageProvider;
  readonly _fallbackStorage: StorageProvider | null;
  _mnemonic: string | null;
  _masterKey: MasterKey | null;
  _source: WalletSource;
  _derivationMode: DerivationMode;
  _basePath: string;
  _identity: MutableFullIdentity | null;
  _currentAddressIndex: number;
  _trackedAddressesLoaded: boolean;
  readonly _addressNametags: Map<string, Map<number, string>>;

  encrypt(data: string): string;
  decrypt(encrypted: string): string | null;
  initializeIdentityFromMnemonic(mnemonic: string, derivationPath?: string): Promise<void>;
  initializeIdentityFromMasterKey(
    masterKey: string,
    chainCode?: string,
    derivationPath?: string,
  ): Promise<void>;
  loadTrackedAddresses(): Promise<void>;
  loadAddressNametags(): Promise<void>;
  ensureAddressTracked(index: number): Promise<TrackedAddress>;
  _deriveAddressInternal(index: number, isChange?: boolean): AddressInfo;
  _updateCachedProxyAddress(): Promise<void>;
}

export async function storeMnemonicImpl(
  host: IdentityStorageHost,
  mnemonic: string,
  derivationPath?: string,
  basePath?: string,
): Promise<void> {
  // Wave G.6: prefer the atomic setMany() path when the provider
  // implements it (IndexedDB cross-key transaction, FileStorage
  // file-lock-guarded snapshot rewrite). Either every key lands or
  // none do — no rollback needed. Falls back to the F.56 best-
  // effort transactional rollback for providers that don't.
  //
  // Wave I.3 CRITICAL: snapshot in-memory state BEFORE mutating
  // and BEFORE awaiting setMany. If setMany throws (quota, IDB
  // abort, lock-contended file write), the in-memory state was
  // already mutated — caller's `sphere.getMnemonic()` would return
  // an unstored mnemonic, silent divergence between live instance
  // and disk. Restore on catch matches the F.51 fallback contract.
  const encrypted = host.encrypt(mnemonic);
  const prevMnemonic = host._mnemonic;
  const prevSource = host._source;
  const prevDerivationMode = host._derivationMode;
  const prevBasePath = host._basePath;
  host._mnemonic = mnemonic;
  host._source = 'mnemonic';
  host._derivationMode = 'bip32';
  const effectiveBasePath = basePath ?? DEFAULT_BASE_PATH;
  host._basePath = effectiveBasePath;
  const entries: Array<[string, string]> = [
    [STORAGE_KEYS_GLOBAL.MNEMONIC, encrypted],
    [STORAGE_KEYS_GLOBAL.BASE_PATH, effectiveBasePath],
    [STORAGE_KEYS_GLOBAL.DERIVATION_MODE, host._derivationMode],
    [STORAGE_KEYS_GLOBAL.WALLET_SOURCE, host._source],
  ];
  if (derivationPath) {
    entries.splice(1, 0, [STORAGE_KEYS_GLOBAL.DERIVATION_PATH, derivationPath]);
  }
  if (host._storage.setMany) {
    try {
      await host._storage.setMany(entries);
    } catch (err) {
      host._mnemonic = prevMnemonic;
      host._source = prevSource;
      host._derivationMode = prevDerivationMode;
      host._basePath = prevBasePath;
      throw err;
    }
    return;
  }
  // Steelman⁵¹ CRITICAL fallback: best-effort transactional rollback.
  // See pre-G.6 implementation for full rationale — kept verbatim
  // for providers without setMany().
  const writtenKeys: string[] = [];
  const writeKey = async (key: string, value: string): Promise<void> => {
    await host._storage.set(key, value);
    writtenKeys.push(key);
  };
  try {
    for (const [k, v] of entries) {
      await writeKey(k, v);
    }
  } catch (writeErr) {
    for (const k of writtenKeys.reverse()) {
      try {
        await host._storage.remove(k);
      } catch {
        /* best-effort cleanup */
      }
    }
    // Wave I.3: restore in-memory state on rollback so caller does
    // not observe an unstored mnemonic via sphere.getMnemonic().
    host._mnemonic = prevMnemonic;
    host._source = prevSource;
    host._derivationMode = prevDerivationMode;
    host._basePath = prevBasePath;
    throw writeErr;
  }
  // Note: WALLET_EXISTS is set in finalizeWalletCreation() after successful initialization
}

export async function storeMasterKeyImpl(
  host: IdentityStorageHost,
  masterKey: string,
  chainCode?: string,
  derivationPath?: string,
  basePath?: string,
  derivationMode?: DerivationMode,
): Promise<void> {
  // Wave G.6: prefer setMany when available; fall back to F.56
  // best-effort rollback otherwise.
  //
  // Wave I.3 CRITICAL: snapshot in-memory state before mutating;
  // restore on any failure so caller does not observe unstored
  // master-key state (silent disk/memory divergence).
  const encrypted = host.encrypt(masterKey);
  const prevMnemonic = host._mnemonic;
  const prevSource = host._source;
  const prevDerivationMode = host._derivationMode;
  const prevBasePath = host._basePath;
  host._source = 'file';
  host._mnemonic = null;
  if (derivationMode) {
    host._derivationMode = derivationMode;
  } else {
    host._derivationMode = chainCode ? 'bip32' : 'wif_hmac';
  }
  const effectiveBasePath = basePath ?? DEFAULT_BASE_PATH;
  host._basePath = effectiveBasePath;
  const entries: Array<[string, string]> = [
    [STORAGE_KEYS_GLOBAL.MASTER_KEY, encrypted],
    [STORAGE_KEYS_GLOBAL.BASE_PATH, effectiveBasePath],
    [STORAGE_KEYS_GLOBAL.DERIVATION_MODE, host._derivationMode],
    [STORAGE_KEYS_GLOBAL.WALLET_SOURCE, host._source],
  ];
  if (chainCode) entries.splice(1, 0, [STORAGE_KEYS_GLOBAL.CHAIN_CODE, chainCode]);
  if (derivationPath) entries.splice(chainCode ? 2 : 1, 0, [STORAGE_KEYS_GLOBAL.DERIVATION_PATH, derivationPath]);
  if (host._storage.setMany) {
    try {
      await host._storage.setMany(entries);
    } catch (err) {
      host._mnemonic = prevMnemonic;
      host._source = prevSource;
      host._derivationMode = prevDerivationMode;
      host._basePath = prevBasePath;
      throw err;
    }
    return;
  }
  const writtenKeys: string[] = [];
  const writeKey = async (key: string, value: string): Promise<void> => {
    await host._storage.set(key, value);
    writtenKeys.push(key);
  };
  try {
    for (const [k, v] of entries) {
      await writeKey(k, v);
    }
  } catch (writeErr) {
    for (const k of writtenKeys.reverse()) {
      try {
        await host._storage.remove(k);
      } catch {
        /* best-effort cleanup */
      }
    }
    host._mnemonic = prevMnemonic;
    host._source = prevSource;
    host._derivationMode = prevDerivationMode;
    host._basePath = prevBasePath;
    throw writeErr;
  }
  // Note: WALLET_EXISTS is set in finalizeWalletCreation() after successful initialization
}

/**
 * Mark wallet as fully created (after successful initialization)
 * This is called at the end of create()/import() to ensure wallet is only
 * marked as existing after all initialization steps succeed.
 */
export async function finalizeWalletCreationImpl(host: IdentityStorageHost): Promise<void> {
  await host._storage.set(STORAGE_KEYS_GLOBAL.WALLET_EXISTS, 'true');
}

export async function loadIdentityFromStorageImpl(host: IdentityStorageHost): Promise<void> {
  // Issue #309 — read each identity key with a primary→fallback
  // retry. The primary path can fail in two ways for a Profile-mode
  // boot whose local Helia blockstore has lost a referenced block:
  //   (a) the read throws a chained `LoadBlockFailedError`
  //       (OrbitDB walks the OpLog head, hits the missing block);
  //   (b) the read swallows the throw upstream and returns `null`
  //       (e.g. Profile's getEnvelopePayload catches the envelope
  //       decode failure but still can't reach the raw bytes).
  // In either case, if a legacy IndexedDB fallback is available it
  // still holds the encrypted-with-password identity material at the
  // same key shape, so the wallet can boot from cached local state.
  // The helper retries the same key against `this._fallbackStorage`
  // on any null-or-throw outcome from the primary.
  const readIdentityKey = async (key: string): Promise<string | null> => {
    let primaryValue: string | null = null;
    let primaryThrew: unknown = null;
    try {
      primaryValue = await host._storage.get(key);
    } catch (err) {
      primaryThrew = err;
    }
    if (primaryValue !== null && primaryValue !== undefined) {
      return primaryValue;
    }
    if (!host._fallbackStorage) {
      if (primaryThrew !== null) throw primaryThrew;
      return null;
    }
    // Fallback path. Log so operators can see we're booting from
    // legacy state, not the post-migration Profile state.
    logger.warn(
      'Sphere',
      `Identity read for "${key}" missing from primary storage` +
        (primaryThrew instanceof Error
          ? ` (threw: ${primaryThrew.message})`
          : '') +
        `; consulting fallbackStorage (legacy cached identity).`,
    );
    // Review fix #1 — Wrap the fallback read in its own try/catch.
    // Previously a throw from the fallback shadowed the primary's
    // throw on the way out; operators care most about the primary
    // (typically a chained LoadBlockFailedError) because it identifies
    // the missing block CID. On a both-throw outcome the primary error
    // is rethrown, with the fallback error attached as `cause` for
    // forensics.
    let fallbackValue: string | null = null;
    let fallbackThrew: unknown = null;
    try {
      fallbackValue = await host._fallbackStorage.get(key);
    } catch (err) {
      fallbackThrew = err;
    }
    if (fallbackValue !== null && fallbackValue !== undefined) {
      // Lazy backfill — write the fallback value into primary so the
      // next boot finds it without consulting fallback again. With
      // the IDENTITY_KEYS ⊂ CACHE_ONLY_KEYS fix in
      // `profile-storage-provider.ts`, identity-key writes route to
      // the Profile localCache (IndexedDB) only — they never reach
      // OrbitDB / IPFS. So the backfill is the right move: it
      // silences the per-boot "missing from primary; consulting
      // fallbackStorage" warning for wallets that predate this fix
      // without re-introducing the OrbitDB leak the cache-only
      // routing closes.
      //
      // Best-effort: a failure to backfill is non-fatal — the read
      // already succeeded and the caller has the value. We log at
      // debug so operators can see why a subsequent boot still
      // re-falls-back if the backfill kept failing.
      try {
        await host._storage.set(key, fallbackValue);
      } catch (err) {
        logger.debug(
          'Sphere',
          `Identity backfill of "${key}" into primary storage failed; the ` +
            `next boot will re-consult fallback. (${
              err instanceof Error ? err.message : String(err)
            })`,
        );
      }
      return fallbackValue;
    }
    // Neither side has it. The primary error wins when both threw —
    // it's the more diagnostic of the two for the typical Profile-
    // mode failure mode. Fallback error is preserved as `cause`.
    if (primaryThrew !== null) {
      if (
        fallbackThrew !== null &&
        primaryThrew instanceof Error &&
        fallbackThrew instanceof Error &&
        (primaryThrew as { cause?: unknown }).cause === undefined
      ) {
        try {
          Object.defineProperty(primaryThrew, 'cause', {
            value: fallbackThrew,
            enumerable: false,
            writable: true,
            configurable: true,
          });
        } catch {
          // Defining `cause` on the original error is best-effort;
          // a frozen or hostile Error subclass would refuse.
        }
      }
      throw primaryThrew;
    }
    if (fallbackThrew !== null) {
      // Primary returned null cleanly but fallback threw —
      // surface the fallback error so the operator sees a
      // diagnosable failure rather than a silent "no wallet".
      throw fallbackThrew;
    }
    return null;
  };

  // Load keys that are saved with 'default' address (before identity is set)
  const encryptedMnemonic = await readIdentityKey(STORAGE_KEYS_GLOBAL.MNEMONIC);
  const encryptedMasterKey = await readIdentityKey(STORAGE_KEYS_GLOBAL.MASTER_KEY);
  const chainCode = await readIdentityKey(STORAGE_KEYS_GLOBAL.CHAIN_CODE);
  const derivationPath = await readIdentityKey(STORAGE_KEYS_GLOBAL.DERIVATION_PATH);
  const savedBasePath = await readIdentityKey(STORAGE_KEYS_GLOBAL.BASE_PATH);
  const savedDerivationMode = await readIdentityKey(STORAGE_KEYS_GLOBAL.DERIVATION_MODE);
  const savedSource = await readIdentityKey(STORAGE_KEYS_GLOBAL.WALLET_SOURCE);
  const savedAddressIndex = await readIdentityKey(STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX);

  // Steelman⁵² CRITICAL: detect partial-write corruption. F.56's
  // best-effort rollback in storeMnemonic/storeMasterKey may itself
  // fail (e.g., if remove() also hits the same lock contention)
  // — the wallet file would then have MNEMONIC/MASTER_KEY plus
  // SOME metadata keys but be missing OTHERS. We only fire on the
  // partial state — if all three metadata keys are missing, treat
  // as a legacy / external-app-created wallet (e.g., a plaintext
  // mnemonic dropped into wallet.json by an external tool, or an
  // older SDK build that did not write the metadata triplet).
  // Defaults apply for those flows.
  //
  // The genuine corruption signature is "at least one metadata
  // key written, at least one missing" — that pattern can only
  // result from an aborted multi-key write whose rollback also
  // failed, and silently applying defaults to the missing fields
  // would derive the wrong identity for the persisted MNEMONIC.
  //
  // Issue #309 review (Finding #3) — when `fallbackStorage` is set,
  // these values are the MERGED view: any key not in primary was
  // satisfied from fallback. The partial-write detector's invariant
  // therefore weakens: a "primary partial + fallback complete" wallet
  // looks identical to a "primary complete + fallback unused" wallet.
  // Acceptable for the migration-recovery flow this option exists for
  // — both shapes derive the SAME identity, so the wallet boots
  // correctly. A genuine partial-write that ALSO had a holey fallback
  // would still trip the detector. Document the weakening explicitly
  // so future readers don't tighten the check by accident.
  if (encryptedMnemonic || encryptedMasterKey) {
    const present: string[] = [];
    const missing: string[] = [];
    (savedBasePath ? present : missing).push('BASE_PATH');
    (savedDerivationMode ? present : missing).push('DERIVATION_MODE');
    (savedSource ? present : missing).push('WALLET_SOURCE');
    // Steelman⁵² + ⁵² test fix: only fire on STRONG partial-write
    // signature — at least 2 of the 3 metadata keys present and
    // at least 1 missing. This pattern is unique to modern writes
    // that got most of the way through but not all the way; a
    // legacy / external-app wallet typically has 0 or 1 of these
    // keys (no metadata or just WALLET_SOURCE for older SDK
    // builds), and we don't want to brick load() for those.
    if (present.length >= 2 && missing.length > 0) {
      throw new SphereError(
        `Wallet storage is in an inconsistent state — key material is present along ` +
          `with partial metadata (have: ${present.join(', ')}; missing: ${missing.join(', ')}). ` +
          `This indicates a partial-write corruption (e.g., an aborted Sphere.create / ` +
          `Sphere.import whose rollback also failed). Run Sphere.clear() and re-import ` +
          `the wallet from its mnemonic to recover.`,
        'STORAGE_CORRUPTED',
      );
    }
  }

  // Restore wallet metadata
  host._basePath = savedBasePath ?? DEFAULT_BASE_PATH;
  host._derivationMode = (savedDerivationMode as DerivationMode) ?? 'bip32';
  host._source = (savedSource as WalletSource) ?? 'unknown';
  host._currentAddressIndex = savedAddressIndex ? parseInt(savedAddressIndex, 10) : 0;

  if (encryptedMnemonic) {
    const mnemonic = host.decrypt(encryptedMnemonic);
    if (!mnemonic) {
      throw new SphereError('Failed to decrypt mnemonic', 'STORAGE_ERROR');
    }
    host._mnemonic = mnemonic;
    host._source = 'mnemonic';
    await host.initializeIdentityFromMnemonic(mnemonic, derivationPath ?? undefined);
  } else if (encryptedMasterKey) {
    const masterKey = host.decrypt(encryptedMasterKey);
    if (!masterKey) {
      throw new SphereError('Failed to decrypt master key', 'STORAGE_ERROR');
    }
    host._mnemonic = null;
    if (host._source === 'unknown') {
      host._source = 'file';
    }
    await host.initializeIdentityFromMasterKey(
      masterKey,
      chainCode ?? undefined,
      derivationPath ?? undefined,
    );
  } else {
    throw new SphereError('No wallet data found in storage', 'NOT_INITIALIZED');
  }

  // Now that identity is restored, set it on storage so subsequent reads use correct address
  if (host._identity) {
    host._storage.setIdentity(host._identity);
  }

  // Load tracked addresses registry (with migration from old format)
  await host.loadTrackedAddresses();
  host._trackedAddressesLoaded = true;
  // Load nametag cache
  await host.loadAddressNametags();

  // Ensure current address is tracked
  const trackedEntry = await host.ensureAddressTracked(host._currentAddressIndex);
  const nametag = host._addressNametags.get(trackedEntry.addressId)?.get(0);

  // If we have a saved address index > 0 and master key, re-derive identity
  if (host._currentAddressIndex > 0 && host._masterKey) {
    const addressInfo = host._deriveAddressInternal(host._currentAddressIndex, false);
    const ipnsHash = sha256(addressInfo.publicKey, 'hex').slice(0, 40);
    const predicateAddress = await deriveL3PredicateAddress(addressInfo.privateKey);

    host._identity = {
      privateKey: addressInfo.privateKey,
      chainPubkey: addressInfo.publicKey,
      directAddress: predicateAddress,
      ipnsName: '12D3KooW' + ipnsHash,
      nametag,
    };
    host._storage.setIdentity(host._identity);
    logger.debug('Sphere', `Restored to address ${host._currentAddressIndex}:`, host._identity.directAddress);
  } else if (host._identity && nametag) {
    // Restore nametag from cache
    host._identity.nametag = nametag;
  }
  await host._updateCachedProxyAddress();
}

export async function initializeIdentityFromMnemonicImpl(
  host: IdentityStorageHost,
  mnemonic: string,
  derivationPath?: string,
): Promise<void> {
  // Use base path (e.g., m/44'/0'/0') and append chain/index
  const basePath = derivationPath ?? DEFAULT_BASE_PATH;
  const fullPath = `${basePath}/0/0`;

  // Generate master key from mnemonic using BIP39/BIP32
  const masterKey = identityFromMnemonicSync(mnemonic);

  // Derive key at full path (e.g., m/44'/0'/0'/0/0)
  const derivedKey = deriveKeyAtPath(
    masterKey.privateKey,
    masterKey.chainCode,
    fullPath,
  );

  // Get public key from derived private key
  const publicKey = getPublicKey(derivedKey.privateKey);

  // Generate proper bech32 address
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const address = publicKeyToAddress(publicKey, 'alpha');

  // Generate IPNS name from public key hash
  const ipnsHash = sha256(publicKey, 'hex').slice(0, 40);

  // Derive L3 predicate address (DIRECT://...)
  const predicateAddress = await deriveL3PredicateAddress(derivedKey.privateKey);

  host._identity = {
    privateKey: derivedKey.privateKey,
    chainPubkey: publicKey,
    directAddress: predicateAddress,
    ipnsName: '12D3KooW' + ipnsHash,
  };

  // Store master key info for future derivations
  host._masterKey = masterKey;
}

export async function initializeIdentityFromMasterKeyImpl(
  host: IdentityStorageHost,
  masterKey: string,
  chainCode?: string,
  _derivationPath?: string,
): Promise<void> {
  // Use _basePath (already set by storeMasterKey) for consistency with deriveAddress/scan.
  // Previously used derivationPath param which was undefined for file imports,
  // causing identity to derive at DEFAULT_BASE_PATH instead of the wallet's actual path.
  const basePath = host._basePath;
  const fullPath = `${basePath}/0/0`;

  let privateKey: string;

  if (chainCode) {
    // Full BIP32 derivation with chain code
    const derivedKey = deriveKeyAtPath(masterKey, chainCode, fullPath);
    privateKey = derivedKey.privateKey;

    host._masterKey = {
      privateKey: masterKey,
      chainCode,
    };
  } else {
    // WIF/HMAC derivation without chain code
    // Uses HMAC-SHA512(masterKey, path) to derive child keys (legacy webwallet format)
    const addr0 = generateAddressFromMasterKey(masterKey, 0);
    privateKey = addr0.privateKey;

    // Store masterKey for future deriveAddress() calls (chainCode unused in wif_hmac mode)
    host._masterKey = {
      privateKey: masterKey,
      chainCode: '',
    };
  }

  const publicKey = getPublicKey(privateKey);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const address = publicKeyToAddress(publicKey, 'alpha');
  const ipnsHash = sha256(publicKey, 'hex').slice(0, 40);

  // Derive L3 predicate address (DIRECT://...)
  const predicateAddress = await deriveL3PredicateAddress(privateKey);

  host._identity = {
    privateKey,
    chainPubkey: publicKey,
    directAddress: predicateAddress,
    ipnsName: '12D3KooW' + ipnsHash,
  };
}
