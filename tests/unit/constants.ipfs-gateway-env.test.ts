/**
 * Tests for the `SPHERE_IPFS_GATEWAY` env override in `constants.ts`.
 *
 * The override is parsed ONCE at module-init (see
 * `readIpfsGatewayEnvOverride` in constants.ts), so each test must
 * re-import the module after stubbing the env so it picks up the new
 * value. `vi.resetModules()` clears the import cache between cases.
 *
 * Issue #154: parallel software workaround for testnet IPFS gateway
 * outages — points e2e suites at an alternate gateway without patching
 * factories.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const BUILTIN = 'https://unicity-ipfs1.dyndns.org';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadConstants() {
  // Dynamic import after env stub + module reset, so the top-level
  // env read in constants.ts runs fresh.
  return await import('../../constants');
}

describe('SPHERE_IPFS_GATEWAY env override', () => {
  it('preserves built-in defaults when env is truly unset', async () => {
    // Real "unset" path: delete after unstubbing so the env-read sees no key
    // at all (not just an empty string). Steelman-finding #6: the "empty
    // stub" case below covers the falsy-string branch; this case covers the
    // genuinely-absent branch.
    vi.unstubAllEnvs();
    delete process.env.SPHERE_IPFS_GATEWAY;
    const c = await loadConstants();
    expect([...c.DEFAULT_IPFS_GATEWAYS]).toEqual([BUILTIN]);
    expect([...c.BUILTIN_IPFS_GATEWAYS]).toEqual([BUILTIN]);
    expect([...c.NETWORKS.testnet.ipfsGateways]).toEqual([BUILTIN]);
    expect(c.getIpfsGatewayUrls()).toEqual([BUILTIN]);
  });

  it('preserves built-in defaults when env is set to empty string', async () => {
    vi.stubEnv('SPHERE_IPFS_GATEWAY', '');
    const c = await loadConstants();
    expect([...c.DEFAULT_IPFS_GATEWAYS]).toEqual([BUILTIN]);
    expect([...c.BUILTIN_IPFS_GATEWAYS]).toEqual([BUILTIN]);
    expect([...c.NETWORKS.testnet.ipfsGateways]).toEqual([BUILTIN]);
    expect(c.getIpfsGatewayUrls()).toEqual([BUILTIN]);
  });

  it('replaces gateways with a single override URL', async () => {
    vi.stubEnv('SPHERE_IPFS_GATEWAY', 'https://ipfs.example.org');
    const c = await loadConstants();
    expect([...c.DEFAULT_IPFS_GATEWAYS]).toEqual(['https://ipfs.example.org']);
    // The static built-in MUST remain unchanged so callers can compare.
    expect([...c.BUILTIN_IPFS_GATEWAYS]).toEqual([BUILTIN]);
    // NETWORKS inherits via the shared reference.
    expect([...c.NETWORKS.testnet.ipfsGateways]).toEqual(['https://ipfs.example.org']);
    expect([...c.NETWORKS.mainnet.ipfsGateways]).toEqual(['https://ipfs.example.org']);
    expect([...c.NETWORKS.dev.ipfsGateways]).toEqual(['https://ipfs.example.org']);
    // getIpfsGatewayUrls() switches to the override list verbatim.
    expect(c.getIpfsGatewayUrls()).toEqual(['https://ipfs.example.org']);
    expect(c.getIpfsGatewayUrls(false)).toEqual(['https://ipfs.example.org']);
  });

  it('accepts a comma-separated list (multiple URLs, in order)', async () => {
    vi.stubEnv(
      'SPHERE_IPFS_GATEWAY',
      'https://gw1.example.org, https://gw2.example.org ,https://gw3.example.org',
    );
    const c = await loadConstants();
    expect([...c.DEFAULT_IPFS_GATEWAYS]).toEqual([
      'https://gw1.example.org',
      'https://gw2.example.org',
      'https://gw3.example.org',
    ]);
    expect(c.getIpfsGatewayUrls()).toEqual([
      'https://gw1.example.org',
      'https://gw2.example.org',
      'https://gw3.example.org',
    ]);
  });

  it('ignores an env value that is whitespace / commas only', async () => {
    // After trim+filter, no valid entries remain → fall back to defaults.
    vi.stubEnv('SPHERE_IPFS_GATEWAY', '  ,  , ');
    const c = await loadConstants();
    expect([...c.DEFAULT_IPFS_GATEWAYS]).toEqual([BUILTIN]);
    expect(c.getIpfsGatewayUrls()).toEqual([`https://unicity-ipfs1.dyndns.org`]);
  });

  it('does not affect DEFAULT_IPFS_BOOTSTRAP_PEERS or UNICITY_IPFS_NODES', async () => {
    vi.stubEnv('SPHERE_IPFS_GATEWAY', 'https://override.example.org');
    const c = await loadConstants();
    // Bootstrap peers are a distinct concern (libp2p P2P discovery, not
    // HTTP gateway). The env override targets HTTP gateways only.
    expect(c.DEFAULT_IPFS_BOOTSTRAP_PEERS.length).toBeGreaterThan(0);
    expect(c.DEFAULT_IPFS_BOOTSTRAP_PEERS[0]).toMatch(/^\/dns4\//);
    // UNICITY_IPFS_NODES is structural info (peerId etc.) and stays
    // untouched even when the env points elsewhere.
    expect(c.UNICITY_IPFS_NODES[0].host).toBe('unicity-ipfs1.dyndns.org');
    expect(c.UNICITY_IPFS_NODES[0].peerId).toMatch(/^12D3KooW/);
  });
});
