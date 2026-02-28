import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '../../../core/logger';
import type { LogLevel } from '../../../core/logger';

describe('Logger', () => {
  beforeEach(() => {
    logger.reset();
  });

  describe('configure', () => {
    it('should default to debug=false', () => {
      expect(logger.isDebugEnabled()).toBe(false);
    });

    it('should enable debug globally', () => {
      logger.configure({ debug: true });
      expect(logger.isDebugEnabled()).toBe(true);
    });

    it('should disable debug globally', () => {
      logger.configure({ debug: true });
      logger.configure({ debug: false });
      expect(logger.isDebugEnabled()).toBe(false);
    });

    it('should accept custom handler', () => {
      const handler = vi.fn();
      logger.configure({ debug: true, handler });
      logger.debug('Test', 'hello');
      expect(handler).toHaveBeenCalledWith('debug', 'Test', 'hello');
    });

    it('should allow null handler to revert to console', () => {
      const handler = vi.fn();
      logger.configure({ debug: true, handler });
      logger.debug('Test', 'first call'); // call with handler active
      logger.configure({ handler: null });
      // handler should no longer be called
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.debug('Test', 'hello');
      expect(handler).toHaveBeenCalledTimes(1); // from first call only
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe('debug', () => {
    it('should NOT log when debug=false', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.debug('Test', 'hidden message');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should log when debug=true', () => {
      logger.configure({ debug: true });
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.debug('Test', 'visible message');
      expect(spy).toHaveBeenCalledWith('[Test]', 'visible message');
      spy.mockRestore();
    });

    it('should pass additional arguments', () => {
      logger.configure({ debug: true });
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.debug('Tag', 'msg', { key: 'value' }, 42);
      expect(spy).toHaveBeenCalledWith('[Tag]', 'msg', { key: 'value' }, 42);
      spy.mockRestore();
    });
  });

  describe('warn', () => {
    it('should ALWAYS log regardless of debug flag', () => {
      // debug=false (default)
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      logger.warn('Test', 'important warning');
      expect(spy).toHaveBeenCalledWith('[Test]', 'important warning');
      spy.mockRestore();
    });

    it('should log with additional arguments', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      logger.warn('Nostr', 'queryEvents timed out', { timeout: 5000 });
      expect(spy).toHaveBeenCalledWith('[Nostr]', 'queryEvents timed out', { timeout: 5000 });
      spy.mockRestore();
    });
  });

  describe('error', () => {
    it('should ALWAYS log regardless of debug flag', () => {
      // debug=false (default)
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      logger.error('Test', 'critical error');
      expect(spy).toHaveBeenCalledWith('[Test]', 'critical error');
      spy.mockRestore();
    });

    it('should log with additional arguments', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = new Error('something broke');
      logger.error('Sphere', 'Fatal:', err);
      expect(spy).toHaveBeenCalledWith('[Sphere]', 'Fatal:', err);
      spy.mockRestore();
    });
  });

  describe('per-tag overrides', () => {
    it('should enable logging for specific tag when global debug=false', () => {
      logger.setTagDebug('Nostr', true);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.debug('Nostr', 'nostr message');
      logger.debug('Payments', 'payments message');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('[Nostr]', 'nostr message');
      spy.mockRestore();
    });

    it('should disable logging for specific tag when global debug=true', () => {
      logger.configure({ debug: true });
      logger.setTagDebug('Nostr', false);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.debug('Nostr', 'hidden');
      logger.debug('Payments', 'visible');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('[Payments]', 'visible');
      spy.mockRestore();
    });

    it('should report tag-specific debug state', () => {
      logger.setTagDebug('Nostr', true);
      expect(logger.isDebugEnabled('Nostr')).toBe(true);
      expect(logger.isDebugEnabled('Payments')).toBe(false);
    });

    it('should clear tag override with clearTagDebug', () => {
      logger.configure({ debug: true });
      logger.setTagDebug('Nostr', false);
      expect(logger.isDebugEnabled('Nostr')).toBe(false);
      logger.clearTagDebug('Nostr');
      expect(logger.isDebugEnabled('Nostr')).toBe(true); // falls back to global
    });
  });

  describe('custom handler', () => {
    it('should receive all levels with correct arguments', () => {
      const handler = vi.fn();
      logger.configure({ debug: true, handler });

      logger.debug('A', 'debug msg', 1);
      logger.warn('B', 'warn msg', 2);
      logger.error('C', 'error msg', 3);

      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler).toHaveBeenNthCalledWith(1, 'debug', 'A', 'debug msg', 1);
      expect(handler).toHaveBeenNthCalledWith(2, 'warn', 'B', 'warn msg', 2);
      expect(handler).toHaveBeenNthCalledWith(3, 'error', 'C', 'error msg', 3);
    });

    it('should receive warn and error calls even when debug=false', () => {
      const handler = vi.fn();
      logger.configure({ handler }); // debug=false by default
      logger.warn('W', 'warning visible');
      logger.error('X', 'error visible');
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, 'warn', 'W', 'warning visible');
      expect(handler).toHaveBeenNthCalledWith(2, 'error', 'X', 'error visible');
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      logger.configure({ debug: true });
      logger.setTagDebug('Nostr', true);
      logger.reset();
      expect(logger.isDebugEnabled()).toBe(false);
      expect(logger.isDebugEnabled('Nostr')).toBe(false);
    });
  });

  describe('globalThis persistence', () => {
    it('should share state across calls (simulates cross-bundle)', () => {
      // Configure in one "context"
      logger.configure({ debug: true });

      // Verify state is stored on globalThis (same mechanism used across tsup bundles)
      const state = (globalThis as Record<string, unknown>)['__sphere_sdk_logger__'] as { debug: boolean };
      expect(state).toBeDefined();
      expect(state.debug).toBe(true);
    });
  });
});
