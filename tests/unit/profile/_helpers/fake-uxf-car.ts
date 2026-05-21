/**
 * Test-only helpers that turn a JSON payload into a minimal valid CARv1
 * byte stream, so test mocks for `UxfPackage.toCar()` produce something
 * the production pin path can parse (post-#200 Phase 2 the flush
 * scheduler / consolidation engine call `extractCarRootCid` before
 * `pinCarBlocksToIpfs`, which requires a real CAR).
 *
 * The CAR shape is deliberately minimal:
 *   - one dag-cbor envelope block whose content carries the test JSON
 *   - rootCid = envelope CID
 *
 * Tests don't need to mirror production's full envelope→manifest→token
 * DAG; this single-block CAR is enough for the pin path to succeed and
 * for `fakeCarRoundTrip` to recover the JSON payload via the symmetric
 * `decodeFakeCar` helper (used by mocked `fromCar`).
 *
 * Keeping this in `_helpers/` (underscore prefix) keeps it out of
 * vitest auto-discovery — there are no tests in this file.
 *
 * @module tests/unit/profile/_helpers/fake-uxf-car
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import { create as createMultihash } from 'multiformats/hashes/digest';
import { encode as dagCborEncode, decode as dagCborDecode } from '@ipld/dag-cbor';
import { CarWriter } from '@ipld/car/writer';
import { CarReader } from '@ipld/car';

const DAG_CBOR_CODE = 0x71;
const SHA256_CODE = 0x12;

/**
 * Build a single-block CARv1 that carries `payload` inside a dag-cbor
 * envelope. The returned bytes are accepted by:
 *   - `extractCarRootCid` (the root is a real dag-cbor CIDv1)
 *   - `pinCarBlocksToIpfs` (the envelope CID matches a block in the CAR)
 *   - `CarReader.fromBytes` (full CAR validity)
 */
export async function makeFakeUxfCar(payload: unknown): Promise<Uint8Array> {
  const envelopeBytes = dagCborEncode({ payload });
  const digest = createMultihash(SHA256_CODE, sha256(envelopeBytes));
  const envelopeCid = CID.createV1(DAG_CBOR_CODE, digest);

  const { writer, out } = CarWriter.create([envelopeCid]);
  const chunks: Uint8Array[] = [];
  const collectPromise = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  await writer.put({ cid: envelopeCid, bytes: envelopeBytes });
  await writer.close();
  await collectPromise;

  let total = 0;
  for (const c of chunks) total += c.length;
  const carBytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    carBytes.set(c, offset);
    offset += c.length;
  }
  return carBytes;
}

/**
 * Symmetric decoder for {@link makeFakeUxfCar}. Returns the original
 * payload by reading the root block back out. Used by mocked
 * `UxfPackage.fromCar` implementations.
 */
export async function decodeFakeUxfCar<T = unknown>(carBytes: Uint8Array): Promise<T> {
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  if (roots.length !== 1) {
    throw new Error(`decodeFakeUxfCar: expected one root, got ${roots.length}`);
  }
  const block = await reader.get(roots[0]);
  if (!block) {
    throw new Error(`decodeFakeUxfCar: root block ${roots[0].toString()} missing`);
  }
  const decoded = dagCborDecode(block.bytes) as { payload: T };
  return decoded.payload;
}
