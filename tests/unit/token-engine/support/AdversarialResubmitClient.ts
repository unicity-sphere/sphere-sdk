/**
 * Adversarial wire client over the in-memory TestAggregatorClient — the #692 F13
 * de-lying of the engine test aggregator. TestAggregatorClient answers SUCCESS to
 * every re-submit (first-write-wins friendly), which let bare-submit code paths
 * pass the contract suite for the wrong reason. The OBSERVED gateway contract
 * (M7 live e2e 2026-06-12, sdk-changes E.2) is that the submit status carries NO
 * conflict/duplicate signal: SUCCESS for duplicates AND conflicts on the current
 * gateway, and an unknown/transitional status (STATE_ID_EXISTS) on earlier ones.
 * Only getInclusionProof + match-verify reveals whose transaction certified.
 *
 * This wrapper detects a re-submit via the INNER aggregator's own state (an
 * inclusion for the stateId already exists), so it stays adversarial across
 * engines sharing one aggregator, and answers with a status that must carry no
 * usable signal: `unknown-status` (default — the harsher lie: not SUCCESS, not a
 * clean reject) or `success` (the current gateway's lie).
 */
import {
  CertificationData,
  CertificationResponse,
  CertificationStatus,
  HexConverter,
  type IAggregatorClient,
  type InclusionProofResponse,
  StateId,
} from '../../../../token-engine/sdk';
import { TestAggregatorClient } from './TestAggregatorClient';

/** Not a member of CertificationStatus — a status this SDK's enum does not know. */
export const ADVERSARIAL_UNKNOWN_STATUS = 'ADVERSARIAL_RESUBMIT_UNKNOWN_STATUS';

export type ResubmitLie = 'unknown-status' | 'success';

export interface ResubmitRecord {
  readonly stateIdHex: string;
  readonly transactionHashHex: string;
  readonly kind: 'first' | 'resubmit-duplicate' | 'resubmit-conflict' | 'rejected';
  readonly wireStatus: string;
}

export class AdversarialResubmitClient implements IAggregatorClient {
  public readonly submits: ResubmitRecord[] = [];

  public constructor(
    private readonly inner: TestAggregatorClient,
    private readonly resubmitLie: ResubmitLie = 'unknown-status',
  ) {}

  public async submitCertificationRequest(certificationData: CertificationData): Promise<CertificationResponse> {
    const stateId = await StateId.fromCertificationData(certificationData);
    const stateIdHex = HexConverter.encode(stateId.data);
    const transactionHashHex = HexConverter.encode(certificationData.transactionHash.data);
    // Prior inclusion read from the SHARED inner tree — adversarial across engines too.
    // v3: a null proof IS "no prior leaf"; a present one always carries certification data.
    const prior = (await this.inner.getInclusionProof(stateId)).inclusionProof;
    const response = await this.inner.submitCertificationRequest(certificationData);

    let kind: ResubmitRecord['kind'];
    let wire: CertificationResponse;
    if (prior !== null) {
      kind =
        HexConverter.encode(prior.certificationData.transactionHash.data) === transactionHashHex
          ? 'resubmit-duplicate'
          : 'resubmit-conflict';
      wire =
        this.resubmitLie === 'success'
          ? CertificationResponse.create(CertificationStatus.SUCCESS)
          : CertificationResponse.create(ADVERSARIAL_UNKNOWN_STATUS);
    } else {
      kind = response.status === CertificationStatus.SUCCESS ? 'first' : 'rejected';
      wire = response;
    }
    this.submits.push({ stateIdHex, transactionHashHex, kind, wireStatus: wire.status });
    return wire;
  }

  public getInclusionProof(stateId: StateId): Promise<InclusionProofResponse> {
    return this.inner.getInclusionProof(stateId);
  }
}
