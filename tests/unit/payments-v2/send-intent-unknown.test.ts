// #835: a send whose durable intent the server may NOT hold. When PUT /v1/intents
// fails without proof that no row exists (anything but the #670 422), the machine
// keeps its backstop 'open' and the facade's in-process convergence (#677/#690)
// certifies and delivers the legs anyway — and a later failure on that path (the
// complete 404 for an intent that was never stored, GET /progress 404 for a split
// leg, a 5xx on complete, an ordinary coded leg failure) surfaced RAW, so the
// caller read "nothing left the wallet, safe to re-pay" for money already
// delivered (core/errors.ts isPossiblyCommittedSendOutcome).
//
// Every case asserts the CONTRACT, never one particular fix: a resolved send
// delivered exactly the amount; a clean rejection certified nothing; anything
// that may have certified rejects possibly-committed, carries its transferId and
// never emits transfer:updated{failed}. The retry cases then act as a caller that
// follows that contract (re-send only on a clean rejection) and assert the
// recipient is never paid twice.
//
// (g)–(r) pin the gate the fix puts in front of every engine op: nothing runs
// until a PUT of the stored envelope answered 2xx; two pre-write refusals (or one
// 413/422) are clean; any ambiguous answer HOLDS the send possibly-committed and
// the converger re-PUTs those same bytes and executes it under the same
// transferId; once a leg certified, no failure is ever clean.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isPossiblyCommittedSendOutcome, PartialSendConflictError, SphereError } from '../../../core/errors';
import { WalletApiHttpError } from '../../../impl/wallet-api-v2/http';
import { WalletApiSplitCheckpointStore } from '../../../impl/wallet-api-v2/checkpoints';
import type { TransferResult } from '../../../types';
import type {
  EngineOpOptions,
  SphereToken,
  SplitCheckpointStore,
  SplitParams,
  SplitResult,
  TransferParams,
} from '../../../token-engine';
import { CheckpointPersistFailedError, ProofUnconfirmedError, TransferConflictError } from '../../../token-engine/errors';
import * as MESSAGES from '../../../modules/payments-v2/send-errors';
import type { MachineStores } from '../../../modules/payments-v2/machine/journal';
import { STORE_KEYS, type IntentBackstopEntry, type ShortfallEntry } from '../../../modules/payments-v2/stores';
import { hexToBytes } from '../../../core/crypto';
import { logger } from '../../../core/logger';
import { RealizationEngine } from './machine-harness';
import {
  COIN,
  OWN_PUB,
  cleanupWorlds,
  eventsOf,
  flushTail,
  makeGate,
  makeWorld,
  ownCaller,
  peerCaller,
  type Gate,
  type PutCall,
  type World,
} from './facade-harness';
import { fakeSeedSignature } from './fakes/FakeWalletApi';

afterEach(cleanupWorlds);

// ── wire failures a PUT /v1/intents can end in without proving "no row" ─────
// Codes as impl/wallet-api-v2/http.ts produces them: the wallet-api envelope for
// the 429s (wallet-api src/lib/errors.ts), HTTP_<status> for a proxy's non-JSON
// 5xx body, NETWORK for fetchRaw's transport wrapper.
const PUT_FAILURES: readonly (readonly [string, () => WalletApiHttpError])[] = [
  ['429 QUOTA_EXCEEDED', () => new WalletApiHttpError(429, 'QUOTA_EXCEEDED', 'open intent cap reached')],
  ['429 RATE_LIMITED', () => new WalletApiHttpError(429, 'RATE_LIMITED', 'slow down', 1000)],
  ['502 HTTP_502', () => new WalletApiHttpError(502, 'HTTP_502', 'PUT /v1/intents failed with status 502')],
  ['503 HTTP_503', () => new WalletApiHttpError(503, 'HTTP_503', 'PUT /v1/intents failed with status 503')],
  ['0 NETWORK', () => new WalletApiHttpError(0, 'NETWORK', 'wallet-api request failed: connection reset')],
];

// Answers wallet-api raises BEFORE any write (ARCHITECTURE §16), with the number
// of PUTs the gate spends on them: two such answers with nothing ambiguous before
// prove no PUT of this fresh transferId stored a row; a 413/422 is deterministic
// on the stored bytes, so one is the verdict (#670) — a 413 from any hop (the one
// receiving the body answers it), a 422 only in wallet-api's envelope. AUTH_SUPERSEDED is the
// session's own 401, raised before the request leaves (impl/wallet-api-v2/session.ts).
const PRE_WRITE_REFUSALS: readonly (readonly [string, () => WalletApiHttpError, number])[] = [
  ['429 QUOTA_EXCEEDED', () => new WalletApiHttpError(429, 'QUOTA_EXCEEDED', 'open intent cap reached'), 2],
  ['429 RATE_LIMITED (Retry-After 60 s)', () => new WalletApiHttpError(429, 'RATE_LIMITED', 'slow down', 60_000), 2],
  ['401 AUTH_SUPERSEDED', () => new WalletApiHttpError(401, 'AUTH_SUPERSEDED', 'authentication superseded before completion'), 2],
  ['403 TLS_REQUIRED', () => new WalletApiHttpError(403, 'TLS_REQUIRED', 'PUT /v1/intents: TLS required'), 2],
  ['409 CONFLICT', () => new WalletApiHttpError(409, 'CONFLICT', 'PUT /v1/intents: an aborted intent re-opens only with its original payload'), 2],
  ['413 PAYLOAD_TOO_LARGE', () => new WalletApiHttpError(413, 'PAYLOAD_TOO_LARGE', 'PUT /v1/intents: request body is too large'), 1],
  ['422 VALIDATION_FAILED', () => new WalletApiHttpError(422, 'VALIDATION_FAILED', 'PUT /v1/intents: payload envelope refused'), 1],
  ["413 HTTP_413 (a hop's body limit)", () => new WalletApiHttpError(413, 'HTTP_413', 'PUT /v1/intents failed with status 413'), 1],
];

// Answers that prove nothing about the row: it may exist, or appear later. A 2xx
// other than wallet-api's 204, or whose body is not JSON (PROTOCOL), may not have
// reached it, or may have stored it. A 4xx proves "nothing
// written" only in wallet-api's own envelope: a page it did not write reads HTTP_<status>
// (an intermediary — a proxy's 403 or 429, or a 499 after it forwarded the request).
// 408 and 499 stay ambiguous even under a typed body: the status alone says so.
const AMBIGUOUS_ANSWERS: readonly (readonly [string, () => WalletApiHttpError])[] = [
  ['0 NETWORK', () => new WalletApiHttpError(0, 'NETWORK', 'wallet-api request failed: connection reset')],
  ['500 INTERNAL', () => new WalletApiHttpError(500, 'INTERNAL', 'PUT /v1/intents: internal server error')],
  ['502 HTTP_502', () => new WalletApiHttpError(502, 'HTTP_502', 'PUT /v1/intents failed with status 502')],
  ['503 SERVICE_UNAVAILABLE', () => new WalletApiHttpError(503, 'SERVICE_UNAVAILABLE', 'PUT /v1/intents: dependency unavailable')],
  ['504 HTTP_504', () => new WalletApiHttpError(504, 'HTTP_504', 'PUT /v1/intents failed with status 504')],
  ['408 HTTP_408', () => new WalletApiHttpError(408, 'HTTP_408', 'PUT /v1/intents failed with status 408')],
  ['200 PROTOCOL', () => new WalletApiHttpError(200, 'PROTOCOL', 'PUT /v1/intents: response is not JSON')],
  ['202 PROTOCOL (a 2xx other than 204)', () => new WalletApiHttpError(202, 'PROTOCOL', 'PUT /v1/intents: answered 202, not 204')],
  ["422 HTTP_422 (not wallet-api's envelope)", () => new WalletApiHttpError(422, 'HTTP_422', 'PUT /v1/intents failed with status 422')],
  ['429 HTTP_429 (an intermediary page)', () => new WalletApiHttpError(429, 'HTTP_429', 'PUT /v1/intents failed with status 429')],
  ['403 HTTP_403', () => new WalletApiHttpError(403, 'HTTP_403', 'PUT /v1/intents failed with status 403')],
  ['499 HTTP_499', () => new WalletApiHttpError(499, 'HTTP_499', 'PUT /v1/intents failed with status 499')],
  ['408 REQUEST_TIMEOUT (typed)', () => new WalletApiHttpError(408, 'REQUEST_TIMEOUT', 'PUT /v1/intents: request timed out')],
  ['499 CLIENT_CLOSED_REQUEST (typed)', () => new WalletApiHttpError(499, 'CLIENT_CLOSED_REQUEST', 'PUT /v1/intents: client closed request')],
];

const unavailable = (): WalletApiHttpError =>
  new WalletApiHttpError(503, 'SERVICE_UNAVAILABLE', 'PUT /v1/intents: dependency unavailable');
const networkDown = (): WalletApiHttpError =>
  new WalletApiHttpError(0, 'NETWORK', 'wallet-api request failed: connection reset');

/** The PUT dies BEFORE the fake server stores the row (request never landed). */
function failPutBeforeStoreOnce(world: World, make: () => Error): void {
  let fired = false;
  world.hooks.putIntent = async () => {
    if (fired) return;
    fired = true;
    throw make();
  };
}

/** The server STORES the row, then the response is lost (the client sees the error). */
function losePutResponseOnce(world: World, make: () => Error): void {
  const inner = world.innerClient;
  const store = inner.putIntent.bind(inner);
  let fired = false;
  inner.putIntent = async (transferId, payloadEnvelope, requiresSeedClose) => {
    await store(transferId, payloadEnvelope, requiresSeedClose);
    if (fired) return;
    fired = true;
    throw make();
  };
}

/** POST /v1/intents/<id>/complete answers `make()` once, before the server acts on it. */
function failCompleteOnce(world: World, make: () => Error): void {
  let fired = false;
  world.hooks.complete = async () => {
    if (fired) return;
    fired = true;
    throw make();
  };
}

/** Every PUT /v1/intents fails before the server stores anything; returns what was thrown, in order. */
function failEveryPut(world: World, make: () => Error): Error[] {
  const thrown: Error[] = [];
  world.hooks.putIntent = async () => {
    const err = make();
    thrown.push(err);
    throw err;
  };
  return thrown;
}

/** The server STORES every PUT, then every response is lost, until `heal()`. */
function loseEveryPutResponse(world: World, make: () => Error): { heal(): void } {
  const inner = world.innerClient;
  const store = inner.putIntent.bind(inner);
  let lost = true;
  inner.putIntent = async (transferId, payloadEnvelope, requiresSeedClose) => {
    await store(transferId, payloadEnvelope, requiresSeedClose);
    if (lost) throw make();
  };
  return {
    heal: () => {
      lost = false;
    },
  };
}

/** Every POST …/abort the facade issues, in order (the call still reaches the server). */
function recordAborts(world: World): string[] {
  const aborts: string[] = [];
  world.hooks.abort = async (transferId) => {
    aborts.push(transferId);
  };
  return aborts;
}

// ── observation helpers ──────────────────────────────────────────────────────

type Settled =
  | { readonly kind: 'resolved'; readonly result: TransferResult }
  | { readonly kind: 'rejected'; readonly error: unknown };

async function settle(op: Promise<TransferResult>): Promise<Settled> {
  try {
    return { kind: 'resolved', result: await op };
  } catch (error) {
    return { kind: 'rejected', error };
  }
}

function rejectionOf(outcome: Settled): unknown {
  expect(outcome.kind, 'the send rejects').toBe('rejected');
  return outcome.kind === 'rejected' ? outcome.error : undefined;
}

/** What the recipient's mailbox holds: entries, and their summed COIN value. */
async function receipts(world: World): Promise<{ entries: number; amount: bigint }> {
  const { entries } = await world.api.listMailbox(peerCaller, 0);
  let amount = 0n;
  for (const entry of entries) {
    for (const asset of entry.assets) if (asset.coinId === COIN) amount += BigInt(asset.amount);
  }
  return { entries: entries.length, amount };
}

function failedUpdates(world: World): TransferResult[] {
  return (eventsOf(world, 'transfer:updated') as TransferResult[]).filter((u) => u.status === 'failed');
}

function chainOps(world: World): number {
  return world.engine.transferCalls.length + world.engine.splitCalls.length;
}

/** Distinct transferIds the engine ran an op under (op keys are `<transferId>:<opIndex>`). */
function engineOpIds(world: World): string[] {
  const keys = [...world.engine.transferCalls, ...world.engine.splitCalls].map((call) => call.key);
  return [...new Set(keys.map((key) => key.slice(0, key.lastIndexOf(':'))))];
}

/** Distinct transferIds the facade planned an attempt under, in order (each attempt PUTs first). */
function plannedIds(world: World): string[] {
  return [...new Set(world.putCalls.map((call) => call.transferId))];
}

function putCallsFor(world: World, transferId: string): PutCall[] {
  return world.putCalls.filter((call) => call.transferId === transferId);
}

/** Every PUT carried the stored bytes and seal flag — a re-PUT is never a re-encryption. */
function expectIdenticalPuts(calls: readonly PutCall[], stored: { payloadEnvelope: string; requiresSeedClose: boolean }): void {
  for (const call of calls) {
    expect(call.envelope, 'a re-PUT carries the stored envelope, byte for byte').toBe(stored.payloadEnvelope);
    expect(call.requiresSeedClose).toBe(stored.requiresSeedClose);
  }
}

/** Read off the backing map, so an armed KV read fault never hides what is stored. */
function storedList<T>(world: World, key: string): T[] {
  return (world.kv.map.get(key) as T[] | undefined) ?? [];
}

function backstopOf(world: World, transferId: string): IntentBackstopEntry | undefined {
  return storedList<IntentBackstopEntry>(world, STORE_KEYS.intentBackstop).find((e) => e.transferId === transferId);
}

/** #835's PUT marker. */
function intentPutOf(entry: IntentBackstopEntry | undefined): string | undefined {
  return entry?.intentPut;
}

function shortfallOf(world: World, transferId: string): ShortfallEntry | undefined {
  return storedList<ShortfallEntry>(world, STORE_KEYS.shortfalls).find((e) => e.transferId === transferId);
}

