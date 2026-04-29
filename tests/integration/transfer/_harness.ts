/**
 * T.8.E.1 — Shared harness for the §11.2 UXF transfer integration suite.
 *
 * Provides minimal in-memory mocks for the surfaces every send / receive
 * orchestrator needs: `OracleProvider`, `TransportProvider`,
 * `TokenStorageProvider`-shaped fakes, recording event emitters, and
 * fixture builders for `Token` / `PeerInfo` / `FullIdentity`.
 *
 * The harness intentionally does NOT instantiate a full `Sphere` — the
 * §11.2 integration scenarios are all expressible at the orchestrator
 * level (T.2.D.1 conservative-sender, T.5.A instant-sender, T.7.B txf-
 * sender, T.3.A bundle-acquirer + bundle-verifier). Going through the
 * full `Sphere.init()` path would pull in IndexedDB, Fulcrum, Aggregator
 * HTTP, Nostr WebSocket, and the entire `PaymentsModule.send()`
 * redirection table — all of which are independently tested elsewhere.
 *
 * Re-uses the `TOKEN_A` / `TOKEN_B` / ... fixtures from T.8.A's reference
 * snapshot (`tests/fixtures/uxf-mock-tokens.ts`) so byte-identity references
 * align with the T.2.D regression slot when a test compares wire-bundle
 * structure.
 *
 * @packageDocumentation
 */

import { vi } from 'vitest';

import type { TokenLike } from '../../../modules/payments/transfer/classify-token';
import type { OracleProvider } from '../../../oracle/oracle-provider';
import type { TransportProvider } from '../../../transport';
import type { PeerInfo } from '../../../transport/transport-provider';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
} from '../../../types';

// =============================================================================
// 1. Recording transport stub
// =============================================================================

export interface RecordedSend {
  readonly recipient: string;
  readonly payload: unknown;
}

export interface RecordingTransport extends TransportProvider {
  readonly _calls: RecordedSend[];
  /** When set, the next sendTokenTransfer rejects with this error. */
  _failNextSendWith: Error | null;
}

export function makeRecordingTransport(): RecordingTransport {
  const calls: RecordedSend[] = [];
  const stub: RecordingTransport = {
    _calls: calls,
    _failNextSendWith: null,
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p',
    description: 'Test stub',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => undefined),
    sendTokenTransfer: vi
      .fn()
      .mockImplementation(async (recipient: string, payload: unknown) => {
        if (stub._failNextSendWith) {
          const err = stub._failNextSendWith;
          stub._failNextSendWith = null;
          throw err;
        }
        calls.push({ recipient, payload });
        return 'event-id';
      }),
    onTokenTransfer: vi.fn().mockReturnValue(() => undefined),
  };
  return stub;
}

// =============================================================================
// 2. Oracle stub — never reaches the orchestrator's hot path
// =============================================================================

export function makeOracleStub(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network',
    description: 'Test stub',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    initialize: vi.fn(),
    submitCommitment: vi.fn(),
    getProof: vi.fn(),
    waitForProof: vi.fn(),
    validateToken: vi.fn(),
    isSpent: vi.fn().mockResolvedValue(false),
    getTokenState: vi.fn().mockResolvedValue(null),
    getCurrentRound: vi.fn().mockResolvedValue(1),
  };
}

// =============================================================================
// 3. Identity / peer fixtures (byte-identity aligned with T.8.A snapshot)
// =============================================================================

export const ALICE_CHAIN_PUBKEY =
  '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const BOB_TRANSPORT_PUBKEY =
  '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

export const BOB_CHAIN_PUBKEY =
  '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

export function makeIdentity(): FullIdentity {
  return {
    chainPubkey: ALICE_CHAIN_PUBKEY,
    l1Address: 'alpha1mock',
    directAddress: 'DIRECT://alice-direct',
    privateKey: '01'.repeat(32),
  };
}

export function makePeerInfo(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    transportPubkey: BOB_TRANSPORT_PUBKEY,
    chainPubkey: BOB_CHAIN_PUBKEY,
    l1Address: 'alpha1bob',
    directAddress: 'DIRECT://bob-direct',
    timestamp: 0,
    nametag: 'bob',
    ...overrides,
  };
}

// =============================================================================
// 4. Token builders
// =============================================================================

/**
 * Wallet-shape `Token` whose `sdkData` is the JSON of the supplied fixture.
 * Matches what production stores in `tokens.values()` and what the
 * unit-level conservative-sender / instant-sender tests use.
 */
export function makeToken(params: {
  readonly id: string;
  readonly fixture: Record<string, unknown>;
  readonly coinId?: string;
  readonly amount?: string;
  readonly status?: 'confirmed' | 'pending' | 'unconfirmed';
}): Token {
  return {
    id: params.id,
    coinId: params.coinId ?? 'UCT',
    symbol: params.coinId ?? 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: params.amount ?? '1000000',
    status: params.status ?? 'confirmed',
    createdAt: 0,
    updatedAt: 0,
    sdkData: JSON.stringify(params.fixture),
  };
}

/**
 * Project a `Token` to a coin-class `TokenLike` consumable by
 * {@link validateTargets}. Tests that exercise NFT or pending semantics
 * supply their own projection (see the NFT / chain-mode files).
 */
export function defaultCoinTokenLike(token: Token): TokenLike {
  return {
    id: token.id,
    coins: [{ coinId: token.coinId, amount: BigInt(token.amount) }],
  };
}

/**
 * Project a `Token` to an NFT-class `TokenLike` (empty coins array).
 */
export function nftTokenLike(token: Token, opts: { pending?: boolean } = {}): TokenLike {
  return {
    id: token.id,
    coins: null,
    ...(opts.pending !== undefined ? { pending: opts.pending } : {}),
  };
}

// =============================================================================
// 5. Event recorder
// =============================================================================

export interface RecordedEvent {
  readonly type: SphereEventType;
  readonly data: unknown;
}

export interface EventRecorder {
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  readonly events: ReadonlyArray<RecordedEvent>;
  readonly clear: () => void;
  readonly count: (type: SphereEventType) => number;
  readonly find: (type: SphereEventType) => ReadonlyArray<RecordedEvent>;
}

export function makeEventRecorder(): EventRecorder {
  const events: RecordedEvent[] = [];
  return {
    events,
    emit: <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
      events.push({ type, data });
    },
    clear: (): void => {
      events.length = 0;
    },
    count: (type) => events.filter((e) => e.type === type).length,
    find: (type) => events.filter((e) => e.type === type),
  };
}

// =============================================================================
// 6. Fixture rewriter — keep distinct ingested elements when reusing TOKEN_A
// =============================================================================

/**
 * Produce a copy of a TOKEN fixture with the genesis `tokenId` rewritten.
 * Re-using `TOKEN_A` as a template across N children would otherwise
 * collapse them into a single content-addressed pool element. The
 * canonical 64-hex shape is preserved.
 */
export function rewriteFixtureTokenId(
  fixture: Record<string, unknown>,
  newTokenIdHex: string,
): Record<string, unknown> {
  const genesis = (fixture as { genesis: Record<string, unknown> }).genesis;
  const data = genesis.data as Record<string, unknown>;
  return {
    ...fixture,
    genesis: {
      ...genesis,
      data: {
        ...data,
        tokenId: newTokenIdHex,
      },
    },
  };
}
