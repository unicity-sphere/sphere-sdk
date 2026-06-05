import { vi } from 'vitest';
import type {
  ITokenEngine, EngineIdentity, SphereToken, SphereValue, TokenBlob, CoinId,
} from '../../../token-engine';

/** Build a SphereToken stand-in for interaction tests (sdkToken/blob are inert). */
export function mockSphereToken(value: SphereValue | null = { assets: [] }): SphereToken {
  const blob: TokenBlob = { v: 1, network: 2, token: new Uint8Array() };
  return { sdkToken: {} as SphereToken['sdkToken'], blob, value };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A vi-spy ITokenEngine. Pass overrides to fix return values per test. */
export function createMockTokenEngine(overrides: Partial<ITokenEngine> = {}): ITokenEngine {
  const identity: EngineIdentity = { chainPubkey: new Uint8Array(33).fill(0x02) };
  const base: ITokenEngine = {
    getIdentity: vi.fn((): EngineIdentity => ({ chainPubkey: new Uint8Array(identity.chainPubkey) })),
    deriveIdentityAddress: vi.fn((pubkey?: Uint8Array) => Promise.resolve(`DIRECT://${hex(pubkey ?? identity.chainPubkey)}`)),
    readValue: vi.fn((t: SphereToken) => t.value),
    balanceOf: vi.fn((_t: SphereToken, _c: CoinId) => 0n),
    mint: vi.fn(async () => mockSphereToken()),
    transfer: vi.fn(async () => mockSphereToken()),
    split: vi.fn(async () => ({ outputs: [] })),
    verify: vi.fn(async () => ({ ok: true })),
    isSpent: vi.fn(async () => false),
    encodeToken: vi.fn((t: SphereToken) => t.blob),
    decodeToken: vi.fn(async () => mockSphereToken()),
  };
  return { ...base, ...overrides };
}
