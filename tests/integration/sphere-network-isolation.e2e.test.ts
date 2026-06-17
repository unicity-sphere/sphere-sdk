/**
 * Sphere-level per-network storage isolation e2e test.
 *
 * GOAL (proven through Sphere.init's REAL provider wiring, NOT by constructing
 * providers directly): two wallets built from the SAME mnemonic on DIFFERENT
 * networks, pointed at the SAME on-disk dataDir/tokensDir, are
 *   - STORAGE-ISOLATED for token/payment state  (token DB dir is per-network;
 *     KV token keys are network-prefixed), AND
 *   - IDENTITY-SHARED — same address/chainPubkey on every network (the
 *     XP-invariant), and chat (MESSAGES KV) is network-agnostic → shared.
 *
 * Wiring: we build providers via `createNodeProviders({ network, dataDir, tokensDir })`
 * (impl/nodejs/index.ts:184) which threads `network` into the REAL file storage +
 * file token storage providers (index.ts:226,253). Only the transport + oracle are
 * swapped for offline stubs so the test never touches the network — the
 * network-carrying STORAGE providers stay real, which is the whole point.
 *
 * HOW THE TOKEN GETS INTO INVENTORY: SEEDED, not minted. We call the public
 * `sphere.payments.addToken()` (PaymentsModule.ts:3838), which does NO aggregator
 * call — it inserts into the in-memory map and persists via the FileTokenStorageProvider
 * to `{tokensDir}/{network}/{chainPubkey}/`. getBalance()/getTokens() reflect it
 * directly off the Token fields (no re-validation). The token carries an opaque hex
 * `sdkData` blob so it round-trips through save+load as a "v2 storage entry" (otherwise
 * it would be dropped on persist and never reload — see makeSeedToken). This is a
 * synthetic, unvalidated balance entry — adequate here because isolation is about WHERE
 * state lives, not whether the token is cryptographically valid. The control test below
 * proves the seed genuinely RELOADS on the same network, so the cross-network "B sees
 * nothing" assertion fails-on-regression rather than passing trivially.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Sphere } from '../../core/Sphere';
import { createNodeProviders, type NodeProviders } from '../../impl/nodejs';
import type { TransportProvider } from '../../transport/transport-provider';
import type { OracleProvider } from '../../oracle';
import type { ProviderStatus, Token } from '../../types';
import type { NetworkType } from '../../constants';

// ---------------------------------------------------------------------------
// Networks: A on TEST_NETWORK ('testnet2'), B on a DIFFERENT valid network.
// Both must pass impl/shared/network.assertNetworkConsistency (they have embedded
// trust bases: testnet=networkId 3, testnet2=networkId 4).
// ---------------------------------------------------------------------------
const NETWORK_A: NetworkType = 'testnet2';
const NETWORK_B: NetworkType = 'testnet';

// Known, fixed mnemonic (BIP39 all-zeros test vector) → deterministic
// chainPubkey/address, identical on every network (derivation ignores network).
const KNOWN_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// SAME backing location for both wallets — this is what makes the isolation real:
// if state were not network-scoped, B would see A's token at the same dir.
let SHARED_BASE: string;
let SHARED_DATA_DIR: string;
let SHARED_TOKENS_DIR: string;

// ---------------------------------------------------------------------------
// Offline stubs — transport + oracle only. Storage stays REAL (network-carrying).
// ---------------------------------------------------------------------------
function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Offline transport stub',
    setIdentity: () => {},
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    getStatus: () => 'connected' as ProviderStatus,
    // sendMessage returns a deterministic event id so sendDM persists locally
    // without any real relay.
    sendMessage: async () => `evt-${Date.now()}`,
    onMessage: () => () => {},
    sendTokenTransfer: async () => 'transfer-id',
    onTokenTransfer: () => () => {},
    resolveNametag: async () => null,
    publishIdentityBinding: async () => true,
  } as unknown as TransportProvider;
}

function createMockOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    getStatus: () => 'connected' as ProviderStatus,
    initialize: async () => undefined,
    submitCommitment: async () => ({ requestId: 'test-id' }),
    getProof: async () => null,
    waitForProof: async () => ({ proof: 'mock' }),
    validateToken: async () => ({ valid: true }),
    mintToken: async () => ({ success: true, token: { id: 'mock-token' } }),
  } as unknown as OracleProvider;
}

/**
 * Build a Sphere on `network` through the REAL Sphere.init provider wiring:
 * createNodeProviders threads `network` into the file storage + file token storage
 * providers; we override only transport + oracle with offline stubs.
 *
 * Sphere.init loads-or-creates: the FIRST init on a given dataDir creates the wallet
 * (mnemonic persisted to the SHARED, non-network-scoped MNEMONIC key); subsequent
 * inits on the same dataDir LOAD that same wallet → identical identity.
 */
