import { SphereError } from '../core/errors';
import { MintReasonUnverifiableError } from './errors';
import {
  CborDeserializer,
  type CertifiedMintTransaction,
  type IMintJustificationVerifier,
  MintJustificationVerifierService,
  type Token,
  VerificationResult,
  VerificationStatus,
} from './sdk';

const RULE = 'MintJustificationVerification';

/** The engine's mint-reason verifiers by CBOR tag; a plugin's throw or an unknown tag is not yet verifiable, never a FAIL. */
export class MintReasonRegistry extends MintJustificationVerifierService {
  private readonly byTag = new Map<bigint, IMintJustificationVerifier>();
  private readonly pluginTags = new Set<bigint>();

  public override register(verifier: IMintJustificationVerifier): this {
    super.register(verifier);
    this.byTag.set(verifier.tag, verifier);
    return this;
  }

  public registerPlugin(verifier: IMintJustificationVerifier): this {
    this.register(verifier);
    this.pluginTags.add(verifier.tag);
    return this;
  }

  public override async verify(
    transaction: CertifiedMintTransaction,
    nestedTokenCollector: (token: Token) => void,
  ): Promise<VerificationResult<VerificationStatus>> {
    const tag = transaction.justification ? reasonTag(transaction.justification) : null;
    if (tag === null) return super.verify(transaction, nestedTokenCollector);
    const verifier = this.byTag.get(tag);
    if (verifier === undefined) throw new MintReasonUnverifiableError(`No verifier is registered for mint-reason tag ${tag}`);
    if (!this.pluginTags.has(tag)) return super.verify(transaction, nestedTokenCollector);
    return verifyPlugin(verifier, transaction, nestedTokenCollector);
  }

  public knows(tag: bigint): boolean {
    return this.byTag.has(tag);
  }

  /** `verifiers` replace the registered ones of their tags; a tag this registry lacks is refused. */
  public overlaid(verifiers: readonly IMintJustificationVerifier[]): MintReasonRegistry {
    for (const verifier of verifiers) assertKnown(this, verifier.tag);
    const replaced = new Map(verifiers.map((verifier) => [verifier.tag, verifier]));
    const overlay = new MintReasonRegistry();
    for (const [tag, verifier] of this.byTag) {
      const perCall = replaced.get(tag);
      if (perCall !== undefined || this.pluginTags.has(tag)) overlay.registerPlugin(perCall ?? verifier);
      else overlay.register(verifier);
    }
    return overlay;
  }

  public assertVerifiable(justification: Uint8Array): void {
    const tag = reasonTag(justification);
    if (tag === null) throw new SphereError('The mint reason is not tagged CBOR', 'VALIDATION_ERROR');
    assertKnown(this, tag);
  }
}

export function reasonTag(justification: Uint8Array): bigint | null {
  try {
    return BigInt(CborDeserializer.decodeTag(justification).tag);
  } catch {
    return null;
  }
}

async function verifyPlugin(
  verifier: IMintJustificationVerifier,
  transaction: CertifiedMintTransaction,
  nestedTokenCollector: (token: Token) => void,
): Promise<VerificationResult<VerificationStatus>> {
  let result: VerificationResult<VerificationStatus>;
  try {
    result = await verifier.verify(transaction, nestedTokenCollector);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new MintReasonUnverifiableError(`Mint-reason tag ${verifier.tag} cannot be verified yet: ${why}`, err);
  }
  return result.status === VerificationStatus.OK
    ? new VerificationResult(RULE, VerificationStatus.OK, '', [result])
    : new VerificationResult(RULE, VerificationStatus.FAIL, `Verification failed for tag ${verifier.tag}.`, [result]);
}

function assertKnown(registry: MintReasonRegistry, tag: bigint): void {
  if (registry.knows(tag)) return;
  throw new SphereError(
    `No verifier is registered on the engine for mint-reason tag ${tag}, so a replay of this mint could never verify`,
    'VALIDATION_ERROR',
  );
}
