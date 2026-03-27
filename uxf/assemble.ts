/**
 * Token Reassembly (WU-07)
 *
 * Converts content-addressed DAG elements back into self-contained
 * ITokenJson-shaped plain objects. Reassembly is the inverse of
 * deconstruction (WU-06).
 *
 * Every element fetched from the pool is re-hashed and compared against
 * the expected content hash (Decision 7). A visited-hash set detects
 * cycles (Decision 8).
 *
 * @module uxf/assemble
 */

import { decode } from '@ipld/dag-cbor';

import type {
  ContentHash,
  UxfElement,
  UxfElementType,
  UxfManifest,
  InstanceChainIndex,
  InstanceSelectionStrategy,
  GenesisDataContent,
  TransactionDataContent,
  InclusionProofContent,
  AuthenticatorContent,
  SmtPathContent,
  UnicityCertificateContent,
  StateContent,
  TokenRootContent,
  TokenRootChildren,
  GenesisChildren,
  TransactionChildren,
  InclusionProofChildren,
} from './types.js';
import { STRATEGY_LATEST } from './types.js';
import { ElementPool } from './element-pool.js';
import { resolveElement, selectInstance } from './instance-chain.js';
import { computeElementHash } from './hash.js';
import { UxfError } from './errors.js';

// ---------------------------------------------------------------------------
// Assembly Context
// ---------------------------------------------------------------------------

/**
 * Internal context threaded through all assembly helpers.
 * Carries visited-hash set (cycle detection), instance chain index,
 * and instance selection strategy.
 */
interface AssemblyContext {
  readonly visited: Set<string>;
  readonly instanceChains: InstanceChainIndex;
  readonly strategy: InstanceSelectionStrategy;
}

// ---------------------------------------------------------------------------
// Resolve + Verify helper
// ---------------------------------------------------------------------------

/**
 * Resolve an element from the pool (with instance selection),
 * verify its content hash, check for cycles, and optionally
 * assert its element type.
 *
 * When resolving through an instance chain the resolved element's
 * hash may differ from the requested hash (a newer instance was
 * selected). In that case we verify the resolved element's hash
 * matches the SELECTED hash, not the original reference hash.
 */
function resolveAndVerify(
  pool: ElementPool,
  hash: ContentHash,
  ctx: AssemblyContext,
  expectedType?: UxfElementType,
): UxfElement {
  // Cycle detection
  if (ctx.visited.has(hash)) {
    throw new UxfError('CYCLE_DETECTED', `Cycle detected at element ${hash}`);
  }
  ctx.visited.add(hash);

  // Resolve through instance chain (may return a different element)
  const element = resolveElement(pool, hash, ctx.instanceChains, ctx.strategy);

  // Determine the actual hash of the resolved element for integrity check.
  const actualHash = computeElementHash(element);

  // If the hash is in an instance chain, the resolved element may have a
  // different hash than what was requested (because a newer instance was
  // selected). In that case we need to verify that the resolved element's
  // hash matches the selected instance hash from the chain, not the
  // original reference hash. If the hash is NOT in a chain, the actual
  // hash must match the requested hash exactly.
  const chainEntry = ctx.instanceChains.get(hash);
  if (chainEntry) {
    const selectedHash = selectInstance(chainEntry, ctx.strategy, pool);
    if (actualHash !== selectedHash) {
      throw new UxfError(
        'VERIFICATION_FAILED',
        `Hash mismatch for element ${selectedHash}: computed ${actualHash}`,
      );
    }
    // Also mark the selected hash as visited
    ctx.visited.add(selectedHash);
  } else {
    if (actualHash !== hash) {
      throw new UxfError(
        'VERIFICATION_FAILED',
        `Hash mismatch for element ${hash}: computed ${actualHash}`,
      );
    }
  }

  // Type assertion
  if (expectedType && element.type !== expectedType) {
    throw new UxfError(
      'TYPE_MISMATCH',
      `Expected element type '${expectedType}' but got '${element.type}' at ${hash}`,
    );
  }

  return element;
}

// ---------------------------------------------------------------------------
// Leaf assemblers
// ---------------------------------------------------------------------------

/**
 * Assemble a token-state element into `{ predicate, data }`.
 */
function assembleState(
  pool: ElementPool,
  stateHash: ContentHash,
  ctx: AssemblyContext,
): { predicate: string; data: string } {
  const el = resolveAndVerify(pool, stateHash, ctx, 'token-state');
  const c = el.content as unknown as StateContent;
  return {
    predicate: c.predicate,
    data: c.data,
  };
}

/**
 * Assemble an authenticator element.
 */
