/**
 * token-engine/sdk.ts — the SINGLE place that imports @unicitylabs/state-transition-sdk.
 *
 * The v1 cut-over is done: the canonical package name now resolves to the v2 SDK
 * (the migration-era `state-transition-sdk-v2` npm alias is gone, and v1 with it).
 *
 * Everything else in token-engine/ imports SDK symbols from `./sdk`, never from the package directly.
 * ESLint `no-restricted-imports` forbids importing the SDK anywhere except this file.
 *
 * Import path note: subpaths are `…/lib/<path>.js` (no `/src/`); no root barrel.
 */

// ── client / aggregator / proof / network / trust base ──────────────────────
export { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js';
export { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
export type { IAggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/IAggregatorClient.js';
export { NetworkId } from '@unicitylabs/state-transition-sdk/lib/api/NetworkId.js';
export { CertificationData } from '@unicitylabs/state-transition-sdk/lib/api/CertificationData.js';
export { CertificationResponse, CertificationStatus } from '@unicitylabs/state-transition-sdk/lib/api/CertificationResponse.js';
export { StateId } from '@unicitylabs/state-transition-sdk/lib/api/StateId.js';
export { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProof.js';
export { InclusionProofResponse } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProofResponse.js';
export { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/api/bft/RootTrustBase.js';
export { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js';
export { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/verification/rule/InclusionProofVerificationRule.js';

// ── token / transactions ────────────────────────────────────────────────────
export { Token } from '@unicitylabs/state-transition-sdk/lib/transaction/Token.js';
export { MintTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransaction.js';
export { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction.js';
export { CertifiedMintTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/CertifiedMintTransaction.js';
export { CertifiedTransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/CertifiedTransferTransaction.js';
export { TokenId } from '@unicitylabs/state-transition-sdk/lib/transaction/TokenId.js';
export { TokenType } from '@unicitylabs/state-transition-sdk/lib/transaction/TokenType.js';
export { TokenSalt } from '@unicitylabs/state-transition-sdk/lib/transaction/TokenSalt.js';
export type { ITransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/ITransaction.js';
export { MintJustificationVerifierService } from '@unicitylabs/state-transition-sdk/lib/transaction/verification/MintJustificationVerifierService.js';
export type { IMintJustificationVerifier } from '@unicitylabs/state-transition-sdk/lib/transaction/verification/IMintJustificationVerifier.js';

// ── predicates / unlock scripts ─────────────────────────────────────────────
export type { IPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/IPredicate.js';
export type { IUnlockScript } from '@unicitylabs/state-transition-sdk/lib/predicate/IUnlockScript.js';
export { EncodedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/EncodedPredicate.js';
export { SignaturePredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/builtin/SignaturePredicate.js';
export { SignaturePredicateUnlockScript } from '@unicitylabs/state-transition-sdk/lib/predicate/builtin/SignaturePredicateUnlockScript.js';
export { BurnPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/builtin/BurnPredicate.js';
export { PredicateVerifierService } from '@unicitylabs/state-transition-sdk/lib/predicate/verification/PredicateVerifierService.js';

// ── crypto / hashing ────────────────────────────────────────────────────────
export { SigningService } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/SigningService.js';
export { Signature } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/Signature.js';
export { MintSigningService } from '@unicitylabs/state-transition-sdk/lib/crypto/MintSigningService.js';
export { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/HashAlgorithm.js';
export { DataHash } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHash.js';
export { DataHasher } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHasher.js';
export { DataHasherFactory } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHasherFactory.js';

// ── CBOR serialization ──────────────────────────────────────────────────────
export { CborSerializer } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborSerializer.js';
export { CborDeserializer } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborDeserializer.js';
export { CborError } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborError.js';

// ── payment / value / split ─────────────────────────────────────────────────
export type { IPaymentData } from '@unicitylabs/state-transition-sdk/lib/payment/IPaymentData.js';
export { Asset } from '@unicitylabs/state-transition-sdk/lib/payment/asset/Asset.js';
export { AssetId } from '@unicitylabs/state-transition-sdk/lib/payment/asset/AssetId.js';
export { PaymentAssetCollection } from '@unicitylabs/state-transition-sdk/lib/payment/asset/PaymentAssetCollection.js';
export { TokenSplit } from '@unicitylabs/state-transition-sdk/lib/payment/TokenSplit.js';
export { SplitTokenRequest } from '@unicitylabs/state-transition-sdk/lib/payment/SplitTokenRequest.js';
export { SplitToken } from '@unicitylabs/state-transition-sdk/lib/payment/SplitToken.js';
export { SplitAssetProof } from '@unicitylabs/state-transition-sdk/lib/payment/SplitAssetProof.js';
export { SplitMintJustification } from '@unicitylabs/state-transition-sdk/lib/payment/SplitMintJustification.js';
export { SplitMintJustificationVerifier } from '@unicitylabs/state-transition-sdk/lib/payment/SplitMintJustificationVerifier.js';

// ── verification result types ───────────────────────────────────────────────
export { VerificationStatus } from '@unicitylabs/state-transition-sdk/lib/verification/VerificationStatus.js';
export { VerificationResult } from '@unicitylabs/state-transition-sdk/lib/verification/VerificationResult.js';

// ── unicity-id (nametag) ────────────────────────────────────────────────────
export { UnicityId } from '@unicitylabs/state-transition-sdk/lib/unicity-id/UnicityId.js';
export { UnicityIdMintTransaction } from '@unicitylabs/state-transition-sdk/lib/unicity-id/UnicityIdMintTransaction.js';
export { CertifiedUnicityIdMintTransaction } from '@unicitylabs/state-transition-sdk/lib/unicity-id/CertifiedUnicityIdMintTransaction.js';
export { UnicityIdToken } from '@unicitylabs/state-transition-sdk/lib/unicity-id/UnicityIdToken.js';

// ── util ────────────────────────────────────────────────────────────────────
export { HexConverter } from '@unicitylabs/state-transition-sdk/lib/util/HexConverter.js';
export { BigintConverter } from '@unicitylabs/state-transition-sdk/lib/util/BigintConverter.js';
export { BitString } from '@unicitylabs/state-transition-sdk/lib/util/BitString.js';
