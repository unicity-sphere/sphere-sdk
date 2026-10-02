import type { CoinClaims } from '../../../token-engine/claims';
import type { ITokenEngine } from '../../../token-engine/engine';
import type { SphereToken } from '../../../token-engine/types';
import type { Unverified } from '../../../types';
import { SerialChain } from '../async';
import { STORE_KEYS, type ScopedKV } from '../stores';
import type { Standing } from './InventoryView';

export const VERDICT_RETRY_MS = 30_000;
export const VERDICT_RETRY_MAX_MS = 60 * 60 * 1000;

/** Which token type issues a coin, and whether a loaded policy of that type claims the coin itself. */
export type ClaimReader = Pick<CoinClaims, 'issuerOf' | 'vouches'>;

export interface VerdictClaims extends ClaimReader {
  /** The loaded policies: remembered verdicts are kept only under the same ones. */
  fingerprint(): string;
  /** Changes whenever a claim that can change a verdict does. */
  version?(): string;
  whenReady?(): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

/** Each coin a token carries, with its issuer when the verdict was reached: the verdict holds while they all still do. */
type Issuers = ReadonlyMap<string, string | null>;
type Settled = 'verified' | 'refused' | 'unvouched';

interface Judgement {
  readonly verdict: Settled;
  readonly issuers: Issuers;
}

interface Checked {
  readonly verdict: Settled | 'retry';
  readonly issuers?: Issuers;
}

type RememberedEntry = readonly [string, readonly (readonly [string, string | null])[]];

interface Remembered {
  readonly fingerprint: string;
  readonly verified?: readonly RememberedEntry[];
}

interface Retry {
  readonly attempts: number;
  readonly atMs: number;
}

const NO_COINS: Issuers = new Map();

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

function claimedCoins(claims: Pick<ClaimReader, 'issuerOf'>, token: SphereToken): string[] {
  return (token.value?.assets ?? []).map((asset) => asset.coinId).filter((coinId) => claims.issuerOf(coinId) !== null);
}

/** Every claimed coin it carries is claimed for its type by a loaded policy, so `verify` judges each one. */
export function vouchedFor(claims: ClaimReader, token: SphereToken): boolean {
  const coinIds = claimedCoins(claims, token);
  return coinIds.length > 0 && coinIds.every((coinId) => claims.vouches(coinId, token.tokenType));
}

/** The claimed coins of a verified arrival that do not count yet, and why; null when all of them count. */
export function unverifiedOnArrival(claims: ClaimReader, token: SphereToken): { coinIds: string[]; standing: Unverified } | null {
  const coinIds = claimedCoins(claims, token);
  if (coinIds.length === 0 || vouchedFor(claims, token)) return null;
  return { coinIds, standing: honoursClaims(claims, token) ? 'pending' : 'refused' };
}

function rememberedEntries(remembered: Remembered): RememberedEntry[] {
  return Array.isArray(remembered.verified) ? remembered.verified.filter((entry) => Array.isArray(entry?.[1])) : [];
}

export class TokenVerdicts {
  private readonly judged = new Map<string, Judgement>();
  private readonly retries = new Map<string, Retry>();
  private readonly writes = new SerialChain();
  private version: string;
  private hydration: Promise<void> | null = null;
  private queued: readonly string[] | null = null;
  private running: Promise<void> | null = null;
  private held: readonly string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unwatch: (() => void) | null = null;
  private live = false;

  constructor(private readonly deps: TokenVerdictsDeps) {
    this.version = deps.claims.version?.() ?? '';
  }

  isClaimed(coinId: string): boolean {
    return this.deps.claims.issuerOf(coinId) !== null;
  }

  standing(tokenId: string, coinId: string): Standing {
    if (!this.isClaimed(coinId)) return 'trusted';
    const verdict = this.current(tokenId)?.verdict;
    if (verdict === 'verified') return 'trusted';
    return verdict === 'refused' ? 'refused' : 'pending';
  }

  trusts(tokenId: string, coinId: string): boolean {
    return this.standing(tokenId, coinId) === 'trusted';
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
    if (this.unwatch === null) {
      this.version = this.deps.claims.version?.() ?? '';
      this.unwatch = this.deps.claims.subscribe?.(() => this.onClaimsChanged()) ?? null;
    }
    return this.hydrate();
  }

  stop(): void {
    this.live = false;
    this.unwatch?.();
    this.unwatch = null;
    this.disarmRetry();
  }

  async accept(token: SphereToken): Promise<void> {
    if (!vouchedFor(this.deps.claims, token)) return;
    await this.hydrate();
    if (vouchedFor(this.deps.claims, token)) await this.remember(token.blob.tokenId, this.issuersOf(token));
  }

  async recordSplit(sourceTokenId: string, outputTokenId: string): Promise<void> {
    await this.hydrate();
    const source = this.current(sourceTokenId);
    if (source?.verdict === 'verified') await this.remember(outputTokenId, source.issuers);
  }

