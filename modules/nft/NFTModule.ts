/**
 * NFT Module — Minting and Collection Management
 *
 * Creates, manages, and mints non-fungible tokens (NFTs) on the Unicity network.
 * NFTs are standard on-chain tokens with tokenType = NFT_TOKEN_TYPE_HEX and
 * metadata stored in genesis.data.tokenData.
 *
 * This module follows the established SDK module pattern (AccountingModule,
 * PaymentsModule) with dependency injection, lifecycle management, and
 * per-collection concurrency gates.
 *
 * @see docs/NFT-SPEC.md
 * @see docs/NFT-ARCHITECTURE.md
 */

import { logger } from '../../core/logger.js';
import { SphereError } from '../../core/errors.js';
import { NFT_TOKEN_TYPE_HEX, STORAGE_KEYS_ADDRESS, getAddressStorageKey } from '../../constants.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

import type {
  NFTModuleConfig,
  NFTMetadata,
  NFTTokenData,
  NFTRef,
  CollectionRef,
  CollectionDefinition,
  CreateCollectionRequest,
  CreateCollectionResult,
  GetCollectionsOptions,
  MintNFTResult,
  BatchMintNFTResult,
} from './types.js';
import { NFT_MAX_BATCH_SIZE } from './types.js';
import type { IncomingTransfer, Token } from '../../types/index.js';

import { canonicalSerializeNFT, deriveCollectionId, parseNFTTokenData } from './serialization.js';
import { validateNFTMetadata, validateCreateCollectionRequest } from './validation.js';
import { CollectionRegistry } from './collection-registry.js';

// =============================================================================
// Constants
// =============================================================================

const LOG_TAG = 'NFT';

/** Standalone NFTs use this key for the collection gate. */
const STANDALONE_GATE_KEY = '__standalone__';

// =============================================================================
// NFTModule
// =============================================================================

export class NFTModule {
  // ── In-memory state ──
  private _nftIndex: Map<string, NFTRef> = new Map();
  private _collectionIndex: Map<string, CollectionRef> = new Map();
  private _registry: CollectionRegistry;
  private _collectionGates: Map<string, Promise<unknown>> = new Map();
  private _eventUnsubscribers: Array<() => void> = [];
  private _initialized = false;
  private _destroyed = false;

  // ── Dependencies (set by load) ──
  private deps!: NFTModuleConfig;

