/**
 * The 3.x wire break, pinned against a real 2.1.0-encoded token.
 *
 * The testnet and backend reset clear the network; they do NOT clear a browser's
 * IndexedDB. A token written by the previous major can therefore still reach a
 * decode path, and it must be refused in a way that names the cause — the
 * fixture is here because it becomes uncapturable once the pin moves.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CborError, Token } from '../../../token-engine/sdk';
import { createTestEngine } from './test-engine';

const TOKEN_2_1_0 = readFileSync(join(__dirname, 'fixtures', 'token-sdk-2.1.0.hex'), 'utf8').trim();

const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

describe('state-transition-sdk 2.x → 3.x wire break', () => {
  it('refuses a 2.1.0-encoded token with an error naming the version', async () => {
    const err = await Token.fromCBOR(bytes(TOKEN_2_1_0)).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(CborError);
    expect((err as Error).message).toMatch(/version/i);
  });

  it('surfaces that refusal through the engine rather than as a silent skip', async () => {
    const engine = createTestEngine();
    await expect(engine.decodeToken({ tokenId: '', token: bytes(TOKEN_2_1_0) })).rejects.toThrow(/version/i);
  });
});
