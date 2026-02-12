import { describe, it, expect } from 'vitest';
import {
  IpfsError,
  classifyFetchError,
  classifyHttpStatus,
} from '../../../../../impl/shared/ipfs/ipfs-error-types';

describe('IpfsError', () => {
  it('should create error with category and gateway', () => {
    const error = new IpfsError('test error', 'NETWORK_ERROR', 'https://gw.example.com');
    expect(error.message).toBe('test error');
    expect(error.category).toBe('NETWORK_ERROR');
    expect(error.gateway).toBe('https://gw.example.com');
    expect(error.name).toBe('IpfsError');
  });

  it('should store cause error', () => {
    const cause = new Error('original');
    const error = new IpfsError('wrapped', 'TIMEOUT', undefined, cause);
    expect(error.cause).toBe(cause);
  });

  describe('shouldTriggerCircuitBreaker', () => {
    it('should NOT trigger for NOT_FOUND', () => {
      const error = new IpfsError('not found', 'NOT_FOUND');
      expect(error.shouldTriggerCircuitBreaker).toBe(false);
    });

    it('should NOT trigger for SEQUENCE_DOWNGRADE', () => {
      const error = new IpfsError('downgrade', 'SEQUENCE_DOWNGRADE');
      expect(error.shouldTriggerCircuitBreaker).toBe(false);
    });

    it('should trigger for NETWORK_ERROR', () => {
      const error = new IpfsError('network', 'NETWORK_ERROR');
      expect(error.shouldTriggerCircuitBreaker).toBe(true);
    });

    it('should trigger for TIMEOUT', () => {
      const error = new IpfsError('timeout', 'TIMEOUT');
      expect(error.shouldTriggerCircuitBreaker).toBe(true);
    });

    it('should trigger for GATEWAY_ERROR', () => {
      const error = new IpfsError('gateway', 'GATEWAY_ERROR');
      expect(error.shouldTriggerCircuitBreaker).toBe(true);
    });
  });
});

describe('classifyFetchError', () => {
  it('should classify AbortError as TIMEOUT', () => {
    const error = new DOMException('signal timed out', 'AbortError');
    expect(classifyFetchError(error)).toBe('TIMEOUT');
  });

  it('should classify TypeError as NETWORK_ERROR', () => {
    const error = new TypeError('Failed to fetch');
    expect(classifyFetchError(error)).toBe('NETWORK_ERROR');
  });

  it('should classify TimeoutError as TIMEOUT', () => {
    const error = new Error('timeout');
    error.name = 'TimeoutError';
    expect(classifyFetchError(error)).toBe('TIMEOUT');
  });

  it('should default to NETWORK_ERROR for unknown errors', () => {
    expect(classifyFetchError(new Error('unknown'))).toBe('NETWORK_ERROR');
    expect(classifyFetchError('string error')).toBe('NETWORK_ERROR');
  });
});

describe('classifyHttpStatus', () => {
  it('should classify 404 as NOT_FOUND', () => {
    expect(classifyHttpStatus(404)).toBe('NOT_FOUND');
  });

  it('should classify 500 with "routing: not found" as NOT_FOUND', () => {
    expect(classifyHttpStatus(500, 'routing: not found')).toBe('NOT_FOUND');
  });

  it('should classify 500 with "Routing: Not Found" (case insensitive) as NOT_FOUND', () => {
    expect(classifyHttpStatus(500, 'Routing: Not Found')).toBe('NOT_FOUND');
  });

  it('should classify 500 with other message as GATEWAY_ERROR', () => {
    expect(classifyHttpStatus(500, 'Internal Server Error')).toBe('GATEWAY_ERROR');
  });

  it('should classify 500 without body as GATEWAY_ERROR', () => {
    expect(classifyHttpStatus(500)).toBe('GATEWAY_ERROR');
  });

  it('should classify 502/503 as GATEWAY_ERROR', () => {
    expect(classifyHttpStatus(502)).toBe('GATEWAY_ERROR');
    expect(classifyHttpStatus(503)).toBe('GATEWAY_ERROR');
  });

  it('should classify 400-level errors as GATEWAY_ERROR', () => {
    expect(classifyHttpStatus(400)).toBe('GATEWAY_ERROR');
    expect(classifyHttpStatus(403)).toBe('GATEWAY_ERROR');
    expect(classifyHttpStatus(429)).toBe('GATEWAY_ERROR');
  });
});
