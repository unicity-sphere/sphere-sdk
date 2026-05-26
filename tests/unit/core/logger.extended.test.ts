import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSink,
  clearSinks,
  createRingBufferSink,
  disableDebug,
  getLogger,
  listDebug,
  logger,
  setDebug,
} from '../../../core/logger';
import type { LogRecord, LogSink } from '../../../core/logger';

const envSnapshot = { ...process.env };

beforeEach(() => {
  logger.reset();
});

afterEach(() => {
  // restore env between tests because the logger reads SPHERE_DEBUG once on init
  for (const k of Object.keys(process.env)) {
    if (!(k in envSnapshot)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(envSnapshot)) process.env[k] = v;
  logger.reset();
});

describe('Extended logger (issue #274)', () => {
  describe('namespace levels and spec parsing', () => {
    it('setDebug("payments:*") enables debug for payments and children', () => {
      setDebug('payments:*');
      expect(logger.isDebugEnabled('payments')).toBe(true);
      expect(logger.isDebugEnabled('payments:send')).toBe(true);
      expect(logger.isDebugEnabled('payments:send:execute')).toBe(true);
      expect(logger.isDebugEnabled('transport:nostr')).toBe(false);
    });

    it('per-namespace level qualifier sets gating', () => {
      setDebug('payments:send=trace');
      const log = getLogger('payments:send');
      expect(log.isEnabled('trace')).toBe(true);
      expect(log.isEnabled('debug')).toBe(true);
      const other = getLogger('payments:receive');
      expect(other.isEnabled('debug')).toBe(false);
      expect(other.isEnabled('warn')).toBe(true);
    });

    it('warn and error are always enabled', () => {
      // No spec applied — defaults.
      const log = getLogger('transport:nostr');
      expect(log.isEnabled('warn')).toBe(true);
      expect(log.isEnabled('error')).toBe(true);
      expect(log.isEnabled('debug')).toBe(false);
    });

    it('child loggers inherit namespace from parent', () => {
      setDebug('payments:*=info');
      const root = getLogger('payments');
      const child = root.child('send').child('plan');
      expect(child.namespace).toBe('payments:send:plan');
      expect(child.isEnabled('info')).toBe(true);
      expect(child.isEnabled('debug')).toBe(false);
    });

    it('listDebug reports active namespace levels', () => {
      setDebug('payments:*,transport:nostr=trace');
      const list = listDebug();
      const map = new Map(list.map((e) => [e.namespace, e.level]));
      expect(map.get('payments:*')).toBe('debug');
      expect(map.get('transport:nostr')).toBe('trace');
    });

    it('disableDebug clears all overrides', () => {
      setDebug('*=trace');
      expect(logger.isDebugEnabled('anything')).toBe(true);
      disableDebug();
      expect(logger.isDebugEnabled('anything')).toBe(false);
    });

    it('negation pattern raises minimum to warn', () => {
      setDebug('*=debug,-transport:nostr');
      expect(logger.isDebugEnabled('payments:send')).toBe(true);
      expect(logger.isDebugEnabled('transport:nostr')).toBe(false);
    });
  });

  describe('env bootstrap', () => {
    it('reads SPHERE_DEBUG once on first state access', () => {
      logger.reset(); // wipe singleton
      process.env.SPHERE_DEBUG = 'payments:send=trace';
      // First call triggers bootstrap
      expect(getLogger('payments:send').isEnabled('trace')).toBe(true);
      expect(getLogger('transport:nostr').isEnabled('debug')).toBe(false);
    });

    it('SPHERE_LOG is honoured as a synonym', () => {
      logger.reset();
      delete process.env.SPHERE_DEBUG;
      process.env.SPHERE_LOG = 'transport:*';
      expect(getLogger('transport:nostr').isEnabled('debug')).toBe(true);
    });

    it('does not bootstrap twice', () => {
      logger.reset();
      process.env.SPHERE_DEBUG = 'payments:*';
      expect(logger.isDebugEnabled('payments')).toBe(true);
      // mutate env after bootstrap — should NOT take effect
      process.env.SPHERE_DEBUG = 'transport:nostr';
      // re-access state — bootstrap flag prevents re-read
      expect(logger.isDebugEnabled('transport:nostr')).toBe(false);
      expect(logger.isDebugEnabled('payments')).toBe(true);
    });
  });

  describe('redaction', () => {
    it('redacts denylisted keys at top level of fields', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) {
          this.records.push(record);
        },
      };
      addSink(sink);
      setDebug('redact:test');
      getLogger('redact:test').debug('event', {
        privateKey: 'aabbcc',
        mnemonic: 'twelve words here',
        password: 'hunter2',
        normal: 'ok',
      });
      expect(sink.records.length).toBe(1);
      const fields = sink.records[0].fields!;
      expect(fields.privateKey).toBe('[REDACTED]');
      expect(fields.mnemonic).toBe('[REDACTED]');
      expect(fields.password).toBe('[REDACTED]');
      expect(fields.normal).toBe('ok');
    });

    it('redacts denylisted keys at one-level nesting', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) {
          this.records.push(record);
        },
      };
      addSink(sink);
      setDebug('redact:test');
      getLogger('redact:test').debug('event', {
        ctx: { nsec: 'abc', name: 'alice', apiKey: 'sk-xyz' },
      });
      const ctx = sink.records[0].fields!.ctx as Record<string, unknown>;
      expect(ctx.nsec).toBe('[REDACTED]');
      expect(ctx.apiKey).toBe('[REDACTED]');
      expect(ctx.name).toBe('alice');
    });

    it('redacts denylisted keys in legacy positional args', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) {
          this.records.push(record);
        },
      };
      addSink(sink);
      setDebug('redact:legacy=debug');
      logger.debug('redact:legacy', 'event', { password: 'p4ss', visible: 'v' });
      const arg0 = sink.records[0].args![0] as Record<string, unknown>;
      expect(arg0.password).toBe('[REDACTED]');
      expect(arg0.visible).toBe('v');
    });

    it('redaction can be disabled via configure', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) {
          this.records.push(record);
        },
      };
      addSink(sink);
      logger.configure({ redaction: false });
      setDebug('redact:off');
      getLogger('redact:off').debug('event', { privateKey: 'plain' });
      expect(sink.records[0].fields!.privateKey).toBe('plain');
    });

    it('redacts via regex match on compound key names', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) {
          this.records.push(record);
        },
      };
      addSink(sink);
      setDebug('redact:rx');
      getLogger('redact:rx').debug('event', {
        userSecret: 'should-redact',
        api_key: 'should-redact',
        my_password: 'should-redact',
        normalField: 'keep',
      });
      const f = sink.records[0].fields!;
      expect(f.userSecret).toBe('[REDACTED]');
      expect(f.api_key).toBe('[REDACTED]');
      expect(f.my_password).toBe('[REDACTED]');
      expect(f.normalField).toBe('keep');
    });
  });

  describe('lazy variants', () => {
    it('debugLazy does not invoke builder when disabled', () => {
      const build = vi.fn(() => ['msg', { x: 1 }] as [string, Record<string, unknown>?]);
      getLogger('cold').debugLazy(build);
      expect(build).not.toHaveBeenCalled();
    });

    it('debugLazy invokes builder when enabled', () => {
      setDebug('hot');
      const build = vi.fn(() => ['hot msg', { x: 1 }] as [string, Record<string, unknown>?]);
      getLogger('hot').debugLazy(build);
      expect(build).toHaveBeenCalledTimes(1);
    });

    it('traceLazy gated separately from debug', () => {
      setDebug('mix=debug');
      const buildTrace = vi.fn(() => ['t', undefined] as [string, Record<string, unknown>?]);
      const buildDebug = vi.fn(() => ['d', undefined] as [string, Record<string, unknown>?]);
      getLogger('mix').traceLazy(buildTrace);
      getLogger('mix').debugLazy(buildDebug);
      expect(buildTrace).not.toHaveBeenCalled();
      expect(buildDebug).toHaveBeenCalled();
    });
  });

  describe('Span timing', () => {
    it('emits one debug record on end with durationMs and marks', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) {
          this.records.push(record);
        },
      };
      addSink(sink);
      setDebug('span:test');
      const log = getLogger('span:test');
      const span = log.time('op', { id: 'abc' });
      span.mark('step1', { items: 4 });
      span.mark('step2');
      const dur = span.end({ ok: true });
      expect(dur).toBeGreaterThanOrEqual(0);
      // The span emits one record (span.end). No record for start, no record per mark at debug level.
      const spanRecs = sink.records.filter((r) => typeof r.fields?.spanName === 'string');
      expect(spanRecs.length).toBe(1);
      expect(spanRecs[0].level).toBe('debug');
      const f = spanRecs[0].fields!;
      expect(f.spanName).toBe('op');
      expect(typeof f.durationMs).toBe('number');
      expect(f.ok).toBe(true);
      expect(f.id).toBe('abc');
      const marks = f.marks as Array<{ label: string }>;
      expect(marks.map((m) => m.label)).toEqual(['step1', 'step2']);
    });

    it('endWithError emits warn-level record', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) {
          this.records.push(record);
        },
      };
      addSink(sink);
      const span = getLogger('span:err').time('op');
      const err = new Error('boom');
      span.endWithError(err, { phase: 'submit' });
      const rec = sink.records.find((r) => r.fields?.spanName === 'op')!;
      expect(rec.level).toBe('warn');
      expect((rec.fields!.err as string).includes('boom')).toBe(true);
      expect(rec.fields!.phase).toBe('submit');
    });

    it('double-end is a no-op', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) {
          this.records.push(record);
        },
      };
      addSink(sink);
      setDebug('span:double');
      const span = getLogger('span:double').time('op');
      span.end();
      span.end();
      span.endWithError(new Error('late'));
      const spanRecs = sink.records.filter((r) => r.fields?.spanName === 'op');
      expect(spanRecs.length).toBe(1);
    });
  });

  describe('RingBufferSink', () => {
    it('buffers records up to capacity, oldest first', () => {
      const buf = createRingBufferSink(3);
      addSink(buf);
      setDebug('ring');
      const log = getLogger('ring');
      log.debug('a');
      log.debug('b');
      log.debug('c');
      log.debug('d');
      log.debug('e');
      const recs = buf.getRecords();
      expect(recs.length).toBe(3);
      expect(recs.map((r) => r.message)).toEqual(['c', 'd', 'e']);
    });

    it('clear empties the buffer', () => {
      const buf = createRingBufferSink(2);
      addSink(buf);
      setDebug('ring:clear');
      getLogger('ring:clear').debug('x');
      expect(buf.getRecords().length).toBe(1);
      buf.clear();
      expect(buf.getRecords().length).toBe(0);
    });
  });

  describe('multi-sink dispatch', () => {
    it('writes to every registered sink', () => {
      const a = vi.fn();
      const b = vi.fn();
      addSink({ write: a });
      addSink({ write: b });
      setDebug('multi');
      getLogger('multi').debug('hello');
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('a throwing sink does not block other sinks', () => {
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const a = vi.fn(() => { throw new Error('bad sink'); });
      const b = vi.fn();
      addSink({ write: a });
      addSink({ write: b });
      setDebug('throw');
      getLogger('throw').debug('hello');
      expect(a).toHaveBeenCalled();
      expect(b).toHaveBeenCalled();
      consoleErrSpy.mockRestore();
    });

    it('clearSinks removes all sinks; default console resumes', () => {
      const a = vi.fn();
      const removeA = addSink({ write: a });
      removeA();
      clearSinks();
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      setDebug('cleared');
      getLogger('cleared').debug('back to console');
      expect(consoleLogSpy).toHaveBeenCalled();
      expect(a).not.toHaveBeenCalled();
      consoleLogSpy.mockRestore();
    });
  });

  describe('toggle symmetry (review S1, S2, S6)', () => {
    it('setDebug("") is a no-op — does not enable timestamps', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) { this.records.push(record); },
      };
      addSink(sink);
      logger.configure({ debug: true });   // legacy boolean — no timestamps
      setDebug('');                         // empty spec
      expect(listDebug()).toEqual([{ namespace: '*', level: 'debug' }]);
      logger.debug('LegacyTag', 'no timestamps please');
      // Single record; default sink would have used legacy split — assert format
      // by checking the test sink received fields=undefined and that
      // state.timestamps is still false.
      expect(sink.records.length).toBe(1);
      expect(sink.records[0].fields).toBeUndefined();
    });

    it('setDebug(false) and disableDebug() both reset timestamps', () => {
      setDebug('payments:*');
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record, formatted) { this.records.push({ ...record, message: formatted }); },
      };
      addSink(sink);
      setDebug(false);
      logger.warn('post-reset', 'visible');
      // warn always fires; check the formatted line has NO timestamp prefix
      expect(sink.records[0].message.startsWith('[post-reset]')).toBe(true);

      // Now via disableDebug
      sink.records.length = 0;
      setDebug('payments:*');
      disableDebug();
      logger.warn('post-disable', 'visible');
      expect(sink.records[0].message.startsWith('[post-disable]')).toBe(true);
    });

    it('parseSpec emits console.warn on invalid level qualifier', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setDebug('payments:send=tracee');     // typo
      expect(consoleWarn).toHaveBeenCalled();
      // Falls back to 'debug', not silently dropped
      expect(getLogger('payments:send').isEnabled('debug')).toBe(true);
      consoleWarn.mockRestore();
    });
  });

  describe('deep redaction (security review C1)', () => {
    it('redacts secrets nested at depth 3+', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) { this.records.push(record); },
      };
      addSink(sink);
      setDebug('deep');
      getLogger('deep').debug('event', {
        outer: { middle: { inner: { privateKey: 'X', mnemonic: 'Y', safe: 'Z' } } },
      });
      const inner = (((sink.records[0].fields!.outer as Record<string, unknown>).middle as Record<string, unknown>).inner as Record<string, unknown>);
      expect(inner.privateKey).toBe('[REDACTED]');
      expect(inner.mnemonic).toBe('[REDACTED]');
      expect(inner.safe).toBe('Z');
    });

    it('caps recursion at REDACT_MAX_DEPTH and replaces deeper values', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) { this.records.push(record); },
      };
      addSink(sink);
      setDebug('depth');
      // build a 10-deep nested object
      let v: Record<string, unknown> = { leaf: 'reached' };
      for (let i = 0; i < 10; i++) v = { next: v };
      getLogger('depth').debug('event', { root: v });
      // Walk down — at depth ≥ 8 it should be [REDACTED:depth-exceeded]
      let cur: unknown = sink.records[0].fields!.root;
      let depth = 0;
      while (cur && typeof cur === 'object' && 'next' in (cur as object)) {
        cur = (cur as Record<string, unknown>).next;
        depth += 1;
        if (depth > 12) break;
      }
      // Some level must be the truncation sentinel — otherwise the cap leaked.
      const serialized = JSON.stringify(sink.records[0].fields);
      expect(serialized).toContain('[REDACTED:depth-exceeded]');
    });

    it('handles cycles without infinite recursion', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) { this.records.push(record); },
      };
      addSink(sink);
      setDebug('cycle');
      const a: Record<string, unknown> = { name: 'a' };
      const b: Record<string, unknown> = { name: 'b', child: a };
      a.child = b; // cycle
      getLogger('cycle').debug('event', { root: a });
      // Must not throw or infinite-loop
      expect(sink.records.length).toBe(1);
    });

    it('redacts secret nested inside deep arrays', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) { this.records.push(record); },
      };
      addSink(sink);
      setDebug('arrdeep');
      getLogger('arrdeep').debug('event', {
        list: [
          { item: { credentials: { apiKey: 'sk-1' } } },
        ],
      });
      const item = ((sink.records[0].fields!.list as Array<unknown>)[0] as Record<string, unknown>).item as Record<string, unknown>;
      const creds = item.credentials as Record<string, unknown>;
      expect(creds.apiKey).toBe('[REDACTED]');
    });
  });

  describe('denylist coverage (security review C2)', () => {
    it.each([
      ['encryptionKey', 'aes-key'],
      ['masterKey', 'xprv-here'],
      ['chainCode', 'cc-bytes'],
      ['privKey', 'lowercase camelCase form'],
      ['seedPhrase', 'twelve words'],
      ['nsecHex', 'beef'],
      ['wif', 'KxFC...'],
      ['xpriv', 'xprv9...'],
      ['xprv', 'xprv9...'],
      ['recoveryPhrase', 'twelve words'],
      ['peerId', 'libp2p key'],
      ['accessToken', 'oauth-tok'],
      ['refreshToken', 'oauth-tok'],
      ['sessionToken', 'sess'],
      ['token', 'tok'],
      ['ciphertext', 'cipher-bytes'],
      ['iv', 'aes-iv'],
      ['salt', 'kdf-salt'],
      ['nonce', 'aes-nonce'],
      ['hmacKey', 'mac-key'],
      ['attestKey', 'att-key'],
      ['rawKey', 'raw-bytes'],
      ['keyMaterial', 'bytes'],
      ['walletKey', 'wallet-key'],
      ['signingKey', 'sig-key'],
    ])('redacts %s', (key, val) => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) { this.records.push(record); },
      };
      addSink(sink);
      setDebug('cov');
      getLogger('cov').debug('event', { [key]: val });
      expect(sink.records[0].fields![key]).toBe('[REDACTED]');
    });
  });

  describe('log injection prevention (security review C3)', () => {
    it('escapes newlines in the message body', () => {
      const recs: { record: LogRecord; formatted: string }[] = [];
      addSink({ write(record, formatted) { recs.push({ record, formatted }); } });
      setDebug('inj');
      // Attacker-controlled memo containing a fake log line
      getLogger('inj').debug('memo received: hi\n[ERROR] [Sphere] fake critical');
      // formatted line must not contain real newline
      expect(recs[0].formatted.includes('\n')).toBe(false);
      expect(recs[0].formatted).toContain('\\n');
    });

    it('escapes ANSI escape introducer in the namespace and message', () => {
      const recs: { formatted: string }[] = [];
      addSink({ write(_r, formatted) { recs.push({ formatted }); } });
      setDebug('inj');
      getLogger('inj').warn('contains \x1b[31m red \x1b[0m');
      expect(recs[0].formatted).not.toContain('\x1b');
      expect(recs[0].formatted).toContain('\\x1b');
    });
  });

  describe('spec DoS bound (security review H2)', () => {
    it('rejects an oversized spec', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const huge = 'x:'.repeat(5000) + 'y'; // > 8 KB
      setDebug(huge);
      // Spec rejected — no namespaces enabled
      expect(listDebug()).toEqual([]);
      expect(consoleWarn).toHaveBeenCalled();
      consoleWarn.mockRestore();
    });

    it('truncates after SPEC_MAX_ENTRIES entries', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Build a spec with 300 entries
      const many = Array.from({ length: 300 }, (_, i) => `ns${i}`).join(',');
      setDebug(many);
      expect(listDebug().length).toBeLessThanOrEqual(256);
      expect(consoleWarn).toHaveBeenCalled();
      consoleWarn.mockRestore();
    });

    it('rejects pattern entries with control characters', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setDebug('payments:send,inject\x00chars');
      const list = listDebug();
      expect(list.find((e) => e.namespace.includes('\x00'))).toBeUndefined();
      // The valid one was still registered
      expect(list.find((e) => e.namespace === 'payments:send')).toBeDefined();
      consoleWarn.mockRestore();
    });
  });

  describe('redaction inside arrays (review S4)', () => {
    it('redacts denylisted keys inside array elements one level deep', () => {
      const sink: LogSink & { records: LogRecord[] } = {
        records: [],
        write(record) { this.records.push(record); },
      };
      addSink(sink);
      setDebug('arr');
      getLogger('arr').debug('keys', {
        keys: [
          { apiKey: 'sk-xyz', label: 'prod' },
          { apiKey: 'sk-abc', label: 'dev' },
        ],
      });
      const arr = sink.records[0].fields!.keys as Array<Record<string, unknown>>;
      expect(arr[0].apiKey).toBe('[REDACTED]');
      expect(arr[0].label).toBe('prod');
      expect(arr[1].apiKey).toBe('[REDACTED]');
    });
  });

  describe('formatted output', () => {
    it('prepends ISO timestamp + level when timestamps are enabled', () => {
      const recs: { record: LogRecord; formatted: string }[] = [];
      addSink({
        write(record, formatted) {
          recs.push({ record, formatted });
        },
      });
      setDebug('fmt'); // implicit timestamps:true via spec
      getLogger('fmt').debug('hello', { x: 1 });
      const f = recs[0].formatted;
      expect(f).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[DEBUG\] \[fmt\] hello \{"x":1\}$/);
    });

    it('legacy split shape preserved when timestamps off and no fields', () => {
      // legacy boolean toggle does NOT auto-enable timestamps
      logger.configure({ debug: true });
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.debug('LegacyTag', 'plain message', { unredacted: 'ok' });
      expect(spy).toHaveBeenCalledWith('[LegacyTag]', 'plain message', { unredacted: 'ok' });
      spy.mockRestore();
    });
  });
});
