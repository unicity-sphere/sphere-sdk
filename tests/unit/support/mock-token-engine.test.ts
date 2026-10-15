import { describe, it, expect } from 'vitest';
import type { ITokenEngine } from '../../../token-engine';
import { createMockTokenEngine, mockSphereToken } from './mock-token-engine';

describe('createMockTokenEngine', () => {
  it('implements every ITokenEngine method as a spy', () => {
    const e: ITokenEngine = createMockTokenEngine();
    const methods: (keyof ITokenEngine)[] = [
      'getIdentity', 'readValue', 'balanceOf',
      'mint', 'transfer', 'split', 'verify', 'isSpent', 'encodeToken', 'decodeToken',
      'buildNftMint', 'readNft',
    ];
    for (const m of methods) expect(typeof e[m]).toBe('function');
  });

  it('getIdentity returns a 33-byte chain pubkey', () => {
    expect(createMockTokenEngine().getIdentity().chainPubkey).toHaveLength(33);
  });

  it('default async ops resolve to sensible shapes', async () => {
    const e = createMockTokenEngine();
    expect((await e.verify(mockSphereToken())).ok).toBe(true);
    expect(await e.isSpent(mockSphereToken())).toBe(false);
    expect((await e.split({ token: mockSphereToken(), outputs: [] })).outputs).toEqual([]);
  });

  it('overrides replace specific methods and stay spies', async () => {
    const e = createMockTokenEngine({ balanceOf: () => 42n });
    expect(e.balanceOf(mockSphereToken(), 'cc')).toBe(42n);
    await e.transfer({ token: mockSphereToken(), recipientPubkey: new Uint8Array(33) });
    expect(e.transfer).toHaveBeenCalledOnce();
  });

  it('readValue returns the token value; encodeToken returns its blob', () => {
    const e = createMockTokenEngine();
    const t = mockSphereToken({ assets: [{ coinId: 'cc', amount: 5n }] });
    expect(e.readValue(t)).toEqual({ assets: [{ coinId: 'cc', amount: 5n }] });
    expect(e.encodeToken(t)).toBe(t.blob);
  });
});
