import { describe, expect, it, vi } from 'vitest';

import { SphereError } from '../../../core/errors';
import { readTokenData, readTokenJustification } from '../../../modules/payments-v2/inventory/token-data';
import type { ITokenEngine } from '../../../token-engine/engine';
import type { SphereToken, TokenBlob } from '../../../token-engine/types';

const TOKEN = 'aa'.repeat(32);
const PAYLOAD = new TextEncoder().encode('kitty #1');
const REASON = new Uint8Array([0xd9, 0x14, 0x4c, 0x52]);

function engineWith(data: Uint8Array | null, justification: Uint8Array | null = REASON): ITokenEngine {
  return {
    decodeToken: vi.fn(async (blob: TokenBlob) => ({ blob }) as unknown as SphereToken),
    readTokenData: vi.fn(() => data),
    readTokenJustification: vi.fn(() => justification),
  } as unknown as ITokenEngine;
}

function deps(opts: {
  stateHash?: string | undefined;
  blobs?: Map<string, Uint8Array>;
  data?: Uint8Array | null;
  onFetch?: () => void;
}) {
  return {
    engine: engineWith(opts.data === undefined ? PAYLOAD : opts.data),
    view: { stateHashOf: () => opts.stateHash },
    storagePort: {
      getBlobs: vi.fn(async () => {
        opts.onFetch?.();
        return opts.blobs ?? new Map([[TOKEN, new Uint8Array([1])]]);
      }),
    },
  };
}

describe('readTokenData', () => {
  it('returns the genesis payload of a held token', async () => {
    await expect(readTokenData(deps({ stateHash: 'S1' }), TOKEN)).resolves.toEqual(PAYLOAD);
  });

  it('returns null for a token that carries no payload', async () => {
    await expect(readTokenData(deps({ stateHash: 'S1', data: null }), TOKEN)).resolves.toBeNull();
  });

  it('refuses a token the wallet does not hold, without fetching a blob', async () => {
    const onFetch = vi.fn();
    const d = deps({ stateHash: undefined, onFetch });
    await expect(readTokenData(d, TOKEN)).rejects.toBeInstanceOf(SphereError);
    expect(onFetch).not.toHaveBeenCalled();
  });

  it('refuses when the blob is missing rather than reporting an empty payload', async () => {
    const d = deps({ stateHash: 'S1', blobs: new Map() });
    await expect(readTokenData(d, TOKEN)).rejects.toThrow(/no blob in storage/);
  });

  it('needs no post-fetch re-check: genesis is byte-identical in every blob of the chain, so a state advance in flight cannot change the payload', async () => {
    // The presence check guards "do we hold this token", never freshness. The token
    // advances state (and is even tombstoned) while getBlobs is in flight; the
    // payload is fixed at mint, so the answer is still correct and returning it is
    // not a stale read.
    let stateHash: string | undefined = 'S1';
    const d = {
      engine: engineWith(PAYLOAD),
      view: { stateHashOf: () => stateHash },
      storagePort: {
        getBlobs: vi.fn(async () => {
          stateHash = undefined; // spent / tombstoned mid-flight
          return new Map([[TOKEN, new Uint8Array([1])]]);
        }),
      },
    };
    await expect(readTokenData(d, TOKEN)).resolves.toEqual(PAYLOAD);
  });
});

describe('readTokenJustification', () => {
  it('returns the mint reason of a held token', async () => {
    await expect(readTokenJustification(deps({ stateHash: 'S1' }), TOKEN)).resolves.toEqual(REASON);
  });

  it('returns null for a token minted without one', async () => {
    const d = { ...deps({ stateHash: 'S1' }), engine: engineWith(PAYLOAD, null) };
    await expect(readTokenJustification(d, TOKEN)).resolves.toBeNull();
  });

  it('refuses a token the wallet does not hold, like readTokenData', async () => {
    await expect(readTokenJustification(deps({ stateHash: undefined }), TOKEN)).rejects.toBeInstanceOf(SphereError);
  });
});
