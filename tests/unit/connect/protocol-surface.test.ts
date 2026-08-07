import { describe, it, expect } from 'vitest';
import { SDK_VERSION } from '../../../connect/version';
import { ERROR_CODES, INTENT_ACTIONS, RPC_METHODS, SPHERE_CONNECT_VERSION, WALLET_EVENTS } from '../../../connect/protocol';
import { PERMISSION_SCOPES } from '../../../connect/permissions';

/**
 * Connect protocol-surface guard.
 *
 * The "surface" — every intent action, permission scope and RPC method, plus the
 * protocol version — is the wire contract dApps depend on. Per docs/CONNECT.md:
 *   - add an intent / method / scope            -> bump MINOR (e.g. 2.0 -> 2.1)
 *   - remove / rename / change an existing one  -> bump MAJOR (e.g. 2.0 -> 3.0)
 *   - add an error code the HOST never sends    -> client-local: bump the npm MINOR,
 *                                                 NOT the protocol MINOR
 *
 * When this test fails: read the diff, decide MINOR vs MAJOR, update
 * SPHERE_CONNECT_VERSION, then update EXPECTED below to match.
 */

const BUMP_REMINDER =
  '\nConnect wire surface changed.\n' +
  'Per docs/CONNECT.md: add intent/method/scope -> MINOR; remove/rename/change -> MAJOR.\n' +
  'EXCEPTION: an error code the HOST never sends is client-local — bump the npm MINOR,\n' +
  'not the protocol MINOR (e.g. REQUEST_TIMEOUT 4010, generated only by ConnectClient).\n' +
  'Bump SPHERE_CONNECT_VERSION, then update EXPECTED in this file to match.\n';

// Committed snapshot of the wire surface. CHANGE ONLY TOGETHER WITH A VERSION BUMP.
// P11 flip: the 9 invoice intents, 2 invoice queries and 2 invoice scopes were removed
// WITHOUT a MAJOR — they were experimental, never enabled in any wallet host (every call
// answered MODULE_NOT_AVAILABLE), and the consumer gate found zero dApp users. Version
// stays 2.1 by owner decision; a removed method now falls through to METHOD_NOT_FOUND.
const EXPECTED = {
  version: '2.1',
  intents: [
    'send', 'dm', 'payment_request', 'receive', 'sign_message', 'mint',
  ],
  scopes: [
    'identity:read', 'balance:read', 'tokens:read', 'history:read',
    'events:subscribe', 'resolve:peer', 'transfer:request', 'dm:request',
    'dm:read', 'dm:manage', 'payment:request', 'sign:request', 'mint:request',
  ],
  methods: [
    'sphere_getIdentity', 'sphere_getBalance', 'sphere_getAssets',
    'sphere_getFiatBalance', 'sphere_getTokens', 'sphere_getHistory',
    'sphere_resolve', 'sphere_subscribe', 'sphere_unsubscribe', 'sphere_disconnect',
    'sphere_getConversations', 'sphere_getMessages', 'sphere_getDMUnreadCount',
    'sphere_markAsRead',
  ],
  events: [
    'wallet:locked', 'wallet:unlocked', 'wallet:disconnected', 'identity:changed',
  ],
  // An error code the HOST never sends is client-local and bumps the npm MINOR, NOT the
  // protocol MINOR. REQUEST_TIMEOUT (4010) is client-generated only and lands in R2 —
  // it must appear here WITHOUT a SPHERE_CONNECT_VERSION bump when it does.
  errorCodes: [
    -32700, -32600, -32601, -32602, -32603,
    4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009,
    4100, 4101, 4102, 4200,
    // 4201 INTENT_OUTCOME_UNKNOWN — host-sent. Part of 2.1 from the start: 2.1 has not been
    // published, so its surface is still being defined rather than extended.
    4201,
  ],
};

/** Order-independent canonical form so reordering a registry never trips the guard. */
function canonical(s: {
  version: string; intents: string[]; scopes: string[]; methods: string[];
  events: string[]; errorCodes: number[];
}) {
  return {
    version: s.version,
    intents: [...s.intents].sort(),
    scopes: [...s.scopes].sort(),
    methods: [...s.methods].sort(),
    events: [...s.events].sort(),
    errorCodes: [...s.errorCodes].sort((a, b) => a - b),
  };
}

describe('Connect protocol surface guard', () => {
  it('wire surface is unchanged (else bump SPHERE_CONNECT_VERSION + update EXPECTED)', () => {
    const live = {
      version: SPHERE_CONNECT_VERSION,
      intents: Object.values(INTENT_ACTIONS),
      scopes: Object.values(PERMISSION_SCOPES),
      methods: Object.values(RPC_METHODS),
      events: Object.values(WALLET_EVENTS),
      errorCodes: Object.values(ERROR_CODES),
    };
    expect(canonical(live), BUMP_REMINDER).toEqual(canonical(EXPECTED));
  });
});
