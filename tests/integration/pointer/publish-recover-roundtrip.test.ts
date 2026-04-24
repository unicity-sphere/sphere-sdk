/**
 * ProfilePointerLayer end-to-end round trip (T-D12).
 *
 * Exercises `publish(cidProducer)` followed by `recoverLatest()`
 * against a fake aggregator and in-memory IPFS mock. The test lives
 * at the integration layer (not unit) because it wires the entire
 * pointer-layer stack:
 *
 *   ProfilePointerLayer
 *     → publish-algorithm / reconcile-algorithm
 *       → aggregator-submit / aggregator-probe
 *         → fake AggregatorClient (stores commitments → replays as proofs)
 *     → discover-algorithm → classifyVersion → fake CAR fetcher
 *     → resolveRemoteCid → decodeVersionCid (real Phase 1+2 XOR-decode)
 *
 * What the fake aggregator does: on submitCommitment it records
 * `requestId → transactionHash.data` (the ct ciphertext for that side).
 * On getInclusionProof it returns a proof whose
 * `verify(trustBase, ...)` resolves to OK and whose
 * `transactionHash.data` is exactly the stored ct. The pointer layer
 * then XOR-decodes ct using its own xorKey (pre-shared via key
 * material derivation) and recovers the original CID.
 *
 * The proofs are NOT cryptographically valid (no real merkle path,
 * no real signature). The test verifies the pointer layer's
 * interaction contract with the aggregator and its recovery
 * arithmetic — not inclusion-proof cryptography, which is covered
 * separately by the SDK's own tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';
import { SubmitCommitmentResponse, SubmitCommitmentStatus } from '@unicitylabs/state-transition-sdk/lib/api/SubmitCommitmentResponse.js';
import { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from '@noble/hashes/sha2.js';
import { create as createDigest } from 'multiformats/hashes/digest';

import {
  ProfilePointerLayer,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  buildPointerSigner,
  FlagStore,
  DURABLE_STORAGE,
  type CarFetcher,
  type CidDecoder,
  type FetchAndJoinCallback,
} from '../../../profile/aggregator-pointer';
import { decodeVersionCid } from '../../../profile/aggregator-pointer/aggregator-probe';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET_SEED = new Uint8Array(32).fill(0x33);

function makeDurableStore() {
  const kv = new Map<string, string>();
  return {
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => {
      kv.set(k, v);
    },
    remove: async (k: string) => {
      kv.delete(k);
    },
    has: async (k: string) => kv.has(k),
    keys: async () => [...kv.keys()],
    clear: async () => {
      kv.clear();
    },
    setIdentity: () => {},
    saveTrackedAddresses: async () => {},
    loadTrackedAddresses: async () => [],
    initialize: async () => {},
    shutdown: async () => {},
    name: 'test',
    [DURABLE_STORAGE]: true as const,
  };
}

/**
 * Fake aggregator: stores the raw ct bytes from each submitCommitment
 * keyed by `requestId.toString()`, then replays them as
 * `inclusionProof.transactionHash.data` on getInclusionProof.
 *
 * `verify()` resolves to OK unconditionally — the test is not
 * validating inclusion-proof cryptography, only the ct-round-trip
 * contract between publisher and aggregator.
 */
function makeFakeAggregator(): {
  client: AggregatorClient;
  commitments: Map<string, Uint8Array>;
} {
  const commitments = new Map<string, Uint8Array>();

  const client = {
    async submitCommitment(
      requestId: { toString(): string },
      transactionHash: { data: Uint8Array },
      _authenticator: unknown,
    ) {
      commitments.set(requestId.toString(), new Uint8Array(transactionHash.data));
      return new SubmitCommitmentResponse(SubmitCommitmentStatus.SUCCESS);
    },
    async getInclusionProof(requestId: { toString(): string }) {
      const data = commitments.get(requestId.toString());
      if (!data) {
        return {
          inclusionProof: {
            verify: async () => InclusionProofVerificationStatus.PATH_NOT_INCLUDED,
            transactionHash: null,
          },
        };
      }
      return {
        inclusionProof: {
          verify: async () => InclusionProofVerificationStatus.OK,
          transactionHash: { data },
        },
      };
    },
  } as unknown as AggregatorClient;

  return { client, commitments };
}

/** Build a CIDv1 (raw codec, sha256) for arbitrary bytes. */
function cidForBytes(bytes: Uint8Array): CID {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest);
}

/** CarFetcher stub — always succeeds. CAR contents aren't validated here. */
const alwaysOkCarFetcher: CarFetcher = async () => ({ ok: true });

