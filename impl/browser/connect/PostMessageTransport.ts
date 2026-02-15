/**
 * PostMessageTransport — Browser transport for Sphere Connect.
 *
 * Two modes:
 * - iframe: wallet (parent) ↔ dApp (iframe child)
 * - popup:  dApp (opener) ↔ wallet (popup window)
 */

import type { ConnectTransport, SphereConnectMessage } from '../../../connect';
import { isSphereConnectMessage } from '../../../connect';

// =============================================================================
// Configuration
// =============================================================================

export interface PostMessageHostOptions {
  /** Allowed origins for incoming messages. Use ['*'] only in development. */
  allowedOrigins: string[];
}

export interface PostMessageClientOptions {
  /** Target window to send messages to. Defaults to window.parent (iframe mode). */
  target?: Window;
  /** Target origin for postMessage. Default: '*'. Should be set to wallet origin. */
  targetOrigin?: string;
}

// =============================================================================
// Implementation
// =============================================================================

const POPUP_CLOSE_CHECK_INTERVAL = 1000;

export class PostMessageTransport implements ConnectTransport {
  private readonly targetWindow: Window;
  private readonly targetOrigin: string;
  private readonly allowedOrigins: Set<string> | null;
  private handlers: Set<(message: SphereConnectMessage) => void> = new Set();
  private listener: ((event: MessageEvent) => void) | null = null;
  private popupCheckInterval: ReturnType<typeof setInterval> | null = null;
  private onPopupClosed: (() => void) | null = null;

  private constructor(
    targetWindow: Window,
    targetOrigin: string,
    allowedOrigins: string[] | null,
  ) {
    this.targetWindow = targetWindow;
    this.targetOrigin = targetOrigin;
    this.allowedOrigins = allowedOrigins ? new Set(allowedOrigins) : null;

    // Listen for incoming messages
    this.listener = (event: MessageEvent) => {
      // Origin check (host mode)
      if (this.allowedOrigins && !this.allowedOrigins.has('*') && !this.allowedOrigins.has(event.origin)) {
        return;
      }

      // Namespace filter
      if (!isSphereConnectMessage(event.data)) {
        return;
      }

      for (const handler of this.handlers) {
        try {
          handler(event.data);
        } catch {
          // Ignore handler errors
        }
      }
    };

    window.addEventListener('message', this.listener);
  }

  // ===========================================================================
  // Factory Methods
  // ===========================================================================

  /**
   * Create transport for the HOST side (wallet).
   *
   * iframe mode: target = iframe.contentWindow
   * popup mode:  target = window.opener
   */
  static forHost(
    target: HTMLIFrameElement | Window,
    options: PostMessageHostOptions,
  ): PostMessageTransport {
    const targetWindow = target instanceof HTMLIFrameElement
      ? target.contentWindow!
      : target;
    const targetOrigin = options.allowedOrigins[0] === '*' ? '*' : options.allowedOrigins[0];
    return new PostMessageTransport(targetWindow, targetOrigin, options.allowedOrigins);
  }

  /**
   * Create transport for the CLIENT side (dApp).
   *
   * iframe mode: target defaults to window.parent
   * popup mode:  target = popup window (from window.open())
   */
  static forClient(options?: PostMessageClientOptions): PostMessageTransport {
    const target = options?.target ?? window.parent;
    const targetOrigin = options?.targetOrigin ?? '*';
    const transport = new PostMessageTransport(target, targetOrigin, null);

    // If target is a popup window, detect when it closes
    if (options?.target && options.target !== window.parent) {
      transport.startPopupCloseDetection(options.target);
    }

    return transport;
  }

  // ===========================================================================
  // ConnectTransport Interface
  // ===========================================================================

  send(message: SphereConnectMessage): void {
    try {
      this.targetWindow.postMessage(message, this.targetOrigin);
    } catch {
      // Window may be closed
    }
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
    if (this.popupCheckInterval) {
      clearInterval(this.popupCheckInterval);
      this.popupCheckInterval = null;
    }
    this.handlers.clear();
  }

  // ===========================================================================
  // Popup Close Detection
  // ===========================================================================

  /** Register a callback for when the popup window closes */
  onClose(callback: () => void): void {
    this.onPopupClosed = callback;
  }

  private startPopupCloseDetection(popup: Window): void {
    this.popupCheckInterval = setInterval(() => {
      if (popup.closed) {
        if (this.popupCheckInterval) {
          clearInterval(this.popupCheckInterval);
          this.popupCheckInterval = null;
        }
        if (this.onPopupClosed) {
          this.onPopupClosed();
        }
      }
    }, POPUP_CLOSE_CHECK_INTERVAL);
  }
}
