/**
 * WebSocket Abstraction
 * Platform-independent WebSocket interface for cross-platform support
 */

// =============================================================================
// WebSocket Interface
// =============================================================================

/**
 * Minimal WebSocket interface compatible with browser and Node.js
 */
export interface IWebSocket {
  readonly readyState: number;

  send(data: string): void;
  close(code?: number, reason?: string): void;

  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: IMessageEvent) => void) | null;
}

export interface IMessageEvent {
  data: string;
}

/**
 * WebSocket ready states (same as native WebSocket)
 */
export const WebSocketReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

/**
 * Factory function to create WebSocket instances
 * Different implementations for browser (native) vs Node.js (ws package)
 */
export type WebSocketFactory = (url: string) => IWebSocket;

// =============================================================================
// UUID Generator
// =============================================================================

/**
 * Generate a unique ID (platform-independent)
 * Browser: crypto.randomUUID()
 * Node: crypto.randomUUID() or uuid package
 */
export type UUIDGenerator = () => string;

/**
 * Default UUID generator using crypto.randomUUID
 * Works in modern browsers and Node 19+
 */
export function defaultUUIDGenerator(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
