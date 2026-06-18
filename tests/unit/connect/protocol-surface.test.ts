import { describe, it, expect } from 'vitest';
import { INTENT_ACTIONS, RPC_METHODS, SPHERE_CONNECT_VERSION } from '../../../connect/protocol';
import { PERMISSION_SCOPES } from '../../../connect/permissions';

/**
 * Connect protocol-surface guard.
 *
 * The "surface" — every intent action, permission scope and RPC method, plus the
 * protocol version — is the wire contract dApps depend on. Per docs/CONNECT.md:
 *   - add an intent / method / scope            -> bump MINOR (e.g. 2.0 -> 2.1)
 *   - remove / rename / change an existing one  -> bump MAJOR (e.g. 2.0 -> 3.0)
 *
 * When this test fails: read the diff, decide MINOR vs MAJOR, update
 * SPHERE_CONNECT_VERSION, then update EXPECTED below to match.
 */

const BUMP_REMINDER =
  '\nConnect wire surface changed.\n' +
  'Per docs/CONNECT.md: add intent/method/scope -> MINOR; remove/rename/change -> MAJOR.\n' +
  'Bump SPHERE_CONNECT_VERSION, then update EXPECTED in this file to match.\n';

// Committed snapshot of the wire surface. CHANGE ONLY TOGETHER WITH A VERSION BUMP.
const EXPECTED = {
  version: '2.0',
  intents: [
    'send', 'dm', 'payment_request', 'receive', 'sign_message',
    'create_invoice', 'close_invoice', 'cancel_invoice', 'pay_invoice',
    'return_invoice_payment', 'import_invoice', 'send_invoice_receipts',
    'send_cancellation_notices', 'set_auto_return', 'mint',
  ],
  scopes: [
    'identity:read', 'balance:read', 'tokens:read', 'history:read',
    'events:subscribe', 'resolve:peer', 'transfer:request', 'dm:request',
    'dm:read', 'dm:manage', 'payment:request', 'sign:request', 'mint:request',
    'invoice:read', 'invoice:write',
  ],
  methods: [
    'sphere_getIdentity', 'sphere_getBalance', 'sphere_getAssets',
    'sphere_getFiatBalance', 'sphere_getTokens', 'sphere_getHistory',
    'sphere_resolve', 'sphere_subscribe', 'sphere_unsubscribe', 'sphere_disconnect',
    'sphere_getConversations', 'sphere_getMessages', 'sphere_getDMUnreadCount',
    'sphere_markAsRead', 'sphere_getInvoices', 'sphere_getInvoiceStatus',
  ],
};

/** Order-independent canonical form so reordering a registry never trips the guard. */
function canonical(s: { version: string; intents: string[]; scopes: string[]; methods: string[] }) {
  return {
    version: s.version,
    intents: [...s.intents].sort(),
    scopes: [...s.scopes].sort(),
    methods: [...s.methods].sort(),
  };
}

describe('Connect protocol surface guard', () => {
  it('wire surface is unchanged (else bump SPHERE_CONNECT_VERSION + update EXPECTED)', () => {
    const live = {
      version: SPHERE_CONNECT_VERSION,
      intents: Object.values(INTENT_ACTIONS),
      scopes: Object.values(PERMISSION_SCOPES),
      methods: Object.values(RPC_METHODS),
    };
    expect(canonical(live), BUMP_REMINDER).toEqual(canonical(EXPECTED));
  });
});
