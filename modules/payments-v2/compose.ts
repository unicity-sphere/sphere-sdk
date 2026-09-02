// Composition helper for PaymentsFacade: the injected-deps surface and the
// wiring of every built component (§5 layout). Policy stays in PaymentsFacade.

import { coalesced } from './async';
import { hexToBytes } from '../../core/crypto';
import { decryptField, encryptField } from '../../core/field-encryption';
import type { ITokenEngine, SplitCheckpointStore } from '../../token-engine/engine';
import type { TransferResult } from '../../types';

import type { ConnectionStatus, SendRequest } from './api';
import type { DeliveryPort, StoragePort } from './ports';
import type { ScopedKV } from './stores';
import { History, type HistoryClient } from './history/History';
import { InventoryView, type PriceReader, type RegistryReader } from './inventory/InventoryView';
import { Receive, type ReceivedRecord, type StoredIncoming } from './receive/Receive';
import { Requests, type RequestMemoCodec, type RequestsWireClient } from './requests/Requests';
import { deriveOpenIntentHolds } from './convergence';
import type { RestoreDeps } from './restore';
import { ReservationLedger } from './select/ledger';
import { IntentPins } from './select/pins';
import { SpendQueue } from './select/queue';
import { createMachineStores, type MachineStores } from './machine/journal';
import { TransferMachine, type MachineDeps } from './machine/TransferMachine';

/**
 * F13 makes `mint(params, { transferId, opIndex })` idempotent-recoverable — a
 * same-seed re-CALL recovers the existing certification via the E.2 probe
 * (pinned by tests/unit/token-engine/mint-recovery.test.ts) — so replay needs
 * no pre-derivation, just a safe re-call; a non-advertising engine falls back
 * to the inventory-guard + hold path (never a blind re-mint).
 */
export interface DeterministicMintCapable {
  readonly deterministicMint: true;
}

export function supportsDeterministicMint(
  engine: ITokenEngine
): engine is ITokenEngine & DeterministicMintCapable {
  return (engine as Partial<DeterministicMintCapable>).deterministicMint === true;
}

export interface RecipientInfo {
  chainPubkey: string;
  /** The recipient's PROVEN network — `null` when nothing proved one (§5.6). */
  network: string | null;
  nametag?: string;
}

export interface FacadeSession {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribeStream(
    stream: 'inventory' | 'mailbox' | 'payment_requests',
    handler: () => void
  ): () => void;
  /** §5.1: the latched server syncEpoch ('' before first server contact). */
  currentEpoch(): string;
  /**
   * §5.1 restore hook — REQUIRED so an unwired restore protocol is a COMPILE
   * ERROR: handlers run and are AWAITED on a syncEpoch change BEFORE any
   * stream nudge resumes. The facade registers handleEpochChange here.
   */
  subscribeEpochChange(handler: (epoch: string) => Promise<void>): () => void;
  /**
   * The session's CURRENT status — REQUIRED, and the ONE source `connectionStatus()`
   * and `connection:status` both come from ('offline' before first contact).
   */
  status(): ConnectionStatus;
  /**
   * Optional connection-status feed (same wiring pattern as the streams; the
   * emission point is the session's existing `connection:status` transition).
   * The facade's heartbeat resets its backoff on a 'connected' recovery.
   */
  subscribeStatus?(handler: (status: ConnectionStatus) => void): () => void;
}

/**
 * §5.1/§6 restore surface of the checkpoint store: re-POST the slot's cached
 * encrypt-once ciphertext byte-identical after a server restore (insert-once,
 * first-write-wins server-side). Returns false when no ciphertext is cached.
 */
export interface CheckpointReseeder {
  reseedCheckpoint(transferId: string, opIndex: number): Promise<boolean>;
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
  /** Reseeder REQUIRED: the restore protocol re-POSTs cached ciphertexts (§5.1). */
  checkpointStore: SplitCheckpointStore & CheckpointReseeder;
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
  /** REQUIRED (§5.1): reads the session's current epoch — never a default. */
  syncEpoch: () => string;
  now?: () => number;
  newId?: () => string;
  workBudget?: number;
  receivePollMs?: number;
}

/** Derived (non-authoritative) tokenId→stateHash cache backing the ReceiveView seam. */
export type HeldStateCache = Map<string, string>;

export interface FacadeHooks {
  engine(): ITokenEngine;
  send(request: SendRequest): Promise<TransferResult>;
  /** §7 ownership — an attempt running in-process owns its own reservation (#737). */
  isActiveOp(transferId: string): boolean;
  /** Register a background op so stop() cannot return while it is still writing. */
  track(op: Promise<unknown>): void;
}

export interface FacadeParts {
  ownPubkeyBytes: Uint8Array;
  view: InventoryView;
  ledger: ReservationLedger;
  pins: IntentPins;
  queue: SpendQueue;
  historyStore: History;
  machineStores: MachineStores;
  machineDeps: MachineDeps;
  machine: TransferMachine;
  heldStates: HeldStateCache;
  /** ONE coalescer over view.delta(), shared by the §9 wake and the receive drain. */
  refreshView: () => void;
  receiveLoop: Receive;
  requests: Requests;
  restoreDeps: RestoreDeps;
}

