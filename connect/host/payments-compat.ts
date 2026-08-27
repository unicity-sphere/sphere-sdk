// docs/PAYMENTS-V2-DESIGN.md §4 "Compatibility": with a v2-facade Sphere bound
// (`sphere.paymentsV2` non-null), old wire queries are served from facade reads and every
// old event name a dApp can `sphere_subscribe` to is re-emitted from the v2 bus events —
// dApps change NOTHING. Dormant on an old-stack Sphere (its module emits the old names).
// Old names stay plain string literals here: post-flip this wire surface is their only home.

import type { TransferResult } from '../../types';
import type { PaymentRequestView } from '../../modules/payments-v2/api';
import type { SphereInstance } from './SphereInstance';

type Forward = (data: unknown) => void;
type Attach = (sphere: SphereInstance, forward: Forward) => () => void;

type PaymentRequestUpdated = {
  id: string;
  status: 'pending' | 'settling' | 'paid' | 'rejected' | 'expired';
};
type TransferAttention = { transferId: string; code: string; detail?: string };
type ConnectionStatus = { status: 'connected' | 'degraded' | 'offline' };

// Old `sphere_getFiatBalance` semantics, held exactly: sum of priced assets, null when NO
// asset carries a price — the "no price data" signal a dApp may branch on.
export function sumFiatUsd(
  assets: ReadonlyArray<{ fiatValueUsd: number | null }>,
): number | null {
  let total = 0;
  let priced = false;
  for (const asset of assets) {
    if (asset.fiatValueUsd != null) {
      total += asset.fiatValueUsd;
      priced = true;
    }
  }
  return priced ? total : null;
}

const SETTLED_STATUSES: ReadonlySet<TransferResult['status']> = new Set([
  'confirmed',
  'delivered',
  'completed',
]);

const REALTIME_STATUS: Record<ConnectionStatus['status'], string> = {
  connected: 'connected',
  degraded: 'reconnecting',
  offline: 'closed',
};

// The ONE view → legacy `IncomingPaymentRequest` mapping (incoming AND the per-status
// rebuilds): symbol is registry-resolved when known, else '' — never absent on the wire.
function toLegacyRequest(view: PaymentRequestView, status: string): Record<string, unknown> {
  return { ...view, symbol: view.symbol ?? '', status };
}

// Rebuilds the old per-status `IncomingPaymentRequest` payload: full view from
// `requests.list()` (processed requests stay listed until dismissProcessed()); if already
// gone, id + status still carry the signal and unknowable fields are empty.
function legacyRequestPayload(
  sphere: SphereInstance,
  update: PaymentRequestUpdated,
): Record<string, unknown> {
  const view: PaymentRequestView | undefined = sphere.payments.requests
    .list()
    .find((request) => request.id === update.id);
  if (!view) {
    return {
      id: update.id,
      requestId: update.id,
      senderPubkey: '',
      amount: '',
      coinId: '',
      symbol: '',
      timestamp: Date.now(),
      status: update.status,
    };
  }
  return toLegacyRequest(view, update.status);
}

function requestStatusAttacher(status: 'paid' | 'rejected' | 'expired'): Attach {
  return (sphere, forward) =>
    sphere.on('payment_request:updated', (update: PaymentRequestUpdated) => {
      if (update.status === status) forward(legacyRequestPayload(sphere, update));
    });
}

// The v2 attention `code` IS the old event name (machine/journal.ts ATTENTION_* constants).
function attentionAttacher(code: string, toLegacy: (a: TransferAttention) => unknown): Attach {
  return (sphere, forward) =>
    sphere.on('transfer:attention', (attention: TransferAttention) => {
      if (attention.code === code) forward(toLegacy(attention));
    });
}

function remoteUpdateAttacher(sphere: SphereInstance, forward: Forward): () => void {
  let sequence = 0;
  return sphere.on('inventory:updated', () => {
    sequence += 1;
    forward({ providerId: 'wallet-api', name: 'wallet-api', sequence, cid: '', added: 0, removed: 0 });
  });
}

// A Map, not a plain object: the key is dApp-controlled, and an object lookup would reach
// the prototype chain ('constructor' would come back as a callable "attacher").
const COMPAT_ATTACHERS: ReadonlyMap<string, Attach> = new Map<string, Attach>([
  // Old completion split, held: deliveryPending ? delivery_pending : confirmed, plus the
  // failed arm (manifest judgment call #1). Payloads are the TransferResult, unchanged.
  ['transfer:confirmed', (sphere, forward) =>
    sphere.on('transfer:updated', (result: TransferResult) => {
      if (SETTLED_STATUSES.has(result.status) && result.deliveryPending !== true) forward(result);
    })],
  ['transfer:delivery_pending', (sphere, forward) =>
    sphere.on('transfer:updated', (result: TransferResult) => {
      if (result.status !== 'failed' && result.deliveryPending === true) forward(result);
    })],
  ['transfer:failed', (sphere, forward) =>
    sphere.on('transfer:updated', (result: TransferResult) => {
      if (result.status === 'failed') forward(result);
    })],
  // Same name on both wires, different payload: the raw v2 view has optional `symbol`;
  // legacy subscribers get the IncomingPaymentRequest shape via the shared mapping.
  ['payment_request:incoming', (sphere, forward) =>
    sphere.on('payment_request:incoming', (view: PaymentRequestView) => {
      forward(toLegacyRequest(view, view.status));
    })],
  ['payment_request:paid', requestStatusAttacher('paid')],
  ['payment_request:rejected', requestStatusAttacher('rejected')],
  ['payment_request:expired', requestStatusAttacher('expired')],
  // detail carries the old inner code (SPLIT_CHECKPOINT_LOST / CHECKPOINT_TRUSTBASE_MISMATCH).
  ['split:checkpoint-stuck', attentionAttacher('split:checkpoint-stuck', (attention) => ({
    transferId: attention.transferId,
    code: attention.detail ?? '',
    error: attention.detail ?? '',
  }))],
  ['delivery:undeliverable', attentionAttacher('delivery:undeliverable', (attention) => ({
    transferId: attention.transferId,
    recipientPubkey: '',
    attempts: 0,
    error: attention.detail ?? '',
  }))],
  ['delivery:deferred', attentionAttacher('delivery:deferred', (attention) => ({
    transferId: attention.transferId,
    recipientPubkey: '',
    reason: attention.detail ?? attention.code,
    deferredUntil: 0,
  }))],
  ['realtime:status', (sphere, forward) =>
    sphere.on('connection:status', (connection: ConnectionStatus) => {
      forward({ status: REALTIME_STATUS[connection.status] ?? 'closed' });
    })],
  // The server IS storage on the v2 vertical — a degraded connection is degraded storage.
  ['storage:degraded', (sphere, forward) =>
    sphere.on('connection:status', (connection: ConnectionStatus) => {
      if (connection.status !== 'degraded') return;
      forward({ providerId: 'wallet-api', error: 'wallet-api connection degraded' });
    })],
  ['sync:completed', (sphere, forward) =>
    sphere.on('inventory:updated', () => {
      forward({ source: 'payments', count: sphere.payments.tokens().length });
    })],
  ['sync:remote-update', remoteUpdateAttacher],
]);

// Attach ONE old-name subscription fed from its v2 source event; `forward` sends the wire
// frame under the OLD name. Null when `eventName` is not an adapted name (the caller falls
// through to a direct `sphere.on`).
export function attachCompatEvent(
  sphere: SphereInstance,
  eventName: string,
  forward: Forward,
): (() => void) | null {
  const attach = COMPAT_ATTACHERS.get(eventName);
  return attach ? attach(sphere, forward) : null;
}
