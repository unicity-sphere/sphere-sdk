// §5.1 WalletApiSession: auth generation-cell, single-flight refresh,
// challenge-template verification, wake-socket supervisor, epoch latch.

import { STORE_KEYS, type ScopedKV } from '../../modules/payments-v2/stores';
import { verifyChallengeTemplate } from '../../core/wallet-api-protocol';
import { WalletApiHttpError } from './http';
import type { AuthTokensWire, WalletApiV2Client } from './client';

// The spend key never signs unverified server text (S1/§4) — the canonical
// verifier is the ONE source; re-exported so existing importers keep working.
export {
  AUTH_CHALLENGE_PREFIX,
  ChallengeTemplateError,
  verifyChallengeTemplate,
  type ChallengeExpectation,
} from '../../core/wallet-api-protocol';

/**
 * The JWT generation cell (#692 F8/F14). Every write is a compare-and-swap on
 * a generation captured at operation start — the CAS lives INSIDE the setter,
 * so a continuation returning from an await can never clobber a newer session.
 */
export class JwtGenerationCell {
  private gen = 0;
  private jwt: string | null = null;

  get generation(): number {
    return this.gen;
  }

  token(): string | null {
    return this.jwt;
  }

  install(generation: number, jwt: string): boolean {
    if (generation !== this.gen) return false;
    this.jwt = jwt;
    return true;
  }

  /** authGone(G) is a no-op when the cell moved to G+1 (F14). */
  clearIfCurrent(generation: number): boolean {
    if (generation !== this.gen || this.jwt === null) return false;
    this.jwt = null;
    return true;
  }

  dropIfMatches(generation: number, jwt: string): void {
    if (generation === this.gen && this.jwt === jwt) this.jwt = null;
  }

  bump(): number {
    this.gen += 1;
    this.jwt = null;
    return this.gen;
  }
}

export type WakeStream = 'inventory' | 'mailbox' | 'payment_requests';
export const WAKE_STREAMS: readonly WakeStream[] = ['inventory', 'mailbox', 'payment_requests'];

export type ConnectionStatus = 'connected' | 'degraded' | 'offline';

export interface SessionSigner {
  readonly pubkey: string;
  readonly network: string;
  sign(message: string): string | Promise<string>;
}

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface SessionTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SessionTiming {
  pullIntervalMs: number;
  reconnectBaseMs: number;
  reconnectCapMs: number;
  heartbeatTimeoutMs: number;
  offlineAfterFailures: number;
}

export const DEFAULT_SESSION_TIMING: SessionTiming = {
  pullIntervalMs: 30_000,
  reconnectBaseMs: 1_000,
  reconnectCapMs: 30_000,
  heartbeatTimeoutMs: 120_000,
  offlineAfterFailures: 3,
};

export interface WalletApiSessionDeps {
  client: WalletApiV2Client;
  cell: JwtGenerationCell;
  signer: SessionSigner;
  deviceId: string;
  kv: ScopedKV;
  webSocketFactory: WebSocketFactory;
  emitStatus: (status: ConnectionStatus) => void;
  /** Runs the syncEpoch re-seed protocol BEFORE any stream resumes. */
  onEpochChange: (epoch: string) => Promise<void>;
  timing?: Partial<SessionTiming>;
  timers?: SessionTimers;
  random?: () => number;
}

export function refreshTokenKey(deviceId: string): string {
  return `auth:refresh:${deviceId}`;
}

const WS_CLOSE_AUTH_GONE = 4401;

interface WakeFrame {
  stream: WakeStream;
  syncEpoch: string;
}

function parseWakeFrame(data: unknown): WakeFrame | null {
  if (typeof data !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const frame = json as { type?: unknown; stream?: unknown; syncEpoch?: unknown };
  if (frame.type !== 'wake') return null;
  if (!WAKE_STREAMS.includes(frame.stream as WakeStream)) return null;
  if (typeof frame.syncEpoch !== 'number' && typeof frame.syncEpoch !== 'string') return null;
  return { stream: frame.stream as WakeStream, syncEpoch: String(frame.syncEpoch) };
}

const GLOBAL_TIMERS: SessionTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as Parameters<typeof clearInterval>[0]),
};

export class WalletApiSession {
  private readonly timing: SessionTiming;
  private readonly timers: SessionTimers;
  private readonly random: () => number;
  private readonly refreshKey: string;

  private authFlight: Promise<void> | null = null;

