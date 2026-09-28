import { describe, expect, it, vi } from 'vitest';

import { CoinClaims } from '../../../token-engine/claims';
import { TokenType } from '../../../token-engine/sdk';

const policy = (typeByte: number, coinIds: string[]) => ({
  tokenType: new TokenType(new Uint8Array(32).fill(typeByte)),
  coinIds,
  verify: vi.fn(),
});

describe('CoinClaims', () => {
  it('names the token type that issues a claimed coin, in any letter case, and none for an unclaimed coin', () => {
    const claims = CoinClaims.fromPlugins([{ id: 'bridge', tokenIssuancePolicies: [policy(0x6f, ['AB'.repeat(32)])] }]);

    expect(claims.issuerOf('ab'.repeat(32))).toBe('6f'.repeat(32));
    expect(claims.issuerOf('AB'.repeat(32))).toBe('6f'.repeat(32));
    expect(claims.issuerOf('cd'.repeat(32))).toBeNull();
  });

  it('refuses a coin that another token type already issues', () => {
    const claims = new CoinClaims();
    claims.add(policy(1, ['ab'.repeat(32)]));

    expect(() => claims.add(policy(2, ['AB'.repeat(32)]))).toThrow(/(ab){32}.*(01){32}/);
  });
});
