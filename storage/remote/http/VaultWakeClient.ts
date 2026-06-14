/**
 * VaultWakeClient — the REALTIME wake channel against the token-api change-stream
 * (server side: DESIGN §5.1 ws-ticket + §6.7 fan-out). Without it, incoming courier
 * deliveries + a peer device's vault writes are only seen on the next `load()`
 * (i.e. a page reload); with it the wallet re-pulls the moment the server wakes it.
 *
 * Protocol (server `routes/ws.ts` + `change-stream.plugin.ts`):
 *  1. `POST /v1/ws/ticket` (Bearer JWT, via the shared {@link VaultTokenSource}) →
 *     `{ ticket }` — single-use, 30s, bound to ownerId.
 *  2. `GET  /v1/ws?ticket=…` (WS upgrade) → the socket is registered; the server
 *     fans a PAYLOAD-FREE `{ type:'wake', epoch }` frame to it on any insert/update
 *     of `deliveries` (recipientId) or `vault_tokens` (ownerId).
 *  3. Every frame → `onWake()` (the wallet re-pulls; the frame carries no data, so a
 *     spurious wake is just a harmless re-pull).
 *
 * Resilience: capped exponential reconnect on close/error; a jittered 4–6 min
 * backstop poll fires `onWake()` even with no frames, covering a missed wake when the
 * server's change-stream resume point fell out of the oplog (DESIGN §6.7).
 */

import { authedJson } from './http-core';
import type { FetchLike, VaultTokenSource } from './http-core';

/** Minimal structural WebSocket surface this client uses (browser + Node 22 global). */
interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((ev: unknown) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}
type WsCtor = new (url: string) => WsLike;

export interface VaultWakeClientConfig {
  /** Vault/courier base URL — `NETWORKS[network].vaultUrl`. */
  vaultUrl: string;
  /** Shared JWT source (the vault's VaultApiClient) — used to mint the ws-ticket. */
  auth: VaultTokenSource;
  /** Called on every wake frame AND on each backstop tick. */
  onWake: () => void;
  /** Injectable fetch (defaults to global). */
  fetchImpl?: FetchLike;
  /** Injectable WebSocket ctor (defaults to `globalThis.WebSocket`; tests pass a fake). */
  webSocketImpl?: WsCtor;
}

const BACKSTOP_MIN_MS = 4 * 60_000;
const BACKSTOP_MAX_MS = 6 * 60_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class VaultWakeClient {
  private socket: WsLike | null = null;
  private stopped = false;
  private reconnectMs = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backstopTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ws: WsCtor | undefined;

  constructor(private readonly config: VaultWakeClientConfig) {
    this.ws = config.webSocketImpl ?? (globalThis as { WebSocket?: WsCtor }).WebSocket;
  }

  /** Begin the wake channel: arm the backstop poll, then connect. Idempotent-safe. */
  start(): void {
    if (this.stopped || !this.ws) return;
    this.armBackstop();
    void this.connect();
  }

  /** Tear down: stop reconnecting, clear timers, close the socket. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.backstopTimer) clearTimeout(this.backstopTimer);
    this.reconnectTimer = null;
    this.backstopTimer = null;
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
  }

  /** `http(s)://host` → `ws(s)://host/v1/ws?ticket=…`. */
  private wsUrl(ticket: string): string {
    const base = this.config.vaultUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
    return `${base}/v1/ws?ticket=${encodeURIComponent(ticket)}`;
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.ws) return;
    let ticket: string;
    try {
      const res = await authedJson<{ ticket: string }>(
        this.config.fetchImpl ?? fetch,
        this.config.vaultUrl,
        this.config.auth,
        { method: 'POST', path: '/v1/ws/ticket' },
      );
      ticket = res.ticket;
    } catch {
      this.scheduleReconnect(); // auth/network down — retry with backoff
      return;
    }
    try {
      const socket = new this.ws(this.wsUrl(ticket));
      this.socket = socket;
      socket.onopen = () => { this.reconnectMs = RECONNECT_BASE_MS; };
      socket.onmessage = () => { this.config.onWake(); };
      socket.onclose = () => { this.socket = null; this.scheduleReconnect(); };
      socket.onerror = () => { try { socket.close(); } catch { /* ignore */ } };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private armBackstop(): void {
    if (this.stopped) return;
    const jitter = BACKSTOP_MIN_MS + Math.floor(Math.random() * (BACKSTOP_MAX_MS - BACKSTOP_MIN_MS));
    this.backstopTimer = setTimeout(() => {
      this.backstopTimer = null;
      if (this.stopped) return;
      this.config.onWake(); // periodic re-pull covers a missed wake (oplog gap)
      this.armBackstop();
    }, jitter);
  }
}