function assembleAuthenticator(
  pool: ElementPool,
  authHash: ContentHash,
  ctx: AssemblyContext,
): { algorithm: string; publicKey: string; signature: string; stateHash: string } {
  const el = resolveAndVerify(pool, authHash, ctx, 'authenticator');
  const c = el.content as unknown as AuthenticatorContent;
  return {
    algorithm: c.algorithm,
    publicKey: c.publicKey,
    signature: c.signature,
    stateHash: c.stateHash,
  };
}

/**
 * Assemble an smt-path element into `{ root, steps[] }`.
 */
function assembleSmtPath(
  pool: ElementPool,
  pathHash: ContentHash,
  ctx: AssemblyContext,
): { root: string; steps: Array<{ data: string; path: string }> } {
  const el = resolveAndVerify(pool, pathHash, ctx, 'smt-path');
  const c = el.content as unknown as SmtPathContent;
  const steps = c.segments.map((seg) => ({
    data: seg.data,
    path: seg.path,
  }));
  return { root: c.root, steps };
}

/**
 * Assemble a unicity-certificate element into its raw hex string.
 */
function assembleUnicityCertificate(
  pool: ElementPool,
  certHash: ContentHash,
  ctx: AssemblyContext,
): string {
  const el = resolveAndVerify(pool, certHash, ctx, 'unicity-certificate');
  const c = el.content as unknown as UnicityCertificateContent;
  return c.raw;
}

// ---------------------------------------------------------------------------
// Composite assemblers
// ---------------------------------------------------------------------------

/**
 * Assemble an inclusion-proof element into the IInclusionProofJson shape.
 */
function assembleInclusionProof(
  pool: ElementPool,
  proofHash: ContentHash,
  ctx: AssemblyContext,
): {
  authenticator: { algorithm: string; publicKey: string; signature: string; stateHash: string } | null;
  merkleTreePath: { root: string; steps: Array<{ data: string; path: string }> };
  transactionHash: string | null;
  unicityCertificate: string;
} {
  const el = resolveAndVerify(pool, proofHash, ctx, 'inclusion-proof');
  const c = el.content as unknown as InclusionProofContent;
  const ch = el.children as unknown as InclusionProofChildren;

  const authenticator = ch.authenticator !== null
    ? assembleAuthenticator(pool, ch.authenticator, ctx)
    : null;

  const merkleTreePath = assembleSmtPath(pool, ch.merkleTreePath, ctx);
  const unicityCertificate = assembleUnicityCertificate(pool, ch.unicityCertificate, ctx);

  return {
    authenticator,
    merkleTreePath,
    transactionHash: c.transactionHash ?? null,
    unicityCertificate,
  };
}

/**
 * Decode the genesis `reason` field from opaque bytes back to
 * its original form.
 *
 * - null -> null
 * - Uint8Array -> attempt dag-cbor decode (split reason object),
 *   fall back to UTF-8 string decode
 */
function decodeReason(reason: Uint8Array | null): unknown {
  if (reason === null || reason === undefined) {
    return null;
  }
  // Try dag-cbor decode first (handles ISplitMintReasonJson objects).
  // If that fails, treat as UTF-8 string.
  try {
    return decode(reason);
  } catch {
    return new TextDecoder().decode(reason);
  }
}

/**
 * Assemble a genesis-data element into the IMintTransactionDataJson shape.
 */
function assembleGenesisData(
  pool: ElementPool,
  dataHash: ContentHash,
  ctx: AssemblyContext,
): {
  tokenId: string;
  tokenType: string;
  coinData: Array<[string, string]>;
  tokenData: string;
  salt: string;
  recipient: string;
  recipientDataHash: string | null;
  reason: unknown;
} {
  const el = resolveAndVerify(pool, dataHash, ctx, 'genesis-data');
  const c = el.content as unknown as GenesisDataContent;

  return {
    tokenId: c.tokenId,
    tokenType: c.tokenType,
    coinData: c.coinData.map(([coinId, amount]) => [coinId, amount] as [string, string]),
    tokenData: c.tokenData,
    salt: c.salt,
    recipient: c.recipient,
    recipientDataHash: c.recipientDataHash ?? null,
    reason: decodeReason(c.reason),
  };
}

/**
 * Assemble a genesis element into the IMintTransactionJson shape.
 */
function assembleGenesis(
  pool: ElementPool,
  genesisHash: ContentHash,
  ctx: AssemblyContext,
): {
  data: ReturnType<typeof assembleGenesisData>;
  inclusionProof: ReturnType<typeof assembleInclusionProof>;
} {
  const el = resolveAndVerify(pool, genesisHash, ctx, 'genesis');
  const ch = el.children as unknown as GenesisChildren;

  const data = assembleGenesisData(pool, ch.data, ctx);
  const inclusionProof = assembleInclusionProof(pool, ch.inclusionProof, ctx);

  return { data, inclusionProof };
}

/**
 * Assemble a transaction-data element, restoring nametagRefs as
 * recursively reassembled nametag ITokenJson objects.
 */
