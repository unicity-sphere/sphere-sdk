/**
 * FakeTokenEngine — a deterministic, in-memory ITokenEngine test double.
 *
 * Track B develops + unit-tests callers (PaymentsModule, AccountingModule, …)
 * against the frozen ITokenEngine port using this fake, before the real adapter
 * lands. It does no network/crypto: it models token identity, value, ownership
 * transfer, value-conserving split, and spent-state in memory. Token ids are a
 * monotonic counter, so behaviour is fully deterministic.
 *
 * This is a TEST double (lives under tests/, never shipped). The real adapter
 * puts a genuine v2 Token in SphereToken.sdkToken; here it is an opaque
 * placeholder, which is fine because callers treat sdkToken as opaque.
 */

import {
  CborDeserializer,
  CborSerializer,
  HexConverter,
  type Token,
} from '../../../token-engine/sdk';
import type {
  CoinId,
  EngineIdentity,
  EngineOpOptions,
  EngineVerifyResult,
  ITokenEngine,
  MintParams,
  SphereToken,
  SphereValue,
  SplitParams,
  SplitResult,
  TokenBlob,
  TransferParams,
} from '../../../token-engine';
import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { TOKEN_BLOB_VERSION } from '../../../token-engine/token-blob';

const DEFAULT_PUBKEY = new Uint8Array([0x02, ...new Array<number>(32).fill(0)]); // 33 bytes

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

  public async mint(params: MintParams, _options?: EngineOpOptions): Promise<SphereToken> {
    return this.makeToken(this.nextId(), params.recipientPubkey, params.value ?? { assets: [] });
  }

  public async transfer(params: TransferParams, _options?: EngineOpOptions): Promise<SphereToken> {
    this.consume(params.token);
    return this.makeToken(this.nextId(), params.recipientPubkey, params.token.value ?? { assets: [] });
  }

  public async split(params: SplitParams, _options?: EngineOpOptions): Promise<SplitResult> {
    assertConserved(params.token.value ?? { assets: [] }, params.outputs);
    this.consume(params.token);
    const outputs: SphereToken[] = [];
    for (const o of params.outputs) {
      outputs.push(
        await this.makeToken(this.nextId(), o.recipientPubkey, { assets: [{ coinId: o.coinId, amount: o.amount }] }),
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

  public encodeToken(token: SphereToken): TokenBlob {
    return token.blob;
  }

  public decodeToken(blob: TokenBlob): Promise<SphereToken> {
    const { value } = decodeFakeState(blob.token);
    return Promise.resolve({ sdkToken: handleFor(blob.token), blob, value });
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

  private async makeToken(id: Uint8Array, owner: Uint8Array, value: SphereValue): Promise<SphereToken> {
    const stateBytes = await encodeFakeState(id, owner, value);
    const blob: TokenBlob = { v: TOKEN_BLOB_VERSION, network: this.network, token: stateBytes };
    return { sdkToken: handleFor(stateBytes), blob, value };
  }

  private idOf(token: SphereToken): string {
    return HexConverter.encode(decodeFakeState(token.blob.token).id);
  }

  private consume(token: SphereToken): void {
    const id = this.idOf(token);
    if (this.spent.has(id)) {
      throw new Error('FakeTokenEngine: token already spent');
    }
    this.spent.add(id);
  }
}

// fake-token state: CBOR array[ id, owner, SpherePaymentData(value) ]
async function encodeFakeState(id: Uint8Array, owner: Uint8Array, value: SphereValue): Promise<Uint8Array> {
  return CborSerializer.encodeArray(
    CborSerializer.encodeByteString(id),
    CborSerializer.encodeByteString(owner),
    await SpherePaymentData.fromValue(value).encode(),
  );
}

function decodeFakeState(bytes: Uint8Array): { id: Uint8Array; owner: Uint8Array; value: SphereValue } {
  const [idB, ownerB, valueB] = CborDeserializer.decodeArray(bytes, 3);
  return {
    id: CborDeserializer.decodeByteString(idB),
    owner: CborDeserializer.decodeByteString(ownerB),
    value: SpherePaymentData.fromCBOR(valueB).toValue(),
  };
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
