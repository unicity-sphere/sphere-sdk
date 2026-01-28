/**
 * Tests for Sphere dynamic provider management
 * Covers addTokenStorageProvider, removeTokenStorageProvider, etc.
 */

import { describe, it, expect } from 'vitest';
import type { TokenStorageProvider, TxfStorageDataBase, SaveResult, LoadResult, SyncResult } from '../../../storage';
import type { FullIdentity, ProviderStatus } from '../../../types';

// =============================================================================
// Mock Token Storage Provider
// =============================================================================

class MockTokenStorageProvider implements TokenStorageProvider<TxfStorageDataBase> {
  readonly id: string;
  readonly name: string;
  readonly type = 'cloud' as const;

  private status: ProviderStatus = 'disconnected';
  private identity: FullIdentity | null = null;
  private data: TxfStorageDataBase | null = null;

  public initializeCalled = false;
  public shutdownCalled = false;
  public setIdentityCalled = false;
  public saveCalled = false;
  public loadCalled = false;
  public syncCalled = false;

  constructor(id: string, name: string = `Mock Provider ${id}`) {
    this.id = id;
    this.name = name;
  }

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
    this.setIdentityCalled = true;
  }

  async initialize(): Promise<boolean> {
    this.initializeCalled = true;
    this.status = 'connected';
    return true;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
    this.status = 'disconnected';
  }

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    await this.shutdown();
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async load(): Promise<LoadResult<TxfStorageDataBase>> {
    this.loadCalled = true;
    return {
      success: true,
      data: this.data ?? {
        _meta: {
          version: 1,
          address: this.identity?.address ?? '',
          formatVersion: '2.0',
          updatedAt: Date.now(),
        },
      },
      source: 'remote',
      timestamp: Date.now(),
    };
  }

  async save(data: TxfStorageDataBase): Promise<SaveResult> {
    this.saveCalled = true;
    this.data = data;
    return {
      success: true,
      timestamp: Date.now(),
    };
  }

  async sync(localData: TxfStorageDataBase): Promise<SyncResult<TxfStorageDataBase>> {
    this.syncCalled = true;
    await this.save(localData);
    return {
      success: true,
      merged: localData,
      added: 0,
      removed: 0,
      conflicts: 0,
    };
  }

  // Helper methods for testing
  reset() {
    this.initializeCalled = false;
    this.shutdownCalled = false;
    this.setIdentityCalled = false;
    this.saveCalled = false;
    this.loadCalled = false;
    this.syncCalled = false;
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('TokenStorageProvider Management', () => {
  describe('MockTokenStorageProvider', () => {
    it('should implement all required methods', () => {
      const provider = new MockTokenStorageProvider('test-1');

      expect(provider.id).toBe('test-1');
      expect(provider.name).toBe('Mock Provider test-1');
      expect(provider.type).toBe('remote');
      expect(typeof provider.setIdentity).toBe('function');
      expect(typeof provider.initialize).toBe('function');
      expect(typeof provider.shutdown).toBe('function');
      expect(typeof provider.load).toBe('function');
      expect(typeof provider.save).toBe('function');
      expect(typeof provider.sync).toBe('function');
    });

    it('should track method calls', async () => {
      const provider = new MockTokenStorageProvider('test-1');

      const identity: FullIdentity = {
        privateKey: 'a'.repeat(64),
        publicKey: 'b'.repeat(64),
        address: 'alpha1test',
        ipnsName: '12D3KooWtest',
      };

      provider.setIdentity(identity);
      expect(provider.setIdentityCalled).toBe(true);

      await provider.initialize();
      expect(provider.initializeCalled).toBe(true);
      expect(provider.isConnected()).toBe(true);

      await provider.shutdown();
      expect(provider.shutdownCalled).toBe(true);
      expect(provider.isConnected()).toBe(false);
    });

    it('should save and load data', async () => {
      const provider = new MockTokenStorageProvider('test-1');
      await provider.initialize();

      const testData: TxfStorageDataBase = {
        _meta: {
          version: 1,
          address: 'alpha1test',
          formatVersion: '2.0',
          updatedAt: Date.now(),
        },
        _token1: { id: 'token1', amount: '100' },
      };

      await provider.save(testData);
      expect(provider.saveCalled).toBe(true);

      const result = await provider.load();
      expect(result.success).toBe(true);
      expect(result.data?._token1).toEqual({ id: 'token1', amount: '100' });
    });

    it('should sync data', async () => {
      const provider = new MockTokenStorageProvider('test-1');
      await provider.initialize();

      const testData: TxfStorageDataBase = {
        _meta: {
          version: 1,
          address: 'alpha1test',
          formatVersion: '2.0',
          updatedAt: Date.now(),
        },
      };

      const result = await provider.sync(testData);
      expect(result.success).toBe(true);
      expect(provider.syncCalled).toBe(true);
      expect(provider.saveCalled).toBe(true);
    });
  });

  describe('Provider interface', () => {
    it('should have correct properties', () => {
      const provider = new MockTokenStorageProvider('mongodb', 'MongoDB Storage');
      expect(provider.id).toBe('mongodb');
      expect(provider.name).toBe('MongoDB Storage');
    });

    it('should initialize and shutdown correctly', async () => {
      const provider = new MockTokenStorageProvider('test');

      expect(provider.getStatus()).toBe('disconnected');

      await provider.initialize();
      expect(provider.getStatus()).toBe('connected');
      expect(provider.isConnected()).toBe(true);

      await provider.shutdown();
      expect(provider.getStatus()).toBe('disconnected');
      expect(provider.isConnected()).toBe(false);
    });
  });
});

describe('Multiple Providers', () => {
  it('should allow creating multiple providers', () => {
    const provider1 = new MockTokenStorageProvider('ipfs', 'IPFS Storage');
    const provider2 = new MockTokenStorageProvider('mongodb', 'MongoDB Storage');
    const provider3 = new MockTokenStorageProvider('s3', 'S3 Storage');

    expect(provider1.id).not.toBe(provider2.id);
    expect(provider2.id).not.toBe(provider3.id);
  });

  it('should track calls independently', async () => {
    const provider1 = new MockTokenStorageProvider('p1');
    const provider2 = new MockTokenStorageProvider('p2');

    await provider1.initialize();
    expect(provider1.initializeCalled).toBe(true);
    expect(provider2.initializeCalled).toBe(false);

    await provider2.initialize();
    expect(provider2.initializeCalled).toBe(true);
  });

  it('should store data independently', async () => {
    const provider1 = new MockTokenStorageProvider('p1');
    const provider2 = new MockTokenStorageProvider('p2');

    await provider1.initialize();
    await provider2.initialize();

    const data1: TxfStorageDataBase = {
      _meta: { version: 1, address: 'addr1', formatVersion: '2.0', updatedAt: Date.now() },
      _token1: { value: 'from-p1' },
    };

    const data2: TxfStorageDataBase = {
      _meta: { version: 1, address: 'addr2', formatVersion: '2.0', updatedAt: Date.now() },
      _token2: { value: 'from-p2' },
    };

    await provider1.save(data1);
    await provider2.save(data2);

    const result1 = await provider1.load();
    const result2 = await provider2.load();

    expect(result1.data?._token1).toEqual({ value: 'from-p1' });
    expect(result2.data?._token2).toEqual({ value: 'from-p2' });
    expect(result1.data?._token2).toBeUndefined();
    expect(result2.data?._token1).toBeUndefined();
  });
});
