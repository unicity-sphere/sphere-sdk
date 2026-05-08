/**
 * UXF resource and structural limits (steelman Wave 3).
 *
 * Centralised caps used at parse / verify / import time to defend
 * against bloat-DoS and adversarial CAR shapes whose individual
 * blocks fit existing per-element-count caps but collectively
 * exhaust memory.
 *
 * These constants are deliberately above any legitimate package
 * shape so legitimate workloads are unaffected; they are below the
 * memory budget required to crash a typical Node.js / browser
 * runtime on the hot path.
 *
 * Cross-references:
 *  - VERIFY_MAX_POOL_SIZE / WRAP_POOL_MAX_SIZE: per-element COUNT cap
 *    (uxf/UxfPackage.ts, uxf/verify.ts) — already in place.
 *  - The constants in THIS file enforce per-block / per-element
 *    BYTE caps so a CAR whose count fits the existing caps cannot
 *    hide multi-GB element bodies underneath.
 *
 * @module uxf/limits
 */

/**
 * Maximum number of blocks accepted in a single CAR import.
 *
 * `WRAP_POOL_MAX_SIZE = 1_000_000` (UxfPackage.ts:446) only fires
 * AFTER `importFromCar` has fully populated `pool` from the CAR's
 * `for await (const block of reader.blocks())` loop. A 32 MiB CAR
 * with ~800k tiny dag-cbor blocks fits the pool cap and forces
 * 800k Map insertions before structural rejection — defeating the
 * intent of the cap.
 *
 * 10_000 elements × any single-token DAG depth fits a comfortable
 * ceiling well above any legitimate UXF package; multi-token
 * bundles up to this size still parse. Hostile bloat is rejected
 * deterministically on the first violation, before the full pool
 * is materialised.
 */
export const CAR_IMPORT_MAX_BLOCK_COUNT = 10_000;

/**
 * Maximum bytes for a single IPLD block in a CAR import.
 *
 * dag-cbor encoded UXF elements are typically < 1 KiB. 64 KiB is
 * generous slack for encrypted-payload elements (predicate raw bytes,
 * certificate raw bytes) while preventing a single 100 MiB block
 * from being allocated and decoded.
 */
export const CAR_IMPORT_MAX_BLOCK_BYTES = 64 * 1024;

/**
 * Maximum bytes per UXF element's content + children sub-tree
 * during verify.ts re-hash.
 *
 * Verify's `VERIFY_MAX_POOL_SIZE = 1_000_000` (verify.ts:102) caps
 * element COUNT but not the bytes-per-element. An adversarial bundle
 * with 100k elements of 100 KiB each fits the count cap but is 10 GB
 * total. A per-element byte cap during verify rejects this shape
 * before the SHA-256 + dag-cbor encode hot loop spends time on it.
 *
 * 64 KiB matches CAR_IMPORT_MAX_BLOCK_BYTES so the two layers (CAR
 * import + verify) reject the same hostile shape consistently.
 */
export const VERIFY_MAX_ELEMENT_BYTES = 64 * 1024;

/**
 * Fast-path size limit for `extractCarRootCid` header-only parse.
 *
 * The CAR header (varint length + dag-cbor `{ version, roots }`)
 * lives in the first few hundred bytes of any well-formed CARv1.
 * 4 KiB is generous slack for many-root CARs (which we reject
 * anyway via single-root rule §5.2 #1) without forcing the full
 * CAR through `CarReader.fromBytes`, whose internal block index
 * iteration is O(N) on hostile padding.
 */
export const EXTRACT_CAR_ROOT_HEADER_PROBE_BYTES = 4 * 1024;

/**
 * Maximum total bytes accepted by `importFromCar` BEFORE invoking
 * `CarReader.fromBytes`.
 *
 * `CarReader.fromBytes(car)` parses the entire CAR up-front, building
 * an internal block index over `car.byteLength` bytes. That happens
 * before the per-block count/byte caps fire — a 1 GiB hostile CAR
 * forces a 1 GiB allocation + parse pass through the cborg decoder
 * even if every block is rejected on the next loop iteration.
 *
 * 64 MiB is comfortably above any legitimate UXF package shape (the
 * existing per-block × per-block-count product budget is 64 KiB ×
 * 10_000 = 640 MiB, but real packages are orders of magnitude
 * smaller) while bounding the worst-case pre-parse memory burst.
 */
export const CAR_IMPORT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Maximum manifest entries (token bindings) accepted by JSON or CAR
 * deserializers BEFORE iterating the manifest map.
 *
 * Without an explicit cap, a hostile package whose manifest carries
 * 10M entries forces a 10M-iteration loop through `Object.entries`
 * /`tokens.set` plus 10M `contentHash`/`tokenId` validations. The
 * existing per-element-count cap (`WRAP_POOL_MAX_SIZE`) does not
 * fire on the manifest object — it only fires on the element pool.
 *
 * 100k entries is well above any realistic UXF packaging shape (a
 * single bundle with 100k tokens already dwarfs the largest production
 * batches) while rejecting bloat-DoS at the parse boundary.
 */
export const MANIFEST_MAX_SIZE = 100_000;

/**
 * Maximum elements (pool entries) accepted by the JSON deserializer
 * BEFORE iterating the elements map.
 *
 * Steelman³ remediation (FIX 1, Round 3): the JSON path was a
 * symmetric gap on the CAR path. CAR import caps blocks via
 * `CAR_IMPORT_MAX_BLOCK_COUNT = 10_000` BEFORE pool insertion; the
 * JSON path iterated `Object.entries(raw.elements)` unbounded and
 * paid `contentHash` + `computeElementHash` cost on every entry
 * before `WRAP_POOL_MAX_SIZE = 1M` (UxfPackage.ts) finally fired —
 * i.e. 10M elements would burn 10M SHA-256 evaluations + 10M Map
 * inserts before structural rejection. Cap upfront at the parse
 * boundary so the hot loop never starts.
 *
 * 100_000 matches MANIFEST_MAX_SIZE — well above any realistic UXF
 * packaging shape but below the per-block-count CAR cap multiplied
 * by reasonable DAG depth, keeping the two layers consistent.
 */
export const ELEMENTS_MAX_SIZE = 100_000;