/**
 * CidDecoder wrapper — mirrors the production wiring in
 * pointer-wiring.ts. The 64-byte `full` buffer is length-prefixed
 * per SPEC §5.3: byte 0 is `cidLen`, bytes [1..1+cidLen] are the
 * raw CID, the rest is derived padding.
 */
const multiformatsDecoder: CidDecoder = (full: Uint8Array) => {
  try {
    if (full.length === 0) return { ok: false };
    const cidLen = full[0];
    if (cidLen === undefined || cidLen === 0 || cidLen > full.length - 1) {
      return { ok: false };
    }
    const cid = CID.decode(full.subarray(1, 1 + cidLen));
    return { ok: true, cidBytes: new Uint8Array(cid.bytes) };
  } catch {
    return { ok: false };
  }
};

async function buildLayer(deps: {
  aggregatorClient: AggregatorClient;
  readLocal: () => Promise<number>;
  persistLocal: (v: number) => Promise<void>;
}): Promise<ProfilePointerLayer> {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  const storage = makeDurableStore();
  const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);

  // In-memory mutex — no need for real file locks in this integration test.
  let held = false;
  const queue: Array<() => void> = [];
  const mutex = {
    async acquire() {
      if (held) {
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      held = true;
      return {
        release: async () => {
          held = false;
          const next = queue.shift();
          if (next) next();
        },
        assertHeld: () => {
          if (!held) throw new Error('fake mutex: lock lost');
        },
      };
    },
  };

  const trustBase = {} as unknown as RootTrustBase;

  const fetchAndJoin: FetchAndJoinCallback = async () => {
    // No conflicts in this test — the callback is never reached.
    throw new Error('fetchAndJoin should not fire in a single-writer round-trip');
  };

  const resolveRemoteCid = async (version: number): Promise<Uint8Array> => {
    const result = await decodeVersionCid({
      v: version,
      keyMaterial,
      signer,
      aggregatorClient: deps.aggregatorClient,
      trustBase,
      decodeCid: multiformatsDecoder,
    });
    if (!result.ok) {
      throw new Error(`decodeVersionCid failed: ${result.reason}`);
    }
    return result.cidBytes;
  };

  return new ProfilePointerLayer({
    keyMaterial,
    signer,
    aggregatorClient: deps.aggregatorClient,
    trustBase,
    flagStore,
    mutex,
    decodeCid: multiformatsDecoder,
    fetchCar: alwaysOkCarFetcher,
    fetchAndJoin,
    readLocalVersion: deps.readLocal,
    persistLocalVersion: deps.persistLocal,
    resolveRemoteCid,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfilePointerLayer publish → recover round trip (T-D12)', () => {
  let localVersion = 0;

  beforeEach(() => {
    localVersion = 0;
  });

  it('publishes a CID at v=1 and recoverLatest returns the same CID', async () => {
    const { client } = makeFakeAggregator();

    const layer = await buildLayer({
      aggregatorClient: client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
    });

    const payload = new TextEncoder().encode('hello uxf');
    const publishedCid = cidForBytes(payload);

    const publishResult = await layer.publish(async () => publishedCid.bytes);

    expect(publishResult.version).toBe(1);
    expect(publishResult.attemptsUsed).toBe(1);
    expect(localVersion).toBe(1);

    const recovered = await layer.recoverLatest();
    expect(recovered).not.toBeNull();
    if (!recovered) return;

    // The recovered CID bytes must equal what we published.
    expect(recovered.version).toBe(1);
    const recoveredCid = CID.decode(recovered.cid);
    expect(recoveredCid.toString()).toBe(publishedCid.toString());
  });

  it('publishes twice; recoverLatest returns the most recent CID', async () => {
    const { client } = makeFakeAggregator();

    const layer = await buildLayer({
      aggregatorClient: client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
    });

    const firstCid = cidForBytes(new TextEncoder().encode('first'));
    const secondCid = cidForBytes(new TextEncoder().encode('second'));

    const first = await layer.publish(async () => firstCid.bytes);
    expect(first.version).toBe(1);

    const second = await layer.publish(async () => secondCid.bytes);
    expect(second.version).toBe(2);

    expect(localVersion).toBe(2);

    const recovered = await layer.recoverLatest();
    expect(recovered).not.toBeNull();
    if (!recovered) return;
    expect(recovered.version).toBe(2);
    expect(CID.decode(recovered.cid).toString()).toBe(secondCid.toString());
  });

  it('returns null from recoverLatest when nothing was ever published', async () => {
    const { client } = makeFakeAggregator();

    const layer = await buildLayer({
      aggregatorClient: client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
    });

    const recovered = await layer.recoverLatest();
    expect(recovered).toBeNull();
  });
});
