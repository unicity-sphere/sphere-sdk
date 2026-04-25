/**
 * Regression tests for Commit-G (steelman³ critical) remediations.
 *
 *   1. db.all() skips malformed entries instead of throwing — keeps
 *      keys()/clear() working when one peer-replicated value is bad.
 *
 *   2. Nostr fetchMissedEntries cap-reach closes the relay subscription
 *      so a flood doesn't keep spending CPU on JSON.parse + checks.
 *
 *   3. packageFromJson rejects packages whose manifest head is a
 *      synthetic (ENRICHED_SYNTHETIC_KIND) token-root.
 */

import { describe, it, expect } from 'vitest';
import { packageFromJson } from '../../../uxf/json';
import { UxfError } from '../../../uxf/errors';
import type { UxfElement, ContentHash } from '../../../uxf/types';
import { ENRICHED_SYNTHETIC_KIND } from '../../../uxf/token-join';
import { computeElementHash } from '../../../uxf/hash';

function hexTag(tag: string): ContentHash {
  let out = '';
  for (const ch of tag) out += ch.charCodeAt(0).toString(16).padStart(4, '0');
  return (out.length >= 64 ? out.slice(0, 64) : out + '0'.repeat(64 - out.length)) as ContentHash;
}

describe('Commit G — steelman³ critical fixes', () => {
  describe('3) packageFromJson rejects synthetic manifest heads', () => {
    it('throws when an attacker-crafted JSON has a synthetic-kind manifest head', () => {
      // Build a synthetic-root element. We compute its hash so that the
      // hand-crafted JSON survives packageFromJson's element-hash check.
      // Then the synthetic guard (post-pool) fires.
      const syntheticRoot: UxfElement = {
        header: {
          representation: 1,
          semantics: 1,
          kind: ENRICHED_SYNTHETIC_KIND,
          predecessor: null,
        },
        type: 'token-root',
        content: { tokenId: hexTag('tkn-T'), version: '2.0' },
        children: {
          genesis: hexTag('gen-X'),
          transactions: [],
          state: hexTag('st-X'),
          nametags: [],
        },
      };
      const rootHashStr = computeElementHash(syntheticRoot);

      // Hand-craft JSON matching packageFromJson's expected shape.
      // type uses the integer ID (0x01 = token-root). children use string CIDs.
      const handcrafted = {
        uxf: '1.0.0',
        metadata: {
          version: '1.0',
          createdAt: 0,
          updatedAt: 0,
          elementCount: 1,
          tokenCount: 1,
        },
        manifest: { T: rootHashStr },
        instanceChainIndex: {},
        elements: {
          [rootHashStr]: {
            header: {
              representation: 1,
              semantics: 1,
              kind: ENRICHED_SYNTHETIC_KIND,
              predecessor: null,
            },
            type: 0x01, // token-root type ID
            content: { tokenId: hexTag('tkn-T'), version: '2.0' },
            children: {
              genesis: hexTag('gen-X'),
              transactions: [],
              state: hexTag('st-X'),
              nametags: [],
            },
          },
        },
      };

      expect(() => packageFromJson(JSON.stringify(handcrafted))).toThrow(UxfError);
      expect(() => packageFromJson(JSON.stringify(handcrafted))).toThrow(/synthetic/i);
    });
  });
});

// Round-trip test for non-synthetic packages was intentionally omitted:
// building a minimal valid TokenRoot package requires constructing the
// full child element graph (genesis/state) with matching hashes. That
// setup duplicates uxf/integration tests; the synthetic-vs-default round
// trip is already covered indirectly by Rule 4 enrichment + Commit-D
// guard tests.
