/**
 * FakeTokenEngine — a deterministic, in-memory ITokenEngine test double.
 *
 * Track B develops + unit-tests callers (PaymentsModule, AccountingModule, …)
 * against the frozen ITokenEngine port using this fake, before the real adapter
 * lands. It does no network/crypto: it models token identity, value, ownership
 * transfer, value-conserving split, data tokens, on-chain memos and spent-state
 * in memory. Token ids are a monotonic counter (or the salt for data tokens), so
 * behaviour is fully deterministic.
 *
 * Its state mirrors the real engine: a token carries raw `genesisData` (a
 * SpherePaymentData envelope for value tokens, opaque bytes for data tokens) plus
 * an optional `transferMemo` (the latest transfer's data). value / readMemo /
 * readTokenData are derived exactly as the real adapter derives them.
 *
 * This is a TEST double (lives under tests/, never shipped). The real adapter
 * puts a genuine v2 Token in SphereToken.sdkToken; here it is an opaque
 * placeholder, which is fine because callers treat sdkToken as opaque.
 */

import {
  CborDeserializer,
  CborSerializer,
  HexConverter,
  NetworkId,
  type Token,
  TokenId,
  TokenSalt,
} from '../../../token-engine/sdk';
import type {
  CoinId,
  EngineIdentity,
  EngineOpOptions,
  EngineVerifyResult,
  ITokenEngine,
  MintDataTokenParams,
  MintParams,
  SphereToken,
  SphereValue,
  SplitParams,
  SplitResult,
  TokenBlob,
  TransferParams,
} from '../../../token-engine';
import { sha256 } from '@noble/hashes/sha2.js';

import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { TOKEN_BLOB_VERSION, decodeTokenBlob } from '../../../token-engine/token-blob';

const DEFAULT_PUBKEY = new Uint8Array([0x02, ...new Array<number>(32).fill(0)]); // 33 bytes

interface FakeState {
  /** Genesis-stable identity — same across every state of the token (mirrors v2 TokenId). */
  readonly tokenId: Uint8Array;
  /** Per-state identity — changes on every transfer; the unit of spent-tracking. */
  readonly stateId: Uint8Array;
  readonly owner: Uint8Array;
  /** Raw mint data: a SpherePaymentData envelope (value token) or opaque bytes (data token). */
  readonly genesisData: Uint8Array | null;
  /** The latest transfer's opaque memo, when the token was delivered by transfer. */
  readonly transferMemo: Uint8Array | null;
}

export interface FakeEngineConfig {
  readonly chainPubkey?: Uint8Array;
  readonly network?: number;
}

export class FakeTokenEngine implements ITokenEngine {
  private readonly identity: EngineIdentity;
  private readonly network: number;
  private readonly spent = new Set<string>();
  private seq = 0;

  public constructor(config: FakeEngineConfig = {}) {
    this.identity = { chainPubkey: config.chainPubkey ?? DEFAULT_PUBKEY };
    this.network = config.network ?? 2; // testnet
  }

  public getIdentity(): EngineIdentity {
    return { chainPubkey: new Uint8Array(this.identity.chainPubkey) };
  }

  public deriveIdentityAddress(pubkey?: Uint8Array): Promise<string> {
    return Promise.resolve(`DIRECT://${HexConverter.encode(pubkey ?? this.identity.chainPubkey)}`);
  }

  public tokenId(token: SphereToken): string {
    return token.blob.tokenId;
  }

  public readValue(token: SphereToken): SphereValue | null {
    return token.value;
  }

  public balanceOf(token: SphereToken, coinId: CoinId): bigint {
    let sum = 0n;
    for (const a of token.value?.assets ?? []) {
      if (a.coinId === coinId) sum += a.amount;
    }
    return sum;
  }

  public readMemo(token: SphereToken): Uint8Array | null {
    const state = decodeFakeState(token.blob.token);
    if (state.transferMemo) return state.transferMemo;
    if (state.genesisData && isSpherePaymentData(state.genesisData)) {
      return SpherePaymentData.fromCBOR(state.genesisData).memo;
    }
    return null;
  }

  public readTokenData(token: SphereToken): Uint8Array | null {
    return decodeFakeState(token.blob.token).genesisData;
  }

  public async mint(params: MintParams, _options?: EngineOpOptions): Promise<SphereToken> {
    const genesisData = params.value ? await SpherePaymentData.fromValue(params.value).encode() : null;
    return this.makeToken({
      tokenId: this.nextId(),
      stateId: this.nextId(),
      owner: params.recipientPubkey,
      genesisData,
      transferMemo: null,
    });
  }

