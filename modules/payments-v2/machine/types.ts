export interface IntentPayload {
  v: 2;
  recipient: string;
  coinId: string;
  amount: string;
  memo?: string;
  // Stored order is normative (E.3).
  direct: string[];
  split?: { tokenId: string; splitAmount: string; remainderAmount: string };
  // Dual-field = old-module v:2 wire compat (always equal); collapse at the flip.
  spentStates?: Record<string, { local: string; protocol: string }>;
}

export interface PlannedOp {
  kind: 'direct' | 'split';
  // Plan-derived; never execution-derived.
  opIndex: number;
  sourceTokenId: string;
  deliveredAmount: bigint;
}

// certified and error are ORTHOGONAL (#441).
export interface OpOutcome {
  op: PlannedOp;
  certified: boolean;
  recipientBlob?: Uint8Array;
  changeBlob?: Uint8Array;
  error?: unknown;
}

export type OutcomeClass = 'keep-open' | 'conflict' | 'other';
