/**
 * Issue #223 steelman fix — verify that the uxf-cid bundle-acquirer
 * branch handles ANY throw from `fetchCarFromIpfs`, not only
 * `ProfileError(BUNDLE_NOT_FOUND)`.
 *
 * The initial #223 fix routed the uxf-cid path through
 * `fetchCarFromIpfs` and re-wrapped its `BUNDLE_NOT_FOUND` errors as
 * `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT` (plus a `transfer:fetch-failed`
 * emit). But the catch was narrow: `cause instanceof ProfileError &&
 * cause.code === 'BUNDLE_NOT_FOUND'`. Several real-world paths inside
 * `fetchCarFromIpfs` throw OTHER error classes:
 *
 *   - `validateGatewayUrls` throws plain `Error` for malformed URLs
 *   - Dynamic `import('@ipld/dag-cbor')` failures throw the loader error
 *   - `CID.parse` can throw on malformed CIDs reached via Tag 42 walk
 *   - `dagCborDecode` / `collectCidLinks` can throw on hostile blocks
 *   - `CarWriter.put` / async writer errors
 *
 * Pre-fix: these escape the narrow catch as bare exceptions, hit
 * `IngestWorkerPool.classifyAcquireError`'s "hard bundle rejection"
 * default arm — log at warn, NO `transfer:fetch-failed` event, NO
 * disposition record. Same silent-drop pattern as the original bug.
 *
 * Post-fix: the catch handles ANY thrown value (Error, TypeError,
 * non-Error rejections), sanitizes the message via
 * `sanitizeReasonString` (W40 alignment), fires `transfer:fetch-failed`,
 * and re-wraps as `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT` so the
 * worker pool's W13 contract is honored regardless of upstream cause.
 *
 * Test strategy: module-mock `fetchCarFromIpfs` to throw each error
 * class we care about, then drive `acquireBundle` and verify both the
 * thrown SphereError code AND the emit event payload.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { isSphereError, SphereError } from '../../../../core/errors';
import { ProfileError } from '../../../../extensions/uxf/profile/errors';
import {
  acquireBundle,
  __clearInflightForTests,
} from '../../../../extensions/uxf/pipeline/bundle-acquirer';
import { ReplayLRU } from '../../../../extensions/uxf/pipeline/replay-lru';
import type { UxfTransferPayloadCid } from '../../../../types/uxf-transfer';

const SENDER = 'a'.repeat(64);
const BUNDLE_CID = 'bafyreigoqei7imlyllzngjgun4yu2mkbmufgkbfxabafh552vyhm2z5lby';
const TOKEN_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';

// =============================================================================
// Module mock — substitute `fetchCarFromIpfs` per-test
// =============================================================================

const mockFetchCarFromIpfs = vi.fn<
  (gateways: readonly string[], rootCid: string) => Promise<Uint8Array>
>();

vi.mock('../../../../extensions/uxf/profile/ipfs-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../extensions/uxf/profile/ipfs-client')>();
  return {
    ...original,
    fetchCarFromIpfs: (...args: Parameters<typeof original.fetchCarFromIpfs>) =>
      mockFetchCarFromIpfs(args[0], args[1]),
  };
});

const cidPayload: UxfTransferPayloadCid = {
  kind: 'uxf-cid',
  version: '1.0',
  mode: 'instant',
  bundleCid: BUNDLE_CID,
  tokenIds: [TOKEN_ID],
};

describe('acquireBundle uxf-cid branch — handles ANY throw from fetchCarFromIpfs (Issue #223 steelman)', () => {
  beforeEach(() => {
    mockFetchCarFromIpfs.mockReset();
    __clearInflightForTests(SENDER, BUNDLE_CID);
  });

  it('ProfileError(BUNDLE_NOT_FOUND) → emit + re-wrap as BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT', async () => {
    mockFetchCarFromIpfs.mockRejectedValueOnce(
      new ProfileError('BUNDLE_NOT_FOUND', 'all gateways failed'),
    );
    const events: Array<{ name: string; payload: unknown }> = [];
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(cidPayload, SENDER, lru, {
        gateways: ['http://gw.example'],
        emit: (name, payload) => { events.push({ name, payload }); },
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
    expect(events.map((e) => e.name)).toContain('transfer:fetch-failed');
  });

  it('plain Error (e.g. validateGatewayUrls throw) → emit + re-wrap (does NOT escape uncaught)', async () => {
    mockFetchCarFromIpfs.mockRejectedValueOnce(
      new Error('invalid gateway URL: not-a-url'),
    );
    const events: Array<{ name: string; payload: unknown }> = [];
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(cidPayload, SENDER, lru, {
        gateways: ['http://gw.example'],
        emit: (name, payload) => { events.push({ name, payload }); },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SphereError);
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
    // The upstream error class is captured in the cause for telemetry.
    const cause = caught.cause as Record<string, unknown> | undefined;
    expect(cause?.upstreamErrorClass).toBe('Error');
    expect(events.map((e) => e.name)).toEqual(['transfer:fetch-failed']);
  });

  it('TypeError (e.g. fetch() returned non-Response) → emit + re-wrap', async () => {
    mockFetchCarFromIpfs.mockRejectedValueOnce(
      new TypeError('Failed to fetch: TypeError on parse'),
    );
    const events: Array<{ name: string; payload: unknown }> = [];
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(cidPayload, SENDER, lru, {
        gateways: ['http://gw.example'],
        emit: (name, payload) => { events.push({ name, payload }); },
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
    expect((caught.cause as { upstreamErrorClass?: string })?.upstreamErrorClass).toBe('TypeError');
    expect(events).toHaveLength(1);
  });

  it('non-Error rejection (e.g. throw "string") → emit + re-wrap with placeholder reason', async () => {
    // Production code rarely throws non-Error values, but defensive
    // handling means we don't crash on it (no `.message` access on a
    // non-Error).
    mockFetchCarFromIpfs.mockRejectedValueOnce('bare string rejection');
    const events: Array<{ name: string; payload: unknown }> = [];
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(cidPayload, SENDER, lru, {
        gateways: ['http://gw.example'],
        emit: (name, payload) => { events.push({ name, payload }); },
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
    expect(events).toHaveLength(1);
  });

  it('sanitizes hostile error messages — strips HTML/control chars from telemetry payload (W40)', async () => {
    // A hostile gateway returning an error message with embedded HTML
    // markup + control chars would otherwise leak verbatim into
    // `transfer:fetch-failed.failureReasons` and downstream operator
    // dashboards. `sanitizeReasonString` strips both.
    mockFetchCarFromIpfs.mockRejectedValueOnce(
      new Error('<script>alert(1)</script>\x00\x07bad'),
    );
    const events: Array<{ name: string; payload: unknown }> = [];
    const lru = new ReplayLRU();
    try {
      await acquireBundle(cidPayload, SENDER, lru, {
        gateways: ['http://gw.example'],
        emit: (name, payload) => { events.push({ name, payload }); },
      });
    } catch {
      /* expected throw */
    }
    expect(events).toHaveLength(1);
    const reason = (
      (events[0]!.payload as { failureReasons: string[] }).failureReasons[0]
    );
    expect(reason).not.toContain('<script>');
    expect(reason).not.toContain('</script>');
    // ASCII control chars are stripped.
    expect(reason).not.toContain('\x00');
    expect(reason).not.toContain('\x07');
    // The "block-walk-failed:" prefix is preserved so dashboards can
    // still classify the event.
    expect(reason).toMatch(/^block-walk-failed:/);
  });

  it('emit is optional — no-emit consumers do not crash on the throw path', async () => {
    mockFetchCarFromIpfs.mockRejectedValueOnce(new Error('boom'));
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(cidPayload, SENDER, lru, {
        gateways: ['http://gw.example'],
        // emit deliberately omitted
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
  });
});
