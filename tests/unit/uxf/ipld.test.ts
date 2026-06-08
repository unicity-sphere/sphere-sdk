import { describe, it, expect } from 'vitest';
import {
  computeCid,
  contentHashToCid,
  cidToContentHash,
  elementToIpldBlock,
  exportToCar,
  importFromCar,
} from '../../../uxf/ipld.js';
import { verify } from '../../../uxf/verify.js';
import { ElementPool } from '../../../uxf/element-pool.js';
import { deconstructToken } from '../../../uxf/deconstruct.js';
import { computeElementHash } from '../../../uxf/hash.js';
import { CID } from 'multiformats';
import { encode as dagCborEncode, decode as dagCborDecode } from '@ipld/dag-cbor';
import { CarWriter } from '@ipld/car/writer';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  InstanceChainEntry,
} from '../../../uxf/types.js';
import { contentHash } from '../../../uxf/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexFill(pattern: string, totalChars: number): string {
  return pattern.repeat(Math.ceil(totalChars / pattern.length)).slice(0, totalChars);
}

function makeElement(
  type: UxfElement['type'],
  content: Record<string, unknown> = {},
  children: Record<string, ContentHash | ContentHash[] | null> = {},
): UxfElement {
  return {
    header: { representation: 1, semantics: 1, kind: 'default', predecessor: null },
    type,
    content,
    children,
  };
}

function makePackage(
  manifest: Map<string, ContentHash>,
  pool: Map<ContentHash, UxfElement>,
  instanceChains: Map<ContentHash, InstanceChainEntry> = new Map(),
): UxfPackageData {
  return {
    envelope: { version: '1.0.0', createdAt: 1700000000, updatedAt: 1700000001 },
    manifest: { tokens: manifest },
    pool,
    instanceChains,
    indexes: {
      byTokenType: new Map(),
      byCoinId: new Map(),
      byStateHash: new Map(),
    },
  };
}

function makeValidToken(suffix: string, predicateHex: string = 'a0'.repeat(32)): Record<string, unknown> {
  const tokenId = hexFill(suffix, 64);
  return {
    version: '2.0',
    state: { predicate: predicateHex, data: null },
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

function buildPackageFromToken(token: Record<string, unknown>): UxfPackageData {
  const pool = new ElementPool();
  const rootHash = deconstructToken(pool, token);
  const tokenId = ((token.genesis as any).data as any).tokenId.toLowerCase();
  const manifest = new Map<string, ContentHash>();
  manifest.set(tokenId, rootHash);
  return makePackage(manifest, pool.toMap() as Map<ContentHash, UxfElement>);
}

function buildPackageFromTokens(tokens: Record<string, unknown>[]): UxfPackageData {
  const pool = new ElementPool();
  const manifest = new Map<string, ContentHash>();
  for (const token of tokens) {
    const rootHash = deconstructToken(pool, token);
    const tokenId = ((token.genesis as any).data as any).tokenId.toLowerCase();
    manifest.set(tokenId, rootHash);
  }
  return makePackage(manifest, pool.toMap() as Map<ContentHash, UxfElement>);
}

// ---------------------------------------------------------------------------
// Tests -- computeCid
// ---------------------------------------------------------------------------

describe('computeCid', () => {
  it('deterministic: same element produces same CID', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const cid1 = computeCid(el);
    const cid2 = computeCid(el);
    expect(cid1.toString()).toBe(cid2.toString());
  });

  it('CID uses dag-cbor codec (0x71)', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const cid = computeCid(el);
    expect(cid.code).toBe(0x71);
  });

  it('CID uses sha2-256 hash (0x12)', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const cid = computeCid(el);
    expect(cid.multihash.code).toBe(0x12);
  });
});

// ---------------------------------------------------------------------------
// Tests -- contentHashToCid / cidToContentHash
// ---------------------------------------------------------------------------

