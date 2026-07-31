// §5.9 of docs/PAYMENTS-V2-DESIGN.md — history is a server read-through plus
// client POSTs. No local ledger; the server log is the store of record.

import { encryptField, decryptField } from '../../../core/field-encryption';
import { randomUUID } from '../../../core/uuid';

import type { HistoryEntry, HistoryPage } from '../api';

export interface HistoryWireAsset {
  coinId: string;
  amount: string;
}

// §16 wire record (structural slice of impl/wallet-api-v2 HistoryRecordWire).
export interface HistoryWireRecord {
  dedupKey: string;
  id: string;
  type: 'SENT' | 'RECEIVED' | 'MINT';
  assets: HistoryWireAsset[];
  ts: string;
  transferId?: string;
  tokenId?: string;
  counterpartyPubkey?: string;
  counterpartyNametag?: string;
  memo?: string;
}

// WalletApiV2Client satisfies this structurally; tests drive FakeWalletApi
// through a thin adapter of the same shape.
export interface HistoryClient {
  listHistory(options?: { before?: string; limit?: number }): Promise<{
    records: readonly HistoryWireRecord[];
    more: boolean;
    cursor: string | null;
  }>;
  postHistory(records: HistoryWireRecord[]): Promise<unknown>;
}

export interface HistoryRegistryReader {
  getSymbol(coinId: string): string;
}

export interface HistoryDeps {
  readonly client: HistoryClient;
  /** S6 self-scoped field-encryption key (core/field-encryption, `enc1.`). */
  readonly fieldKey: Uint8Array;
  readonly registry: HistoryRegistryReader;
  readonly emit: (event: 'history:updated') => void;
  readonly log?: (message: string, error?: unknown) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface RecordSentInput {
  transferId: string;
  coinId: string;
  amount: string;
  recipientPubkey?: string;
  recipientNametag?: string;
  memo?: string;
  tokenId?: string;
  timestamp?: number;
}

export interface RecordReceivedInput {
  tokenId: string;
  stateHash: string;
  coinId: string;
  amount: string;
  transferId?: string;
  senderPubkey?: string;
  senderNametag?: string;
  memo?: string;
  timestamp?: number;
}

export interface RecordMintInput {
  tokenId: string;
  coinId: string;
  amount: string;
  timestamp?: number;
}

const WIRE_TOKEN_ID = /^(?:[0-9a-f]{2}){1,64}$/;
const WIRE_PUBKEY = /^0[23][0-9a-f]{64}$/;

export class History {
  constructor(private readonly deps: HistoryDeps) {}

  // ── read-through ───────────────────────────────────────────────────────────

