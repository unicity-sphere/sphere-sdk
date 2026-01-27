/**
 * Platform-specific implementations
 *
 * Each subdirectory contains implementations for a specific platform:
 * - browser/  - Browser environment (localStorage, WebSocket, fetch)
 * - node/     - Node.js environment (future)
 * - rn/       - React Native (future)
 */

// Re-export browser as default for this project
export * from './browser';
