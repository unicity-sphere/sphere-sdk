import { HexConverter } from './sdk';
import type { CoinId, TokenIssuancePolicy, TokenPlugin } from './types';

export class CoinClaims {
  private readonly issuers = new Map<CoinId, string>();
  private readonly policies: string[] = [];

  public static fromPlugins(plugins: readonly TokenPlugin[] | undefined): CoinClaims {
    const claims = new CoinClaims();
    for (const plugin of plugins ?? []) {
      for (const policy of plugin.tokenIssuancePolicies ?? []) claims.add(policy);
    }
    return claims;
  }

  public add(policy: TokenIssuancePolicy): void {
    const tokenType = HexConverter.encode(policy.tokenType.bytes);
    const coinIds = policy.coinIds.map((coinId) => coinId.toLowerCase());
    const taken = coinIds.find((coinId) => this.issuers.has(coinId));
    if (taken !== undefined) throw new Error(`Coin ${taken} is already issued by token type ${this.issuers.get(taken)}.`);
    for (const coinId of coinIds) this.issuers.set(coinId, tokenType);
    this.policies.push(JSON.stringify([tokenType, [...coinIds].sort(), policy.revision ?? '']));
  }

  public fingerprint(): string {
    return [...this.policies].sort().join('\n');
  }

  public issuerOf(coinId: CoinId): string | null {
    return this.issuers.get(coinId.toLowerCase()) ?? null;
  }
}