describe('contentHashToCid / cidToContentHash', () => {
  it('CID digest matches ContentHash', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const hash = computeElementHash(el);
    const cid = computeCid(el);
    expect(cidToContentHash(cid)).toBe(hash);
  });

  it('round-trip: contentHashToCid then cidToContentHash', () => {
    const hash = contentHash('a0'.repeat(32));
    const cid = contentHashToCid(hash);
    expect(cidToContentHash(cid)).toBe(hash);
  });

  it('non-sha256 CID throws SERIALIZATION_ERROR', () => {
    const fakeDigest = new Uint8Array(32).fill(0xaa);
    const fakeMultihashBytes = new Uint8Array(2 + 32);
    fakeMultihashBytes[0] = 0x14; // sha3-256
    fakeMultihashBytes[1] = 32;
    fakeMultihashBytes.set(fakeDigest, 2);
    const fakeMultihash = { code: 0x14, size: 32, digest: fakeDigest, bytes: fakeMultihashBytes };
    const fakeCid = CID.createV1(0x71, fakeMultihash);

    expect(() => cidToContentHash(fakeCid)).toThrow(/SERIALIZATION_ERROR/);
  });
});

// ---------------------------------------------------------------------------
// Tests -- elementToIpldBlock
// ---------------------------------------------------------------------------

