/**
 * Fungible token mint — thin `ITokenEngine` wrapper (Phase 6.P2.3 rewrite).
 *
 * v1 flow: manually built MintTransactionData + MintCommitment + predicate +
 * TokenState, submitted the mint commitment with retry, awaited the inclusion
 * proof, materialised a Token, converted to the wallet UI Token shape, and
 * persisted via the facade's `addToken`. That whole pipeline is now the
 * anti-corruption layer's job — `ITokenEngine.mint` handles the full
 * mint→certify→proof→realize chain.
 *
 * Public surface preserved (`mintFungibleTokenImpl` name, dep shape adjusted):
 *  - Callers pass a `tokenEngine` alongside the registry lookups + persistence
 *    hook.
 *  - Return type unchanged: `{ success, token, tokenId } | { success, error }`.
 *
 * The wallet-facing `Token` shape stores an `sdkData` JSON string; for v2 the
 * blob is CBOR (`Uint8Array`). We encode it as base64 into a synthetic JSON
 * wrapper so downstream storage (TXF) continues to consume the same field —
 * this preserves the "extract latest state" plumbing until Phase 6.P2.4
 * rewires storage onto the engine's `encodeToken` / `decodeToken` directly.
 */

import type { Token } from '../../../types';
import type { ITokenEngine, SphereToken } from '../../../token-engine';

/**
 * Facade-slice consumed by {@link mintFungibleTokenImpl}. The facade
 * (PaymentsModule) passes itself in to grant selective access to the small
 * handful of members this operation needs.
 */
export interface MintFungibleTokenDeps {
  /**
   * The wallet's anti-corruption engine port. `undefined` when the wallet has
   * not yet wired token-engine access (Phase 6.P2.3 landed the type; wire-up
   * lands in Phase 6.P2.4). Callers see `{ success: false }` in that case.
   */
  readonly tokenEngine: ITokenEngine | undefined;
  /** Registry lookup for the coin's UI symbol. */
  getCoinSymbol(coinId: string): string;
  /** Registry lookup for the coin's UI name. */
  getCoinName(coinId: string): string;
  /** Registry lookup for the coin's decimals. */
  getCoinDecimals(coinId: string): number;
  /** Registry lookup for the coin's icon URL (optional). */
  getCoinIconUrl(coinId: string): string | undefined;
  /** Persist the minted Token via the facade's repository layer. */
  /**
   * Persist the minted token to storage AND register the opaque SphereToken
   * handle in the facade's `engineTokens` map so `planCoinSpend` can source
   * from it. Both args are required — bug uncovered by wave 6-P2-6's
   * two-wallet send soak (2026-07-07): passing only the UI Token silently
   * dropped the engine handle, and every subsequent `payments.send` failed
   * with "Insufficient balance" because `planCoinSpend` couldn't find any
   * candidate tokens.
   */
  addToken(token: Token, sphereToken: SphereToken): Promise<boolean>;
}

function encodeSdkDataFromSphereToken(sphereToken: SphereToken): string {
  // The v1 sdkData channel was a JSON serialization of the SDK's Token JSON
  // (including transactions[], genesis, etc.). v2 blobs are CBOR bytes; we
  // wrap them in a compatibility envelope so downstream TXF parsers can
  // recognise the format and skip legacy parse attempts.
  const blob = sphereToken.blob;
  return JSON.stringify({
    _sdkVersion: 'v2',
    _format: 'sphere-token-blob',
    v: blob.v,
    network: blob.network,
    tokenId: blob.tokenId,
    // Base64-encoded CBOR bytes.
    token: Buffer.from(blob.token).toString('base64'),
  });
}

/**
 * Mint a fresh fungible token owned by the calling wallet's identity.
 *
 * Behavior:
 * - Delegates the full mint pipeline to `ITokenEngine.mint`.
 * - Recipient is the wallet itself (engine binds the wallet identity).
 * - Converts the returned `SphereToken` to the wallet UI `Token` shape and
 *   persists via `deps.addToken`.
 *
 * Errors are returned as `{ success: false, error }` rather than thrown; the
 * public facade signature preserves this contract for external callers.
 */
export async function mintFungibleTokenImpl(
  deps: MintFungibleTokenDeps,
  coinIdHex: string,
  amount: bigint,
): Promise<{ success: true; token: Token; tokenId: string } | { success: false; error: string }> {
  const tokenEngine = deps.tokenEngine;
  if (!tokenEngine) {
    return { success: false, error: 'Token engine not available' };
  }

  try {
    const identity = tokenEngine.getIdentity();

    const sphereToken = await tokenEngine.mint({
      recipientPubkey: identity.chainPubkey,
      value: {
        assets: [{ coinId: coinIdHex, amount }],
      },
    });

    const tokenIdHex = tokenEngine.tokenId(sphereToken);
    const symbol = deps.getCoinSymbol(coinIdHex);
    const name = deps.getCoinName(coinIdHex);
    const decimals = deps.getCoinDecimals(coinIdHex);
    const iconUrl = deps.getCoinIconUrl(coinIdHex);
    const uiToken: Token = {
      id: tokenIdHex,
      coinId: coinIdHex,
      symbol,
      name,
      decimals,
      ...(iconUrl !== undefined ? { iconUrl } : {}),
      amount: amount.toString(),
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: encodeSdkDataFromSphereToken(sphereToken),
    };
    await deps.addToken(uiToken, sphereToken);

    return { success: true, token: uiToken, tokenId: tokenIdHex };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Local mint failed: ${msg}` };
  }
}