  review(holders: readonly string[]): Promise<void> {
    this.queued = holders;
    this.running ??= this.drain();
    return this.running;
  }

  /** A verdict counts only while every coin its token carries keeps the issuer it was reached under. */
  private current(tokenId: string): Judgement | undefined {
    const judgement = this.judged.get(tokenId);
    if (judgement === undefined) return undefined;
    for (const [coinId, issuer] of judgement.issuers) if (this.deps.claims.issuerOf(coinId) !== issuer) return undefined;
    return judgement;
  }

  private issuersOf(token: SphereToken): Issuers {
    return new Map((token.value?.assets ?? []).map((asset) => [asset.coinId.toLowerCase(), this.deps.claims.issuerOf(asset.coinId)]));
  }

  private onClaimsChanged(): void {
    const version = this.deps.claims.version?.() ?? '';
    if (version === this.version) return;
    this.version = version;
    this.retries.clear();
    this.disarmRetry();
    const op = this.review(this.deps.holders?.() ?? this.held).then(() => this.deps.changed());
    if (this.deps.track !== undefined) this.deps.track(op);
    else void op.catch(() => undefined);
    this.deps.changed();
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
    this.held = holders;
    const due = holders.filter((tokenId) => this.isDue(tokenId));
    const checked = due.length === 0 ? new Map<string, Checked>() : await this.check(due);
    for (const tokenId of due) this.settle(tokenId, checked.get(tokenId) ?? { verdict: 'retry' });
    if (due.some((tokenId) => checked.get(tokenId)?.verdict === 'verified')) {
      await this.persist();
      this.deps.changed();
    }
    this.scheduleRetry();
  }

  private isDue(tokenId: string): boolean {
    if (this.current(tokenId) !== undefined) return false;
    return (this.retries.get(tokenId)?.atMs ?? 0) <= this.now();
  }

  private async check(due: readonly string[]): Promise<Map<string, Checked>> {
    const checked = new Map<string, Checked>();
    let blobs: Map<string, Uint8Array>;
    try {
      blobs = await this.deps.getBlobs([...due]);
    } catch {
      return checked;
    }
    for (const tokenId of due) {
      const bytes = blobs.get(tokenId);
      if (bytes !== undefined) checked.set(tokenId, await this.verdictOf(tokenId, bytes));
    }
    return checked;
  }

  /** The issuers are read before `verify`: claims that move during it leave the verdict holding for the old ones only. */
  private async verdictOf(tokenId: string, bytes: Uint8Array): Promise<Checked> {
    let engine: ReturnType<TokenVerdictsDeps['engine']>;
    try {
      engine = this.deps.engine();
    } catch {
      return { verdict: 'retry' };
    }
    let token: SphereToken;
    try {
      token = await engine.decodeToken({ tokenId, token: bytes });
    } catch {
      return { verdict: 'refused', issuers: NO_COINS };
    }
    const issuers = this.issuersOf(token);
    if (token.blob.tokenId !== tokenId || !honoursClaims(this.deps.claims, token)) return { verdict: 'refused', issuers };
    if (!vouchedFor(this.deps.claims, token)) return { verdict: 'unvouched', issuers };
    try {
      return { verdict: (await engine.verify(token)).ok ? 'verified' : 'refused', issuers };
    } catch {
      return { verdict: 'retry' };
    }
  }

  private settle(tokenId: string, checked: Checked): void {
    if (checked.verdict === 'retry') {
      this.retries.set(tokenId, this.nextRetry(this.retries.get(tokenId)));
      return;
    }
    this.retries.delete(tokenId);
    this.judged.set(tokenId, { verdict: checked.verdict, issuers: checked.issuers ?? NO_COINS });
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

  private async remember(tokenId: string, issuers: Issuers): Promise<void> {
    if (this.current(tokenId)?.verdict === 'verified') return;
    this.judged.set(tokenId, { verdict: 'verified', issuers });
    this.retries.delete(tokenId);
    await this.persist();
  }

  /** Each verified token is written with the issuers it was verified under, so a restart re-checks only those that moved. */
  private persist(): Promise<void> {
    const verified: RememberedEntry[] = [];
    for (const [tokenId, judgement] of this.judged) {
      if (judgement.verdict === 'verified') verified.push([tokenId, [...judgement.issuers]]);
    }
    const remembered: Remembered = { fingerprint: this.deps.claims.fingerprint(), verified };
    return this.writes.enqueue(() => this.deps.kv.set(STORE_KEYS.verifiedTokens, remembered));
  }

  private async load(): Promise<void> {
    const remembered = await this.deps.kv.get<Remembered>(STORE_KEYS.verifiedTokens);
    if (remembered === null || remembered.fingerprint !== this.deps.claims.fingerprint()) return;
    for (const [tokenId, issuers] of rememberedEntries(remembered)) {
      this.judged.set(tokenId, { verdict: 'verified', issuers: new Map(issuers) });
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