function serverIntent(world: World, transferId: string): string | undefined {
  return world.api.inspectIntent(ownCaller, transferId)?.status;
}

function tokenStatus(world: World, tokenId: string): string | undefined {
  return world.facade.tokens().find((t) => t.id === tokenId)?.status;
}

type MessageName = 'INTENT_UNCONFIRMED_MESSAGE' | 'NOT_FENCED_MESSAGE' | 'CANCEL_UNCONFIRMED_MESSAGE';

function expectMessage(err: unknown, name: MessageName): void {
  expect((err as Error).message).toBe(MESSAGES[name]);
}

/** A payment request from the peer, drained into this wallet and payable. */
async function incomingRequest(world: World, amount: bigint): Promise<string> {
  const wire = await world.api.createRequest(peerCaller, {
    toPubkey: OWN_PUB,
    assets: [{ coinId: COIN, amount: amount.toString() }],
  });
  await world.facade.requests.drainIncoming();
  expect(requestStatus(world, wire.id)).toBe('pending');
  return wire.id;
}

function requestStatus(world: World, id: string): string | undefined {
  return world.facade.requests.list().find((r) => r.id === id)?.status;
}

/** The request as its REQUESTER sees it on the server (status + linked transferId). */
async function requesterRow(world: World, id: string): Promise<{ status: string; transferId: string | null } | undefined> {
  return (await world.api.listRequests(peerCaller, { role: 'outgoing' })).requests.find((r) => r.id === id);
}

function describeError(err: unknown): string {
  if (err === null || typeof err !== 'object') return String(err);
  const e = err as { name?: unknown; code?: unknown; status?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? ` ${String(e.status)}` : '';
  return `${String(e.name)}${status} ${String(e.code)} (${String(e.message)})`;
}

/**
 * A clean rejection promises more than "nothing moved yet": nothing of the
 * attempt can EVER execute (#835 I2). No runnable backstop entry, no server row
 * anyone could resume, nothing left reserved — and an epoch reseed (which
 * re-PUTs every open entry) plus a convergence pass still move nothing.
 */
async function expectCleanLeavesNothing(world: World): Promise<void> {
  const failed = failedUpdates(world);
  const last = failed[failed.length - 1];
  expect(last, 'a clean rejection emits transfer:updated{failed} naming its attempt').toBeDefined();
  const id = last!.id;
  const entry = backstopOf(world, id);
  expect(
    entry === undefined || entry.disposition === 'abortPending',
    `no runnable backstop entry is left for ${id}: ${JSON.stringify(entry)}`
  ).toBe(true);
  const row = (): string | undefined => serverIntent(world, id);
  expect([undefined, 'aborted'], 'no server row of a clean rejection can be resumed').toContain(row());
  expect(
    world.facade.tokens().filter((t) => t.status === 'transferring').map((t) => t.id),
    'a clean rejection leaves nothing reserved'
  ).toEqual([]);
  expect(world.facade.coinless().filter((t) => t.transferring).map((t) => t.tokenId)).toEqual([]);

  const paid = await receipts(world);
  const ops = chainOps(world);
  await world.facade.handleEpochChange('e2');
  await world.facade.resumeNow();
  await flushTail();
  expect(await receipts(world), 'an epoch reseed and a convergence pass moved nothing').toEqual(paid);
  expect(chainOps(world)).toBe(ops);
  expect([undefined, 'aborted']).toContain(row());
}

/**
 * The #835 contract on one send() outcome:
 *  - resolved → the recipient holds exactly `amount`, and nothing said 'failed';
 *  - rejected clean → nothing certified, nothing reached the recipient, and
 *    nothing of the attempt can ever run;
 *  - otherwise → possibly-committed, with its transferId, and no 'failed' event.
 */
async function expectHonestOutcome(world: World, outcome: Settled, amount: bigint): Promise<void> {
  await flushTail();
  const paid = await receipts(world);
  const failed = failedUpdates(world);
  if (outcome.kind === 'resolved') {
    expect(paid.amount, 'a resolved send delivered exactly the amount').toBe(amount);
    expect(failed, 'a resolved send never emits transfer:updated{failed}').toEqual([]);
    return;
  }
  const err = outcome.error;
  const moved = paid.entries > 0 || chainOps(world) > 0;
  if (!moved) {
    // A clean rejection that kept its promise — and keeps it.
    await expectCleanLeavesNothing(world);
    return;
  }
  expect(
    isPossiblyCommittedSendOutcome(err),
    `${String(paid.amount)} units reached the recipient over ${String(chainOps(world))} chain op(s), yet send() ` +
      `rejected with ${describeError(err)} — a clean failure tells the caller nothing left the wallet`
  ).toBe(true);
  // '' is not an id anything can converge on (partialize falls back to it).
  expect(
    (err as SphereError).transferId,
    'a possibly-committed rejection carries the transferId the caller converges on'
  ).toMatch(/^.+$/);
  expect(failed, 'no transfer:updated{failed} once anything may have certified').toEqual([]);
}

/**
 * A caller that follows the contract: re-sends ONLY after a clean rejection,
 * then lets convergence run (resumeNow is the only retry verb for the rest).
 */
async function followContract(world: World, first: Settled, request: Parameters<World['facade']['send']>[0]): Promise<void> {
  if (first.kind === 'rejected' && !isPossiblyCommittedSendOutcome(first.error)) {
    await settle(world.facade.send(request));
  }
  await world.facade.resumeNow();
  await flushTail();
}

async function expectPaidAtMostOnce(world: World, amount: bigint): Promise<void> {
  const paid = await receipts(world);
  expect(
    paid.amount,
    `the recipient was owed ${String(amount)} once and holds ${String(paid.amount)} over ${String(paid.entries)} deliveries`
  ).toBeLessThanOrEqual(amount);
}

/**
 * start() never awaits its own convergence pass, and resumeNow() coalesces onto a
 * pass in flight. A case that counts passes after a hold waits that one out first,
 * so its first resumeNow() is a pass of its own.
 */
async function startSettled(world: World): Promise<void> {
  await world.facade.start();
  await world.facade.resumeNow();
}

// ── engines ──────────────────────────────────────────────────────────────────

/** Every transfer of a named source fails with an ordinary coded error, every attempt. */
class LegFailureEngine extends RealizationEngine {
  readonly failSources = new Set<string>();
  /** Runs as a named leg fails: after the PUT gate acked, before the machine disposes of the attempt. */
  onFail: (() => void) | null = null;

  override async transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    if (this.failSources.has(params.token.blob.tokenId)) {
      this.onFail?.();
      throw new SphereError('the aggregator refused the transfer (simulated)', 'TRANSFER_FAILED');
    }
    return super.transfer(params, options);
  }
}

/** A named source's leg ends without an inclusion proof: the submit may have certified. */
class UnconfirmedLegEngine extends LegFailureEngine {
  /** Every attempt of these sources is unconfirmed. */
  readonly unconfirmedSources = new Set<string>();
  /** Only the SECOND attempt is — the in-process re-certification of a leg run() already delivered. */
  readonly unconfirmedOnSecondCall = new Set<string>();
  /** Every attempt after the first is: no re-certification of these legs ever confirms. */
  readonly unconfirmedAfterFirstCall = new Set<string>();
  private readonly calls = new Map<string, number>();

  /** How many times this source's leg reached the engine, unconfirmed attempts included. */
  submits(tokenId: string): number {
    return this.calls.get(tokenId) ?? 0;
  }

  override async transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    const tokenId = params.token.blob.tokenId;
    const call = (this.calls.get(tokenId) ?? 0) + 1;
    this.calls.set(tokenId, call);
    const recertify = (call === 2 && this.unconfirmedOnSecondCall.has(tokenId)) || (call > 1 && this.unconfirmedAfterFirstCall.has(tokenId));
    if (this.unconfirmedSources.has(tokenId) || recertify) {
      throw new ProofUnconfirmedError('no inclusion proof before the deadline (simulated)');
    }
    return super.transfer(params, options);
  }
}

/**
 * Models the REAL engine's E.4 split path against the server (SphereTokenEngine
 * .resolveBurntToken): the checkpoint is read with GET /v1/intents/<id>/progress
 * BEFORE any burn, and persisted with POST …/progress after it — through the
 * production WalletApiSplitCheckpointStore over the fake server, so an intent
 * the server never stored answers 404 exactly as wallet-api does. The facade
 * harness's in-memory checkpoint store cannot model that (it returns null).
 */
class ProgressBackedEngine extends RealizationEngine {
  checkpoints: SplitCheckpointStore | null = null;

  override async split(params: SplitParams, options?: EngineOpOptions): Promise<SplitResult> {
    const store = this.checkpoints;
    if (store === null || options?.transferId === undefined) return super.split(params, options);
    const opIndex = options.opIndex ?? 0;
    await store.get(options.transferId, opIndex);
    const result = await super.split(params, options);
    try {
      await store.put(options.transferId, opIndex, new TextEncoder().encode(`burn:${options.transferId}`));
    } catch (err) {
      throw new CheckpointPersistFailedError('split burn certified but its checkpoint could not be persisted', err);
    }
    return result;
  }
}

function progressBackedWorld(): World & { engine: ProgressBackedEngine } {
  const engine = new ProgressBackedEngine({ chainPubkey: hexToBytes(OWN_PUB) });
  const world = makeWorld({ engine });
  engine.checkpoints = new WalletApiSplitCheckpointStore({
    client: world.innerClient,
    kv: world.kv,
    fieldKey: new Uint8Array(32).fill(9),
    signProgress: (message) => fakeSeedSignature(OWN_PUB, message),
  });
  return world as World & { engine: ProgressBackedEngine };
}

// ── (a) PUT fails before the server stores the intent ───────────────────────

describe('#835 (a) PUT /v1/intents fails before the row is stored — one direct leg', () => {
  it.each(PUT_FAILURES)(
    '%s: the send either certifies nothing and fails clean, or reports possibly-committed — never a clean failure for delivered money',
    async (_label, make) => {
      const world = makeWorld();
      await world.seed(100n);
      await world.facade.start();
      failPutBeforeStoreOnce(world, make);

      const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

      await expectHonestOutcome(world, outcome, 100n);
    }
  );

  it.each(PUT_FAILURES)(
    '%s: a caller that re-sends only after a clean rejection never pays the recipient twice',
    async (_label, make) => {
      const world = makeWorld();
      await world.seed(100n);
      await world.seed(100n); // enough for the re-send to find a second source
      await world.facade.start();
      failPutBeforeStoreOnce(world, make);
      const request = { recipient: '@peer', amount: '100', coinId: COIN };

      const first = await settle(world.facade.send(request));
      await followContract(world, first, request);

      await expectPaidAtMostOnce(world, 100n);
    }
  );
});

// ── (b) PUT stored, response lost ───────────────────────────────────────────

describe('#835 (b) PUT /v1/intents stores the row, then the response is lost', () => {
  it.each(PUT_FAILURES)(
    '%s: the send is neither lost nor double-paid — it resolves with one delivery or reports possibly-committed',
    async (_label, make) => {
      const world = makeWorld();
      const token = await world.seed(100n);
      await world.facade.start();
      losePutResponseOnce(world, make);

      const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

      await expectHonestOutcome(world, outcome, 100n);
      if (outcome.kind === 'resolved') {
        const { entries } = await world.api.listMailbox(peerCaller, 0);
        expect(entries.map((e) => e.tokenId)).toEqual([token.blob.tokenId]);
      }
    }
  );

  it.each(PUT_FAILURES)(
    '%s: a contract-following caller plus convergence still pays exactly once',
    async (_label, make) => {
      const world = makeWorld();
      await world.seed(100n);
      await world.seed(100n);
      await world.facade.start();
      losePutResponseOnce(world, make);
      const request = { recipient: '@peer', amount: '100', coinId: COIN };

      const first = await settle(world.facade.send(request));
      await followContract(world, first, request);

      await expectPaidAtMostOnce(world, 100n);
    }
  );
});

// ── (c) the same PUT failure through requests.pay() ─────────────────────────

describe('#835 (c) requests.pay() over a PUT that fails before the row is stored', () => {
  it.each(PUT_FAILURES)(
    '%s: a request whose payment reached the requester never becomes payable again',
    async (_label, make) => {
      const world = makeWorld();
      await world.seed(100n);
      await world.seed(100n);
      await world.facade.start();
      const wire = await world.api.createRequest(peerCaller, {
        toPubkey: OWN_PUB,
        assets: [{ coinId: COIN, amount: '100' }],
      });
      await world.facade.requests.drainIncoming();
      expect(world.facade.requests.list().find((r) => r.id === wire.id)?.status).toBe('pending');
      failPutBeforeStoreOnce(world, make);

      const first = await settle(world.facade.requests.pay(wire.id));
      await flushTail();

      const paid = await receipts(world);
      const status = world.facade.requests.list().find((r) => r.id === wire.id)?.status;
      if (paid.entries > 0) {
        expect(
          status,
          `the requester already holds ${String(paid.amount)} for this request, yet pay() ` +
            `${first.kind === 'rejected' ? `rejected with ${describeError(first.error)}` : 'resolved'} and the request reads '${String(status)}'`
        ).not.toBe('pending');
      }

      // The UI offers "Pay" again only while the request reads pending.
      if (status === 'pending') await settle(world.facade.requests.pay(wire.id));
      await world.facade.resumeNow();
      await flushTail();

      await expectPaidAtMostOnce(world, 100n);
    }
  );
});

// ── (d) a later leg fails with an ordinary coded error, no PUT failure ──────

