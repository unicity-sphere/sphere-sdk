import { describe, it, expect } from 'vitest';
import { AsyncSerialQueue, WriteBuffer } from '../../../../../impl/shared/ipfs/write-behind-buffer';

describe('AsyncSerialQueue', () => {
  it('should execute operations in order', async () => {
    const queue = new AsyncSerialQueue();
    const results: number[] = [];

    await Promise.all([
      queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 50));
        results.push(1);
      }),
      queue.enqueue(async () => {
        results.push(2);
      }),
      queue.enqueue(async () => {
        results.push(3);
      }),
    ]);

    expect(results).toEqual([1, 2, 3]);
  });

  it('should return the value from the enqueued function', async () => {
    const queue = new AsyncSerialQueue();

    const result = await queue.enqueue(async () => 42);
    expect(result).toBe(42);
  });

  it('should propagate rejections without breaking the chain', async () => {
    const queue = new AsyncSerialQueue();

    // First operation rejects
    const p1 = queue.enqueue(async () => {
      throw new Error('oops');
    });
    await expect(p1).rejects.toThrow('oops');

    // Second operation should still run
    const result = await queue.enqueue(async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('should serialize concurrent enqueues', async () => {
    const queue = new AsyncSerialQueue();
    let running = 0;
    let maxConcurrent = 0;

    const work = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    };

    await Promise.all([
      queue.enqueue(work),
      queue.enqueue(work),
      queue.enqueue(work),
    ]);

    // Should never have more than 1 running at a time
    expect(maxConcurrent).toBe(1);
  });
});

describe('WriteBuffer', () => {
  it('should start empty', () => {
    const buf = new WriteBuffer();
    expect(buf.isEmpty).toBe(true);
    expect(buf.txfData).toBeNull();
    expect(buf.tokenMutations.size).toBe(0);
  });

  it('should not be empty when txfData is set', () => {
    const buf = new WriteBuffer();
    buf.txfData = { _meta: { version: 1, address: 'test', formatVersion: '2.0', updatedAt: 0 } };
    expect(buf.isEmpty).toBe(false);
  });

  it('should not be empty when tokenMutations exist', () => {
    const buf = new WriteBuffer();
    buf.tokenMutations.set('_tok1', { op: 'save', data: { id: 'tok1' } });
    expect(buf.isEmpty).toBe(false);
  });

  it('should clear all data', () => {
    const buf = new WriteBuffer();
    buf.txfData = { _meta: { version: 1, address: 'test', formatVersion: '2.0', updatedAt: 0 } };
    buf.tokenMutations.set('_tok1', { op: 'save', data: { id: 'tok1' } });

    buf.clear();

    expect(buf.isEmpty).toBe(true);
    expect(buf.txfData).toBeNull();
    expect(buf.tokenMutations.size).toBe(0);
  });

  describe('mergeFrom', () => {
    it('should take txfData from other if this has none', () => {
      const current = new WriteBuffer();
      const other = new WriteBuffer();
      other.txfData = { _meta: { version: 1, address: 'test', formatVersion: '2.0', updatedAt: 0 } };

      current.mergeFrom(other);

      expect(current.txfData).toBe(other.txfData);
    });

    it('should keep own txfData if already set', () => {
      const current = new WriteBuffer();
      current.txfData = { _meta: { version: 2, address: 'newer', formatVersion: '2.0', updatedAt: 0 } };

      const other = new WriteBuffer();
      other.txfData = { _meta: { version: 1, address: 'older', formatVersion: '2.0', updatedAt: 0 } };

      current.mergeFrom(other);

      expect(current.txfData!._meta.address).toBe('newer');
    });

    it('should merge token mutations — existing take precedence', () => {
      const current = new WriteBuffer();
      current.tokenMutations.set('_tok1', { op: 'delete' });

      const other = new WriteBuffer();
      other.tokenMutations.set('_tok1', { op: 'save', data: { id: 'tok1', old: true } });
      other.tokenMutations.set('_tok2', { op: 'save', data: { id: 'tok2' } });

      current.mergeFrom(other);

      // _tok1: current's delete takes precedence
      expect(current.tokenMutations.get('_tok1')!.op).toBe('delete');
      // _tok2: merged from other
      expect(current.tokenMutations.get('_tok2')!.op).toBe('save');
      expect(current.tokenMutations.size).toBe(2);
    });

    it('should add all mutations from other when current is empty', () => {
      const current = new WriteBuffer();
      const other = new WriteBuffer();
      other.tokenMutations.set('_a', { op: 'save', data: { id: 'a' } });
      other.tokenMutations.set('_b', { op: 'delete' });

      current.mergeFrom(other);

      expect(current.tokenMutations.size).toBe(2);
      expect(current.tokenMutations.get('_a')!.op).toBe('save');
      expect(current.tokenMutations.get('_b')!.op).toBe('delete');
    });
  });
});
