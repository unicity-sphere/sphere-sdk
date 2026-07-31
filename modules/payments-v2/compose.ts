// Composition helper for PaymentsFacade: the injected-deps surface and the
// wiring of every built component (§5 layout). Policy stays in PaymentsFacade.

import { hexToBytes } from '../../core/crypto';
import { decryptField, encryptField } from '../../core/field-encryption';
import type { ITokenEngine, SplitCheckpointStore } from '../../token-engine/engine';
import type { MintParams } from '../../token-engine/types';
import type { TransferResult } from '../../types';

import type { SendRequest } from './api';
import type { DeliveryPort, StoragePort } from './ports';
import type { ScopedKV } from './stores';
import { History, type HistoryClient } from './history/History';
import { InventoryView, type PriceReader, type RegistryReader } from './inventory/InventoryView';
import { Receive, type ReceiveEngine, type ReceivedRecord, type StoredIncoming } from './receive/Receive';
import { Requests, type RequestMemoCodec, type RequestsWireClient } from './requests/Requests';
import { ReservationLedger } from './select/ledger';
import { SpendQueue } from './select/queue';
import { createMachineStores, type MachineStores } from './machine/journal';
import { TransferMachine, type IntentApi, type MachineDeps } from './machine/TransferMachine';

/**
 * TODO(mint-F13 seam): `engine.mint` today salts fresh per call, so an
 * interrupted mint is not re-derivable. When F13 lands transferId-seeded
 * determinism the engine advertises it here and replay re-derives by mintId.
 */
export interface DeterministicMintCapable {
  readonly deterministicMint: true;
  deriveMintTokenId(params: MintParams, mintId: string): Promise<string>;
}

export function supportsDeterministicMint(
  engine: ITokenEngine
): engine is ITokenEngine & DeterministicMintCapable {
  const candidate = engine as Partial<DeterministicMintCapable>;
  return candidate.deterministicMint === true && typeof candidate.deriveMintTokenId === 'function';
}

export interface RecipientInfo {
  chainPubkey: string;
  network: string;
  nametag?: string;
}

export interface FacadeSession {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribeStream(
    stream: 'inventory' | 'mailbox' | 'payment_requests',
    handler: () => void
  ): () => void;
}

interface IntentWireLike {
  transferId: string;
  payload: string;
  createdAt: string;
}

/** Structural slice of WalletApiV2Client the facade consumes directly. */
export interface FacadeClient extends HistoryClient, RequestsWireClient {
  putIntent(transferId: string, payloadEnvelope: string, requiresSeedClose?: boolean): Promise<void>;
  listIntents(status?: 'open' | 'aborted'): Promise<IntentWireLike[]>;
  abortIntent(transferId: string): Promise<void>;
  completeIntent(transferId: string, signature?: string): Promise<void>;
}

export interface PaymentsFacadeDeps {
  session: FacadeSession;
  client: FacadeClient;
  storagePort: StoragePort;
  deliveryPort: DeliveryPort;
  checkpointStore: SplitCheckpointStore;
  /** Initial engine source; setEngine() swaps what FUTURE operations snapshot. */
  engineRef: () => ITokenEngine;
  kv: ScopedKV;
  registry: RegistryReader;
  price?: PriceReader;
  emit: (event: string, payload: unknown) => void;
  resolveRecipient: (identifier: string) => Promise<RecipientInfo | null>;
  signComplete: (transferId: string) => Promise<string>;
  /** S6 self-scoped field key: intent payload envelope + history memo/nametag. */
  fieldKey: Uint8Array;
  /** The session's network — a recipient not verifiably on it is refused (§5.6). */
  network: string;
  ownPubkey: string;
  ownNametag?: () => string | undefined;
  requestMemo: RequestMemoCodec;
  syncEpoch?: () => string;
  now?: () => number;
  newId?: () => string;
  workBudget?: number;
  receivePollMs?: number;
}

/** Derived (non-authoritative) tokenId→stateHash cache backing the ReceiveView seam. */
export class HeldStateCache {
  private readonly held = new Map<string, string>();

  get(tokenId: string): string | null {
    return this.held.get(tokenId) ?? null;
  }

  set(tokenId: string, stateHash: string): void {
    this.held.set(tokenId, stateHash);
  }
}

export interface FacadeHooks {
  engine(): ITokenEngine;
  send(request: SendRequest): Promise<TransferResult>;
}

export interface FacadeParts {
  ownPubkeyBytes: Uint8Array;
  view: InventoryView;
  ledger: ReservationLedger;
  queue: SpendQueue;
  historyStore: History;
  machineStores: MachineStores;
  machineDeps: MachineDeps;
  machine: TransferMachine;
  heldStates: HeldStateCache;
  receiveLoop: Receive;
  requests: Requests;
}