describe('#835 (d) multi-leg send: one leg delivers, the other fails with an ordinary coded error', () => {
  it('the rejection is possibly-committed with its transferId, and nothing says failed', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const a = await world.seed(50n);
    const b = await world.seed(50n);
    engine.failSources.add(b.blob.tokenId);
    await world.facade.start();

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    await flushTail();

    const { entries } = await world.api.listMailbox(peerCaller, 0);
    expect(entries.map((e) => e.tokenId), 'the healthy leg reached the recipient').toEqual([a.blob.tokenId]);
    expect(outcome.kind).toBe('rejected');
    await expectHonestOutcome(world, outcome, 100n);
  });

  it('a caller that re-sends only after a clean rejection never pays more than the amount', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    await world.seed(50n);
    const b = await world.seed(50n);
    await world.seed(30n); // a re-send can cover 100 from these two without b
    await world.seed(70n);
    engine.failSources.add(b.blob.tokenId);
    await world.facade.start();
    const request = { recipient: '@peer', amount: '100', coinId: COIN };

    const first = await settle(world.facade.send(request));
    await followContract(world, first, request);

    await expectPaidAtMostOnce(world, 100n);
  });
});

// ── (e) the in-process convergence path fails AFTER delivery ────────────────

describe('#835 (e) a failure after delivery on the in-process convergence path', () => {
  it('PUT response lost, then complete answers 503 once: the delivered send is not reported as a clean failure', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    losePutResponseOnce(world, () => new WalletApiHttpError(503, 'HTTP_503', 'PUT /v1/intents failed with status 503'));
    failCompleteOnce(world, () => new WalletApiHttpError(503, 'HTTP_503', 'complete failed with status 503'));

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

    await expectHonestOutcome(world, outcome, 100n);
  });

  it('a conflicted leg after a delivered one, then complete answers 503 once: the shortfall is not reported as a clean failure', async () => {
    const world = makeWorld();
    const a = await world.seed(60n);
    const b = await world.seed(40n);
    await world.engine.foreignSpend(b);
    await world.facade.start();
    failCompleteOnce(world, () => new WalletApiHttpError(503, 'HTTP_503', 'complete failed with status 503'));

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    await flushTail();

    const { entries } = await world.api.listMailbox(peerCaller, 0);
    expect(entries.map((e) => e.tokenId), 'the unconflicted leg reached the recipient').toEqual([a.blob.tokenId]);
    await expectHonestOutcome(world, outcome, 100n);
  });

  it('a conflicted leg after a delivered one, then the shortfall write fails: not reported as a clean failure', async () => {
    const world = makeWorld();
    const a = await world.seed(60n);
    const b = await world.seed(40n);
    await world.engine.foreignSpend(b);
    await world.facade.start();
    world.kv.failWriteKeys.add(STORE_KEYS.shortfalls);

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    await flushTail();

    const { entries } = await world.api.listMailbox(peerCaller, 0);
    expect(entries.map((e) => e.tokenId), 'the unconflicted leg reached the recipient').toEqual([a.blob.tokenId]);
    await expectHonestOutcome(world, outcome, 100n);
  });
});

// ── (f) mixed direct + split, PUT fails before the row is stored ────────────

describe('#835 (f) direct + split send over a PUT that fails before the row is stored', () => {
  it('harness: the progress-backed split model round-trips on a healthy send', async () => {
    const world = progressBackedWorld();
    await world.seed(50n);
    await world.seed(200n);
    await world.facade.start();

    const result = await world.facade.send({ recipient: '@peer', amount: '120', coinId: COIN });
    await flushTail();

    expect(result.status).toBe('delivered');
    expect(result.tokenTransfers.map((t) => t.method).sort()).toEqual(['direct', 'split']);
    expect((await receipts(world)).amount).toBe(120n);
    expect(world.api.inspectIntent(ownCaller, result.id)?.status).toBe('completed');
  });

  it.each(PUT_FAILURES)(
    '%s: GET /progress 404s for the unknown intent — the delivered direct leg is not reported as a clean failure',
    async (_label, make) => {
      const world = progressBackedWorld();
      await world.seed(50n);
      await world.seed(200n);
      await world.facade.start();
      failPutBeforeStoreOnce(world, make);

      const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '120', coinId: COIN }));

      await expectHonestOutcome(world, outcome, 120n);
    }
  );
});

// ── (g) the PUT is refused before any write, on every attempt ───────────────

describe('#835 (g) PUT /v1/intents refused before any write, on every attempt', () => {
  it.each(PRE_WRITE_REFUSALS)(
    '%s: send() rejects clean with that refusal, runs nothing, and leaves nothing that can run',
    async (_label, make, puts) => {
      const world = makeWorld();
      const token = await world.seed(100n);
      await world.facade.start();
      const thrown = failEveryPut(world, make);

      const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

      expect(chainOps(world), 'no engine op runs before a PUT of the intent answered 2xx').toBe(0);
      expect((await receipts(world)).entries).toBe(0);
      const err = rejectionOf(outcome);
      expect(err, 'the refusal itself is the verdict').toBe(thrown[thrown.length - 1]);
      expect(isPossiblyCommittedSendOutcome(err)).toBe(false);
      expect(failedUpdates(world)).toHaveLength(1);
      expect(world.counters.putIntent, 'a 413/422 is final on these bytes; any other refusal is confirmed once').toBe(puts);
      expect(backstopOf(world, 'tid-1'), 'a refused attempt leaves no backstop entry').toBeUndefined();
      expect(serverIntent(world, 'tid-1')).toBeUndefined();
      expect(tokenStatus(world, token.blob.tokenId), 'the source is spendable again').toBe('confirmed');
      await expectCleanLeavesNothing(world);
    }
  );

  it.each(PRE_WRITE_REFUSALS)(
    '%s: requests.pay() rejects clean and the request stays payable',
    async (_label, make, puts) => {
      const world = makeWorld();
      await world.seed(100n);
      await world.facade.start();
      const id = await incomingRequest(world, 100n);
      const thrown = failEveryPut(world, make);

      const outcome = await settle(world.facade.requests.pay(id));
      await flushTail();

      expect(chainOps(world)).toBe(0);
      expect((await receipts(world)).entries).toBe(0);
      const err = rejectionOf(outcome);
      expect(err).toBe(thrown[thrown.length - 1]);
      expect(isPossiblyCommittedSendOutcome(err)).toBe(false);
      expect(world.counters.putIntent).toBe(puts);
      expect(requestStatus(world, id), 'nothing was paid, so the request is payable again').toBe('pending');
      expect((await requesterRow(world, id))?.status).toBe('open');
    }
  );

  it.each(PRE_WRITE_REFUSALS.filter(([label]) => label.startsWith('429 QUOTA') || label.startsWith('422')))(
    '%s whose backstop cleanup write fails: still clean, and the leftover entry never runs',
    async (_label, make, puts) => {
      const world = makeWorld();
      const token = await world.seed(100n);
      await world.facade.start();
      const thrown: Error[] = [];
      world.hooks.putIntent = async () => {
        // Armed after the upsert: only the refusal's own cleanup write can fail.
        world.kv.failWriteKeys.add(STORE_KEYS.intentBackstop);
        const err = make();
        thrown.push(err);
        throw err;
      };

      const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

      expect(chainOps(world), 'a refused attempt never converges in-process off its leftover entry').toBe(0);
      const err = rejectionOf(outcome);
      expect(err, 'the wire refusal is the verdict, never the local KV error').toBe(thrown[thrown.length - 1]);
      expect(isPossiblyCommittedSendOutcome(err)).toBe(false);
      expect(failedUpdates(world)).toHaveLength(1);
      const leftover = backstopOf(world, 'tid-1');
      expect(leftover?.disposition, 'the removal failed: the entry is still there').toBe('open');
      expect(intentPutOf(leftover), 'an entry whose PUT never answered 2xx is inert').toBe('pending');

      world.kv.failWriteKeys.delete(STORE_KEYS.intentBackstop);
      await world.facade.handleEpochChange('e2');
      await world.facade.resumeNow();
      await flushTail();

      expect(putCallsFor(world, 'tid-1'), 'the epoch reseed never re-PUTs a refused attempt').toHaveLength(puts);
      expect(serverIntent(world, 'tid-1')).toBeUndefined();
      expect(chainOps(world)).toBe(0);
      expect((await receipts(world)).entries).toBe(0);
      expect(backstopOf(world, 'tid-1'), 'the next pass sweeps the inert entry (S1)').toBeUndefined();
      expect(tokenStatus(world, token.blob.tokenId)).toBe('confirmed');
    }
  );
});

// ── (h) every PUT answer is ambiguous: the send is HELD ─────────────────────

