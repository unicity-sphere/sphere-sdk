/**
 * Tests for CommunicationsModule's DM middleware pipeline.
 *
 * Covers `useDmMiddleware()` — ordered, propagation-aware DM consumers
 * registered alongside (and running before) the legacy
 * `onDirectMessage()` handler set.
 *
 * Contract under test:
 *   - higher priority runs first; ties resolve by registration order
 *   - a middleware that calls `next()` lets the DM continue to downstream
 *   - a middleware that omits `next()` stops propagation
 *   - a middleware that throws stops the chain (no silent partial dispatch)
 *   - legacy `onDirectMessage` handlers run UNCONDITIONALLY after the chain
 *   - async middleware: the dispatcher awaits before invoking downstream
 *   - `unsubscribe()` removes the middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunicationsModule } from '../../../modules/communications/CommunicationsModule';
import type {
  CommunicationsModuleDependencies,
  DmMiddleware,
} from '../../../modules/communications/CommunicationsModule';
import type { TransportProvider, IncomingMessage, MessageHandler } from '../../../transport';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity } from '../../../types';

const MY_PUBKEY = '02' + 'a'.repeat(64);
const PEER_PUBKEY = 'b'.repeat(64);

function createMockTransport(onMessageImpl?: (handler: MessageHandler) => () => void): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport for testing',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('mock-event-id'),
    onMessage: vi.fn().mockImplementation(onMessageImpl ?? (() => () => {})),
    sendTokenTransfer: vi.fn().mockResolvedValue('mock-event-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
  };
}

function createMockStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
    description: 'Mock storage for testing',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, value: string) => { store.set(key, value); return Promise.resolve(); }),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockImplementation((key: string) => Promise.resolve(store.has(key))),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
  };
}

function createMockIdentity(chainPubkey = MY_PUBKEY): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    chainPubkey,
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://testaddr',
    nametag: 'testuser',
  };
}

function makeIncomingMessage(overrides?: Partial<IncomingMessage>): IncomingMessage {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2, 10),
    senderTransportPubkey: PEER_PUBKEY,
    content: 'test',
    timestamp: Date.now() + 5000, // future to skip historical filter
    encrypted: false,
    ...(overrides ?? {}),
  };
}

/**
 * Bootstrap a CommunicationsModule wired to a mock transport. Returns
 * the module + the transport's message-injection callback so each test
 * can fire DMs into the pipeline at will.
 */
function bootstrap(): {
  mod: CommunicationsModule;
  injectIncoming: (msg: IncomingMessage) => void;
} {
  let messageHandler: MessageHandler | null = null;
  const transport = createMockTransport((handler) => {
    messageHandler = handler;
    return () => {};
  });
  const mod = new CommunicationsModule();
  const deps: CommunicationsModuleDependencies = {
    identity: createMockIdentity(),
    storage: createMockStorage(),
    transport,
    emitEvent: vi.fn(),
  };
  mod.initialize(deps);
  return {
    mod,
    injectIncoming: (msg) => {
      if (!messageHandler) throw new Error('transport did not register a handler');
      messageHandler(msg);
    },
  };
}

