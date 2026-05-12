/**
 * Tests for `InstantSplitExecutor.submitCommitmentsImmediate` (Loop1-S3).
 *
 * The method is private but accessed via `(executor as any)` for focused
 * unit coverage — the steelman pass found zero tests on the new
 * commitment-submission path, which is exactly the kind of code that
 * ships with a wrong polarity bug.
 *
 * What the tests lock down:
 *  - SERIAL ordering (sender mint → recipient mint → transfer). Earlier
 *    revision used Promise.all → partial-success orphans.
 *  - Fail-fast: any non-SUCCESS / non-REQUEST_ID_EXISTS throws.
 *  - The thrown SphereError names the failing step so operators can
 *    triage which submission orphaned.
 *  - The thrown SphereError carries `code: 'TRANSFER_FAILED'` and
 *    forwards the original error as `cause`.
 *  - Aggregator-supplied error strings are sanitized (newlines /
 *    control chars stripped) before being interpolated into the
 *    SphereError message.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, expect, it, vi } from 'vitest';

import { InstantSplitExecutor } from '../../../modules/payments/InstantSplitExecutor';
import { isSphereError } from '../../../core/errors';

function makeExecutor(client: any): InstantSplitExecutor {
  return new InstantSplitExecutor({
    stateTransitionClient: client,
    trustBase: {} as any,
    signingService: {} as any,
  });
}

const fakeSenderMint = { __label: 'senderMint' } as any;
const fakeRecipientMint = { __label: 'recipientMint' } as any;
const fakeTransfer = { __label: 'transfer' } as any;

describe('InstantSplitExecutor.submitCommitmentsImmediate — serial ordering', () => {
  it('submits in order: senderMint → recipientMint → transfer', async () => {
    const calls: string[] = [];
    const client = {
      submitMintCommitment: vi.fn(async (c: any) => {
        calls.push(c.__label);
        return { status: 'SUCCESS' };
      }),
      submitTransferCommitment: vi.fn(async (c: any) => {
        calls.push(c.__label);
        return { status: 'SUCCESS' };
      }),
    };

    const executor = makeExecutor(client);
    await (executor as any).submitCommitmentsImmediate(
      fakeSenderMint,
      fakeRecipientMint,
      fakeTransfer,
    );

    expect(calls).toEqual(['senderMint', 'recipientMint', 'transfer']);
  });

  it('completes without throwing when all three return SUCCESS', async () => {
    const client = {
      submitMintCommitment: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
      submitTransferCommitment: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    };
    const executor = makeExecutor(client);
    await expect(
      (executor as any).submitCommitmentsImmediate(
        fakeSenderMint,
        fakeRecipientMint,
        fakeTransfer,
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts REQUEST_ID_EXISTS as a non-failure status (idempotent retry)', async () => {
    const client = {
      submitMintCommitment: vi.fn().mockResolvedValue({ status: 'REQUEST_ID_EXISTS' }),
      submitTransferCommitment: vi.fn().mockResolvedValue({ status: 'REQUEST_ID_EXISTS' }),
    };
    const executor = makeExecutor(client);
    await expect(
      (executor as any).submitCommitmentsImmediate(
        fakeSenderMint,
        fakeRecipientMint,
        fakeTransfer,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('InstantSplitExecutor.submitCommitmentsImmediate — fail-fast', () => {
  it('STOPS after senderMint failure — recipient mint + transfer NOT submitted', async () => {
    // Loop1-S3 invariant — if senderMint fails, no later commitments
    // are submitted. Otherwise we'd leak orphan recipient-side
    // commitments to the aggregator without a sender-side anchor.
    const calls: string[] = [];
    const client = {
      submitMintCommitment: vi.fn(async (c: any) => {
        calls.push(c.__label);
        return { status: 'INVALID_REQUEST' };
      }),
      submitTransferCommitment: vi.fn(async (c: any) => {
        calls.push(c.__label);
        return { status: 'SUCCESS' };
      }),
    };

    const executor = makeExecutor(client);
    let caught: unknown;
    try {
      await (executor as any).submitCommitmentsImmediate(
        fakeSenderMint,
        fakeRecipientMint,
        fakeTransfer,
      );
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('TRANSFER_FAILED');
    expect(caught.message).toContain('senderMint');
    expect(caught.message).toContain('INVALID_REQUEST');

    // Only senderMint was attempted. Loop1-S3's serial ordering means
    // recipientMint and transfer NEVER see the aggregator.
    expect(calls).toEqual(['senderMint']);
  });

  it('STOPS after recipientMint failure — transfer NOT submitted; senderMint orphan acceptable', async () => {
    const calls: string[] = [];
    const client = {
      submitMintCommitment: vi.fn(async (c: any) => {
        calls.push(c.__label);
        if (c === fakeSenderMint) return { status: 'SUCCESS' };
        return { status: 'INVALID_REQUEST' };
      }),
      submitTransferCommitment: vi.fn(async (c: any) => {
        calls.push(c.__label);
        return { status: 'SUCCESS' };
      }),
    };

    const executor = makeExecutor(client);
    let caught: unknown;
    try {
      await (executor as any).submitCommitmentsImmediate(
        fakeSenderMint,
        fakeRecipientMint,
        fakeTransfer,
      );
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.message).toContain('recipientMint');

    // Only senderMint + recipientMint were attempted. The transfer was
    // NEVER submitted because recipientMint failed.
    expect(calls).toEqual(['senderMint', 'recipientMint']);
  });

  it('STOPS after transfer failure — earlier mints anchored, transfer rejected', async () => {
    const calls: string[] = [];
    const client = {
      submitMintCommitment: vi.fn(async (c: any) => {
        calls.push(c.__label);
        return { status: 'SUCCESS' };
      }),
      submitTransferCommitment: vi.fn(async (c: any) => {
        calls.push(c.__label);
        return { status: 'INVALID_REQUEST' };
      }),
    };

    const executor = makeExecutor(client);
    let caught: unknown;
    try {
      await (executor as any).submitCommitmentsImmediate(
        fakeSenderMint,
        fakeRecipientMint,
        fakeTransfer,
      );
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.message).toContain('transfer');

    expect(calls).toEqual(['senderMint', 'recipientMint', 'transfer']);
  });

  it('wraps thrown submit errors into SphereError with cause', async () => {
    const originalErr = new Error('network is down');
    const client = {
      submitMintCommitment: vi.fn(async () => {
        throw originalErr;
      }),
      submitTransferCommitment: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    };

    const executor = makeExecutor(client);
    let caught: unknown;
    try {
      await (executor as any).submitCommitmentsImmediate(
        fakeSenderMint,
        fakeRecipientMint,
        fakeTransfer,
      );
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('TRANSFER_FAILED');
    expect(caught.message).toContain('senderMint');
    expect(caught.message).toContain('network is down');
    // `cause` is forwarded for forensic chain walking. Error.cause
    // (native getter) sees the original error via the redaction path.
    expect((caught as Error).cause).toBeDefined();
  });
});

describe('InstantSplitExecutor.submitCommitmentsImmediate — input sanitization', () => {
  it('strips newlines and control chars from aggregator-supplied error messages', async () => {
    // A hostile / buggy aggregator could plant control characters in
    // its error message. The wrapper must sanitize before interpolating
    // into the SphereError message — otherwise log parsers and audit
    // tools see corrupted entries.
    const hostileErr = new Error('line1\nline2\rline3\tline4\0line5');
    const client = {
      submitMintCommitment: vi.fn(async () => {
        throw hostileErr;
      }),
      submitTransferCommitment: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    };

    const executor = makeExecutor(client);
    let caught: unknown;
    try {
      await (executor as any).submitCommitmentsImmediate(
        fakeSenderMint,
        fakeRecipientMint,
        fakeTransfer,
      );
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    // No raw newlines/CR/TAB/NUL in the outgoing message.
    expect(caught.message).not.toMatch(/[\r\n\t\0]/);
    // The substance is preserved (just whitespace-collapsed).
    expect(caught.message).toContain('line1');
    expect(caught.message).toContain('line5');
  });

  it('caps interpolated error message length (200 chars)', async () => {
    const longErr = new Error('A'.repeat(1000));
    const client = {
      submitMintCommitment: vi.fn(async () => {
        throw longErr;
      }),
      submitTransferCommitment: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    };

    const executor = makeExecutor(client);
    let caught: unknown;
    try {
      await (executor as any).submitCommitmentsImmediate(
        fakeSenderMint,
        fakeRecipientMint,
        fakeTransfer,
      );
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    // The interpolated `msg` is sliced to 200 chars before assembly
    // into the SphereError message. The full SphereError message is
    // longer (prefix + suffix); but the count of consecutive 'A's
    // must not exceed the slice cap.
    const aRun = caught.message.match(/A+/);
    expect(aRun).toBeTruthy();
    expect((aRun?.[0] ?? '').length).toBeLessThanOrEqual(200);
  });
});
