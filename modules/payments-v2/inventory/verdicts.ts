import type { CoinClaims } from '../../../token-engine/claims';
import type { ITokenEngine } from '../../../token-engine/engine';
import type { SphereToken } from '../../../token-engine/types';
import type { Unverified } from '../../../types';
import { SerialChain } from '../async';
import { STORE_KEYS, type ScopedKV } from '../stores';
import type { Standing } from './InventoryView';

export const VERDICT_RETRY_MS = 30_000;
export const VERDICT_RETRY_MAX_MS = 60 * 60 * 1000;

/** Which token type issues a coin, and whether `verify` enforces that type's issuance policy here. */
export type ClaimReader = Pick<CoinClaims, 'issuerOf' | 'enforces'>;

export interface VerdictClaims extends ClaimReader {
  fingerprint(): string;
  whenReady?(): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

interface Remembered {
  readonly fingerprint: string;
  readonly tokenIds: readonly string[];
}
type Verdict = 'verified' | 'refused' | 'unvouched' | 'retry';

interface Retry {
  readonly attempts: number;
  readonly atMs: number;
}

export interface TokenVerdictsDeps {
  readonly kv: ScopedKV;
  readonly claims: VerdictClaims;
  readonly engine: () => Pick<ITokenEngine, 'decodeToken' | 'verify'>;
  readonly getBlobs: (tokenIds: string[]) => Promise<Map<string, Uint8Array>>;
  readonly changed: () => void;
  /** The held tokens that carry a claimed coin, judged again when the claims change. */
  readonly holders?: () => readonly string[];
  readonly track?: (op: Promise<unknown>) => void;
  readonly now?: () => number;
}

export function honoursClaims(claims: Pick<ClaimReader, 'issuerOf'>, token: SphereToken): boolean {
  const issuers = (token.value?.assets ?? []).map((asset) => claims.issuerOf(asset.coinId));
  return issuers.some((issuer) => issuer !== null) && issuers.every((issuer) => issuer === null || issuer === token.tokenType);
}

/** Of the type that issues every claimed coin it carries, under a policy `verify` enforces here. */
export function vouchedFor(claims: ClaimReader, token: SphereToken): boolean {
  return honoursClaims(claims, token) && claims.enforces(token.tokenType);
}

/** The claimed coins of a verified arrival that do not count yet, and why; null when all of them count. */
export function unverifiedOnArrival(claims: ClaimReader, token: SphereToken): { coinIds: string[]; standing: Unverified } | null {
  const coinIds = (token.value?.assets ?? []).map((asset) => asset.coinId).filter((coinId) => claims.issuerOf(coinId) !== null);
  if (coinIds.length === 0 || vouchedFor(claims, token)) return null;
  return { coinIds, standing: honoursClaims(claims, token) ? 'pending' : 'refused' };
}

export class TokenVerdicts {
  private readonly verified = new Set<string>();
  private readonly refused = new Set<string>();
  /** Of the issuing type under a claim no policy here enforces: pending until the claims change. */
  private readonly unvouched = new Set<string>();
  private readonly retries = new Map<string, Retry>();
  private readonly writes = new SerialChain();
  /** The claims fingerprint every verdict above was reached under. */
  private basis: string;
  private hydration: Promise<void> | null = null;
  private queued: readonly string[] | null = null;
  private running: Promise<void> | null = null;
  private held: readonly string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unwatch: (() => void) | null = null;
  private live = false;

  constructor(private readonly deps: TokenVerdictsDeps) {
    this.basis = deps.claims.fingerprint();
  }

  isClaimed(coinId: string): boolean {
    return this.deps.claims.issuerOf(coinId) !== null;
  }

  standing(tokenId: string, coinId: string): Standing {
    this.syncClaims();
    if (!this.isClaimed(coinId) || this.verified.has(tokenId)) return 'trusted';
    return this.refused.has(tokenId) ? 'refused' : 'pending';
  }

  trusts(tokenId: string, coinId: string): boolean {
    return this.standing(tokenId, coinId) === 'trusted';
  }

  /** Forgets every verdict reached under other claims and, while started, judges the holders again; true when the claims moved. */
  syncClaims(): boolean {
    const current = this.deps.claims.fingerprint();
    if (current === this.basis) return false;
    this.basis = current;
    this.verified.clear();
    this.refused.clear();
    this.unvouched.clear();
    this.retries.clear();
    this.disarmRetry();
    if (this.live) this.rejudge();
    return true;
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
    this.unwatch ??= this.deps.claims.subscribe?.(() => this.onClaimsChanged()) ?? null;
    return this.hydrate();
  }

  stop(): void {
    this.live = false;
    this.unwatch?.();
    this.unwatch = null;
    this.disarmRetry();
  }

  async accept(token: SphereToken): Promise<void> {
    const vouched = (): boolean => vouchedFor(this.deps.claims, token);
    if (vouched()) await this.remember(token.blob.tokenId, vouched);
  }

  recordSplit(sourceTokenId: string, outputTokenId: string): Promise<void> {
    return this.remember(outputTokenId, () => this.verified.has(sourceTokenId));
  }

  review(holders: readonly string[]): Promise<void> {
    this.queued = holders;
    this.running ??= this.drain();
    return this.running;
  }

  private onClaimsChanged(): void {
    if (this.syncClaims()) this.deps.changed();
  }

  private rejudge(): void {
    const op = this.review(this.deps.holders?.() ?? this.held).then(() => this.deps.changed());
    if (this.deps.track !== undefined) this.deps.track(op);
    else void op.catch(() => undefined);
  }

  private disarmRetry(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
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
    this.syncClaims();
    const basis = this.basis;
    this.held = holders;
    const due = holders.filter((tokenId) => this.isDue(tokenId));
    const verdicts = due.length === 0 ? new Map<string, Verdict>() : await this.check(due);
    this.syncClaims();
    if (this.basis !== basis) {
      this.queued ??= holders;
      return;
    }
    for (const tokenId of due) this.settle(tokenId, verdicts.get(tokenId) ?? 'retry');
    if (due.some((tokenId) => verdicts.get(tokenId) === 'verified')) {
      await this.persist();
      this.deps.changed();
    }
    this.scheduleRetry();
  }

  private isDue(tokenId: string): boolean {
    if (this.verified.has(tokenId) || this.refused.has(tokenId) || this.unvouched.has(tokenId)) return false;
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
    if (!this.deps.claims.enforces(token.tokenType)) return 'unvouched';
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
    ({ verified: this.verified, refused: this.refused, unvouched: this.unvouched })[verdict].add(tokenId);
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

  /** Records a token as verified when `vouched` holds under the claims current once hydrated. */
  private async remember(tokenId: string, vouched: () => boolean): Promise<void> {
    await this.hydrate();
    this.syncClaims();
    if (this.verified.has(tokenId) || !vouched()) return;
    this.verified.add(tokenId);
    this.refused.delete(tokenId);
    this.unvouched.delete(tokenId);
    this.retries.delete(tokenId);
    await this.persist();
  }

  /** Written under the claims the set was reached under. */
  private persist(): Promise<void> {
    const remembered: Remembered = { fingerprint: this.basis, tokenIds: [...this.verified] };
    return this.writes.enqueue(() => this.deps.kv.set(STORE_KEYS.verifiedTokens, remembered));
  }

  private async load(): Promise<void> {
    await this.deps.claims.whenReady?.();
    const remembered = await this.deps.kv.get<Remembered>(STORE_KEYS.verifiedTokens);
    this.syncClaims();
    if (remembered?.fingerprint !== this.basis) return;
    for (const tokenId of remembered.tokenIds) this.verified.add(tokenId);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
