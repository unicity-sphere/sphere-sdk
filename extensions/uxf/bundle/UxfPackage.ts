/**
 * UxfPackage — v2-only (Wave 6-P2-17).
 *
 * Wraps a set of v2 `SphereTokenPersistenceEntry` envelopes and
 * serializes them as a single-block IPLD CARv1. The old v1 chain-
 * deconstruction implementation (element pool, instance chains,
 * bundle-manifest DAG, verify/diff/applyDelta) is deleted. There is
 * NO backward compatibility with v1 CAR bundles — a `fromCar()` call
 * over v1 bytes throws.
 *
 * ## CAR format
 *
 * Single root block, dag-cbor encoded:
 *
 * ```
 * {
 *   version: 2,              // envelope format version
 *   format:  'sphere-uxf-v2',
 *   createdAt: <unix seconds>,
 *   updatedAt: <unix seconds>,
 *   tokens: [
 *     {
 *       tokenId: string,    // 64-char hex
 *       network: number,    // TokenBlob.network
 *       ver:     number,    // TokenBlob.v (renamed to avoid clashing
 *                           // with the envelope `version` field)
 *       token:   Uint8Array,// raw v2 SphereToken CBOR bytes
 *     },
 *     ...
 *   ]
 * }
 * ```
 *
 * The single-block CAR is trivially compatible with the existing
 * pin/extract helpers (`extractCarRootCid`, `pinCarBlocksToIpfs`) —
 * both parse the CAR header for the root CID and walk blocks.
 *
 * ## Public API surface (preserved)
 *
 * The flush-scheduler and consolidation.ts only need:
 * `create`, `fromCar`, `toCar`, `ingest`, `ingestAll`, `merge`,
 * `assemble`, `assembleAll`. Legacy methods that made sense only for
 * the v1 chain-DAG (`consolidateProofs`, `diff`, `applyDelta`,
 * `computeVerifiedProofs`, `filterTokens`, `tokensByCoinId`,
 * `tokensByTokenType`, `addInstance`, `gc`, `verify`, `toJson`,
 * `save`) are retained as no-op / trivial stubs so any lingering
 * caller keeps compiling. New code MUST NOT rely on them.
 *
 * @module uxf/UxfPackage
 */

import { CarWriter } from '@ipld/car/writer';
import { CarReader } from '@ipld/car';
import { CID } from 'multiformats/cid';
import { encode as dagCborEncode, decode as dagCborDecode } from '@ipld/dag-cbor';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

import type { ContentHash, UxfManifest, UxfEnvelope, UxfPackageData } from './types.js';
import { UxfError } from './errors.js';
import { logger } from '../../../core/logger.js';
import type { SphereTokenPersistenceEntry } from '../../../types/txf.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Envelope format tag baked into every CAR root block. */
const V2_FORMAT_TAG = 'sphere-uxf-v2';

/** Envelope schema version. Bump when the on-wire root-block shape changes. */
const V2_ENVELOPE_VERSION = 2;

/** CIDv1 codec for dag-cbor blocks. */
const DAG_CBOR_CODE = 0x71;

/** Multihash code for sha2-256. */
const SHA256_CODE = 0x12;

// ---------------------------------------------------------------------------
// V2 root block shape (in-CAR)
// ---------------------------------------------------------------------------

interface V2InCarToken {
  tokenId: string;
  network: number;
  ver: number;
  token: Uint8Array;
}

interface V2RootBlock {
  version: number;
  format: string;
  createdAt: number;
  updatedAt: number;
  tokens: V2InCarToken[];
}

// ---------------------------------------------------------------------------
// Merge-skip type (kept for source compat with old callers)
// ---------------------------------------------------------------------------

export interface MergeSkip {
  readonly tokenId: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// UxfPackage — v2 class
// ---------------------------------------------------------------------------

export class UxfPackage {
  private readonly tokens: Map<string, SphereTokenPersistenceEntry>;
  private envelope: {
    version: string;
    createdAt: number;
    updatedAt: number;
    description?: string;
    creator?: string;
  };