describe('elementToIpldBlock', () => {
  it('returns cid and bytes', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const block = elementToIpldBlock(el);
    expect(block.cid).toBeDefined();
    expect(block.bytes).toBeInstanceOf(Uint8Array);
    expect(block.bytes.length).toBeGreaterThan(0);
  });

  it('children encoded as dag-cbor Tag 42 CID-links (#435 canonical form)', () => {
    // Issue #435 — child references are emitted as Tag 42 CID-links
    // so Kubo's recursive pin / `/dag/export` walkers natively follow
    // the DAG. Same for `header[3]` predecessor refs.
    const pkg = buildPackageFromToken(makeValidToken('a1'));

    for (const [, element] of pkg.pool) {
      const childValues = Object.values(element.children).filter((v) => v !== null);
      if (childValues.length > 0) {
        const block = elementToIpldBlock(element);
        const decoded = dagCborDecode(block.bytes) as Record<string, any>;

        for (const [, value] of Object.entries(decoded.children)) {
          if (value !== null) {
            if (Array.isArray(value)) {
              for (const item of value) {
                expect(item).toBeInstanceOf(CID);
                expect((item as CID).code).toBe(0x71);
                expect((item as CID).multihash.code).toBe(0x12);
                expect((item as CID).multihash.digest.byteLength).toBe(32);
              }
            } else {
              expect(value).toBeInstanceOf(CID);
              expect((value as CID).code).toBe(0x71);
              expect((value as CID).multihash.code).toBe(0x12);
              expect((value as CID).multihash.digest.byteLength).toBe(32);
            }
          }
        }
        return;
      }
    }
    expect.fail('No element with children found');
  });

  it('block bytes hash to the block CID (#435 self-consistency)', () => {
    // Issue #435 invariant (carried over from #213): `sha256(block.bytes)`
    // === `cid.multihash.digest` for every UXF element block. The hash
    // canonical form and the IPLD canonical form are still a single
    // bit-identical form; the only change is that child / predecessor
    // refs are now Tag 42 CIDs instead of raw 32-byte Uint8Array.
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    let checked = 0;
    for (const [, element] of pkg.pool) {
      const block = elementToIpldBlock(element);
      const computed = nobleSha256(block.bytes);
      const claimed = block.cid.multihash.digest;
      expect(computed.length).toBe(claimed.length);
      for (let i = 0; i < computed.length; i++) {
        expect(computed[i]).toBe(claimed[i]);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('CID matches computeElementHash', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const block = elementToIpldBlock(el);
    const hash = computeElementHash(el);
    expect(cidToContentHash(block.cid)).toBe(hash);
  });

  it('header[3] predecessor encoded as Tag 42 CID-link (#435 wire-shape)', () => {
    // Issue #435 — predecessor refs ride in the canonical CBOR as Tag
    // 42 CID-links so Kubo's recursive pin / `/dag/export` walkers
    // traverse instance-chain edges natively.
    //
    // The self-consistency test above (`block bytes hash to the block
    // CID`) would still pass under a regression to `hexToBytes(predecessor)`
    // because both `computeElementHash` and `elementToIpldBlock` share
    // `buildCanonicalHeader`. This test inspects the dag-cbor-decoded
    // wire bytes directly to guard against that silent drift.
    const predecessorHex = '11'.repeat(32);
    const el: UxfElement = {
      header: { representation: 1, semantics: 1, kind: 'default', predecessor: contentHash(predecessorHex) },
      type: 'token-state',
      content: { predicate: 'a0'.repeat(32), data: null },
      children: {},
    };
    const block = elementToIpldBlock(el);
    const decoded = dagCborDecode(block.bytes) as Record<string, unknown>;
    const header = decoded.header as unknown[];
    expect(Array.isArray(header)).toBe(true);
    const wirePredecessor = header[3];
    expect(wirePredecessor).toBeInstanceOf(CID);
    const wirePredCid = wirePredecessor as CID;
    expect(wirePredCid.code).toBe(0x71);
    expect(wirePredCid.multihash.code).toBe(0x12);
    expect(wirePredCid.multihash.digest.byteLength).toBe(32);
    expect(wirePredCid.multihash.digest).toEqual(new Uint8Array(32).fill(0x11));
  });
});

// ---------------------------------------------------------------------------
// Tests -- exportToCar / importFromCar
// ---------------------------------------------------------------------------

describe('exportToCar / importFromCar', () => {
  it('round-trip preserves package', async () => {
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    const car = await exportToCar(pkg);
    const restored = await importFromCar(car);

    expect(restored.pool.size).toBe(pkg.pool.size);
    expect(restored.manifest.tokens.size).toBe(pkg.manifest.tokens.size);
    for (const [tokenId, rootHash] of pkg.manifest.tokens) {
      expect(restored.manifest.tokens.get(tokenId)).toBe(rootHash);
    }
    for (const hash of pkg.pool.keys()) {
      expect(restored.pool.has(hash)).toBe(true);
    }
  });

  it('round-trip package verifies with no errors', async () => {
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    const car = await exportToCar(pkg);
    const restored = await importFromCar(car);
    const result = verify(restored);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('envelope preserved in round-trip', async () => {
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    const car = await exportToCar(pkg);
    const restored = await importFromCar(car);

    expect(restored.envelope.version).toBe(pkg.envelope.version);
    expect(restored.envelope.createdAt).toBe(pkg.envelope.createdAt);
    expect(restored.envelope.updatedAt).toBe(pkg.envelope.updatedAt);
  });

  it('shared elements appear once in multi-token CAR', async () => {
    const pkg = buildPackageFromTokens([makeValidToken('a1'), makeValidToken('a2', 'b0'.repeat(32))]);
    const car = await exportToCar(pkg);
    const restored = await importFromCar(car);
    expect(restored.pool.size).toBe(pkg.pool.size);
  });

  it('empty package round-trips', async () => {
    const emptyPkg = makePackage(new Map(), new Map());
    const car = await exportToCar(emptyPkg);
    const restored = await importFromCar(car);

    expect(restored.pool.size).toBe(0);
    expect(restored.manifest.tokens.size).toBe(0);
    expect(restored.envelope.version).toBe('1.0.0');
  });

  it('hash verification during CAR import detects tampering', async () => {
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    const car = await exportToCar(pkg);

    const tampered = new Uint8Array(car);
    const idx = Math.floor(tampered.length * 0.75);
    tampered[idx] = tampered[idx] ^ 0xff;

    await expect(importFromCar(tampered)).rejects.toThrow();
  });

  it('#435: rejects legacy PR-#213 Option C Uint8Array children at import', async () => {
    // Issue #435 explicitly drops backward compatibility for the PR
    // #213 Option C raw-byte child encoding (testnet posture — wallets
    // re-mint / re-receive tokens). A hand-crafted block whose children
    // are raw 32-byte Uint8Array values must be rejected by the
    // receiver instead of silently decoded.
    const pkg = buildPackageFromToken(makeValidToken('a1'));

    // Find any element with at least one non-null child reference.
    let target: { hash: ContentHash; element: UxfElement } | null = null;
    for (const [hash, element] of pkg.pool) {
      if (Object.values(element.children).some((v) => v !== null)) {
        target = { hash, element };
        break;
      }
    }
    if (!target) {
      expect.fail('No element with children to test Option-C rejection path');
    }

    // Re-encode the element using the OLD Option-C form (raw Uint8Array
    // children) and a Tag 42 predecessor (#435 form) so the only deviation
    // is the children encoding — the import must reject this shape.
    const headerArr = [
      target.element.header.representation,
      target.element.header.semantics,
      target.element.header.kind,
      target.element.header.predecessor !== null
        ? CID.createV1(
            0x71,
            makeSha256DigestLocal(hexToBytesLocal(target.element.header.predecessor)),
          )
        : null,
    ];
    const optionCChildren: Record<string, any> = {};
    for (const [k, v] of Object.entries(target.element.children)) {
      if (v === null) {
        optionCChildren[k] = null;
      } else if (Array.isArray(v)) {
        optionCChildren[k] = (v as string[]).map((h) => hexToBytesLocal(h));
      } else {
        optionCChildren[k] = hexToBytesLocal(v as string);
      }
    }

    // Decode and confirm the test fixture really is in Option-C shape.
    const optionCNode = {
      header: headerArr,
      type: 0x01, // arbitrary — fixture is for decodeIpldChildren shape only
      content: target.element.content,
      children: optionCChildren,
    };
    const optionCBytes = dagCborEncode(optionCNode);
    const optionCDecoded = dagCborDecode(optionCBytes) as any;
    for (const value of Object.values(optionCDecoded.children)) {
      if (value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          expect(item).toBeInstanceOf(Uint8Array);
        }
      } else {
        expect(value).toBeInstanceOf(Uint8Array);
      }
    }

    // Build a single-element CAR that points at this node as the
    // envelope root. The point is to exercise the import-side decoder
    // — it must reject Option-C-shaped children with SERIALIZATION_ERROR.
    const rootDigest = makeSha256DigestLocal(nobleSha256(optionCBytes));
    const rootCid = CID.createV1(0x71, rootDigest);
    const { writer, out } = CarWriter.create([rootCid]);
    const collectPromise = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    await writer.put({ cid: rootCid, bytes: optionCBytes });
    await writer.close();
    const chunks = await collectPromise;
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const carBytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      carBytes.set(c, off);
      off += c.byteLength;
    }

    await expect(importFromCar(carBytes)).rejects.toThrow();
  });
});

function hexToBytesLocal(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function makeSha256DigestLocal(hash: Uint8Array): {
  code: 0x12;
  size: number;
  digest: Uint8Array;
  bytes: Uint8Array;
} {
  const code = 0x12 as const;
  const size = hash.length;
  const bytes = new Uint8Array(2 + size);
  bytes[0] = code;
  bytes[1] = size;
  bytes.set(hash, 2);
  return { code, size, digest: hash, bytes };
}

// ---------------------------------------------------------------------------
// Tests -- steelman regression: importFromCar hardening (FIX 1, 2, 3, 5, 6, 12)
// ---------------------------------------------------------------------------

const DAG_CBOR_CODE_TEST = 0x71;

function makeSha256Digest(hash: Uint8Array): { code: 0x12; size: number; digest: Uint8Array; bytes: Uint8Array } {
  const code = 0x12 as const;
  const size = hash.length;
  const bytes = new Uint8Array(2 + size);
  bytes[0] = code;
  bytes[1] = size;
  bytes.set(hash, 2);
  return { code, size, digest: hash, bytes };
}

async function collectCar(writer: { close(): Promise<void> }, out: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const collect = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  await writer.close();
  await collect;
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return bytes;
}

describe('importFromCar — multi-root rejection (FIX 1, spec §5.2 #1)', () => {
  it('CAR with 2 roots → INVALID_PACKAGE', async () => {
    // Two minimal arbitrary CIDs as roots.
    const bytesA = dagCborEncode({ a: 1 });
    const bytesB = dagCborEncode({ b: 2 });
    const cidA = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(bytesA)));
    const cidB = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(bytesB)));

    const { writer, out } = CarWriter.create([cidA, cidB]);
    const collectPromise = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    await writer.put({ cid: cidA, bytes: bytesA });
    await writer.put({ cid: cidB, bytes: bytesB });
    await writer.close();
    const chunks = await collectPromise;
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const car = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      car.set(c, off);
      off += c.byteLength;
    }

    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('INVALID_PACKAGE');
    expect(String(err.message)).toMatch(/Multi-root CAR rejected/);
  });

  it('UxfPackage.fromCar rejects multi-root CAR with INVALID_PACKAGE', async () => {
    const { UxfPackage } = await import('../../../uxf/UxfPackage.js');
    const bytesA = dagCborEncode({ a: 1 });
    const bytesB = dagCborEncode({ b: 2 });
    const cidA = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(bytesA)));
    const cidB = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(bytesB)));
    const { writer, out } = CarWriter.create([cidA, cidB]);
    const collectPromise = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    await writer.put({ cid: cidA, bytes: bytesA });
    await writer.put({ cid: cidB, bytes: bytesB });
    await writer.close();
    const chunks = await collectPromise;
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const car = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      car.set(c, off);
      off += c.byteLength;
    }
    let err: any;
    try {
      await UxfPackage.fromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('INVALID_PACKAGE');
  });
});