export function composeFacadeParts(deps: PaymentsFacadeDeps, hooks: FacadeHooks): FacadeParts {
  const ownPubkeyBytes = hexToBytes(deps.ownPubkey);
  const ledger = new ReservationLedger();
  const view = new InventoryView({
    port: deps.storagePort,
    kv: deps.kv,
    emit: (event) => deps.emit(event, {}),
    // #737: a reserved token is unselectable, so it is never confirmed balance.
    // #738: while the held-set is unproven, EVERY token reads pinned — the report
    // must not call a token spendable that the queue is about to refuse to spend.
    isPinned: (tokenId) => ledger.unprovenReason() !== null || ledger.holderOf(tokenId) !== undefined,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const queue = new SpendQueue({
    ledger,
    getPool: (coinId) => view.pool(coinId),
    ...(deps.workBudget !== undefined ? { workBudget: deps.workBudget } : {}),
  });
  const historyStore = new History({
    client: deps.client,
    fieldKey: deps.fieldKey,
    registry: deps.registry,
    emit: (event, entry) => deps.emit(event, entry),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
  });
  const machineDeps = buildMachineDeps(deps, hooks, historyStore);
  const machineStores = createMachineStores(deps.kv);
  const heldStates: HeldStateCache = new Map();

  const refreshView = coalesced(() => view.delta(), hooks.track);
  return {
    ownPubkeyBytes,
    view,
    refreshView,
    ledger,
    pins: buildPins(deps, hooks, { ledger, view, machineStores, machineDeps }),
    queue,
    historyStore,
    machineStores,
    machineDeps,
    machine: new TransferMachine(machineDeps),
    heldStates,
    receiveLoop: buildReceive(deps, hooks, historyStore, heldStates, refreshView),
    requests: buildRequests(deps, hooks),
    restoreDeps: buildRestoreDeps(deps, machineDeps, machineStores, view),
  };
}

/** #737 pin lifecycle wiring (see select/pins.ts); the facade owns when it runs. */
function buildPins(
  deps: PaymentsFacadeDeps,
  hooks: FacadeHooks,
  parts: {
    ledger: ReservationLedger;
    view: InventoryView;
    machineStores: MachineStores;
    machineDeps: MachineDeps;
  }
): IntentPins {
  return new IntentPins({
    ledger: parts.ledger,
    openIntents: () => deriveOpenIntentHolds(parts.machineStores, parts.machineDeps.decryptPayload),
    isActive: (transferId) => hooks.isActiveOp(transferId),
    release: (tokenId) => {
      parts.view.release(tokenId);
    },
    changed: () => deps.emit('inventory:updated', {}),
  });
}

/** §5.1 restore protocol wiring (reseedAndReset's deps) — policy stays in the facade. */
function buildRestoreDeps(
  deps: PaymentsFacadeDeps,
  machineDeps: MachineDeps,
  machineStores: MachineStores,
  view: InventoryView
): RestoreDeps {
  return {
    stores: machineStores,
    kv: deps.kv,
    reput: (transferId, envelope, requiresSeedClose) =>
      machineDeps.intents.put(transferId, envelope, requiresSeedClose),
    reseedCheckpoint: (transferId, opIndex) => deps.checkpointStore.reseedCheckpoint(transferId, opIndex),
    decryptPayload: machineDeps.decryptPayload,
    fullRePull: () => view.onEpochReset(),
    attention: (transferId, code, detail) => {
      deps.emit(
        'transfer:attention',
        detail === undefined ? { transferId, code } : { transferId, code, detail }
      );
    },
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
    intents: {
      put: (transferId, envelope, requiresSeedClose) =>
        deps.client.putIntent(transferId, envelope, requiresSeedClose),
      listOpen: () => deps.client.listIntents('open'),
      abort: (transferId) => deps.client.abortIntent(transferId),
      complete: (transferId, signature) => deps.client.completeIntent(transferId, signature),
    },
    checkpointStore: deps.checkpointStore,
    kv: deps.kv,
    encryptPayload: async (payload) => encryptField(deps.fieldKey, JSON.stringify(payload)),
    decryptPayload: async (envelope) => JSON.parse(decryptField(deps.fieldKey, envelope)) as unknown,
    signComplete: deps.signComplete,
    ownPubkey: hexToBytes(deps.ownPubkey),
    // sphere#487: the same live getter Requests uses — the delivery envelope is
    // the recipient's ONLY source for the sender's Unicity ID.
    ...(deps.ownNametag !== undefined ? { ownNametag: deps.ownNametag } : {}),
    emit: deps.emit,
    now: deps.now ?? Date.now,
    recordHistory: async ({ transferId, payload, committedAmount }) => {
      await historyStore.recordSent({
        transferId,
        coinId: payload.coinId,
        // §5.9: the SETTLED amount (machine-computed from the certified
        // recipient blobs), never payload.amount — the plan.
        amount: committedAmount,
        recipientPubkey: payload.recipient,
        ...(payload.memo !== undefined ? { memo: payload.memo } : {}),
      });
    },
  };
}

function buildReceive(
  deps: PaymentsFacadeDeps,
  hooks: FacadeHooks,
  historyStore: History,
  heldStates: HeldStateCache,
  refreshView: () => void
): Receive {
  return new Receive({
    delivery: deps.deliveryPort,
    engine: () => hooks.engine(),
    view: {
      heldState: (tokenId) => heldStates.get(tokenId) ?? null,
      store: async (entry: StoredIncoming) => {
        heldStates.set(entry.tokenId, entry.stateHash);
      },
    },
    kv: deps.kv,
    registry: deps.registry,
    recordReceived: (record) => recordReceived(historyStore, record),
    emit: (event, transfer) => deps.emit(event, transfer),
    refreshView,
    attention: (transferId, code, detail) => {
      deps.emit(
        'transfer:attention',
        detail === undefined ? { transferId, code } : { transferId, code, detail }
      );
    },
    syncEpoch: deps.syncEpoch,
    // #770: the poll/wake drains Receive spawns itself must hold stop() too.
    track: hooks.track,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
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
