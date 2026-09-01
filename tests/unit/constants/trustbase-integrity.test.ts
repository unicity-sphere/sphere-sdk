/**
 * The embedded trust bases ARE the root of trust.
 *
 * `RootTrustBase.fromJSON` checks only structure — version, duplicate nodeIds,
 * non-empty rootNodes and 0 < quorumThreshold <= rootNodes — and never verifies
 * the `signatures` map against the root nodes. So whatever bytes sit in
 * assets/trustbase.ts are accepted as authoritative, and the engine takes its
 * NetworkId straight from them (token-engine/factory.ts). A stray edit, a
 * mis-transcribed sigKey or a copy-paste of the wrong network's base would be
 * silently trusted and would verify real money against the wrong chain.
 *
 * These tests pin the embedded literal to the published file byte-for-byte.
 * The fixture is the published bft-trustbase.mainnet.json verbatim — when the
 * trust base legitimately rotates, update the fixture AND the digest together,
 * from the published source, never by pasting whatever the literal happens to
 * produce.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TRUSTBASE_MAINNET, TRUSTBASE_TESTNET2 } from '../../../assets/trustbase';

/** sha256 of the published https://github.com/unicitynetwork/unicity-ids/bft-trustbase.mainnet.json */
const MAINNET_TRUSTBASE_SHA256 =
  '346c217b3f0f5debb906781a49c29791f8dcbba63f24615e5a78fcd9b79b43f8';

const rawMainnet = readFileSync(join(__dirname, 'fixtures', 'bft-trustbase.mainnet.json'));

describe('embedded mainnet trust base', () => {
  it('the fixture is the published file (digest over the RAW bytes)', () => {
    // Deliberately NOT a digest of JSON.stringify(TRUSTBASE_MAINNET): a TS literal
    // cannot reproduce the published bytes, and such a test gets "fixed" by pasting
    // whatever digest the object yields — which would pin nothing.
    expect(createHash('sha256').update(rawMainnet).digest('hex')).toBe(MAINNET_TRUSTBASE_SHA256);
  });

  it('the embedded literal deep-equals the published file', () => {
    expect(TRUSTBASE_MAINNET).toEqual(JSON.parse(rawMainnet.toString('utf8')));
  });

  it('declares mainnet: networkId 1, 4 root nodes, quorum 3', () => {
    expect(TRUSTBASE_MAINNET.networkId).toBe(1);
    expect(TRUSTBASE_MAINNET.rootNodes).toHaveLength(4);
    expect(TRUSTBASE_MAINNET.quorumThreshold).toBe(3);
  });

  it('every root node has a signature, and quorum is reachable but not trivial', () => {
    const nodeIds = TRUSTBASE_MAINNET.rootNodes.map((n) => n.nodeId);
    expect(new Set(nodeIds).size).toBe(nodeIds.length); // no duplicate nodeIds
    expect(Object.keys(TRUSTBASE_MAINNET.signatures).sort()).toEqual([...nodeIds].sort());
    expect(TRUSTBASE_MAINNET.quorumThreshold).toBeGreaterThan(nodeIds.length / 2);
    expect(TRUSTBASE_MAINNET.quorumThreshold).toBeLessThanOrEqual(nodeIds.length);
  });

  it('is NOT the testnet2 trust base', () => {
    // assets/trustbase.ts used to alias one network's base onto another
    // (TRUSTBASE_DEV = TRUSTBASE_TESTNET, removed with the v1 cleanup), so this is
    // a mistake the file has actually made. A shared reference here would verify
    // mainnet money against testnet2's root nodes.
    expect(TRUSTBASE_MAINNET).not.toBe(TRUSTBASE_TESTNET2);
    expect(TRUSTBASE_MAINNET.networkId).not.toBe(TRUSTBASE_TESTNET2.networkId);
    expect(TRUSTBASE_MAINNET.rootNodes.map((n) => n.sigKey)).not.toEqual(
      TRUSTBASE_TESTNET2.rootNodes.map((n) => n.sigKey),
    );
  });
});
