/**
 * Nametag Minter
 * Mints nametag tokens on-chain for PROXY address support
 *
 * Flow (same as Sphere wallet and lottery):
 * 1. Generate salt
 * 2. Create MintTransactionData from nametag
 * 3. Create MintCommitment
 * 4. Submit to aggregator
 * 5. Wait for inclusion proof
 * 6. Create Token with proof
 * 7. Return token for storage
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from '../../core/logger';

import { Token } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData';
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { DirectAddress } from '@unicitylabs/state-transition-sdk/lib/address/DirectAddress';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import { normalizeNametag } from '@unicitylabs/nostr-js-sdk';
import type { NametagData } from '../../types/txf';

// =============================================================================
// Constants
// =============================================================================

/**
 * Unicity token type for nametags
 * Same as used in Sphere wallet and lottery
 */
const UNICITY_TOKEN_TYPE_HEX = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';

// =============================================================================
// Types
// =============================================================================

export interface NametagMinterConfig {
  stateTransitionClient: any;
  trustBase: any;
  signingService: SigningService;
  /** Skip trust base verification (dev mode) */
  skipVerification?: boolean;
  /** Enable debug logging */
  debug?: boolean;
}

export interface MintNametagResult {
  success: boolean;
  token?: Token<any>;
  nametagData?: NametagData;
  error?: string;
}

// =============================================================================
// Implementation
// =============================================================================

export class NametagMinter {
  private client: any;
  private trustBase: any;
  private signingService: SigningService;
  private skipVerification: boolean;
  private debug: boolean;

  constructor(config: NametagMinterConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.signingService = config.signingService;
    this.skipVerification = config.skipVerification ?? false;
    this.debug = config.debug ?? false;
  }

  private log(message: string, ...args: unknown[]): void {
    logger.debug('NametagMinter', message, ...args);
  }

  /**
   * Check if a nametag is available (not already minted)
   */
  async isNametagAvailable(nametag: string): Promise<boolean> {
    try {
      const stripped = nametag.startsWith('@') ? nametag.slice(1) : nametag;
      const cleanNametag = normalizeNametag(stripped);
      const nametagTokenId = await TokenId.fromNameTag(cleanNametag);

      const isMinted = await this.client.isMinted(this.trustBase, nametagTokenId);
      return !isMinted;
    } catch (error) {
      this.log('Error checking nametag availability:', error);
      return false;
    }
  }

  /**
   * Mint a nametag token on-chain
   *
   * @param nametag - The nametag to mint (e.g., "alice" or "@alice")
   * @param ownerAddress - The owner's direct address
   * @returns MintNametagResult with token if successful
   */
  async mintNametag(
    nametag: string,
    ownerAddress: DirectAddress
  ): Promise<MintNametagResult> {
    const stripped = nametag.startsWith('@') ? nametag.slice(1) : nametag;
    const cleanNametag = normalizeNametag(stripped);
    this.log(`Starting mint for nametag: ${cleanNametag}`);

    try {
      // 1. Create token ID and type
      const nametagTokenId = await TokenId.fromNameTag(cleanNametag);
      const nametagTokenType = new TokenType(
        Buffer.from(UNICITY_TOKEN_TYPE_HEX, 'hex')
      );

      // 2. Generate deterministic salt from signing key + nametag.
      // This ensures the same wallet can recover its nametag token if lost
      // from local storage, because re-minting produces the same commitment
      // and the aggregator returns REQUEST_ID_EXISTS with the same inclusion proof.
      const nametagBytes = new TextEncoder().encode(cleanNametag);
      const pubKey = this.signingService.publicKey;
      const saltInput = new Uint8Array(pubKey.length + nametagBytes.length);
      saltInput.set(pubKey, 0);
      saltInput.set(nametagBytes, pubKey.length);
      const saltBuffer = await crypto.subtle.digest('SHA-256', saltInput);
      const salt = new Uint8Array(saltBuffer);
      this.log('Generated deterministic salt');

      // 3. Create mint transaction data
      const mintData = await MintTransactionData.createFromNametag(
        cleanNametag,
        nametagTokenType,
        ownerAddress,
        salt,
        ownerAddress
      );
      this.log('Created MintTransactionData');

      // 4. Create commitment
      const commitment = await MintCommitment.create(mintData);
      this.log('Created MintCommitment');

      // 5. Submit to aggregator with retries
      // If the nametag was previously minted by this wallet (same deterministic salt),
      // the aggregator returns REQUEST_ID_EXISTS which is handled as success.
      const MAX_RETRIES = 3;
      let submitSuccess = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          this.log(`Submitting commitment (attempt ${attempt}/${MAX_RETRIES})...`);
          const response = await this.client.submitMintCommitment(commitment);

          if (response.status === 'SUCCESS' || response.status === 'REQUEST_ID_EXISTS') {
            this.log(`Commitment ${response.status === 'REQUEST_ID_EXISTS' ? 'already exists' : 'submitted successfully'}`);
            submitSuccess = true;
            break;
          } else {
            this.log(`Commitment failed: ${response.status}`);
            if (attempt === MAX_RETRIES) {
              return {
                success: false,
                error: `Failed to submit commitment after ${MAX_RETRIES} attempts: ${response.status}`,
              };
            }
            await new Promise(r => setTimeout(r, 1000 * attempt));
          }
        } catch (error) {
          this.log(`Attempt ${attempt} error:`, error);
          if (attempt === MAX_RETRIES) {
            return {
              success: false,
              error: `Submit failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }

      if (!submitSuccess) {
        return {
          success: false,
          error: 'Failed to submit commitment after retries',
        };
      }

      // 6. Wait for inclusion proof
      this.log('Waiting for inclusion proof...');
      const inclusionProof = await waitInclusionProof(this.trustBase, this.client, commitment);
      this.log('Received inclusion proof');

      // 7. Create genesis transaction
      const genesisTransaction = commitment.toTransaction(inclusionProof);

      // 8. Create token predicate and state
      const nametagPredicate = await UnmaskedPredicate.create(
        nametagTokenId,
        nametagTokenType,
        this.signingService,
        HashAlgorithm.SHA256,
        salt
      );

      const tokenState = new TokenState(nametagPredicate, null);

      // 9. Create final token
      let token: Token<any>;

      if (this.skipVerification) {
        this.log('Creating token WITHOUT verification (dev mode)');
        const tokenJson = {
          version: '2.0',
          state: tokenState.toJSON(),
          genesis: genesisTransaction.toJSON(),
          transactions: [],
          nametags: [],
        };
        token = await Token.fromJSON(tokenJson);
      } else {
        token = await Token.mint(
          this.trustBase,
          tokenState,
          genesisTransaction
        );
      }

      this.log(`Nametag minted successfully: ${cleanNametag}`);

      // 10. Create NametagData for storage
      const nametagData: NametagData = {
        name: cleanNametag,
        token: token.toJSON(),
        timestamp: Date.now(),
        format: 'txf',
        version: '2.0',
      };

      return {
        success: true,
        token,
        nametagData,
      };
    } catch (error) {
      this.log('Minting failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createNametagMinter(config: NametagMinterConfig): NametagMinter {
  return new NametagMinter(config);
}
