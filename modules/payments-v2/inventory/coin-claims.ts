import { logger } from '../../../core/logger';
import type { CoinClaims } from '../../../token-engine/claims';
import type { RegistryReader } from './presentation';

export type ClaimRegistry = Pick<RegistryReader, 'getIssuanceClaims' | 'cacheRead' | 'onDefinitionsChanged'>;

const NO_CLAIMS: ReadonlyMap<string, string> = new Map();

/**
 * The coins this wallet treats as claimed: its plugins' claims, plus the token registry's for every
 * coin no plugin claims. Read live, because the registry loads after composition and refreshes.
 */
export class WalletCoinClaims {
  private seen: ReadonlyMap<string, string> | null = null;
  private registryVersion = '';
  private readonly conflicts = new Set<string>();
  private readiness: Promise<void> | null = null;

  constructor(
    private readonly plugins: CoinClaims,
    private readonly registry: ClaimRegistry
  ) {}

  issuerOf(coinId: string): string | null {
    return this.plugins.issuerOf(coinId) ?? this.registryClaims().get(coinId.toLowerCase()) ?? null;
  }

  /** Only a plugin's own claim on the coin lets its policy vouch for it; a registry claim never does. */
  vouches(coinId: string, tokenType: string): boolean {
    return this.plugins.vouches(coinId, tokenType);
  }

  /** The plugins' policies, which a remembered verdict is kept under. */
  fingerprint(): string {
    return this.plugins.fingerprint();
  }

  /** Changes whenever a registry claim that can change a verdict does: one on a coin no plugin claims. */
  version(): string {
    this.registryClaims();
    return this.registryVersion;
  }

  /** Resolves once the registry's persistent cache has been read, so a cached claim applies from the start. */
  whenReady(): Promise<void> {
    this.readiness ??= (this.registry.cacheRead?.() ?? Promise.resolve()).catch(() => undefined);
    return this.readiness;
  }

  subscribe(listener: () => void): () => void {
    return this.registry.onDefinitionsChanged?.(listener) ?? (() => undefined);
  }

  private registryClaims(): ReadonlyMap<string, string> {
    const current = this.registry.getIssuanceClaims?.() ?? NO_CLAIMS;
    if (current !== this.seen) this.adopt(current);
    return current;
  }

  private adopt(current: ReadonlyMap<string, string>): void {
    const lines: string[] = [];
    for (const [coinId, tokenType] of current) {
      const plugin = this.plugins.issuerOf(coinId);
      if (plugin === null) lines.push(JSON.stringify([coinId, tokenType]));
      else if (plugin !== tokenType) this.noteConflict(coinId, tokenType, plugin);
    }
    this.seen = current;
    this.registryVersion = lines.sort().join('\n');
  }

  private noteConflict(coinId: string, tokenType: string, plugin: string): void {
    const key = `${coinId}:${tokenType}`;
    if (this.conflicts.has(key)) return;
    this.conflicts.add(key);
    logger.warn(
      'PaymentsV2',
      `The token registry names token type ${tokenType} as the issuer of coin ${coinId}; keeping the loaded plugin's ${plugin}`
    );
  }
}
