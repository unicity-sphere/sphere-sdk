/**
 * Test-mint helper — mint a token directly via the live aggregator.
 *
 * Used by e2e tests that need to put real cryptographic tokens into a
 * wallet without going through the faucet (which delivers via Nostr DM).
 * Suitable for any test scenario that wants to bypass Nostr entirely.
 *
 * The minted token has:
 *   - random TokenId (32 bytes)
 *   - the UNICITY_TOKEN_TYPE (standard fungible token)
 *   - the caller-specified CoinId + amount
 *   - recipient = the wallet's own UnmaskedPredicate address (self-mint)
 *   - reason = null (no genesis reason — accepted by the aggregator
 *     for test mints; the user explicitly opted into "test tokens
 *     without valid genesis reason")
 *
 * Steps:
 *   1. Build MintTransactionData
 *   2. Submit MintCommitment to the aggregator
 *   3. Wait for the aggregator inclusion proof
 *   4. Reconstruct the token locally with the same predicate +
 *      state used as the mint recipient
 *   5. Return the finalized Token
 *
 * The caller is responsible for inserting the token into the wallet
 * via `sphere.payments.addToken(token)`.
 */

import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';
import { sha256 } from '@noble/hashes/sha2.js';

import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService.js';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId.js';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType.js';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState.js';
import { Token } from '@unicitylabs/state-transition-sdk/lib/token/Token.js';
import { TokenCoinData } from '@unicitylabs/state-transition-sdk/lib/token/fungible/TokenCoinData.js';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js';
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment.js';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js';
import { UnmaskedPredicateReference } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';
import type { IMintTransactionReason } from '@unicitylabs/state-transition-sdk/lib/transaction/IMintTransactionReason.js';

import type { Sphere } from '../../../core/Sphere';

/** Standard Unicity fungible token type hex (used by faucet-minted tokens too). */
const UNICITY_TOKEN_TYPE_HEX =
  'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';

function strictHexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${clean.length}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    const b = parseInt(clean.slice(i, i + 2), 16);
    if (Number.isNaN(b)) {
      throw new Error(`invalid hex char at index ${i}`);
    }
    bytes[i / 2] = b;
  }
  return bytes;
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export interface MintTestTokenInput {
  /** Live Sphere instance — we read its oracle for aggregator + trust base. */
  readonly sphere: Sphere;
  /** Wallet private key (hex). Required because Sphere does not expose it
   * via the public Identity surface; the test caller derives it from the
   * mnemonic via core/crypto's BIP32 path or carries it through Sphere.import(). */
  readonly privateKey: string;
  /** Coin ID (hex) — typically 4 bytes (`fffeefee` for UCT, etc.). */
  readonly coinIdHex: string;
  /** Amount in smallest unit (bigint). */
  readonly amount: bigint;
}

export interface MintTestTokenOutput {
  /** The finalized SDK Token. */
  readonly token: Token<IMintTransactionReason>;
  /** Hex of the random tokenId — useful for assertions. */
  readonly tokenIdHex: string;
}

/**
 * Mint a test token via the live aggregator and return the finalized SDK Token.
 *
 * The caller can then inject the token into the wallet via
 * `sphere.payments.addToken(...)` (sphere-sdk's documented public API for
 * adding a Token to the in-memory inventory).
 */
export async function mintTestTokenToSelf(
  input: MintTestTokenInput,
): Promise<MintTestTokenOutput> {
  const secret = strictHexToBytes(input.privateKey);
  const signingService = await SigningService.createFromSecret(secret);

  // Token identity — random bytes; on each call this produces a unique
  // tokenId, so concurrent mints across two devices never collide.
  const tokenIdBytes = randomBytes(32);
  const tokenId = new TokenId(tokenIdBytes);

  const tokenType = new TokenType(strictHexToBytes(UNICITY_TOKEN_TYPE_HEX));

  // Coin data — single-coin token with the caller-specified amount.
  const coinId = new CoinId(strictHexToBytes(input.coinIdHex));
  const coinData = TokenCoinData.create([[coinId, input.amount]]);

  // Random salt — deterministic predicate derivation gates on the salt,
  // so each mint produces a unique recipient address even for the same
  // signing key.
  const salt = randomBytes(32);

  // Recipient = wallet's own address (self-mint).
  const recipientRef = await UnmaskedPredicateReference.create(
    tokenType,
    signingService.algorithm,
    signingService.publicKey,
    HashAlgorithm.SHA256,
  );
  const recipient = await recipientRef.toAddress();

  // Build mint transaction data — `reason: null` is the "test mint"
  // shape (no genesis reason). Production faucet flow uses a typed
  // reason; tests can omit it.
  const mintData = await MintTransactionData.create(
    tokenId,
    tokenType,
    null, // tokenData (no metadata)
    coinData,
    recipient,
    salt,
    null, // recipientDataHash
    null, // reason
  );

  const commitment = await MintCommitment.create(mintData);

  // Pull the StateTransitionClient + trust base from the Sphere's oracle.
  // Sphere does not expose these as public getters, but the OracleProvider
  // on `_payments.deps` does. `submitMintCommitment` lives on the
  // StateTransitionClient (which wraps the lower-level AggregatorClient);
  // `waitInclusionProof` also takes the StateTransitionClient.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oracle = (input.sphere as any)._payments?.deps?.oracle;
  if (!oracle) {
    throw new Error('mintTestTokenToSelf: Sphere has no oracle wired');
  }
  const client = oracle.getStateTransitionClient?.() as StateTransitionClient | null;
  const trustBase = oracle.getRootTrustBase?.() as RootTrustBase | null;
  if (!client) {
    throw new Error('mintTestTokenToSelf: oracle has no StateTransitionClient');
  }
  if (!trustBase) throw new Error('mintTestTokenToSelf: oracle has no RootTrustBase');

  // Submit + wait for inclusion proof.
  const submitResp = await client.submitMintCommitment(commitment);
  // Both SUCCESS (first submission) and REQUEST_ID_EXISTS (idempotent
  // retry) are healthy outcomes per NametagMinter's pattern.
  const status = (submitResp as { status?: string }).status;
  if (status && status !== 'SUCCESS' && status !== 'REQUEST_ID_EXISTS') {
    throw new Error(`mintTestTokenToSelf: aggregator rejected commitment: ${status}`);
  }

  const inclusionProof = await waitInclusionProof(trustBase, client, commitment);
  const genesisTransaction = commitment.toTransaction(inclusionProof);

  // Build the recipient predicate + state, then finalize the token.
  const predicate = await UnmaskedPredicate.create(
    tokenId,
    tokenType,
    signingService,
    HashAlgorithm.SHA256,
    salt,
  );
  const state = new TokenState(predicate, null);
  const token = await Token.mint(trustBase, state, genesisTransaction);

  // Sanity tag for observability in test logs.
  const tokenIdHex = Array.from(tokenIdBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return { token, tokenIdHex };
}

/** Convenience: build a deterministic CID for content-address sanity-checks.
 *  Not used by the mint helper itself but exported for callers that want
 *  a stable CID handle on JSON CARs they build. */
export function cidForBytes(bytes: Uint8Array): string {
  return CID.createV1(raw.code, createDigest(0x12, sha256(bytes))).toString();
}
