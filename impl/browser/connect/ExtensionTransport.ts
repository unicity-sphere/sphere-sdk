/**
 * ExtensionTransport — Chrome Extension transport for Sphere Connect.
 *
 * Two modes:
 * - forClient(): dApp page sends messages via window.postMessage with namespace
 *   'sphere-connect-ext:tohost'. Content script relays to background via
 *   chrome.runtime.sendMessage. Responses arrive via 'sphere-connect-ext:toclient'.
 *
 * - forHost(): Extension background listens via chrome.runtime.onMessage for
 *   'sphere-connect-ext:tohost' messages and sends responses back via
 *   chrome.tabs.sendMessage to the originating tab.
 */

import type { ConnectTransport, SphereConnectMessage } from '../../../connect';
import { isSphereConnectMessage } from '../../../connect';

// =============================================================================
// Message namespaces
// =============================================================================

export const EXT_MSG_TO_HOST = 'sphere-connect-ext:tohost';
export const EXT_MSG_TO_CLIENT = 'sphere-connect-ext:toclient';

/** Shape of the wrapper sent via postMessage / chrome.runtime.sendMessage */
export interface ExtensionConnectEnvelope {
  type: typeof EXT_MSG_TO_HOST | typeof EXT_MSG_TO_CLIENT;
  payload: SphereConnectMessage;
}

export function isExtensionConnectEnvelope(data: unknown): data is ExtensionConnectEnvelope {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    ((data as ExtensionConnectEnvelope).type === EXT_MSG_TO_HOST ||
      (data as ExtensionConnectEnvelope).type === EXT_MSG_TO_CLIENT) &&
    'payload' in data &&
    isSphereConnectMessage((data as ExtensionConnectEnvelope).payload)
  );
}

// =============================================================================
// Client-side transport (runs in dApp page, injected script context)
// =============================================================================

class ExtensionClientTransport implements ConnectTransport {
  private handlers: Set<(message: SphereConnectMessage) => void> = new Set();
  private listener: ((event: MessageEvent) => void) | null = null;

  constructor() {
    // Listen for responses relayed back from content script
    this.listener = (event: MessageEvent) => {
      if (!isExtensionConnectEnvelope(event.data)) return;
      if (event.data.type !== EXT_MSG_TO_CLIENT) return;

      for (const handler of this.handlers) {
        try {
          handler(event.data.payload);
        } catch {
          // Ignore handler errors
        }
      }
    };

    window.addEventListener('message', this.listener);
  }

  send(message: SphereConnectMessage): void {
    // Post to window — content script will pick this up and forward to background
    const envelope: ExtensionConnectEnvelope = {
      type: EXT_MSG_TO_HOST,
      payload: message,
    };
    window.postMessage(envelope, '*');
  }

  onMessage(handler: (message: SphereConnectMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  destroy(): void {
    if (this.listener) {
      window.removeEventListener('message', this.listener);
      this.listener = null;
    }
    this.handlers.clear();
  }
}

// =============================================================================
// Host-side transport (runs in extension background service worker)
// =============================================================================

/**
 * Chrome extension API subset used by ExtensionHostTransport.
 * Allows injecting a mock in tests without depending on chrome globals.
 */
export interface ChromeMessagingApi {
  onMessage: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addListener(listener: (message: unknown, sender: any, sendResponse: (r?: unknown) => void) => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeListener(listener: (message: unknown, sender: any, sendResponse: (r?: unknown) => void) => void): void;
  };
  tabs: {
    sendMessage(tabId: number, message: unknown): void;
  };
}

class ExtensionHostTransport implements ConnectTransport {
  private handlers: Set<(message: SphereConnectMessage) => void> = new Set();
  // tabId of the currently connected dApp tab (used to send responses back)
  private activeTabId: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private chromeListener: ((message: unknown, sender: any, sendResponse: (r?: unknown) => void) => void) | null = null;
  private readonly chromeApi: ChromeMessagingApi;

  constructor(chromeApi: ChromeMessagingApi) {
    this.chromeApi = chromeApi;

    this.chromeListener = (message: unknown, sender: { tab?: { id?: number } }) => {
      if (!isExtensionConnectEnvelope(message)) return;
      if ((message as ExtensionConnectEnvelope).type !== EXT_MSG_TO_HOST) return;

      // Track which tab is talking to us
      if (sender.tab?.id !== undefined) {
        this.activeTabId = sender.tab.id;
      }

      const payload = (message as ExtensionConnectEnvelope).payload;
      for (const handler of this.handlers) {
        try {
          handler(payload);
        } catch {
          // Ignore handler errors
        }
      }
    };

    this.chromeApi.onMessage.addListener(this.chromeListener);
  }

  send(message: SphereConnectMessage): void {
    if (this.activeTabId === null) return;

    const envelope: ExtensionConnectEnvelope = {
      type: EXT_MSG_TO_CLIENT,
      payload: message,
    };

    try {
      this.chromeApi.tabs.sendMessage(this.activeTabId, envelope);
    } catch {
      // Tab may have been closed
    }
  }

  onMessage(handler: (message: SphereConnectMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  destroy(): void {
    if (this.chromeListener) {
      this.chromeApi.onMessage.removeListener(this.chromeListener);
      this.chromeListener = null;
    }
    this.handlers.clear();
    this.activeTabId = null;
  }
}

// =============================================================================
// Public API
// =============================================================================

export const ExtensionTransport = {
  /**
   * Create transport for the CLIENT side (dApp page / inject script).
   * Sends via window.postMessage; receives via window.postMessage from content script.
   */
  forClient(): ConnectTransport {
    return new ExtensionClientTransport();
  },

  /**
   * Create transport for the HOST side (extension background service worker).
   * Receives via chrome.runtime.onMessage; sends via chrome.tabs.sendMessage.
   *
   * @param chromeApi - Pass `chrome` from the extension background context,
   *   or a mock for unit tests.
   */
  forHost(chromeApi: ChromeMessagingApi): ConnectTransport {
    return new ExtensionHostTransport(chromeApi);
  },
};
