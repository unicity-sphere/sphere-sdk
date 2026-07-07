/**
 * Payment-request submodule — shared host-shim types.
 *
 * Extracted from PaymentsModule.ts during Phase 5 (uxfv2-refactor-design.md
 * §2.1 and uxfv2-phase-5-payments-disposition.md §"Payment requests"). The
 * incoming/outgoing helpers accept these small capability shims so the free
 * functions stay decoupled from PaymentsModule internals — the facade wires
 * `deps`, resolvers, and its instance state through per-call closures.
 *
 * The facade retains ownership of the underlying state (list, maps, sets,
 * timer resolvers) — matching the wave-1 nametag/import-export pattern.
 */

import type {
  PaymentRequestPayload,
  PaymentRequestResponsePayload,
  PeerInfo,
  TransportProvider,
} from '../../../transport';
import type {
  IncomingPaymentRequest,
  OutgoingPaymentRequest,
  PaymentRequestResponse,
  PaymentRequestStatus,
  PaymentRequestHandler,
  PaymentRequestResponseHandler,
  SphereEventMap,
  SphereEventType,
  TransferRequest,
  TransferResult,
} from '../../../types';

/**
 * Emit shape used across both stores — matches the facade's
 * `PaymentsModuleDependencies.emitEvent` signature exactly.
 */
export type EmitEventFn = <T extends SphereEventType>(
  type: T,
  data: SphereEventMap[T],
) => void;

/**
 * Pending-response resolver entry — one live promise per outgoing request
 * that has a caller blocked in `waitForPaymentResponse`.
 */
export interface PendingResponseResolver {
  resolve: (response: PaymentRequestResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Capability shim used by handlers that touch the incoming request list
 * (`handleIncomingPaymentRequest`, `updatePaymentRequestStatus`, and the
 * accept/reject/pay verbs). The facade instantiates one of these per call
 * from its own state so tests can drive the surface without booting a full
 * PaymentsModule.
 */
export interface IncomingRequestHost {
  /** Mutable list of incoming requests (facade-owned). */
  readonly requests: IncomingPaymentRequest[];
  /** Handler set — same identity that `onPaymentRequest` mutates. */
  readonly handlers: ReadonlySet<PaymentRequestHandler>;
  /** Facade-supplied event emitter. `undefined` when facade isn't initialised. */
  readonly emitEvent: EmitEventFn | undefined;
  /**
   * Transport surface used by `sendPaymentRequestResponse`. `undefined` when
   * the transport doesn't advertise the response-send verb (older transports).
   */
  readonly transport: Pick<TransportProvider, 'sendPaymentRequestResponse'> | undefined;
}

/**
 * Capability shim used by outgoing-side handlers
 * (`handlePaymentRequestResponse`, `waitForPaymentResponse`, and the
 * cancel/remove verbs). Bundles the maps + resolvers + handler set the
 * outgoing side owns.
 */
export interface OutgoingRequestHost {
  /** Map keyed by local outgoing request id (facade-owned). */
  readonly requests: Map<string, OutgoingPaymentRequest>;
  /** Response handler set — same identity that `onPaymentRequestResponse` mutates. */
  readonly handlers: ReadonlySet<PaymentRequestResponseHandler>;
  /** Pending `waitForPaymentResponse` resolvers keyed by outgoing request id. */
  readonly resolvers: Map<string, PendingResponseResolver>;
  /** Facade-supplied event emitter. `undefined` when facade isn't initialised. */
  readonly emitEvent: EmitEventFn | undefined;
}

/**
 * Capability shim used by `sendPaymentRequestImpl`. The transport is the
 * one that has already gated on `sendPaymentRequest` support — callers
 * short-circuit before invoking the helper when the verb is absent.
 */
export interface SendPaymentRequestHost {
  readonly transport: TransportProvider;
  /**
   * Resolves the recipient address string to a 64-hex transport pubkey
   * suitable for the transport's `sendPaymentRequest` call. Delegates to
   * the facade's own resolver so identity/nametag lookup stays centralized.
   */
  resolveTransportPubkey(recipient: string, peerInfo: PeerInfo | null | undefined): string;
}

/**
 * Callback used by `payPaymentRequestImpl` — the facade wires in
 * `this.send.bind(this)` so the free function stays decoupled from the
 * facade's send orchestrator.
 */
export type SendFn = (request: TransferRequest) => Promise<TransferResult>;

/** Re-export payment-request status literal for internal consumers. */
export type { PaymentRequestStatus };

/** Re-export transport payload shapes used by response-sending. */
export type { PaymentRequestPayload, PaymentRequestResponsePayload };