  public async mintDataToken(params: MintDataTokenParams, _options?: EngineOpOptions): Promise<SphereToken> {
    // Derive the tokenId EXACTLY as the real engine does (TokenId.fromSalt = SHA-256 over
    // [salt, networkId]) so the fake is a faithful double — the id is NOT the raw salt.
    const tokenId = params.salt
      ? (await TokenId.fromSalt(networkIdOf(this.network), TokenSalt.fromCBOR(CborSerializer.encodeByteString(params.salt)))).bytes
      : this.nextId();
    return this.makeToken({
      tokenId,
      stateId: this.nextId(),
      owner: params.recipientPubkey,
      genesisData: params.data,
      transferMemo: null,
    });
  }

  public async transfer(params: TransferParams, _options?: EngineOpOptions): Promise<SphereToken> {
    this.consume(params.token);
    const source = decodeFakeState(params.token.blob.token);
    // A transfer keeps the same token (genesis + tokenId); only the state + owner change.
    return this.makeToken({
      tokenId: source.tokenId,
      stateId: this.nextId(),
      owner: params.recipientPubkey,
      genesisData: source.genesisData,
      transferMemo: params.data ?? null,
    });
  }

  public async split(params: SplitParams, _options?: EngineOpOptions): Promise<SplitResult> {
    assertConserved(params.token.value ?? { assets: [] }, params.outputs);
    this.consume(params.token);
    const outputs: SphereToken[] = [];
    for (const o of params.outputs) {
      // A split output is a fresh mint (new tokenId); its memo rides inside the value envelope.
      const genesisData = await SpherePaymentData.fromValue(
        { assets: [{ coinId: o.coinId, amount: o.amount }] },
        o.data ?? null,
      ).encode();
      outputs.push(
        await this.makeToken({
          tokenId: this.nextId(),
          stateId: this.nextId(),
          owner: o.recipientPubkey,
          genesisData,
          transferMemo: null,
        }),
      );
    }
    return { outputs };
  }

  public verify(_token: SphereToken, _options?: EngineOpOptions): Promise<EngineVerifyResult> {
    // Structural validity only — fake tokens are always well-formed. Spent-status is isSpent's job.
    return Promise.resolve({ ok: true });
  }

  public isSpent(token: SphereToken, _options?: EngineOpOptions): Promise<boolean> {
    return Promise.resolve(this.spent.has(this.idOf(token)));
  }

  public isOwnedBy(token: SphereToken, pubkey: Uint8Array): boolean {
    const owner = decodeFakeState(token.blob.token).owner;
    if (owner.length !== pubkey.length) return false;
    return owner.every((b, i) => b === pubkey[i]);
  }

  public encodeToken(token: SphereToken): TokenBlob {
    return token.blob;
  }

  /**
   * @inheritDoc — fake-world derivation: sha256 over the inner token bytes.
   * Internally CONSISTENT across the fake engine + fake server + helpers; the
   * REAL derivation (SDK state-hash imprint) is pinned by the real-engine test
   * in delivery-keys.test.ts and, end-to-end, by the cross-repo harness.
   */
  public deliveryKeys(blobBytes: Uint8Array): Promise<{ tokenId: string; stateHash: string }> {
    // Tolerant like the real derivation (blob-keys.ts): the cross-port blob
    // is the sphere envelope, the wallet-api WIRE carries raw inner bytes
    // (§5.2/§8.2). Both forms of the same token derive the identical pair.
    try {
      const blob = decodeTokenBlob(blobBytes);
      return Promise.resolve({ tokenId: blob.tokenId, stateHash: bytesToHexLocal(sha256(blob.token)) });
    } catch {
      const state = decodeFakeState(blobBytes);
      return Promise.resolve({
        tokenId: HexConverter.encode(state.tokenId),
        stateHash: bytesToHexLocal(sha256(blobBytes)),
      });
    }
  }

