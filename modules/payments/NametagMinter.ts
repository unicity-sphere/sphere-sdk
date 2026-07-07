/**
 * Nametag Minter — thin `ITokenEngine` wrapper (Phase 6.P2.3 rewrite).
 *
 * v1 flow: manually built MintTransactionData + MintCommitment, called the
 * StateTransitionClient, waited for the inclusion proof, materialised a Token,
 * wrapped it in a NametagData envelope. That whole pipeline is now the
 * anti-corruption layer's job — `ITokenEngine.mintDataToken` handles the
 * mint→certify→proof→realize chain, so this file collapses to salt derivation
 * (kept deterministic for wallet recoverability) plus the envelope shape the
 * PaymentsModule caller still expects.
 *
 * Public surface preserved:
 *  - `NametagMinter` class + `createNametagMinter(config)` factory
 *  - `mintNametag(nametag)` returns `MintNametagResult` with the same shape
 *    (success flag + optional nametagData envelope + optional token handle)
 *  - `isNametagAvailable(nametag)` returns a boolean
 *
 * Callers that constructed the v1 shape (with `stateTransitionClient` /
 * `trustBase` / `signingService`) MUST be migrated to pass `tokenEngine`
 * instead — this is a source-level shape change, not a runtime shim.
 */

import { logger } from '../../core/logger';
import { errMessage } from '../../core/errors';
import { normalizeNametag } from '@unicitylabs/nostr-js-sdk';

import type { ITokenEngine, SphereToken } from '../../token-engine';
import type { NametagData } from '../../types/txf';

// =============================================================================
// Constants
// =============================================================================

/**
 * Token type prefix used across the wallet for the nametag mint (kept stable
 * across the v1 → v2 anti-corruption migration so sdkData round-trips against
 * the rest of PaymentsModule / TXF storage).
 */
const UNICITY_TOKEN_TYPE_HEX =
  'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// =============================================================================
// Types
// =============================================================================

export interface NametagMinterConfig {
  /**
   * The wallet's anti-corruption engine port. Constructed once per wallet
   * (see `token-engine/factory.ts`) and shared across mint sites.
   */
  readonly tokenEngine: ITokenEngine;
  /** Enable debug logging. */
  readonly debug?: boolean;
}

export interface MintNametagResult {
  success: boolean;
  token?: SphereToken;
  nametagData?: NametagData;
  error?: string;
}

// =============================================================================
// Implementation
// =============================================================================

export class NametagMinter {
  private readonly tokenEngine: ITokenEngine;
  private readonly debug: boolean;

  constructor(config: NametagMinterConfig) {
    this.tokenEngine = config.tokenEngine;
    this.debug = config.debug ?? false;
  }

  private log(message: string, ...args: unknown[]): void {
    if (this.debug) logger.debug('NametagMinter', message, ...args);
  }

  /**
   * Best-effort availability probe. Returns `true` when the nametag can be
   * minted by this wallet. The wallet-facing v2 anti-corruption layer does
   * not yet expose an `isMinted(tokenId)` probe — the mint call is the
   * authoritative check (a duplicate returns `REQUEST_ID_EXISTS`). See
   * `nametag/availability.ts` for the historical contract.
   */
  async isNametagAvailable(nametag: string): Promise<boolean> {
    try {
      // Normalize once so callers using the same string as the mint see
      // consistent behavior across the two probes.
      const stripped = nametag.startsWith('@') ? nametag.slice(1) : nametag;
      normalizeNametag(stripped);
      return true;
    } catch (error) {
      this.log('Error checking nametag availability:', error);
      return false;
    }
  }

  /**
   * Mint a nametag token on-chain via the token engine.
   *
   * The nametag string is normalized (strip leading `@`, apply the
   * nostr-js-sdk normalizer), UTF-8 encoded as the data-token payload, and
   * combined with a deterministic salt derived from the wallet public key so
   * a re-mint (recovery path) rehydrates the same tokenId + inclusion proof
   * on the aggregator.
   */
  async mintNametag(nametag: string): Promise<MintNametagResult> {
    const stripped = nametag.startsWith('@') ? nametag.slice(1) : nametag;
    const cleanNametag = normalizeNametag(stripped);
    this.log(`Starting mint for nametag: ${cleanNametag}`);

    try {
      const identity = this.tokenEngine.getIdentity();
      const chainPubkey = identity.chainPubkey;

      // Deterministic salt = SHA-256(pubkey || nametag). Same wallet re-mints
      // hit `REQUEST_ID_EXISTS` on the aggregator with matching inclusion
      // proof, which is the recovery path.
      const nametagBytes = new TextEncoder().encode(cleanNametag);
      const saltInput = new Uint8Array(chainPubkey.length + nametagBytes.length);
      saltInput.set(chainPubkey, 0);
      saltInput.set(nametagBytes, chainPubkey.length);
      const saltBuffer = await crypto.subtle.digest('SHA-256', saltInput);
      const salt = new Uint8Array(saltBuffer);
      this.log('Generated deterministic salt');

      const tokenTypeBytes = hexToBytes(UNICITY_TOKEN_TYPE_HEX);

      const token = await this.tokenEngine.mintDataToken({
        recipientPubkey: chainPubkey,
        data: nametagBytes,
        tokenType: tokenTypeBytes,
        salt,
      });

      this.log(`Nametag minted successfully: ${cleanNametag}`);

      const nametagData: NametagData = {
        name: cleanNametag,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        token: token as any,
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
        error: errMessage(error),
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
