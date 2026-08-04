/**
 * Composition of the opt-in payments-v2 vertical (P9 — PAYMENTS-V2-DESIGN.md
 * §4/§7/§11), kept out of core/Sphere.ts. The wallet-api transport reuses the
 * old S4 client's composition config (see PaymentsV2TransportSource).
 */

import { signMessage } from './crypto';
import { SphereError } from './errors';
import { deriveFieldEncryptionKey } from './field-encryption';
import {
  decryptDeliveryBundle,
  deriveDeliveryEncryptionKey,
  encryptDeliveryBundle,
} from './delivery-envelope';
import type { FullIdentity } from '../types';
import type { PeerInfo } from '../transport';
import type { StorageProvider } from '../storage';
import type { PriceProvider } from '../price';
import type { ITokenEngine } from '../token-engine/engine';
import { TokenRegistry } from '../registry';
import {
  PaymentsFacade,
  type FacadeClient,
  type FacadeSession,
  type PaymentsFacadeDeps,
  type RecipientInfo,
} from '../modules/payments-v2/PaymentsFacade';
import { createScopedKV, type ScopedKV } from '../modules/payments-v2/stores';
import type { RequestMemoCodec } from '../modules/payments-v2/requests/Requests';
import { createWalletApiHttp, type FetchLike as V2FetchLike } from '../impl/wallet-api-v2/http';
import { WalletApiV2Client } from '../impl/wallet-api-v2/client';
import {
  JwtGenerationCell,
  WalletApiSession,
  type ConnectionStatus,
  type WebSocketFactory,
  type WebSocketLike,
} from '../impl/wallet-api-v2/session';
import { WalletApiStoragePort, type StoragePortClient } from '../impl/wallet-api-v2/storage';
import { WalletApiDeliveryPort, type DeliveryPortClient } from '../impl/wallet-api-v2/mailbox';
import { WalletApiSplitCheckpointStore, type CheckpointClient } from '../impl/wallet-api-v2/checkpoints';

/** Everything the facade + wallet-api-v2 ports consume from the wire client. */
export type PaymentsV2WireClient = StoragePortClient &
  DeliveryPortClient &
  CheckpointClient &
  FacadeClient;

export interface PaymentsV2Transport {
  session: FacadeSession;
  client: PaymentsV2WireClient;
}

export interface PaymentsV2TransportArgs {
  identity: { privateKey: string; chainPubkey: string };
  network: string;
  /** Per-(network, address) scoped KV — refresh token, cursors, seen-set live here. */
  kv: ScopedKV;
  emitStatus: (status: ConnectionStatus) => void;
  onEpochChange: (epoch: string) => Promise<void>;
}

export type PaymentsV2TransportFactory = (args: PaymentsV2TransportArgs) => PaymentsV2Transport;

/**
 * Read (duck-typed) off `Sphere.init({ walletApi })`: `network` is required;
 * exactly one of the two optional members supplies the transport.
 */
export interface PaymentsV2TransportSource {
  network: string;
  /** DI seam: supply the whole per-address bundle (offline tests, custom hosts). */
  paymentsV2Transport?(args: PaymentsV2TransportArgs): PaymentsV2Transport;
  /** Default path: the old S4 client's construction config. */
  paymentsV2CompositionConfig?(): {
    baseUrl: string;
    deviceId: string;
    fetchFn?: unknown;
    webSocketFactory?: unknown;
  };
}

export interface PaymentsV2Composition {
  network: string;
  factory: PaymentsV2TransportFactory;
}

/** Fail-closed: `paymentsV2: true` without a usable source throws at init. */
export function resolvePaymentsV2Composition(walletApi: unknown): PaymentsV2Composition {
  const source = walletApi as Partial<PaymentsV2TransportSource> | null | undefined;
  const network = typeof source?.network === 'string' && source.network !== '' ? source.network : null;
  if (!source || network === null) {
    throw new SphereError(
      'paymentsV2 requires a wallet-api composition: pass `walletApi` (the S4 WalletApiClient — its baseUrl/network/deviceId are reused, no new env) to Sphere.init.',
      'INVALID_CONFIG'
    );
  }
  if (typeof source.paymentsV2Transport === 'function') {
    return { network, factory: source.paymentsV2Transport.bind(source) };
  }
  if (typeof source.paymentsV2CompositionConfig === 'function') {
    const cfg = source.paymentsV2CompositionConfig();
    return {
      network,
      factory: defaultPaymentsV2Transport({
        baseUrl: cfg.baseUrl,
        network,
        deviceId: cfg.deviceId,
        fetchFn: cfg.fetchFn,
        webSocketFactory: cfg.webSocketFactory,
      }),
    };
  }
  throw new SphereError(
    'paymentsV2: the `walletApi` object exposes neither paymentsV2CompositionConfig() (WalletApiClient does) nor the paymentsV2Transport() seam.',
    'INVALID_CONFIG'
  );
}