describe('importFromCar — envelope+manifest block hash verification (FIX 2)', () => {
  it('envelope CID with mismatching bytes throws VERIFICATION_FAILED', async () => {
    // Build a CAR where envelope CID claims one digest but the bytes
    // we actually write hash to a different value.
    const realEnvelopeBytes = dagCborEncode({
      version: '1.0.0',
      createdAt: 1,
      updatedAt: 1,
      manifest: CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(dagCborEncode({ tokens: {} })))),
    });
    // Use a CID derived from DIFFERENT bytes
    const fakeBytes = dagCborEncode({ different: 'content' });
    const fakeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(fakeBytes)));

    const { writer, out } = CarWriter.create([fakeCid]);
    const collectPromise = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    // Write envelope under the FAKE cid but with REAL bytes (mismatch).
    await writer.put({ cid: fakeCid, bytes: realEnvelopeBytes });
    await writer.close();
    const chunks = await collectPromise;
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const car = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      car.set(c, off);
      off += c.byteLength;
    }

    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('VERIFICATION_FAILED');
    expect(String(err.message)).toMatch(/Envelope block hash does not match its CID/);
  });

  it('manifest CID with mismatching bytes throws VERIFICATION_FAILED', async () => {
    // The manifest CID is referenced from the envelope, but the bytes
    // we put under that CID hash to something else.
    const fakeManifestBytes = dagCborEncode({ tokens: {} });
    const fakeManifestCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(dagCborEncode({ different: 1 }))));

    const envelopeNode = {
      version: '1.0.0',
      createdAt: 1,
      updatedAt: 1,
      manifest: fakeManifestCid,
    };
    const envelopeBytes = dagCborEncode(envelopeNode);
    const envelopeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(envelopeBytes)));

    const { writer, out } = CarWriter.create([envelopeCid]);
    const collectPromise = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    await writer.put({ cid: envelopeCid, bytes: envelopeBytes });
    // Manifest bytes don't hash to fakeManifestCid
    await writer.put({ cid: fakeManifestCid, bytes: fakeManifestBytes });
    await writer.close();
    const chunks = await collectPromise;
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const car = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      car.set(c, off);
      off += c.byteLength;
    }

    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('VERIFICATION_FAILED');
    expect(String(err.message)).toMatch(/Manifest block hash does not match its CID/);
  });
});

