/**
 * Signed monotonic Merkle root (§5.4) — leaf/tombstone KATs, order-independence,
 * fold, and signRoot/verifyRoot round-trip.
 */

import { describe, it, expect } from 'vitest';

import {
  leaf,
  computeRoot,
  foldDelta,
  signRoot,
  verifyRoot,
  type EntryState,
} from '../../../storage/remote/merkle';
import { bytesToHex } from '../../../core/crypto';

const WALLET_PRIV = '11'.repeat(32);
const OWNER = '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';
const PUBKEY = '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';

describe('vault merkle root primitives', () => {
  it('leaf KAT (pinned for fixed key/version)', () => {
    expect(bytesToHex(leaf('k1', 3))).toBe(
      'a73bc36fa44228690b53e342dc2aa80001e7dd29377355542cc4f70e5d88e048',
    );
  });

  it('tombstone leaf KAT (deleted flag sets the high bit of the version field)', () => {
    expect(bytesToHex(leaf('k1', 3, true))).toBe(
      '46a937e39ea47d5ac508206296f63c22038d56d907a715007e4af3f3bad2c95c',
    );
    // a tombstone leaf differs from the live leaf for the same (key, version)
    expect(bytesToHex(leaf('k1', 3, true))).not.toBe(bytesToHex(leaf('k1', 3, false)));
  });

  it('root is order-independent (same map, two insertion orders -> same root)', () => {
    const a = new Map<string, EntryState>([
      ['k1', { version: 3 }],
      ['k2', { version: 1 }],
      ['k3', { version: 7, deleted: true }],
    ]);
    const b = new Map<string, EntryState>([
      ['k3', { version: 7, deleted: true }],
      ['k1', { version: 3 }],
      ['k2', { version: 1 }],
    ]);
    expect(computeRoot(a)).toBe(computeRoot(b));
    // pinned root KAT for this map
    expect(computeRoot(a)).toBe(
      '5d97654d997d152670bc5c21b0e761f3f646946e3ba72b5a3cd547a2579fdd1d',
    );
  });

  it('foldDelta applies a delta and recomputes the root (matches a fresh computeRoot)', () => {
    const base = new Map<string, EntryState>([['k1', { version: 3 }]]);
    const delta = new Map<string, EntryState>([
      ['k2', { version: 1 }],
      ['k3', { version: 7, deleted: true }],
    ]);
    const { state, root } = foldDelta(base, delta);
    // prevState is not mutated
    expect(base.size).toBe(1);
    // folded state equals the full map
    expect(root).toBe(
      computeRoot(
        new Map<string, EntryState>([
          ['k1', { version: 3 }],
          ['k2', { version: 1 }],
          ['k3', { version: 7, deleted: true }],
        ]),
      ),
    );
    expect(state.size).toBe(3);
  });

  it('signRoot/verifyRoot round-trip + pinned KAT', () => {
    const binding = {
      network: 'testnet2',
      ownerId: OWNER,
      cursor: 5,
      root: '5d97654d997d152670bc5c21b0e761f3f646946e3ba72b5a3cd547a2579fdd1d',
    };
    const sig = signRoot(WALLET_PRIV, binding);
    expect(sig).toBe(
      '1fec5158bcc8fee660093797e537dbefe5a13ce2ee106f793baa66fd713c5484c407d28beb95f507c2db548e58b2dc85307b4227947bd1b5ad1df2a55ebef83736',
    );
    expect(verifyRoot(binding, sig, PUBKEY)).toBe(true);
    // a tampered cursor fails verification
    expect(verifyRoot({ ...binding, cursor: 6 }, sig, PUBKEY)).toBe(false);
  });
});
