import type { NetworkType } from '../constants';

/**
 * Default L3 network for tests. The SDK requires `network` at every entry point
 * (fail-loud), so tests must pass one — keep it in a single constant instead of
 * hardcoding the string at each call site, so the test network can change in one place.
 */
export const TEST_NETWORK: NetworkType = 'testnet2';
