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

/** Minimal shape of IMintTransactionJson / genesis. */
interface GenesisShape {
  readonly data: MintDataShape;
  readonly inclusionProof: InclusionProofShape;
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
 * Validates that the input is a usable token and not a placeholder or pending
 * finalization stub.
 */
function validateToken(token: unknown): asserts token is TokenShape {
  if (!token || typeof token !== 'object') {
    throw new UxfError('INVALID_PACKAGE', 'Token input must be a non-null object');
  }

  const obj = token as Record<string, unknown>;

  if (obj._placeholder === true) {
    throw new UxfError(
      'INVALID_PACKAGE',
      'Cannot ingest placeholder or pending finalization tokens',
    );
  }

  if (obj._pendingFinalization) {
    throw new UxfError(
      'INVALID_PACKAGE',
      'Cannot ingest placeholder or pending finalization tokens',
    );
  }

  if (!obj.genesis || typeof obj.genesis !== 'object') {
    throw new UxfError('INVALID_PACKAGE', 'Token must have a genesis field');
  }

  if (!obj.state || typeof obj.state !== 'object') {
    throw new UxfError('INVALID_PACKAGE', 'Token must have a state field');
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
      data: lowerHex(state.data),
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
    data: step.data == null ? '' : lowerHex(step.data),
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
 * Children: data (genesis-data), inclusionProof, destinationState (token-state).
 */
export function deconstructGenesis(
  pool: ElementPool,
  genesis: GenesisShape,
  destinationState: StateShape,
): ContentHash {
  const dataHash = deconstructGenesisData(pool, genesis.data);
  const inclusionProofHash = deconstructInclusionProof(
    pool,
    genesis.inclusionProof,
  );
  const destinationStateHash = deconstructState(pool, destinationState);

  return putElement(pool, 'genesis', {}, {
    data: dataHash,
    inclusionProof: inclusionProofHash,
    destinationState: destinationStateHash,
  });
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
): ContentHash {
  // Recursively deconstruct nametag tokens embedded in the transfer data
  const nametagRefs: ContentHash[] = [];
  if (Array.isArray(txData.nametags)) {
    for (const nt of txData.nametags) {
      if (isTokenObject(nt)) {
        nametagRefs.push(deconstructTokenInternal(pool, nt as TokenShape));
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
 * Children: sourceState, data, inclusionProof, destinationState.
 *
 * For uncommitted transactions, data and inclusionProof are null.
 */
export function deconstructTransaction(
  pool: ElementPool,
  tx: TransferTxShape,
  sourceState: StateShape,
  destinationState: StateShape,
): ContentHash {
  const sourceStateHash = deconstructState(pool, sourceState);
  const destinationStateHash = deconstructState(pool, destinationState);

  // Transaction data
  let dataHash: ContentHash | null = null;
  if (tx.data != null) {
    dataHash = deconstructTransferData(pool, tx.data);
  }

  // Inclusion proof (null for uncommitted)
  let inclusionProofHash: ContentHash | null = null;
  if (tx.inclusionProof != null) {
    inclusionProofHash = deconstructInclusionProof(pool, tx.inclusionProof);
  }

  return putElement(pool, 'transaction', {}, {
    sourceState: sourceStateHash,
    data: dataHash,
    inclusionProof: inclusionProofHash,
    destinationState: destinationStateHash,
  });
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
): ContentHash {
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
        nametagHashes.push(deconstructTokenInternal(pool, nt as TokenShape));
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
