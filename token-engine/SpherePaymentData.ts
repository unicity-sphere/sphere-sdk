/**
 * token-engine/SpherePaymentData.ts — the sphere value model.
 *
 * v2 `Token` carries no coins; value is app-defined and stored in
 * `MintTransaction.data`. `SpherePaymentData` is that payload: it implements the
 * SDK's `IPaymentData` (so `TokenSplit` can read it for value conservation) and
 * encodes a `PaymentAssetCollection` inside a versioned, tagged CBOR envelope.
 *
 * The SDK never inspects our raw bytes — it only calls `decodePaymentData(data)`
 * and reads `.assets` — so the envelope (tag + version) is ours, chosen for
 * forward-compatible storage. `fromValue`/`toValue` bridge sphere-domain values
 * (hex coin id + bigint amount) to/from the SDK asset collection.
 */

import {
  Asset,
  AssetId,
  CborDeserializer,
  CborError,
  CborSerializer,
  HexConverter,
  type IPaymentData,
  PaymentAssetCollection,
} from './sdk';
import type { CoinId, SphereValue } from './types';
import { SphereError } from '../core/errors';

/** Canonical coin id: non-empty, even-length lowercase hex (the form `toValue` emits). */
const COIN_ID_PATTERN = /^([0-9a-f]{2})+$/;

/** Guard a sphere-domain asset before it crosses into the SDK value model. */
function assertAsset(coinId: CoinId, amount: bigint): void {
  if (!COIN_ID_PATTERN.test(coinId)) {
    throw new SphereError(`Invalid coin id (expected even-length lowercase hex): "${coinId}"`, 'VALIDATION_ERROR');
  }
  if (amount < 0n) {
    // Negative bigints silently encode to an empty byte string (decoding back to 0n)
    // in the SDK's BigintConverter — reject loudly to avoid silent value loss.
    throw new SphereError(`Asset amount must be non-negative: ${amount.toString()}`, 'VALIDATION_ERROR');
  }
}

/** Validate a sphere-domain asset and build the SDK Asset — the single validation point. */
export function sphereAssetToSdk(coinId: CoinId, amount: bigint): Asset {
  assertAsset(coinId, amount);
  return new Asset(new AssetId(HexConverter.decode(coinId)), amount);
}

export class SpherePaymentData implements IPaymentData {
  /** Sphere-private CBOR tag (verified free in the v2 SDK tag space). */
  public static readonly CBOR_TAG = 39050n;
  /** Envelope version; bump when the structure changes. */
  public static readonly VERSION = 1n;

  private constructor(
    public readonly assets: PaymentAssetCollection,
    private readonly _memo: Uint8Array | null = null,
  ) {}

  /** Opaque, app-defined memo carried alongside the value (e.g. invoice attribution). */
  public get memo(): Uint8Array | null {
    return this._memo ? new Uint8Array(this._memo) : null;
  }

  /** Wrap an existing SDK asset collection (+ optional opaque memo). */
  public static create(assets: PaymentAssetCollection, memo: Uint8Array | null = null): SpherePaymentData {
    return new SpherePaymentData(assets, memo);
  }

  /** Build from a sphere-domain value (hex coin id → bigint amount) + optional opaque memo. */
  public static fromValue(value: SphereValue, memo: Uint8Array | null = null): SpherePaymentData {
    const assets = value.assets.map((a) => sphereAssetToSdk(a.coinId, a.amount));
    return new SpherePaymentData(PaymentAssetCollection.create(...assets), memo);
  }

  /** Decode from the CBOR envelope produced by {@link encode}. */
  public static fromCBOR(bytes: Uint8Array): SpherePaymentData {
    const tag = CborDeserializer.decodeTag(bytes);
    if (tag.tag !== SpherePaymentData.CBOR_TAG) {
      throw new CborError(`Invalid SpherePaymentData tag: ${tag.tag}`);
    }
    // Strict structure: exactly [version, assets, memo] (matches encode + the SDK's
    // fixed-shape decoders). Extra/missing fields are corruption, not tolerated.
    const fields = CborDeserializer.decodeArray(tag.data, 3);
    const version = CborDeserializer.decodeUnsignedInteger(fields[0]);
    if (version !== SpherePaymentData.VERSION) {
      throw new CborError(`Unsupported SpherePaymentData version: ${version}`);
    }
    const memo = CborDeserializer.decodeNullable(fields[2], CborDeserializer.decodeByteString);
    return new SpherePaymentData(PaymentAssetCollection.fromCBOR(fields[1]), memo);
  }

  /** Deterministic, versioned, tagged CBOR: `tag(39050)[ version, assets, memo? ]`. */
  public encode(): Promise<Uint8Array> {
    return Promise.resolve(
      CborSerializer.encodeTag(
        SpherePaymentData.CBOR_TAG,
        CborSerializer.encodeArray(
          CborSerializer.encodeUnsignedInteger(SpherePaymentData.VERSION),
          this.assets.toCBOR(),
          CborSerializer.encodeNullable(this._memo, CborSerializer.encodeByteString),
        ),
      ),
    );
  }

  /** Project to a sphere-domain value (hex coin id + bigint amount), preserving order. */
  public toValue(): SphereValue {
    return {
      assets: this.assets.toArray().map((a) => ({
        coinId: HexConverter.encode(a.id.bytes) as CoinId,
        amount: a.value,
      })),
    };
  }

  /** Balance of a single coin within this payload (0n when absent). */
  public balanceOf(coinId: CoinId): bigint {
    if (!COIN_ID_PATTERN.test(coinId)) {
      throw new SphereError(`Invalid coin id (expected even-length lowercase hex): "${coinId}"`, 'VALIDATION_ERROR');
    }
    const asset = this.assets.get(new AssetId(HexConverter.decode(coinId)));
    return asset ? asset.value : 0n;
  }
}

/**
 * Async payment-data decoder matching the SDK's `decodePaymentData` signature.
 * Used by `TokenSplit.split` (value conservation) and `SplitMintJustificationVerifier`.
 */
export function decodeSpherePaymentData(bytes: Uint8Array): Promise<IPaymentData> {
  return Promise.resolve(SpherePaymentData.fromCBOR(bytes));
}

/**
 * Reads the amount a Sphere token declares for `coinId` (32 raw bytes), or null
 * if it declares none. Shaped as a bridge plugin's value extractor so a bridged
 * mint-reason verifier can confirm the token's declared value equals the amount
 * locked on the source chain.
 *
 * Example:
 * ```ts
 * createTronUsdtBridgePlugin(config, { extractAmount: spherePaymentAmountExtractor });
 * ```
 */
export function spherePaymentAmountExtractor(data: Uint8Array | null, coinId: Uint8Array): bigint | null {
  if (!data) {
    return null;
  }
  try {
    const amount = SpherePaymentData.fromCBOR(data).balanceOf(HexConverter.encode(coinId).toLowerCase());
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}