async function buildWallet(network: NetworkType): Promise<Sphere> {
  const providers: NodeProviders = createNodeProviders({
    network,
    dataDir: SHARED_DATA_DIR,
    tokensDir: SHARED_TOKENS_DIR,
    l1: undefined,
  });
  const { sphere } = await Sphere.init({
    ...providers,
    transport: createMockTransport(),
    oracle: createMockOracle(),
    network,
    mnemonic: KNOWN_MNEMONIC,
  });
  return sphere;
}

/**
 * Build a synthetic-but-PERSISTABLE confirmed token.
 *
 * `sdkData` MUST be a non-JSON, even-length lowercase-hex blob so the token is
 * recognised as a "v2 storage entry" by both the SAVE path
 * (buildTxfStorageData → isV2TokenBlob, txf-serializer.ts:331) and the LOAD path
 * (parseTxfStorageData → isV2TokenEntry, txf-serializer.ts:505). Without it, the
 * token has no `genesis` and no v2 blob, so it is DROPPED on save and never reloads
 * — which would make the "B sees nothing" assertion pass for the wrong reason. The
 * hex blob is opaque/garbage: addToken's spend-queue JSON.parse (PaymentsModule.ts:3926)
 * throws and is swallowed, so the token still lands. We never call send()/validate(),
 * so the unvalidated blob is never inspected by the (mocked) oracle.
 */
function makeSeedToken(id: string): Token {
  const now = Date.now();
  return {
    id,
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount: '10000000',
    status: 'confirmed',
    createdAt: now,
    updatedAt: now,
    sdkData: 'deadbeefcafe', // opaque even-length lowercase hex → v2 storage entry
  };
}

