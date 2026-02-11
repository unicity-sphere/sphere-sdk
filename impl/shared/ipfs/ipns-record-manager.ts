/**
 * IPNS Record Manager
 * Creates, marshals, and parses IPNS records for publishing and resolution
 */

// =============================================================================
// Constants
// =============================================================================

/** Default IPNS record lifetime: 99 years (effectively permanent) */
const DEFAULT_LIFETIME_MS = 99 * 365 * 24 * 60 * 60 * 1000;

// =============================================================================
// Dynamic Import Cache
// =============================================================================

let ipnsModule: {
  createIPNSRecord: typeof import('ipns')['createIPNSRecord'];
  marshalIPNSRecord: typeof import('ipns')['marshalIPNSRecord'];
  unmarshalIPNSRecord: typeof import('ipns')['unmarshalIPNSRecord'];
} | null = null;

async function loadIpnsModule() {
  if (!ipnsModule) {
    const mod = await import('ipns');
    ipnsModule = {
      createIPNSRecord: mod.createIPNSRecord,
      marshalIPNSRecord: mod.marshalIPNSRecord,
      unmarshalIPNSRecord: mod.unmarshalIPNSRecord,
    };
  }
  return ipnsModule;
}

// =============================================================================
// Record Creation
// =============================================================================

/**
 * Create a signed IPNS record and marshal it to bytes.
 *
 * @param keyPair - Ed25519 private key (from deriveIpnsIdentity)
 * @param cid - CID to point the IPNS record at
 * @param sequenceNumber - Monotonically increasing sequence number
 * @param lifetimeMs - Record validity period (default: 99 years)
 * @returns Marshalled IPNS record bytes
 */
export async function createSignedRecord(
  keyPair: unknown,
  cid: string,
  sequenceNumber: bigint,
  lifetimeMs: number = DEFAULT_LIFETIME_MS,
): Promise<Uint8Array> {
  const { createIPNSRecord, marshalIPNSRecord } = await loadIpnsModule();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record = await createIPNSRecord(
    keyPair as any,
    `/ipfs/${cid}`,
    sequenceNumber,
    lifetimeMs,
  );

  return marshalIPNSRecord(record);
}

// =============================================================================
// Record Parsing
// =============================================================================

/**
 * Parse a routing API response (NDJSON) to extract CID and sequence number.
 * The routing API returns newline-delimited JSON with an "Extra" field
 * containing a base64-encoded marshalled IPNS record.
 *
 * @param responseText - Raw text from the routing API response
 * @returns Parsed result with cid, sequence, and recordData, or null
 */
export async function parseRoutingApiResponse(
  responseText: string,
): Promise<{ cid: string; sequence: bigint; recordData: Uint8Array } | null> {
  const { unmarshalIPNSRecord } = await loadIpnsModule();

  const lines = responseText.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      if (obj.Extra) {
        const recordData = base64ToUint8Array(obj.Extra);
        const record = unmarshalIPNSRecord(recordData);

        // Extract CID from the value field
        const valueBytes = typeof record.value === 'string'
          ? new TextEncoder().encode(record.value)
          : record.value as Uint8Array;
        const valueStr = new TextDecoder().decode(valueBytes);
        const cidMatch = valueStr.match(/\/ipfs\/([a-zA-Z0-9]+)/);

        if (cidMatch) {
          return {
            cid: cidMatch[1],
            sequence: record.sequence,
            recordData,
          };
        }
      }
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  return null;
}

/**
 * Verify that a new sequence number represents a valid progression.
 *
 * @param newSeq - Proposed new sequence number
 * @param lastKnownSeq - Last known sequence number
 * @returns true if the new sequence is valid (greater than last known)
 */
export function verifySequenceProgression(
  newSeq: bigint,
  lastKnownSeq: bigint,
): boolean {
  return newSeq > lastKnownSeq;
}

// =============================================================================
// Utilities
// =============================================================================

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
