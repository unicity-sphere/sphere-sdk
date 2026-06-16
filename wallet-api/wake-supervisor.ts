/**
 * Wake-socket reconnect supervisor (§9) — makes the single multiplexed wake
 * socket self-heal.
 *
 * The wake socket is a best-effort NUDGE; correctness is the pull. But a
 * SILENTLY dead socket starves every realtime consumer until a reload: the
 * server `terminate()`s on a missed heartbeat, hard-closes at access-token
 * expiry (code 4401), and proxies/idle/network/tab-suspend drop it — none of
 * which the bare `connectWakeSocket` observed once it nulled `onclose`/`onerror`
 * after open.
 *
 * This supervisor keeps `onclose`/`onerror` live and:
 *  - reconnects on any drop with bounded exponential backoff + full jitter,
 *    re-minting a fresh ticket each attempt (and refreshing the JWT on a 4401 /
 *    auth-expiry close) — never giving up while the session is valid;
 *  - runs a client-side liveness watchdog: any inbound signal (message, server
 *    ping, or pong) is a sign of life; `2×` the server heartbeat of silence
 *    means a half-open socket → force-close and reconnect;
 *  - runs a full catch-up pull of ALL streams on every (re)connect (`onReconnect`)
 *    — wakes missed during the dead window are gone (best-effort pub/sub), so
 *    the client MUST full-resync to converge;
 *  - distinguishes an intentional close (`destroy`/logout) from a drop so a
 *    deliberate 4401 logout-close never spawns an infinite reconnect loop.
 *
 * Lives at the client layer because reconnecting re-mints a ws-ticket and may
 * refresh the JWT — both client-private. The socket OWNER (the MailboxProvider)
 * just supplies the catch-up/wake/status callbacks.
 */
import { WalletApiError } from './errors';
import { parseWakeFrame } from './codec';
import type {
  SuperviseWakeOptions,
  WakeSocketStatus,
  WebSocketLike,
} from './types';

/** App-defined WS close code: authentication gone — reconnect needs a fresh ticket + token (server `CLOSE_AUTH_GONE`, §9). */
export const CLOSE_AUTH_GONE = 4401;

export interface WakeSupervisorTiming {
  /** First reconnect delay; doubles each attempt up to {@link backoffCapMs}. */
  readonly backoffBaseMs: number;
  /** Backoff ceiling — the delay never exceeds this (before jitter). */
  readonly backoffCapMs: number;
  /**
   * Server heartbeat interval (§9 — 30 s). The liveness watchdog fires after
   * `2×` this of total silence (one whole missed ping/pong cycle + margin).
   */
  readonly heartbeatMs: number;
}

export const DEFAULT_WAKE_TIMING: WakeSupervisorTiming = {
  backoffBaseMs: 500,
  backoffCapMs: 30_000,
  heartbeatMs: 30_000,
};

/** Injectable seams so tests drive time/randomness deterministically. */
export interface WakeSupervisorEnv {
  /** Re-mint a ticket and open ONE socket (no auto-reconnect). */
  readonly openSocket: () => Promise<WebSocketLike>;
  /** On a 4401/auth-gone close, drop the cached JWT so the next ticket mint re-auths. */
  readonly onAuthGone: () => void;
  readonly setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  /** [0,1) — defaults to Math.random; injected for deterministic jitter in tests. */
  readonly random: () => number;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Owns the lifecycle of ONE logical wake channel across reconnects. Construct,
 * call {@link start}, and {@link close} to tear down (idempotent).
 */
export class WakeSocketSupervisor {
  private status: WakeSocketStatus = 'connecting';
  private socket: WebSocketLike | null = null;
  private reconnectTimer: Timer | null = null;
  private watchdogTimer: Timer | null = null;
  private attempt = 0;
  private stopped = false;
  /** A reconnect cycle is already scheduled/in-flight — coalesce concurrent drop signals. */
  private reconnecting = false;

  constructor(
    private readonly opts: SuperviseWakeOptions,
    private readonly env: WakeSupervisorEnv,
    private readonly timing: WakeSupervisorTiming = DEFAULT_WAKE_TIMING
  ) {}