function assembleTransactionData(
  pool: ElementPool,
  dataHash: ContentHash,
  ctx: AssemblyContext,
): {
  sourceState: { predicate: string; data: string };
  recipient: string;
  salt: string;
  recipientDataHash: string | null;
  message: string | null;
  nametags: unknown[];
} {
  const el = resolveAndVerify(pool, dataHash, ctx, 'transaction-data');
  const c = el.content as unknown as TransactionDataContent;

  // Restore nametag tokens from nametagRefs
  const nametags: unknown[] = [];
  if (c.nametagRefs && c.nametagRefs.length > 0) {
    for (const ntHash of c.nametagRefs) {
      nametags.push(assembleTokenFromRootInternal(pool, ntHash, ctx));
    }
  }

  // Transaction data carries sourceState but we return a placeholder here;
  // the caller (assembleTransaction) will fill in sourceState from
  // the transaction element's sourceState child. We include it as a
  // dummy that the caller overwrites -- this matches the original
  // ITransferTransactionDataJson shape.
  return {
    sourceState: { predicate: '', data: '' },
    recipient: c.recipient,
    salt: c.salt,
    recipientDataHash: c.recipientDataHash ?? null,
    message: c.message ?? null,
    nametags,
  };
}

/**
 * Assemble a transaction element into the ITransferTransactionJson shape.
 */
function assembleTransaction(
  pool: ElementPool,
  txHash: ContentHash,
  ctx: AssemblyContext,
): {
  data: {
    sourceState: { predicate: string; data: string };
    recipient: string;
    salt: string;
    recipientDataHash: string | null;
    message: string | null;
    nametags: unknown[];
  };
  inclusionProof: ReturnType<typeof assembleInclusionProof> | null;
} {
  const el = resolveAndVerify(pool, txHash, ctx, 'transaction');
  const ch = el.children as unknown as TransactionChildren;

  // Source state (always present)
  const sourceState = assembleState(pool, ch.sourceState, ctx);

  // Transaction data (may be null for uncommitted)
  let txData: ReturnType<typeof assembleTransactionData> | null = null;
  if (ch.data !== null) {
    txData = assembleTransactionData(pool, ch.data, ctx);
    // Overwrite the placeholder sourceState with the actual one
    txData.sourceState = sourceState;
  }

  // Inclusion proof (may be null for uncommitted)
  let inclusionProof: ReturnType<typeof assembleInclusionProof> | null = null;
  if (ch.inclusionProof !== null) {
    inclusionProof = assembleInclusionProof(pool, ch.inclusionProof, ctx);
  }

  // Build the data object. If txData is null (uncommitted), construct
  // a minimal data object with sourceState and empty fields.
  const data = txData ?? {
    sourceState,
    recipient: '',
    salt: '',
    recipientDataHash: null,
    message: null,
    nametags: [],
  };

  return { data, inclusionProof };
}

// ---------------------------------------------------------------------------
// Token-level assemblers
// ---------------------------------------------------------------------------

/**
 * Internal implementation of assembleTokenFromRoot that accepts an
 * existing AssemblyContext. Used for recursive nametag assembly.
 */
