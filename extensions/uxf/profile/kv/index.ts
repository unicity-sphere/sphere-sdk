/**
 * Barrel exports for the ProfileKv substrate.
 *
 * The Node factory (`profile/node.ts`) picks up `ProfileKvNode` +
 * `LocalBlockCacheNode`; the browser factory (`profile/browser.ts`) picks
 * up `ProfileKvBrowser` + `LocalBlockCacheBrowser`. Both platforms wrap
 * their pair in a `ProfileKvAdapter` which satisfies `ProfileDatabase`.
 *
 * @module extensions/uxf/profile/kv
 */

export {
  ProfileKvNode,
  type ProfileKvBackend,
  type ProfileKvNodeOptions,
} from './profile-kv-node.js';
export {
  ProfileKvBrowser,
  type ProfileKvBrowserOptions,
} from './profile-kv-browser.js';
export {
  LocalBlockCacheNode,
  type LocalBlockCacheFacade,
  type LocalBlockCacheNodeOptions,
} from './local-block-cache-node.js';
export {
  LocalBlockCacheBrowser,
  type LocalBlockCacheBrowserOptions,
} from './local-block-cache-browser.js';
export {
  ProfileKvAdapter,
  deriveProfileDbNameShort,
  type ProfileKvAdapterOptions,
  type OpLogEntryEnvelope,
} from './profile-kv-adapter.js';
