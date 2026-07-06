/**
 * V6-RECOVER real-SDK integration tests.
 *
 * Test-coverage gap
 * -----------------
 * `tests/unit/modules/PaymentsModule.recipient-address-mismatch-recovery.test.ts`
 * exercises `tryRecoverSigningServiceForRecipient` and friends with the
 * SDK fully mocked at the import boundary (vi.mock for SigningService,
 * UnmaskedPredicate, TokenState, HashAlgorithm, ...). Those tests prove
 * the helper's iteration logic but NOT that the helper's notion of
 * "derived recipient address" agrees with the real SDK's notion when
 * `verifyRecipient` runs on the same inputs.
 *
 * `tests/unit/modules/PaymentsModule.proof-polling-persistence.test.ts`
 * issue-#269 tests cover the error-classification side: GIVEN the SDK
 * throws `VerificationError(Recipient address mismatch)`, the worker
 * routes to permanent-fail (not transient). That test mocks the throw
 * source — it does NOT prove the throw shouldn't have fired.
 *
 * The soak (`manual-test-full-recovery.sh`) routinely surfaces
 * `[ERROR] [V6-RECOVER] Stranded receive <hex> hit permanent recipient-
 * address mismatch (HD-index recovery exhausted) (no retry):
 * VerificationError: Recipient address mismatch` at §C → §D. With
 * only mocked-SDK helper tests + a mocked-throw classifier test, the
 * regression mode "tryRecover returns a candidate but the SDK still
 * rejects it" is not catchable by CI.
 *
 * What this file covers (Audit #333 V6-RECOVER test-gap layer 1)
 * --------------------------------------------------------------
 *   - Real SDK end-to-end: SigningService.createFromSecret →
 *     UnmaskedPredicate.create → reference.toAddress() — no mocks.
 *   - Happy path: sender targeted a sibling HD index that IS in the
 *     recipient's tracked-addresses inventory; tryRecover finds the
 *     matching signer; the recovered signer's predicate constructs
 *     the EXACT address the sender computed.
 *   - Negative path: sender targeted an HD index NOT in the
 *     recipient's inventory; tryRecover returns null (no false-positive
 *     candidate that the SDK would later reject).
 *   - Negative path: deriveAddressInfo() throws for one index but
 *     succeeds for another; iteration continues and finds the match.
 */

import { describe, expect, it, vi } from 'vitest';

// Real SDK — NO vi.mock for these imports.
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';