  public decodeToken(blob: TokenBlob): Promise<SphereToken> {
    // Normalize like the real engine's wrapToken: tokenId/network come from
    // the decoded token, never from the (possibly placeholder) envelope
    // fields of a raw wire wrap.
    const state = decodeFakeState(blob.token);
    const normalized: TokenBlob = { ...blob, network: this.network, tokenId: HexConverter.encode(state.tokenId) };
    return Promise.resolve({ sdkToken: handleFor(blob.token), blob: normalized, value: valueOf(state) });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private nextId(): Uint8Array {
    const id = new Uint8Array(32);
    const n = this.seq++;
    id[28] = (n >>> 24) & 0xff;
    id[29] = (n >>> 16) & 0xff;
    id[30] = (n >>> 8) & 0xff;
    id[31] = n & 0xff;
    return id;
  }

  private async makeToken(state: FakeState): Promise<SphereToken> {
    const stateBytes = encodeFakeState(state);
    const blob: TokenBlob = {
      v: TOKEN_BLOB_VERSION,
      network: this.network,
      tokenId: HexConverter.encode(state.tokenId),
      token: stateBytes,
    };
    return { sdkToken: handleFor(stateBytes), blob, value: valueOf(state) };
  }

  /** Spent-tracking key = the per-state id (changes on every transfer). */
  private idOf(token: SphereToken): string {
    return HexConverter.encode(decodeFakeState(token.blob.token).stateId);
  }

  private consume(token: SphereToken): void {
    const id = this.idOf(token);
    if (this.spent.has(id)) {
      throw new Error('FakeTokenEngine: token already spent');
    }
    this.spent.add(id);
  }
}

/**
 * Decode a fake inner-token state's value — the injectable `decodeAssets`
 * port for FakeWalletApi (the §8.2 step-6 stand-in), so wallet-api
 * integration tests can run PaymentsModule + FakeTokenEngine against the
 * fake backend's deposit/apply validation pipeline.
 */
export function decodeFakeTokenAssets(
  tokenBytes: Uint8Array
): { coinId: string; amount: bigint }[] | null {
  try {
    const state = decodeFakeState(tokenBytes);
    if (!state.genesisData || !isSpherePaymentData(state.genesisData)) return null;
    const value = SpherePaymentData.fromCBOR(state.genesisData).toValue();
    return value.assets.map((a) => ({ coinId: a.coinId, amount: a.amount }));
  } catch {
    return null;
  }
}

/**
 * Genesis-stable token id of fake inner-token bytes — the injectable
 * `decodeTokenId` port for FakeWalletApi's §8.2 step-4 stand-in over RAW wire
 * bytes (the wallet-api wire carries inner bytes, never the envelope).
 */
export function decodeFakeTokenId(tokenBytes: Uint8Array): string | null {
  try {
    return HexConverter.encode(decodeFakeState(tokenBytes).tokenId);
  } catch {
    return null;
  }
}

// fake-token state: CBOR array[ tokenId, stateId, owner, genesisData?, transferMemo? ]
function encodeFakeState(state: FakeState): Uint8Array {
  return CborSerializer.encodeArray(
    CborSerializer.encodeByteString(state.tokenId),
    CborSerializer.encodeByteString(state.stateId),
    CborSerializer.encodeByteString(state.owner),
    CborSerializer.encodeNullable(state.genesisData, CborSerializer.encodeByteString),
    CborSerializer.encodeNullable(state.transferMemo, CborSerializer.encodeByteString),
  );
}

function decodeFakeState(bytes: Uint8Array): FakeState {
  const [tokenIdB, stateIdB, ownerB, genesisB, memoB] = CborDeserializer.decodeArray(bytes, 5);
  return {
    tokenId: CborDeserializer.decodeByteString(tokenIdB),
    stateId: CborDeserializer.decodeByteString(stateIdB),
    owner: CborDeserializer.decodeByteString(ownerB),
    genesisData: CborDeserializer.decodeNullable(genesisB, CborDeserializer.decodeByteString),
    transferMemo: CborDeserializer.decodeNullable(memoB, CborDeserializer.decodeByteString),
  };
}

/** Derive the decoded value exactly as the real adapter does (SpherePaymentData envelope only). */
function valueOf(state: FakeState): SphereValue | null {
  if (state.genesisData && isSpherePaymentData(state.genesisData)) {
    return SpherePaymentData.fromCBOR(state.genesisData).toValue();
  }
  return null;
}

function isSpherePaymentData(data: Uint8Array): boolean {
  try {
    return CborDeserializer.decodeTag(data).tag === SpherePaymentData.CBOR_TAG;
  } catch {
    return false;
  }
}

/** Map the fake's numeric network to the SDK NetworkId instance (for TokenId.fromSalt). */
function networkIdOf(n: number): NetworkId {
  if (n === NetworkId.MAINNET.id) return NetworkId.MAINNET;
  if (n === NetworkId.LOCAL.id) return NetworkId.LOCAL;
  return NetworkId.TESTNET;
}

// Opaque placeholder for SphereToken.sdkToken — callers never call methods on it.
function handleFor(stateBytes: Uint8Array): Token {
  return { __fake: HexConverter.encode(stateBytes).slice(0, 16) } as unknown as Token;
}

function assertConserved(source: SphereValue, outputs: SplitParams['outputs']): void {
  const need = new Map<string, bigint>();
  for (const a of source.assets) need.set(a.coinId, (need.get(a.coinId) ?? 0n) + a.amount);
  const got = new Map<string, bigint>();
  for (const o of outputs) got.set(o.coinId, (got.get(o.coinId) ?? 0n) + o.amount);
  for (const coin of new Set([...need.keys(), ...got.keys()])) {
    if ((need.get(coin) ?? 0n) !== (got.get(coin) ?? 0n)) {
      throw new Error(`FakeTokenEngine: split is not value-conserving for coin ${coin}`);
    }
  }
}

function bytesToHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
