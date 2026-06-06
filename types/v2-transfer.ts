/**
 * v2 transfer wire payload (token-engine migration, path B).
 *
 * The v2 engine is sender-driven: the sender hands the recipient a FINISHED
 * token, so the wire payload carries the serialized token blob and the receiver
 * just stores it — no commitment / inclusion-proof / finalization round-trip
 * (contrast the legacy v1 `{ sourceToken, transferTx }` and the V5/V6 bundles).
 */

/** A v2 transfer: the finished token blob handed to the recipient. */
export interface V2TransferPayload {
  readonly type: 'V2_TRANSFER';
  readonly version: '2.0';
  /** Hex of CBOR(TokenBlob) — the finished token (recipient just stores it). */
  readonly tokenBlob: string;
  /** Optional opaque memo. */
  readonly memo?: string;
}

/** Narrow an unknown wire payload to a {@link V2TransferPayload}. */
export function isV2TransferPayload(obj: unknown): obj is V2TransferPayload {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Record<string, unknown>;
  return p.type === 'V2_TRANSFER' && typeof p.tokenBlob === 'string' && p.tokenBlob.length > 0;
}