import {
  createPaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../modules/payments/PaymentsModule';
import type { AddressInfo } from '../../../core/crypto';
import type {
  FullIdentity,
  TrackedAddress,
  TxfStorageDataBase,
} from '../../../types';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle/oracle-provider';
import type { TokenStorageProvider } from '../../../storage/token-storage-provider';

// ---------------------------------------------------------------------------
// Minimal stubs for the non-recovery dependencies
// ---------------------------------------------------------------------------

function makeStubStorage(): StorageProvider {
  const m = new Map<string, string>();
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => m.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { m.set(k, v); }),
    remove: vi.fn(async (k: string) => { m.delete(k); }),
    has: vi.fn(async (k: string) => m.has(k)),
    keys: vi.fn(async () => Array.from(m.keys())),
    clear: vi.fn(async () => { m.clear(); }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeStubs(): {
  storage: StorageProvider;
  transport: TransportProvider;
  oracle: OracleProvider;
} {
  return {
    storage: makeStubStorage(),
    transport: {
      id: 'mock-transport',
      name: 'Mock Transport',
      type: 'p2p',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('connected'),
      setIdentity: vi.fn(),
      sendTokenTransfer: vi.fn(),
      onTokenTransfer: vi.fn().mockReturnValue(() => {}),
      onPaymentRequest: vi.fn().mockReturnValue(() => {}),
      onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    oracle: {
      id: 'mock-oracle',
      name: 'Mock Oracle',
      type: 'network',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('connected'),
      initialize: vi.fn().mockResolvedValue(undefined),
      getProof: vi.fn().mockResolvedValue(null),
      waitForProofSdk: vi.fn().mockResolvedValue(null),
      getStateTransitionClient: vi.fn().mockReturnValue({}),
      getTrustBase: vi.fn().mockReturnValue({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

function hexFromBytes(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function makeTracked(
  index: number,
  chainPubkey: string,
  directAddress: string,
): TrackedAddress {
  return {
    index,
    hidden: false,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    addressId: `DIRECT_idx${index}`,
    directAddress,
    chainPubkey,
  };
}

function makeAddressInfo(
  index: number,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  directAddress: string,
): AddressInfo {
  return {
    privateKey: hexFromBytes(privateKey),
    publicKey: hexFromBytes(publicKey),
    address: directAddress,
    path: `m/44'/0'/0'/0/${index}`,
    index,
  };
}

function makeDeps(input: {
  identity: FullIdentity;
  derivations: Map<number, AddressInfo>;
  trackedAddresses: ReadonlyArray<TrackedAddress>;
}): PaymentsModuleDependencies {
  const stubs = makeStubs();
  return {
    identity: input.identity,
    storage: stubs.storage,
    tokenStorageProviders: new Map<
      string,
      TokenStorageProvider<TxfStorageDataBase>
    >(),
    transport: stubs.transport,
    oracle: stubs.oracle,
    emitEvent: vi.fn(),
    getActiveAddresses: () => input.trackedAddresses,
    deriveAddressInfo: (idx: number) => {
      const info = input.derivations.get(idx);
      if (!info) {
        throw new Error(`No derivation fixture for index ${idx}`);
      }
      return info;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// Reach the private recovery helpers without losing static types.
interface RecoveryInternals {
  tryRecoverSigningServiceForRecipient: (
    sourceToken: { id: TokenId; type: TokenType },
    transferSalt: Uint8Array,
    expectedTransactionAddress: string,
  ) => Promise<{ signer: SigningService; index: number } | null>;
}
function recovery(m: ReturnType<typeof createPaymentsModule>): RecoveryInternals {
  return m as unknown as RecoveryInternals;
}

// ---------------------------------------------------------------------------
// Setup helper — build N real HD-index keypairs.
// ---------------------------------------------------------------------------

interface RealKey {
  privateKey: Uint8Array;
  signer: SigningService;
  chainPubkeyHex: string;
}

async function buildHdKey(seedSuffix: number): Promise<RealKey> {
  // Deterministic per index so failures are reproducible. We do not need
  // BIP32 derivation for this test — only "two distinct keys that the
  // SDK accepts" so the iteration logic can find one of them.
  const privateKey = new Uint8Array(32).fill(0xa0 + seedSuffix);
  const signer = await SigningService.createFromSecret(privateKey);
  // SigningService exposes `publicKey` as Uint8Array; the wallet stores
  // it as 33-byte compressed hex (the `chainPubkey` field).
  const pubBytes = signer.publicKey as Uint8Array;
  const chainPubkeyHex = hexFromBytes(pubBytes);
  return { privateKey, signer, chainPubkeyHex };
}

async function deriveDirectAddress(
  signer: SigningService,
  tokenId: TokenId,
  tokenType: TokenType,
  transferSalt: Uint8Array,
): Promise<string> {
  const predicate = await UnmaskedPredicate.create(
    tokenId,
    tokenType,
    signer,
    HashAlgorithm.SHA256,
    transferSalt,
  );
  const reference = await predicate.getReference();
  const address = await reference.toAddress();
  return address.address;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V6-RECOVER — real-SDK HD-index recovery integration', () => {
  describe('happy path: sender targeted sibling HD index in inventory', () => {
    it('tryRecover finds the matching signer AND the recovered signer derives the EXACT same address', async () => {
      // Two real HD keys.
      const keyZero = await buildHdKey(0);
      const keyOne = await buildHdKey(1);

      // Real tokenId + tokenType the source token is identified by.
      const tokenId = TokenId.fromJSON('aa'.repeat(32));
      const tokenType = TokenType.fromJSON('bb'.repeat(32));
      const transferSalt = new Uint8Array(32).fill(0xdd);

      // What the sender computed: the recipient's DIRECT address for
      // HD index 1, using REAL SDK predicate construction.
      const senderTargetedAddress = await deriveDirectAddress(
        keyOne.signer,
        tokenId,
        tokenType,
        transferSalt,
      );

      // Recipient's wallet state: active at index 0, but tracks both
      // index 0 and index 1 in its address book.
      const trackedZero = makeTracked(
        0,
        keyZero.chainPubkeyHex,
        await deriveDirectAddress(keyZero.signer, tokenId, tokenType, transferSalt),
      );
      const trackedOne = makeTracked(1, keyOne.chainPubkeyHex, senderTargetedAddress);

      const derivations = new Map<number, AddressInfo>();
      derivations.set(0, makeAddressInfo(
        0, keyZero.privateKey, keyZero.signer.publicKey as Uint8Array, trackedZero.directAddress,
      ));
      derivations.set(1, makeAddressInfo(
        1, keyOne.privateKey, keyOne.signer.publicKey as Uint8Array, trackedOne.directAddress,
      ));

      const identity: FullIdentity = {
        chainPubkey: keyZero.chainPubkeyHex,
        directAddress: trackedZero.directAddress,
        privateKey: hexFromBytes(keyZero.privateKey),
      };

      const module = createPaymentsModule();
      module.initialize(makeDeps({
        identity,
        derivations,
        trackedAddresses: [trackedZero, trackedOne],
      }));

      // The actual SUT call — a real SDK predicate is constructed
      // inside `tryRecoverSigningServiceForRecipient` for each
      // candidate and compared against `senderTargetedAddress`.
      const result = await recovery(module).tryRecoverSigningServiceForRecipient(
        { id: tokenId, type: tokenType },
        transferSalt,
        senderTargetedAddress,
      );

      expect(result).not.toBeNull();
      expect(result!.index).toBe(1);

      // The recovered signer's public key MUST match keyOne — this is
      // the layer the existing mock-based tests cannot prove.
      expect(hexFromBytes(result!.signer.publicKey as Uint8Array)).toBe(
        keyOne.chainPubkeyHex,
      );

      // Most importantly: using the recovered signer to construct the
      // same predicate the SDK's verifyRecipient uses gives back the
      // EXACT same address the sender targeted. If this assertion
      // holds, the SDK's downstream Token.update verifyRecipient
      // step CANNOT throw "Recipient address mismatch" — the address
      // the SDK computes from this signer + (tokenId, tokenType, salt)
      // is bit-for-bit identical to the sender's target.
      const rederived = await deriveDirectAddress(
        result!.signer,
        tokenId,
        tokenType,
        transferSalt,
      );
      expect(rederived).toBe(senderTargetedAddress);
    });
  });

  describe('negative path: sender targeted an HD index NOT in inventory', () => {
    it('tryRecover returns null (no false-positive that SDK would later reject)', async () => {
      const keyZero = await buildHdKey(0);
      const keyOne = await buildHdKey(1);
      const keyTwo = await buildHdKey(2);

      const tokenId = TokenId.fromJSON('aa'.repeat(32));
      const tokenType = TokenType.fromJSON('bb'.repeat(32));
      const transferSalt = new Uint8Array(32).fill(0xdd);

      // Sender targeted index 2's address — but recipient only tracks
      // indices 0 and 1.
      const senderTargetedAddress = await deriveDirectAddress(
        keyTwo.signer,
        tokenId,
        tokenType,
        transferSalt,
      );

      const trackedZero = makeTracked(0, keyZero.chainPubkeyHex,
        await deriveDirectAddress(keyZero.signer, tokenId, tokenType, transferSalt));
      const trackedOne = makeTracked(1, keyOne.chainPubkeyHex,
        await deriveDirectAddress(keyOne.signer, tokenId, tokenType, transferSalt));

      const derivations = new Map<number, AddressInfo>();
      derivations.set(0, makeAddressInfo(
        0, keyZero.privateKey, keyZero.signer.publicKey as Uint8Array, trackedZero.directAddress,
      ));
      derivations.set(1, makeAddressInfo(
        1, keyOne.privateKey, keyOne.signer.publicKey as Uint8Array, trackedOne.directAddress,
      ));

      const identity: FullIdentity = {
        chainPubkey: keyZero.chainPubkeyHex,
        directAddress: trackedZero.directAddress,
        privateKey: hexFromBytes(keyZero.privateKey),
      };

      const module = createPaymentsModule();
      module.initialize(makeDeps({
        identity,
        derivations,
        trackedAddresses: [trackedZero, trackedOne],
      }));

      const result = await recovery(module).tryRecoverSigningServiceForRecipient(
        { id: tokenId, type: tokenType },
        transferSalt,
        senderTargetedAddress,
      );

      // No tracked index produces the sender's target address — the
      // helper MUST return null. (A false-positive candidate would
      // surface as the soak's V6-RECOVER ERROR a step later when
      // Token.update runs verifyRecipient.)
      expect(result).toBeNull();
    });
  });

  describe('composition: tryRecover signer + real predicate matches transferTx recipient', () => {
    // The full `finalizeTransferToken` path is:
    //   1. recipientAddress = transferTx.data.recipient
    //   2. expectedTransactionAddress = resolveExpectedTransactionAddress(recipientAddress)
    //   3. primaryDerivedAddress = deriveRecipientAddressFor(currentSigner, sourceToken, salt)
    //   4. IF primary ≠ expected: chosenSigner = tryRecover(sourceToken, salt, expected).signer
    //   5. recipientPredicate = UnmaskedPredicate.create(sourceToken.id, sourceToken.type,
    //                                                    chosenSigner, SHA256, salt)
    //   6. recipientState = new TokenState(recipientPredicate, null)
    //   7. stClient.finalizeTransaction(trustBase, sourceToken, recipientState, transferTx, ...)
    //
    // The SDK's verifyRecipient inside step 7 compares the predicate's
    // derived address against transferTx.data.recipient.address. If
    // step 5's `chosenSigner` derives an address matching `expected`,
    // and `expected` matches `transferTx.data.recipient.address` (true
    // for DIRECT scheme), then verifyRecipient cannot throw "Recipient
    // address mismatch".
    //
    // This test exercises steps 3–5 with real SDK objects and asserts
    // the predicate derived at step 5 matches the transferTx target.
    // The previous test covers step 4 in isolation; this test proves
    // the COMPOSITION across steps 3–5 holds end-to-end at the real-
    // address layer, closing the "tryRecover returns a candidate but
    // the SDK still rejects it" risk.
    it('produces a recipientPredicate whose address === transferTx.data.recipient.address (DIRECT scheme)', async () => {
      const keyZero = await buildHdKey(0);
      const keyOne = await buildHdKey(1);

      const tokenId = TokenId.fromJSON('aa'.repeat(32));
      const tokenType = TokenType.fromJSON('bb'.repeat(32));
      const transferSalt = new Uint8Array(32).fill(0xdd);

      // Sender computed `transferTx.data.recipient.address` from index 1.
      const transferTxRecipientAddress = await deriveDirectAddress(
        keyOne.signer,
        tokenId,
        tokenType,
        transferSalt,
      );

      // Step 3 — primary derived address from the current (index 0) signer.
      const primaryDerived = await deriveDirectAddress(
        keyZero.signer,
        tokenId,
        tokenType,
        transferSalt,
      );
      // Pre-condition for the recovery branch: primary ≠ expected.
      expect(primaryDerived).not.toBe(transferTxRecipientAddress);

      // Set up wallet for steps 4–5.
      const trackedZero = makeTracked(0, keyZero.chainPubkeyHex, primaryDerived);
      const trackedOne = makeTracked(1, keyOne.chainPubkeyHex, transferTxRecipientAddress);
      const derivations = new Map<number, AddressInfo>();
      derivations.set(0, makeAddressInfo(
        0, keyZero.privateKey, keyZero.signer.publicKey as Uint8Array, primaryDerived,
      ));
      derivations.set(1, makeAddressInfo(
        1, keyOne.privateKey, keyOne.signer.publicKey as Uint8Array, transferTxRecipientAddress,
      ));
      const identity: FullIdentity = {
        chainPubkey: keyZero.chainPubkeyHex,
        directAddress: primaryDerived,
        privateKey: hexFromBytes(keyZero.privateKey),
      };
      const module = createPaymentsModule();
      module.initialize(makeDeps({
        identity,
        derivations,
        trackedAddresses: [trackedZero, trackedOne],
      }));

      // Step 4 — tryRecover.
      const recovered = await recovery(module).tryRecoverSigningServiceForRecipient(
        { id: tokenId, type: tokenType },
        transferSalt,
        transferTxRecipientAddress, // DIRECT scheme → expected === transferTx.recipient.address
      );
      expect(recovered).not.toBeNull();
      expect(recovered!.index).toBe(1);

      // Step 5 — build recipientPredicate from the recovered signer with
      // the REAL SDK and re-derive its address.
      const recipientPredicate = await UnmaskedPredicate.create(
        tokenId,
        tokenType,
        recovered!.signer,
        HashAlgorithm.SHA256,
        transferSalt,
      );
      const reference = await recipientPredicate.getReference();
      const recipientAddress = (await reference.toAddress()).address;

      // Composition assertion: the recipientPredicate that
      // finalizeTransferToken would pass into stClient.finalizeTransaction
      // derives an address byte-equal to transferTx.data.recipient.address.
      // The SDK's verifyRecipient inside finalizeTransaction CANNOT throw
      // "Recipient address mismatch" against this state.
      expect(recipientAddress).toBe(transferTxRecipientAddress);
    });
  });

  describe('iteration tolerates per-index deriveAddressInfo throws', () => {
    it('skips a throwing index and continues — finds the match further down', async () => {
      const keyZero = await buildHdKey(0);
      const keyOne = await buildHdKey(1);
      const keyTwo = await buildHdKey(2);

      const tokenId = TokenId.fromJSON('aa'.repeat(32));
      const tokenType = TokenType.fromJSON('bb'.repeat(32));
      const transferSalt = new Uint8Array(32).fill(0xdd);

      // Sender targeted index 2.
      const senderTargetedAddress = await deriveDirectAddress(
        keyTwo.signer,
        tokenId,
        tokenType,
        transferSalt,
      );

      const trackedZero = makeTracked(0, keyZero.chainPubkeyHex,
        await deriveDirectAddress(keyZero.signer, tokenId, tokenType, transferSalt));
      const trackedOne = makeTracked(1, keyOne.chainPubkeyHex,
        await deriveDirectAddress(keyOne.signer, tokenId, tokenType, transferSalt));
      const trackedTwo = makeTracked(2, keyTwo.chainPubkeyHex, senderTargetedAddress);

      const derivations = new Map<number, AddressInfo>();
      derivations.set(0, makeAddressInfo(
        0, keyZero.privateKey, keyZero.signer.publicKey as Uint8Array, trackedZero.directAddress,
      ));
      // Index 1's derivation FAILS — the helper must continue.
      // (Map.get returns undefined → the deriveAddressInfo throws in makeDeps.)
      derivations.set(2, makeAddressInfo(
        2, keyTwo.privateKey, keyTwo.signer.publicKey as Uint8Array, trackedTwo.directAddress,
      ));

      const identity: FullIdentity = {
        chainPubkey: keyZero.chainPubkeyHex,
        directAddress: trackedZero.directAddress,
        privateKey: hexFromBytes(keyZero.privateKey),
      };

      const module = createPaymentsModule();
      module.initialize(makeDeps({
        identity,
        derivations,
        trackedAddresses: [trackedZero, trackedOne, trackedTwo],
      }));

      const result = await recovery(module).tryRecoverSigningServiceForRecipient(
        { id: tokenId, type: tokenType },
        transferSalt,
        senderTargetedAddress,
      );

      // Index 1 threw — the loop continued to index 2 and found the match.
      expect(result).not.toBeNull();
      expect(result!.index).toBe(2);
    });
  });
});
