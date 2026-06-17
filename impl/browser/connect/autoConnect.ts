/**
 * autoConnect — Universal dApp connection to Sphere wallet.
 *
 * Auto-detects the best available transport and connects:
 *   P1: iframe   → PostMessageTransport to parent window
 *   P2: extension → ExtensionTransport via chrome extension
 *   P3: standalone → PostMessageTransport to popup window
 *
 * Usage:
 *   import { autoConnect } from '@unicitylabs/sphere-sdk/connect/browser';
 *
 *   const client = await autoConnect({
 *     dapp: { name: 'My App', url: location.origin },
 *     walletUrl: 'https://sphere.unicity.network',
 *   });
 *
 *   // Use the client — same API regardless of transport:
 *   const balance = await client.query('sphere_getBalance');
 *   await client.intent('send', { recipient: '@bob', amount: '1000', coinId: 'UCT' });
 *   client.on('transfer:incoming', (data) => console.log(data));
 */

import { ConnectClient } from '../../../connect/client/ConnectClient';
import { HOST_READY_TYPE, HOST_READY_TIMEOUT } from '../../../connect/protocol';
import type { ConnectTransport, ConnectResult, ConnectClientConfig } from '../../../connect/types';
import type { DAppMetadata, SphereConnectMessage } from '../../../connect/protocol';
import type { PermissionScope } from '../../../connect/permissions';
import { PostMessageTransport } from './PostMessageTransport';
import { ExtensionTransport } from './ExtensionTransport';

// =============================================================================
// Environment detection
// =============================================================================

/** Returns true when the page is running inside an iframe. */
export function isInIframe(): boolean {
  try {
    return window.parent !== window && window.self !== window.top;
  } catch {
    // cross-origin access throws — we're in an iframe
    return true;
  }
}

/** Returns true when the Sphere browser extension is installed and active. */
export function hasExtension(): boolean {
  try {
    const sphere = (window as unknown as Record<string, unknown>).sphere;
    if (!sphere || typeof sphere !== 'object') return false;
    const isInstalled = (sphere as Record<string, unknown>).isInstalled;
    if (typeof isInstalled !== 'function') return false;
    return (isInstalled as () => boolean)() === true;
  } catch {
    return false;
  }
}

/** Detected transport type. */
export type DetectedTransport = 'iframe' | 'extension' | 'popup';

/** Detect which transport to use based on the current environment. */
export function detectTransport(): DetectedTransport {
  if (isInIframe()) return 'iframe';
  if (hasExtension()) return 'extension';
  return 'popup';
}

// =============================================================================
// autoConnect config
// =============================================================================

export interface AutoConnectConfig {
  /** dApp metadata sent during handshake. */
  dapp: DAppMetadata;

  /**
   * Wallet URL for popup fallback (P3).
   * The URL will be opened with `/connect?origin=<current origin>` appended.
   * Required if the extension is not installed and the page is not in an iframe.
   */
  walletUrl?: string;

  /** Permissions to request. Defaults to all. */
  permissions?: PermissionScope[];

  /**
   * If true, silently fail if the wallet has not previously approved this origin.
   * No UI will be shown. Useful for auto-connect on page load.
   * Default: false.
   */
  silent?: boolean;

  /** Existing session ID to resume (for popup mode). */
  resumeSessionId?: string;

  /** Timeout for query requests in ms. Default: 30000. */
  timeout?: number;

  /** Timeout for intent requests in ms. Default: 120000. */
  intentTimeout?: number;

  /**
   * Popup window features (width, height, etc.).
   * Default: 'width=420,height=720,scrollbars=yes,resizable=yes'
   */
  popupFeatures?: string;

  /**
   * Force a specific transport instead of auto-detecting.
   * Useful for testing or explicit control.
   */
  forceTransport?: DetectedTransport;
}

export interface AutoConnectResult {
  /** Connected client — use for queries, intents, and events. */
  client: ConnectClient;
  /** Connection result with session info and identity. */
  connection: ConnectResult;
  /** Which transport was selected. */
  transport: DetectedTransport;
  /**
   * Disconnect and clean up all resources.
   * For popup mode, also closes the popup window.
   */
  disconnect: () => Promise<void>;
}

// =============================================================================
// autoConnect implementation
// =============================================================================

const DEFAULT_POPUP_FEATURES = 'width=420,height=720,scrollbars=yes,resizable=yes';

