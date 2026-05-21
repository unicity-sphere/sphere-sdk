/**
 * Token Deconstruction (WU-06)
 *
 * Decomposes ITokenJson tokens into content-addressed DAG elements,
 * inserting them into an ElementPool. Each helper creates UxfElement
 * objects bottom-up and returns the ContentHash of the element placed
 * in the pool.
 *
 * The input type is `unknown` to support both ITokenJson (canonical)
 * and TxfToken (sphere-sdk) shapes with runtime detection.
 *
 * @module uxf/deconstruct
 */

import { encode } from '@ipld/dag-cbor';

import type {
  ContentHash,
  UxfElement,
  UxfElementHeader,
  UxfElementType,
} from './types.js';
import { ElementPool } from './element-pool.js';
import { UxfError } from './errors.js';

// ---------------------------------------------------------------------------
// Internals -- raw record types for duck-typed input
// ---------------------------------------------------------------------------

/** Minimal shape of ITokenStateJson (shared between ITokenJson and TxfToken). */
interface StateShape {
  readonly predicate: string;
  readonly data: string | null;
}

/** Minimal shape of IAuthenticatorJson. */
interface AuthenticatorShape {
  readonly algorithm: string;
  readonly publicKey: string;
  readonly signature: string;
  readonly stateHash: string;
}

/** Minimal shape of a single SMT path step. */
interface SmtStepShape {
  readonly data: string | null;
  readonly path: string;
}

/** Minimal shape of ISparseMerkleTreePathJson. */
interface SmtPathShape {
  readonly root: string;
  readonly steps: ReadonlyArray<SmtStepShape>;
}

/** Minimal shape of IInclusionProofJson. */
interface InclusionProofShape {
  readonly authenticator: AuthenticatorShape | null;
  readonly merkleTreePath: SmtPathShape;
  readonly transactionHash: string | null;
  readonly unicityCertificate: string;
}

/** Minimal shape of IMintTransactionDataJson. */
interface MintDataShape {
  readonly tokenId: string;
  readonly tokenType: string;
  readonly coinData: ReadonlyArray<readonly [string, string]> | null;
  readonly tokenData: string | null;
  readonly salt: string;
  readonly recipient: string;
  readonly recipientDataHash: string | null;
  readonly reason: unknown | null;
}

/**
 * Minimal shape of IMintTransactionJson / genesis.
 *
 * #202 — `inclusionProof` is nullable to express pending genesis (mint
 * commitment not yet submitted / not yet proven). Mirrors the existing
 * `TransferTxShape.inclusionProof` nullable behavior so genesis and
 * transactions have symmetric handling.
 */
interface GenesisShape {
  readonly data: MintDataShape;
  readonly inclusionProof: InclusionProofShape | null;
}

/** Minimal shape of ITransferTransactionDataJson. */
interface TransferDataShape {
  readonly sourceState: StateShape;
  readonly recipient: string;
  readonly salt: string;
  readonly recipientDataHash: string | null;
  readonly message: string | null;
  readonly nametags: unknown[];
}

/** Minimal shape of ITransferTransactionJson. */
interface TransferTxShape {
  readonly data: TransferDataShape;
  readonly inclusionProof: InclusionProofShape | null;
}

/** Minimal top-level token shape (ITokenJson). */
interface TokenShape {
  readonly version: string;
  readonly state: StateShape;
  readonly genesis: GenesisShape;
  readonly transactions: TransferTxShape[];
  readonly nametags: unknown[];
}

// ---------------------------------------------------------------------------
// Default element header
// ---------------------------------------------------------------------------

/**
 * Creates the default element header used by all Phase 1 elements.
 */
function makeHeader(): UxfElementHeader {
  return {
    representation: 1,
    semantics: 1,
    kind: 'default',
    predecessor: null,
  };
}

// ---------------------------------------------------------------------------
// Element builder helper
// ---------------------------------------------------------------------------

/**
 * Shorthand to create and put a UxfElement into the pool.
 */
function putElement(
  pool: ElementPool,
  type: UxfElementType,
  content: Record<string, unknown>,
  children: Record<string, ContentHash | ContentHash[] | null>,
): ContentHash {
  const element: UxfElement = {
    header: makeHeader(),
    type,
    content,
    children,
  };
  return pool.put(element);
}

// ---------------------------------------------------------------------------
// Hex normalization
// ---------------------------------------------------------------------------

/**
 * Lowercase a hex string. Returns empty string for null/undefined/empty.
 */
