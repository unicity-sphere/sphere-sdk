import { HexConverter, TokenIssuanceVerifierService } from './sdk';
import type { CoinId, TokenIssuancePolicy } from './types';

export class IssuancePolicies {
  public readonly verifier = new TokenIssuanceVerifierService(false);
  private readonly issuers = new Map<CoinId, string>();

  public register(policy: TokenIssuancePolicy): this {
    const tokenType = HexConverter.encode(policy.tokenType.bytes);
    const coinIds = policy.coinIds.map((coinId) => coinId.toLowerCase());
    const taken = coinIds.find((coinId) => this.issuers.has(coinId));
    if (taken !== undefined) throw new Error(`Coin ${taken} is already issued by token type ${this.issuers.get(taken)}.`);
    this.verifier.register(policy);
    for (const coinId of coinIds) this.issuers.set(coinId, tokenType);
    return this;
  }

  public issuerOf(coinId: CoinId): string | null {
    return this.issuers.get(coinId.toLowerCase()) ?? null;
  }
}