export interface PaymentsV2DefaultTransportConfig {
  baseUrl: string;
  network: string;
  deviceId: string;
  /** Old-client `FetchLike` (structurally compatible); default `globalThis.fetch`. */
  fetchFn?: unknown;
  /** Old-client WS factory (structurally compatible); default `globalThis.WebSocket`. */
  webSocketFactory?: unknown;
}

function adaptFetch(fetchFn: unknown): V2FetchLike {
  if (typeof fetchFn === 'function') return fetchFn as V2FetchLike;
  if (typeof (globalThis as { fetch?: unknown }).fetch !== 'function') {
    throw new SphereError('paymentsV2: no fetch available — inject fetchFn into the wallet-api client.', 'INVALID_CONFIG');
  }
  // Through globalThis so browser fetch keeps its receiver (Illegal invocation).
  return (url, init) =>
    (globalThis as unknown as { fetch: V2FetchLike }).fetch(url, init);
}

function adaptWebSocketFactory(factory: unknown): WebSocketFactory {
  // The old wallet-api WebSocketLike is a structural superset of the v2 one.
  if (typeof factory === 'function') return factory as WebSocketFactory;
  return (url: string): WebSocketLike => {
    const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!Ctor) {
      throw new SphereError(
        'paymentsV2: no global WebSocket — inject webSocketFactory into the wallet-api client (e.g. the "ws" package on Node < 22).',
        'INVALID_CONFIG'
      );
    }
    return new Ctor(url);
  };
}

/**
 * Default per-address transport — the live-staging e2e composition. Each call
 * builds a FRESH bundle (a stopped WalletApiSession does not restart; §7).
 */
export function defaultPaymentsV2Transport(
  config: PaymentsV2DefaultTransportConfig
): PaymentsV2TransportFactory {
  const fetchFn = adaptFetch(config.fetchFn);
  const webSocketFactory = adaptWebSocketFactory(config.webSocketFactory);
  return (args) => {
    const cell = new JwtGenerationCell();
    const http = createWalletApiHttp({
      baseUrl: config.baseUrl,
      fetchFn,
      getToken: () => cell.token(),
    });
    const client = new WalletApiV2Client(http);
    const session = new WalletApiSession({
      client,
      cell,
      signer: {
        pubkey: args.identity.chainPubkey,
        network: args.network,
        sign: (message: string) => signMessage(args.identity.privateKey, message),
      },
      // ':pv2': a distinct lineage — sharing the old S4 client's (owner,
      // device) session row would let refresh rotations revoke each other.
      deviceId: `${config.deviceId}:pv2`,
      kv: args.kv,
      webSocketFactory,
      emitStatus: args.emitStatus,
      onEpochChange: args.onEpochChange,
    });
    return { session, client: authedWireClient(session, client) };
  };
}

/**
 * Every call rides session.withAuth (one 401 → single-flight re-auth → one
 * retry); presigned-S3 fetch/upload carry no bearer and pass straight through.
 */
function authedWireClient(session: WalletApiSession, client: WalletApiV2Client): PaymentsV2WireClient {
  const auth = <T>(op: () => Promise<T>): Promise<T> => session.withAuth(() => op());
  return {
    listInventory: (since) => auth(() => client.listInventory(since)),
    blobUrls: (tokenIds) => auth(() => client.blobUrls(tokenIds)),
    uploadUrls: (blobs) => auth(() => client.uploadUrls(blobs)),
    apply: (delta) => auth(() => client.apply(delta)),
    fetchBlob: (getUrl) => client.fetchBlob(getUrl),
    uploadBlob: (putUrl, bytes) => client.uploadBlob(putUrl, bytes),
    putIntent: (t, payload, requiresSeedClose) => auth(() => client.putIntent(t, payload, requiresSeedClose)),
    listIntents: (status) => auth(() => client.listIntents(status)),
    abortIntent: (t) => auth(() => client.abortIntent(t)),
    completeIntent: (t, signature) => auth(() => client.completeIntent(t, signature)),
    postProgress: (t, opIndex, payload, signature) => auth(() => client.postProgress(t, opIndex, payload, signature)),
    getProgress: (t) => auth(() => client.getProgress(t)),
    deposit: (entry) => auth(() => client.deposit(entry)),
    depositBatch: (entries) => auth(() => client.depositBatch(entries)),
    listMailbox: (since) => auth(() => client.listMailbox(since)),
    claim: (entryIds, intoInventory) => auth(() => client.claim(entryIds, intoInventory)),
    reject: (entryIds, reason, detail) => auth(() => client.reject(entryIds, reason, detail)),
    postHistory: (records) => auth(() => client.postHistory(records)),
    listHistory: (options) => auth(() => client.listHistory(options)),
    createPaymentRequest: (input) => auth(() => client.createPaymentRequest(input)),
    listPaymentRequests: (params) => auth(() => client.listPaymentRequests(params)),
    respondPaymentRequest: (id, response) => auth(() => client.respondPaymentRequest(id, response)),
  };
}