describe('#835 (h) PUT /v1/intents answers ambiguously on every attempt', () => {
  it.each(AMBIGUOUS_ANSWERS)(
    '%s: the send is held possibly-committed, runs nothing, and converges once the service answers',
    async (_label, make) => {
      const world = makeWorld();
      const token = await world.seed(100n);
      await startSettled(world);
      const thrown = failEveryPut(world, make);

      const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

      expect(chainOps(world), 'no engine op runs before a PUT of the intent answered 2xx').toBe(0);
      const err = rejectionOf(outcome) as SphereError;
      expect(err).toBeInstanceOf(SphereError);
      expect(err.code, describeError(err)).toBe('SEND_SYNC_PENDING');
      expect(err.transferId).toBe('tid-1');
      expect(err.cause, 'the last answer rides as the cause').toBe(thrown[thrown.length - 1]);
      expectMessage(err, 'INTENT_UNCONFIRMED_MESSAGE');
      expect(failedUpdates(world)).toEqual([]);
      expect(world.counters.putIntent, 'the PUT and two immediate re-PUTs').toBe(3);
      const held = backstopOf(world, 'tid-1');
      expect(held?.disposition).toBe('open');
      expect(intentPutOf(held)).toBe('unconfirmed');
      expect(putCallsFor(world, 'tid-1')).toHaveLength(3);
      expectIdenticalPuts(putCallsFor(world, 'tid-1'), held!);
      const pending = await world.facade.pendingTransfers();
      expect(pending.map((p) => [p.transferId, p.kind])).toEqual([['tid-1', 'open']]);
      expect(tokenStatus(world, token.blob.tokenId), 'a held send keeps its source').toBe('transferring');

      delete world.hooks.putIntent;
      await world.facade.resumeNow();
      await flushTail();

      expect(putCallsFor(world, 'tid-1'), 'the pass re-PUTs the held intent first').toHaveLength(4);
      expectIdenticalPuts(putCallsFor(world, 'tid-1'), held!);
      expect(await receipts(world), 'the confirming pass also runs it').toEqual({ entries: 1, amount: 100n });

      await world.facade.resumeNow();
      await flushTail();

      expect(putCallsFor(world, 'tid-1'), 'nothing re-PUTs a converged intent').toHaveLength(4);
      expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
      expect(serverIntent(world, 'tid-1')).toBe('completed');
      expect(backstopOf(world, 'tid-1')).toBeUndefined();
    }
  );

  it('(h-pay) through requests.pay(): the request reads settling while held, and paid once it converged', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    const id = await incomingRequest(world, 100n);
    failEveryPut(world, unavailable);

    const outcome = await settle(world.facade.requests.pay(id));

    expect(chainOps(world)).toBe(0);
    const err = rejectionOf(outcome) as SphereError;
    expect(err.code, describeError(err)).toBe('SEND_SYNC_PENDING');
    expect(err.transferId).toBe('tid-1');
    expect(requestStatus(world, id), 'a held payment is never payable again').toBe('settling');

    delete world.hooks.putIntent;
    await world.facade.resumeNow();
    await flushTail();

    expect(requestStatus(world, id), 'confirmed and run by the same pass').toBe('paid');
    const row = await requesterRow(world, id);
    expect(row?.status).toBe('paid');
    expect(row?.transferId).toBe('tid-1');
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
  });

  it('(h-landed) the server stored the row but every answer was lost: held, then run by the very next pass', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    const wire = loseEveryPutResponse(world, networkDown);

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

    expect(chainOps(world)).toBe(0);
    const err = rejectionOf(outcome) as SphereError;
    expect(err.code, describeError(err)).toBe('SEND_SYNC_PENDING');
    expect(err.transferId).toBe('tid-1');
    expect(serverIntent(world, 'tid-1'), 'the row landed despite every lost answer').toBe('open');
    expect(putCallsFor(world, 'tid-1')).toHaveLength(3);

    wire.heal();
    await world.facade.resumeNow();
    await flushTail();

    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    expect(putCallsFor(world, 'tid-1'), 'a listed row needs no re-PUT').toHaveLength(3);
    expect(serverIntent(world, 'tid-1')).toBe('completed');
    expect(backstopOf(world, 'tid-1')).toBeUndefined();
  });

  it('(h-restart) a held send survives a restart: the new facade re-PUTs the stored bytes, then runs it once', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    failEveryPut(world, networkDown);
    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    expect((rejectionOf(outcome) as SphereError).code).toBe('SEND_SYNC_PENDING');
    const held = backstopOf(world, 'tid-1');
    expect(intentPutOf(held)).toBe('unconfirmed');
    await world.facade.stop();

    const restarted = makeWorld({ restartOf: world });
    restarted.innerClient.copyBlobIndexFrom(world.innerClient);
    await restarted.facade.start();
    await restarted.facade.resumeNow();
    await restarted.facade.resumeNow();
    await flushTail();

    expect(putCallsFor(restarted, 'tid-1').length, 'the restarted facade re-PUT the held intent').toBeGreaterThan(0);
    expectIdenticalPuts(putCallsFor(restarted, 'tid-1'), held!);
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    expect(serverIntent(world, 'tid-1')).toBe('completed');
    expect(backstopOf(world, 'tid-1')).toBeUndefined();
  });

  it('(h-422) a held payment whose re-PUT is refused 422 stays held: its timed-out PUT may still land, and then it pays exactly once', async () => {
    const world = makeWorld();
    const token = await world.seed(100n);
    await startSettled(world);
    const id = await incomingRequest(world, 100n);
    failEveryPut(world, networkDown);
    const outcome = await settle(world.facade.requests.pay(id));
    expect((rejectionOf(outcome) as SphereError).code).toBe('SEND_SYNC_PENDING');
    expect(requestStatus(world, id)).toBe('settling');

    const refusals = failEveryPut(
      world,
      () => new WalletApiHttpError(422, 'VALIDATION_FAILED', 'PUT /v1/intents: payload envelope refused')
    );
    await world.facade.resumeNow();
    await flushTail();

    expect(refusals, 'one re-PUT, refused on the bytes').toHaveLength(1);
    const held = backstopOf(world, 'tid-1');
    expect(intentPutOf(held), 'no absence proves the earlier PUT dead: still held').toBe('unconfirmed');
    expect(serverIntent(world, 'tid-1')).toBeUndefined();
    expect(requestStatus(world, id), 'never payable again while the held send can still pay').toBe('settling');
    expect(tokenStatus(world, token.blob.tokenId)).toBe('transferring');
    expect(chainOps(world)).toBe(0);

    // The PUT that timed out lands after all: the listing confirms the hold, and it pays once.
    await world.api.putIntent(ownCaller, { transferId: 'tid-1', payload: held!.payloadEnvelope });
    delete world.hooks.putIntent;
    await world.facade.resumeNow();
    await flushTail();

    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    expect(requestStatus(world, id)).toBe('paid');
    expect(backstopOf(world, 'tid-1')).toBeUndefined();
  });

  it('(h-stale) a pass judging a snapshot from before the hold never sweeps the held entry', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    failEveryPut(world, unavailable);
    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    expect((rejectionOf(outcome) as SphereError).code).toBe('SEND_SYNC_PENDING');
    expect(intentPutOf(backstopOf(world, 'tid-1'))).toBe('unconfirmed');
    // The backstop list as the attempt wrote it, before the hold was recorded.
    const prePark = world.kv.sets
      .filter((set) => set.key === STORE_KEYS.intentBackstop)
      .map((set) => set.value as IntentBackstopEntry[])
      .filter((list) => {
        const entry = list.find((e) => e.transferId === 'tid-1');
        return entry !== undefined && intentPutOf(entry) !== 'unconfirmed';
      })
      .pop();
    expect(prePark, 'the pre-hold backstop write').toBeDefined();
    await world.facade.stop();

    // A fresh process: nothing in memory says the send is held, only the store.
    const restarted = makeWorld({ restartOf: world });
    restarted.innerClient.copyBlobIndexFrom(world.innerClient);
    failEveryPut(restarted, unavailable);
    await restarted.facade.start();
    await restarted.facade.resumeNow();
    expect(intentPutOf(backstopOf(world, 'tid-1')), 'a failed re-PUT keeps the hold').toBe('unconfirmed');

    let staleNext = false;
    let served = false;
    let armed = true; // only the pass's own judging read is stale; later reads see the store as it is
    restarted.hooks.listOpen = async () => {
      if (!armed) return;
      armed = false;
      staleNext = true;
    };
    const get = restarted.kv.get.bind(restarted.kv);
    restarted.kv.get = async <T>(key: string): Promise<T | null> => {
      if (staleNext && key === STORE_KEYS.intentBackstop) {
        staleNext = false;
        served = true;
        return JSON.parse(JSON.stringify(prePark)) as T;
      }
      return get<T>(key);
    };
    await restarted.facade.resumeNow();
    await flushTail();

    expect(served, 'the pass judged the pre-hold snapshot').toBe(true);
    const kept = backstopOf(world, 'tid-1');
    expect(kept?.disposition, 'a removal is judged against the CURRENT entry, never the snapshot').toBe('open');
    expect(intentPutOf(kept)).toBe('unconfirmed');

    delete restarted.hooks.listOpen;
    delete restarted.hooks.putIntent;
    await restarted.facade.resumeNow();
    await restarted.facade.resumeNow();
    await flushTail();
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
  });

  it('(h-kvfail) the hold cannot be written: still possibly-committed, and the same facade converges it', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    world.hooks.putIntent = async () => {
      // Armed after the upsert: only the hold's own patch can fail.
      world.kv.failWriteKeys.add(STORE_KEYS.intentBackstop);
      throw unavailable();
    };

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

    expect(chainOps(world)).toBe(0);
    const err = rejectionOf(outcome) as SphereError;
    expect(err.code, describeError(err)).toBe('SEND_SYNC_PENDING');
    expect(err.transferId).toBe('tid-1');
    expect(failedUpdates(world)).toEqual([]);
    expect(intentPutOf(backstopOf(world, 'tid-1')), 'the hold never reached the store').toBe('pending');

    world.kv.failWriteKeys.delete(STORE_KEYS.intentBackstop);
    delete world.hooks.putIntent;
    await world.facade.resumeNow();
    await world.facade.resumeNow();
    await flushTail();

    expect(putCallsFor(world, 'tid-1'), 'the pass re-PUT it from the in-memory hold').toHaveLength(4);
    expectIdenticalPuts(putCallsFor(world, 'tid-1'), {
      payloadEnvelope: world.putCalls[0]!.envelope,
      requiresSeedClose: false,
    });
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    expect(serverIntent(world, 'tid-1')).toBe('completed');
  });

  it('(h-kvfail-restart) the next pass re-persists a hold whose flag write failed, so a restart still sends it — once', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    world.hooks.putIntent = async () => {
      world.kv.failWriteKeys.add(STORE_KEYS.intentBackstop);
      throw unavailable();
    };
    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    expect((rejectionOf(outcome) as SphereError).code).toBe('SEND_SYNC_PENDING');
    expect(intentPutOf(backstopOf(world, 'tid-1')), 'the hold never reached the store').toBe('pending');

    // The store heals; the wallet service does not.
    world.kv.failWriteKeys.delete(STORE_KEYS.intentBackstop);
    failEveryPut(world, unavailable);
    await world.facade.resumeNow();
    await flushTail();
    expect(intentPutOf(backstopOf(world, 'tid-1')), 'the pass re-persisted the hold before its re-PUT').toBe('unconfirmed');
    await world.facade.stop();

    // A fresh process: only the store says the send is held.
    const restarted = makeWorld({ restartOf: world });
    restarted.innerClient.copyBlobIndexFrom(world.innerClient);
    await restarted.facade.start();
    await restarted.facade.resumeNow();
    await restarted.facade.resumeNow();
    await flushTail();

    expect(putCallsFor(restarted, 'tid-1').length, 'the restarted facade re-PUT the held intent').toBeGreaterThan(0);
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    expect(serverIntent(world, 'tid-1')).toBe('completed');
    expect(backstopOf(world, 'tid-1')).toBeUndefined();
  });
});

// ── (i) an epoch reseed while the PUT is in flight ──────────────────────────

describe('#835 (i) an epoch reseed while the first PUT is still in flight', () => {
  it('the reseed never PUTs the unacked attempt, so a refusal that follows is honestly clean', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    const gate = makeGate();
    world.gates.push(gate);
    world.hooks.putIntent = async () => {
      await gate.enter();
      throw new WalletApiHttpError(429, 'RATE_LIMITED', 'slow down', 1000);
    };

    const sending = settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    await vi.waitFor(() => expect(gate.entered).toBe(true));
    const reseed = world.facade.handleEpochChange('e2');
    await flushTail();

    expect(putCallsFor(world, 'tid-1'), 'the epoch reseed re-PUTs only acked attempts').toHaveLength(1);
    gate.release();
    await reseed;
    const outcome = await sending;

    const err = rejectionOf(outcome);
    expect(isPossiblyCommittedSendOutcome(err), describeError(err)).toBe(false);
    expect((err as WalletApiHttpError).code).toBe('RATE_LIMITED');
    expect(putCallsFor(world, 'tid-1')).toHaveLength(2);
    expect(serverIntent(world, 'tid-1')).toBeUndefined();
    await expectHonestOutcome(world, outcome, 100n);
  });
});

// ── (j)–(l) once a leg certified, no failure is clean ───────────────────────

describe('#835 (j)–(l) after a certified leg, every failure is possibly-committed', () => {
  it('(j) a conflict beside a delivered leg, its in-process converge failing before the apply, then a background re-certification unconfirmed: no re-plan of the full amount', async () => {
    const engine = new UnconfirmedLegEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const a = await world.seed(600n);
    const b = await world.seed(400n);
    await world.seed(1100n); // what a full re-plan of 1000 would spend
    await engine.foreignSpend(b);
    // #844: the in-process converge reuses run()'s legs, so a's second call is the background pass's.
    engine.unconfirmedOnSecondCall.add(a.blob.tokenId);
    await world.facade.start();
    world.kv.failWriteKeys.add(STORE_KEYS.shortfalls); // the in-process converge fails before its apply

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN }));
    await flushTail();
    world.kv.failWriteKeys.delete(STORE_KEYS.shortfalls);

    expect(plannedIds(world), 'a certified leg rules out re-planning the full amount').toEqual(['tid-1']);
    expect(engine.submits(a.blob.tokenId), 'the in-process converge reuses the leg run() certified (#844)').toBe(1);
    const { entries } = await world.api.listMailbox(peerCaller, 0);
    expect(entries.map((e) => e.tokenId), 'the unconflicted leg was delivered by run()').toEqual([a.blob.tokenId]);
    const err = rejectionOf(outcome);
    expect(isPossiblyCommittedSendOutcome(err), describeError(err)).toBe(true);
    expect((err as SphereError).transferId).toBe('tid-1');
    expect(failedUpdates(world)).toEqual([]);

    await world.facade.resumeNow(); // a's re-certification unconfirmed beside b's conflict
    await flushTail();
    expect(serverIntent(world, 'tid-1'), 'a delivered leg is never aborted as a lost race').toBe('open');

    await world.facade.resumeNow();
    await flushTail();
    await expectPaidAtMostOnce(world, 1000n);
  });

  it('(j-pay) the same through requests.pay(), the background re-certification never confirming: no pass reads the conflict as "nothing ran"', async () => {
    const engine = new UnconfirmedLegEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const a = await world.seed(600n);
    const b = await world.seed(400n);
    await world.seed(1100n);
    await engine.foreignSpend(b);
    engine.unconfirmedAfterFirstCall.add(a.blob.tokenId);
    await world.facade.start();
    const id = await incomingRequest(world, 1000n);
    world.kv.failWriteKeys.add(STORE_KEYS.shortfalls); // #844: the in-process converge fails before its apply

    const outcome = await settle(world.facade.requests.pay(id));
    await flushTail();
    world.kv.failWriteKeys.delete(STORE_KEYS.shortfalls);

    expect(plannedIds(world)).toEqual(['tid-1']);
    expect(engine.submits(a.blob.tokenId), 'the in-process converge reuses the leg run() certified (#844)').toBe(1);
    const err = rejectionOf(outcome);
    expect(isPossiblyCommittedSendOutcome(err), describeError(err)).toBe(true);
    expect((err as SphereError).transferId).toBe('tid-1');
    expect(requestStatus(world, id)).toBe('settling');

    // The background resume sees the pair: a conflict beside a keep-open leg.
    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, 'tid-1'), 'a delivered leg is never aborted as a lost race').toBe('open');
    expect(backstopOf(world, 'tid-1')?.disposition).toBe('open');
    expect(requestStatus(world, id), 'the delivered part keeps the request off the payable list').toBe('settling');
    await expectPaidAtMostOnce(world, 1000n);
  });

  it('(k) a re-plan attempt left open: the partial error owns no remainder, names its certified leg, and keeps no stale shortfall', async () => {
    const engine = new UnconfirmedLegEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const a = await world.seed(600n);
    const b = await world.seed(400n);
    const c = await world.seed(250n);
    const d = await world.seed(150n);
    await world.seed(500n); // what a caller's re-plan of a phantom remainder would spend
    await engine.foreignSpend(b);
    engine.unconfirmedSources.add(d.blob.tokenId);
    await world.facade.start();

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN }));
    await flushTail();

    const err = rejectionOf(outcome);
    expect(err, describeError(err)).toBeInstanceOf(PartialSendConflictError);
    const partial = err as PartialSendConflictError;
    expect(partial.transferId).toBe('tid-1');
    expect(partial.remainingAmount, 'the open re-plan attempt owns the remainder').toBe('0');
    expect(partial.committedTokenIds).toEqual([a.blob.tokenId, c.blob.tokenId]);
    // The remainder may first be re-planned onto a source whose demotion has not
    // landed yet (a clean conflict, #625); the attempt left open is the LAST one.
    const planned = plannedIds(world);
    const open = planned[planned.length - 1];
    expect(open, `the remainder was re-planned under a new transferId (${planned.join(', ')})`).not.toBe('tid-1');
    const cause = partial.cause as SphereError;
    expect(cause).toBeInstanceOf(ProofUnconfirmedError);
    expect(cause.transferId, 'the cause names the attempt that converges the rest').toBe(open);
    expect(shortfallOf(world, 'tid-1'), 'no shortfall row competes with the open attempt').toBeUndefined();
    expect(failedUpdates(world)).toEqual([]);

    if (BigInt(partial.remainingAmount) > 0n) {
      await settle(world.facade.send({ recipient: '@peer', amount: partial.remainingAmount, coinId: COIN }));
    }
    await world.facade.resumeNow();
    await flushTail();
    await expectPaidAtMostOnce(world, 1000n);
  });

  it("(k') a re-plan attempt whose other leg fails ordinarily after one certified: the cause is SEND_SYNC_PENDING for that attempt", async () => {
    const engine = new UnconfirmedLegEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const a = await world.seed(600n);
    const b = await world.seed(400n);
    const c = await world.seed(250n);
    const d = await world.seed(150n);
    await world.seed(500n);
    await engine.foreignSpend(b);
    engine.failSources.add(d.blob.tokenId);
    await world.facade.start();

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN }));
    await flushTail();

    const err = rejectionOf(outcome);
    expect(err, describeError(err)).toBeInstanceOf(PartialSendConflictError);
    const partial = err as PartialSendConflictError;
    expect(partial.transferId).toBe('tid-1');
    expect(partial.remainingAmount).toBe('0');
    expect(partial.committedTokenIds).toEqual([a.blob.tokenId, c.blob.tokenId]);
    const planned = plannedIds(world);
    const open = planned[planned.length - 1];
    expect(open).not.toBe('tid-1');
    const cause = partial.cause as SphereError;
    expect(cause.code, describeError(cause)).toBe('SEND_SYNC_PENDING');
    expect(cause.transferId).toBe(open);
    expect((cause.cause as SphereError).code).toBe('TRANSFER_FAILED');
    expect(shortfallOf(world, 'tid-1')).toBeUndefined();

    if (BigInt(partial.remainingAmount) > 0n) {
      await settle(world.facade.send({ recipient: '@peer', amount: partial.remainingAmount, coinId: COIN }));
    }
    await world.facade.resumeNow();
    await flushTail();
    await expectPaidAtMostOnce(world, 1000n);
  });

  it('(l) one attempt: a leg certifies, a leg conflicts, a leg fails ordinarily — held open, nothing applied, converged later', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const a = await world.seed(200n);
    const b = await world.seed(100n);
    const c = await world.seed(300n);
    await engine.foreignSpend(b);
    engine.failSources.add(c.blob.tokenId);
    const applied: { transferId: string; spent: string[] }[] = [];
    world.hooks.applyDelta = async (delta) => {
      applied.push({ transferId: delta.transferId, spent: [...delta.spent] });
    };
    await world.facade.start();

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '600', coinId: COIN }));
    await flushTail();

    expect(applied.filter((d) => d.transferId === 'tid-1'), 'no apply for an attempt that is not settled').toEqual([]);
    const err = rejectionOf(outcome) as SphereError;
    expect(err.code, describeError(err)).toBe('SEND_SYNC_PENDING');
    expect(err.transferId).toBe('tid-1');
    expect(serverIntent(world, 'tid-1'), 'the intent stays open for resume').toBe('open');
    expect(shortfallOf(world, 'tid-1')).toBeUndefined();
    expect(failedUpdates(world)).toEqual([]);
    expect((await receipts(world)).amount).toBe(200n);

    engine.failSources.delete(c.blob.tokenId);
    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, 'tid-1')).toBe('completed');
    expect((await receipts(world)).amount).toBe(500n);
    expect(shortfallOf(world, 'tid-1')?.remainingAmount, 'the conflicted leg is the durable remainder').toBe('100');
    const settled = applied.filter((d) => d.transferId === 'tid-1');
    expect(settled).toHaveLength(1);
    expect([...settled[0]!.spent].sort()).toEqual([a.blob.tokenId, c.blob.tokenId].sort());
  });
});

