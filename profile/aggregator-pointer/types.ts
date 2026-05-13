/**
 * Profile Aggregator Pointer Layer — shared types (T-A3, SPEC §4, §7, §10).
 */

export const SIDE_A_NUM = 0x00 as const;
export const SIDE_B_NUM = 0x01 as const;
export type Side = typeof SIDE_A_NUM | typeof SIDE_B_NUM;

/** Profile-pointer version number. `0` means "no pointer published yet". */
export type PointerVersion = number;

/** Per-version derived secrets, held transiently during publish/probe. */
export interface PerVersionDerivation {
  readonly v: PointerVersion;
  readonly side: Side;
  readonly stateHashDigest: Uint8Array; // 32 bytes (§4.4)
  readonly xorKey: Uint8Array; // 32 bytes (§4.5)
}

/** Pending-version marker — crash-safety guard (§7.1.2). */
export interface PendingVersionMarker {
  readonly v: PointerVersion;
  readonly cidHash: Uint8Array; // 32 bytes: SHA-256(cidBytes)
}

/** Persistent BLOCKED-state flag (§10.2). */
export interface BlockedState {
  readonly blocked: boolean;
  readonly reason?: string;
  readonly setAt?: number; // ms timestamp
}
