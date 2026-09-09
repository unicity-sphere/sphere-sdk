/**
 * Genesis value-envelope classification: the client half of wallet-api's §8.2
 * step 6. This throw set stays a SUBSET of wallet-api's 422 set — throwing where
 * it accepts loses a token (`Receive.screen()` acks a decode throw as invalid).
 */
import { SphereError } from '../core/errors';

import {
  CborDeserializer,
  CborReader,
  HexConverter,
  MajorType,
  type Token,
} from './sdk';
import { SpherePaymentData } from './SpherePaymentData';
import type { SphereToken, SphereValue, TokenBlob } from './types';

/** `none_*` = coinless; `bare_collection` = a dialect this SDK cannot read. */
export type ValueEnvelope =
  | 'sphere'
  | 'bare_collection'
  | 'none_tag'
  | 'none_other'
  | 'none_absent';

export interface ClassifiedValue {
  readonly envelope: ValueEnvelope;
  /** Populated only for `'sphere'`; null for every other envelope. */
  readonly value: SphereValue | null;
}

const SELF_DESCRIBED_CBOR_TAG = 55799n;
const CBOR_MAJOR_TYPE_MASK = 0b1110_0000;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const invalid = (message: string): SphereError => new SphereError(message, 'VALIDATION_ERROR');

function majorTypeOf(bytes: Uint8Array): MajorType | null {
  const first = bytes.at(0);
  return first === undefined ? null : first & CBOR_MAJOR_TYPE_MASK;
}

/** Tag number from the HEAD ALONE; `null` = truncated or non-canonical head. */
function headTagNumber(bytes: Uint8Array): bigint | null {
  try {
    return new CborReader(bytes).readLength(MajorType.TAG);
  } catch {
    return null;
  }
}

/** `Asset.toCBOR()`'s signature: a 2-array of byte strings. Arity and types only. */
function isAssetShaped(item: Uint8Array): boolean {
  try {
    return CborDeserializer.decodeArray(item, 2).every(
      (field) => majorTypeOf(field) === MajorType.BYTE_STRING,
    );
  } catch {
    return false;
  }
}

function arrayItemsOrNull(bytes: Uint8Array): readonly Uint8Array[] | null {
  try {
    return CborDeserializer.decodeArray(bytes);
  } catch {
    return null;
  }
}

function decodeSphere(genesisData: Uint8Array): SphereValue {
  try {
    return SpherePaymentData.fromCBOR(genesisData).toValue();
  } catch (error) {
    throw invalid(`Failed to decode token payment data: ${describe(error)}`);
  }
}

/** Tagged items must frame cleanly, so raw binary in the tag range is refused. */
function taggedItemBody(genesisData: Uint8Array): Uint8Array {
  try {
    return CborDeserializer.decodeTag(genesisData).data;
  } catch (error) {
    throw invalid(
      `Token value payload is a CBOR tag whose item is malformed or carries trailing bytes: ${describe(error)}`,
    );
  }
}

/** Does a 55799 wrapper hide a value envelope? Nested wrappers are refused, not walked. */
function selfDescribedBodyCarriesValue(body: Uint8Array): boolean {
  const major = majorTypeOf(body);
  if (major === MajorType.TAG) {
    const inner = headTagNumber(body);
    return inner === SpherePaymentData.CBOR_TAG || inner === SELF_DESCRIBED_CBOR_TAG;
  }
  if (major === MajorType.ARRAY) {
    const items = arrayItemsOrNull(body);
    return items !== null && items.some(isAssetShaped);
  }
  return false;
}

/** Tag 39050 decodes; 55799-over-value is refused; any other tag is coinless. */
function classifyTagged(genesisData: Uint8Array): ClassifiedValue {
  const tag = headTagNumber(genesisData);
  if (tag === null) {
    throw invalid(
      'Token value payload has an unreadable or non-canonically encoded CBOR tag head — it could be a malformed SpherePaymentData envelope',
    );
  }
  if (tag === SpherePaymentData.CBOR_TAG) {
    return { envelope: 'sphere', value: decodeSphere(genesisData) };
  }
  const body = taggedItemBody(genesisData);
  if (tag === SELF_DESCRIBED_CBOR_TAG && selfDescribedBodyCarriesValue(body)) {
    throw invalid(
      'Token value payload is a value envelope wrapped in the self-described CBOR tag 55799 (RFC 8949 §3.4.6), which no codec here unwraps — its coins would be invisible. Emit the envelope without the self-describe prefix',
    );
  }
  return { envelope: 'none_tag', value: null };
}

/** Must frame cleanly (a truncation may be a corrupt collection). `.some`, never `.every`. */
function classifyArray(genesisData: Uint8Array): ClassifiedValue {
  const items = arrayItemsOrNull(genesisData);
  if (items === null) {
    throw invalid('Token value payload is not PaymentAssetCollection: malformed CBOR array');
  }
  return items.some(isAssetShaped)
    ? { envelope: 'bare_collection', value: null }
    : { envelope: 'none_other', value: null };
}

/** Not a value envelope ⇒ null value (coinless); claims one and fails to decode ⇒ throws. */
export function classifyValueEnvelope(genesisData: Uint8Array | null): ClassifiedValue {
  if (genesisData === null) return { envelope: 'none_absent', value: null };
  const major = majorTypeOf(genesisData);
  if (major === null) return { envelope: 'none_absent', value: null };
  if (major === MajorType.TAG) return classifyTagged(genesisData);
  if (major === MajorType.ARRAY) return classifyArray(genesisData);
  return { envelope: 'none_other', value: null };
}

/** Wrap an SDK token: blob (incl. stable tokenId), classified envelope, decoded value. */
export function wrapToken(sdkToken: Token): SphereToken {
  const { envelope, value } = classifyValueEnvelope(sdkToken.genesis.data);
  const blob: TokenBlob = {
    tokenId: HexConverter.encode(sdkToken.id.bytes),
    token: sdkToken.toCBOR(),
  };
  return { sdkToken, blob, value, valueEnvelope: envelope };
}

/**
 * Pre-flight for `mintDataToken`'s opaque payload, BEFORE any chain op — otherwise
 * the refusal surfaces from `wrapToken` after the mint certified, stranding a token
 * this SDK can no longer decode and wallet-api would refuse at deposit anyway.
 */
export function assertMintableData(data: Uint8Array): void {
  try {
    classifyValueEnvelope(data);
  } catch (error) {
    throw invalid(
      `Cannot mint a data token with this payload: ${describe(error)}. Raw bytes starting in the CBOR array (0x80-0x9f) or tag (0xc0-0xdf) range must be well-formed canonical CBOR; wrap them in a CBOR byte string, map, text string, or a tag other than 39050/55799.`,
    );
  }
}