  constructor() {
    this._registry = new CollectionRegistry();
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Load the NFT module: restore collection registry, scan tokens for NFTs,
   * build in-memory indexes, and subscribe to transfer events.
   */
  async load(config: NFTModuleConfig): Promise<void> {
    if (this._destroyed) {
      throw new SphereError('NFT module has been destroyed', 'NOT_INITIALIZED');
    }
    if (this._initialized) {
      return;
    }

    this.deps = config;

    // 1. Load collection registry from storage
    await this._registry.load(config.storage, config.addressId);

    // 2. Enumerate tokens and discover NFTs
    const allTokens = config.payments.getTokens();
    for (const token of allTokens) {
      this._tryIndexToken(token);
    }

    // 3. Update collection token counts
    this._updateCollectionTokenCount();

    // 4. Subscribe to transfer events
    const unsubIncoming = config.on('transfer:incoming', (transfer: IncomingTransfer) => {
      this._onIncomingTransfer(transfer);
    });
    this._eventUnsubscribers.push(unsubIncoming);

    this._initialized = true;
    logger.debug(LOG_TAG, `Loaded: ${this._nftIndex.size} NFTs, ${this._collectionIndex.size} collections`);
  }

  /**
   * Destroy the module: unsubscribe events and clear in-memory state.
   */
  async destroy(): Promise<void> {
    for (const unsub of this._eventUnsubscribers) {
      try { unsub(); } catch { /* ignore */ }
    }
    this._eventUnsubscribers = [];
    this._nftIndex.clear();
    this._collectionIndex.clear();
    this._collectionGates.clear();
    this._initialized = false;
    this._destroyed = true;
  }

  // ==========================================================================
  // Collections
  // ==========================================================================

  /**
   * Create a new NFT collection definition and store it locally.
   * Does NOT mint any tokens — just registers the collection.
   * Idempotent: if the same definition already exists, returns existing.
   */
  async createCollection(request: CreateCollectionRequest): Promise<CreateCollectionResult> {
    this._ensureInitialized();

    // 1. Validate
    validateCreateCollectionRequest(request);

    // 2. Construct CollectionDefinition
    const definition: CollectionDefinition = {
      name: request.name,
      description: request.description,
      creator: this.deps.identity.chainPubkey,
      createdAt: Date.now(),
      maxSupply: request.maxSupply ?? null,
      image: request.image,
      externalUrl: request.externalUrl,
      royalty: request.royalty,
      transferable: request.transferable ?? true,
      deterministicMinting: request.deterministicMinting ?? false,
    };

    // 3. Derive deterministic collection ID
    const collectionId = deriveCollectionId(definition);

    // 4. Idempotent: if already exists, return existing
    const existing = this._registry.get(collectionId);
    if (existing) {
      logger.debug(LOG_TAG, `Collection ${collectionId.slice(0, 16)}... already exists (idempotent)`);
      return { collectionId, definition: existing };
    }

    // 5. Store in registry and persist
    this._registry.set(collectionId, definition);
    await this._registry.save();

    // 6. Update in-memory collection index
    this._collectionIndex.set(
      collectionId,
      this._registry.buildCollectionRef(
        collectionId,
        definition,
        0,
        true,
      ),
    );

    // 7. Emit event
    this.deps.emitEvent('nft:collection_created', {
      collectionId,
      name: definition.name,
    });

    logger.debug(LOG_TAG, `Collection created: ${collectionId.slice(0, 16)}... "${definition.name}"`);

    return { collectionId, definition };
  }

  /**
   * Get a single collection by ID.
   */
  getCollection(collectionId: string): CollectionRef | null {
    return this._collectionIndex.get(collectionId) ?? null;
  }

  /**
   * Get all collections, optionally filtered and sorted.
   */
  getCollections(options?: GetCollectionsOptions): CollectionRef[] {
    let results = Array.from(this._collectionIndex.values());

    // Filter
    if (options?.createdByMe) {
      const myPubkey = this.deps?.identity?.chainPubkey;
      if (myPubkey) {
        results = results.filter((c) => c.creator === myPubkey);
      }
    }

    // Sort
    const sortBy = options?.sortBy ?? 'name';
    const sortOrder = options?.sortOrder ?? 'asc';
    const dir = sortOrder === 'desc' ? -1 : 1;

    results.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'tokenCount':
          cmp = a.tokenCount - b.tokenCount;
          break;
        case 'creator':
          cmp = a.creator.localeCompare(b.creator);
          break;
        default:
          cmp = a.name.localeCompare(b.name);
      }
      return cmp * dir;
    });

    return results;
  }

  // ==========================================================================
  // Minting
  // ==========================================================================

  /**
   * Mint a single NFT. Can be standalone or part of a collection.
   * Follows the 22-step algorithm from NFT-SPEC section 4.1.
   */
  async mintNFT(
    metadata: NFTMetadata,
    collectionId?: string,
    edition?: number,
    totalEditions?: number,
    recipient?: string,
  ): Promise<MintNFTResult> {
    this._ensureInitialized();

    const gateKey = collectionId ?? STANDALONE_GATE_KEY;

    return this._withCollectionGate(gateKey, async () => {
      return this._mintSingleNFT(metadata, collectionId, edition, totalEditions, recipient);
    });
  }

  /**
   * Mint multiple NFTs in a batch. Can be standalone or part of a collection.
   * Edition numbers are reserved atomically inside the collection gate,
   * then individual mints are parallelized.
   */
  async batchMintNFT(
    items: Array<{ metadata: NFTMetadata; edition?: number; recipient?: string }>,
    collectionId?: string,
  ): Promise<BatchMintNFTResult> {
    this._ensureInitialized();

    // Validate batch size
    if (!items || items.length === 0) {
      throw new SphereError('Batch must contain at least one item', 'NFT_INVALID_METADATA');
    }
    if (items.length > NFT_MAX_BATCH_SIZE) {
      throw new SphereError(
        `Batch size ${items.length} exceeds maximum of ${NFT_MAX_BATCH_SIZE}`,
        'NFT_INVALID_METADATA',
      );
    }

    const gateKey = collectionId ?? STANDALONE_GATE_KEY;

    return this._withCollectionGate(gateKey, async () => {
      let collection: CollectionDefinition | null = null;
      let editions: number[] = [];

      if (collectionId) {
        // Validate collection exists
        collection = this._registry.get(collectionId);
        if (!collection) {
          throw new SphereError(
            `Collection ${collectionId} not registered locally`,
            'NFT_COLLECTION_NOT_FOUND',
          );
        }

        // Pre-check maxSupply
        if (collection.maxSupply !== null && collection.maxSupply !== undefined) {
          const currentCount = await this._registry.getEditionCount(collectionId);
          if (currentCount + items.length > collection.maxSupply) {
            throw new SphereError(
              `Batch mint would exceed maxSupply: ${currentCount} + ${items.length} > ${collection.maxSupply}`,
              'NFT_MAX_SUPPLY_EXCEEDED',
            );
          }
        }

        // Reserve edition range atomically
        editions = [];
        for (let i = 0; i < items.length; i++) {
          if (items[i].edition !== undefined) {
            editions.push(items[i].edition!);
          } else {
            const nextEd = await this._registry.getNextEdition(collectionId);
            editions.push(nextEd);
          }
        }
      } else {
        // Standalone NFTs: all editions = 0
        editions = items.map(() => 0);
      }

      // Parallelize individual mints via Promise.allSettled
      const mintPromises = items.map((item, index) =>
        this._mintSingleNFTInternal(
          item.metadata,
          collectionId ?? null,
          collection,
          editions[index],
          0, // totalEditions for batch
          item.recipient,
        ).then((result) => ({ index, result })),
      );

      const settled = await Promise.allSettled(mintPromises);

      const results: MintNFTResult[] = [];
      const errors: Array<{ index: number; error: string }> = [];

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          results.push(outcome.value.result);
        } else {
          const idx = (outcome.reason as { index?: number })?.index ?? -1;
          errors.push({
            index: idx,
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          });
        }
      }

      return {
        results,
        successCount: results.length,
        failureCount: errors.length,
        errors: errors.length > 0 ? errors : undefined,
      };
    });
  }

  // ==========================================================================
  // Private — Minting internals
  // ==========================================================================

  /**
   * Mint a single NFT with collection gate already held.
   * Resolves edition, validates collection, then delegates to _mintSingleNFTInternal.
   */
  private async _mintSingleNFT(
    metadata: NFTMetadata,
    collectionId?: string,
    edition?: number,
    totalEditions?: number,
    recipient?: string,
  ): Promise<MintNFTResult> {
    let collection: CollectionDefinition | null = null;
    let resolvedEdition = 0;

    if (collectionId) {
      // Step 2: Resolve collection
      collection = this._registry.get(collectionId);
      if (!collection) {
        throw new SphereError(
          `Collection ${collectionId} not registered locally`,
          'NFT_COLLECTION_NOT_FOUND',
        );
      }

      // Step 3: Check maxSupply
      if (collection.maxSupply !== null && collection.maxSupply !== undefined) {
        const currentCount = await this._registry.getEditionCount(collectionId);
        if (currentCount >= collection.maxSupply) {
          throw new SphereError(
            `Max supply reached for collection ${collectionId}: ${currentCount} >= ${collection.maxSupply}`,
            'NFT_MAX_SUPPLY_EXCEEDED',
          );
        }
      }

      // Step 4: Determine edition
      if (edition !== undefined) {
        resolvedEdition = edition;
      } else {
        resolvedEdition = await this._registry.getNextEdition(collectionId);
      }
    }
    // For standalone NFTs: resolvedEdition stays 0

    return this._mintSingleNFTInternal(
      metadata,
      collectionId ?? null,
      collection,
      resolvedEdition,
      totalEditions ?? 0,
      recipient,
    );
  }

  /**
   * Core minting logic — follows the 22-step algorithm from NFT-SPEC §4.1.
   * Steps 1-22 are annotated inline.
   */
  private async _mintSingleNFTInternal(
    metadata: NFTMetadata,
    collectionId: string | null,
    collection: CollectionDefinition | null,
    edition: number,
    totalEditions: number,
    recipient?: string,
  ): Promise<MintNFTResult> {
    const deps = this.deps;

    // Step 1: Validate metadata
    validateNFTMetadata(metadata);

    // Step 5: Resolve recipient
    const recipientAddress = recipient ?? deps.identity.directAddress;

    // Step 6: Construct NFTTokenData
    const mintedAt = Date.now();
    const nftTokenData: NFTTokenData = {
      collectionId: collectionId,
      metadata,
      edition,
      totalEditions,
      minter: deps.identity.chainPubkey,
      mintedAt,
    };

    // Step 7: Serialize token data
    const tokenData = canonicalSerializeNFT(nftTokenData);
    const tokenDataBytes = new TextEncoder().encode(tokenData);

    // Step 8: Generate salt
    let salt: Uint8Array;
    if (collection && collection.deterministicMinting && collectionId) {
      // Strategy B: deterministic salt — HMAC-SHA256(privateKey, collectionId || uint64BE(edition))
      const privateKeyBytes = hexToBytes(deps.identity.privateKey);
      const collectionIdBytes = hexToBytes(collectionId);
      const editionBytes = new Uint8Array(8);
      const editionView = new DataView(editionBytes.buffer);
      editionView.setBigUint64(0, BigInt(edition), false); // big-endian

      const hmacInput = new Uint8Array(collectionIdBytes.length + editionBytes.length);
      hmacInput.set(collectionIdBytes, 0);
      hmacInput.set(editionBytes, collectionIdBytes.length);

      salt = hmac(sha256, privateKeyBytes, hmacInput);
    } else {
      // Strategy A: random salt
      salt = crypto.getRandomValues(new Uint8Array(32));
    }

    // Step 8a: Persist mint intent for crash recovery
    const mintIntentKey = `nft_mint_intent_${collectionId ?? 'standalone'}_${edition}`;
    await deps.storage.set(
      getAddressStorageKey(deps.addressId, mintIntentKey),
      JSON.stringify({
        collectionId,
        edition,
        mintedAt,
        salt: bytesToHex(salt),
        tokenData,
      }),
    );

    // Step 9: Import state-transition-sdk types (dynamic import, same pattern as AccountingModule)
    try {
      const { TokenId } = await import(
        '@unicitylabs/state-transition-sdk/lib/token/TokenId.js'
      );
      const { TokenType } = await import(
        '@unicitylabs/state-transition-sdk/lib/token/TokenType.js'
      );
      const { MintTransactionData } = await import(
        '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js'
      );
      const { MintCommitment } = await import(
        '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment.js'
      );
      const { SigningService } = await import(
        '@unicitylabs/state-transition-sdk/lib/sign/SigningService.js'
      );
      const { HashAlgorithm } = await import(
        '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js'
      );
      const { DataHasher } = await import(
        '@unicitylabs/state-transition-sdk/lib/hash/DataHasher.js'
      );
      const { UnmaskedPredicate } = await import(
        '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js'
      );
      const { UnmaskedPredicateReference } = await import(
        '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js'
      );
      const { TokenState } = await import(
        '@unicitylabs/state-transition-sdk/lib/token/TokenState.js'
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { Token: SdkToken } = await import(
        '@unicitylabs/state-transition-sdk/lib/token/Token.js'
      );
      const { waitInclusionProof } = await import(
        '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js'
      );

      // Step 10: Derive TokenId from SHA-256(tokenDataBytes + salt)
      const hash = await new DataHasher(HashAlgorithm.SHA256)
        .update(tokenDataBytes)
        .update(salt)
        .digest();
      const nftTokenId = new TokenId(hash.imprint);
      const tokenIdHex: string = nftTokenId.toJSON();

      // Step 11: Create MintTransactionData
      const nftTokenType = new TokenType(
        Buffer.from(NFT_TOKEN_TYPE_HEX, 'hex'),
      );

      // Create signing service from identity private key
      const signingKeyBytes = hexToBytes(deps.identity.privateKey);
      const signingService = await SigningService.createFromSecret(signingKeyBytes);

      // Build owner address using UnmaskedPredicateReference
      const addressRef = await UnmaskedPredicateReference.create(
        nftTokenType,
        signingService.algorithm,
        signingService.publicKey,
        HashAlgorithm.SHA256,
      );
      const ownerAddress = await addressRef.toAddress();

      const mintData = await MintTransactionData.create(
        nftTokenId,         // tokenId: TokenId
        nftTokenType,       // tokenType: TokenType
        tokenDataBytes,     // tokenData: Uint8Array
        null,               // coinData: null (NFTs have no coin data)
        ownerAddress,       // recipient: IAddress
        salt,               // salt: Uint8Array
        null,               // recipientDataHash: null
        null,               // reason: null
      );

      logger.debug(LOG_TAG, `Created MintTransactionData for NFT ${tokenIdHex.slice(0, 16)}...`);

      // Step 12: Create MintCommitment
      const commitment = await MintCommitment.create(mintData);

      logger.debug(LOG_TAG, 'Created MintCommitment for NFT');

      // Step 13: Submit to oracle with retries
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stClient = (deps.oracle as any).getStateTransitionClient?.();
      if (!stClient) {
        throw new SphereError(
          'Oracle provider does not expose getStateTransitionClient() — required for NFT minting',
          'NFT_MINT_FAILED',
        );
      }

      const MAX_RETRIES = 3;
      let submitSuccess = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          logger.debug(LOG_TAG, `Submitting NFT commitment (attempt ${attempt}/${MAX_RETRIES})...`);
          const response = await stClient.submitMintCommitment(commitment);

          if (response.status === 'SUCCESS' || response.status === 'REQUEST_ID_EXISTS') {
            logger.debug(
              LOG_TAG,
              response.status === 'REQUEST_ID_EXISTS'
                ? 'NFT commitment already exists (idempotent re-mint)'
                : 'NFT commitment submitted successfully',
            );
            submitSuccess = true;
            break;
          } else {
            logger.warn(LOG_TAG, `NFT commitment submission failed: ${response.status}`);
            if (attempt === MAX_RETRIES) {
              throw new SphereError(
                `Failed to mint NFT: commitment rejected after ${MAX_RETRIES} attempts: ${response.status}`,
                'NFT_MINT_FAILED',
              );
            }
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        } catch (retryErr) {
          if (retryErr instanceof SphereError && retryErr.code === 'NFT_MINT_FAILED') {
            throw retryErr;
          }
          logger.warn(LOG_TAG, `NFT commitment attempt ${attempt} error:`, retryErr);
          if (attempt === MAX_RETRIES) {
            throw new SphereError(
              `Failed to mint NFT: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
              'NFT_MINT_FAILED',
              retryErr,
            );
          }
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }

      if (!submitSuccess) {
        throw new SphereError(
          'Failed to mint NFT: commitment submission failed after retries',
          'NFT_MINT_FAILED',
        );
      }

      // Step 14: Wait for inclusion proof
      logger.debug(LOG_TAG, 'Waiting for NFT inclusion proof...');
      const trustBase = deps.trustBase;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inclusionProof = await waitInclusionProof(trustBase as any, stClient, commitment);
      logger.debug(LOG_TAG, 'NFT inclusion proof received');

      // Step 15: Create predicate
      const nftPredicate = await UnmaskedPredicate.create(
        nftTokenId,
        nftTokenType,
        signingService,
        HashAlgorithm.SHA256,
        salt,
      );

      // Step 16: Construct token
      const tokenState = new TokenState(nftPredicate, null);
      const genesisTransaction = commitment.toTransaction(inclusionProof);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdkToken: any = await SdkToken.mint(trustBase as any, tokenState, genesisTransaction);

      logger.debug(LOG_TAG, 'NFT token minted successfully');

      // Step 17: Store token via PaymentsModule.addToken()
      const sdkTokenJson = sdkToken.toJSON();
      const uiToken: Token = {
        id: tokenIdHex,
        coinId: NFT_TOKEN_TYPE_HEX,
        symbol: 'NFT',
        name: metadata.name,
        decimals: 0,
        amount: '1',
        status: 'confirmed',
        createdAt: mintedAt,
        updatedAt: mintedAt,
        sdkData: JSON.stringify(sdkTokenJson),
      };

      await deps.payments.addToken(uiToken);

      // Step 18: Delete mint intent (crash recovery cleanup)
      try {
        await deps.storage.remove(getAddressStorageKey(deps.addressId, mintIntentKey));
      } catch {
        // Non-critical — intent key cleanup failure is not fatal
      }

      // Step 19: Update mint counter (collection-only — already incremented by getNextEdition)
      // No additional action needed here; getNextEdition already persisted the counter.

      // Step 20: Update in-memory index
      const nftRef = this._buildNFTRef(tokenIdHex, nftTokenData, true);
      this._nftIndex.set(tokenIdHex, nftRef);

      // Update collection index token count
      this._updateCollectionTokenCount();

      // Step 21: Emit event
      this.deps.emitEvent('nft:minted', {
        tokenId: tokenIdHex,
        collectionId: collectionId,
        name: metadata.name,
        confirmed: true,
      });

      logger.debug(LOG_TAG, `NFT minted: ${tokenIdHex.slice(0, 16)}... "${metadata.name}"`);

      // Step 22: Return result
      return {
        tokenId: tokenIdHex,
        collectionId: collectionId,
        confirmed: true,
        nft: nftRef,
      };
    } catch (err) {
      // Clean up mint intent on failure (best-effort)
      try {
        await deps.storage.remove(getAddressStorageKey(deps.addressId, mintIntentKey));
      } catch { /* ignore */ }

      if (err instanceof SphereError) throw err;
      throw new SphereError(
        `NFT minting failed: ${err instanceof Error ? err.message : String(err)}`,
        'NFT_MINT_FAILED',
        err,
      );
    }
  }

  // ==========================================================================
  // Private — Concurrency
  // ==========================================================================

  /**
   * Per-collection promise chain to serialize concurrent minting operations.
   * Same pattern as AccountingModule's withInvoiceGate.
   */
  private async _withCollectionGate<T>(collectionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._collectionGates.get(collectionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this._collectionGates.set(collectionId, next);
    try {
      return await next;
    } finally {
      if (this._collectionGates.get(collectionId) === next) {
        this._collectionGates.delete(collectionId);
      }
    }
  }

  // ==========================================================================
  // Private — Index management
  // ==========================================================================

  /**
   * Build an NFTRef from token data.
   */
  private _buildNFTRef(tokenId: string, nftData: NFTTokenData, confirmed: boolean): NFTRef {
    return {
      tokenId,
      collectionId: nftData.collectionId,
      name: nftData.metadata.name,
      image: nftData.metadata.image,
      edition: nftData.edition,
      confirmed,
      status: confirmed ? 'confirmed' : 'pending',
      mintedAt: nftData.mintedAt,
    };
  }

  /**
   * Try to parse a token as an NFT and add it to the index.
   * Returns true if the token was an NFT and was indexed.
   */
  private _tryIndexToken(token: Token): boolean {
    if (!token.sdkData) return false;

    try {
      const txf = JSON.parse(token.sdkData);
      if (txf?.genesis?.data?.tokenType !== NFT_TOKEN_TYPE_HEX) return false;

      const nftData = parseNFTTokenData(
        typeof txf.genesis.data.tokenData === 'string'
          ? txf.genesis.data.tokenData
          : JSON.stringify(txf.genesis.data.tokenData),
      );
      if (!nftData) return false;

      const nftRef = this._buildNFTRef(
        token.id,
        nftData,
        token.status === 'confirmed',
      );
      this._nftIndex.set(token.id, nftRef);

      // Ensure collection is registered if we have a collectionId
      if (nftData.collectionId) {
        this._ensureCollectionRegistered(nftData.collectionId, nftData);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update collection token counts from the NFT index.
   */
  private _updateCollectionTokenCount(): void {
    // Count NFTs per collection
    const counts = new Map<string, number>();
    for (const nft of this._nftIndex.values()) {
      if (nft.collectionId) {
        counts.set(nft.collectionId, (counts.get(nft.collectionId) ?? 0) + 1);
      }
    }

    // Rebuild collection index from registry
    const myPubkey = this.deps?.identity?.chainPubkey;
    const allCollections = this._registry.getAll();

    this._collectionIndex.clear();
    for (const [collectionId, definition] of allCollections) {
      const tokenCount = counts.get(collectionId) ?? 0;
      const isCreator = myPubkey ? definition.creator === myPubkey : false;
      this._collectionIndex.set(
        collectionId,
        this._registry.buildCollectionRef(collectionId, definition, tokenCount, isCreator),
      );
    }

    // Also index collections from NFTs that we received (not in local registry)
    for (const [collectionId, tokenCount] of counts) {
      if (!this._collectionIndex.has(collectionId)) {
        // We have NFTs from this collection but no local definition
        // Build a minimal CollectionRef from what we know
        const firstNft = Array.from(this._nftIndex.values()).find(
          (n) => n.collectionId === collectionId,
        );
        if (firstNft) {
          this._collectionIndex.set(collectionId, {
            collectionId,
            name: `Collection ${collectionId.slice(0, 8)}...`,
            creator: '',
            tokenCount,
            maxSupply: null,
            isCreator: false,
            transferable: true,
          });
        }
      }
    }
  }

  /**
   * Ensure a collection is registered in the local registry.
   * If not found, creates a synthetic entry from available NFT data.
   */
  private _ensureCollectionRegistered(collectionId: string, nftData: NFTTokenData): void {
    if (!collectionId) return;
    if (this._registry.get(collectionId)) return;

    // We received an NFT from an unknown collection — store a synthetic definition
    // This is best-effort; the definition may be incomplete
    logger.debug(LOG_TAG, `Registering synthetic collection from received NFT: ${collectionId.slice(0, 16)}...`);

    // We cannot store a full CollectionDefinition without knowing creator, createdAt, etc.
    // The collection will be represented only in _collectionIndex via _updateCollectionTokenCount.
  }

  // ==========================================================================
  // Private — Event handlers
  // ==========================================================================

  /**
   * Handle incoming transfer events: detect NFTs and add to index.
   * CRITICAL: Errors MUST be caught and logged — never propagate or block
   * the underlying token transfer flow.
   */
  private _onIncomingTransfer(transfer: IncomingTransfer): void {
    try {
      for (const token of transfer.tokens) {
        if (!token.sdkData) continue;

        try {
          const txf = JSON.parse(token.sdkData);
          if (txf?.genesis?.data?.tokenType !== NFT_TOKEN_TYPE_HEX) continue;

          const tokenDataStr = typeof txf.genesis.data.tokenData === 'string'
            ? txf.genesis.data.tokenData
            : JSON.stringify(txf.genesis.data.tokenData);

          const nftData = parseNFTTokenData(tokenDataStr);
          if (!nftData) {
            logger.warn(LOG_TAG, `Failed to parse NFT data for token ${token.id.slice(0, 16)}...`);
            continue;
          }

          // Register collection if unknown
          if (nftData.collectionId) {
            this._ensureCollectionRegistered(nftData.collectionId, nftData);
          }

          // Add to index
          const nftRef = this._buildNFTRef(
            token.id,
            nftData,
            token.status === 'confirmed',
          );
          this._nftIndex.set(token.id, nftRef);

          // Update collection counts
          this._updateCollectionTokenCount();

          // Emit event
          this.deps.emitEvent('nft:received', {
            tokenId: token.id,
            collectionId: nftData.collectionId,
            name: nftData.metadata.name,
            senderPubkey: transfer.senderPubkey,
            senderNametag: transfer.senderNametag,
          });

          logger.debug(LOG_TAG, `NFT received: ${token.id.slice(0, 16)}... "${nftData.metadata.name}"`);
        } catch (tokenErr) {
          // Never block processing of other tokens in the batch
          logger.warn(LOG_TAG, `Error processing incoming NFT token ${token.id?.slice(0, 16) ?? '?'}:`, tokenErr);
        }
      }
    } catch (err) {
      // NEVER block transfer processing — log and continue
      logger.error(LOG_TAG, 'NFT inbound processing error:', err);
    }
  }

  // ==========================================================================
  // Private — Guards
  // ==========================================================================

  private _ensureInitialized(): void {
    if (this._destroyed) {
      throw new SphereError('NFT module has been destroyed', 'MODULE_DESTROYED');
    }
    if (!this._initialized) {
      throw new SphereError('NFT module not initialized — call load() first', 'NOT_INITIALIZED');
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create and return an NFTModule instance.
 * The caller is responsible for calling load() to initialize.
 */
export function createNFTModule(): NFTModule {
  return new NFTModule();
}
