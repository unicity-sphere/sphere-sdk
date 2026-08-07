/**
 * Adversarial aggregator for token-engine paths — a drop-in IAggregatorClient
 * with the OBSERVED M7 gateway semantics (live e2e 2026-06-12): first-write-wins
 * per stateId, but the submit response is SUCCESS for duplicates AND conflicts —
 * the status carries no conflict signal; only getInclusionProof + match-verify
 * reveals whose transaction certified (sdk-changes E.2). Proof refetches are
 * BYTE-UNSTABLE (fresh sibling path + fresh certificate over a moved root), so
 * checkpoint tests can prove recovery used stored bytes, never a refetch.
 */
import {
  CertificationData,
  CertificationResponse,
  CertificationStatus,
  HexConverter,
  type IAggregatorClient,
  type InclusionProofResponse,
  MintTransaction,
  NetworkId,
  type RootTrustBase,
  SignaturePredicate,
  SigningService,
  StateId,
} from '../../../../token-engine/sdk';
import { TestAggregatorClient } from '../../token-engine/support/TestAggregatorClient';

export type SubmitMode = 'normal' | 'unknown-status';
export type ProofMode = 'normal' | 'timeout';

/** Not a member of CertificationStatus — exercises the SDK's tolerant parsing. */
export const FAKE_UNKNOWN_STATUS = 'FAKE_GATEWAY_UNKNOWN_STATUS';

export class FakeGatewayTimeoutError extends Error {
  constructor() {
    super('FakeGateway: proof fetch timed out');
    this.name = 'FakeGatewayTimeoutError';
  }
}

export interface SubmitRecord {
  readonly stateIdHex: string;
  readonly transactionHashHex: string;
  readonly kind: 'first' | 'duplicate' | 'conflict' | 'rejected';
  readonly wireStatus: string;
}

export interface FakeGatewayOptions {
  readonly inner?: TestAggregatorClient;
  readonly networkId?: NetworkId;
  /** Default true — turn off only to pin that instability itself is the fake's doing. */
  readonly byteUnstableRefetch?: boolean;
}

export class FakeGateway implements IAggregatorClient {
  readonly inner: TestAggregatorClient;
  readonly submits: SubmitRecord[] = [];

  private readonly networkId: NetworkId;
  private readonly byteUnstableRefetch: boolean;
  private readonly firstWrites = new Map<string, string>();
  private submitMode: SubmitMode = 'normal';
  private proofMode: ProofMode = 'normal';

  private constructor(options: FakeGatewayOptions) {
    this.inner = options.inner ?? TestAggregatorClient.create();
    this.networkId = options.networkId ?? NetworkId.LOCAL;
    this.byteUnstableRefetch = options.byteUnstableRefetch ?? true;
  }

  static create(options: FakeGatewayOptions = {}): FakeGateway {
    return new FakeGateway(options);
  }

  get rootTrustBase(): RootTrustBase {
    return this.inner.rootTrustBase;
  }

  setSubmitMode(mode: SubmitMode): void {
    this.submitMode = mode;
  }

  setProofMode(mode: ProofMode): void {
    this.proofMode = mode;
  }

  async submitCertificationRequest(certificationData: CertificationData): Promise<CertificationResponse> {
    const stateId = await StateId.fromCertificationData(certificationData);
    const stateIdHex = HexConverter.encode(stateId.data);
    const transactionHashHex = HexConverter.encode(certificationData.transactionHash.data);
    const prior = this.firstWrites.get(stateIdHex);
    const response = await this.inner.submitCertificationRequest(certificationData);
    const accepted = response.status === CertificationStatus.SUCCESS;
    const kind = !accepted ? 'rejected' : prior === undefined ? 'first' : prior === transactionHashHex ? 'duplicate' : 'conflict';
    if (accepted && prior === undefined) this.firstWrites.set(stateIdHex, transactionHashHex);
    const wire = this.submitMode === 'unknown-status' ? CertificationResponse.create(FAKE_UNKNOWN_STATUS) : response;
    this.submits.push({ stateIdHex, transactionHashHex, kind, wireStatus: wire.status });
    return wire;
  }

  async getInclusionProof(stateId: StateId): Promise<InclusionProofResponse> {
    if (this.proofMode === 'timeout') throw new FakeGatewayTimeoutError();
    if (this.byteUnstableRefetch) await this.churn();
    return this.inner.getInclusionProof(stateId);
  }

  /**
   * Moves the SMT root by certifying a throwaway mint — exactly what other
   * users' submissions do to a live gateway between two refetches. Existing
   * certifications stay stable (their CertificationData is untouched); every
   * subsequent proof re-encodes differently while still verifying.
   */
  private async churn(): Promise<void> {
    const throwawayPubkey = new SigningService(SigningService.generatePrivateKey()).publicKey;
    const mintTx = await MintTransaction.create(this.networkId, SignaturePredicate.create(throwawayPubkey), null);
    await this.inner.submitCertificationRequest(await CertificationData.fromMintTransaction(mintTx));
  }
}