  async page(opts: { before?: string; limit?: number } = {}): Promise<HistoryPage> {
    const result = await this.deps.client.listHistory({
      ...(opts.before !== undefined ? { before: opts.before } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    return {
      entries: result.records.map((record) => this.toEntry(record)),
      more: result.more,
      cursor: result.cursor,
    };
  }

  // ── client POSTs (best-effort — NEVER throw into the money path) ────────────

  async recordSent(input: RecordSentInput): Promise<void> {
    await this.post(() => ({
      dedupKey: input.transferId,
      id: (this.deps.newId ?? randomUUID)(),
      type: 'SENT' as const,
      assets: [{ coinId: input.coinId, amount: input.amount }],
      ts: this.ts(input.timestamp),
      transferId: input.transferId,
      ...this.wireTokenId(input.tokenId),
      ...this.wireCounterparty(input.recipientPubkey, input.recipientNametag),
      ...this.wireMemo(input.memo),
    }));
  }

  async recordReceived(input: RecordReceivedInput): Promise<void> {
    await this.post(() => ({
      dedupKey: `RECEIVED:${input.tokenId.toLowerCase()}:${input.stateHash.toLowerCase()}`,
      id: (this.deps.newId ?? randomUUID)(),
      type: 'RECEIVED' as const,
      assets: [{ coinId: input.coinId, amount: input.amount }],
      ts: this.ts(input.timestamp),
      ...(input.transferId !== undefined ? { transferId: input.transferId } : {}),
      ...this.wireTokenId(input.tokenId),
      ...this.wireCounterparty(input.senderPubkey, input.senderNametag),
      ...this.wireMemo(input.memo),
    }));
  }

  async recordMint(input: RecordMintInput): Promise<void> {
    await this.post(() => ({
      dedupKey: `MINT:${input.tokenId.toLowerCase()}`,
      id: (this.deps.newId ?? randomUUID)(),
      type: 'MINT' as const,
      assets: [{ coinId: input.coinId, amount: input.amount }],
      ts: this.ts(input.timestamp),
      ...this.wireTokenId(input.tokenId),
    }));
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async post(build: () => HistoryWireRecord): Promise<void> {
    try {
      await this.deps.client.postHistory([build()]);
    } catch (err) {
      this.deps.log?.('history POST failed (dedupKey makes retry safe)', err);
      return;
    }
    this.deps.emit('history:updated');
  }

  private ts(timestamp?: number): string {
    return new Date(timestamp ?? (this.deps.now ?? Date.now)()).toISOString();
  }

  private wireTokenId(tokenId?: string): { tokenId?: string } {
    const lower = tokenId?.toLowerCase();
    return lower !== undefined && WIRE_TOKEN_ID.test(lower) ? { tokenId: lower } : {};
  }

  // Server zod is strict — a non-pubkey counterparty stays off the wire; the
  // nametag rides regardless (S6-encrypted, operator-blind).
  private wireCounterparty(
    pubkey?: string,
    nametag?: string
  ): { counterpartyPubkey?: string; counterpartyNametag?: string } {
    const lower = pubkey?.toLowerCase();
    return {
      ...(lower !== undefined && WIRE_PUBKEY.test(lower) ? { counterpartyPubkey: lower } : {}),
      ...(nametag !== undefined ? { counterpartyNametag: encryptField(this.deps.fieldKey, nametag) } : {}),
    };
  }

  private wireMemo(memo?: string): { memo?: string } {
    return memo !== undefined ? { memo: encryptField(this.deps.fieldKey, memo) } : {};
  }

  // Consumed mapping: wire `ts` (ISO 8601, any offset) → epoch-ms `timestamp`;
  // coinId/amount from the FIRST asset (multi-asset remainder surfaces via
  // tokenIds[]); counterparty lands on the role-appropriate side by type.
  private toEntry(wire: HistoryWireRecord): HistoryEntry {
    const first = wire.assets[0];
    const coinId = first?.coinId ?? '';
    const received = wire.type === 'RECEIVED';
    const memo = this.tryDecrypt(wire.memo);
    const nametag = this.tryDecrypt(wire.counterpartyNametag);
    return {
      id: wire.id,
      type: wire.type,
      coinId,
      amount: first?.amount ?? '0',
      symbol: this.deps.registry.getSymbol(coinId),
      timestamp: Date.parse(wire.ts),
      ...(wire.transferId !== undefined ? { transferId: wire.transferId } : {}),
      ...(wire.tokenId !== undefined ? { tokenId: wire.tokenId } : {}),
      ...(wire.assets.length > 1
        ? { tokenIds: wire.assets.map((asset) => ({ id: asset.coinId, amount: asset.amount })) }
        : {}),
      ...(wire.counterpartyPubkey !== undefined
        ? received
          ? { senderPubkey: wire.counterpartyPubkey }
          : { recipientPubkey: wire.counterpartyPubkey }
        : {}),
      ...(nametag !== undefined
        ? received
          ? { senderNametag: nametag }
          : { recipientNametag: nametag }
        : {}),
      ...(memo !== undefined ? { memo } : {}),
    };
  }

  // Self-scoped decrypt: a foreign/undecryptable/plaintext value is absent,
  // never ciphertext and never a throw.
  private tryDecrypt(envelope?: string): string | undefined {
    if (envelope === undefined) return undefined;
    try {
      return decryptField(this.deps.fieldKey, envelope);
    } catch {
      return undefined;
    }
  }
}