describe('Sphere per-network storage isolation (shared backing dir)', () => {
  beforeEach(() => {
    // Unique temp dir per test; both wallets share it.
    SHARED_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-net-iso-'));
    SHARED_DATA_DIR = path.join(SHARED_BASE, 'data');
    SHARED_TOKENS_DIR = path.join(SHARED_BASE, 'tokens');
    fs.mkdirSync(SHARED_DATA_DIR, { recursive: true });
    fs.mkdirSync(SHARED_TOKENS_DIR, { recursive: true });
    // Sphere is a singleton — reset before each test.
    (Sphere as unknown as { instance: Sphere | null }).instance = null;
  });

  afterEach(() => {
    (Sphere as unknown as { instance: Sphere | null }).instance = null;
    if (SHARED_BASE && fs.existsSync(SHARED_BASE)) {
      fs.rmSync(SHARED_BASE, { recursive: true, force: true });
    }
  });

  it(
    'isolates token inventory across networks while sharing identity + chat',
    async () => {
      // -------------------------------------------------------------------
      // 1) Build wallet A on NETWORK_A. Sphere.init CREATES it (first init on
      //    this dataDir) and persists the mnemonic to the shared KV.
      // -------------------------------------------------------------------
      const a = await buildWallet(NETWORK_A);

      const addrA = a.identity!.directAddress;
      const pkA = a.identity!.chainPubkey;
      expect(pkA).toBeTruthy();

      // -------------------------------------------------------------------
      // 2) SEED a token into A (status 'confirmed') and assert A's inventory
      //    reflects it. addToken() persists to {tokensDir}/<NETWORK_A>/<pk>/.
      // -------------------------------------------------------------------
      const added = await a.payments.addToken(makeSeedToken('seed-token-A-1'));
      expect(added).toBe(true);

      const tokensA = a.payments.getTokens();
      expect(tokensA.map((t) => t.id)).toContain('seed-token-A-1');
      const balA = a.payments.getBalance().find((b) => b.symbol === 'UCT');
      expect(balA?.confirmedAmount).toBe('10000000');

      // Write a DM via the (mocked) transport — persists to the per-address,
      // NETWORK-AGNOSTIC MESSAGES key, so a wallet on any network sharing this
      // dataDir reads it back. (peer key: a different valid x-only pubkey.)
      const peerPubkey =
        '02b4632d08485ff1df2db55b9dafd23347d1c47a457072a1e87be26896549a8737';
      await a.communications.sendDM(peerPubkey, 'hello across networks');
      const convA = a.communications.getConversations();
      const peerConvA = [...convA.values()].flat();
      expect(peerConvA.some((m) => m.content === 'hello across networks')).toBe(true);

      // Token file landed under NETWORK_A's segment on disk.
      expect(
        fs.existsSync(path.join(SHARED_TOKENS_DIR, NETWORK_A, pkA)),
      ).toBe(true);

      // Tear A down (also resets the Sphere singleton).
      await a.destroy();
      (Sphere as unknown as { instance: Sphere | null }).instance = null;

      // -------------------------------------------------------------------
      // 3) Build wallet B on NETWORK_B, SAME mnemonic, SAME dataDir/tokensDir.
      //    Sphere.init finds the shared mnemonic → LOADS (same identity), but
      //    its token storage reads {tokensDir}/<NETWORK_B>/<pk>/ (different dir).
      // -------------------------------------------------------------------
      const b = await buildWallet(NETWORK_B);

      // -------------------------------------------------------------------
      // 4) ISOLATION — B's token inventory does NOT see A's token.
      //    This is the load-bearing assertion: it fails-on-regression because if
      //    the token DB / KV stopped being network-scoped, B would read A's dir
      //    and 'seed-token-A-1' would appear here.
      // -------------------------------------------------------------------
      const tokensB = b.payments.getTokens();
      expect(tokensB.map((t) => t.id)).not.toContain('seed-token-A-1');
      expect(tokensB).toHaveLength(0);
      const balB = b.payments.getBalance().find((bb) => bb.symbol === 'UCT');
      expect(balB).toBeUndefined();

      // B's per-network token dir is a DIFFERENT path than A's.
      expect(
        fs.existsSync(path.join(SHARED_TOKENS_DIR, NETWORK_A, pkA)),
      ).toBe(true); // A's still there...
      // ...and they are genuinely different directories.
      expect(path.join(SHARED_TOKENS_DIR, NETWORK_A, pkA)).not.toBe(
        path.join(SHARED_TOKENS_DIR, NETWORK_B, pkA),
      );

      // -------------------------------------------------------------------
      // 5) IDENTITY-SHARED — same address/chainPubkey (network-agnostic).
      // -------------------------------------------------------------------
      expect(b.identity!.chainPubkey).toBe(pkA);
      expect(b.identity!.directAddress).toBe(addrA);

      // -------------------------------------------------------------------
      // 6) CHAT SHARED — B sees the conversation A wrote (MESSAGES KV is
      //    per-address but NOT network-scoped → same key across networks).
      // -------------------------------------------------------------------
      const convB = b.communications.getConversations();
      const peerConvB = [...convB.values()].flat();
      expect(peerConvB.some((m) => m.content === 'hello across networks')).toBe(true);

      await b.destroy();
    },
    60_000,
  );

  it(
    'control: SAME network + same dirs → B DOES see A token (proves the dir is shared, isolation is by network only)',
    async () => {
      // This negative control proves the previous test isn't passing for a
      // trivial reason (e.g. B always sees an empty store). With the SAME
      // network, the per-network dir is identical, so the seeded token IS visible.
      const a = await buildWallet(NETWORK_A);
      const added = await a.payments.addToken(makeSeedToken('seed-token-same-net'));
      expect(added).toBe(true);
      const pk = a.identity!.chainPubkey;
      await a.destroy();
      (Sphere as unknown as { instance: Sphere | null }).instance = null;

      const b = await buildWallet(NETWORK_A); // SAME network this time
      expect(b.identity!.chainPubkey).toBe(pk);
      const tokensB = b.payments.getTokens();
      expect(tokensB.map((t) => t.id)).toContain('seed-token-same-net');
      await b.destroy();
    },
    60_000,
  );
});