export function composeFacadeParts(deps: PaymentsFacadeDeps, hooks: FacadeHooks): FacadeParts {
  const ownPubkeyBytes = hexToBytes(deps.ownPubkey);
  const view = new InventoryView({
    port: deps.storagePort,
    kv: deps.kv,
    emit: (event) => deps.emit(event, {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const ledger = new ReservationLedger();
  const queue = new SpendQueue({
    ledger,
    getPool: (coinId) => view.pool(coinId),
    ...(deps.workBudget !== undefined ? { workBudget: deps.workBudget } : {}),
  });
  const historyStore = new History({
    client: deps.client,
    fieldKey: deps.fieldKey,
    registry: deps.registry,
    emit: (event) => deps.emit(event, {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
  });
  const machineDeps = buildMachineDeps(deps, hooks, historyStore);
  const heldStates = new HeldStateCache();

  return {
    ownPubkeyBytes,
    view,
    ledger,
    queue,
    historyStore,
    machineStores: createMachineStores(deps.kv),
    machineDeps,
    machine: new TransferMachine(machineDeps),
    heldStates,
    receiveLoop: buildReceive(deps, hooks, historyStore, heldStates),
    requests: buildRequests(deps, hooks),
  };
}

function buildMachineDeps(
  deps: PaymentsFacadeDeps,
  hooks: FacadeHooks,
  historyStore: History
): MachineDeps {
  return {
    engine: () => hooks.engine(),
    storage: deps.storagePort,
    delivery: deps.deliveryPort,
    intents: intentApi(deps.client),
    checkpointStore: deps.checkpointStore,
    kv: deps.kv,
    encryptPayload: async (payload) => encryptField(deps.fieldKey, JSON.stringify(payload)),
    decryptPayload: async (envelope) => JSON.parse(decryptField(deps.fieldKey, envelope)) as unknown,
    signComplete: deps.signComplete,
    ownPubkey: hexToBytes(deps.ownPubkey),
    emit: deps.emit,
    now: deps.now ?? Date.now,
    recordHistory: async ({ transferId, payload }) => {
      await historyStore.recordSent({
        transferId,
        coinId: payload.coinId,
        amount: payload.amount,
        recipientPubkey: payload.recipient,
        ...(payload.memo !== undefined ? { memo: payload.memo } : {}),
      });
    },
  };
}

function intentApi(client: FacadeClient): IntentApi {
  return {
    put: (transferId, envelope, requiresSeedClose) =>
      client.putIntent(transferId, envelope, requiresSeedClose),
    listOpen: async () =>
      (await client.listIntents('open')).map((intent) => ({
        transferId: intent.transferId,
        payload: intent.payload,
        createdAt: intent.createdAt,
      })),
    abort: (transferId) => client.abortIntent(transferId),
    complete: (transferId, signature) => client.completeIntent(transferId, signature),
  };
}

function buildReceive(
  deps: PaymentsFacadeDeps,
  hooks: FacadeHooks,
  historyStore: History,
  heldStates: HeldStateCache
): Receive {
  return new Receive({
    delivery: deps.deliveryPort,
    engine: receiveEngine(hooks),
    view: {
      heldState: (tokenId) => heldStates.get(tokenId),
      store: async (entry: StoredIncoming) => {
        heldStates.set(entry.tokenId, entry.stateHash);
        return 'stored';
      },
    },
    kv: deps.kv,
    registry: deps.registry,
    recordReceived: (record) => recordReceived(historyStore, record),
    emit: (event, transfer) => deps.emit(event, transfer),
    syncEpoch: deps.syncEpoch ?? (() => ''),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}

function receiveEngine(hooks: FacadeHooks): ReceiveEngine {
  return {
    getIdentity: () => hooks.engine().getIdentity(),
    decodeToken: (blob) => hooks.engine().decodeToken(blob),
    verify: (token, options) => hooks.engine().verify(token, options),
    isOwnedBy: (token, pubkey) => hooks.engine().isOwnedBy(token, pubkey),
    isSpent: (token, options) => hooks.engine().isSpent(token, options),
    tokenId: (token) => hooks.engine().tokenId(token),
    deliveryKeys: (blobBytes) => hooks.engine().deliveryKeys(blobBytes),
  };
}

async function recordReceived(historyStore: History, record: ReceivedRecord): Promise<void> {
  const first = record.assets[0];
  await historyStore.recordReceived({
    tokenId: record.tokenId,
    stateHash: record.stateHash,
    coinId: first?.coinId ?? '',
    amount: first?.amount ?? '0',
    ...(record.senderPubkey !== undefined ? { senderPubkey: record.senderPubkey } : {}),
    ...(record.senderNametag !== undefined ? { senderNametag: record.senderNametag } : {}),
    ...(record.memo !== undefined ? { memo: record.memo } : {}),
    timestamp: record.receivedAt,
  });
}

function buildRequests(deps: PaymentsFacadeDeps, hooks: FacadeHooks): Requests {
  return new Requests({
    client: deps.client,
    kv: deps.kv,
    ownPubkey: deps.ownPubkey,
    send: (request) => hooks.send(request),
    resolvePubkey: async (identifier) =>
      (await deps.resolveRecipient(identifier))?.chainPubkey ?? null,
    listAbortedTransferIds: async () =>
      (await deps.client.listIntents('aborted')).map((intent) => intent.transferId),
    emit: deps.emit,
    memo: deps.requestMemo,
    ...(deps.ownNametag !== undefined ? { ownNametag: deps.ownNametag } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}
