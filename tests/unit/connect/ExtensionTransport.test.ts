/**
 * Unit tests for ExtensionTransport (both client and host sides).
 *
 * Host transport is tested by injecting a mock ChromeMessagingApi.
 * Client transport is tested by stubbing window with a manual mock (no jsdom needed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ExtensionTransport,
  EXT_MSG_TO_HOST,
  EXT_MSG_TO_CLIENT,
  isExtensionConnectEnvelope,
} from '../../../impl/browser/connect/ExtensionTransport';
import type { ChromeMessagingApi } from '../../../impl/browser/connect/ExtensionTransport';
import type { SphereConnectMessage } from '../../../connect';

// =============================================================================
// Helpers
// =============================================================================

/** Minimal valid SphereConnectMessage — must satisfy isSphereConnectMessage (ns + v) */
function makeMsg(id = 'test-1'): SphereConnectMessage {
  return {
    ns: 'sphere-connect',
    v: '1.0',
    type: 'rpc',
    id,
    method: 'sphere_getBalance',
    params: {},
  } as unknown as SphereConnectMessage;
}

/** Build a mock ChromeMessagingApi with spy capture of calls */
function makeChromeApi() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: Array<(msg: unknown, sender: any, sendResponse: (r?: unknown) => void) => void> = [];
  const sentMessages: Array<{ tabId: number; message: unknown }> = [];

  const api: ChromeMessagingApi = {
    onMessage: {
      addListener: vi.fn((fn) => { listeners.push(fn); }),
      removeListener: vi.fn((fn) => {
        const idx = listeners.indexOf(fn);
        if (idx !== -1) listeners.splice(idx, 1);
      }),
    },
    tabs: {
      sendMessage: vi.fn((tabId, message) => { sentMessages.push({ tabId, message }); }),
    },
  };

  /** Fire a fake chrome.runtime message to all registered listeners */
  function simulateIncoming(message: unknown, sender: { tab?: { id?: number } } = {}) {
    for (const fn of [...listeners]) {
      fn(message, sender, vi.fn());
    }
  }

  return { api, listeners, sentMessages, simulateIncoming };
}

// =============================================================================
// isExtensionConnectEnvelope
// =============================================================================

describe('isExtensionConnectEnvelope', () => {
  it('returns true for a valid tohost envelope', () => {
    expect(isExtensionConnectEnvelope({ type: EXT_MSG_TO_HOST, payload: makeMsg() })).toBe(true);
  });

  it('returns true for a valid toclient envelope', () => {
    expect(isExtensionConnectEnvelope({ type: EXT_MSG_TO_CLIENT, payload: makeMsg() })).toBe(true);
  });

  it('returns false for an unknown type', () => {
    expect(isExtensionConnectEnvelope({ type: 'other', payload: makeMsg() })).toBe(false);
  });

  it('returns false when payload is not a SphereConnectMessage', () => {
    expect(isExtensionConnectEnvelope({ type: EXT_MSG_TO_HOST, payload: { foo: 'bar' } })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isExtensionConnectEnvelope(null)).toBe(false);
  });

  it('returns false for a primitive value', () => {
    expect(isExtensionConnectEnvelope('hello')).toBe(false);
  });
});

// =============================================================================
// ExtensionTransport.forHost
// =============================================================================

