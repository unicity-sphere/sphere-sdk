/**
 * NFT mint planning and genesis reads (#785), shared by the real and the fake
 * engine so both sign and verify through one path. The format is nft-payload.ts.
 */
import {
  encodeNftContent,
  encodeNftSigned,
  nftSignedDigest,
  parseNftPayload,
  type ParsedNft,
  verifyNftSignature,
} from './nft-payload';
import {
  EncodedPredicate,
  HexConverter,
  type NetworkId,
  SignaturePredicate,
  type SigningService,
  TokenId,
  TokenSalt,
  TokenType,
} from './sdk';
import type { BuildNftMintParams, NftMintPlan, NftReading, SphereToken } from './types';
import { assertMintableData } from './value-envelope';

export interface NftOpsDeps {
  readonly networkId: NetworkId;
  readonly signingService: Pick<SigningService, 'publicKey' | 'sign'>;
}

/** The genesis recipient a mint to `pubkey` records — the bytes an NftSigned digest binds. */
export function nftRecipientCbor(pubkey: Uint8Array): Uint8Array {
  return EncodedPredicate.fromPredicate(SignaturePredicate.create(pubkey)).toCBOR();
}

async function signPayload(
  deps: NftOpsDeps,
  payload: Uint8Array,
  tokenId: TokenId,
  recipientPubkey: Uint8Array,
): Promise<Uint8Array> {
  const digest = await nftSignedDigest(tokenId.toCBOR(), nftRecipientCbor(recipientPubkey), payload);
  const signature = await deps.signingService.sign(digest);
  return encodeNftSigned(deps.signingService.publicKey, payload, signature.encode());
}

/** Encode, optionally sign, and fix the salt, type and token id of an NFT mint. No chain op. */
export async function planNftMint(deps: NftOpsDeps, params: BuildNftMintParams): Promise<NftMintPlan> {
  const payload = encodeNftContent(params.content);
  // Built for its length check: a bad type must fail before the caller journals the plan.
  const tokenType = new TokenType(params.tokenType).bytes;
  const salt = TokenSalt.generate();
  const tokenId = await TokenId.fromSalt(deps.networkId, salt);
  const data = params.sign ? await signPayload(deps, payload, tokenId, params.recipientPubkey) : payload;
  assertMintableData(data);
  return { data, salt: salt.toBytes(), tokenType, tokenId: HexConverter.encode(tokenId.bytes) };
}

async function verifyAgainst(
  signed: NonNullable<ParsedNft['signed']>,
  tokenIdCbor: Uint8Array,
  genesisRecipientCbor: () => Uint8Array,
): Promise<'valid' | 'invalid'> {
  try {
    return await verifyNftSignature(signed, tokenIdCbor, genesisRecipientCbor());
  } catch {
    // A first owner that has no signature predicate was never signed for.
    return 'invalid';
  }
}

/** Genesis data read as an NFT, a signature checked against the token id and GENESIS recipient. Never throws. */
export async function readNftData(
  data: Uint8Array | null,
  tokenIdCbor: Uint8Array,
  genesisRecipientCbor: () => Uint8Array,
): Promise<NftReading | null> {
  const parsed = parseNftPayload(data);
  if (parsed === null) return null;
  if (parsed.signed === null) return { content: parsed.content, creator: null, signature: 'unsigned' };
  return {
    content: parsed.content,
    creator: HexConverter.encode(parsed.signed.creator),
    signature: await verifyAgainst(parsed.signed, tokenIdCbor, genesisRecipientCbor),
  };
}

/** An SDK token read as an NFT. Never throws: a read that cannot complete is not an NFT. */
export async function readTokenNft(token: SphereToken): Promise<NftReading | null> {
  try {
    const { genesis } = token.sdkToken;
    return await readNftData(genesis.data, genesis.tokenId.toCBOR(), () => genesis.recipient.toCBOR());
  } catch {
    return null;
  }
}
