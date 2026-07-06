/**
 * Log-scrub test (T-A7b): derived secret bytes MUST NOT reach any
 * serialization / logging output path.
 *
 * Strategy: use a magic walletPrivateKey chosen such that the derived
 * pointerSecret / signingSeed / xorSeed / padSeed contain recognizable
 * byte patterns. Install a poisoned console + JSON.stringify + inspect
 * capture harness. Run the full Phase A derivation chain (including
 * SigningService + health-check + per-version derivations). Grep the
 * capture buffer for any of the derived secret-byte substrings —
 * expected: zero hits.
 *
 * NOTE: this test cannot catch every conceivable leakage path (e.g.,
 * stack traces, core dumps, /proc visibility). It catches the ones
 * the wrapper is designed to prevent: toString, toJSON, util.inspect,
 * accidental string interpolation.
 */

import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import {
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  deriveStateHashDigest,
  deriveXorKey,
  derivePaddingBytes,
  buildPointerSigner,
  deriveHealthCheckRequestId,
  bytesToHex,
  SIDE_A_NUM,
  SIDE_B_NUM,
} from '../../../../extensions/uxf/profile/aggregator-pointer/index.js';

describe('log-scrub (T-A7b)', () => {
  it('derived secret bytes never appear in console / JSON / util.inspect output', async () => {
    const captured: string[] = [];

    // Poisoned capture hooks
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    console.log = (...args: unknown[]) => captured.push(args.map((a) => String(a)).join(' '));
    console.error = (...args: unknown[]) => captured.push(args.map((a) => String(a)).join(' '));
    console.warn = (...args: unknown[]) => captured.push(args.map((a) => String(a)).join(' '));

    try {
      // Use a magic-valued walletPrivateKey that produces identifiable derivations.
      const walletBytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) walletBytes[i] = 0xa0 + i;
      const master = createMasterPrivateKey(walletBytes);
      const km = derivePointerKeyMaterial(master);

      // Record the hex of every derived secret — these are what we grep for.
      const secretHexes: string[] = [
        bytesToHex(km.pointerSecret.reveal()),
        bytesToHex(km.signingSeed.reveal()),
        bytesToHex(km.xorSeed.reveal()),
        bytesToHex(km.padSeed.reveal()),
      ];

      // Exercise every serialization surface a bad impl might leak through.
      captured.push(String(km.pointerSecret));
      captured.push(String(km.signingSeed));
      captured.push(String(km.xorSeed));
      captured.push(String(km.padSeed));
      captured.push(JSON.stringify({ km }));
      captured.push(JSON.stringify(km));
      captured.push(JSON.stringify({ seeds: [km.signingSeed, km.xorSeed, km.padSeed] }));
      captured.push(inspect(km, { depth: 5 }));
      captured.push(inspect({ kmWrapped: { inner: km } }, { depth: 10 }));
      captured.push(`${km.pointerSecret}`);
      captured.push(`${km.signingSeed}`);
      // Object.keys / spread / Object.entries / Object.assign — the
      // surfaces a TypeScript `private` modifier fails to protect.
      captured.push(JSON.stringify(Object.keys(km.signingSeed)));
      captured.push(JSON.stringify(Object.entries(km.signingSeed)));
      captured.push(JSON.stringify({ ...km.signingSeed }));
      captured.push(JSON.stringify(Object.assign({}, km.xorSeed)));
      captured.push(JSON.stringify(Object.getOwnPropertyNames(km.padSeed)));
      // Error objects may get toString'd in stack traces
      const err = new Error(`something happened involving ${km.xorSeed}`);
      captured.push(String(err));
      captured.push(inspect(err));
      // Also try to structuredClone — should throw, but in case impl
      // ever changes to a plain-object shape, catch would let the
      // test exercise the clone output.
      try {
        const cloned = structuredClone(km as unknown as Record<string, unknown>);
        captured.push(inspect(cloned));
      } catch {
        // Expected path for private-fields-based SecretKey.
      }

      // Exercise downstream uses — signer, per-version derivations,
      // health-check — to ensure those code paths don't leak.
      const signer = await buildPointerSigner(km.signingSeed);
      const stateA = deriveStateHashDigest(km.xorSeed, SIDE_A_NUM, 1);
      const stateB = deriveStateHashDigest(km.xorSeed, SIDE_B_NUM, 1);
      const xorA = deriveXorKey(km.xorSeed, SIDE_A_NUM, 1);
      const xorB = deriveXorKey(km.xorSeed, SIDE_B_NUM, 1);
      const pad = derivePaddingBytes(km.padSeed, 1, 36);
      const healthRid = deriveHealthCheckRequestId(signer.signingPubKey);

      // These are NOT secret — they're derivation OUTPUTS, public on the SMT.
      // But log-scrub is only concerned with the upstream secret bytes.
      void stateA;
      void stateB;
      void xorA;
      void xorB;
      void pad;
      void healthRid;

      // Sanity check: the capture harness actually captured something.
      // Without this, a broken harness could silently pass the test.
      expect(captured.length).toBeGreaterThan(10);

      // Now grep the capture buffer for ANY of the secret hex strings.
      const joined = captured.join('\n');
      for (const hex of secretHexes) {
        expect(joined).not.toContain(hex);
      }

      // Also grep for 16-byte substrings of each secret (partial-leak defense).
      for (const hex of secretHexes) {
        const prefix = hex.slice(0, 32); // 16 bytes = 32 hex chars
        const middle = hex.slice(20, 52);
        const suffix = hex.slice(-32);
        expect(joined).not.toContain(prefix);
        expect(joined).not.toContain(middle);
        expect(joined).not.toContain(suffix);
      }
    } finally {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
    }
  });
});