describe('ExtensionTransport.forHost', () => {
  it('registers a listener on construction', () => {
    const { api } = makeChromeApi();
    const transport = ExtensionTransport.forHost(api);
    expect(api.onMessage.addListener).toHaveBeenCalledTimes(1);
    transport.destroy();
  });

  it('removes the listener on destroy', () => {
    const { api } = makeChromeApi();
    const transport = ExtensionTransport.forHost(api);
    transport.destroy();
    expect(api.onMessage.removeListener).toHaveBeenCalledTimes(1);
  });

  it('ignores non-connect messages', () => {
    const { api, simulateIncoming } = makeChromeApi();
    const transport = ExtensionTransport.forHost(api);
    const handler = vi.fn();
    transport.onMessage(handler);

    simulateIncoming({ type: 'unrelated', data: 123 });
    expect(handler).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('ignores toclient envelopes (wrong direction)', () => {
    const { api, simulateIncoming } = makeChromeApi();
    const transport = ExtensionTransport.forHost(api);
    const handler = vi.fn();
    transport.onMessage(handler);

    simulateIncoming({ type: EXT_MSG_TO_CLIENT, payload: makeMsg() });
    expect(handler).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('calls handler with payload when a valid tohost message arrives', () => {
    const { api, simulateIncoming } = makeChromeApi();
    const transport = ExtensionTransport.forHost(api);
    const handler = vi.fn();
    transport.onMessage(handler);

    const msg = makeMsg('req-42');
    simulateIncoming({ type: EXT_MSG_TO_HOST, payload: msg }, { tab: { id: 7 } });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(msg);
    transport.destroy();
  });

  it('routes responses to the sender tab', () => {
    const { api, simulateIncoming, sentMessages } = makeChromeApi();
    const transport = ExtensionTransport.forHost(api);
    transport.onMessage(() => {});

    // Establish tab 42 as the active dApp tab
    simulateIncoming({ type: EXT_MSG_TO_HOST, payload: makeMsg() }, { tab: { id: 42 } });

    const reply = makeMsg('reply-1');
    transport.send(reply);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].tabId).toBe(42);
    expect(sentMessages[0].message).toEqual({ type: EXT_MSG_TO_CLIENT, payload: reply });
    transport.destroy();
  });

  it('does not send before any tab is known', () => {
    const { api, sentMessages } = makeChromeApi();
    const transport = ExtensionTransport.forHost(api);

    transport.send(makeMsg());
    expect(sentMessages).toHaveLength(0);
    transport.destroy();
  });

  it('onMessage returns an unsubscribe function', () => {
    const { api, simulateIncoming } = makeChromeApi();
    const transport = ExtensionTransport.forHost(api);
    const handler = vi.fn();
    const unsub = transport.onMessage(handler);

    unsub();
    simulateIncoming({ type: EXT_MSG_TO_HOST, payload: makeMsg() }, { tab: { id: 1 } });

    expect(handler).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('send is a no-op after destroy', () => {
    const { api, simulateIncoming, sentMessages } = makeChromeApi();
    const transport = ExtensionTransport.forHost(api);
    transport.onMessage(() => {});

    // Establish tab
    simulateIncoming({ type: EXT_MSG_TO_HOST, payload: makeMsg() }, { tab: { id: 5 } });

    transport.destroy();
    transport.send(makeMsg('after-destroy'));

    // destroy() clears activeTabId so send() is a no-op
    expect(sentMessages).toHaveLength(0);
  });
});

// =============================================================================
// ExtensionTransport.forClient
// =============================================================================

describe('ExtensionTransport.forClient', () => {
  // Manual window mock — avoids needing jsdom/happy-dom
  let messageListeners: Array<(ev: { data: unknown }) => void>;
  let postedMessages: unknown[];

  beforeEach(() => {
    messageListeners = [];
    postedMessages = [];

    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, fn: (ev: { data: unknown }) => void) => {
        if (type === 'message') messageListeners.push(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: (ev: { data: unknown }) => void) => {
        const idx = messageListeners.indexOf(fn);
        if (idx !== -1) messageListeners.splice(idx, 1);
      }),
      postMessage: vi.fn((msg: unknown) => {
        postedMessages.push(msg);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Deliver a fake message to all client listeners */
  function simulateWindowMessage(data: unknown) {
    for (const fn of [...messageListeners]) {
      fn({ data });
    }
  }

  it('registers a window message listener on construction', () => {
    const transport = ExtensionTransport.forClient();
    expect(window.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    transport.destroy();
  });

  it('removes the window message listener on destroy', () => {
    const transport = ExtensionTransport.forClient();
    transport.destroy();
    expect(window.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('sends a tohost envelope via window.postMessage', () => {
    const transport = ExtensionTransport.forClient();
    const msg = makeMsg('client-send-1');
    transport.send(msg);

    expect(window.postMessage).toHaveBeenCalledWith(
      { type: EXT_MSG_TO_HOST, payload: msg },
      '*',
    );
    transport.destroy();
  });

  it('calls handlers when a toclient message arrives on window', () => {
    const transport = ExtensionTransport.forClient();
    const handler = vi.fn();
    transport.onMessage(handler);

    const msg = makeMsg('incoming-1');
    simulateWindowMessage({ type: EXT_MSG_TO_CLIENT, payload: msg });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(msg);
    transport.destroy();
  });

  it('ignores tohost messages (wrong direction)', () => {
    const transport = ExtensionTransport.forClient();
    const handler = vi.fn();
    transport.onMessage(handler);

    simulateWindowMessage({ type: EXT_MSG_TO_HOST, payload: makeMsg() });
    expect(handler).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('ignores non-connect messages', () => {
    const transport = ExtensionTransport.forClient();
    const handler = vi.fn();
    transport.onMessage(handler);

    simulateWindowMessage({ type: 'unrelated', foo: 'bar' });
    expect(handler).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('onMessage returns an unsubscribe function', () => {
    const transport = ExtensionTransport.forClient();
    const handler = vi.fn();
    const unsub = transport.onMessage(handler);

    unsub();
    simulateWindowMessage({ type: EXT_MSG_TO_CLIENT, payload: makeMsg() });

    expect(handler).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('stops receiving messages after destroy', () => {
    const transport = ExtensionTransport.forClient();
    const handler = vi.fn();
    transport.onMessage(handler);

    transport.destroy();
    simulateWindowMessage({ type: EXT_MSG_TO_CLIENT, payload: makeMsg() });

    expect(handler).not.toHaveBeenCalled();
  });

  it('multiple handlers all receive the same message', () => {
    const transport = ExtensionTransport.forClient();
    const h1 = vi.fn();
    const h2 = vi.fn();
    transport.onMessage(h1);
    transport.onMessage(h2);

    const msg = makeMsg('multi');
    simulateWindowMessage({ type: EXT_MSG_TO_CLIENT, payload: msg });

    expect(h1).toHaveBeenCalledWith(msg);
    expect(h2).toHaveBeenCalledWith(msg);
    transport.destroy();
  });
});
