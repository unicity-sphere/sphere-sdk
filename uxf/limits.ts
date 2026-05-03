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