// ── (m) whole-token sends go through the same gate ──────────────────────────

const WHOLE_SENDS: readonly (readonly [
  string,
  (world: World) => Promise<SphereToken>,
  (world: World, tokenId: string) => Promise<TransferResult>,
])[] = [
  [
    'sendWholeToken (a valued token)',
    (world) => world.seed(100n),
    (world, tokenId) => world.facade.sendWholeToken({ recipient: '@peer', tokenId }),
  ],
  [
    'sendCoinless (a coinless token)',
    (world) => world.seedCoinless(),
    (world, tokenId) => world.facade.sendCoinless({ recipient: '@peer', tokenId }),
  ],
];

describe('#835 (m) whole-token sends over an unconfirmed intent PUT', () => {
  it.each(WHOLE_SENDS)('%s over a PUT that answers ambiguously once: delivered', async (_label, seed, send) => {
    const world = makeWorld();
    const token = await seed(world);
    await world.facade.start();
    failPutBeforeStoreOnce(world, networkDown);

    const outcome = await settle(send(world, token.blob.tokenId));
    await flushTail();

    expect(outcome.kind, outcome.kind === 'rejected' ? describeError(outcome.error) : 'resolved').toBe('resolved');
    const result = (outcome as { result: TransferResult }).result;
    expect(result.status).toBe('delivered');
    const { entries } = await world.api.listMailbox(peerCaller, 0);
    expect(entries.map((e) => e.tokenId)).toEqual([token.blob.tokenId]);
    expect(serverIntent(world, result.id)).toBe('completed');
    expect(failedUpdates(world)).toEqual([]);
  });

  it.each(WHOLE_SENDS)('%s over a PUT that answers ambiguously every time: held, never failed, delivered once later', async (_label, seed, send) => {
    const world = makeWorld();
    const token = await seed(world);
    await startSettled(world);
    failEveryPut(world, unavailable);

    const outcome = await settle(send(world, token.blob.tokenId));

    expect(chainOps(world)).toBe(0);
    const err = rejectionOf(outcome) as SphereError;
    expect(err.code, describeError(err)).toBe('SEND_SYNC_PENDING');
    expect(err.transferId).toBe('tid-1');
    expect(failedUpdates(world)).toEqual([]);

    delete world.hooks.putIntent;
    await world.facade.resumeNow();
    await world.facade.resumeNow();
    await flushTail();

    const { entries } = await world.api.listMailbox(peerCaller, 0);
    expect(entries.map((e) => e.tokenId)).toEqual([token.blob.tokenId]);
    expect(serverIntent(world, 'tid-1')).toBe('completed');
  });

  it.each(WHOLE_SENDS)('%s over a PUT refused 403 every time: clean, and nothing can run', async (_label, seed, send) => {
    const world = makeWorld();
    const token = await seed(world);
    await world.facade.start();
    const thrown = failEveryPut(world, () => new WalletApiHttpError(403, 'TLS_REQUIRED', 'PUT /v1/intents: TLS required'));

    const outcome = await settle(send(world, token.blob.tokenId));

    expect(chainOps(world)).toBe(0);
    const err = rejectionOf(outcome);
    expect(err).toBe(thrown[thrown.length - 1]);
    expect(isPossiblyCommittedSendOutcome(err)).toBe(false);
    expect(failedUpdates(world)).toHaveLength(1);
    expect(world.counters.putIntent).toBe(2);
    await expectCleanLeavesNothing(world);
  });
});

// ── (n)–(p) a clean leg failure is clean only when it can be fenced ─────────

describe('#835 (n)–(p) a leg that fails cleanly after the PUT acked', () => {
  it('(n) after an ambiguous PUT answer the attempt cannot be fenced: held open, never aborted, delivered once the fault clears', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const token = await world.seed(100n);
    engine.failSources.add(token.blob.tokenId);
    await startSettled(world);
    const aborts = recordAborts(world);
    failPutBeforeStoreOnce(world, networkDown);

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

    const err = rejectionOf(outcome) as SphereError;
    expect(err.code, describeError(err)).toBe('SEND_SYNC_PENDING');
    expect(err.transferId).toBe('tid-1');
    expectMessage(err, 'NOT_FENCED_MESSAGE');
    expect((err.cause as SphereError).code).toBe('TRANSFER_FAILED');
    expect(aborts, 'an unfenceable attempt is never aborted').toEqual([]);
    expect(serverIntent(world, 'tid-1')).toBe('open');
    expect(backstopOf(world, 'tid-1')?.disposition).toBe('open');
    expect(failedUpdates(world)).toEqual([]);

    engine.failSources.delete(token.blob.tokenId);
    await world.facade.resumeNow();
    await flushTail();

    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    expect(serverIntent(world, 'tid-1')).toBe('completed');
  });

  it('(o) the tombstone cannot be written: held open possibly-committed, never aborted, delivered once the fault clears', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const token = await world.seed(100n);
    engine.failSources.add(token.blob.tokenId);
    // After the gate acked: the leg's failure is the first moment a tombstone is due.
    engine.onFail = () => world.kv.failWriteKeys.add(STORE_KEYS.intentBackstop);
    await startSettled(world);
    const aborts = recordAborts(world);

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

    const err = rejectionOf(outcome) as SphereError;
    expect(err.code, describeError(err)).toBe('SEND_SYNC_PENDING');
    expect(err.transferId).toBe('tid-1');
    expectMessage(err, 'NOT_FENCED_MESSAGE');
    expect(aborts, 'no abort without a durable tombstone to back it').toEqual([]);
    expect(serverIntent(world, 'tid-1')).toBe('open');
    expect(backstopOf(world, 'tid-1')?.disposition).toBe('open');
    expect(failedUpdates(world)).toEqual([]);

    engine.onFail = null;
    engine.failSources.delete(token.blob.tokenId);
    world.kv.failWriteKeys.delete(STORE_KEYS.intentBackstop);
    await world.facade.resumeNow();
    await flushTail();

    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    expect(serverIntent(world, 'tid-1')).toBe('completed');
    expect(backstopOf(world, 'tid-1')).toBeUndefined();
  });

  it('(p) the abort fails: the tombstone outlives a pass that could not list the row, and the #676 gate aborts it — nothing runs', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const token = await world.seed(100n);
    engine.failSources.add(token.blob.tokenId);
    await world.facade.start();
    await world.facade.resumeNow(); // the start pass is over: the next resumeNow runs its own

    const abortGate = makeGate();
    world.gates.push(abortGate);
    let abortFails = true;
    world.hooks.abort = async () => {
      await abortGate.enter();
      if (abortFails) throw new WalletApiHttpError(500, 'INTERNAL', 'POST /v1/intents/abort: internal server error');
    };
    // The pass lists while the attempt is still active (its row filtered out),
    // then reads the backstop only after the attempt has ended.
    const readGate = makeGate();
    world.gates.push(readGate);
    let holdNextRead = false;
    world.hooks.listOpen = async () => {
      holdNextRead = true;
    };
    const get = world.kv.get.bind(world.kv);
    world.kv.get = async <T>(key: string): Promise<T | null> => {
      if (holdNextRead && key === STORE_KEYS.intentBackstop) {
        holdNextRead = false;
        await readGate.enter();
      }
      return get<T>(key);
    };

    const sending = settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    await vi.waitFor(() => expect(abortGate.entered).toBe(true));
    expect(backstopOf(world, 'tid-1')?.disposition).toBe('abortPending');
    const pass = world.facade.resumeNow();
    await vi.waitFor(() => expect(readGate.entered).toBe(true));
    abortGate.release();
    const endedFirst = await Promise.race([sending.then(() => true), flushTail(100).then(() => false)]);
    readGate.release();
    const outcome = await sending;
    await pass;
    await flushTail();

    expect(backstopOf(world, 'tid-1')?.disposition, 'a tombstone goes only once the server says the row cannot run').toBe(
      'abortPending'
    );
    expect(endedFirst, 'the attempt had ended before the pass read the backstop').toBe(true);
    const err = rejectionOf(outcome) as SphereError;
    // The row is still open: another device of this wallet could run it before this one cancels it.
    expect(isPossiblyCommittedSendOutcome(err), describeError(err)).toBe(true);
    expect(err.code).toBe('SEND_SYNC_PENDING');
    expect(err.transferId).toBe('tid-1');
    expectMessage(err, 'CANCEL_UNCONFIRMED_MESSAGE');
    expect(failedUpdates(world)).toEqual([]);
    expect(serverIntent(world, 'tid-1'), 'the failed abort left the row open').toBe('open');

    // The leg would now succeed: only the tombstone stands between the row and a run.
    engine.failSources.delete(token.blob.tokenId);
    abortFails = false;
    delete world.hooks.listOpen;
    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, 'tid-1')).toBe('aborted');
    expect(backstopOf(world, 'tid-1')).toBeUndefined();
    expect(chainOps(world)).toBe(0);
    expect(await receipts(world)).toEqual({ entries: 0, amount: 0n });
  });

  it('(p-pay) through requests.pay(): the request stays settling until the server confirms the abort, then is payable', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const token = await world.seed(100n);
    engine.failSources.add(token.blob.tokenId);
    await startSettled(world);
    const id = await incomingRequest(world, 100n);
    let abortFails = true;
    world.hooks.abort = async () => {
      if (abortFails) throw new WalletApiHttpError(500, 'INTERNAL', 'POST /v1/intents/abort: internal server error');
    };

    const outcome = await settle(world.facade.requests.pay(id));

    const err = rejectionOf(outcome) as SphereError;
    expect(err.code, describeError(err)).toBe('SEND_SYNC_PENDING');
    expect(err.transferId).toBe('tid-1');
    expect(requestStatus(world, id)).toBe('settling');

    engine.failSources.delete(token.blob.tokenId); // the leg would now succeed: only the tombstone holds it
    await world.facade.resumeNow();
    await flushTail();

    expect(requestStatus(world, id), 'an unconfirmed cancel proves nothing').toBe('settling');
    expect(serverIntent(world, 'tid-1')).toBe('open');

    abortFails = false;
    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, 'tid-1')).toBe('aborted');
    expect(requestStatus(world, id), 'cancelled with nothing moved: payable again').toBe('pending');
    expect(chainOps(world)).toBe(0);
    expect(await receipts(world)).toEqual({ entries: 0, amount: 0n });
  });
});

// ── (q) a pass that cannot read the backstop reconciles nothing ─────────────

describe('#835 (q) a backstop read failure during a pass', () => {
  it('a held payment link stays settling: a deferred pass never resolves it paid', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    const id = await incomingRequest(world, 100n);
    failEveryPut(world, unavailable);
    const outcome = await settle(world.facade.requests.pay(id));
    expect((rejectionOf(outcome) as SphereError).code).toBe('SEND_SYNC_PENDING');
    expect(requestStatus(world, id)).toBe('settling');

    world.kv.failKeys.add(STORE_KEYS.intentBackstop);
    await world.facade.resumeNow();
    await flushTail();

    expect(requestStatus(world, id), 'an unreadable backstop proves nothing about the link').toBe('settling');
    expect((await requesterRow(world, id))?.status, 'no paid respond for an unpaid request').toBe('open');

    world.kv.failKeys.delete(STORE_KEYS.intentBackstop);
    delete world.hooks.putIntent;
    await world.facade.resumeNow();
    await world.facade.resumeNow();
    await flushTail();

    expect(requestStatus(world, id)).toBe('paid');
    expect((await requesterRow(world, id))?.transferId).toBe('tid-1');
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
  });
});

// ── (r) a settled partial whose close fails ─────────────────────────────────