  private constructor(
    tokens: Map<string, SphereTokenPersistenceEntry>,
    envelope: UxfPackage['envelope'],
  ) {
    this.tokens = tokens;
    this.envelope = envelope;
  }

  // ---------- Factories ----------

  static create(options?: {
    description?: string;
    creator?: string;
    createdAt?: number;
    updatedAt?: number;
  }): UxfPackage {
    const now = options?.createdAt ?? Math.floor(Date.now() / 1000);
    const updated = options?.updatedAt ?? now;
    return new UxfPackage(new Map(), {
      version: '2.0.0',
      createdAt: now,
      updatedAt: updated,
      ...(options?.description !== undefined ? { description: options.description } : {}),
      ...(options?.creator !== undefined ? { creator: options.creator } : {}),
    });
  }

  static async fromCar(car: Uint8Array): Promise<UxfPackage> {
    let reader: CarReader;
    try {
      reader = await CarReader.fromBytes(car);
    } catch (err) {
      throw new UxfError(
        'INVALID_PACKAGE',
        `UxfPackage.fromCar: CAR bytes did not parse (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const roots = await reader.getRoots();
    if (roots.length !== 1) {
      throw new UxfError(
        'INVALID_PACKAGE',
        `UxfPackage.fromCar: expected single-root CAR, found ${roots.length}`,
      );
    }
    const rootBlock = await reader.get(roots[0]);
    if (!rootBlock) {
      throw new UxfError(
        'INVALID_PACKAGE',
        `UxfPackage.fromCar: root block ${roots[0].toString()} missing from CAR`,
      );
    }
    let decoded: unknown;
    try {
      decoded = dagCborDecode(rootBlock.bytes);
    } catch (err) {
      throw new UxfError(
        'INVALID_PACKAGE',
        `UxfPackage.fromCar: dag-cbor decode failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const root = decoded as Partial<V2RootBlock>;
    if (root.format !== V2_FORMAT_TAG) {
      throw new UxfError(
        'INVALID_PACKAGE',
        `UxfPackage.fromCar: unrecognized root format "${String(root.format)}"; ` +
          `expected "${V2_FORMAT_TAG}". No v1 CAR backward compatibility.`,
      );
    }
    const tokens = new Map<string, SphereTokenPersistenceEntry>();
    const tokList = Array.isArray(root.tokens) ? root.tokens : [];
    for (const raw of tokList) {
      const entry = inCarTokenToEnvelope(raw);
      if (!entry) continue;
      tokens.set(entry.tokenId, entry);
    }
    return new UxfPackage(tokens, {
      version: '2.0.0',
      createdAt: typeof root.createdAt === 'number' ? root.createdAt : Math.floor(Date.now() / 1000),
      updatedAt: typeof root.updatedAt === 'number' ? root.updatedAt : Math.floor(Date.now() / 1000),
    });
  }

  static fromJson(_json: string): UxfPackage {
    throw new UxfError(
      'INVALID_PACKAGE',
      'UxfPackage.fromJson is not supported in the v2 rebuild — use fromCar()',
    );
  }

  // ---------- Ingestion ----------

  /**
   * Ingest a single v2 envelope. If the tokenId already exists, the
   * existing entry is REPLACED (last-write-wins) — callers that don't
   * want to clobber should use `merge()` which is non-clobbering.
   */
  ingest(token: unknown, opts?: { updatedAt?: number }): this {
    const entry = toEnvelope(token);
    if (!entry) {
      logger.warn(
        'Uxf',
        `UxfPackage.ingest: skipping non-v2 token entry (missing envelope signature)`,
      );
      return this;
    }
    this.tokens.set(entry.tokenId, entry);
    this.envelope.updatedAt = opts?.updatedAt ?? Math.floor(Date.now() / 1000);
    return this;
  }

  ingestAll(tokens: unknown[], opts?: { updatedAt?: number }): this {
    for (const t of tokens) {
      const entry = toEnvelope(t);
      if (!entry) {
        logger.warn(
          'Uxf',
          `UxfPackage.ingestAll: skipping non-v2 token entry (missing envelope signature)`,
        );
        continue;
      }
      this.tokens.set(entry.tokenId, entry);
    }
    this.envelope.updatedAt = opts?.updatedAt ?? Math.floor(Date.now() / 1000);
    return this;
  }

  // ---------- Reassembly ----------

  /**
   * Return the v2 envelope for the given tokenId, or `undefined` if
   * not present. Callers can round-trip through
   * `PaymentsModule.loadFromStorageData` which decodes the envelope
   * via the engine.
   */
  assemble(tokenId: string): SphereTokenPersistenceEntry | undefined {
    return this.tokens.get(tokenId);
  }

  assembleAtState(
    tokenId: string,
    _stateIndex: number,
  ): SphereTokenPersistenceEntry | undefined {
    // v2 envelopes carry a single snapshot per token — there are no
    // historical states to assemble at. Return the current envelope.
    return this.tokens.get(tokenId);
  }

  assembleAll(): Map<string, unknown> {
    const result = new Map<string, unknown>();
    for (const [id, entry] of this.tokens) {
      result.set(id, entry);
    }
    return result;
  }

  // ---------- Token management ----------

  removeToken(tokenId: string): this {
    this.tokens.delete(tokenId);
    return this;
  }

  tokenIds(): string[] {
    return [...this.tokens.keys()];
  }

  hasToken(tokenId: string): boolean {
    return this.tokens.has(tokenId);
  }

  transactionCount(_tokenId: string): number {
    // v2 blobs carry no transaction count directly.
    return 0;
  }

  // ---------- Package operations ----------

  /**
   * Non-clobbering merge: entries from `other` are added only when
   * `this` does not already have the tokenId. Rationale: the flush
   * scheduler uses `merge()` to fold in FOREIGN bundles fetched from
   * cross-device pointers; those are older than the current in-memory
   * pkg for tokenIds we already know about, so preserving the local
   * copy avoids silently downgrading fresh state.
   *
   * Returns `{ skipped: [] }` to preserve the old API shape (the v1
   * impl returned a per-token skip list). No v2 merge failure modes
   * currently populate this list.
   */
  merge(
    other: UxfPackage,
    _opts?: {
      readonly verifiedProofs?: ReadonlySet<string>;
      readonly strict?: boolean;
      readonly onSkip?: (event: { readonly tokenId: string; readonly error: Error }) => void;
    },
  ): { readonly skipped: ReadonlyArray<MergeSkip> } {
    for (const [id, entry] of other.tokens) {
      if (this.tokens.has(id)) continue;
      this.tokens.set(id, entry);
    }
    this.envelope.updatedAt = Math.floor(Date.now() / 1000);
    return { skipped: [] };
  }

  async computeVerifiedProofs(
    _other: UxfPackage,
    _verifier: (input: {
      proofJson: unknown;
      transactionHash: string;
      proofHash?: string;
    }) => Promise<boolean>,
  ): Promise<Set<string>> {
    // v2 blobs verify via the engine, not via the UXF DAG — the
    // proof-set is empty by construction.
    return new Set<string>();
  }

  diff(_other: UxfPackage): unknown {
    // No structural diff in v2. Callers that reach for this are on a
    // v1-only code path.
    return { added: [], removed: [], changed: [] };
  }

  applyDelta(_delta: unknown): this {
    // No-op: mirrors the diff() empty-result contract.
    return this;
  }

  gc(): number {
    // v2 has no element pool to collect from.
    return 0;
  }

  // ---------- Verification ----------

  verify(): { valid: boolean; issues: never[] } {
    // Structural verification of v1 chain shape no longer applies.
    // v2 tokens verify through the engine on load.
    return { valid: true, issues: [] };
  }

  // ---------- Queries ----------

  filterTokens(_predicate: unknown): string[] {
    // No structural walk available in v2.
    return [];
  }

  tokensByCoinId(_coinId: string): string[] {
    // Coin id is embedded in the encrypted blob — cannot index by coin
    // without engine decode.
    return [];
  }

  tokensByTokenType(_tokenType: string): string[] {
    // Token type is embedded in the encrypted blob.
    return [];
  }

  // ---------- Serialization ----------

  toJson(): string {
    // Kept for source compat. Not a v2 wire format — do not consume.
    return JSON.stringify({
      version: this.envelope.version,
      envelope: this.envelope,
      tokens: [...this.tokens.values()],
    });
  }

  async toCar(): Promise<Uint8Array> {
    const inCarTokens: V2InCarToken[] = [];
    // Deterministic ordering by tokenId so the same envelope contents
    // hash to the same CID across processes (crash-restart, cross-
    // device peers). Alphabetical hex sort is stable and cheap.
    const sortedIds = [...this.tokens.keys()].sort();
    for (const id of sortedIds) {
      const env = this.tokens.get(id)!;
      inCarTokens.push({
        tokenId: env.tokenId,
        network: env.network,
        ver: env.v,
        token: base64ToBytes(env.token),
      });
    }
    const rootBlock: V2RootBlock = {
      version: V2_ENVELOPE_VERSION,
      format: V2_FORMAT_TAG,
      createdAt: this.envelope.createdAt,
      updatedAt: this.envelope.updatedAt,
      tokens: inCarTokens,
    };
    const rootBytes = dagCborEncode(rootBlock as unknown as Record<string, unknown>);
    const rootCid = await computeDagCborCid(rootBytes);
    const { writer, out } = CarWriter.create([rootCid]);
    void (async () => {
      try {
        await writer.put({ cid: rootCid, bytes: rootBytes });
      } finally {
        await writer.close();
      }
    })();
    return await collectCarBytes(out);
  }

  async save(_storage: unknown): Promise<void> {
    throw new UxfError(
      'INVALID_PACKAGE',
      'UxfPackage.save is not supported in the v2 rebuild — call toCar() and pin via profile IPFS client',
    );
  }

  addInstance(_originalHash: ContentHash, _newInstance: unknown): this {
    // Instance chains are a v1 DAG concept. No-op.
    return this;
  }

  consolidateProofs(_tokenId: string, _txRange: [number, number]): void {
    // No v2 semantics.
  }

  // ---------- Stats ----------

  get tokenCount(): number {
    return this.tokens.size;
  }

  get elementCount(): number {
    // Each envelope maps to one implicit element block.
    return this.tokens.size;
  }

  get estimatedSize(): number {
    // Rough estimate: envelope base64 payload + 200-byte fixed overhead
    // per entry.
    let total = 0;
    for (const env of this.tokens.values()) {
      total += (env.token?.length ?? 0) + 200;
    }
    return total;
  }

  /**
   * Retained for backward source-compat with callers that reach for
   * the underlying data shape. The returned object is a legacy-flavored
   * projection populated from the v2 in-memory state.
   */
  get packageData(): Readonly<UxfPackageData> {
    // Legacy UxfPackageData had { envelope, manifest, pool, indexes,
    // instanceChains }. We produce a minimal projection so tsc doesn't
    // choke and any lingering caller sees an empty-shaped-but-valid
    // package.
    const manifest: UxfManifest = { tokens: new Map() };
    const env: UxfEnvelope = {
      version: this.envelope.version,
      createdAt: this.envelope.createdAt,
      updatedAt: this.envelope.updatedAt,
      ...(this.envelope.description !== undefined
        ? { description: this.envelope.description }
        : {}),
      ...(this.envelope.creator !== undefined ? { creator: this.envelope.creator } : {}),
    };
    return {
      envelope: env,
      manifest,
      pool: new Map(),
      instanceChains: new Map(),
      indexes: {
        byTokenType: new Map(),
        byCoinId: new Map(),
        byStateHash: new Map(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Legacy free-function exports (retained no-ops)
// ---------------------------------------------------------------------------

export function ingest(_pkg: UxfPackageData, _token: unknown, _opts?: unknown): void {
  throw new UxfError(
    'INVALID_PACKAGE',
    'Free-function ingest is unsupported in the v2 rebuild — use UxfPackage.ingest()',
  );
}

export function ingestAll(_pkg: UxfPackageData, _tokens: unknown[], _opts?: unknown): void {
  throw new UxfError(
    'INVALID_PACKAGE',
    'Free-function ingestAll is unsupported in the v2 rebuild — use UxfPackage.ingestAll()',
  );
}

export function removeToken(_pkg: UxfPackageData, _tokenId: string): void {
  /* no-op */
}

export function merge(
  _pkg: UxfPackageData,
  _other: UxfPackageData,
  _opts?: unknown,
): { readonly skipped: ReadonlyArray<MergeSkip> } {
  return { skipped: [] };
}

export function consolidateProofs(
  _pkg: UxfPackageData,
  _tokenId: string,
  _txRange: [number, number],
): void {
  /* no-op */
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort conversion from an arbitrary `unknown` (token entry from
 * old storage, foreign package, receive path) into a v2
 * `SphereTokenPersistenceEntry`. Returns `null` on any shape mismatch.
 */
function toEnvelope(input: unknown): SphereTokenPersistenceEntry | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Partial<SphereTokenPersistenceEntry> & {
    ver?: number;
    token?: unknown;
  };
  const tokenId = typeof raw.tokenId === 'string' ? raw.tokenId : null;
  if (!tokenId) return null;
  const network = typeof raw.network === 'number' ? raw.network : null;
  if (network === null) return null;
  const ver = typeof raw.v === 'number' ? raw.v : typeof raw.ver === 'number' ? raw.ver : 1;
  // `token` may be a base64 string (persisted form) or a Uint8Array (in-CAR form).
  let tokenB64: string | null = null;
  const rawToken = raw.token as unknown;
  if (typeof rawToken === 'string') {
    tokenB64 = rawToken;
  } else if (rawToken instanceof Uint8Array) {
    tokenB64 = bytesToBase64(rawToken);
  }
  if (!tokenB64) return null;
  return {
    _sdkVersion: raw._sdkVersion ?? 'v2',
    _format: raw._format ?? 'sphere-token-blob',
    v: ver,
    network,
    tokenId,
    token: tokenB64,
  };
}

function inCarTokenToEnvelope(raw: unknown): SphereTokenPersistenceEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as { tokenId?: unknown; network?: unknown; ver?: unknown; token?: unknown };
  if (typeof t.tokenId !== 'string') return null;
  if (typeof t.network !== 'number') return null;
  const rawToken = t.token as unknown;
  if (!(rawToken instanceof Uint8Array)) return null;
  const ver = typeof t.ver === 'number' ? t.ver : 1;
  return {
    _sdkVersion: 'v2',
    _format: 'sphere-token-blob',
    v: ver,
    network: t.network,
    tokenId: t.tokenId,
    token: bytesToBase64(rawToken),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Compute the CIDv1 (dag-cbor / sha2-256) for a raw block.
 */
async function computeDagCborCid(bytes: Uint8Array): Promise<CID> {
  const digestBytes = nobleSha256(bytes);
  // Build a `MultihashDigest` via multiformats' `create()` helper.
  const digestModule = await import('multiformats/hashes/digest');
  const mh = digestModule.create(SHA256_CODE, digestBytes);
  return CID.createV1(DAG_CBOR_CODE, mh);
}

async function collectCarBytes(out: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of out) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}