function assembleTokenFromRootInternal(
  pool: ElementPool,
  rootHash: ContentHash,
  ctx: AssemblyContext,
): unknown {
  const root = resolveAndVerify(pool, rootHash, ctx, 'token-root');
  const rc = root.content as unknown as TokenRootContent;
  const rch = root.children as unknown as TokenRootChildren;

  // Genesis
  const genesis = assembleGenesis(pool, rch.genesis, ctx);

  // Transactions
  const transactions: ReturnType<typeof assembleTransaction>[] = [];
  for (const txHash of rch.transactions) {
    transactions.push(assembleTransaction(pool, txHash, ctx));
  }

  // Current state
  const state = assembleState(pool, rch.state, ctx);

  // Nametags (recursive)
  const nametags: unknown[] = [];
  if (rch.nametags && rch.nametags.length > 0) {
    for (const ntHash of rch.nametags) {
      nametags.push(assembleTokenFromRootInternal(pool, ntHash, ctx));
    }
  }

  return {
    version: rc.version || '2.0',
    genesis,
    transactions,
    state,
    nametags: nametags.length > 0 ? nametags : [],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reassemble a token from the element pool by looking up its root hash
 * in the manifest.
 *
 * @param pool           The element pool containing all DAG elements.
 * @param manifest       Token manifest mapping tokenId to root hash.
 * @param tokenId        The token ID to reassemble.
 * @param instanceChains Instance chain index for version selection.
 * @param strategy       Instance selection strategy (default: latest).
 * @returns A plain object matching the ITokenJson shape.
 */
export function assembleToken(
  pool: ElementPool,
  manifest: UxfManifest,
  tokenId: string,
  instanceChains: InstanceChainIndex,
  strategy: InstanceSelectionStrategy = STRATEGY_LATEST,
): unknown {
  const rootHash = manifest.tokens.get(tokenId);
  if (!rootHash) {
    throw new UxfError('TOKEN_NOT_FOUND', `Token ${tokenId} not in manifest`);
  }

  return assembleTokenFromRoot(pool, rootHash, instanceChains, strategy);
}

/**
 * Reassemble a token directly from its root hash in the pool.
 * Used for nametag sub-DAGs whose root hashes are stored in parent
 * token-root children but may not have their own manifest entries.
 *
 * @param pool           The element pool.
 * @param rootHash       Content hash of the token-root element.
 * @param instanceChains Instance chain index.
 * @param strategy       Instance selection strategy (default: latest).
 * @returns A plain object matching the ITokenJson shape.
 */
export function assembleTokenFromRoot(
  pool: ElementPool,
  rootHash: ContentHash,
  instanceChains: InstanceChainIndex,
  strategy: InstanceSelectionStrategy = STRATEGY_LATEST,
): unknown {
  const ctx: AssemblyContext = {
    visited: new Set<string>(),
    instanceChains,
    strategy,
  };

  return assembleTokenFromRootInternal(pool, rootHash, ctx);
}

/**
 * Reassemble a token at a specific historical state.
 *
 * - stateIndex=0: genesis only, no transactions. State is the genesis
 *   destination state.
 * - stateIndex=N: genesis + first N transactions. State is the
 *   destination state of transaction N-1 (the Nth transaction).
 *
 * Nametags are included in full regardless of stateIndex.
 *
 * @param pool           The element pool.
 * @param manifest       Token manifest.
 * @param tokenId        The token ID.
 * @param stateIndex     The historical state index (0 = genesis).
 * @param instanceChains Instance chain index.
 * @param strategy       Instance selection strategy (default: latest).
 * @returns A plain object matching the ITokenJson shape at the given state.
 */
export function assembleTokenAtState(
  pool: ElementPool,
  manifest: UxfManifest,
  tokenId: string,
  stateIndex: number,
  instanceChains: InstanceChainIndex,
  strategy: InstanceSelectionStrategy = STRATEGY_LATEST,
): unknown {
  const rootHash = manifest.tokens.get(tokenId);
  if (!rootHash) {
    throw new UxfError('TOKEN_NOT_FOUND', `Token ${tokenId} not in manifest`);
  }

  const ctx: AssemblyContext = {
    visited: new Set<string>(),
    instanceChains,
    strategy,
  };

  const root = resolveAndVerify(pool, rootHash, ctx, 'token-root');
  const rc = root.content as unknown as TokenRootContent;
  const rch = root.children as unknown as TokenRootChildren;

  // Validate stateIndex range
  const totalTx = rch.transactions.length;
  if (stateIndex < 0 || stateIndex > totalTx) {
    throw new UxfError(
      'STATE_INDEX_OUT_OF_RANGE',
      `Token ${tokenId} has ${totalTx} transactions, requested state index ${stateIndex}`,
    );
  }

  // Genesis (always included)
  const genesis = assembleGenesis(pool, rch.genesis, ctx);

  // Truncate transactions
  const truncatedHashes = rch.transactions.slice(0, stateIndex);
  const transactions: ReturnType<typeof assembleTransaction>[] = [];
  for (const txHash of truncatedHashes) {
    transactions.push(assembleTransaction(pool, txHash, ctx));
  }

  // Determine state at the requested index
  let state: { predicate: string; data: string };
  if (stateIndex === 0) {
    // State = genesis destination state
    const genesisEl = resolveAndVerify(pool, rch.genesis, ctx, 'genesis');
    const genCh = genesisEl.children as unknown as GenesisChildren;
    state = assembleState(pool, genCh.destinationState, ctx);
  } else {
    // State = destination state of the last included transaction
    const lastTxHash = truncatedHashes[truncatedHashes.length - 1];
    // We need to resolve the transaction element to get its destinationState child.
    // The element was already visited during assembleTransaction above,
    // so we resolve it directly from the pool without re-verifying.
    const lastTxEl = resolveElement(pool, lastTxHash, ctx.instanceChains, ctx.strategy);
    const lastTxCh = lastTxEl.children as unknown as TransactionChildren;
    state = assembleState(pool, lastTxCh.destinationState, ctx);
  }

  // Nametags (full, regardless of stateIndex)
  const nametags: unknown[] = [];
  if (rch.nametags && rch.nametags.length > 0) {
    for (const ntHash of rch.nametags) {
      nametags.push(assembleTokenFromRootInternal(pool, ntHash, ctx));
    }
  }

  return {
    version: rc.version || '2.0',
    genesis,
    transactions,
    state,
    nametags: nametags.length > 0 ? nametags : [],
  };
}