/**
 * Auto-detect the best transport and connect to the Sphere wallet.
 *
 * @throws Error if connection fails or is rejected by the wallet.
 */
export async function autoConnect(config: AutoConnectConfig): Promise<AutoConnectResult> {
  const transportType = config.forceTransport ?? detectTransport();

  switch (transportType) {
    case 'iframe':
      return connectViaIframe(config);
    case 'extension':
      return connectViaExtension(config);
    case 'popup':
      return connectViaPopup(config);
  }
}

// =============================================================================
// P1: iframe
// =============================================================================

async function connectViaIframe(config: AutoConnectConfig): Promise<AutoConnectResult> {
  const transport = PostMessageTransport.forClient();

  const { client, connection, cleanup } = await createAndConnect(transport, config);

  return {
    client,
    connection,
    transport: 'iframe',
    disconnect: async () => {
      await client.disconnect();
      cleanup();
    },
  };
}

// =============================================================================
// P2: extension
// =============================================================================

async function connectViaExtension(config: AutoConnectConfig): Promise<AutoConnectResult> {
  const transport = ExtensionTransport.forClient();

  const { client, connection, cleanup } = await createAndConnect(transport, config);

  return {
    client,
    connection,
    transport: 'extension',
    disconnect: async () => {
      await client.disconnect();
      cleanup();
    },
  };
}

// =============================================================================
// P3: popup
// =============================================================================

async function connectViaPopup(config: AutoConnectConfig): Promise<AutoConnectResult> {
  if (!config.walletUrl) {
    throw new Error('autoConnect: walletUrl is required when no extension or iframe is available');
  }

  const origin = encodeURIComponent(window.location.origin);
  const popupUrl = `${config.walletUrl}/connect?origin=${origin}`;
  const features = config.popupFeatures ?? DEFAULT_POPUP_FEATURES;

  const popup = window.open(popupUrl, 'sphere-wallet', features);
  if (!popup) {
    throw new Error('autoConnect: Failed to open wallet popup — check popup blocker settings');
  }

  // Wait for HOST_READY signal from the wallet popup
  await waitForHostReady(popup, config.walletUrl);

  const transport = PostMessageTransport.forClient({
    target: popup,
    targetOrigin: config.walletUrl,
  });

  const { client, connection, cleanup } = await createAndConnect(transport, config);

  // Monitor popup close → treat as disconnect
  const closeCheckInterval = setInterval(() => {
    if (popup.closed) {
      clearInterval(closeCheckInterval);
      cleanup();
    }
  }, 1000);

  return {
    client,
    connection,
    transport: 'popup',
    disconnect: async () => {
      clearInterval(closeCheckInterval);
      await client.disconnect();
      cleanup();
      if (!popup.closed) popup.close();
    },
  };
}

// =============================================================================
// Helpers
// =============================================================================

function waitForHostReady(popup: Window, walletOrigin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', listener);
      reject(new Error('autoConnect: Wallet popup did not respond in time'));
    }, HOST_READY_TIMEOUT);

    function listener(event: MessageEvent) {
      // Accept from the wallet origin or any origin (for local dev)
      if (event.data?.type === HOST_READY_TYPE) {
        clearTimeout(timer);
        window.removeEventListener('message', listener);
        resolve();
      }
    }

    window.addEventListener('message', listener);

    // Also detect if popup is closed before responding
    const closeCheck = setInterval(() => {
      if (popup.closed) {
        clearInterval(closeCheck);
        clearTimeout(timer);
        window.removeEventListener('message', listener);
        reject(new Error('autoConnect: Wallet popup was closed before connecting'));
      }
    }, 500);
  });
}

async function createAndConnect(
  transport: ConnectTransport,
  config: AutoConnectConfig,
): Promise<{
  client: ConnectClient;
  connection: ConnectResult;
  cleanup: () => void;
}> {
  const clientConfig: ConnectClientConfig = {
    transport,
    dapp: config.dapp,
    permissions: config.permissions,
    timeout: config.timeout,
    intentTimeout: config.intentTimeout,
    resumeSessionId: config.resumeSessionId,
    silent: config.silent,
  };

  const client = new ConnectClient(clientConfig);

  try {
    const connection = await client.connect();
    return {
      client,
      connection,
      cleanup: () => transport.destroy(),
    };
  } catch (err) {
    transport.destroy();
    throw err;
  }
}
