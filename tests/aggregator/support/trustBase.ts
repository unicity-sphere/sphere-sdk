/**
 * Instruments for the vacuity guard in `aggregator-v3.test.ts`.
 *
 * The four positive cases in that suite all assert `verify() === { ok: true }`
 * against a real aggregator-go. That is only evidence if verification can also
 * say NO — a `verify()` that returned OK unconditionally, or one that never
 * consulted the trust base at all, would make every one of them green. So the
 * suite needs one case where the ONLY thing wrong is the trust base, and the
 * trust base is wrong in the one way that is hard to fake: a root key that is a
 * perfectly good secp256k1 public key but not the one that signed the seal.
 *
 * Everything here is deliberately narrow: substitute keys, rebuild the SDK's own
 * verification pipeline exactly as `token-engine/factory.ts` does, and flatten a
 * verification trace. No assertions live in this file.
 */

import { decodeSpherePaymentData } from '../../../token-engine/SpherePaymentData';
import {
  HexConverter,
  MintJustificationVerifierService,
  PredicateVerifierService,
  RootTrustBase,
  Secp256k1SignatureVerifier,
  SigningService,
  SplitMintJustificationVerifier,
  TokenIssuanceVerifierService,
  UnicityCertificateVerifier,
  UnicitySealQuorumSignaturesVerificationRule,
  VerificationContext,
  VerificationResult,
  VerifiedSealCache,
} from '../../../token-engine/sdk';

/** The two fields of the trust base JSON this module touches; the rest rides along untyped. */
interface RootNodeJson {
  readonly nodeId: string;
  readonly sigKey: string;
  readonly stake: string;
}

interface TrustBaseJson {
  rootNodes: RootNodeJson[];
  readonly [field: string]: unknown;
}

/** A fresh, valid, compressed secp256k1 public key that no node already claims. */
function unusedSigningKey(taken: Set<string>): string {
  // `generatePrivateKey` is rejection-sampled, so a duplicate is not reachable in
  // practice; the bound exists so a broken generator fails loudly instead of hanging.
  for (let attempt = 0; attempt < 32; attempt++) {
    const publicKey = new SigningService(SigningService.generatePrivateKey()).publicKey;
    const hex = HexConverter.encode(publicKey);
    if (!SigningService.isPublicKeyValid(publicKey) || taken.has(hex)) continue;
    taken.add(hex);
    return hex;
  }
  throw new Error('Could not generate a distinct root signing key.');
}

/**
 * The same trust base with every root node's `sigKey` replaced by a different,
 * valid public key.
 *
 * What is deliberately NOT changed, because each would make the guard prove
 * something weaker than "the root key is checked":
 *
 * - the **node ids**, so the quorum rule still FINDS each node and rejects it on
 *   its key. Renaming a node makes the seal's signer unknown to the trust base,
 *   which fails through `'No root node defined'` — a lookup miss, not a key check.
 * - the **networkId**, which `UnicityCertificateVerifier` compares against the
 *   seal before it ever reaches a signature.
 * - the **quorumThreshold**, stakes, epoch, hashes and the trust base's own
 *   `signatures` map, so the result still parses as a valid `RootTrustBase` and
 *   still demands the same number of good signatures as the real one.
 *
 * @param trustBaseJson The trust base the aggregator stack generated.
 * @returns A structurally identical trust base whose root keys are all wrong.
 */
export function withWrongRootKeys(trustBaseJson: unknown): unknown {
  const tampered = structuredClone(trustBaseJson) as TrustBaseJson;
  if (!Array.isArray(tampered.rootNodes) || tampered.rootNodes.length === 0) {
    throw new Error('Trust base declares no root nodes — there is no key to get wrong.');
  }
  const taken = new Set(tampered.rootNodes.map((node) => node.sigKey.toLowerCase()));
  tampered.rootNodes = tampered.rootNodes.map((node) => ({ ...node, sigKey: unusedSigningKey(taken) }));
  return tampered;
}

/**
 * The verification pipeline `createSphereTokenEngine` builds, over a given trust
 * base.
 *
 * `ITokenEngine.verify` answers `{ ok, reason }` where `reason` is the AGGREGATED
 * `VerificationStatus` — `'FAIL'`. The granular status the rules produce, including
 * `INVALID_TRUSTBASE`, survives only in the nested trace, which the port does not
 * expose. Naming the reason therefore means driving `Token.verify` directly.
 *
 * This is a reconstruction of the engine's context, not the engine's own, so the
 * caller must keep it honest by also running the CORRECT trust base through it:
 * a context assembled wrongly here would fail that case too.
 */
export function verificationContextFor(trustBaseJson: unknown): VerificationContext {
  const mintJustificationVerifier = new MintJustificationVerifierService();
  mintJustificationVerifier.register(new SplitMintJustificationVerifier(decodeSpherePaymentData));
  return new VerificationContext(
    RootTrustBase.fromJSON(trustBaseJson),
    PredicateVerifierService.create(),
    new UnicityCertificateVerifier(
      new UnicitySealQuorumSignaturesVerificationRule(new Secp256k1SignatureVerifier(), new VerifiedSealCache(256)),
    ),
    mintJustificationVerifier,
    new TokenIssuanceVerifierService(false),
  );
}

/** One node of a flattened verification trace. */
export interface TraceEntry {
  readonly rule: string;
  readonly status: string;
  readonly message: string;
}

/**
 * Depth-first flattening of a verification trace, root first.
 *
 * Rules nest their children in `results`, and statuses are of mixed enum types
 * down the tree, so they are compared as strings.
 */
export function flattenTrace(result: VerificationResult<unknown>): TraceEntry[] {
  return [
    { message: result.message, rule: result.rule, status: String(result.status) },
    ...result.results.flatMap((child) => flattenTrace(child)),
  ];
}