describe('exportToCar / importFromCar — predecessor BFS walk (FIX 3)', () => {
  it('predecessor element survives CAR round-trip', async () => {
    // Build a token, then construct an instance chain by adding a
    // synthetic successor element whose `header.predecessor` points at
    // the original root hash. The package's manifest references the
    // SUCCESSOR root (head), so the BFS walk MUST follow predecessor
    // back to include the original.
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    const origRootHash = Array.from(pkg.manifest.tokens.values())[0]!;
    const origRootEl = pkg.pool.get(origRootHash)!;

    // Synthesize a successor TokenRoot element that links to origRoot
    // via predecessor. Hash & insert into pool.
    const successor: UxfElement = {
      header: {
        representation: origRootEl.header.representation,
        semantics: origRootEl.header.semantics,
        kind: origRootEl.header.kind,
        predecessor: origRootHash,
      },
      type: origRootEl.type,
      content: origRootEl.content,
      children: origRootEl.children,
    };
    const successorHash = computeElementHash(successor);
    pkg.pool.set(successorHash, successor);

    // Repoint manifest at the successor — this is the head.
    const tokenId = Array.from(pkg.manifest.tokens.keys())[0]!;
    pkg.manifest.tokens.set(tokenId, successorHash);

    const car = await exportToCar(pkg);
    const restored = await importFromCar(car);

    // The predecessor (original root) MUST be present in the restored
    // pool for instance-chain materialisation to work.
    expect(restored.pool.has(origRootHash)).toBe(true);
    expect(restored.pool.has(successorHash)).toBe(true);
  });
});

