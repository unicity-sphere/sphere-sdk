/**
 * PumpHealth (#630): the background wallet-api pumps (mailbox / payment-requests
 * / inventory) must stop dumping a full WalletApiError stack every 30 s tick
 * during a transient outage. A NETWORK blip is one `debug` line (no stack),
 * escalating to a single `warn` only after N consecutive failures, with one
 * recovery line when it clears; a non-network fault stays loud and immediate and
 * is never counted. Captured through the logger's injectable handler.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { logger } from '../../../core/logger';
import { WalletApiError } from '../../../wallet-api';
import { PumpHealth } from '../../../modules/payments/pump-health';

interface Line {
  level: string;
  message: string;
  args: unknown[];
}

describe('PumpHealth — quiet-then-escalate pump logging (#630)', () => {
  const lines: Line[] = [];

  beforeEach(() => {
    lines.length = 0;
    logger.configure({
      debug: true, // so `debug`-level lines reach the handler
      handler: (level, _tag, message, ...args) => lines.push({ level, message, args }),
    });
  });
  afterEach(() => logger.reset());

  const network = (): WalletApiError => new WalletApiError('fetch failed', 'NETWORK');
  const warns = (): Line[] => lines.filter((l) => l.level === 'warn');
  const debugs = (): Line[] => lines.filter((l) => l.level === 'debug');
  const noErrorArgs = (l: Line): void => l.args.forEach((a) => expect(a).not.toBeInstanceOf(Error));

  it('keeps transient NETWORK failures quiet, then escalates ONCE at the threshold', () => {
    const h = new PumpHealth(4);
    for (let i = 0; i < 3; i += 1) h.failure('delivery', network());
    expect(warns()).toHaveLength(0); // first three are quiet
    expect(debugs()).toHaveLength(3); // one debug line each

    h.failure('delivery', network()); // 4th → escalate
    expect(warns()).toHaveLength(1);
    expect(warns()[0].message).toMatch(/degraded/);

    h.failure('delivery', network()); // 5th → no NEW warn
    expect(warns()).toHaveLength(1);
  });

  it('never hands the Error object to the logger (no stack-per-tick)', () => {
    const h = new PumpHealth(4);
    h.failure('inventory', network());
    lines.forEach(noErrorArgs); // the WalletApiError is never a log arg — message strings only
  });

  it('resets on success and logs one recovery line after escalation', () => {
    const h = new PumpHealth(2);
    h.failure('payment-requests', network());
    h.failure('payment-requests', network()); // degraded → warn #1
    expect(warns()).toHaveLength(1);

    h.success('payment-requests'); // recovered → warn #2
    expect(warns()).toHaveLength(2);
    expect(warns()[1].message).toMatch(/recovered/);

    // counter was reset — it takes two fresh failures to escalate again
    h.failure('payment-requests', network());
    expect(warns()).toHaveLength(2);
    h.failure('payment-requests', network());
    expect(warns()).toHaveLength(3);
  });

  it('a plain success (never degraded) logs nothing', () => {
    const h = new PumpHealth(2);
    h.success('delivery');
    expect(lines).toHaveLength(0);
  });

  it('a non-NETWORK fault is loud immediately, message-only, and NOT counted', () => {
    const h = new PumpHealth(4);
    h.failure('delivery', new WalletApiError('bad body', 'VALIDATION', 422));
    expect(warns()).toHaveLength(1);
    expect(warns()[0].message).toMatch(/pump failed/);
    noErrorArgs(warns()[0]);

    for (let i = 0; i < 6; i += 1) h.failure('delivery', new WalletApiError('bad', 'VALIDATION', 422));
    expect(warns().filter((w) => /degraded/.test(w.message))).toHaveLength(0); // never escalates
  });

  it('run() classifies a SYNCHRONOUS throw as a failure (never an unhandled rejection)', async () => {
    const h = new PumpHealth(1);
    h.run('delivery', () => {
      throw network(); // throws before returning a Promise
    });
    await new Promise((r) => setTimeout(r, 0)); // flush the microtask chain
    expect(warns()).toHaveLength(1); // degradeAfter=1 → the single failure escalates
    expect(warns()[0].message).toMatch(/degraded/);
  });

  it('run() resets the counter on a successful run', async () => {
    const h = new PumpHealth(2);
    h.failure('inventory', network()); // #1
    h.run('inventory', async () => undefined); // success → reset
    await new Promise((r) => setTimeout(r, 0));
    h.failure('inventory', network()); // #1 again (not #2) — so no escalation yet
    expect(warns()).toHaveLength(0);
  });

  it('tracks each pump stream independently', () => {
    const h = new PumpHealth(2);
    h.failure('delivery', network());
    h.failure('inventory', network()); // a different stream — each at 1
    expect(warns()).toHaveLength(0);

    h.failure('delivery', network()); // delivery reaches 2 → degraded
    expect(warns()).toHaveLength(1);
    expect(warns()[0].message).toMatch(/delivery/);
  });
});
