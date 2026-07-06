/**
 * Issue #200 Phase 3 — Per-token addressability inside a hierarchical
 * bundle CAR.
 *
 * Pins the architectural claim from the issue body:
 *
 *   "Every component (profile, bundle, token, sub-token field) is
 *    individually addressable by its own CID — fetchable in isolation,
 *    verifiable in isolation."
 *
 * Concretely: after `exportToCar(pkg)` produces a bundle CAR, the
 * recipient can:
 *  1. Fetch the envelope root block by its CID and decode it as
 *     `{version, createdAt, updatedAt, manifest: CID}`.
 *  2. Follow the `manifest` CID to a separately-addressable manifest
 *     block.
 *  3. Read the manifest's `tokens` field as a CID map (`tokenId → CID`).
 *  4. Fetch any one token's root CID and walk its child links to
 *     reassemble the full token subtree IN ISOLATION — without
 *     fetching the sibling tokens' blocks.
 *
 * This isolation property is what enables future partial-recovery
 * paths (Phase 4 hierarchical profile snapshots) and the cross-bundle
 * dedup payoff (Phase 3 sibling test).
 *
 * Where this test sits in the verification stack:
 *  - The block-level fetch primitives are tested by
 *    `tests/unit/profile/fetchCarFromIpfs.test.ts` (Phase 2 walker).
 *  - This test exercises the bundle-CAR layout itself: that the layout
 *    EMITTED BY `exportToCar` is walkable per-token via the standard
 *    BFS shape (root → manifest → tokens[] → token-root → children).
 */

import { describe, it, expect } from 'vitest';
import { CarReader } from '@ipld/car/reader';
import { decode as dagCborDecode } from '@ipld/dag-cbor';
import { CID } from 'multiformats';
import {
  contentHashToCid,
  cidToContentHash,
  exportToCar,
} from '../../../extensions/uxf/bundle/ipld.js';
import { ElementPool } from '../../../extensions/uxf/bundle/element-pool.js';
import { deconstructToken } from '../../../extensions/uxf/bundle/deconstruct.js';
import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
} from '../../../extensions/uxf/bundle/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexFill(pattern: string, totalChars: number): string {
  return pattern.repeat(Math.ceil(totalChars / pattern.length)).slice(0, totalChars);
}

function makeValidToken(suffix: string): Record<string, unknown> {
  const tokenId = hexFill(suffix, 64);
  return {
    version: '2.0',
    state: { predicate: 'a0'.repeat(32), data: null },
    genesis: {
      data: {
        tokenId,
        tokenType: '00'.repeat(32),
        coinData: [['UCT', '1000000']],
        tokenData: '',
        salt: hexFill('ab', 64),
        recipient: 'DIRECT://test',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: '02' + 'aa'.repeat(32),
          signature: '30' + 'bb'.repeat(63),
          stateHash: 'cc'.repeat(32),
        },
        merkleTreePath: {
          root: 'dd'.repeat(32),
          steps: [{ data: 'ee'.repeat(32), path: '0' }],
        },
        transactionHash: 'ff'.repeat(32),
        unicityCertificate: '11'.repeat(100),
      },
    },
    transactions: [],
    nametags: [],
  };
}

function buildPackageFromTokens(tokens: Record<string, unknown>[]): UxfPackageData {
  const pool = new ElementPool();
  const manifest = new Map<string, ContentHash>();
  for (const token of tokens) {
    const rootHash = deconstructToken(pool, token);
    const tokenId = (
      (token.genesis as { data: { tokenId: string } }).data.tokenId
    ).toLowerCase();
    manifest.set(tokenId, rootHash);
  }
  return {
    envelope: { version: '1.0.0', createdAt: 1700000000, updatedAt: 1700000001 },
    manifest: { tokens: manifest },
    pool: pool.toMap() as Map<ContentHash, UxfElement>,
    instanceChains: new Map(),
    indexes: {
      byTokenType: new Map(),
      byCoinId: new Map(),
      byStateHash: new Map(),
    },
  };
}

/**
 * Parse a CAR into a `cid -> bytes` map. Stands in for a content-
 * addressed gateway / store: callers fetch a block by CID by looking
 * up the bytes here.
 */
async function carToBlockMap(
  car: Uint8Array,
): Promise<{ root: CID; blocks: Map<string, Uint8Array> }> {
  const reader = await CarReader.fromBytes(car);
  const roots = await reader.getRoots();
  if (roots.length !== 1) {
    throw new Error(`expected exactly one root, got ${roots.length}`);
  }
  const blocks = new Map<string, Uint8Array>();
  for await (const block of reader.blocks()) {
    blocks.set(block.cid.toString(), block.bytes);
  }
  return { root: roots[0], blocks };
}

/**
 * BFS-walk a dag-cbor DAG starting from `start`, collecting every
 * reachable CID by following Tag 42 links. Treats raw-codec blocks (and
 * blocks not present in the map) as opaque leaves. Returns the set of
 * visited CID strings.
 *
 * Mirrors the shape of `profile/ipfs-client.ts:fetchCarFromIpfs` but
 * operates against an in-memory block map so the test stays free of
 * network mocking.
 */