describe('#835 (r) a settled partial whose close fails after the apply', () => {
  it('surfaces its durable remainder as final: no re-plan, the shortfall kept, the settled part in history', async () => {
    const world = makeWorld();
    const a = await world.seed(60n);
    const b = await world.seed(40n);
    await world.engine.foreignSpend(b);
    await world.facade.start();
    failCompleteOnce(world, () => new WalletApiHttpError(503, 'HTTP_503', 'complete failed with status 503'));

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    await flushTail();

    const err = rejectionOf(outcome);
    expect(err, describeError(err)).toBeInstanceOf(PartialSendConflictError);
    const partial = err as PartialSendConflictError;
    expect(partial.transferId).toBe('tid-1');
    expect(partial.remainingAmount).toBe('40');
    expect(partial.committedTokenIds).toEqual([a.blob.tokenId]);
    expect(plannedIds(world), 'no in-process re-plan while the partial is not closed').toEqual(['tid-1']);
    expect(engineOpIds(world)).toEqual(['tid-1']);
    expect(shortfallOf(world, 'tid-1')?.remainingAmount, 'the remainder stays durable').toBe('40');
    const sent = (await world.api.listHistory(ownCaller, {})).records.filter((r) => r.type === 'SENT');
    expect(sent.map((r) => [r.transferId, r.assets])).toEqual([['tid-1', [{ coinId: COIN, amount: '60' }]]]);
    expect(failedUpdates(world)).toEqual([]);
    expect((await receipts(world)).amount).toBe(60n);
  });
});

// ── (s) a convergence pass that overlaps a send or a payment ────────────────

/** A source whose transfer waits on a gate (a resumed intent's proof wait) or fails ordinarily. */
class GatedEngine extends LegFailureEngine {
  readonly gates = new Map<string, () => Promise<void>>();
  readonly unconfirmOnce = new Set<string>();

  override async transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    const id = params.token.blob.tokenId;
    if (this.unconfirmOnce.delete(id)) throw new ProofUnconfirmedError('no inclusion proof before the deadline (simulated)');
    const gate = this.gates.get(id);
    if (gate !== undefined) {
      this.gates.delete(id);
      await gate();
    }
    return super.transfer(params, options);
  }
}

/** tid-1 is an earlier send left open (its proof never came); the next pass resumes it. */
async function worldWithOpenIntent(): Promise<{ world: World; engine: GatedEngine; open: SphereToken; spare: SphereToken }> {
  const engine = new GatedEngine({ chainPubkey: hexToBytes(OWN_PUB) });
  const world = makeWorld({ engine });
  const open = await world.seed(50n);
  const spare = await world.seed(100n);
  await startSettled(world);
  engine.unconfirmOnce.add(open.blob.tokenId);
  const first = await settle(world.facade.send({ recipient: '@peer', amount: '50', coinId: COIN }));
  expect((rejectionOf(first) as SphereError).code).toBe('CERTIFICATION_UNCONFIRMED');
  expect(serverIntent(world, 'tid-1')).toBe('open');
  return { world, engine, open, spare };
}

/** Starts a pass that resumes tid-1 and blocks inside its leg until `release()`. */
async function passBlockedInResume(world: World, engine: GatedEngine, open: SphereToken): Promise<{ pass: Promise<void>; release(): void }> {
  const gate = makeGate();
  world.gates.push(gate);
  engine.gates.set(open.blob.tokenId, () => gate.enter());
  const pass = world.facade.resumeNow();
  await vi.waitFor(() => expect(gate.entered).toBe(true));
  return { pass, release: () => gate.release() };
}

describe('#835 (s) a payment link written while a convergence pass is in flight', () => {
  it('(s-park) a pay() that parks while a pass is in flight: the request stays settling, then reads paid once the send converged', async () => {
    const { world, engine, open } = await worldWithOpenIntent();
    const id = await incomingRequest(world, 100n);
    const blocked = await passBlockedInResume(world, engine, open);

    failEveryPut(world, unavailable);
    const outcome = await settle(world.facade.requests.pay(id));
    expect((rejectionOf(outcome) as SphereError).code).toBe('SEND_SYNC_PENDING');
    blocked.release();
    await blocked.pass;
    await flushTail();

    expect(requestStatus(world, id), 'a held payment is never resolved paid').toBe('settling');
    expect((await requesterRow(world, id))?.status, 'no paid respond while nothing moved').toBe('open');
    expect(serverIntent(world, 'tid-2')).toBeUndefined();

    delete world.hooks.putIntent;
    await world.facade.resumeNow();
    await flushTail();

    expect(requestStatus(world, id)).toBe('paid');
    expect((await requesterRow(world, id))?.transferId).toBe('tid-2');
    expect(serverIntent(world, 'tid-2')).toBe('completed');
  });

  it('(s-cancel) a pay() that ends cancel-unconfirmed while a pass is in flight: settling, then payable once the cancel is confirmed', async () => {
    const { world, engine, open, spare } = await worldWithOpenIntent();
    const id = await incomingRequest(world, 100n);
    const blocked = await passBlockedInResume(world, engine, open);

    engine.failSources.add(spare.blob.tokenId);
    let abortFails = true;
    world.hooks.abort = async (transferId) => {
      if (transferId === 'tid-2' && abortFails) throw new WalletApiHttpError(500, 'INTERNAL', 'POST /v1/intents/abort: internal server error');
    };
    const outcome = await settle(world.facade.requests.pay(id));
    expectMessage(rejectionOf(outcome), 'CANCEL_UNCONFIRMED_MESSAGE');
    blocked.release();
    await blocked.pass;
    await flushTail();

    expect(requestStatus(world, id), 'a payment being cancelled is never resolved paid').toBe('settling');
    expect((await requesterRow(world, id))?.status).toBe('open');

    abortFails = false;
    engine.failSources.clear();
    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, 'tid-2')).toBe('aborted');
    expect(requestStatus(world, id), 'cancelled with nothing moved: payable again').toBe('pending');
    expect((await requesterRow(world, id))?.status).toBe('open');
    expect((await receipts(world)).amount, 'only the earlier send ever reached the peer').toBe(50n);
  });

  it('(s-listed) a pass that listed while the pay() attempt was active, then ran on after it ended cancel-unconfirmed: settling, never paid', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const tA = await world.seed(100n);
    await world.seed(50n);
    await startSettled(world);

    // A held send B, whose every PUT dies before the server stores anything.
    const inner = world.innerClient;
    const store = inner.putIntent.bind(inner);
    let heldId: string | null = null;
    let rePutGate: Gate | null = null;
    inner.putIntent = async (transferId, envelope, seal) => {
      if (heldId !== null && transferId !== heldId) return store(transferId, envelope, seal);
      heldId ??= transferId;
      if (rePutGate !== null) await rePutGate.enter(); // the pass's re-PUT of B is slow
      throw networkDown();
    };
    const held = await settle(world.facade.send({ recipient: '@peer', amount: '50', coinId: COIN }));
    expect((rejectionOf(held) as SphereError).code).toBe('SEND_SYNC_PENDING');

    const id = await incomingRequest(world, 100n);
    engine.failSources.add(tA.blob.tokenId);
    const abortGate = makeGate();
    world.gates.push(abortGate);
    let aborts = 0;
    world.hooks.abort = async () => {
      if ((aborts += 1) === 1) await abortGate.enter();
      throw new WalletApiHttpError(500, 'INTERNAL', 'POST /v1/intents/abort: internal server error');
    };
    rePutGate = makeGate();
    world.gates.push(rePutGate);

    const paying = settle(world.facade.requests.pay(id));
    await vi.waitFor(() => expect(abortGate.entered).toBe(true));
    const pass = world.facade.resumeNow(); // lists while the attempt is still in its fence
    await vi.waitFor(() => expect(rePutGate!.entered).toBe(true));
    abortGate.release();
    const err = rejectionOf(await paying) as SphereError;
    expectMessage(err, 'CANCEL_UNCONFIRMED_MESSAGE');
    rePutGate.release();
    await pass;
    await flushTail();

    expect(requestStatus(world, id), 'a payment being cancelled is never resolved paid').toBe('settling');
    expect((await requesterRow(world, id))?.status).toBe('open');
    expect(backstopOf(world, err.transferId!)?.disposition, 'the pass left the ended attempt to the next one').toBe('abortPending');

    delete world.hooks.abort;
    engine.failSources.clear();
    rePutGate = null;
    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, err.transferId!)).toBe('aborted');
    expect(requestStatus(world, id), 'cancelled with nothing moved: payable again').toBe('pending');
    expect((await requesterRow(world, id))?.status).toBe('open');
    expect((await receipts(world)).entries).toBe(0);
  });

  it('(s-ended) an attempt held NOT_FENCED that ends after the pass listed it keeps its backstop and its source', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const token = await world.seed(100n);
    engine.failSources.add(token.blob.tokenId);
    await startSettled(world);
    failPutBeforeStoreOnce(world, networkDown); // ambiguous, then 2xx: the attempt cannot be fenced

    const legGate = makeGate();
    world.gates.push(legGate);
    const transfer = engine.transfer.bind(engine);
    let held = false;
    engine.transfer = async (params, options) => {
      if (!held) {
        held = true;
        await legGate.enter();
      }
      return transfer(params, options);
    };
    // The pass lists while the attempt is active, and reads the backstop only after it ended.
    const readGate = makeGate();
    world.gates.push(readGate);
    let holdNextRead = false;
    world.hooks.listOpen = async () => {
      holdNextRead = true;
    };
    const get = world.kv.get.bind(world.kv);
    world.kv.get = async <T>(key: string): Promise<T | null> => {
      if (holdNextRead && key === STORE_KEYS.intentBackstop) {
        holdNextRead = false;
        await readGate.enter();
      }
      return get<T>(key);
    };

    const sending = settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    await vi.waitFor(() => expect(legGate.entered).toBe(true));
    const pass = world.facade.resumeNow();
    await vi.waitFor(() => expect(readGate.entered).toBe(true));
    legGate.release();
    expectMessage(rejectionOf(await sending), 'NOT_FENCED_MESSAGE');
    readGate.release();
    await pass;
    await flushTail();

    expect(serverIntent(world, 'tid-1')).toBe('open');
    expect(backstopOf(world, 'tid-1')?.disposition, 'the pass judged the attempt active for its whole run').toBe('open');
    expect(tokenStatus(world, token.blob.tokenId), 'its source stays pinned to the open intent').toBe('transferring');

    delete world.hooks.listOpen;
    engine.failSources.delete(token.blob.tokenId);
    await world.facade.resumeNow();
    await flushTail();
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
  });
});

/** The pass's listing is computed at once; its answer reaches the pass only on `release()`. */
function delayListing(world: World): Gate {
  const gate = makeGate();
  world.gates.push(gate);
  const inner = world.innerClient;
  const list = inner.listIntents.bind(inner);
  let delay = true;
  inner.listIntents = async (status) => {
    const listed = await list(status);
    if (delay && (status ?? 'open') === 'open') {
      delay = false;
      await gate.enter();
    }
    return listed;
  };
  return gate;
}

describe('#835 (s) an attempt the pass listing cannot show, ending while the pass runs', () => {
  async function unlistedWorld(): Promise<{ world: World; engine: LegFailureEngine; token: SphereToken; id: string }> {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const token = await world.seed(100n);
    await startSettled(world);
    const id = await incomingRequest(world, 100n);
    engine.failSources.add(token.blob.tokenId);
    return { world, engine, token, id };
  }

  async function expectOwnedByNoPass(world: World, engine: LegFailureEngine, token: SphereToken, id: string, transferId: string): Promise<void> {
    expect(serverIntent(world, transferId)).toBe('open');
    expect(backstopOf(world, transferId)?.disposition, 'the pass never sweeps an attempt in process during it').toBe('open');
    expect(tokenStatus(world, token.blob.tokenId), 'its source stays pinned to the open intent').toBe('transferring');
    expect(requestStatus(world, id), 'nothing moved: the link is never resolved paid').toBe('settling');
    expect((await requesterRow(world, id))?.status).toBe('open');

    engine.failSources.clear();
    await world.facade.resumeNow();
    await flushTail();
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    expect(requestStatus(world, id)).toBe('paid');
  }

  it('(s-unlisted) a pay() that starts after the pass listed and ends NOT_FENCED before the listing answers', async () => {
    const { world, engine, token, id } = await unlistedWorld();
    const listing = delayListing(world);

    const pass = world.facade.resumeNow();
    await vi.waitFor(() => expect(listing.entered).toBe(true)); // computed with no row of the pay
    failPutBeforeStoreOnce(world, networkDown); // ambiguous, then 2xx: the attempt cannot be fenced
    const err = rejectionOf(await settle(world.facade.requests.pay(id))) as SphereError;
    expectMessage(err, 'NOT_FENCED_MESSAGE');
    listing.release();
    await pass;
    await flushTail();

    await expectOwnedByNoPass(world, engine, token, id, err.transferId!);
  });

  it('(s-unlisted-running) a pay() already in its first PUT when the pass begins, ending NOT_FENCED before the listing answers', async () => {
    const { world, engine, token, id } = await unlistedWorld();
    const putGate = makeGate();
    world.gates.push(putGate);
    const inner = world.innerClient;
    const store = inner.putIntent.bind(inner);
    let puts = 0;
    inner.putIntent = async (transferId, envelope, seal) => {
      if ((puts += 1) > 1) return store(transferId, envelope, seal);
      await putGate.enter();
      throw networkDown(); // ambiguous: the attempt cannot be fenced
    };
    const listing = delayListing(world);

    const paying = settle(world.facade.requests.pay(id));
    await vi.waitFor(() => expect(putGate.entered).toBe(true));
    const pass = world.facade.resumeNow();
    await vi.waitFor(() => expect(listing.entered).toBe(true)); // computed before any PUT of the pay landed
    putGate.release();
    const err = rejectionOf(await paying) as SphereError;
    expectMessage(err, 'NOT_FENCED_MESSAGE');
    listing.release();
    await pass;
    await flushTail();

    await expectOwnedByNoPass(world, engine, token, id, err.transferId!);
  });
});

// ── (t) a §5.1 reseed already running when the send starts ──────────────────

