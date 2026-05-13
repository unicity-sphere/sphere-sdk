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

let ipnsValidatorModule: {
  validate: typeof import('ipns/validator')['validate'];
} | null = null;

async function loadIpnsValidator() {
  if (!ipnsValidatorModule) {
    const mod = await import('ipns/validator');
    ipnsValidatorModule = { validate: mod.validate };
  }
  return ipnsValidatorModule;
}

let peerIdModule: {
  peerIdFromString: typeof import('@libp2p/peer-id')['peerIdFromString'];
} | null = null;

async function loadPeerIdModule() {
  if (!peerIdModule) {
    const mod = await import('@libp2p/peer-id');
    peerIdModule = { peerIdFromString: mod.peerIdFromString };
  }
  return peerIdModule;
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

  const record = await createIPNSRecord(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 * Authenticity: when `ipnsName` is provided, the record's Ed25519
 * signature is verified against the pubkey embedded in the IPNS name
 * via `ipns/validator.validate`. Records that fail verification are
 * rejected silently (skipped in the NDJSON loop) — a hostile gateway
 * cannot forge a record for an IPNS name it does not hold the
 * private key for. Callers that pass no `ipnsName` accept the record
 * without verification; this path is retained only for callers that
 * have their own out-of-band trust anchor.
 *
 * @param responseText - Raw text from the routing API response
 * @param ipnsName - The IPNS name the response is a resolution for
 *   (the peer-ID string from the `/ipns/<name>` URL). Required for
 *   signature verification; pass `null` to explicitly opt out.
 * @returns Parsed result with cid, sequence, and recordData, or null
 */
export async function parseRoutingApiResponse(
  responseText: string,
  ipnsName: string | null = null,
): Promise<{ cid: string; sequence: bigint; recordData: Uint8Array } | null> {
  const { unmarshalIPNSRecord } = await loadIpnsModule();

  // Resolve the public key once before the loop — peer-id parsing is
  // cheap but the dynamic import is not.
  let publicKey: import('@libp2p/interface').PublicKey | null = null;
  if (ipnsName !== null) {
    try {
      const { peerIdFromString } = await loadPeerIdModule();
      const peerId = peerIdFromString(ipnsName);
      // Only Ed25519 / Secp256k1 peer IDs embed a public key inline;
      // RSA IDs do not. IPNS records produced by the Profile stack
      // (and by legacy IPFS-storage) are Ed25519, so a missing pubkey
      // is a misuse / unexpected key type — reject rather than
      // silently accept unverifiable records.
      const maybePubkey = (peerId as { publicKey?: import('@libp2p/interface').PublicKey }).publicKey;
      if (!maybePubkey) {
        return null;
      }
      publicKey = maybePubkey;
    } catch {
      // Malformed IPNS name — treat as unresolvable rather than
      // accepting an unverified record.
      return null;
    }
  }

  const { validate } = publicKey !== null ? await loadIpnsValidator() : { validate: null };

  const lines = responseText.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      if (obj.Extra) {
        const recordData = base64ToUint8Array(obj.Extra);

        // Signature verification: if an ipnsName was supplied, the
        // marshalled record must verify against the pubkey embedded
        // in the peer ID. `validate` throws on signature mismatch,
        // expired record, or malformed fields — treat any throw as
        // "this line is unverifiable, skip it".
        if (publicKey !== null && validate !== null) {
          try {
            await validate(publicKey, recordData);
          } catch {
            continue;
          }
        }

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