describe('importFromCar — pre-parse byte cap (FIX 5)', () => {
  it('CAR larger than CAR_IMPORT_MAX_TOTAL_BYTES (64 MiB) is rejected before parse', async () => {
    // Allocating a 64 MiB Uint8Array filled with zeros — the cap MUST
    // fire purely on byteLength, not on parse success.
    const oversize = new Uint8Array(64 * 1024 * 1024 + 1);
    let err: any;
    try {
      await importFromCar(oversize);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('LIMIT_EXCEEDED');
    expect(String(err.message)).toMatch(/CAR exceeds max bytes/);
  });
});

describe('importFromCar — manifest tokenId validation (FIX 6)', () => {
  async function buildCarWithManifest(manifestTokens: Record<string, CID>): Promise<Uint8Array> {
    const manifestNode = { tokens: manifestTokens };
    const manifestBytes = dagCborEncode(manifestNode);
    const manifestCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(manifestBytes)));
    const envelopeNode = {
      version: '1.0.0',
      createdAt: 1,
      updatedAt: 1,
      manifest: manifestCid,
    };
    const envelopeBytes = dagCborEncode(envelopeNode);
    const envelopeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(envelopeBytes)));
    const { writer, out } = CarWriter.create([envelopeCid]);
    const collectPromise = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    await writer.put({ cid: envelopeCid, bytes: envelopeBytes });
    await writer.put({ cid: manifestCid, bytes: manifestBytes });
    await writer.close();
    const chunks = await collectPromise;
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const car = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      car.set(c, off);
      off += c.byteLength;
    }
    return car;
  }

  it('manifest with __proto__ key is rejected', async () => {
    const fakeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(new Uint8Array(32)));
    const car = await buildCarWithManifest({ __proto__: fakeCid } as any);
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/Invalid manifest tokenId/);
  });

  it('manifest with empty-string key is rejected', async () => {
    const fakeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(new Uint8Array(32)));
    const car = await buildCarWithManifest({ '': fakeCid });
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('manifest with 63-char hex key is rejected', async () => {
    const fakeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(new Uint8Array(32)));
    const car = await buildCarWithManifest({ ['ab'.repeat(31) + 'a']: fakeCid });
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('manifest with wrong-length hex key is rejected', async () => {
    // #226: the regex was relaxed from `{64}` to `{64,68}` so invoice
    // tokenIds (imprint form, 68 chars) survive a round-trip through
    // the CAR import. A length outside the [64, 68] range still gets
    // rejected — 70 chars is the smallest unambiguous over-cap value.
    const fakeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(new Uint8Array(32)));
    const car = await buildCarWithManifest({ ['ab'.repeat(35)]: fakeCid }); // 70 chars
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('manifest with non-hex unicode key is rejected', async () => {
    const fakeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(new Uint8Array(32)));
    const key = 'zz'.repeat(32);
    const car = await buildCarWithManifest({ [key]: fakeCid });
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });
});

describe('importFromCar — runtime envelope type guards (FIX 12)', () => {
  async function buildCarWithEnvelope(envelopeNode: Record<string, unknown>): Promise<Uint8Array> {
    const manifestNode = { tokens: {} };
    const manifestBytes = dagCborEncode(manifestNode);
    const manifestCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(manifestBytes)));
    const fullEnvelope = { ...envelopeNode, manifest: manifestCid };
    const envelopeBytes = dagCborEncode(fullEnvelope);
    const envelopeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(envelopeBytes)));
    const { writer, out } = CarWriter.create([envelopeCid]);
    const collectPromise = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    await writer.put({ cid: envelopeCid, bytes: envelopeBytes });
    await writer.put({ cid: manifestCid, bytes: manifestBytes });
    await writer.close();
    const chunks = await collectPromise;
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const car = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      car.set(c, off);
      off += c.byteLength;
    }
    return car;
  }

  it('envelope.version: 42 (number not string) → SERIALIZATION_ERROR', async () => {
    const car = await buildCarWithEnvelope({
      version: 42,
      createdAt: 1,
      updatedAt: 1,
    });
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/Envelope\.version must be a string/);
  });

  it('envelope.createdAt: "abc" (string not number) → SERIALIZATION_ERROR', async () => {
    const car = await buildCarWithEnvelope({
      version: '1.0.0',
      createdAt: 'abc',
      updatedAt: 1,
    });
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/Envelope\.createdAt must be a finite number/);
  });

  it('manifest value not a CID → SERIALIZATION_ERROR', async () => {
    // Build a manifest whose token entry is a string instead of a CID.
    // Place the malformed manifest bytes under the correct hash so the
    // hash-check passes and we exercise the cidToContentHash guard.
    const manifestNode = { tokens: { ['ab'.repeat(32)]: 'not-a-cid' as any } };
    const manifestBytes = dagCborEncode(manifestNode);
    const manifestCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(manifestBytes)));
    const envelopeNode = {
      version: '1.0.0',
      createdAt: 1,
      updatedAt: 1,
      manifest: manifestCid,
    };
    const envelopeBytes = dagCborEncode(envelopeNode);
    const envelopeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(envelopeBytes)));
    const { writer, out } = CarWriter.create([envelopeCid]);
    const collectPromise = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    await writer.put({ cid: envelopeCid, bytes: envelopeBytes });
    await writer.put({ cid: manifestCid, bytes: manifestBytes });
    await writer.close();
    const chunks = await collectPromise;
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const car = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      car.set(c, off);
      off += c.byteLength;
    }
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/is not a CID/);
  });
});