describe('#835 (t) a reseed that overlaps a send it started before', () => {
  it('(t) the reseed lists the backstop only after the send acked and re-PUTs it while the only leg fails cleanly: held, never fenced, paid once', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.seed(100n); // what a contract-following re-send would spend
    await startSettled(world);
    await flushTail();
    // The reseed's backstop read starts late. The shipped composition issues it before any later
    // send's upsert, so the guard is defensive and the test forces the ordering on the facade's own stores.
    const stores = (world.facade as unknown as { machineStores: MachineStores }).machineStores;
    const listGate = makeGate();
    world.gates.push(listGate);
    const list = stores.backstop.list.bind(stores.backstop);
    let delayNextList = true;
    stores.backstop.list = async () => {
      if (delayNextList) {
        delayNextList = false;
        await listGate.enter();
      }
      return list();
    };
    const reputGate = makeGate();
    world.gates.push(reputGate);
    world.hooks.putIntent = async () => {
      if (putCallsFor(world, 'tid-1').length === 2) await reputGate.enter(); // the reseed's re-PUT
    };
    const transfer = world.engine.transfer.bind(world.engine);
    let failOnce = true;
    world.engine.transfer = async (params, options) => {
      if (!failOnce) return transfer(params, options);
      failOnce = false;
      listGate.release(); // the reseed now lists the acked entry…
      await vi.waitFor(() => expect(reputGate.entered).toBe(true)); // …and its re-PUT is in flight
      throw new SphereError('the aggregator refused the transfer (simulated)', 'TRANSFER_FAILED');
    };

    const reseed = world.facade.handleEpochChange('e2');
    await vi.waitFor(() => expect(listGate.entered).toBe(true));
    const request = { recipient: '@peer', amount: '100', coinId: COIN };
    const outcome = await settle(world.facade.send(request));
    reputGate.release(); // the re-PUT lands after the send reported
    await reseed;
    await flushTail();

    expect(putCallsFor(world, 'tid-1'), 'the reseed re-PUT the acked attempt').toHaveLength(2);
    const err = rejectionOf(outcome);
    expect(isPossiblyCommittedSendOutcome(err), describeError(err)).toBe(true);
    expect((err as SphereError).transferId).toBe('tid-1');
    expectMessage(err, 'NOT_FENCED_MESSAGE');
    expect(failedUpdates(world)).toEqual([]);

    await followContract(world, outcome, request);
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    expect(serverIntent(world, 'tid-1')).toBe('completed');
  });

  it("(t') once the reseed has ended, a clean leg failure is fenced and clean again", async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const token = await world.seed(100n);
    engine.failSources.add(token.blob.tokenId);
    await startSettled(world);
    await world.facade.handleEpochChange('e2');

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));

    const err = rejectionOf(outcome);
    expect(isPossiblyCommittedSendOutcome(err), describeError(err)).toBe(false);
    expect((err as SphereError).code).toBe('TRANSFER_FAILED');
    expect(serverIntent(world, 'tid-1')).toBe('aborted');
    await expectHonestOutcome(world, outcome, 100n);
  });
});

// ── (u) a listener's throw never reaches a money-path outcome ───────────────

/** The host's emit rethrows a listener's error (Node's EventEmitter does) for these events. */
function throwingListener(world: World, events: readonly string[]): void {
  const push = world.events.push.bind(world.events);
  world.events.push = (...items) => {
    if (items.some((item) => events.includes(item.event))) throw new Error('listener blew up');
    return push(...items);
  };
}

describe('#835 (u) a host emit that rethrows a listener error', () => {
  it('a delivered send() still resolves delivered', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    throwingListener(world, ['transfer:updated']);

    const result = await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });

    expect(result.status).toBe('delivered');
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
  });

  it('a delivered send() still resolves delivered when the log sink that records the listener throw throws too', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    throwingListener(world, ['transfer:updated']);
    logger.configure({
      handler: () => {
        throw new Error('log sink blew up');
      },
    });
    try {
      const result = await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });

      expect(result.status).toBe('delivered');
      expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    } finally {
      logger.configure({ handler: null });
    }
  });

  it('requests.pay() over a delivered send still ends paid', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    const id = await incomingRequest(world, 100n);
    throwingListener(world, ['transfer:updated', 'payment_request:updated', 'history:updated']);

    const result = await world.facade.requests.pay(id);

    expect(result.status).toBe('delivered');
    expect(requestStatus(world, id)).toBe('paid');
    expect((await requesterRow(world, id))?.status).toBe('paid');
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
  });
});

// ── (v) a remainder attempt that is being cancelled holds the remainder ─────

describe('#835 (v) after a partial, the re-plan attempt fails and its cancel is unconfirmed', () => {
  it('it holds the remainder until the cancel is confirmed, then it is owed again: nothing is sent twice', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const a = await world.seed(600n);
    const b = await world.seed(400n);
    const c = await world.seed(400n);
    await engine.foreignSpend(b);
    engine.failSources.add(c.blob.tokenId);
    let abortFails = true;
    world.hooks.abort = async () => {
      if (abortFails) throw new WalletApiHttpError(500, 'INTERNAL', 'POST /v1/intents/abort: internal server error');
    };
    await startSettled(world);

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN }));
    await flushTail();

    const err = rejectionOf(outcome);
    expect(err, describeError(err)).toBeInstanceOf(PartialSendConflictError);
    const partial = err as PartialSendConflictError;
    expect(isPossiblyCommittedSendOutcome(partial)).toBe(true);
    expect(partial.transferId).toBe('tid-1');
    expect(partial.remainingAmount, 'another device could still complete it: nothing is owed yet').toBe('0');
    expect(partial.committedTokenIds).toEqual([a.blob.tokenId]);
    const planned = plannedIds(world);
    const cancelling = planned[planned.length - 1];
    const cause = partial.cause as SphereError;
    expect(cause.code, describeError(cause)).toBe('SEND_SYNC_PENDING');
    expect(cause.transferId).toBe(cancelling);
    expectMessage(cause, 'CANCEL_UNCONFIRMED_MESSAGE');
    expect(backstopOf(world, cancelling!)?.disposition).toBe('abortPending');
    expect(backstopOf(world, cancelling!)?.owes?.map((row) => row.transferId), 'the attempt being cancelled holds it').toEqual(['tid-1']);
    expect(shortfallOf(world, 'tid-1'), 'not owed while the cancel is unconfirmed').toBeUndefined();
    expect(await world.facade.pendingTransfers()).toEqual([]);
    expect(failedUpdates(world)).toEqual([]);

    // The cancel lands: nothing of the cancelled attempt ever runs, and the remainder is owed again.
    abortFails = false;
    engine.failSources.clear();
    await world.facade.resumeNow();
    await flushTail();
    expect(serverIntent(world, cancelling!)).toBe('aborted');
    expect(await receipts(world)).toEqual({ entries: 1, amount: 600n });
    expect(backstopOf(world, cancelling!)).toBeUndefined();
    expect(shortfallOf(world, 'tid-1')?.remainingAmount).toBe('400');
    const pending = await world.facade.pendingTransfers();
    expect(pending.map((p) => [p.transferId, p.kind, p.amount])).toEqual([['tid-1', 'shortfall', '400']]);

    // A caller that re-plans the shortfall once it is owed pays the request exactly once.
    await world.facade.send({ recipient: '@peer', amount: pending[0]!.amount, coinId: COIN });
    await world.facade.resumeNow();
    await flushTail();
    expect((await receipts(world)).amount).toBe(1000n);
  });
});

// ── (x) after a partial, the re-plan attempt is held ───────────────────────

/** A named source answers a conflict for its next `n` transfers; later ones go through. */
class ConflictingEngine extends RealizationEngine {
  readonly conflicts = new Map<string, number>();

  override async transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    const id = params.token.blob.tokenId;
    const left = this.conflicts.get(id) ?? 0;
    if (left > 0) {
      this.conflicts.set(id, left - 1);
      throw new TransferConflictError('source already spent (simulated)');
    }
    return super.transfer(params, options);
  }
}

describe('#835 (x) after a partial, the re-plan attempt is held: it holds the shortfall until it pays or is refused', () => {
  /** The next backstop write that attaches held rows fails. */
  function failHoldWrite(world: World): void {
    let armed = true;
    const set = world.kv.set.bind(world.kv);
    world.kv.set = async <T>(key: string, value: T): Promise<void> => {
      const attaches = key === STORE_KEYS.intentBackstop && (value as unknown as IntentBackstopEntry[]).some((e) => e.owes !== undefined);
      if (armed && attaches) {
        armed = false;
        throw new Error('injected backstop write failure');
      }
      return set(key, value);
    };
  }

  /** The next `n` shortfall-store writes that would drop tid-1's row fail. */
  function failRowRemovals(world: World, n: number): void {
    let left = n;
    const set = world.kv.set.bind(world.kv);
    world.kv.set = async <T>(key: string, value: T): Promise<void> => {
      const rows = key === STORE_KEYS.shortfalls ? (value as unknown as ShortfallEntry[]) : null;
      const drops = rows !== null && shortfallOf(world, 'tid-1') !== undefined && !rows.some((row) => row.transferId === 'tid-1');
      if (drops && left > 0) {
        left -= 1;
        throw new Error('injected shortfall removal failure');
      }
      return set(key, value);
    };
  }

  /**
   * 600 of 1000 delivered, the 400 leg conflicted; the re-plan attempt for the 400 (which picks
   * the same source again: a partial's conflicted source is not demoted) is held, every PUT of it
   * unanswered. `spent` decides whether that source really is spent, or only lost its first races;
   * `failedRemovals` fails that many removals of the original row, the first one being the hold's;
   * `failHold` fails the write that attaches the rows to the held attempt.
   */
  async function heldRemainder(spent: boolean, failedRemovals = 0, failHold = false): Promise<{ world: World; held: string }> {
    const engine = new ConflictingEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    await world.seed(600n);
    const contested = await world.seed(400n);
    if (spent) await engine.foreignSpend(contested);
    else engine.conflicts.set(contested.blob.tokenId, 1); // the attempt: its in-process converge reuses that conflict (#844)
    await startSettled(world);
    world.hooks.putIntent = async () => {
      if (world.putCalls[world.putCalls.length - 1]?.transferId !== 'tid-1') throw unavailable();
    };
    failRowRemovals(world, failedRemovals);
    if (failHold) failHoldWrite(world);

    const err = rejectionOf(await settle(world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN })));
    await flushTail();

    expect(err, describeError(err)).toBeInstanceOf(PartialSendConflictError);
    const partial = err as PartialSendConflictError;
    expect(partial.remainingAmount, 'the held attempt owns the remainder').toBe('0');
    expectMessage(partial.cause, 'INTENT_UNCONFIRMED_MESSAGE');
    const held = (partial.cause as SphereError).transferId!;
    const owes = backstopOf(world, held)?.owes?.map((row) => [row.transferId, row.remainingAmount]);
    expect(owes, 'the row is held by the attempt, unless that write failed').toEqual(failHold ? undefined : [['tid-1', '400']]);
    expect(shortfallOf(world, 'tid-1') !== undefined, 'the row left the store, unless its removal failed').toBe(
      failedRemovals > 0
    );
    const pending = await world.facade.pendingTransfers();
    expect(pending.map((p) => [p.transferId, p.kind]), 'listed once, as the attempt that may still pay it').toEqual([[held, 'open']]);
    return { world, held };
  }

  async function expectOwedAgain(world: World, held: string): Promise<void> {
    expect(backstopOf(world, held)).toBeUndefined();
    expect(shortfallOf(world, 'tid-1')?.remainingAmount, 'the remainder is owed again').toBe('400');
    const pending = await world.facade.pendingTransfers();
    expect(pending.map((p) => [p.transferId, p.kind, p.amount])).toEqual([['tid-1', 'shortfall', '400']]);
    expect(await receipts(world)).toEqual({ entries: 1, amount: 600n });
  }

  /** Refused on its re-PUT, the held attempt may still be stored by its earlier PUT: it keeps the remainder. */
  async function expectStillHolding(world: World, held: string): Promise<void> {
    expect(backstopOf(world, held)?.owes?.map((row) => row.transferId)).toEqual(['tid-1']);
    expect(shortfallOf(world, 'tid-1'), 'never owed while the attempt can still pay it').toBeUndefined();
    const pending = await world.facade.pendingTransfers();
    expect(pending.map((p) => [p.transferId, p.kind])).toEqual([[held, 'open']]);
    expect(await receipts(world)).toEqual({ entries: 1, amount: 600n });
  }

  async function expectPaid(world: World, held: string): Promise<void> {
    expect(serverIntent(world, held)).toBe('completed');
    expect((await receipts(world)).amount).toBe(1000n);
    expect(backstopOf(world, held)).toBeUndefined();
    expect(shortfallOf(world, 'tid-1'), 'a paid remainder is never listed as owed again').toBeUndefined();
    expect(await world.facade.pendingTransfers()).toEqual([]);
  }

  it('(x-listed-once) a row whose removal failed after the hold is listed once, as the held attempt', async () => {
    await heldRemainder(true, 1);
  });

  it('(x-hold-failed) a hold whose write failed still takes the row out of the store: never listed as owed while the attempt may pay', async () => {
    const { world, held } = await heldRemainder(false, 0, true);
    delete world.hooks.putIntent;

    await world.facade.resumeNow();
    await flushTail();

    await expectPaid(world, held);
  });

  it('(x-race) a pass that runs while the handoff is in flight leaves the attempt alone; conflicted later, the remainder is owed again', async () => {
    const engine = new ConflictingEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    await world.seed(600n);
    await engine.foreignSpend(await world.seed(400n));
    await startSettled(world);
    let failedPuts = 0;
    world.hooks.putIntent = async () => {
      if (world.putCalls[world.putCalls.length - 1]?.transferId === 'tid-1') return;
      failedPuts += 1;
      throw unavailable();
    };
    // The handoff's read of the shortfall store waits until the pass is over.
    const handoff = makeGate();
    world.gates.push(handoff);
    const get = world.kv.get.bind(world.kv);
    world.kv.get = async <T>(key: string): Promise<T | null> => {
      if (key === STORE_KEYS.shortfalls && failedPuts === 3 && !handoff.entered) await handoff.enter();
      return get<T>(key);
    };

    const sending = settle(world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN }));
    await vi.waitFor(() => expect(handoff.entered).toBe(true));
    delete world.hooks.putIntent; // its PUT would land and the attempt conflict, if a pass adopted it now
    await world.facade.resumeNow(); // the attempt is still in process: this pass never re-PUTs or resumes it
    handoff.release();
    const partial = rejectionOf(await sending) as PartialSendConflictError;
    await flushTail();
    expect(partial.remainingAmount).toBe('0');
    const held = (partial.cause as SphereError).transferId!;
    expect(backstopOf(world, held)?.owes?.map((row) => row.transferId)).toEqual(['tid-1']);

    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, held)).toBe('aborted');
    await expectOwedAgain(world, held);
  });

  it('(x-read-failed) a handoff whose read of the shortfall store fails still takes the row out: never listed as owed while the attempt may pay it', async () => {
    const engine = new ConflictingEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    await world.seed(600n);
    const contested = await world.seed(400n);
    engine.conflicts.set(contested.blob.tokenId, 1); // the attempt: its in-process converge reuses that conflict (#844)
    await startSettled(world);
    let failedPuts = 0;
    world.hooks.putIntent = async () => {
      if (world.putCalls[world.putCalls.length - 1]?.transferId === 'tid-1') return;
      failedPuts += 1;
      throw unavailable();
    };
    let armed = true;
    const get = world.kv.get.bind(world.kv);
    world.kv.get = async <T>(key: string): Promise<T | null> => {
      if (armed && key === STORE_KEYS.shortfalls && failedPuts === 3) {
        armed = false;
        throw new Error('injected shortfall read failure');
      }
      return get<T>(key);
    };

    const partial = rejectionOf(await settle(world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN }))) as PartialSendConflictError;
    await flushTail();

    expect(armed, 'the handoff read failed').toBe(false);
    expect(partial.remainingAmount, 'the held attempt owns the remainder').toBe('0');
    const held = (partial.cause as SphereError).transferId!;
    expect(shortfallOf(world, 'tid-1'), 'never listed as owed while the attempt may pay it').toBeUndefined();
    const pending = await world.facade.pendingTransfers();
    expect(pending.map((p) => [p.transferId, p.kind])).toEqual([[held, 'open']]);

    delete world.hooks.putIntent;
    await world.facade.resumeNow();
    await flushTail();

    await expectPaid(world, held);
  });

  it('(x-paid) once the service confirms it, it pays the remainder and the row goes with it', async () => {
    const { world, held } = await heldRemainder(false);
    delete world.hooks.putIntent;

    await world.facade.resumeNow();
    await flushTail();

    await expectPaid(world, held);
  });

  it('(x-paid-leftover) a copy a failed removal left behind goes when the held attempt completes', async () => {
    const { world, held } = await heldRemainder(false, 1);
    delete world.hooks.putIntent;

    await world.facade.resumeNow();
    await flushTail();

    await expectPaid(world, held);
  });

  it('(x-swept-leftover) when that cleanup fails too, the entry stays, and the sweep removes the copy before the entry', async () => {
    const { world, held } = await heldRemainder(false, 2);
    delete world.hooks.putIntent;

    await world.facade.resumeNow();
    await flushTail();
    expect(serverIntent(world, held)).toBe('completed');
    expect(backstopOf(world, held), 'kept: the copy is still there').toBeDefined();
    expect(shortfallOf(world, 'tid-1')).toBeDefined();

    await world.facade.resumeNow();
    await flushTail();

    await expectPaid(world, held);
  });

  it('(x-refused) a 413/422 on its re-PUT keeps it holding the remainder; when its earlier PUT lands, it pays it once', async () => {
    const { world, held } = await heldRemainder(false);
    world.hooks.putIntent = async () => {
      throw new WalletApiHttpError(422, 'VALIDATION_FAILED', 'intent payload refused');
    };

    await world.facade.resumeNow();
    await flushTail();

    await expectStillHolding(world, held);

    await world.api.putIntent(ownCaller, { transferId: held, payload: backstopOf(world, held)!.payloadEnvelope });
    delete world.hooks.putIntent;
    await world.facade.resumeNow();
    await flushTail();

    await expectPaid(world, held);
  });

  it('(x-conflict) its source spent elsewhere, it conflicts on resume, and the remainder is owed again', async () => {
    const { world, held } = await heldRemainder(true);
    delete world.hooks.putIntent;

    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, held)).toBe('aborted');
    await expectOwedAgain(world, held);
  });
});

