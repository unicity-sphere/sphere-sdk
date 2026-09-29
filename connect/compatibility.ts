// connect/compatibility.ts — pure, dependency-free compatibility decision for the Connect gate.
import { ERROR_CODES } from './protocol';
import type { SphereRpcError, NetworkInfo } from './protocol';
import { majorOf, compareSemver } from './semver';

export type IncompatibleReason = 'protocol_incompatible' | 'network_incompatible';

export interface CompatInput {
  clientProtocol: string;          // inbound msg.v
  walletProtocol: string;          // SPHERE_CONNECT_VERSION
  clientNetwork: NetworkInfo | undefined; // inbound msg.network
  walletNetworkId: number;         // wallet active network
  minMinor?: number;               // optional MINOR floor within the MAJOR
  clientSdkVersion?: string;       // optional secondary npm floor
  minSdkVersion?: string;
}

/**
 * A refusal the wallet can act on rather than merely report. Populated ONLY by the
 * network check, and only when there is a concrete network to offer: a dApp that
 * declared none, and a wallet whose own network is the -1 sentinel, both refuse with
 * the same error and no mismatch. The host branches on THIS, never on error.code —
 * a protocol failure must be structurally unable to raise a user prompt.
 *
 * `clientNetwork` is a sanitised COPY, not the peer's object: `{ id }` (a non-negative
 * integer) plus `name` only when it is a string of at most 64 characters. Nothing else
 * the peer sent is carried. It is still peer-declared, so never render it as a label.
 * `error.data.clientNetwork`, by contrast, echoes the raw wire value unchanged.
 */
export interface NetworkMismatch {
  readonly kind: 'network';
  readonly walletNetwork: NetworkInfo;
  readonly clientNetwork: NetworkInfo;
}

export type CompatResult =
  | { ok: true }
  | { ok: false; error: SphereRpcError; mismatch?: NetworkMismatch };

function fail(
  code: number,
  reason: IncompatibleReason,
  message: string,
  extra: Record<string, unknown>,
): { ok: false; error: SphereRpcError } {
  return { ok: false, error: { code, message, data: { reason, ...extra } } };
}

/**
 * Longest peer-declared network name a mismatch will carry. The wallet never prints it
 * (network labels come from the wallet's own table, never from the peer); it rides along
 * only so a log line can say what the dApp claimed. Longer names are dropped, not truncated.
 */
const MAX_NETWORK_NAME_LENGTH = 64;

/**
 * `CompatInput.clientNetwork` is typed `NetworkInfo`, but it is the handshake's
 * `msg.network` straight off the wire. `isSphereConnectMessage` checks only the
 * namespace (plus the version on non-handshake frames), nothing else inspects `network`
 * on the way here, and the handshake runs before any user approval, so any origin can
 * put anything in it. A `mismatch` is a typed claim that the wallet has a concrete
 * network to offer, so it is only made for a non-null object whose `id` is a
 * non-negative integer. Anything else still refuses (that decision is check #4's own
 * and is unchanged); it just carries no `mismatch`.
 */
function isOfferableNetwork(value: unknown): value is NetworkInfo {
  if (typeof value !== 'object' || value === null) return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'number' && Number.isInteger(id) && id >= 0;
}

/**
 * The copy a mismatch carries: `{ id }` plus `name` only when it is a string of at most
 * MAX_NETWORK_NAME_LENGTH characters. Built, never spread, so no other key the peer sent
 * survives, and no `name` key exists at all when it is dropped. Takes an already-validated
 * network (see isOfferableNetwork), so `id` needs no further check here.
 */
function sanitizedNetwork(net: NetworkInfo): NetworkInfo {
  const { id, name } = net;
  return typeof name === 'string' && name.length <= MAX_NETWORK_NAME_LENGTH ? { id, name } : { id };
}

/**
 * Decide whether a connecting peer is compatible. Runs four ordered checks
 * (protocol MAJOR → optional MINOR floor → optional SDK floor → network) and
 * returns {ok:true} or {ok:false, error}. A refusal from the network check may also
 * carry a typed `mismatch` (see `NetworkMismatch` for exactly when); no other check
 * ever does. A malformed clientProtocol (NaN MAJOR) is treated as
 * protocol-incompatible.
 *
 * Every refusal message NAMES the versions involved. The same numbers are also in
 * `error.data` for anything that wants to branch on them, but `data` alone is not
 * enough: the whole fleet renders `error.message` and nothing else, so a floor that
 * only said "below the required minimum" told a developer to upgrade without ever
 * saying to what.
 */
export function checkCompatibility(input: CompatInput): CompatResult {
  const { clientProtocol, walletProtocol, minMinor, clientSdkVersion, minSdkVersion } = input;

  // 1. Protocol MAJOR must match.
  if (majorOf(clientProtocol) !== majorOf(walletProtocol)) {
    return fail(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION, 'protocol_incompatible',
      `Incompatible Connect protocol version: app speaks ${clientProtocol}, wallet speaks ${walletProtocol}`,
      { walletProtocol, clientProtocol });
  }

  const walletMajor = majorOf(walletProtocol);

  // 2. Optional MINOR floor within the MAJOR.
  if (minMinor !== undefined && compareSemver(clientProtocol, `${walletMajor}.${minMinor}`) < 0) {
    const requiredProtocol = `${walletMajor}.${minMinor}`;
    return fail(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION, 'protocol_incompatible',
      `Connect protocol ${clientProtocol} is below the required minimum ${requiredProtocol}`,
      { walletProtocol, clientProtocol, requiredProtocol });
  }

  // 3. Optional secondary npm-SDK floor (rarely used).
  if (minSdkVersion !== undefined && (!clientSdkVersion || compareSemver(clientSdkVersion, minSdkVersion) < 0)) {
    // A client that reported nothing is a distinct failure from one that reported an old
    // version — say which it was, or the developer checks a version that was never sent.
    const actual = clientSdkVersion ?? 'unknown (not reported)';
    return fail(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION, 'protocol_incompatible',
      `SDK version ${actual} is below the required minimum ${minSdkVersion}`,
      { walletProtocol, clientProtocol, requiredSdk: minSdkVersion, actualSdk: clientSdkVersion ?? null });
  }

  // 4. Network must match (a missing network is treated as a mismatch).
  if (!input.clientNetwork || input.clientNetwork.id !== input.walletNetworkId) {
    const refusal = fail(ERROR_CODES.INCOMPATIBLE_NETWORK, 'network_incompatible',
      'dApp targets a different network than the wallet',
      { walletNetwork: { id: input.walletNetworkId }, clientNetwork: input.clientNetwork ?? null });
    // Offerable only when both sides are real. An undeclared or malformed dApp network
    // gives the wallet nothing to switch to, and walletNetworkId is
    // `snapshot.networkId ?? -1` at the call site, so -1 means "the wallet does not
    // know its own network". 0 is a real id: the test is `< 0`, never falsiness.
    // The refusal above is identical either way; only the mismatch is withheld.
    if (!isOfferableNetwork(input.clientNetwork) || input.walletNetworkId < 0) return refusal;
    // The mismatch carries a COPY built from checked parts, never the peer's object:
    // typed `NetworkInfo` must mean what it says, and nothing else the peer sent (extra
    // keys, a non-string or oversized name) travels with it. `error.data.clientNetwork`
    // above is deliberately still the raw value: that is the wire payload.
    return {
      ...refusal,
      mismatch: {
        kind: 'network',
        walletNetwork: { id: input.walletNetworkId },
        clientNetwork: sanitizedNetwork(input.clientNetwork),
      },
    };
  }

  return { ok: true };
}