// ---------------------------------------------------------------------------
// Steelman³ regression — FIX 2 (Round 3): symmetric envelope.version pinning.
// ---------------------------------------------------------------------------

describe('importFromCar — envelope.version whitelist (FIX 2, Round 3)', () => {
  async function buildCarWithVersion(version: unknown): Promise<Uint8Array> {
    const manifestNode = { tokens: {} };
    const manifestBytes = dagCborEncode(manifestNode);
    const manifestCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(manifestBytes)));
    const envelopeNode = {
      version,
      createdAt: 1,
      updatedAt: 1,
      manifest: manifestCid,
    };
    const envelopeBytes = dagCborEncode(envelopeNode);
    const envelopeCid = CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(envelopeBytes)));
    const { writer, out } = CarWriter.create([envelopeCid]);
    const collectPromise = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    await writer.put({ cid: envelopeCid, bytes: envelopeBytes });
    await writer.put({ cid: manifestCid, bytes: manifestBytes });
    await writer.close();
    const chunks = await collectPromise;
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const car = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      car.set(c, off);
      off += c.byteLength;
    }
    return car;
  }

  it('rejects envelope.version "2.0.0" with SERIALIZATION_ERROR', async () => {
    const car = await buildCarWithVersion('2.0.0');
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/Unsupported uxf version/);
  });

  it('rejects envelope.version "999.0.0-malicious"', async () => {
    const car = await buildCarWithVersion('999.0.0-malicious');
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/Unsupported uxf version/);
  });

  it('rejects empty envelope.version', async () => {
    const car = await buildCarWithVersion('');
    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('accepts canonical envelope.version "1.0.0"', async () => {
    const car = await buildCarWithVersion('1.0.0');
    const pkg = await importFromCar(car);
    expect(pkg.envelope.version).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// Steelman³ regression — FIX 5 (Round 3): rebuildInstanceChains cycle detection.
// ---------------------------------------------------------------------------

describe('rebuildInstanceChains — predecessor cycle rejection (FIX 5, Round 3)', () => {
  it('rejects pool with predecessor cycle (A → B → A) with INVALID_INSTANCE_CHAIN', async () => {
    // SHA-256 fixed-points make CAR-level cycles computationally infeasible
    // to forge (each element hash depends on its predecessor hash), so the
    // cycle guard is exercised by direct in-memory pool construction. This
    // mirrors the threat model the guard defends against: an in-memory
    // merge / token-join bug that aliases hashes into a cycle.
    //
    // The test pattern: pick three pool entries where the head-finder
    // identifies a unique walk start, and the walk encounters a back-edge.
    // Specifically: A has predecessor=B, B has predecessor=C, C has
    // predecessor=B → walking from A: A→B→C→B (cycle). A is the head
    // (no successors), so the walk starts.
    const { rebuildInstanceChains: rebuild } = await import('../../../uxf/ipld.js');
    const elA: UxfElement = {
      header: { representation: 1, semantics: 1, kind: 'default', predecessor: 'bb'.repeat(32) as ContentHash },
      type: 'token-state',
      content: {},
      children: {},
    };
    const elB: UxfElement = {
      header: { representation: 1, semantics: 1, kind: 'default', predecessor: 'cc'.repeat(32) as ContentHash },
      type: 'token-state',
      content: {},
      children: {},
    };
    const elC: UxfElement = {
      header: { representation: 1, semantics: 1, kind: 'default', predecessor: 'bb'.repeat(32) as ContentHash },
      type: 'token-state',
      content: {},
      children: {},
    };
    const hA = 'aa'.repeat(32) as ContentHash;
    const hB = 'bb'.repeat(32) as ContentHash;
    const hC = 'cc'.repeat(32) as ContentHash;
    const pool = new Map<ContentHash, UxfElement>();
    pool.set(hA, elA);
    pool.set(hB, elB);
    pool.set(hC, elC);

    // Head-finder: A is not a successor of anything (B is successor of A
    // and C; C is successor of B; A has no incoming predecessor edge), so
    // A is a head. Walk: A→B→C→B → cycle on B.
    let err: any;
    try {
      rebuild(pool);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('INVALID_INSTANCE_CHAIN');
    expect(String(err.message)).toMatch(/predecessor cycle detected/);
  });

  it('rejects pool with self-loop predecessor (X → X)', async () => {
    // Edge case: a single element X whose predecessor=X. The head-finder
    // skips X (it IS a successor of itself, so it's in successorsOf), so
    // no walk starts via the primary head path. But the secondary
    // "Also find heads" branch checks successors-of-something-not-preds-
    // of-anything-else; in a self-loop, X's successor is X (itself), so
    // X is a successor and ALSO a key in successorsOf — so it isn't
    // added as head there either. In this corner case the walk simply
    // never starts, and rebuild returns an empty chains map. That's
    // still safe (no infinite loop). Verify behaviour.
    const { rebuildInstanceChains: rebuild } = await import('../../../uxf/ipld.js');
    const hX = 'aa'.repeat(32) as ContentHash;
    const elX: UxfElement = {
      header: { representation: 1, semantics: 1, kind: 'default', predecessor: hX },
      type: 'token-state',
      content: {},
      children: {},
    };
    const pool = new Map<ContentHash, UxfElement>();
    pool.set(hX, elX);
    // Should NOT infinite-loop, even if no exception is thrown.
    const chains = rebuild(pool);
    expect(chains).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Steelman³ regression — FIX 7 (Round 3): clearer error on non-sha2-256 multihash.
// ---------------------------------------------------------------------------

describe('importFromCar — assertBlockHashMatchesCid clearer non-sha256 error (FIX 7, Round 3)', () => {
  it('envelope CID with sha2-512 multihash → clear VERIFICATION_FAILED', async () => {
    // Build a CAR where the envelope CID uses sha2-512 (0x13) instead
    // of sha2-256 (0x12). The previous implementation would compute
    // sha256 of the bytes, find a length mismatch (32 vs 64), and
    // throw a confusing "length mismatch" error. The new guard should
    // throw a clear "must use sha2-256" error.
    const realEnvelopeBytes = dagCborEncode({
      version: '1.0.0',
      createdAt: 1,
      updatedAt: 1,
      manifest: CID.createV1(DAG_CBOR_CODE_TEST, makeSha256Digest(nobleSha256(dagCborEncode({ tokens: {} })))),
    });
    // Create a sha2-512-style multihash (code = 0x13). We don't actually
    // hash with sha512 — we just craft a 64-byte digest under code 0x13
    // and trust the CID library will accept it (the multiformats lib
    // accepts any multihash code at construction time).
    const fakeDigest64 = new Uint8Array(64);
    for (let i = 0; i < 64; i++) fakeDigest64[i] = i;
    const code = 0x13; // sha2-512
    const size = 64;
    const bytes = new Uint8Array(2 + size);
    bytes[0] = code;
    bytes[1] = size;
    bytes.set(fakeDigest64, 2);
    const sha512Multihash = { code: code as unknown as 0x12, size, digest: fakeDigest64, bytes };
    // Create CID v1 with dag-cbor codec (0x71) and sha2-512 multihash.
    const fakeCid = CID.createV1(DAG_CBOR_CODE_TEST, sha512Multihash as unknown as ReturnType<typeof makeSha256Digest>);

    const { writer, out } = CarWriter.create([fakeCid]);
    const collectPromise = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    await writer.put({ cid: fakeCid, bytes: realEnvelopeBytes });
    await writer.close();
    const chunks = await collectPromise;
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const car = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      car.set(c, off);
      off += c.byteLength;
    }

    let err: any;
    try {
      await importFromCar(car);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // The error may surface from cidToContentHash (called for
    // envelopeCid → roots[0] check) or from assertBlockHashMatchesCid.
    // Both paths use the same multihash check; either error is
    // acceptable. The key requirement: the message clearly mentions
    // sha2-256 expectation — NOT a confusing length-mismatch error.
    const msg = String(err.message);
    expect(err.code).toMatch(/SERIALIZATION_ERROR|VERIFICATION_FAILED/);
    expect(msg).toMatch(/sha2-256/);
  });
});
