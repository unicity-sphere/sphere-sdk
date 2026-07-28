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

export type CompatResult = { ok: true } | { ok: false; error: SphereRpcError };

function fail(
  code: number,
  reason: IncompatibleReason,
  message: string,
  extra: Record<string, unknown>,
): CompatResult {
  return { ok: false, error: { code, message, data: { reason, ...extra } } };
}

/**
 * Decide whether a connecting peer is compatible. Runs four ordered checks
 * (protocol MAJOR → optional MINOR floor → optional SDK floor → network) and
 * returns {ok:true} or {ok:false, error}. A malformed clientProtocol (NaN MAJOR)
 * is treated as protocol-incompatible.
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
    return fail(ERROR_CODES.INCOMPATIBLE_NETWORK, 'network_incompatible',
      'dApp targets a different network than the wallet',
      { walletNetwork: { id: input.walletNetworkId }, clientNetwork: input.clientNetwork ?? null });
  }

  return { ok: true };
}