function walkDag(
  blocks: Map<string, Uint8Array>,
  start: string,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const cidStr = queue.shift()!;
    if (visited.has(cidStr)) continue;
    visited.add(cidStr);

    const blockBytes = blocks.get(cidStr);
    if (blockBytes === undefined) continue;
    const cid = CID.parse(cidStr);
    if (cid.code !== 0x71) continue; // raw / non-dag-cbor → opaque leaf

    let decoded: unknown;
    try {
      decoded = dagCborDecode(blockBytes);
    } catch {
      continue;
    }
    collectCids(decoded, queue);
  }
  return visited;
}

function collectCids(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return;
  if (node instanceof CID || (node as { asCID?: unknown }).asCID === node) {
    out.push((node as CID).toString());
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectCids(item, out);
    return;
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectCids(value, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #200 Phase 3 — per-token addressability in bundle CARs', () => {
  it('envelope block links manifest via a single CID', async () => {
    const pkg = buildPackageFromTokens([makeValidToken('aa'), makeValidToken('bb')]);
    const car = await exportToCar(pkg);
    const { root, blocks } = await carToBlockMap(car);

    const envelopeBytes = blocks.get(root.toString());
    expect(envelopeBytes).toBeDefined();

    const envelope = dagCborDecode(envelopeBytes!) as Record<string, unknown>;
    expect(envelope.manifest).toBeInstanceOf(CID);
    expect(blocks.has((envelope.manifest as CID).toString())).toBe(true);
  });

  it('manifest block exposes one CID per token (the `tokens` CID map)', async () => {
    const tokenA = makeValidToken('aa');
    const tokenB = makeValidToken('bb');
    const tokenC = makeValidToken('cc');
    const pkg = buildPackageFromTokens([tokenA, tokenB, tokenC]);
    const car = await exportToCar(pkg);
    const { root, blocks } = await carToBlockMap(car);

    const envelope = dagCborDecode(blocks.get(root.toString())!) as {
      manifest: CID;
    };
    const manifest = dagCborDecode(blocks.get(envelope.manifest.toString())!) as {
      tokens: Record<string, CID>;
    };

    expect(Object.keys(manifest.tokens).length).toBe(3);
    for (const [, tokenCid] of Object.entries(manifest.tokens)) {
      expect(tokenCid).toBeInstanceOf(CID);
      expect(blocks.has(tokenCid.toString())).toBe(true);
    }
  });

  it('each token CID resolves to a token-root subtree walkable in isolation', async () => {
    const tokenA = makeValidToken('aa');
    const tokenB = makeValidToken('bb');
    const pkg = buildPackageFromTokens([tokenA, tokenB]);
    const car = await exportToCar(pkg);
    const { root, blocks } = await carToBlockMap(car);

    const envelope = dagCborDecode(blocks.get(root.toString())!) as {
      manifest: CID;
    };
    const manifest = dagCborDecode(blocks.get(envelope.manifest.toString())!) as {
      tokens: Record<string, CID>;
    };

    // Pick token A's CID and walk its subtree — should reach all of A's
    // sub-elements without ever visiting the envelope or manifest blocks
    // (those are bundle-level concerns, NOT part of any single token's
    // subtree).
    const tokenAId = hexFill('aa', 64).toLowerCase();
    const tokenACid = manifest.tokens[tokenAId];
    expect(tokenACid).toBeDefined();

    const reachableFromA = walkDag(blocks, tokenACid.toString());

    expect(reachableFromA.has(tokenACid.toString())).toBe(true);
    // Per-token isolation: walking from token A's root must NOT reach
    // the envelope or manifest (they live above the token in the DAG).
    expect(reachableFromA.has(root.toString())).toBe(false);
    expect(reachableFromA.has(envelope.manifest.toString())).toBe(false);
    // Per-token isolation: walking from token A's root must NOT reach
    // token B's root.
    const tokenBId = hexFill('bb', 64).toLowerCase();
    const tokenBCid = manifest.tokens[tokenBId];
    expect(reachableFromA.has(tokenBCid.toString())).toBe(false);
  });

  it('token-root CID is byte-identical to the content hash recorded in the manifest', async () => {
    // The on-wire `manifest.tokens[tokenId]` MUST equal
    // `contentHashToCid(pkg.manifest.tokens.get(tokenId))`. This is the
    // contract that lets recipients verify a fetched token block — they
    // know the expected CID from the manifest and check
    // `cidToContentHash(fetchedCid)` matches.
    const tokenA = makeValidToken('aa');
    const pkg = buildPackageFromTokens([tokenA]);
    const car = await exportToCar(pkg);
    const { root, blocks } = await carToBlockMap(car);

    const envelope = dagCborDecode(blocks.get(root.toString())!) as {
      manifest: CID;
    };
    const manifest = dagCborDecode(blocks.get(envelope.manifest.toString())!) as {
      tokens: Record<string, CID>;
    };

    const tokenAId = hexFill('aa', 64).toLowerCase();
    const tokenACid = manifest.tokens[tokenAId];
    const expectedRootHash = pkg.manifest.tokens.get(tokenAId)!;

    expect(tokenACid.toString()).toBe(contentHashToCid(expectedRootHash).toString());
    expect(cidToContentHash(tokenACid)).toBe(expectedRootHash);
  });
});