// ── (z) a 2xx whose ack write fails ─────────────────────────────────────────

describe('#835 (z) the intent PUT answers 2xx but clearing the entry\'s pending flag fails', () => {
  it('runs nothing on an entry still marked never-acked: held, then resumed by the next pass and paid once', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    let armed = true;
    const set = world.kv.set.bind(world.kv);
    world.kv.set = async <T>(key: string, value: T): Promise<void> => {
      const before = backstopOf(world, 'tid-1');
      const after = key === STORE_KEYS.intentBackstop ? (value as unknown as IntentBackstopEntry[]).find((e) => e.transferId === 'tid-1') : undefined;
      if (armed && before?.intentPut === 'pending' && after !== undefined && after.intentPut === undefined) {
        armed = false;
        throw new Error('injected ack write failure');
      }
      return set(key, value);
    };

    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    await flushTail();

    const err = rejectionOf(outcome);
    expect(isPossiblyCommittedSendOutcome(err), describeError(err)).toBe(true);
    expect((err as SphereError).transferId).toBe('tid-1');
    expect(serverIntent(world, 'tid-1'), 'the row is stored').toBe('open');
    expect(backstopOf(world, 'tid-1')?.intentPut, 'held, as a send whose PUT stayed unconfirmed').toBe('unconfirmed');
    expect((await receipts(world)).entries, 'no leg ran on an unacked entry').toBe(0);
    expect(failedUpdates(world)).toEqual([]);

    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, 'tid-1')).toBe('completed');
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
    expect(backstopOf(world, 'tid-1')).toBeUndefined();
  });
});

// ── (y) a cancel the server confirms with 404 ──────────────────────────────

describe('#835 (y) a payment being cancelled whose row the server no longer has', () => {
  it('its abort answered 404 NOT_FOUND confirms the cancel: the request is payable again, never paid', async () => {
    const engine = new LegFailureEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const token = await world.seed(100n);
    await startSettled(world);
    const id = await incomingRequest(world, 100n);
    engine.failSources.add(token.blob.tokenId);
    world.hooks.abort = async () => {
      throw new WalletApiHttpError(500, 'INTERNAL', 'POST /v1/intents/abort: internal server error');
    };
    const err = rejectionOf(await settle(world.facade.requests.pay(id))) as SphereError;
    expectMessage(err, 'CANCEL_UNCONFIRMED_MESSAGE');
    expect(requestStatus(world, id)).toBe('settling');

    // A restore to a snapshot older than the intent: its row is gone, the request is not.
    delete world.hooks.abort;
    world.api.forgetIntent(ownCaller, err.transferId!);
    await world.facade.resumeNow();
    await flushTail();

    expect(backstopOf(world, err.transferId!), 'the tombstone goes once the server answers 404').toBeUndefined();
    expect(requestStatus(world, id), 'nothing moved: payable again').toBe('pending');
    expect((await requesterRow(world, id))?.status).toBe('open');
    expect((await receipts(world)).entries).toBe(0);
  });
});

// ── (w) a converged hold is forgotten ───────────────────────────────────────

/** The next backstop write that would drop `transferId` fails once. */
function failNextBackstopRemoval(world: World, transferId: string): { fired(): boolean } {
  const kv = world.kv;
  const set = kv.set.bind(kv);
  let fired = false;
  kv.set = async <T>(key: string, value: T): Promise<void> => {
    if (!fired && key === STORE_KEYS.intentBackstop) {
      const before = storedList<IntentBackstopEntry>(world, key);
      const after = value as unknown as IntentBackstopEntry[];
      if (before.some((e) => e.transferId === transferId) && !after.some((e) => e.transferId === transferId)) {
        fired = true;
        throw new Error('injected backstop removal failure');
      }
    }
    return set(key, value);
  };
  return { fired: () => fired };
}

describe('#835 (w) a held send the converger confirmed and completed', () => {
  it('whose backstop removal failed is swept on a later pass with no further PUT and no further op', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    failEveryPut(world, unavailable);
    const outcome = await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN }));
    expect((rejectionOf(outcome) as SphereError).code).toBe('SEND_SYNC_PENDING');
    delete world.hooks.putIntent;
    const removal = failNextBackstopRemoval(world, 'tid-1');
    await world.facade.resumeNow();
    await flushTail();
    expect(removal.fired()).toBe(true);
    expect(serverIntent(world, 'tid-1')).toBe('completed');
    expect(backstopOf(world, 'tid-1'), 'the stale entry outlived its intent').toBeDefined();
    const puts = putCallsFor(world, 'tid-1').length;
    const ops = chainOps(world);

    await world.facade.resumeNow();
    await world.facade.resumeNow();
    await flushTail();

    expect(putCallsFor(world, 'tid-1'), 'a confirmed hold is never re-PUT').toHaveLength(puts);
    expect(chainOps(world), 'nor run again').toBe(ops);
    expect(backstopOf(world, 'tid-1'), 'swept as S1 residue').toBeUndefined();
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
  });
});

// ── #842: SENT history beside the apply ─────────────────────────────────────

/** The SENT rows the server's history holds for this wallet. */
async function sentRows(world: World): Promise<{ transferId?: string; tokenId?: string; assets: unknown }[]> {
  return (await world.api.listHistory(ownCaller, {})).records
    .filter((r) => r.type === 'SENT')
    .map((r) => ({ transferId: r.transferId, ...(r.tokenId !== undefined ? { tokenId: r.tokenId } : {}), assets: r.assets }));
}

/** POST /v1/inventory/apply commits on the server, then its answer is lost once. */
function loseApplyAnswerOnce(world: World): void {
  const inner = world.innerClient;
  const apply = inner.apply.bind(inner);
  let lose = true;
  inner.apply = async (delta) => {
    const result = await apply(delta);
    if (!lose) return result;
    lose = false;
    throw new WalletApiHttpError(504, 'HTTP_504', 'POST /v1/inventory/apply failed with status 504');
  };
}

const completeDown = (): WalletApiHttpError => new WalletApiHttpError(503, 'HTTP_503', 'complete failed with status 503');

describe('#842 SENT history is posted beside the apply, never gated on the close (facade)', () => {
  it('(sent-complete) send() resolves, complete answers 503 once: after resumeNow, one SENT row and nothing pending', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    failCompleteOnce(world, completeDown);

    await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    await flushTail();
    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, 'tid-1'), 'the apply completed the row').toBe('completed');
    expect(await world.facade.pendingTransfers()).toEqual([]);
    expect(backstopOf(world, 'tid-1')).toBeUndefined();
    expect(await sentRows(world)).toEqual([{ transferId: 'tid-1', assets: [{ coinId: COIN, amount: '100' }] }]);
  });

  it('(sent-lost-apply) the apply commits and its answer is lost: possibly-committed, then one SENT row', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    loseApplyAnswerOnce(world);

    const err = rejectionOf(await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN })));
    expect((err as SphereError).code).toBe('SEND_SYNC_PENDING');
    expect(isPossiblyCommittedSendOutcome(err)).toBe(true);
    expect(failedUpdates(world)).toEqual([]);
    await world.facade.resumeNow();
    await flushTail();

    expect(await world.facade.pendingTransfers()).toEqual([]);
    expect(await sentRows(world)).toEqual([{ transferId: 'tid-1', assets: [{ coinId: COIN, amount: '100' }] }]);
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
  });

  it('(sent-resume) the apply fails on the send, the resume close answers 503: one SENT row once the backstop goes', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    let applyFails = true;
    world.hooks.applyDelta = async () => {
      if (!applyFails) return;
      applyFails = false;
      throw new WalletApiHttpError(503, 'HTTP_503', 'POST /v1/inventory/apply failed with status 503');
    };

    const err = rejectionOf(await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN })));
    expect((err as SphereError).code).toBe('SEND_SYNC_PENDING');
    failCompleteOnce(world, completeDown);
    await world.facade.resumeNow();
    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, 'tid-1')).toBe('completed');
    expect(backstopOf(world, 'tid-1')).toBeUndefined();
    expect(await sentRows(world)).toEqual([{ transferId: 'tid-1', assets: [{ coinId: COIN, amount: '100' }] }]);
  });

  it.each([
    { fault: 'the resume close answers 503', inject: (world: World) => failCompleteOnce(world, completeDown) },
    { fault: 'the resumed apply commits and its answer is lost', inject: loseApplyAnswerOnce },
  ])('(sent-held) a held send whose legs only resume certifies, and $fault: resume alone writes the one SENT row', async ({ inject }) => {
    const world = makeWorld();
    await world.seed(100n);
    await startSettled(world);
    failEveryPut(world, unavailable);
    const err = rejectionOf(await settle(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN })));
    expect((err as SphereError).code).toBe('SEND_SYNC_PENDING');
    expect(chainOps(world), 'held: nothing ran, so run() recorded nothing').toBe(0);
    expect(await sentRows(world)).toEqual([]);
    delete world.hooks.putIntent;
    inject(world);

    await world.facade.resumeNow();
    await world.facade.resumeNow();
    await flushTail();

    expect(serverIntent(world, 'tid-1')).toBe('completed');
    expect(backstopOf(world, 'tid-1')).toBeUndefined();
    expect(await world.facade.pendingTransfers()).toEqual([]);
    expect(await sentRows(world)).toEqual([{ transferId: 'tid-1', assets: [{ coinId: COIN, amount: '100' }] }]);
    expect(await receipts(world)).toEqual({ entries: 1, amount: 100n });
  });

  it('(sent-whole) a whole-token send whose complete answers 503 records the coins the token really carried', async () => {
    const world = makeWorld();
    const coin = await world.seed(100n);
    await startSettled(world);
    failCompleteOnce(world, completeDown);

    await world.facade.sendWholeToken({ recipient: '@peer', tokenId: coin.blob.tokenId });
    await flushTail();
    await world.facade.resumeNow();
    await flushTail();

    expect(await world.facade.pendingTransfers()).toEqual([]);
    expect(await sentRows(world)).toEqual([
      { transferId: 'tid-1', tokenId: coin.blob.tokenId, assets: [{ coinId: COIN, amount: '100' }] },
    ]);
  });
});
