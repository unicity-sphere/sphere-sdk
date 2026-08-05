/**
 * wallet-api/intent-signing.ts — the E.4/#87 seed-holder message formats
 * (sphere-sdk#501). The canonical builders live in `core/wallet-api-protocol.ts`
 * (the single source for the cross-repo contract strings); this module keeps
 * the historical wallet-api import path alive.
 */

export { completeSignMessage, progressSignMessage } from '../core/wallet-api-protocol';
