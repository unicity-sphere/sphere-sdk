/**
 * `UnicityAggregatorProvider.validateToken` — accept both JSON string
 * and parsed object as token input.
 *
 * Bug history (pre-fix):
 *   - `PaymentsModule.validate()` (line ~12636) calls
 *     `oracle.validateToken(token.sdkData)` where `sdkData` is a
 *     JSON string persisted in TXF storage.
 *   - All other oracle.validateToken call sites (UXF receive,
 *     legacy receive) pass a parsed object built from `.toJSON()`.
 *   - state-transition-sdk's `Token.fromJSON` checks
 *     `'transactions' in input && 'nametags' in input` and throws
 *     `InvalidJsonStructureError` for string input — there is no
 *     `JSON.parse` fallback inside `fromJSON`.
 *   - The historical `_validateTokenImpl` pre-parsed via
 *     `SdkToken.fromJSON(tokenData)` with no normalization, so the
 *     string-input branch silently produced `sdkToken=null`, which
 *     skipped the local-crypto SDK path via the `sdkToken !== null`
 *     guard and fell through to the RPC fallback.
 *   - The aggregator does not implement a `validateToken` JSON-RPC
 *     method (it exposes only `submit_commitment`,
 *     `get_inclusion_proof`, etc.), so the RPC always returned
 *     HTTP 400, and `validateToken` returned `{valid:false}`.
 *   - Net effect: `payments.validate()` reported every wallet token
 *     invalid even though local crypto verification succeeded,
 *     permanently blocking `SwapModule.verifyPayout`'s retry loop.
 *
 * Fix contract:
 *   - Both `validateToken(jsonString)` and `validateToken(object)`
 *     must route into the SDK-path local verifier when trustBase is
 *     loaded — without an aggregator round-trip.
 *   - The string-input path must NOT silently fall through to the
 *     dead RPC fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnicityAggregatorProvider } from '../../../oracle/UnicityAggregatorProvider';
import { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';

// Minimal trustBase shape — single-node quorum, version 1, network 3.
// The SDK `verify` path consults trustBase metadata but the actual
// proof verification uses the embedded UnicityCertificate's BFT
// signatures, which the spy below stubs out.
const TRUST_BASE_JSON = {
  version: 1,
  networkId: 3,
  epoch: 1,
  epochStartRound: 1,
  rootNodes: [
    {
      nodeId: '16Uiu2HAkyQRiA7pMgzgLj9GgaBJEJa8zmx9dzqUDa6WxQPJ82ghU',
      sigKey: '0x' + '0'.repeat(66),
      stake: 1,
    },
  ],
  quorumThreshold: 1,
  stateHash: '',
  changeRecordHash: '',
  previousEntryHash: '',
  signatures: {},
};

// Minimal valid Token JSON shape — has the keys `Token.isJSON` checks
// (`state`, `genesis`, `transactions`, `nametags`). We do NOT exercise
// the full crypto path here; we mock `SdkToken.fromJSON` so the test
// stays scoped to oracle wiring (string-normalization + path routing).
const TOKEN_OBJ = Object.freeze({
  state: {},
  genesis: {},
  transactions: [],
  nametags: [],
});
const TOKEN_STR = JSON.stringify(TOKEN_OBJ);

function makeProvider(opts?: {
  trustBase?: unknown;
}): UnicityAggregatorProvider {
  const provider = new UnicityAggregatorProvider({
    url: 'https://test.example/',
    timeout: 1000,
    skipVerification: false,
  });
  (provider as unknown as { status: string }).status = 'connected';
  if (opts?.trustBase !== undefined) {
    (provider as unknown as { trustBase: unknown }).trustBase = opts.trustBase;
  }
  return provider;
}

// Stub a parsed SdkToken so `verify` returns isSuccessful=true. Calling
// the real verify on a hand-crafted minimal token would fail crypto
// checks; the routing assertions here only need to observe that the
// SDK path was entered.
function mockSdkTokenFromJSON(verifyResult: { isSuccessful: boolean }): void {
  vi.spyOn(SdkToken, 'fromJSON').mockImplementation(async (input: unknown) => {
    // Reproduce real fromJSON's `Token.isJSON` invariant — reject
    // anything that isn't a parsed object. This is what's broken
    // pre-fix when the validateToken caller passes a JSON string;
    // the fix should normalize before reaching this mock.
    if (
      !input ||
      typeof input !== 'object' ||
      !('transactions' in input) ||
      !('nametags' in input)
    ) {
      throw new Error('Invalid JSON structure.');
    }
    return {
      verify: async () => verifyResult,
      state: { calculateHash: async () => ({ toJSON: () => 'stub-state-hash' }) },
    } as unknown as Awaited<ReturnType<typeof SdkToken.fromJSON>>;
  });
}

describe('UnicityAggregatorProvider.validateToken — string-or-object input normalization', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('routes JSON-string input into the SDK local-verify path (no RPC round-trip)', async () => {
    // If the fix is in place, the pre-parse normalizes the string
    // to an object before SdkToken.fromJSON, sdkToken is non-null,
    // the SDK gate at `sdkToken !== null` passes, and `verify()`
    // is invoked locally. `fetch` MUST NOT be called.
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when SDK path runs');
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockSdkTokenFromJSON({ isSuccessful: true });

    const provider = makeProvider({ trustBase: RootTrustBase.fromJSON(TRUST_BASE_JSON) });

    const result = await provider.validateToken(TOKEN_STR);

    expect(result.valid).toBe(true);
    expect(result.spent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes parsed-object input into the same SDK local-verify path', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when SDK path runs');
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockSdkTokenFromJSON({ isSuccessful: true });

    const provider = makeProvider({ trustBase: RootTrustBase.fromJSON(TRUST_BASE_JSON) });

    const result = await provider.validateToken(TOKEN_OBJ);

    expect(result.valid).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports invalid (NOT throws) when SDK verify returns isSuccessful=false', async () => {
    mockSdkTokenFromJSON({ isSuccessful: false });

    const provider = makeProvider({ trustBase: RootTrustBase.fromJSON(TRUST_BASE_JSON) });

    const result = await provider.validateToken(TOKEN_STR);

    expect(result.valid).toBe(false);
    expect(result.spent).toBe(false);
    expect(result.error).toBe('SDK verification failed');
  });
});