  private epochLatch: string | null = null;
  private reseedChain: Promise<void> = Promise.resolve();
  private reseedsPending = 0;

  private readonly handlers = new Map<WakeStream, Set<() => void>>();
  private readonly statusHandlers = new Set<(status: ConnectionStatus) => void>();
  private socket: WebSocketLike | null = null;
  private started = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private pullTimers: unknown[] = [];
  private lastStatus: ConnectionStatus | null = null;

  constructor(private readonly deps: WalletApiSessionDeps) {
    this.timing = { ...DEFAULT_SESSION_TIMING, ...deps.timing };
    this.timers = deps.timers ?? GLOBAL_TIMERS;
    this.random = deps.random ?? Math.random;
    this.refreshKey = refreshTokenKey(deps.deviceId);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.epochLatch = await this.deps.kv.get<string>(STORE_KEYS.epochLatch);
    this.startPullTimers();
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.pullTimers) this.timers.clearInterval(t);
    this.pullTimers = [];
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    const ws = this.socket;
    this.socket = null;
    ws?.close();
    await this.reseedChain;
  }

  // ── auth cell (F8/F14) ────────────────────────────────────────────────────

  token(): string | null {
    return this.deps.cell.token();
  }

  /** Identity switch / lock / logout: supersede every in-flight auth continuation. */
  invalidate(): void {
    this.deps.cell.bump();
    this.authFlight = null;
  }

  async ensureAuthenticated(): Promise<string> {
    const existing = this.deps.cell.token();
    if (existing !== null) return existing;
    await this.runAuthSingleFlight();
    const fresh = this.deps.cell.token();
    if (fresh === null) {
      throw new WalletApiHttpError(401, 'AUTH_SUPERSEDED', 'authentication superseded before completion');
    }
    return fresh;
  }

  /** Run an authenticated op; one 401 → single-flight re-auth → one retry. */
  async withAuth<T>(op: (jwt: string) => Promise<T>): Promise<T> {
    const jwt = await this.ensureAuthenticated();
    const generation = this.deps.cell.generation;
    try {
      return await op(jwt);
    } catch (err) {
      if (!(err instanceof WalletApiHttpError && err.status === 401)) throw err;
      this.deps.cell.dropIfMatches(generation, jwt);
      return op(await this.ensureAuthenticated());
    }
  }

  private runAuthSingleFlight(): Promise<void> {
    if (this.authFlight !== null) return this.authFlight;
    const generation = this.deps.cell.generation;
    const flight = this.authenticate(generation).finally(() => {
      if (this.authFlight === flight) this.authFlight = null;
    });
    this.authFlight = flight;
    return flight;
  }

  private async authenticate(generation: number): Promise<void> {
    if (await this.tryRefresh(generation)) return;
    if (this.deps.cell.generation !== generation) return;
    await this.challengeSignIn(generation);
  }

  private async tryRefresh(generation: number): Promise<boolean> {
    const stored = await this.deps.kv.get<string>(this.refreshKey);
    if (stored === null) return false;
    let tokens: AuthTokensWire;
    try {
      tokens = await this.deps.client.authRefresh(stored);
    } catch (err) {
      if (err instanceof WalletApiHttpError && err.status >= 400 && err.status < 500) {
        if (this.deps.cell.generation === generation) await this.deps.kv.remove(this.refreshKey);
        return false;
      }
      throw err;
    }
    if (!this.deps.cell.install(generation, tokens.jwt)) return true;
    await this.deps.kv.set(this.refreshKey, tokens.refreshToken);
    return true;
  }

  private async challengeSignIn(generation: number): Promise<void> {
    const { pubkey, network } = this.deps.signer;
    const { nonce, challenge } = await this.deps.client.authChallenge(pubkey);
    verifyChallengeTemplate(challenge, { pubkey, nonce, network });
    const signature = await this.deps.signer.sign(challenge);
    const tokens = await this.deps.client.authVerify({ nonce, signature, deviceId: this.deps.deviceId });
    if (!this.deps.cell.install(generation, tokens.jwt)) return;
    await this.deps.kv.set(this.refreshKey, tokens.refreshToken);
  }

  // ── epoch latch (F12) ─────────────────────────────────────────────────────

  noteEpoch(epoch: string): void {
    if (this.epochLatch === epoch) return;
    const previous = this.epochLatch;
    this.epochLatch = epoch;
    if (previous === null) {
      void this.deps.kv.set(STORE_KEYS.epochLatch, epoch).catch(() => undefined);
      return;
    }
    this.reseedsPending += 1;
    this.reseedChain = this.reseedChain.then(() => this.runReseed(epoch, previous));
  }

  private async runReseed(epoch: string, previous: string): Promise<void> {
    try {
      await this.deps.onEpochChange(epoch);
      await this.deps.kv.set(STORE_KEYS.epochLatch, epoch);
    } catch {
      if (this.epochLatch === epoch) this.epochLatch = previous;
    } finally {
      this.reseedsPending -= 1;
      if (this.reseedsPending === 0) this.nudgeAllStreams();
    }
  }

  // ── streams ───────────────────────────────────────────────────────────────

  subscribeStream(stream: WakeStream, handler: () => void): () => void {
    let set = this.handlers.get(stream);
    if (!set) {
      set = new Set();
      this.handlers.set(stream, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  private dispatch(stream: WakeStream): void {
    if (this.reseedsPending > 0) return;
    const set = this.handlers.get(stream);
    if (!set) return;
    for (const handler of set) handler();
  }

  private nudgeAllStreams(): void {
    for (const stream of WAKE_STREAMS) this.dispatch(stream);
  }

  private startPullTimers(): void {
    for (const stream of WAKE_STREAMS) {
      this.pullTimers.push(this.timers.setInterval(() => this.dispatch(stream), this.timing.pullIntervalMs));
    }
  }

  // ── wake socket ───────────────────────────────────────────────────────────

  status(): ConnectionStatus {
    return this.lastStatus ?? 'offline';
  }

  /** Transition feed off the existing emitStatus point (FacadeSession.subscribeStatus). */
  subscribeStatus(handler: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(status: ConnectionStatus): void {
    if (this.stopped || this.lastStatus === status) return;
    this.lastStatus = status;
    this.deps.emitStatus(status);
    for (const handler of this.statusHandlers) handler(status);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const ticket = await this.withAuth(() => this.deps.client.wsTicket());
      if (this.stopped) return;
      this.openSocket(ticket, this.deps.cell.generation);
    } catch {
      this.scheduleReconnect();
    }
  }

  private openSocket(ticket: string, generation: number): void {
    const wsBase = this.deps.client.baseUrl.replace(/^http/, 'ws');
    const ws = this.deps.webSocketFactory(`${wsBase}/v1/ws?ticket=${encodeURIComponent(ticket)}`);
    this.socket = ws;
    ws.onopen = () => this.handleOpen(ws);
    ws.onmessage = (ev) => this.handleMessage(ws, ev.data);
    ws.onclose = (ev) => this.handleClose(ws, generation, ev?.code);
    ws.onerror = () => undefined;
  }

  private handleOpen(ws: WebSocketLike): void {
    if (ws !== this.socket) return;
    this.reconnectAttempts = 0;
    this.emitStatus('connected');
    this.armHeartbeat(ws);
    // Wakes before this instant are lost — one synthetic nudge per stream.
    this.nudgeAllStreams();
  }

  private handleMessage(ws: WebSocketLike, data: unknown): void {
    if (ws !== this.socket) return;
    this.armHeartbeat(ws);
    const frame = parseWakeFrame(data);
    if (frame === null) return;
    this.noteEpoch(frame.syncEpoch);
    this.dispatch(frame.stream);
  }

  private handleClose(ws: WebSocketLike, generation: number, code?: number): void {
    if (ws !== this.socket) return;
    this.socket = null;
    this.clearHeartbeat();
    if (this.stopped) return;
    if (code === WS_CLOSE_AUTH_GONE) {
      // CAS inside the cell: a stale socket's auth-gone never clears a newer JWT (F14).
      this.deps.cell.clearIfCurrent(generation);
      this.emitStatus('degraded');
      void this.connect();
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    this.emitStatus(this.reconnectAttempts >= this.timing.offlineAfterFailures ? 'offline' : 'degraded');
    const capped = Math.min(
      this.timing.reconnectCapMs,
      this.timing.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1)
    );
    const delay = Math.floor(this.random() * capped);
    this.reconnectTimer = this.timers.setTimeout(() => void this.connect(), delay);
  }

  private armHeartbeat(ws: WebSocketLike): void {
    this.clearHeartbeat();
    this.heartbeatTimer = this.timers.setTimeout(() => {
      if (ws === this.socket) ws.close();
    }, this.timing.heartbeatTimeoutMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.timers.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