/** The slice of Sphere the vertical consumes (passed by core/Sphere.ts). */
export interface PaymentsV2Host {
  storage: StorageProvider;
  price: PriceProvider | null;
  /** The Sphere event bus (`emitEvent`) — the facade's 8 events ride it directly. */
  emit: (event: string, payload: unknown) => void;
  /** Transport resolve — the same lookup the old send path used. */
  resolvePeer: (identifier: string) => Promise<PeerInfo | null>;
  nametag: () => string | undefined;
}

const CHAIN_PUBKEY_RE = /^0[23][0-9a-f]{64}$/i;

/**
 * Non-pubkey identifiers ride the same transport resolution the old send path
 * used; the recipient's network is pinned to the SESSION network (§5.6).
 */
async function resolveRecipientInfo(
  identifier: string,
  network: string,
  resolvePeer: (identifier: string) => Promise<PeerInfo | null>
): Promise<RecipientInfo | null> {
  if (CHAIN_PUBKEY_RE.test(identifier)) {
    return { chainPubkey: identifier.toLowerCase(), network };
  }
  const peer = await resolvePeer(identifier);
  if (!peer?.chainPubkey) return null;
  return {
    chainPubkey: peer.chainPubkey,
    network,
    ...(peer.nametag !== undefined ? { nametag: peer.nametag } : {}),
  };
}

/** The S6 recipient-ECDH bundle codec — the same primitive delivery memos use. */
function requestMemoCodec(privateKey: string): RequestMemoCodec {
  return {
    encrypt: (peerPubkey, bundle) =>
      encryptDeliveryBundle(deriveDeliveryEncryptionKey(privateKey, peerPubkey), {
        ...(bundle.memo !== undefined ? { memo: bundle.memo } : {}),
        ...(bundle.senderNametag !== undefined ? { senderNametag: bundle.senderNametag } : {}),
      }),
    decrypt: (peerPubkey, envelope) => {
      const bundle = decryptDeliveryBundle(deriveDeliveryEncryptionKey(privateKey, peerPubkey), envelope);
      return {
        ...(bundle.memo !== undefined ? { memo: bundle.memo } : {}),
        ...(bundle.senderNametag !== undefined ? { senderNametag: bundle.senderNametag } : {}),
      };
    },
  };
}

export interface ComposePaymentsV2Spec {
  identity: FullIdentity;
  composition: PaymentsV2Composition;
  /** Sphere's per-address engine record — REUSED; the wiring never builds one. */
  engineRef: () => ITokenEngine;
  host: PaymentsV2Host;
}

/**
 * Compose one address's PaymentsFacade over the wallet-api-v2 ports; the
 * caller (Sphere) owns start()/stop()/setEngine() lifecycle (§7).
 */
export function composePaymentsV2(spec: ComposePaymentsV2Spec): PaymentsFacade {
  const { identity, host } = spec;
  const network = spec.composition.network;
  const identitySlice = { privateKey: identity.privateKey, chainPubkey: identity.chainPubkey };
  const kv = createScopedKV(host.storage, network, identity.chainPubkey);
  const fieldKey = deriveFieldEncryptionKey(identity.privateKey);
  const transport = spec.composition.factory({
    identity: identitySlice,
    network,
    kv,
    emitStatus: (status) => host.emit('connection:status', { status }),
    onEpochChange: async () => undefined,
  });
  const deps: PaymentsFacadeDeps = {
    session: transport.session,
    client: transport.client,
    storagePort: new WalletApiStoragePort(transport.client),
    deliveryPort: new WalletApiDeliveryPort({
      client: transport.client,
      kv,
      identity: identitySlice,
      custody: 'inventory',
    }),
    checkpointStore: new WalletApiSplitCheckpointStore({
      client: transport.client,
      kv,
      fieldKey,
      signProgress: (message) => signMessage(identity.privateKey, message),
    }),
    engineRef: spec.engineRef,
    kv,
    registry: TokenRegistry.getInstance(),
    ...(host.price !== null ? { price: host.price } : {}),
    emit: host.emit,
    resolveRecipient: (identifier) => resolveRecipientInfo(identifier, network, host.resolvePeer),
    // The #87 canonical close message the server's seedGate verifies.
    signComplete: async (transferId) =>
      signMessage(identity.privateKey, `wallet-api.complete.v1:${transferId}`),
    fieldKey,
    network,
    ownPubkey: identity.chainPubkey,
    ownNametag: host.nametag,
    requestMemo: requestMemoCodec(identity.privateKey),
  };
  return new PaymentsFacade(deps);
}