function lowerHex(value: string | null | undefined): string {
  if (value == null || value === '') return '';
  return value.toLowerCase();
}

/**
 * Lowercase a hex string, preserving null.
 */
function lowerHexNullable(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value === '') return '';
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Pre-validation
// ---------------------------------------------------------------------------

/**
 * Validates that the input is a usable token and not a placeholder stub.
 *
 * #202 update — `_pendingFinalization` is NO LONGER rejected. UXF now
 * supports pending tokens (no proven genesis, no proven transfer) so that
 * cross-device profile sync and Nostr-shipped self-sufficient bundles can
 * carry the full lifecycle of a token, not just its post-finalization
 * form. The `_pendingFinalization` field is a wallet-local hint
 * (preserved through the SDK's sdkData but DROPPED on UXF deconstruct →
 * assemble round-trip, like any non-schema top-level field); it doesn't
 * affect UXF semantics any more.
 *
 * `_placeholder` is still rejected because a placeholder is a UI
 * stand-in with no `genesis` at all — there's nothing to deconstruct.
 */
function validateToken(token: unknown): asserts token is TokenShape {
  if (!token || typeof token !== 'object') {
    throw new UxfError('INVALID_PACKAGE', 'Token input must be a non-null object');
  }

  const obj = token as Record<string, unknown>;

  if (obj._placeholder === true) {
    throw new UxfError(
      'INVALID_PACKAGE',
      'Cannot ingest placeholder tokens (no genesis field)',
    );
  }

  if (!obj.genesis || typeof obj.genesis !== 'object') {
    throw new UxfError('INVALID_PACKAGE', 'Token must have a genesis field');
  }

  if (!obj.state || typeof obj.state !== 'object') {
    throw new UxfError('INVALID_PACKAGE', 'Token must have a state field');
  }

  // Steelman²⁸ note: assert genesis.data.tokenId is a non-empty 64-char
  // lowercase hex string. Without this, malformed tokens silently coerce
  // tokenId='' via lowerHex(null), producing manifest entries keyed by
  // an empty string — hard to remove and prone to collision.
  const genesis = obj.genesis as Record<string, unknown>;
  const data = genesis.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') {
    throw new UxfError('INVALID_PACKAGE', 'Token genesis must have a data field');
  }
  const tokenId = data.tokenId;
  if (typeof tokenId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(tokenId)) {
    throw new UxfError(
      'INVALID_PACKAGE',
      `Token genesis.data.tokenId must be 64-char hex, got ${typeof tokenId === 'string' ? `"${tokenId}"` : String(tokenId)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Leaf element deconstructors
// ---------------------------------------------------------------------------

/**
 * Deconstruct a TokenState into a `token-state` element.
 *
 * Predicate and data are stored inline as lowercased hex strings.
 * No children.
 */
export function deconstructState(
  pool: ElementPool,
  state: StateShape,
): ContentHash {
  return putElement(
    pool,
    'token-state',
    {
      predicate: lowerHex(state.predicate),
      data: lowerHexNullable(state.data),
    },
    {},
  );
}

/**
 * Deconstruct an Authenticator into an `authenticator` element.
 */
export function deconstructAuthenticator(
  pool: ElementPool,
  auth: AuthenticatorShape,
): ContentHash {
  return putElement(
    pool,
    'authenticator',
    {
      algorithm: auth.algorithm,
      publicKey: lowerHex(auth.publicKey),
      signature: lowerHex(auth.signature),
      stateHash: lowerHex(auth.stateHash),
    },
    {},
  );
}

/**
 * Deconstruct a SparseMerkleTreePath into an `smt-path` element.
 *
 * Segments are stored inline (Decision 5). Each segment's `data` is a
 * lowercased hex string (or empty string for null/empty subtrees) and
 * `path` is kept as a decimal bigint string (NOT hex).
 */
export function deconstructSmtPath(
  pool: ElementPool,
  merkleTreePath: SmtPathShape,
): ContentHash {
  const segments = merkleTreePath.steps.map((step) => ({
    data: step.data == null ? null : lowerHex(step.data),
    path: step.path, // decimal bigint string, keep as-is
  }));

  return putElement(
    pool,
    'smt-path',
    {
      root: lowerHex(merkleTreePath.root),
      segments,
    },
    {},
  );
}

/**
 * Deconstruct a UnicityCertificate hex blob into a `unicity-certificate`
 * element. Stored opaquely as lowercased hex.
 */
export function deconstructUnicityCertificate(
  pool: ElementPool,
  certHex: string,
): ContentHash {
  return putElement(
    pool,
    'unicity-certificate',
    { raw: lowerHex(certHex) },
    {},
  );
}

/**
 * Deconstruct an InclusionProof into an `inclusion-proof` element.
 *
 * Children: authenticator, merkleTreePath, unicityCertificate.
 * Content: transactionHash (inline, lowercased hex).
 */
export function deconstructInclusionProof(
  pool: ElementPool,
  proof: InclusionProofShape,
): ContentHash {
  const authenticatorHash =
    proof.authenticator != null
      ? deconstructAuthenticator(pool, proof.authenticator)
      : null;

  const merkleTreePathHash = deconstructSmtPath(pool, proof.merkleTreePath);
  const unicityCertificateHash = deconstructUnicityCertificate(
    pool,
    proof.unicityCertificate,
  );

  return putElement(
    pool,
    'inclusion-proof',
    {
      transactionHash: lowerHexNullable(proof.transactionHash),
    },
    {
      authenticator: authenticatorHash,
      merkleTreePath: merkleTreePathHash,
      unicityCertificate: unicityCertificateHash,
    },
  );
}

/**
 * Encode the mint `reason` field into opaque bytes.
 *
 * - null -> null
 * - string -> UTF-8 encoded Uint8Array
 * - object (ISplitMintReasonJson) -> dag-cbor encoded Uint8Array
 */
function encodeReason(reason: unknown): Uint8Array | null {
  if (reason == null) {
    return null;
  }

  if (typeof reason === 'string') {
    return new TextEncoder().encode(reason);
  }

  // Object -- encode via dag-cbor (handles ISplitMintReasonJson and any
  // other structured reason values).
  return encode(reason);
}

/**
 * Deconstruct MintTransactionData into a `genesis-data` element.
 */
export function deconstructGenesisData(
  pool: ElementPool,
  data: MintDataShape,
): ContentHash {
  // coinData: normalize null to empty array, keep tuples as [string, string]
  const coinData: ReadonlyArray<readonly [string, string]> =
    data.coinData ?? [];

  return putElement(
    pool,
    'genesis-data',
    {
      tokenId: lowerHex(data.tokenId),
      tokenType: lowerHex(data.tokenType),
      coinData: coinData.map(([coinId, amount]) => [coinId, amount] as const),
      tokenData: lowerHex(data.tokenData),
      salt: lowerHex(data.salt),
      recipient: data.recipient,
      recipientDataHash: lowerHexNullable(data.recipientDataHash),
      reason: encodeReason(data.reason),
    },
    {},
  );
}

// ---------------------------------------------------------------------------
// State derivation (DOMAIN-CONSTRAINTS Section 3)
// ---------------------------------------------------------------------------

/**
 * Derives all intermediate states needed for genesis destination and
 * per-transaction source/destination states.
 *
 * Returns an object with:
 * - genesisDestState: the state after genesis (TokenState shape)
 * - txSourceStates[i]: state BEFORE transaction[i]
 * - txDestStates[i]: state AFTER transaction[i]
 */
interface DerivedStates {
  genesisDestState: StateShape;
  txSourceStates: StateShape[];
  txDestStates: StateShape[];
}

function deriveAllStates(token: TokenShape): DerivedStates {
  const txs = token.transactions;

  // Genesis destination state
  let genesisDestState: StateShape;
  if (txs.length > 0) {
    // First transaction's sourceState is the genesis destination
    genesisDestState = txs[0].data?.sourceState ?? token.state;
  } else {
    genesisDestState = token.state;
  }

  const txSourceStates: StateShape[] = [];
  const txDestStates: StateShape[] = [];

  for (let i = 0; i < txs.length; i++) {
    // Source state for tx[i]
    if (i === 0) {
      txSourceStates.push(genesisDestState);
    } else {
      // Use tx[i]'s own sourceState if available, otherwise fall back to
      // the previous transaction's destination state
      const src = txs[i].data?.sourceState ?? txDestStates[i - 1];
      txSourceStates.push(src);
    }

    // Destination state for tx[i]
    if (i < txs.length - 1) {
      // Next transaction's source state is this transaction's destination
      const dest = txs[i + 1].data?.sourceState ?? token.state;
      txDestStates.push(dest);
    } else {
      // Last transaction's destination is the current state
      txDestStates.push(token.state);
    }
  }

  return { genesisDestState, txSourceStates, txDestStates };
}

// ---------------------------------------------------------------------------
// Composite element deconstructors
// ---------------------------------------------------------------------------

/**
 * Deconstruct a GenesisTransaction into a `genesis` element.
 *
 * Children: data (genesis-data), inclusionProof (nullable; #202), destinationState (token-state).
 *
 * #202 — `genesis.inclusionProof` is nullable to express V5/V4-pending
 * tokens whose mint commitment has not yet been submitted or proven.
 * Symmetric with `deconstructTransaction`'s existing nullable proof
 * handling. Pre-#202 this asserted a non-null proof, propagating
 * `Cannot read properties of null (reading 'authenticator')` from
 * `deconstructInclusionProof` when callers passed a pending genesis.
 */
export function deconstructGenesis(
  pool: ElementPool,
  genesis: GenesisShape,
  destinationState: StateShape,
): ContentHash {
  const dataHash = deconstructGenesisData(pool, genesis.data);
  let inclusionProofHash: ContentHash | null = null;
  if (genesis.inclusionProof != null) {
    inclusionProofHash = deconstructInclusionProof(pool, genesis.inclusionProof);
  }
  const destinationStateHash = deconstructState(pool, destinationState);

  return putElement(pool, 'genesis', {}, {
    data: dataHash,
    inclusionProof: inclusionProofHash,
    destinationState: destinationStateHash,
  });
}

/**
 * #202 — Deconstruct a pending-authenticator into a dedicated element.
 *
 * Wire shape matches the standard `AuthenticatorShape` (publicKey,
 * algorithm, signature, stateHash). Distinct element type ID so the
 * "submitted-but-not-yet-proven" semantic is explicit in the canonical
 * DAG rather than overloaded onto `authenticator`.
 *
 * On assemble, this element is materialized as `tx._wallet.authenticator
 * = {...}` so wallet code retains the legacy ad-hoc field name introduced
 * by saveCommitmentOnlyToken (V6-direct).
 */
export function deconstructPendingAuthenticator(
  pool: ElementPool,
  auth: AuthenticatorShape,
): ContentHash {
  return putElement(
    pool,
    'pending-authenticator',
    {
      algorithm: auth.algorithm,
      publicKey: lowerHex(auth.publicKey),
      signature: lowerHex(auth.signature),
      stateHash: lowerHex(auth.stateHash),
    },
    {},
  );
}

/**
 * Deconstruct TransferTransactionData into a `transaction-data` element.
 *
 * Content: recipient, salt, recipientDataHash, message, nametagRefs.
 * No children.
 */
function deconstructTransferData(
  pool: ElementPool,
  txData: TransferDataShape,
  maxDepth: number,
): ContentHash {
  // Recursively deconstruct nametag tokens embedded in the transfer data
  const nametagRefs: ContentHash[] = [];
  if (Array.isArray(txData.nametags)) {
    for (const nt of txData.nametags) {
      if (isTokenObject(nt)) {
        nametagRefs.push(deconstructTokenInternal(pool, nt as TokenShape, maxDepth - 1));
      }
    }
  }

  return putElement(
    pool,
    'transaction-data',
    {
      recipient: txData.recipient,
      salt: lowerHex(txData.salt),
      recipientDataHash: lowerHexNullable(txData.recipientDataHash),
      message: txData.message ?? null,
      nametagRefs,
    },
    {},
  );
}

/**
 * Deconstruct a TransferTransaction into a `transaction` element.
 *
 * sourceState and destinationState are pre-derived StateShape objects.
 * Children: sourceState, data, inclusionProof, destinationState,
 * pendingAuthenticator (#202).
 *
 * For uncommitted transactions, data and inclusionProof are null.
 *
 * #202 — When the input tx carries a `_wallet.authenticator` field (the
 * sender-signed authenticator for a committed-but-not-yet-proven transfer,
 * as written by saveCommitmentOnlyToken / saveUnconfirmedV5Token), that
 * authenticator is deconstructed into a `pending-authenticator` element
 * referenced by the optional `pendingAuthenticator` child. On assemble,
 * the field is restored as `tx._wallet = { authenticator: {...} }` so
 * wallet code retains the legacy naming.
 */
export function deconstructTransaction(
  pool: ElementPool,
  tx: TransferTxShape,
  sourceState: StateShape,
  destinationState: StateShape,
  maxDepth: number = 100,
): ContentHash {
  const sourceStateHash = deconstructState(pool, sourceState);
  const destinationStateHash = deconstructState(pool, destinationState);

  // Transaction data
  let dataHash: ContentHash | null = null;
  if (tx.data != null) {
    dataHash = deconstructTransferData(pool, tx.data, maxDepth);
  }

  // Inclusion proof (null for uncommitted)
  let inclusionProofHash: ContentHash | null = null;
  if (tx.inclusionProof != null) {
    inclusionProofHash = deconstructInclusionProof(pool, tx.inclusionProof);
  }

  // #202 — Pending authenticator. Read from the wallet-internal
  // `_wallet.authenticator` field that saveCommitmentOnlyToken (and now
  // saveUnconfirmedV5Token) writes onto transactions awaiting proof.
  // Absence is the normal case (transaction either proven or never
  // committed); presence means "committed locally, awaiting proof".
  let pendingAuthenticatorHash: ContentHash | null = null;
  const txWallet = (tx as TransferTxShape & {
    readonly _wallet?: { readonly authenticator?: AuthenticatorShape | null };
  })._wallet;
  if (txWallet && txWallet.authenticator != null) {
    pendingAuthenticatorHash = deconstructPendingAuthenticator(
      pool,
      txWallet.authenticator,
    );
  }

  // Children object: only include pendingAuthenticator when set so the
  // element hash for tokens without pending state matches the pre-#202
  // hash (back-compat with on-chain content-addressed bundles).
  const children: Record<string, ContentHash | ContentHash[] | null> = {
    sourceState: sourceStateHash,
    data: dataHash,
    inclusionProof: inclusionProofHash,
    destinationState: destinationStateHash,
  };
  if (pendingAuthenticatorHash !== null) {
    children.pendingAuthenticator = pendingAuthenticatorHash;
  }

  return putElement(pool, 'transaction', {}, children);
}

// ---------------------------------------------------------------------------
// Token-level detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if a value looks like a token object (has a `genesis` field with
 * nested structure) as opposed to a plain string nametag.
 */
function isTokenObject(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    'genesis' in (value as Record<string, unknown>)
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Internal implementation of token deconstruction, operating on a validated
 * TokenShape. Separated so recursive calls (nametags) skip re-validation.
 */
function deconstructTokenInternal(
  pool: ElementPool,
  token: TokenShape,
  maxDepth: number = 100,
): ContentHash {
  if (maxDepth <= 0) {
    throw new UxfError('INVALID_PACKAGE', 'Maximum nametag nesting depth exceeded');
  }
  // Derive all intermediate states
  const { genesisDestState, txSourceStates, txDestStates } =
    deriveAllStates(token);

  // Deconstruct genesis
  const genesisHash = deconstructGenesis(
    pool,
    token.genesis,
    genesisDestState,
  );

  // Deconstruct transfer transactions
  const transactionHashes: ContentHash[] = [];
  for (let i = 0; i < token.transactions.length; i++) {
    const txHash = deconstructTransaction(
      pool,
      token.transactions[i],
      txSourceStates[i],
      txDestStates[i],
      maxDepth,
    );
    transactionHashes.push(txHash);
  }

  // Deconstruct current state
  const stateHash = deconstructState(pool, token.state);

  // Recursively deconstruct nametag tokens
  const nametagHashes: ContentHash[] = [];
  if (Array.isArray(token.nametags)) {
    for (const nt of token.nametags) {
      if (isTokenObject(nt)) {
        nametagHashes.push(deconstructTokenInternal(pool, nt as TokenShape, maxDepth - 1));
      }
    }
  }

  // Build TokenRoot
  const tokenId = lowerHex(
    (token.genesis.data as MintDataShape).tokenId,
  );

  return putElement(
    pool,
    'token-root',
    {
      tokenId,
      version: token.version ?? '2.0',
    },
    {
      genesis: genesisHash,
      transactions: transactionHashes,
      state: stateHash,
      nametags: nametagHashes,
    },
  );
}

/**
 * Deconstruct a token into content-addressed DAG elements in the pool.
 *
 * Accepts `unknown` input (supports both ITokenJson and TxfToken-like shapes)
 * with runtime validation. Placeholder tokens and pending finalization stubs
 * are rejected.
 *
 * @param pool  The element pool to insert elements into.
 * @param token The token to deconstruct (ITokenJson or compatible shape).
 * @returns The ContentHash of the token-root element.
 * @throws UxfError with code INVALID_PACKAGE if the token is invalid.
 */
export function deconstructToken(
  pool: ElementPool,
  token: unknown,
): ContentHash {
  validateToken(token);
  return deconstructTokenInternal(pool, token);
}
