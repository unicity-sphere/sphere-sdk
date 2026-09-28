import { SphereError } from '../core/errors';
import { CborDeserializer, type IMintJustificationVerifier, MintJustificationVerifierService } from './sdk';

/** The engine's mint-reason verifiers by CBOR tag. */
export class MintReasonRegistry extends MintJustificationVerifierService {
  private readonly byTag = new Map<bigint, IMintJustificationVerifier>();

  public override register(verifier: IMintJustificationVerifier): this {
    super.register(verifier);
    this.byTag.set(verifier.tag, verifier);
    return this;
  }

  public knows(tag: bigint): boolean {
    return this.byTag.has(tag);
  }

  /** `verifiers` replace the registered ones of their tags; a tag this registry lacks is refused. */
  public overlaid(verifiers: readonly IMintJustificationVerifier[]): MintReasonRegistry {
    for (const verifier of verifiers) assertKnown(this, verifier.tag);
    const replaced = new Map(verifiers.map((verifier) => [verifier.tag, verifier]));
    const overlay = new MintReasonRegistry();
    for (const [tag, verifier] of this.byTag) overlay.register(replaced.get(tag) ?? verifier);
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

function assertKnown(registry: MintReasonRegistry, tag: bigint): void {
  if (registry.knows(tag)) return;
  throw new SphereError(
    `No verifier is registered on the engine for mint-reason tag ${tag}, so a replay of this mint could never verify`,
    'VALIDATION_ERROR',
  );
}