  get currentStatus(): WakeSocketStatus {
    return this.status;
  }

  /** Open the first socket; subsequent drops self-heal until {@link close}. */
  start(): void {
    void this.connect();
  }

  /** Idempotent teardown — no leaked timers or sockets, and no further reconnects. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnect();
    this.clearWatchdog();
    this.detachAndClose(this.socket);
    this.socket = null;
    this.setStatus('closed');
  }

  // ── connect / drop ──────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.clearReconnect();
    try {
      const ws = await this.env.openSocket();
      if (this.stopped) {
        this.detachAndClose(ws);
        return;
      }
      this.adopt(ws);
    } catch (err) {
      if (this.stopped) return;
      // A failed mint/open is just another drop — back off and retry. A 401 in
      // the mint path already triggers the client's silent re-auth, so an
      // auth-expired ticket heals here too.
      this.onDrop(err instanceof WalletApiError && err.status === 401);
    }
  }

  /** Wire a freshly opened socket: keep onclose/onerror LIVE, arm the watchdog, run catch-up. */
  private adopt(ws: WebSocketLike): void {
    this.socket = ws;
    this.attempt = 0;
    this.reconnecting = false;
    ws.onmessage = (ev): void => this.onFrame(ev);
    ws.onerror = (): void => this.onDrop(false);
    ws.onclose = (ev): void => this.onClose(ev);
    // Ping/pong (when the transport surfaces them) are pure liveness signals.
    if ('onPing' in ws) ws.onPing = (): void => this.touch();
    if ('onPong' in ws) ws.onPong = (): void => this.touch();
    this.armWatchdog();
    this.setStatus('connected');
    // §9: wakes missed while dark are NOT replayed — full-resync every stream.
    this.opts.onReconnect?.();
  }

  private onFrame(ev: { data: unknown }): void {
    this.touch(); // any frame proves the socket is alive
    const frame = parseWakeFrame(typeof ev.data === 'string' ? ev.data : String(ev.data));
    if (frame) this.opts.onWake(frame);
  }

  private onClose(ev?: { code?: number }): void {
    this.onDrop(ev?.code === CLOSE_AUTH_GONE);
  }

  /** A drop from any cause: schedule a backed-off reconnect (unless intentionally stopped). */
  private onDrop(authGone: boolean): void {
    if (this.stopped) return;
    if (authGone) this.env.onAuthGone(); // force a token refresh on the next mint
    if (this.reconnecting) return; // a reconnect is already queued — don't pile up
    this.reconnecting = true;
    this.clearWatchdog();
    this.detachAndClose(this.socket);
    this.socket = null;
    this.setStatus('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = this.backoffDelay(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = this.env.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** Exponential `base·2^n` capped at `cap`, then full jitter in `[0, capped]` (thundering-herd guard). */
  private backoffDelay(attempt: number): number {
    const capped = Math.min(this.timing.backoffCapMs, this.timing.backoffBaseMs * 2 ** attempt);
    return Math.floor(this.env.random() * capped);
  }

  // ── liveness watchdog ────────────────────────────────────────────────────────

  /** Mark the socket alive — re-arm the silence watchdog. */
  private touch(): void {
    if (this.stopped || !this.socket) return;
    this.armWatchdog();
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = this.env.setTimeout(() => {
      this.watchdogTimer = null;
      // Silence for a whole heartbeat cycle ⇒ half-open. Force a reconnect.
      this.onDrop(false);
    }, this.timing.heartbeatMs * 2);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      this.env.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.env.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Detach our handlers (so a late close from THIS socket can't re-trigger) then close it. */
  private detachAndClose(ws: WebSocketLike | null): void {
    if (!ws) return;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if ('onPing' in ws) ws.onPing = null;
    if ('onPong' in ws) ws.onPong = null;
    try {
      ws.close();
    } catch {
      // already closing/closed — nothing to do
    }
  }

  private setStatus(status: WakeSocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }
}