// flush any microtasks that the dispatcher's async chain may have queued
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CommunicationsModule.useDmMiddleware — ordered DM pipeline', () => {
  let mod: CommunicationsModule;
  let injectIncoming: (msg: IncomingMessage) => void;

  beforeEach(() => {
    ({ mod, injectIncoming } = bootstrap());
  });

  // ---------------------------------------------------------------------------
  // Ordering
  // ---------------------------------------------------------------------------

  it('runs middleware in priority order (higher first), then legacy handlers', async () => {
    const log: string[] = [];

    mod.useDmMiddleware(async (_msg, next) => { log.push('mw-low'); await next(); }, 1);
    mod.useDmMiddleware(async (_msg, next) => { log.push('mw-high'); await next(); }, 100);
    mod.useDmMiddleware(async (_msg, next) => { log.push('mw-mid'); await next(); }, 50);
    mod.onDirectMessage(() => log.push('legacy'));

    injectIncoming(makeIncomingMessage());
    await flush();

    expect(log).toEqual(['mw-high', 'mw-mid', 'mw-low', 'legacy']);
  });

  it('preserves registration order within the same priority', async () => {
    const log: string[] = [];

    mod.useDmMiddleware((_m, n) => { log.push('a'); return n(); }, 10);
    mod.useDmMiddleware((_m, n) => { log.push('b'); return n(); }, 10);
    mod.useDmMiddleware((_m, n) => { log.push('c'); return n(); }, 10);

    injectIncoming(makeIncomingMessage());
    await flush();

    expect(log).toEqual(['a', 'b', 'c']);
  });

  // ---------------------------------------------------------------------------
  // Propagation control
  // ---------------------------------------------------------------------------

  it('stops the chain when middleware omits next()', async () => {
    const log: string[] = [];

    mod.useDmMiddleware(() => { log.push('first'); /* no next() */ }, 100);
    mod.useDmMiddleware((_m, n) => { log.push('second'); return n(); }, 50);

    injectIncoming(makeIncomingMessage());
    await flush();

    expect(log).toEqual(['first']);
  });

  it('legacy onDirectMessage handlers fire UNCONDITIONALLY even when middleware stops the chain', async () => {
    const log: string[] = [];
    mod.useDmMiddleware(() => { log.push('mw-stop'); /* no next() */ }, 100);
    mod.onDirectMessage(() => log.push('legacy'));

    injectIncoming(makeIncomingMessage());
    await flush();

    // Legacy handler runs regardless. Order: middleware first, legacy after.
    expect(log).toEqual(['mw-stop', 'legacy']);
  });

  it('middleware that throws stops the chain and does not advance to siblings', async () => {
    const log: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mod.useDmMiddleware(() => { log.push('first'); throw new Error('boom'); }, 100);
    mod.useDmMiddleware((_m, n) => { log.push('second'); return n(); }, 50);
    mod.onDirectMessage(() => log.push('legacy'));

    injectIncoming(makeIncomingMessage());
    await flush();

    expect(log).toEqual(['first', 'legacy']);
    errorSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Async semantics
  // ---------------------------------------------------------------------------

  it('awaits an async middleware before invoking the next one', async () => {
    const log: string[] = [];

    mod.useDmMiddleware(async (_m, n) => {
      log.push('a-start');
      await new Promise((r) => setTimeout(r, 5));
      log.push('a-end');
      await n();
    }, 100);
    mod.useDmMiddleware((_m, n) => { log.push('b'); return n(); }, 50);

    injectIncoming(makeIncomingMessage());
    // Wait long enough for the timer to fire AND the chain to drain.
    await new Promise((r) => setTimeout(r, 20));

    expect(log).toEqual(['a-start', 'a-end', 'b']);
  });

  // ---------------------------------------------------------------------------
  // Unsubscribe
  // ---------------------------------------------------------------------------

  it('unsubscribe removes the middleware from future dispatches', async () => {
    const log: string[] = [];
    const unsubscribe = mod.useDmMiddleware((_m, n) => { log.push('mw'); return n(); }, 100);

    injectIncoming(makeIncomingMessage());
    await flush();
    expect(log).toEqual(['mw']);

    unsubscribe();
    injectIncoming(makeIncomingMessage());
    await flush();

    expect(log).toEqual(['mw']); // unchanged — second dispatch did NOT call mw
  });

  it('snapshot semantics: a middleware that registers a sibling does NOT affect the in-flight dispatch', async () => {
    const log: string[] = [];

    mod.useDmMiddleware((_m, n) => {
      log.push('a');
      // Register a new mw mid-dispatch — should NOT run for this DM.
      mod.useDmMiddleware(() => { log.push('late'); }, 999);
      return n();
    }, 100);
    mod.useDmMiddleware((_m, n) => { log.push('b'); return n(); }, 50);

    injectIncoming(makeIncomingMessage());
    await flush();
    // 'late' runs only on the next dispatch, not this one.
    expect(log).toEqual(['a', 'b']);

    injectIncoming(makeIncomingMessage());
    await flush();
    // Now the late-registered mw participates in subsequent dispatches.
    expect(log).toContain('late');
  });

  // ---------------------------------------------------------------------------
  // Use-case: ACP filter pattern
  // ---------------------------------------------------------------------------

  it('use-case: high-priority filter consumes manager-addressed DMs and blocks downstream', async () => {
    const acpLog: string[] = [];
    const appLog: string[] = [];
    const MANAGER = 'm' + 'a'.repeat(63);

    // ACP filter: consume manager DMs, pass everything else.
    mod.useDmMiddleware((msg, next) => {
      if (msg.senderPubkey === MANAGER) {
        acpLog.push(msg.content);
        return; // stop — app code shouldn't see manager-addressed DMs
      }
      return next();
    }, 100);

    // App code: registered as legacy handler. Runs unconditionally.
    // Note: legacy semantics — even ACP-consumed DMs reach legacy
    // handlers. This is intentional for backward compat.
    mod.onDirectMessage((msg) => {
      appLog.push(msg.content);
    });

    injectIncoming(makeIncomingMessage({ senderTransportPubkey: MANAGER, content: 'manager-cmd', id: 'm1' }));
    injectIncoming(makeIncomingMessage({ senderTransportPubkey: PEER_PUBKEY, content: 'peer-msg', id: 'p1' }));
    await flush();

    // ACP filter saw only the manager DM.
    expect(acpLog).toEqual(['manager-cmd']);
    // Legacy handler saw both (cannot opt out of legacy broadcast).
    expect(appLog.sort()).toEqual(['manager-cmd', 'peer-msg']);
  });
});

// Dummy export to keep TS happy if `DmMiddleware` is unused above
export const _typeAssert: DmMiddleware = (_msg, next) => next();
