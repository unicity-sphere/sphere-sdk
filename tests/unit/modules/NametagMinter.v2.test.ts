/**
 * NametagMinter — Phase 6 v2 slim rewrite coverage.
 *
 * Wave 6-P2-3 collapsed NametagMinter to a ~180-LoC ITokenEngine wrapper.
 * All the v1 machinery (MintTransactionData / MintCommitment /
 * StateTransitionClient / Token.create) is now the anti-corruption layer's
 * job; the class is responsible only for:
 *
 *   - Availability probe via `nostr-js-sdk`'s normalizer (empty / bad-char
 *     rejection).
 *   - Deterministic salt derivation: `SHA-256(chainPubkey || nametagBytes)`.
 *   - Delegation to `ITokenEngine.mintDataToken(...)` with the pinned
 *     `NAMETAG` tokenType hex.
 *   - Wrapping the engine handle in the legacy `NametagData` envelope
 *     `PaymentsModule.setNametag()` still expects.
 *
 * Wave-6-P2-5 quarantined the v1 test file; this suite locks in the v2
 * public surface: contract-shaped calls with a mock engine + normalizer
 * failure handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { NametagMinter, createNametagMinter } from '../../../modules/payments/NametagMinter';
import type {
  ITokenEngine,
  SphereToken,
  EngineIdentity,
  MintDataTokenParams,
} from '../../../token-engine';

// ---------------------------------------------------------------------------
// Fake ITokenEngine — only the methods NametagMinter reaches for.
// ---------------------------------------------------------------------------

function makeFakeEngine(identity: EngineIdentity): {
  engine: ITokenEngine;
  mintDataToken: ReturnType<typeof vi.fn>;
} {
  const mintedToken: SphereToken = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdkToken: {} as any,
    blob: { v: 1, network: 2, tokenId: 'nametag-token-id', token: new Uint8Array() },
    value: null,
  };
  const mintDataToken = vi.fn<
    (params: MintDataTokenParams) => Promise<SphereToken>
  >(async () => mintedToken);
  // A fake engine with only the methods NametagMinter touches. Everything
  // else is a placeholder that would throw if accidentally consulted, but
  // NametagMinter's slim implementation should never reach for them.
  const engine = {
    getIdentity: () => identity,
    mintDataToken,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as ITokenEngine;
  return { engine, mintDataToken };
}

function fakeIdentity(): EngineIdentity {
  // 33-byte compressed secp256k1 style pubkey (bytes; NametagMinter reads
  // engine.getIdentity().chainPubkey as Uint8Array).
  const bytes = new Uint8Array(33);
  bytes[0] = 0x02;
  for (let i = 1; i < 33; i++) bytes[i] = i;
  return { chainPubkey: bytes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NametagMinter (v2 slim)', () => {
  describe('isNametagAvailable()', () => {
    let engine: ITokenEngine;
    let minter: NametagMinter;
    beforeEach(() => {
      engine = makeFakeEngine(fakeIdentity()).engine;
      minter = createNametagMinter({ tokenEngine: engine });
    });

    it('returns true for a well-formed alphanumeric nametag', async () => {
      expect(await minter.isNametagAvailable('alice')).toBe(true);
    });

    it('tolerates a leading @', async () => {
      expect(await minter.isNametagAvailable('@bob')).toBe(true);
    });
  });

  describe('mintNametag()', () => {
    it('routes through engine.mintDataToken with the canonical NAMETAG tokenType hex', async () => {
      const { engine, mintDataToken } = makeFakeEngine(fakeIdentity());
      const minter = createNametagMinter({ tokenEngine: engine });

      const result = await minter.mintNametag('alice');
      expect(result.success).toBe(true);
      expect(result.token).toBeDefined();
      expect(result.nametagData).toBeDefined();
      expect(result.nametagData?.name).toBe('alice');
      expect(result.nametagData?.format).toBe('txf');
      expect(result.nametagData?.version).toBe('2.0');

      expect(mintDataToken).toHaveBeenCalledTimes(1);
      const call = mintDataToken.mock.calls[0][0];
      // Pinned canonical NAMETAG token type — the wave-6-P2-3 rewrite must
      // preserve this hex or v1 storage wouldn't round-trip.
      const NAMETAG_TOKEN_TYPE_HEX =
        'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';
      const tokenTypeHex = Array.from(call.tokenType!)
        .map((b) => (b as number).toString(16).padStart(2, '0'))
        .join('');
      expect(tokenTypeHex).toBe(NAMETAG_TOKEN_TYPE_HEX);
      // Payload is the UTF-8 encoded normalized nametag.
      expect(new TextDecoder().decode(call.data)).toBe('alice');
      // Recipient is the wallet's own chain pubkey (self-mint).
      expect(call.recipientPubkey).toEqual(fakeIdentity().chainPubkey);
    });

    it('strips a leading @ before delegating (normalizes the nametag)', async () => {
      const { engine, mintDataToken } = makeFakeEngine(fakeIdentity());
      const minter = createNametagMinter({ tokenEngine: engine });

      const result = await minter.mintNametag('@bob');
      expect(result.success).toBe(true);
      expect(result.nametagData?.name).toBe('bob');
      expect(new TextDecoder().decode(mintDataToken.mock.calls[0][0].data)).toBe('bob');
    });

    it('derives the salt deterministically from (chainPubkey, nametag)', async () => {
      const identity = fakeIdentity();
      const call1 = makeFakeEngine(identity);
      const call2 = makeFakeEngine(identity);
      await createNametagMinter({ tokenEngine: call1.engine }).mintNametag('alice');
      await createNametagMinter({ tokenEngine: call2.engine }).mintNametag('alice');
      const salt1 = call1.mintDataToken.mock.calls[0][0].salt!;
      const salt2 = call2.mintDataToken.mock.calls[0][0].salt!;
      expect(Array.from(salt1)).toEqual(Array.from(salt2));
      // SHA-256 → 32 bytes.
      expect(salt1.length).toBe(32);
    });

    it('derives DIFFERENT salts for different nametags on the same wallet', async () => {
      const identity = fakeIdentity();
      const aliceCall = makeFakeEngine(identity);
      const bobCall = makeFakeEngine(identity);
      await createNametagMinter({ tokenEngine: aliceCall.engine }).mintNametag('alice');
      await createNametagMinter({ tokenEngine: bobCall.engine }).mintNametag('bob');
      const saltAlice = aliceCall.mintDataToken.mock.calls[0][0].salt!;
      const saltBob = bobCall.mintDataToken.mock.calls[0][0].salt!;
      expect(Array.from(saltAlice)).not.toEqual(Array.from(saltBob));
    });

    it('surfaces engine errors as a failed MintNametagResult (no throw)', async () => {
      const { engine, mintDataToken } = makeFakeEngine(fakeIdentity());
      mintDataToken.mockRejectedValueOnce(new Error('aggregator down'));
      const minter = createNametagMinter({ tokenEngine: engine });

      const result = await minter.mintNametag('alice');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/aggregator down/);
      expect(result.token).toBeUndefined();
      expect(result.nametagData).toBeUndefined();
    });

    it('constructs via `new NametagMinter` too (not just the factory)', async () => {
      const { engine, mintDataToken } = makeFakeEngine(fakeIdentity());
      const minter = new NametagMinter({ tokenEngine: engine });
      const result = await minter.mintNametag('carol');
      expect(result.success).toBe(true);
      expect(mintDataToken).toHaveBeenCalledOnce();
    });
  });
});
