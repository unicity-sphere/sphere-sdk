/**
 * VENDORED (test-only) from @unicitylabs/state-transition-sdk
 * tests/functional/TestAggregatorClient.ts. The npm package ships only lib/,
 * not its test helpers, so this in-memory aggregator is copied with imports
 * re-pointed at the installed lib/ (and the two fixtures to ./). It
 * orchestrates installed SDK classes — a faithful relocation, not reimplemented
 * logic. Lets the engine's contract suite run the REAL adapter without a live
 * aggregator.
 *
 * The consensus-clock model below is THIS file's own, not a copy of upstream:
 * v3 gave the service a reference time, and a fake has to decide where it comes
 * from. The choices, and why:
 *
 *  - It is FIXED, not a wall clock. The leaf value binds it, so a moving clock
 *    would make the same request hash to a different leaf on every run — and the
 *    E.1 byte-identity assertions would flake rather than fail.
 *  - It is RECORDED PER LEAF at insertion and served unchanged for every later
 *    proof of that leaf, which is what the real service does. Recomputing it per
 *    fetch would make every refetch of a still-valid proof come back PATH_INVALID.
 *  - It is SETTABLE, so a test can reach REQUEST_EXPIRED (advance past a
 *    deadline) and REFERENCE_TIME_AFTER_ROUND (move the round back behind a
 *    recorded leaf) instead of leaving those statuses as dead enum members.
 */

import { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/api/bft/RootTrustBase.js';
import { CertificationData } from '@unicitylabs/state-transition-sdk/lib/api/CertificationData.js';
import {
  CertificationResponse,
  CertificationStatus,
} from '@unicitylabs/state-transition-sdk/lib/api/CertificationResponse.js';
import { IAggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/IAggregatorClient.js';
import { InclusionCertificate } from '@unicitylabs/state-transition-sdk/lib/api/InclusionCertificate.js';
import { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProof.js';
import { InclusionProofResponse } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProofResponse.js';
import { calculateLeafValue } from '@unicitylabs/state-transition-sdk/lib/api/LeafValue.js';
import { StateId } from '@unicitylabs/state-transition-sdk/lib/api/StateId.js';
import { DataHasher } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHasher.js';
import { DataHasherFactory } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHasherFactory.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/SigningService.js';
import { PredicateVerifierService } from '@unicitylabs/state-transition-sdk/lib/predicate/verification/PredicateVerifierService.js';
import { SparseMerkleTree } from '@unicitylabs/state-transition-sdk/lib/smt/radix/SparseMerkleTree.js';
import { BitString } from '@unicitylabs/state-transition-sdk/lib/util/BitString.js';
import { VerificationStatus } from '@unicitylabs/state-transition-sdk/lib/verification/VerificationStatus.js';

import { createRootTrustBase } from './RootTrustBaseFixture';
import { createUnicityCertificate } from './UnicityCertificateFixture';

/** The fake's consensus clock, in Unix seconds. Fixed so leaf values are stable across runs. */
export const TEST_REFERENCE_TIME = 1_800_000_000n;

/** One certified leaf: the request, and the reference time the round recorded it under. */
interface CertifiedLeaf {
  readonly certificationData: CertificationData;
  readonly referenceTime: bigint;
}

/**
 * Test aggregator client implementation that stores all submitted certification requests in memory.
 */
export class TestAggregatorClient implements IAggregatorClient {
  public readonly rootTrustBase: RootTrustBase;
  private readonly predicateVerifier: PredicateVerifierService;
  private readonly requests: Map<bigint, CertifiedLeaf> = new Map();

  private constructor(
    private readonly smt: SparseMerkleTree,
    private readonly signingService: SigningService,
    private referenceTime: bigint,
  ) {
    this.rootTrustBase = createRootTrustBase(this.signingService.publicKey);
    this.predicateVerifier = PredicateVerifierService.create();
  }

  /**
   * Creates a new TestAggregatorClient instance with optional private key.
   * If no private key is provided, a new one is generated.
   */
  public static create(
    privateKey: Uint8Array = SigningService.generatePrivateKey(),
    referenceTime: bigint = TEST_REFERENCE_TIME,
  ): TestAggregatorClient {
    return new TestAggregatorClient(
      new SparseMerkleTree(new DataHasherFactory(HashAlgorithm.SHA256, DataHasher)),
      new SigningService(privateKey),
      referenceTime,
    );
  }

  /**
   * Move the fake's consensus clock. Already-certified leaves keep the reference
   * time they were recorded under — only new rounds see the new value.
   */
  public setReferenceTime(referenceTime: bigint): void {
    this.referenceTime = referenceTime;
  }

  /** Every request this aggregator certified, in insertion order. */
  public get certified(): CertificationData[] {
    return [...this.requests.values()].map((leaf) => leaf.certificationData);
  }

  /**
   * @inheritDoc
   *
   * Fidelity note: the proof is REBUILT from the live SMT on every request —
   * fresh sibling path + a fresh UnicityCertificate over the CURRENT root.
   * This matches the real aggregator (aggregator-go rebuilds per request;
   * confirmed by owner analysis on st-sdk#126, closed as invalid): only the
   * stored CertificationData is stable across refetches. Consequence for
   * resume flows: a proof refetched after later submissions differs
   * byte-wise from the original — match on certificationData /
   * transactionHash, never on proof bytes (sdk-changes E.2, sphere-sdk#501).
   *
   * The leaf's reference time is the exception to "recomputed per request": it
   * is served from the record, because the leaf VALUE binds it and a fresh one
   * would no longer reproduce the stored leaf.
   */
  public async getInclusionProof(stateId: StateId): Promise<InclusionProofResponse> {
    const path = BitString.fromBytesBigEndian(stateId.data).toBigInt();
    const root = await this.smt.calculateRoot();
    const certificate = await createUnicityCertificate(root.hash, this.signingService, this.referenceTime);

    const leaf = this.requests.get(path);
    // v3: "not certified yet" is the ABSENCE of a proof on the response, not a
    // proof with empty fields — an InclusionProof always describes a real leaf.
    if (leaf === undefined) {
      return InclusionProofResponse.notCertified(1n, certificate);
    }
    // Recomputed from the CURRENT tree per request — like the real aggregator
    // (fresh siblings + latest UC); only certificationData and the recorded
    // reference time are stable (#126).
    return InclusionProofResponse.certified(
      1n,
      new InclusionProof(
        leaf.certificationData,
        leaf.referenceTime,
        InclusionCertificate.create(root, stateId.data),
        certificate,
      ),
    );
  }

  /**
   * @inheritDoc
   */
  public async submitCertificationRequest(certificationData: CertificationData): Promise<CertificationResponse> {
    const stateId = await StateId.fromCertificationData(certificationData);

    const result = await this.predicateVerifier.verify(
      certificationData.lockScript,
      // v3 positional #2. A wrong VALUE here is harmless — SignaturePredicateVerifier
      // ignores it — but a wrong POSITION silently shifts sourceStateHash into this
      // slot, drops unlockScript, and answers SIGNATURE_VERIFICATION_FAILED to
      // everything.
      this.referenceTime,
      certificationData.sourceStateHash,
      certificationData.transactionHash,
      certificationData.unlockScript,
    );

    if (result.status !== VerificationStatus.OK) {
      return CertificationResponse.create(CertificationStatus.SIGNATURE_VERIFICATION_FAILED);
    }

    // v3: admissible only in a round strictly BELOW the request's deadline. A
    // request that carried none was admitted under a service-assigned one, which
    // is not recorded.
    if (certificationData.expiresAt !== null && this.referenceTime >= certificationData.expiresAt) {
      return CertificationResponse.create(CertificationStatus.REQUEST_EXPIRED);
    }

    const path = BitString.fromBytesBigEndian(stateId.data).toBigInt();
    if (!this.requests.has(path)) {
      // v3: the leaf binds the reference time, so the tree stores
      // H(transactionHash, referenceTime) rather than the bare hash. Getting this
      // wrong has no type signal at all — it surfaces as a blanket PATH_INVALID.
      const leafValue = await calculateLeafValue(certificationData.transactionHash, this.referenceTime);
      await this.smt.addLeaf(stateId.data, leafValue.data);
      this.requests.set(path, { certificationData, referenceTime: this.referenceTime });
    }

    return CertificationResponse.create(CertificationStatus.SUCCESS);
  }
}
