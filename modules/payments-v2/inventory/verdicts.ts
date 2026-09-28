import type { CoinClaims } from '../../../token-engine/claims';
import type { ITokenEngine } from '../../../token-engine/engine';
import type { SphereToken } from '../../../token-engine/types';
import { SerialChain } from '../async';
import { STORE_KEYS, type ScopedKV } from '../stores';

export const VERDICT_RETRY_MS = 30_000;
export const VERDICT_RETRY_MAX_MS = 60 * 60 * 1000;

type ClaimReader = Pick<CoinClaims, 'issuerOf'>;
type Verdict = 'verified' | 'refused' | 'retry';

interface Retry {
  readonly attempts: number;
  readonly atMs: number;
}

export interface TokenVerdictsDeps {
  readonly kv: ScopedKV;
  readonly claims: ClaimReader;
  readonly engine: () => Pick<ITokenEngine, 'decodeToken' | 'verify'>;
  readonly getBlobs: (tokenIds: string[]) => Promise<Map<string, Uint8Array>>;
  readonly changed: () => void;
  readonly now?: () => number;
}

export function honoursClaims(claims: ClaimReader, token: SphereToken): boolean {
  const issuers = (token.value?.assets ?? []).map((asset) => claims.issuerOf(asset.coinId));
  return issuers.some((issuer) => issuer !== null) && issuers.every((issuer) => issuer === null || issuer === token.tokenType);
}

export class TokenVerdicts {
  private readonly verified = new Set<string>();
  private readonly refused = new Set<string>();
  private readonly retries = new Map<string, Retry>();
  private readonly writes = new SerialChain();
  private hydration: Promise<void> | null = null;
  private queued: readonly string[] | null = null;
  private running: Promise<void> | null = null;
  private held: readonly string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private live = false;

  constructor(private readonly deps: TokenVerdictsDeps) {}

  isClaimed(coinId: string): boolean {
    return this.deps.claims.issuerOf(coinId) !== null;
  }

  trusts(tokenId: string, coinId: string): boolean {
    return !this.isClaimed(coinId) || this.verified.has(tokenId);
  }

  hydrate(): Promise<void> {
    this.hydration ??= this.load().catch((error: unknown) => {
      this.hydration = null;
      throw error;
    });
    return this.hydration;
  }

  start(): Promise<void> {
    this.live = true;
    return this.hydrate();
  }

  stop(): void {
    this.live = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  async accept(token: SphereToken): Promise<void> {
    if (honoursClaims(this.deps.claims, token)) await this.remember(token.blob.tokenId);
  }

  async recordSplit(sourceTokenId: string, outputTokenId: string): Promise<void> {
    await this.hydrate();
    if (this.verified.has(sourceTokenId)) await this.remember(outputTokenId);
  }

  review(holders: readonly string[]): Promise<void> {
    this.queued = holders;
    this.running ??= this.drain();
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued !== null) {
        const holders = this.queued;
        this.queued = null;
        await this.reviewOnce(holders);
      }
    } finally {
      this.running = null;
    }
  }

  private async reviewOnce(holders: readonly string[]): Promise<void> {
    await this.hydrate();
    this.held = holders;
    const due = holders.filter((tokenId) => this.isDue(tokenId));
    const verdicts = due.length === 0 ? new Map<string, Verdict>() : await this.check(due);
    for (const tokenId of due) this.settle(tokenId, verdicts.get(tokenId) ?? 'retry');
    if (due.some((tokenId) => verdicts.get(tokenId) === 'verified')) {
      await this.persist();
      this.deps.changed();
    }
    this.scheduleRetry();
  }

  private isDue(tokenId: string): boolean {
    if (this.verified.has(tokenId) || this.refused.has(tokenId)) return false;
    return (this.retries.get(tokenId)?.atMs ?? 0) <= this.now();
  }

  private async check(due: readonly string[]): Promise<Map<string, Verdict>> {
    const verdicts = new Map<string, Verdict>();
    let blobs: Map<string, Uint8Array>;
    try {
      blobs = await this.deps.getBlobs([...due]);
    } catch {
      return verdicts;
    }
    for (const tokenId of due) {
      const bytes = blobs.get(tokenId);
      if (bytes !== undefined) verdicts.set(tokenId, await this.verdictOf(tokenId, bytes));
    }
    return verdicts;
  }

  private async verdictOf(tokenId: string, bytes: Uint8Array): Promise<Verdict> {
    let engine: ReturnType<TokenVerdictsDeps['engine']>;
    try {
      engine = this.deps.engine();
    } catch {
      return 'retry';
    }
    let token: SphereToken;
    try {
      token = await engine.decodeToken({ tokenId, token: bytes });
    } catch {
      return 'refused';
    }
    if (token.blob.tokenId !== tokenId || !honoursClaims(this.deps.claims, token)) return 'refused';
    try {
      return (await engine.verify(token)).ok ? 'verified' : 'refused';
    } catch {
      return 'retry';
    }
  }

  private settle(tokenId: string, verdict: Verdict): void {
    if (verdict === 'retry') {
      this.retries.set(tokenId, this.nextRetry(this.retries.get(tokenId)));
      return;
    }
    this.retries.delete(tokenId);
    (verdict === 'verified' ? this.verified : this.refused).add(tokenId);
  }

  private nextRetry(previous: Retry | undefined): Retry {
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = Math.min(VERDICT_RETRY_MS * 2 ** (attempts - 1), VERDICT_RETRY_MAX_MS);
    return { attempts, atMs: this.now() + delay };
  }

  private scheduleRetry(): void {
    if (!this.live || this.timer !== null) return;
    const due = this.held.flatMap((tokenId) => this.retries.get(tokenId)?.atMs ?? []);
    if (due.length === 0) return;
    const delay = Math.max(0, due.reduce((a, b) => Math.min(a, b)) - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.review(this.held).catch(() => undefined);
    }, delay);
  }

  private async remember(tokenId: string): Promise<void> {
    await this.hydrate();
    if (this.verified.has(tokenId)) return;
    this.verified.add(tokenId);
    this.refused.delete(tokenId);
    this.retries.delete(tokenId);
    await this.persist();
  }

  private persist(): Promise<void> {
    return this.writes.enqueue(() => this.deps.kv.set(STORE_KEYS.verifiedTokens, [...this.verified]));
  }

  private async load(): Promise<void> {
    const tokenIds = await this.deps.kv.get<string[]>(STORE_KEYS.verifiedTokens);
    for (const tokenId of tokenIds ?? []) this.verified.add(tokenId);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
