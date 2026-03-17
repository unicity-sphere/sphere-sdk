#!/usr/bin/env npx tsx
/**
 * Sphere SDK CLI
 * Usage: npx tsx cli/index.ts <command> [args...]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { encrypt, decrypt } from '../core/encryption';
import { parseWalletText, isTextWalletEncrypted, parseAndDecryptWalletText } from '../serialization/wallet-text';
import { parseWalletDat, isSQLiteDatabase, isWalletDatEncrypted } from '../serialization/wallet-dat';
import { isValidPrivateKey, base58Encode, base58Decode } from '../core/utils';
import { hexToWIF, generatePrivateKey } from '../l1/crypto';
import { toSmallestUnit, toHumanReadable, formatAmount } from '../core/currency';
import { getPublicKey } from '../core/crypto';
import { generateAddressFromMasterKey } from '../l1/address';
import { Sphere } from '../core/Sphere';
import { createNodeProviders } from '../impl/nodejs';
import { TokenRegistry } from '../registry/TokenRegistry';
import { TokenValidator } from '../validation/token-validator';
import { tokenToTxf } from '../serialization/txf-serializer';
import type { NetworkType } from '../constants';
import type { TransportProvider } from '../transport/transport-provider';
import type { ProviderStatus } from '../types';

const args = process.argv.slice(2);
const command = args[0];

// =============================================================================
// CLI Configuration
// =============================================================================

const DEFAULT_DATA_DIR = './.sphere-cli';
const DEFAULT_TOKENS_DIR = './.sphere-cli/tokens';
const CONFIG_FILE = './.sphere-cli/config.json';
const PROFILES_FILE = './.sphere-cli/profiles.json';

interface CliConfig {
  network: NetworkType;
  dataDir: string;
  tokensDir: string;
  currentProfile?: string;
}

interface WalletProfile {
  name: string;
  dataDir: string;
  tokensDir: string;
  network: NetworkType;
  createdAt: string;
}

interface ProfilesStore {
  profiles: WalletProfile[];
}

function loadConfig(): CliConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {
    // Use defaults
  }
  return {
    network: 'testnet',
    dataDir: DEFAULT_DATA_DIR,
    tokensDir: DEFAULT_TOKENS_DIR,
  };
}

function saveConfig(config: CliConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// =============================================================================
// Wallet Profile Management
// =============================================================================

function loadProfiles(): ProfilesStore {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    }
  } catch {
    // Use defaults
  }
  return { profiles: [] };
}

function saveProfiles(store: ProfilesStore): void {
  fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(store, null, 2));
}

function getProfile(name: string): WalletProfile | undefined {
  const store = loadProfiles();
  return store.profiles.find(p => p.name === name);
}

function addProfile(profile: WalletProfile): void {
  const store = loadProfiles();
  const existing = store.profiles.findIndex(p => p.name === profile.name);
  if (existing >= 0) {
    store.profiles[existing] = profile;
  } else {
    store.profiles.push(profile);
  }
  saveProfiles(store);
}

function deleteProfile(name: string): boolean {
  const store = loadProfiles();
  const index = store.profiles.findIndex(p => p.name === name);
  if (index >= 0) {
    store.profiles.splice(index, 1);
    saveProfiles(store);
    return true;
  }
  return false;
}

function switchToProfile(name: string): boolean {
  const profile = getProfile(name);
  if (!profile) return false;

  const config = loadConfig();
  config.dataDir = profile.dataDir;
  config.tokensDir = profile.tokensDir;
  config.network = profile.network;
  config.currentProfile = name;
  saveConfig(config);
  return true;
}

// =============================================================================
// Sphere Instance Management
// =============================================================================

let sphereInstance: Sphere | null = null;
let noNostrGlobal = false;

/**
 * Create a no-op transport that does nothing.
 * Used with --no-nostr to prove IPFS-only recovery.
 */
function createNoopTransport(): TransportProvider {
  return {
    id: 'noop-transport',
    name: 'No-Op Transport',
    type: 'p2p' as const,
    description: 'No-op transport (Nostr disabled)',
    setIdentity: () => {},
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => false,
    getStatus: () => 'disconnected' as ProviderStatus,
    sendMessage: async () => '',
    onMessage: () => () => {},
    sendTokenTransfer: async () => '',
    onTokenTransfer: () => () => {},
    fetchPendingEvents: async () => {},
  };
}

async function getSphere(options?: { autoGenerate?: boolean; mnemonic?: string; nametag?: string }): Promise<Sphere> {
  if (sphereInstance) return sphereInstance;

  const config = loadConfig();
  const providers = createNodeProviders({
    network: config.network,
    dataDir: config.dataDir,
    tokensDir: config.tokensDir,
    tokenSync: { ipfs: { enabled: true } },
    market: true,
    groupChat: true,
  });

  const initProviders = noNostrGlobal
    ? { ...providers, transport: createNoopTransport() }
    : providers;

  const result = await Sphere.init({
    ...initProviders,
    autoGenerate: options?.autoGenerate,
    mnemonic: options?.mnemonic,
    nametag: options?.nametag,
    market: true,
    groupChat: true,
    accounting: true,
  });

  sphereInstance = result.sphere;

  // Attach IPFS storage provider for sync if available
  if (providers.ipfsTokenStorage) {
    await sphereInstance.addTokenStorageProvider(providers.ipfsTokenStorage);
  }

  return sphereInstance;
}

async function closeSphere(): Promise<void> {
  if (sphereInstance) {
    await sphereInstance.destroy();
    sphereInstance = null;
  }
}

/**
 * Resolve a coin identifier (symbol, name, or hex ID) to its registry definition.
 * Tries symbol first, then name, then raw hex ID.
 * Exits with error if not found.
 */
function resolveCoin(identifier: string): { coinId: string; symbol: string; decimals: number; name: string } {
  const registry = TokenRegistry.getInstance();
  let def = registry.getDefinitionBySymbol(identifier);
  if (!def) def = registry.getDefinitionByName(identifier);
  if (!def) def = registry.getDefinition(identifier);
  if (!def) {
    console.error(`Unknown asset: "${identifier}"`);
    console.error('Use "npm run cli -- assets" to list all registered assets.');
    process.exit(1);
  }
  return {
    coinId: def.id,
    symbol: def.symbol || identifier,
    decimals: def.decimals ?? 8,
    name: def.name || identifier,
  };
}

/**
 * Parse an asset argument in "<amount> <symbol>" format.
 * Examples: "1000000 UCT", "10.5 BTC", "500000 USDU"
 */
function parseAssetArg(value: string): { amount: string; coin: string } {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) {
    console.error(`Invalid asset format: "${value}". Expected "<amount> <symbol>" (e.g., "1000000 UCT")`);
    process.exit(1);
  }
  return { amount: parts[0], coin: parts[1] };
}

/** Map common symbols to faucet coin names. */
const FAUCET_COIN_MAP: Record<string, string> = {
  'UCT': 'unicity', 'BTC': 'bitcoin', 'ETH': 'ethereum',
  'SOL': 'solana', 'USDT': 'tether', 'USDC': 'usd-coin',
  'USDU': 'unicity-usd', 'EURU': 'unicity-eur', 'ALPHT': 'alpha-token',
};

async function syncIfEnabled(sphere: Sphere, skip: boolean): Promise<void> {
  if (skip) return;
  try {
    console.log('Syncing with IPFS...');
    const result = await sphere.payments.sync();
    if (result.added > 0 || result.removed > 0) {
      console.log(`  Synced: +${result.added} added, -${result.removed} removed`);
    } else {
      console.log('  Up to date.');
    }
  } catch (err) {
    console.warn(`  Sync warning: ${err instanceof Error ? err.message : err}`);
  }
}

// =============================================================================
// Interactive Input
// =============================================================================

function _prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// =============================================================================
// Per-command help definitions
// =============================================================================

interface CommandHelp {
  usage: string;
  description: string;
  flags?: Array<{ flag: string; description: string; default?: string }>;
  examples: string[];
  notes?: string[];
}

const COMMAND_HELP: Record<string, CommandHelp> = {
  // --- WALLET ---
  'init': {
    usage: 'init [--network <net>] [--mnemonic "<words>"] [--nametag <name>]',
    description: 'Create a new wallet or import an existing one from a mnemonic phrase. If no mnemonic is provided, a new 24-word mnemonic is generated automatically.',
    flags: [
      { flag: '--network <net>', description: 'Network to use (mainnet, testnet, dev)', default: 'testnet' },
      { flag: '--mnemonic "<words>"', description: 'Import wallet from BIP-39 mnemonic phrase (24 words in quotes)' },
      { flag: '--nametag <name>', description: 'Register a nametag during initialization (mints on-chain)' },
      { flag: '--no-nostr', description: 'Disable Nostr transport (use no-op transport)' },
    ],
    examples: [
      'npm run cli -- init --network testnet',
      'npm run cli -- init --mnemonic "word1 word2 ... word24"',
      'npm run cli -- init --nametag alice --network mainnet',
    ],
    notes: [
      'If a wallet already exists in the current profile, it will be loaded instead of creating a new one.',
      'Back up the generated mnemonic immediately -- it cannot be retrieved later.',
    ],
  },
  'status': {
    usage: 'status',
    description: 'Show wallet identity information including L1 address, Direct address, chain public key, nametag, and current network/profile.',
    examples: [
      'npm run cli -- status',
    ],
  },
  'config': {
    usage: 'config [set <key> <value>]',
    description: 'Show current CLI configuration or update a specific setting. Without arguments, displays all config values as JSON.',
    flags: [
      { flag: 'set network <value>', description: 'Set network (mainnet, testnet, dev)' },
      { flag: 'set dataDir <path>', description: 'Set wallet data directory path' },
      { flag: 'set tokensDir <path>', description: 'Set token storage directory path' },
    ],
    examples: [
      'npm run cli -- config',
      'npm run cli -- config set network mainnet',
      'npm run cli -- config set dataDir ./.my-wallet',
    ],
  },
  'clear': {
    usage: 'clear',
    description: 'Delete all wallet data including keys, tokens, and storage. This is irreversible -- make sure you have your mnemonic backed up.',
    examples: [
      'npm run cli -- clear',
    ],
    notes: [
      'This deletes everything in the current profile data and token directories.',
    ],
  },
  'wallet': {
    usage: 'wallet <subcommand>',
    description: 'Manage wallet profiles. Each profile has its own data directory, token storage, and network configuration.',
    examples: [
      'npm run cli -- wallet list',
      'npm run cli -- wallet create myprofile',
      'npm run cli -- wallet use myprofile',
      'npm run cli -- wallet current',
      'npm run cli -- wallet delete myprofile',
    ],
    notes: [
      'Subcommands: list, create, use, current, delete',
      'Use "help wallet <subcommand>" for detailed help on each.',
    ],
  },
  'wallet list': {
    usage: 'wallet list',
    description: 'List all wallet profiles with their network and data directory. The current active profile is marked with an arrow.',
    examples: [
      'npm run cli -- wallet list',
    ],
  },
  'wallet create': {
    usage: 'wallet create <name> [--network <net>]',
    description: 'Create a new wallet profile and switch to it. The profile stores its data in .sphere-cli-<name>/. After creating, run "init" to initialize the wallet.',
    flags: [
      { flag: '--network <net>', description: 'Network for the profile (mainnet, testnet, dev)', default: 'testnet' },
    ],
    examples: [
      'npm run cli -- wallet create alice',
      'npm run cli -- wallet create bob --network mainnet',
    ],
    notes: [
      'Profile names must be unique. After creation, initialize with: npm run cli -- init --nametag <name>',
    ],
  },
  'wallet use': {
    usage: 'wallet use <name>',
    description: 'Switch the active wallet profile. All subsequent commands will operate on this profile.',
    examples: [
      'npm run cli -- wallet use alice',
    ],
  },
  'wallet current': {
    usage: 'wallet current',
    description: 'Show the currently active wallet profile, its network, data directory, and identity (if initialized).',
    examples: [
      'npm run cli -- wallet current',
    ],
  },
  'wallet delete': {
    usage: 'wallet delete <name>',
    description: 'Remove a wallet profile from the profiles list. The on-disk data directory is NOT deleted -- remove it manually if needed.',
    examples: [
      'npm run cli -- wallet delete bob',
    ],
    notes: [
      'Cannot delete the currently active profile. Switch to a different profile first.',
    ],
  },

  // --- BALANCE & TOKENS ---
  'balance': {
    usage: 'balance [--finalize] [--no-sync]',
    description: 'Show L3 token balance grouped by coin. Receives any pending incoming transfers before displaying. Shows confirmed and unconfirmed amounts, token counts, and USD value.',
    flags: [
      { flag: '--finalize', description: 'Wait for unconfirmed tokens to be finalized (may take several seconds)' },
      { flag: '--no-sync', description: 'Skip IPFS sync before showing balance' },
    ],
    examples: [
      'npm run cli -- balance',
      'npm run cli -- balance --finalize',
      'npm run cli -- balance --no-sync',
    ],
  },
  'tokens': {
    usage: 'tokens [--no-sync]',
    description: 'List all individual tokens with their ID, coin type, amount, and status.',
    flags: [
      { flag: '--no-sync', description: 'Skip IPFS sync before listing tokens' },
    ],
    examples: [
      'npm run cli -- tokens',
      'npm run cli -- tokens --no-sync',
    ],
  },
  'assets': {
    usage: 'assets [--type <fungible|nft>]',
    description: 'List all registered assets (coins and NFTs) from the token registry. Shows symbol, name, kind, decimals, and coin ID.',
    flags: [
      { flag: '--type <kind>', description: 'Filter by asset kind: fungible (or coin/coins), nft (or nfts/non-fungible)' },
    ],
    examples: [
      'npm run cli -- assets',
      'npm run cli -- assets --type fungible',
      'npm run cli -- assets --type nft',
    ],
    notes: [
      'Requires wallet initialization (to load the token registry from the network).',
      'The registry is fetched from a remote URL and cached locally.',
    ],
  },
  'asset-info': {
    usage: 'asset-info <symbol|name|coinId>',
    description: 'Show detailed information for a specific asset. Looks up by symbol (UCT), name (bitcoin), or coin ID hex.',
    examples: [
      'npm run cli -- asset-info UCT',
      'npm run cli -- asset-info bitcoin',
      'npm run cli -- asset-info 0a1b2c3d4e5f...',
    ],
    notes: [
      'Use "assets" command first to see all available assets.',
      'Lookup is case-insensitive for symbols and names.',
    ],
  },
  'l1-balance': {
    usage: 'l1-balance',
    description: 'Show L1 (ALPHA blockchain) balance including confirmed and unconfirmed amounts. Connects to Fulcrum electrum server on first use.',
    examples: [
      'npm run cli -- l1-balance',
    ],
  },
  'topup': {
    usage: 'topup [<amount> <coin>]',
    description: 'Request test tokens from the Unicity faucet. Without arguments, requests default amounts of all supported coins. With amount and coin, requests a specific coin.',
    flags: [
      { flag: '<amount>', description: 'Amount to request (numeric)' },
      { flag: '<coin>', description: 'Coin symbol (UCT, BTC, ETH, SOL, USDT, USDC, USDU, EURU, ALPHT) or faucet name (unicity, bitcoin, ethereum, solana, tether, usd-coin, unicity-usd)' },
    ],
    examples: [
      'npm run cli -- topup',
      'npm run cli -- topup 100 UCT',
      'npm run cli -- topup 2 BTC',
      'npm run cli -- topup 42 ETH',
    ],
    notes: [
      'Requires a registered nametag. The faucet is only available on testnet.',
      'Also accessible as "top-up" or "faucet".',
    ],
  },
  'top-up': {
    usage: 'top-up [<amount> <coin>]',
    description: 'Alias for "topup". Request test tokens from the Unicity faucet.',
    examples: [
      'npm run cli -- top-up',
      'npm run cli -- top-up 2 BTC',
    ],
    notes: [
      'This is an alias for the "topup" command. See "help topup" for full details.',
    ],
  },
  'faucet': {
    usage: 'faucet [<amount> <coin>]',
    description: 'Alias for "topup". Request test tokens from the Unicity faucet.',
    examples: [
      'npm run cli -- faucet',
      'npm run cli -- faucet 100 ETH',
    ],
    notes: [
      'This is an alias for the "topup" command. See "help topup" for full details.',
    ],
  },
  'verify-balance': {
    usage: 'verify-balance [--remove] [-v|--verbose]',
    description: 'Verify all tokens against the aggregator to detect spent tokens that were not properly removed from local storage. Useful for cleaning up stale token state.',
    flags: [
      { flag: '--remove', description: 'Move detected spent tokens to the Sent (archive) folder' },
      { flag: '-v, --verbose', description: 'Show all tokens, not just spent ones; show progress and errors' },
    ],
    examples: [
      'npm run cli -- verify-balance',
      'npm run cli -- verify-balance --verbose',
      'npm run cli -- verify-balance --remove',
    ],
  },
  'sync': {
    usage: 'sync',
    description: 'Sync tokens with IPFS remote storage. Uploads local tokens and downloads any tokens stored remotely.',
    examples: [
      'npm run cli -- sync',
    ],
  },

  // --- TRANSFERS ---
  'send': {
    usage: 'send <recipient> <amount> <coin> [--direct|--proxy] [--instant|--conservative] [--no-sync]',
    description: 'Send L3 tokens to a recipient. The recipient can be a @nametag, DIRECT:// address, chain public key (02/03 prefix), or alpha1... L1 address. Amount is in decimal (e.g., 0.5) and is converted to smallest units automatically.',
    flags: [
      { flag: '<coin>', description: 'Asset symbol (UCT, BTC) as positional argument after amount', default: 'UCT' },
      { flag: '--direct', description: 'Force DirectAddress transfer (requires nametag with directAddress)' },
      { flag: '--proxy', description: 'Force PROXY address transfer (works with any nametag)' },
      { flag: '--instant', description: 'Send immediately via Nostr; receiver gets unconfirmed token', default: 'yes' },
      { flag: '--conservative', description: 'Collect all proofs first; receiver gets confirmed token' },
      { flag: '--no-sync', description: 'Skip IPFS sync after sending' },
    ],
    examples: [
      'npm run cli -- send @alice 10 UCT',
      'npm run cli -- send @alice 0.5 BTC',
      'npm run cli -- send DIRECT://0000be36... 500000 UCT --conservative',
      'npm run cli -- send @bob 100 USDU --no-sync',
    ],
    notes: [
      'Cannot use both --direct and --proxy simultaneously.',
      'Cannot use both --instant and --conservative simultaneously.',
    ],
  },
  'receive': {
    usage: 'receive [--finalize] [--no-sync]',
    description: 'Check for incoming token transfers via Nostr. Displays receive addresses and fetches any pending transfers.',
    flags: [
      { flag: '--finalize', description: 'Wait for unconfirmed tokens to be finalized before returning' },
      { flag: '--no-sync', description: 'Skip IPFS sync after receiving' },
    ],
    examples: [
      'npm run cli -- receive',
      'npm run cli -- receive --finalize',
    ],
  },
  'history': {
    usage: 'history [limit]',
    description: 'Show transaction history ordered by most recent first. Each entry shows date, direction, amount, coin, and counterparty.',
    flags: [
      { flag: '<limit>', description: 'Maximum number of transactions to show', default: '10' },
    ],
    examples: [
      'npm run cli -- history',
      'npm run cli -- history 20',
    ],
  },

  // --- ADDRESSES ---
  'addresses': {
    usage: 'addresses',
    description: 'List all tracked HD addresses with their index, L1 address, DIRECT address, nametag, and hidden status. The currently active address is marked with an arrow.',
    examples: [
      'npm run cli -- addresses',
    ],
  },
  'switch': {
    usage: 'switch <index>',
    description: 'Switch to a different HD-derived address by index. Index 0 is the default. New addresses are created on first switch.',
    examples: [
      'npm run cli -- switch 1',
      'npm run cli -- switch 0',
    ],
  },
  'hide': {
    usage: 'hide <index>',
    description: 'Hide an address from the active address list. Hidden addresses are excluded from getActiveAddresses() but still tracked.',
    examples: [
      'npm run cli -- hide 2',
    ],
  },
  'unhide': {
    usage: 'unhide <index>',
    description: 'Unhide a previously hidden address, making it visible in the active address list again.',
    examples: [
      'npm run cli -- unhide 2',
    ],
  },

  // --- NAMETAGS ---
  'nametag': {
    usage: 'nametag <name>',
    description: 'Register a nametag (@name) for the current address. Mints a nametag token on-chain and publishes to Nostr relay. The name should not include the @ prefix.',
    examples: [
      'npm run cli -- nametag alice',
      'npm run cli -- nametag myname',
    ],
  },
  'nametag-info': {
    usage: 'nametag-info <name>',
    description: 'Look up information about a nametag, including the associated public key and addresses. Resolves via the Nostr relay.',
    examples: [
      'npm run cli -- nametag-info alice',
      'npm run cli -- nametag-info bob',
    ],
  },
  'my-nametag': {
    usage: 'my-nametag',
    description: 'Show the nametag registered for the current address.',
    examples: [
      'npm run cli -- my-nametag',
    ],
  },
  'nametag-sync': {
    usage: 'nametag-sync',
    description: 'Re-publish the current nametag identity binding with chainPubkey. Useful for fixing legacy nametags that were registered without the chainPubkey field.',
    examples: [
      'npm run cli -- nametag-sync',
    ],
  },

  // --- MESSAGING ---
  'dm': {
    usage: 'dm <@nametag|pubkey> <message>',
    description: 'Send an encrypted direct message to a peer via Nostr (NIP-17 gift-wrapped).',
    examples: [
      'npm run cli -- dm @alice "Hello, how are you?"',
      'npm run cli -- dm @bob "Payment sent for order #42"',
    ],
  },
  'dm-inbox': {
    usage: 'dm-inbox',
    description: 'List all DM conversations with unread counts and last message preview.',
    examples: [
      'npm run cli -- dm-inbox',
    ],
  },
  'dm-history': {
    usage: 'dm-history <@nametag|pubkey> [--limit <n>]',
    description: 'Show message history for a specific conversation. Resolves @nametag to pubkey automatically.',
    flags: [
      { flag: '--limit <n>', description: 'Maximum number of messages to display', default: '50' },
    ],
    examples: [
      'npm run cli -- dm-history @alice',
      'npm run cli -- dm-history @alice --limit 20',
    ],
  },

  // --- GROUP CHAT ---
  'group-create': {
    usage: 'group-create <name> [--description <text>] [--private]',
    description: 'Create a new NIP-29 group chat on the relay.',
    flags: [
      { flag: '--description <text>', description: 'Group description text' },
      { flag: '--private', description: 'Create a private (invite-only) group' },
    ],
    examples: [
      'npm run cli -- group-create "Trading Chat"',
      'npm run cli -- group-create "Team Alpha" --description "Internal team chat" --private',
    ],
  },
  'group-list': {
    usage: 'group-list',
    description: 'List all available public groups on the relay with their names, IDs, descriptions, and member counts.',
    examples: [
      'npm run cli -- group-list',
    ],
  },
  'group-my': {
    usage: 'group-my',
    description: 'List groups you have joined, with unread message counts and last message preview.',
    examples: [
      'npm run cli -- group-my',
    ],
  },
  'group-join': {
    usage: 'group-join <groupId> [--invite <code>]',
    description: 'Join a group by its ID. Private groups require an invite code.',
    flags: [
      { flag: '--invite <code>', description: 'Invite code for private groups' },
    ],
    examples: [
      'npm run cli -- group-join tradingchat',
      'npm run cli -- group-join privatechat --invite abc123',
    ],
  },
  'group-leave': {
    usage: 'group-leave <groupId>',
    description: 'Leave a group you have previously joined.',
    examples: [
      'npm run cli -- group-leave tradingchat',
    ],
  },
  'group-send': {
    usage: 'group-send <groupId> <message> [--reply <eventId>]',
    description: 'Send a message to a group. Optionally reply to a specific message by event ID.',
    flags: [
      { flag: '--reply <eventId>', description: 'Event ID of the message to reply to' },
    ],
    examples: [
      'npm run cli -- group-send tradingchat "Hello everyone!"',
      'npm run cli -- group-send tradingchat "I agree" --reply abc123def',
    ],
  },
  'group-messages': {
    usage: 'group-messages <groupId> [--limit <n>]',
    description: 'Show recent messages in a group. Fetches from relay and marks the group as read.',
    flags: [
      { flag: '--limit <n>', description: 'Maximum number of messages to display', default: '50' },
    ],
    examples: [
      'npm run cli -- group-messages tradingchat',
      'npm run cli -- group-messages tradingchat --limit 20',
    ],
  },
  'group-members': {
    usage: 'group-members <groupId>',
    description: 'List members of a group with their nametags, roles (ADMIN/MOD), and join dates.',
    examples: [
      'npm run cli -- group-members tradingchat',
    ],
  },
  'group-info': {
    usage: 'group-info <groupId>',
    description: 'Show detailed information about a group including name, visibility, description, member count, creation date, and relay URL.',
    examples: [
      'npm run cli -- group-info tradingchat',
    ],
  },

  // --- MARKET ---
  'market-post': {
    usage: 'market-post <description> --type <type> [options]',
    description: 'Post an intent to the market bulletin board. Type is required.',
    flags: [
      { flag: '--type <type>', description: 'Intent type: buy, sell, service, announcement, other (required)' },
      { flag: '--category <cat>', description: 'Intent category for filtering' },
      { flag: '--price <n>', description: 'Price amount (numeric)' },
      { flag: '--currency <code>', description: 'Currency code (USD, UCT, etc.)' },
      { flag: '--location <loc>', description: 'Location for geographic filtering' },
      { flag: '--contact <handle>', description: 'Contact handle (e.g., @nametag, email)' },
      { flag: '--expires <days>', description: 'Expiration in days', default: '30' },
    ],
    examples: [
      'npm run cli -- market-post "Buying 100 UCT" --type buy',
      'npm run cli -- market-post "Selling ETH" --type sell --price 50 --currency USD',
      'npm run cli -- market-post "Web dev services" --type service --contact @alice',
    ],
  },
  'market-search': {
    usage: 'market-search <query> [options]',
    description: 'Search the market bulletin board using semantic search. Returns intents ranked by relevance score.',
    flags: [
      { flag: '--type <type>', description: 'Filter by intent type' },
      { flag: '--category <cat>', description: 'Filter by category' },
      { flag: '--min-price <n>', description: 'Minimum price filter' },
      { flag: '--max-price <n>', description: 'Maximum price filter' },
      { flag: '--min-score <0-1>', description: 'Minimum similarity score threshold' },
      { flag: '--location <loc>', description: 'Location filter' },
      { flag: '--limit <n>', description: 'Maximum results to return', default: '10' },
    ],
    examples: [
      'npm run cli -- market-search "UCT tokens" --type sell --limit 5',
      'npm run cli -- market-search "tokens" --min-score 0.7',
      'npm run cli -- market-search "services" --min-price 10 --max-price 100',
    ],
  },
  'market-my': {
    usage: 'market-my',
    description: 'List all intents you have posted to the market.',
    examples: [
      'npm run cli -- market-my',
    ],
  },
  'market-close': {
    usage: 'market-close <id>',
    description: 'Close (delete) one of your market intents by its ID.',
    examples: [
      'npm run cli -- market-close abc123',
    ],
  },
  'market-feed': {
    usage: 'market-feed [--rest]',
    description: 'Watch the live market listing feed via WebSocket. Shows new intents in real time. Use --rest for a one-shot fetch instead.',
    flags: [
      { flag: '--rest', description: 'Use REST fallback: fetch recent listings once and exit' },
    ],
    examples: [
      'npm run cli -- market-feed',
      'npm run cli -- market-feed --rest',
    ],
    notes: [
      'WebSocket mode runs indefinitely. Press Ctrl+C to stop.',
    ],
  },

  // --- INVOICES ---
  'invoice-create': {
    usage: 'invoice-create --target <address> --asset "<amount> <coin>" [options]',
    description: 'Create a new invoice by specifying a target address and requested payment. Alternatively, load full terms from a JSON file with --terms. The invoice is minted as an on-chain token.',
    flags: [
      { flag: '--target <address>', description: 'Target address (@nametag or DIRECT:// address) (required unless --terms)' },
      { flag: '--asset "<amount> <coin>"', description: 'Requested asset in "<amount> <symbol>" format (e.g., "1000000 UCT")' },
      { flag: '--nft <id>', description: 'Request a specific NFT by token ID (instead of coin+amount)' },
      { flag: '--due <ISO-date>', description: 'Due date in ISO-8601 format (e.g., 2026-12-31)' },
      { flag: '--memo <text>', description: 'Invoice memo text' },
      { flag: '--delivery <method>', description: 'Delivery method description' },
      { flag: '--terms <json-file>', description: 'Load full CreateInvoiceRequest from a JSON file (overrides other flags)' },
    ],
    examples: [
      'npm run cli -- invoice-create --target @alice --asset "1000000 UCT"',
      'npm run cli -- invoice-create --target @alice --asset "500000 BTC" --memo "Order #42" --due 2026-12-31',
      'npm run cli -- invoice-create --terms invoice-terms.json',
    ],
    notes: [
      'Amounts must be positive integers in smallest units (no decimals, no leading zeros).',
    ],
  },
  'invoice-import': {
    usage: 'invoice-import <token-file>',
    description: 'Import an invoice from a TXF token JSON file. Parses the invoice terms from the token data and adds it to local tracking.',
    examples: [
      'npm run cli -- invoice-import ./received-invoice.json',
    ],
  },
  'invoice-list': {
    usage: 'invoice-list [--state <states>] [--role <creator|payer>] [--limit <n>]',
    description: 'List invoices with optional filtering by state and role. States can be comma-separated.',
    flags: [
      { flag: '--state <states>', description: 'Filter by state: OPEN, PARTIAL, COVERED, CLOSED, CANCELLED, EXPIRED (comma-separated)' },
      { flag: '--role <role>', description: 'Filter by role: "creator" (invoices you created) or "payer" (invoices targeting you)' },
      { flag: '--limit <n>', description: 'Maximum number of invoices to return' },
    ],
    examples: [
      'npm run cli -- invoice-list',
      'npm run cli -- invoice-list --state OPEN,PARTIAL --limit 5',
      'npm run cli -- invoice-list --role creator',
    ],
  },
  'invoice-status': {
    usage: 'invoice-status <id-or-prefix>',
    description: 'Show detailed invoice status including state, per-target balance breakdown, total forward/back payments, and confirmation status. Accepts full ID or unique prefix.',
    examples: [
      'npm run cli -- invoice-status a1b2c3d4',
      'npm run cli -- invoice-status a1b2c3d4e5f6...',
    ],
  },
  'invoice-close': {
    usage: 'invoice-close <id-or-prefix> [--auto-return]',
    description: 'Close an invoice (terminal state). Freezes balances and stops dynamic recomputation. Optionally triggers auto-return for overpayments.',
    flags: [
      { flag: '--auto-return', description: 'Trigger auto-return of excess payments on close' },
    ],
    examples: [
      'npm run cli -- invoice-close a1b2c3d4',
      'npm run cli -- invoice-close a1b2c3d4 --auto-return',
    ],
  },
  'invoice-cancel': {
    usage: 'invoice-cancel <id-or-prefix>',
    description: 'Cancel an invoice (terminal state). If auto-return is enabled, payments will be automatically refunded.',
    examples: [
      'npm run cli -- invoice-cancel a1b2c3d4',
    ],
  },
  'invoice-pay': {
    usage: 'invoice-pay <id-or-prefix> [--amount <value>] [--target-index <n>]',
    description: 'Pay an invoice. By default pays the remaining amount for the first target. For multi-target invoices, specify --target-index.',
    flags: [
      { flag: '--amount <value>', description: 'Amount to pay in smallest units (positive integer). Defaults to remaining amount.' },
      { flag: '--target-index <n>', description: 'Target index for multi-target invoices (0-based)', default: '0' },
    ],
    examples: [
      'npm run cli -- invoice-pay a1b2c3d4',
      'npm run cli -- invoice-pay a1b2c3d4 --amount 500000',
      'npm run cli -- invoice-pay a1b2c3d4 --target-index 1 --amount 250000',
    ],
  },
  'invoice-return': {
    usage: 'invoice-return <id-or-prefix> --recipient <address> --asset "<amount> <coin>"',
    description: 'Manually return a payment to a sender for a specific invoice.',
    flags: [
      { flag: '--recipient <address>', description: 'Recipient address or @nametag (required)' },
      { flag: '--asset "<amount> <coin>"', description: 'Asset to return in "<amount> <symbol>" format (e.g., "100000 UCT")' },
    ],
    examples: [
      'npm run cli -- invoice-return a1b2c3d4 --recipient @bob --asset "100000 UCT"',
    ],
  },
  'invoice-receipts': {
    usage: 'invoice-receipts <id-or-prefix>',
    description: 'Send payment receipts via DM to each sender who contributed to this invoice. Typically used after closing an invoice.',
    examples: [
      'npm run cli -- invoice-receipts a1b2c3d4',
    ],
  },
  'invoice-notices': {
    usage: 'invoice-notices <id-or-prefix>',
    description: 'Send cancellation notice DMs to each sender who contributed to a cancelled invoice.',
    examples: [
      'npm run cli -- invoice-notices a1b2c3d4',
    ],
  },
  'invoice-auto-return': {
    usage: 'invoice-auto-return [--enable|--disable] [--invoice <id>]',
    description: 'Show or configure auto-return settings. Without flags, displays current settings. Auto-return automatically refunds payments received against closed or cancelled invoices.',
    flags: [
      { flag: '--enable', description: 'Enable auto-return' },
      { flag: '--disable', description: 'Disable auto-return' },
      { flag: '--invoice <id>', description: 'Target a specific invoice (default: global "*" scope)' },
    ],
    examples: [
      'npm run cli -- invoice-auto-return',
      'npm run cli -- invoice-auto-return --enable',
      'npm run cli -- invoice-auto-return --disable --invoice a1b2c3d4',
    ],
  },
  'invoice-transfers': {
    usage: 'invoice-transfers <id-or-prefix>',
    description: 'List all transfers related to an invoice in chronological order, including forward payments and returns.',
    examples: [
      'npm run cli -- invoice-transfers a1b2c3d4',
    ],
  },
  'invoice-export': {
    usage: 'invoice-export <id-or-prefix>',
    description: 'Export an invoice to a JSON file. The file is saved as invoice-<prefix>.json in the current directory.',
    examples: [
      'npm run cli -- invoice-export a1b2c3d4',
    ],
  },
  'invoice-parse-memo': {
    usage: 'invoice-parse-memo <memo-string>',
    description: 'Parse an invoice memo string (INV:...) and display its decoded fields.',
    examples: [
      'npm run cli -- invoice-parse-memo "INV:a1b2c3d4...:F"',
    ],
  },

  // --- SWAPS ---
  'swap-propose': {
    usage: 'swap-propose --to <recipient> --offer "<amount> <coin>" --want "<amount> <coin>" [options]',
    description: 'Propose a token swap deal to a counterparty. Both parties deposit tokens into an escrow, which executes the swap atomically.',
    flags: [
      { flag: '--to <recipient>', description: 'Counterparty @nametag or address (required)' },
      { flag: '--offer "<amount> <coin>"', description: 'Asset you are offering in "<amount> <symbol>" format (e.g., "1000000 UCT")' },
      { flag: '--want "<amount> <coin>"', description: 'Asset you want in return in "<amount> <symbol>" format (e.g., "500000 USDU")' },
      { flag: '--escrow <address>', description: 'Custom escrow address (optional, uses config default)' },
      { flag: '--timeout <seconds>', description: 'Swap timeout in seconds (60-86400)', default: '3600' },
      { flag: '--message <text>', description: 'Optional message to the counterparty' },
    ],
    examples: [
      'npm run cli -- swap-propose --to @bob --offer "1000000 UCT" --want "500000 USDU"',
      'npm run cli -- swap-propose --to @bob --offer "1000000 UCT" --want "500000 USDU" --timeout 7200 --message "Quick trade?"',
    ],
    notes: [
      'Amounts must be positive integers in smallest units (no decimals, no leading zeros).',
    ],
  },
  'swap-list': {
    usage: 'swap-list [--all] [--role <proposer|acceptor>] [--progress <state>]',
    description: 'List swap deals. By default shows only open and in-progress swaps. Use --all to include completed/cancelled/failed swaps.',
    flags: [
      { flag: '--all', description: 'Include terminal states (completed, cancelled, failed)' },
      { flag: '--role <role>', description: 'Filter by your role: "proposer" or "acceptor"' },
      { flag: '--progress <state>', description: 'Filter by progress state' },
    ],
    examples: [
      'npm run cli -- swap-list',
      'npm run cli -- swap-list --all',
      'npm run cli -- swap-list --role proposer',
      'npm run cli -- swap-list --all --role proposer',
    ],
  },
  'swap-accept': {
    usage: 'swap-accept <swap_id> [--deposit] [--no-wait]',
    description: 'Accept a proposed swap deal by its full 64-character hex ID. Announces acceptance to the escrow.',
    flags: [
      { flag: '--deposit', description: 'Immediately deposit after accepting' },
      { flag: '--no-wait', description: 'Do not wait for swap completion after depositing (only with --deposit)' },
    ],
    examples: [
      'npm run cli -- swap-accept a1b2c3d4...full64hex...',
      'npm run cli -- swap-accept a1b2c3d4...full64hex... --deposit',
      'npm run cli -- swap-accept a1b2c3d4...full64hex... --deposit --no-wait',
    ],
    notes: [
      'The swap ID must be the full 64-character hex string.',
      'Without --deposit, run "swap-deposit <id>" separately when ready.',
    ],
  },
  'swap-status': {
    usage: 'swap-status <swap_id> [--query-escrow]',
    description: 'Show detailed status of a swap deal including progress, deal terms, and deposit information.',
    flags: [
      { flag: '--query-escrow', description: 'Query the escrow service for the latest status' },
    ],
    examples: [
      'npm run cli -- swap-status a1b2c3d4...full64hex...',
      'npm run cli -- swap-status a1b2c3d4...full64hex... --query-escrow',
    ],
    notes: [
      'If the swap has an associated deposit invoice, its status is also displayed.',
    ],
  },
  'swap-deposit': {
    usage: 'swap-deposit <swap_id>',
    description: 'Deposit tokens into an accepted swap. The swap must be in the "announced" state (accepted and awaiting deposits).',
    examples: [
      'npm run cli -- swap-deposit a1b2c3d4...full64hex...',
    ],
    notes: [
      'The swap ID must be the full 64-character hex string.',
    ],
  },

  // --- DAEMON ---
  'daemon': {
    usage: 'daemon <start|stop|status> [options]',
    description: 'Manage the persistent event listener daemon. The daemon listens for wallet events and triggers configured actions.',
    examples: [
      'npm run cli -- daemon start --event transfer:incoming --action auto-receive',
      'npm run cli -- daemon start --detach --event "*" --action "log:./events.jsonl"',
      'npm run cli -- daemon stop',
      'npm run cli -- daemon status',
    ],
  },
  'daemon start': {
    usage: 'daemon start [options]',
    description: 'Start the persistent event listener. Can subscribe to specific events and trigger actions (auto-receive, webhook, bash command, or log file).',
    flags: [
      { flag: '--config <path>', description: 'Config file path', default: '.sphere-cli/daemon.json' },
      { flag: '--detach', description: 'Run in background (fork process, PID file, redirect logs)' },
      { flag: '--log <path>', description: 'Override log file path' },
      { flag: '--pid <path>', description: 'Override PID file path' },
      { flag: '--event <type>', description: 'Event type to subscribe to (repeatable). Use "*" for all events.' },
      { flag: '--action <spec>', description: 'Action to trigger: auto-receive, bash:<cmd>, webhook:<url>, log:<path>' },
      { flag: '--market-feed', description: 'Also subscribe to the market WebSocket feed' },
      { flag: '--verbose', description: 'Print full event JSON in logs' },
    ],
    examples: [
      'npm run cli -- daemon start --event transfer:incoming --action auto-receive',
      'npm run cli -- daemon start --event "transfer:*" --action "webhook:https://example.com/hook" --detach',
      'npm run cli -- daemon start --event "*" --action "log:./events.jsonl" --verbose',
      'npm run cli -- daemon start --event message:dm --action "bash:echo DM from \\$SPHERE_SENDER"',
      'npm run cli -- daemon start --config ./my-daemon.json --detach',
    ],
  },
  'daemon stop': {
    usage: 'daemon stop',
    description: 'Stop the running daemon process.',
    examples: [
      'npm run cli -- daemon stop',
    ],
  },
  'daemon status': {
    usage: 'daemon status',
    description: 'Check if the daemon is currently running and show its PID.',
    examples: [
      'npm run cli -- daemon status',
    ],
  },

  // --- ENCRYPTION ---
  'encrypt': {
    usage: 'encrypt <data> <password>',
    description: 'Encrypt a string with AES using a password. Outputs the encrypted result as JSON.',
    examples: [
      'npm run cli -- encrypt "my secret data" mypassword',
    ],
  },
  'decrypt': {
    usage: 'decrypt <encrypted-json> <password>',
    description: 'Decrypt an AES-encrypted JSON blob using a password. Outputs the original plaintext.',
    examples: [
      'npm run cli -- decrypt \'{"iv":"...","data":"..."}\' mypassword',
    ],
  },

  // --- WALLET PARSING ---
  'parse-wallet': {
    usage: 'parse-wallet <file> [password]',
    description: 'Parse a wallet backup file (.txt or .dat format). If the file is encrypted, a password is required.',
    examples: [
      'npm run cli -- parse-wallet wallet.txt',
      'npm run cli -- parse-wallet wallet.txt mypassword',
      'npm run cli -- parse-wallet wallet.dat',
    ],
  },
  'wallet-info': {
    usage: 'wallet-info <file>',
    description: 'Show metadata about a wallet file: format (.txt, .dat, .json), whether it is encrypted, and other format-specific info.',
    examples: [
      'npm run cli -- wallet-info wallet.txt',
      'npm run cli -- wallet-info backup.dat',
    ],
  },

  // --- KEY OPERATIONS ---
  'generate-key': {
    usage: 'generate-key',
    description: 'Generate a random secp256k1 private key and derive the public key, WIF, and L1 address from it.',
    examples: [
      'npm run cli -- generate-key',
    ],
  },
  'validate-key': {
    usage: 'validate-key <hex>',
    description: 'Validate whether a hex string is a valid secp256k1 private key. Exits with code 0 if valid, 1 if invalid.',
    examples: [
      'npm run cli -- validate-key 0a1b2c3d...',
    ],
  },
  'hex-to-wif': {
    usage: 'hex-to-wif <hex>',
    description: 'Convert a hex private key to Wallet Import Format (WIF).',
    examples: [
      'npm run cli -- hex-to-wif 0a1b2c3d...',
    ],
  },
  'derive-pubkey': {
    usage: 'derive-pubkey <private-key-hex>',
    description: 'Derive the compressed secp256k1 public key from a private key.',
    examples: [
      'npm run cli -- derive-pubkey 0a1b2c3d...',
    ],
  },
  'derive-address': {
    usage: 'derive-address <private-key-hex> [index]',
    description: 'Derive an L1 (alpha1...) address from a private key at the given HD derivation index.',
    flags: [
      { flag: '<index>', description: 'HD derivation index', default: '0' },
    ],
    examples: [
      'npm run cli -- derive-address 0a1b2c3d...',
      'npm run cli -- derive-address 0a1b2c3d... 3',
    ],
  },

  // --- CURRENCY ---
  'to-smallest': {
    usage: 'to-smallest <amount> <coin>',
    description: 'Convert a human-readable amount to the smallest unit. Use the coin symbol to apply the correct decimals for a specific asset. Default uses 8 decimals if no coin specified.',
    flags: [
      { flag: '<coin>', description: 'Asset symbol (UCT, BTC), name (bitcoin), or hex coin ID. Determines decimal precision.' },
    ],
    examples: [
      'npm run cli -- to-smallest 1.5 UCT',
      'npm run cli -- to-smallest 0.001 BTC',
      'npm run cli -- to-smallest 100.5 USDT',
    ],
    notes: [
      'When a coin is provided, the wallet is loaded briefly to access the token registry.',
    ],
  },
  'to-human': {
    usage: 'to-human <amount> <coin>',
    description: 'Convert an amount in smallest units back to human-readable format. Use the coin symbol to apply the correct decimals for a specific asset. Default uses 8 decimals if no coin specified.',
    flags: [
      { flag: '<coin>', description: 'Asset symbol (UCT, BTC), name (bitcoin), or hex coin ID. Determines decimal precision.' },
    ],
    examples: [
      'npm run cli -- to-human 150000000 UCT',
      'npm run cli -- to-human 1000000 BTC',
      'npm run cli -- to-human 1000000 USDT',
    ],
    notes: [
      'When a coin is provided, the wallet is loaded briefly to access the token registry.',
    ],
  },
  'format': {
    usage: 'format <amount> [decimals]',
    description: 'Format an amount with the specified number of decimal places.',
    flags: [
      { flag: '<decimals>', description: 'Number of decimal places', default: '8' },
    ],
    examples: [
      'npm run cli -- format 150000000',
      'npm run cli -- format 150000000 6',
    ],
  },

  // --- ENCODING ---
  'base58-encode': {
    usage: 'base58-encode <hex>',
    description: 'Encode a hex string to Base58.',
    examples: [
      'npm run cli -- base58-encode 0a1b2c3d',
    ],
  },
  'base58-decode': {
    usage: 'base58-decode <string>',
    description: 'Decode a Base58 string to hex.',
    examples: [
      'npm run cli -- base58-decode 2NEpo7TZRhna',
    ],
  },
};

function printCommandHelp(cmdName: string): void {
  const help = COMMAND_HELP[cmdName];
  if (!help) {
    console.error(`No help available for command: ${cmdName}`);
    console.error('Run "npm run cli -- help" for a list of all commands.');
    process.exit(1);
  }

  console.log(`\n  ${cmdName}\n`);
  console.log(`  Usage: npm run cli -- ${help.usage}\n`);
  console.log(`  ${help.description}\n`);

  if (help.flags && help.flags.length > 0) {
    console.log('  Flags:');
    const maxFlagLen = Math.max(...help.flags.map(f => f.flag.length));
    for (const f of help.flags) {
      const defaultStr = f.default ? ` (default: ${f.default})` : '';
      console.log(`    ${f.flag.padEnd(maxFlagLen + 2)}${f.description}${defaultStr}`);
    }
    console.log('');
  }

  if (help.examples.length > 0) {
    console.log('  Examples:');
    for (const ex of help.examples) {
      console.log(`    ${ex}`);
    }
    console.log('');
  }

  if (help.notes && help.notes.length > 0) {
    console.log('  Notes:');
    for (const note of help.notes) {
      console.log(`    - ${note}`);
    }
    console.log('');
  }
}

function printUsage() {
  console.log(`
Sphere SDK CLI v0.3.0

Usage: npm run cli -- <command> [args...]
   or: npx tsx cli/index.ts <command> [args...]
   or: npm run cli -- help <command>     Show detailed help for a command

WALLET:
  init                              Create or import wallet
  status                            Show wallet identity
  config                            Show or set CLI configuration
  clear                             Delete all wallet data

WALLET PROFILES:
  wallet list                       List all wallet profiles
  wallet create <name>              Create a new wallet profile
  wallet use <name>                 Switch to a wallet profile
  wallet current                    Show active profile
  wallet delete <name>              Delete a wallet profile

BALANCE & TOKENS:
  balance                           Show L3 token balance
  tokens                            List individual tokens
  assets                            List all registered assets (coins & NFTs)
  asset-info <id>                   Show detailed info for an asset
  l1-balance                        L1 (ALPHA) balance
  topup [<amount> <coin>]            Request test tokens from faucet
  verify-balance                    Detect spent tokens via aggregator
  sync                              Sync tokens with IPFS

TRANSFERS:
  send <to> <amount> <coin>         Send L3 tokens
  receive                           Check for incoming transfers
  history [limit]                   Transaction history

ADDRESSES:
  addresses                         List tracked addresses
  switch <index>                    Switch to HD address
  hide <index>                      Hide address
  unhide <index>                    Unhide address

NAMETAGS:
  nametag <name>                    Register a nametag
  nametag-info <name>               Look up nametag info
  my-nametag                        Show current nametag
  nametag-sync                      Re-publish nametag binding to Nostr

MESSAGING:
  dm <@nametag> <message>           Send a direct message
  dm-inbox                          List conversations and unread counts
  dm-history <@nametag|pubkey>      Show conversation history

GROUP CHAT:
  group-create <name>               Create a new group
  group-list                        List available groups on relay
  group-my                          List your joined groups
  group-join <groupId>              Join a group
  group-leave <groupId>             Leave a group
  group-send <groupId> <message>    Send a message to a group
  group-messages <groupId>          Show group messages
  group-members <groupId>           List group members
  group-info <groupId>              Show group details

MARKET:
  market-post <desc> --type <type>  Post an intent
  market-search <query>             Search intents (semantic)
  market-my                         List your own intents
  market-close <id>                 Close (delete) an intent
  market-feed                       Watch the live listing feed

INVOICES:
  invoice-create                    Create invoice
  invoice-import <file>             Import invoice from token file
  invoice-list                      List invoices
  invoice-status <id>               Show invoice status
  invoice-pay <id>                  Pay an invoice
  invoice-close <id>                Close an invoice
  invoice-cancel <id>               Cancel an invoice
  invoice-return <id>               Return payment to sender
  invoice-receipts <id>             Send receipts
  invoice-notices <id>              Send cancellation notices
  invoice-auto-return               Show/set auto-return settings
  invoice-transfers <id>            List related transfers
  invoice-export <id>               Export invoice to JSON file
  invoice-parse-memo <memo>         Parse invoice memo string

SWAPS:
  swap-propose                      Propose a token swap deal
  swap-list                         List swap deals
  swap-accept <id>                  Accept a swap deal
  swap-status <id>                  Show swap status
  swap-deposit <id>                 Deposit into a swap

EVENT DAEMON:
  daemon start                      Start persistent event listener
  daemon stop                       Stop running daemon
  daemon status                     Check if daemon is running

UTILITIES:
  encrypt <data> <password>         Encrypt data with password
  decrypt <json> <password>         Decrypt encrypted JSON data
  parse-wallet <file> [password]    Parse wallet file (.txt, .dat)
  wallet-info <file>                Show wallet file info
  generate-key                      Generate new private key
  validate-key <key>                Validate a private key
  hex-to-wif <hex>                  Convert hex to WIF
  derive-pubkey <key>               Derive public key
  derive-address <key> [index]      Derive L1 address
  to-smallest <amount> <coin>       Convert to smallest unit
  to-human <amount> <coin>          Convert to human-readable
  format <amount> [decimals]        Format amount
  base58-encode <hex>               Base58 encode
  base58-decode <b58>               Base58 decode

Run "npm run cli -- help <command>" for detailed help on any command.

Examples:
  npm run cli -- init --network testnet
  npm run cli -- init --mnemonic "word1 word2 ... word24"
  npm run cli -- status
  npm run cli -- balance
  npm run cli -- send @alice 1000000 ETH
  npm run cli -- nametag myname
  npm run cli -- history 10
  npm run cli -- help send
`);
}

async function main() {
  // Global flag: --no-nostr disables Nostr transport (uses no-op)
  noNostrGlobal = args.includes('--no-nostr');

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  if (command === 'help') {
    const helpTarget = args[1];
    if (!helpTarget || helpTarget === '--help' || helpTarget === '-h' || helpTarget === 'help') {
      printUsage();
      process.exit(0);
    }
    // Try compound key first (e.g., "wallet create", "daemon start")
    const compoundKey = args[2] ? `${helpTarget} ${args[2]}` : undefined;
    if (compoundKey && COMMAND_HELP[compoundKey]) {
      printCommandHelp(compoundKey);
    } else if (COMMAND_HELP[helpTarget]) {
      printCommandHelp(helpTarget);
    } else {
      console.error(`No help available for command: ${helpTarget}`);
      console.error('Run "npm run cli -- help" for a list of all commands.');
      process.exit(1);
    }
    process.exit(0);
  }

  try {
    switch (command) {
      // === WALLET MANAGEMENT ===
      case 'init': {
        const networkIndex = args.indexOf('--network');
        const mnemonicIndex = args.indexOf('--mnemonic');

        let network: NetworkType = 'testnet';
        let mnemonic: string | undefined;
        let nametag: string | undefined;

        if (networkIndex !== -1 && args[networkIndex + 1]) {
          network = args[networkIndex + 1] as NetworkType;
        }
        if (mnemonicIndex !== -1 && args[mnemonicIndex + 1]) {
          mnemonic = args[mnemonicIndex + 1];
        }

        const nametagIndex = args.indexOf('--nametag');
        if (nametagIndex !== -1 && args[nametagIndex + 1]) {
          nametag = args[nametagIndex + 1];
        }

        // Save config
        const config = loadConfig();
        config.network = network;
        saveConfig(config);

        console.log(`Initializing wallet on ${network}...`);
        if (noNostrGlobal) console.log('  (Nostr transport disabled)');

        const sphere = await getSphere({
          autoGenerate: !mnemonic,
          mnemonic,
          nametag,
        });

        const identity = sphere.identity;
        if (!identity) {
          console.error('Failed to initialize wallet identity');
          process.exit(1);
        }

        console.log('\nWallet initialized successfully!\n');
        console.log('Identity:');
        console.log(JSON.stringify({
          l1Address: identity.l1Address,
          directAddress: identity.directAddress,
          chainPubkey: identity.chainPubkey,
          nametag: identity.nametag,
        }, null, 2));

        if (!mnemonic) {
          // Show generated mnemonic for backup
          const storedMnemonic = sphere.getMnemonic();
          if (storedMnemonic) {
            console.log('\n⚠️  BACKUP YOUR MNEMONIC (24 words):');
            console.log('─'.repeat(50));
            console.log(storedMnemonic);
            console.log('─'.repeat(50));
            console.log('Store this safely! You will need it to recover your wallet.\n');
          }
        }

        await closeSphere();
        break;
      }

      case 'status': {
        try {
          const sphere = await getSphere();
          const identity = sphere.identity;
          const config = loadConfig();

          if (!identity) {
            console.log('No wallet found. Run: npm run cli -- init');
            break;
          }

          console.log('\nWallet Status:');
          console.log('─'.repeat(50));
          if (config.currentProfile) {
            console.log(`Profile:       ${config.currentProfile}`);
          }
          console.log(`Network:       ${config.network}`);
          console.log(`L1 Address:    ${identity.l1Address}`);
          console.log(`Direct Addr:   ${identity.directAddress || '(not set)'}`);
          console.log(`Chain Pubkey:  ${identity.chainPubkey}`);
          console.log(`Nametag:       ${identity.nametag || '(not set)'}`);
          console.log('─'.repeat(50));

          await closeSphere();
        } catch {
          console.log('No wallet found. Run: npm run cli -- init');
        }
        break;
      }

      case 'config': {
        const [, subCmd, key, value] = args;
        const config = loadConfig();

        if (subCmd === 'set' && key && value) {
          if (key === 'network') {
            config.network = value as NetworkType;
          } else if (key === 'dataDir') {
            config.dataDir = value;
          } else if (key === 'tokensDir') {
            config.tokensDir = value;
          } else {
            console.error('Unknown config key:', key);
            console.error('Valid keys: network, dataDir, tokensDir');
            process.exit(1);
          }
          saveConfig(config);
          console.log(`Set ${key} = ${value}`);
        } else {
          console.log('\nCurrent Configuration:');
          console.log(JSON.stringify(config, null, 2));
        }
        break;
      }

      case 'clear': {
        const config = loadConfig();
        const providers = createNodeProviders({
          network: config.network,
          dataDir: config.dataDir,
          tokensDir: config.tokensDir,
        });

        await providers.storage.connect();
        await providers.tokenStorage.initialize();

        console.log('Clearing all wallet data...');
        await Sphere.clear({ storage: providers.storage, tokenStorage: providers.tokenStorage });
        console.log('All wallet data cleared.');

        await providers.storage.disconnect();
        await providers.tokenStorage.shutdown();
        break;
      }

      // === WALLET PROFILES ===
      case 'wallet': {
        const [, subCmd, profileName] = args;

        switch (subCmd) {
          case 'list': {
            const store = loadProfiles();
            const config = loadConfig();

            console.log('\nWallet Profiles:');
            console.log('─'.repeat(60));

            if (store.profiles.length === 0) {
              console.log('No profiles found. Create one with: npm run cli -- wallet create <name>');
            } else {
              for (const profile of store.profiles) {
                const isCurrent = config.currentProfile === profile.name;
                const marker = isCurrent ? '→ ' : '  ';
                console.log(`${marker}${profile.name}`);
                console.log(`    Network: ${profile.network}`);
                console.log(`    DataDir: ${profile.dataDir}`);
              }
            }
            console.log('─'.repeat(60));
            break;
          }

          case 'use': {
            if (!profileName) {
              console.error('Usage: wallet use <name>');
              console.error('Example: npm run cli -- wallet use babaika9');
              process.exit(1);
            }

            if (switchToProfile(profileName)) {
              console.log(`✓ Switched to wallet profile: ${profileName}`);

              // Show wallet status
              try {
                const sphere = await getSphere();
                const identity = sphere.identity;
                if (identity) {
                  console.log(`  Nametag:  ${identity.nametag || '(not set)'}`);
                  console.log(`  L1 Addr:  ${identity.l1Address}`);
                }
                await closeSphere();
              } catch {
                console.log('  (wallet not initialized in this profile)');
              }
            } else {
              console.error(`Profile "${profileName}" not found.`);
              console.error('Run: npm run cli -- wallet list');
              process.exit(1);
            }
            break;
          }

          case 'create': {
            if (!profileName) {
              console.error('Usage: wallet create <name> [--network testnet|mainnet|dev]');
              console.error('Example: npm run cli -- wallet create mywalletname');
              process.exit(1);
            }

            // Check if profile already exists
            if (getProfile(profileName)) {
              console.error(`Profile "${profileName}" already exists.`);
              console.error('Run: npm run cli -- wallet use ' + profileName);
              process.exit(1);
            }

            // Parse optional network
            const networkIdx = args.indexOf('--network');
            let network: NetworkType = 'testnet';
            if (networkIdx !== -1 && args[networkIdx + 1]) {
              network = args[networkIdx + 1] as NetworkType;
            }

            const dataDir = `./.sphere-cli-${profileName}`;
            const tokensDir = `${dataDir}/tokens`;

            // Create the profile
            const profile: WalletProfile = {
              name: profileName,
              dataDir,
              tokensDir,
              network,
              createdAt: new Date().toISOString(),
            };
            addProfile(profile);

            // Switch to the new profile
            switchToProfile(profileName);

            console.log(`✓ Created wallet profile: ${profileName}`);
            console.log(`  Network:  ${network}`);
            console.log(`  DataDir:  ${dataDir}`);
            console.log('');
            console.log('Now initialize the wallet:');
            console.log(`  npm run cli -- init --nametag ${profileName}`);
            break;
          }

          case 'current': {
            const config = loadConfig();
            const currentName = config.currentProfile;

            console.log('\nCurrent Wallet:');
            console.log('─'.repeat(50));

            if (currentName) {
              const profile = getProfile(currentName);
              if (profile) {
                console.log(`Profile:   ${profile.name}`);
                console.log(`Network:   ${profile.network}`);
                console.log(`DataDir:   ${profile.dataDir}`);
              } else {
                console.log(`Profile:   ${currentName} (not found in profiles)`);
              }
            } else {
              console.log('Profile:   (default)');
            }

            console.log(`DataDir:   ${config.dataDir}`);
            console.log(`Network:   ${config.network}`);

            // Try to get identity
            try {
              const sphere = await getSphere();
              const identity = sphere.identity;
              if (identity) {
                console.log(`Nametag:   ${identity.nametag || '(not set)'}`);
                console.log(`L1 Addr:   ${identity.l1Address}`);
              }
              await closeSphere();
            } catch {
              console.log('Wallet:    (not initialized)');
            }

            console.log('─'.repeat(50));
            break;
          }

          case 'delete': {
            if (!profileName) {
              console.error('Usage: wallet delete <name>');
              process.exit(1);
            }

            const config = loadConfig();
            if (config.currentProfile === profileName) {
              console.error(`Cannot delete the current profile. Switch to another profile first.`);
              process.exit(1);
            }

            if (deleteProfile(profileName)) {
              console.log(`✓ Deleted profile: ${profileName}`);
              console.log('Note: Wallet data directory was NOT deleted. Remove manually if needed.');
            } else {
              console.error(`Profile "${profileName}" not found.`);
              process.exit(1);
            }
            break;
          }

          default:
            console.error('Unknown wallet subcommand:', subCmd);
            console.log('\nUsage:');
            console.log('  wallet list              List all profiles');
            console.log('  wallet use <name>        Switch to profile');
            console.log('  wallet create <name>     Create new profile');
            console.log('  wallet current           Show current profile');
            console.log('  wallet delete <name>     Delete profile');
            process.exit(1);
        }
        break;
      }

      // === BALANCE & TOKENS ===
      case 'balance': {
        const finalize = args.includes('--finalize');
        const noSync = args.includes('--no-sync');
        const sphere = await getSphere();

        await syncIfEnabled(sphere, noSync);

        console.log(finalize ? '\nFetching and finalizing tokens...' : '\nFetching tokens...');
        const result = await sphere.payments.receive({
          finalize,
          onProgress: (resolution) => {
            if (resolution.stillPending > 0) {
              const currentBalances = sphere.payments.getBalance();
              for (const bal of currentBalances) {
                if (BigInt(bal.unconfirmedAmount) > 0n) {
                  console.log(`  ${bal.symbol}: ${bal.unconfirmedTokenCount} token(s) still unconfirmed...`);
                }
              }
            }
          },
        });

        if (finalize) {
          if (result.timedOut) {
            console.log('  Warning: finalization timed out, some tokens still unconfirmed.');
          } else if (result.finalization && result.finalization.resolved > 0) {
            console.log(`All tokens finalized in ${((result.finalizationDurationMs ?? 0) / 1000).toFixed(1)}s.`);
          } else {
            console.log('All tokens are already confirmed.');
          }
        }

        const assets = sphere.payments.getBalance();
        const totalUsd = await sphere.payments.getFiatBalance();

        console.log('\nL3 Balance:');
        console.log('─'.repeat(50));

        if (assets.length === 0) {
          console.log('No tokens found.');
        } else {
          for (const asset of assets) {
            const decimals = asset.decimals ?? 8;
            const confirmedFormatted = toHumanReadable(asset.confirmedAmount, decimals);
            const unconfirmedBigInt = BigInt(asset.unconfirmedAmount);

            let line = `${asset.symbol}: ${confirmedFormatted}`;
            if (unconfirmedBigInt > 0n) {
              const unconfirmedFormatted = toHumanReadable(asset.unconfirmedAmount, decimals);
              line += ` (+ ${unconfirmedFormatted} unconfirmed) [${asset.confirmedTokenCount}+${asset.unconfirmedTokenCount} tokens]`;
            } else {
              line += ` (${asset.tokenCount} token${asset.tokenCount !== 1 ? 's' : ''})`;
            }
            if (asset.fiatValueUsd != null) {
              line += ` ≈ $${asset.fiatValueUsd.toFixed(2)}`;
            }
            console.log(line);
          }
        }
        console.log('─'.repeat(50));
        if (totalUsd != null) {
          console.log(`Total: $${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        }

        await closeSphere();
        break;
      }

      case 'tokens': {
        const noSync = args.includes('--no-sync');
        const sphere = await getSphere();

        await syncIfEnabled(sphere, noSync);

        const tokens = sphere.payments.getTokens();
        const registry = TokenRegistry.getInstance();

        console.log('\nTokens:');
        console.log('─'.repeat(50));

        if (tokens.length === 0) {
          console.log('No tokens found.');
        } else {
          for (const token of tokens) {
            const def = registry.getDefinition(token.coinId);
            const symbol = def?.symbol || token.symbol || 'UNK';
            const decimals = def?.decimals ?? token.decimals ?? 8;
            const formatted = toHumanReadable(token.amount || '0', decimals);
            console.log(`ID: ${token.id.slice(0, 16)}...`);
            console.log(`  Coin: ${symbol} (${token.coinId.slice(0, 8)}...)`);
            console.log(`  Amount: ${formatted} ${symbol}`);
            console.log(`  Status: ${token.status || 'active'}`);
            console.log('');
          }
        }
        console.log('─'.repeat(50));

        await closeSphere();
        break;
      }

      case 'assets': {
        // Initialize Sphere so TokenRegistry is loaded with remote data
        const sphere = await getSphere();
        const registry = TokenRegistry.getInstance();
        const allDefs = registry.getAllDefinitions();

        const typeFilter = args.indexOf('--type');
        const filterValue = typeFilter !== -1 ? args[typeFilter + 1] : undefined;

        let defs = allDefs;
        if (filterValue === 'fungible' || filterValue === 'coin' || filterValue === 'coins') {
          defs = registry.getFungibleTokens();
        } else if (filterValue === 'nft' || filterValue === 'nfts' || filterValue === 'non-fungible') {
          defs = registry.getNonFungibleTokens();
        }

        if (defs.length === 0) {
          console.log('No registered assets found.');
          console.log('The token registry may not have loaded yet. Try again in a moment.');
        } else {
          // Table header
          console.log('');
          console.log(`${'SYMBOL'.padEnd(10)} ${'NAME'.padEnd(20)} ${'KIND'.padEnd(14)} ${'DECIMALS'.padEnd(10)} ${'COIN ID'}`);
          console.log('─'.repeat(90));

          // Sort: fungible first (by symbol), then NFTs (by name)
          const sorted = [...defs].sort((a, b) => {
            if (a.assetKind !== b.assetKind) return a.assetKind === 'fungible' ? -1 : 1;
            const aLabel = a.symbol || a.name || a.id;
            const bLabel = b.symbol || b.name || b.id;
            return aLabel.localeCompare(bLabel);
          });

          for (const def of sorted) {
            const symbol = (def.symbol || '—').padEnd(10);
            const name = (def.name ? def.name.charAt(0).toUpperCase() + def.name.slice(1) : '—').padEnd(20);
            const kind = def.assetKind.padEnd(14);
            const decimals = (def.decimals !== undefined ? String(def.decimals) : '—').padEnd(10);
            const coinId = def.id.slice(0, 16) + '...';
            console.log(`${symbol} ${name} ${kind} ${decimals} ${coinId}`);
          }

          console.log('─'.repeat(90));
          console.log(`Total: ${defs.length} asset(s)`);
        }

        await closeSphere();
        break;
      }

      case 'asset-info': {
        const identifier = args[1];
        if (!identifier) {
          console.error('Usage: asset-info <symbol|name|coinId>');
          console.error('Examples:');
          console.error('  npm run cli -- asset-info UCT');
          console.error('  npm run cli -- asset-info bitcoin');
          console.error('  npm run cli -- asset-info 0a1b2c3d...');
          process.exit(1);
        }

        // Initialize Sphere so TokenRegistry is loaded
        const sphere = await getSphere();
        const registry = TokenRegistry.getInstance();

        // Try multiple lookup strategies
        let def = registry.getDefinitionBySymbol(identifier);
        if (!def) def = registry.getDefinitionByName(identifier);
        if (!def) def = registry.getDefinition(identifier); // by coinId hex

        if (!def) {
          console.error(`Asset not found: "${identifier}"`);
          console.error('Use "assets" command to list all registered assets.');
          process.exit(1);
        }

        console.log('');
        console.log('Asset Details');
        console.log('─'.repeat(50));
        console.log(`  Symbol:      ${def.symbol || '—'}`);
        console.log(`  Name:        ${def.name ? def.name.charAt(0).toUpperCase() + def.name.slice(1) : '—'}`);
        console.log(`  Kind:        ${def.assetKind}`);
        console.log(`  Decimals:    ${def.decimals !== undefined ? def.decimals : '—'}`);
        console.log(`  Coin ID:     ${def.id}`);
        console.log(`  Network:     ${def.network}`);
        console.log(`  Description: ${def.description || '—'}`);
        if (def.icons && def.icons.length > 0) {
          console.log(`  Icons:`);
          for (const icon of def.icons) {
            console.log(`    - ${icon.url}`);
          }
        }
        console.log('─'.repeat(50));

        await closeSphere();
        break;
      }

      case 'l1-balance': {
        const sphere = await getSphere();

        if (!sphere.payments.l1) {
          console.error('L1 module not available. Initialize with L1 config.');
          process.exit(1);
        }

        const balance = await sphere.payments.l1.getBalance();

        console.log('\nL1 (ALPHA) Balance:');
        console.log('─'.repeat(50));
        console.log(`Confirmed: ${toHumanReadable(balance.confirmed.toString())} ALPHA`);
        console.log(`Unconfirmed: ${toHumanReadable(balance.unconfirmed.toString())} ALPHA`);
        console.log('─'.repeat(50));

        await closeSphere();
        break;
      }

      case 'verify-balance': {
        // Verify tokens against the aggregator to detect spent tokens
        // Uses SDK Token.fromJSON() to calculate current state hash (per TOKEN_INVENTORY_SPEC.md)
        const removeSpent = args.includes('--remove');
        const verbose = args.includes('--verbose') || args.includes('-v');

        const sphere = await getSphere();
        const tokens = sphere.payments.getTokens();
        const identity = sphere.identity;

        if (!identity) {
          console.error('No wallet identity found.');
          process.exit(1);
        }

        console.log(`\nVerifying ${tokens.length} token(s) against aggregator...`);
        console.log('─'.repeat(60));

        // Get aggregator client from the initialized oracle provider in Sphere
        const oracle = sphere.getAggregator();
        const aggregatorClient = (oracle as { getAggregatorClient?: () => unknown }).getAggregatorClient?.();

        if (!aggregatorClient) {
          console.error('Aggregator client not available. Cannot verify tokens.');
          await closeSphere();
          process.exit(1);
        }

        // Create validator with aggregator client
        const validator = new TokenValidator({
          aggregatorClient: aggregatorClient as Parameters<typeof TokenValidator.prototype.setAggregatorClient>[0],
        });

        // Use checkSpentTokens which properly calculates state hash using SDK
        // (following TOKEN_INVENTORY_SPEC.md Step 7: Spent Token Detection)
        const result = await validator.checkSpentTokens(
          tokens,
          identity.chainPubkey,
          {
            batchSize: 5,
            onProgress: (completed, total) => {
              if (verbose && (completed % 10 === 0 || completed === total)) {
                console.log(`  Checked ${completed}/${total} tokens...`);
              }
            }
          }
        );

        // Build result maps for display
        const registry = TokenRegistry.getInstance();
        const spentTokenIds = new Set(result.spentTokens.map(s => s.localId));

        const spentDisplay: { id: string; tokenId: string; symbol: string; amount: string }[] = [];
        const validDisplay: { id: string; tokenId: string; symbol: string; amount: string }[] = [];

        for (const token of tokens) {
          const def = registry.getDefinition(token.coinId);
          const symbol = def?.symbol || token.symbol || 'UNK';
          const decimals = def?.decimals ?? token.decimals ?? 8;
          const formatted = toHumanReadable(token.amount || '0', decimals);

          const txf = tokenToTxf(token);
          const tokenId = txf?.genesis?.data?.tokenId || token.id;

          if (spentTokenIds.has(token.id)) {
            spentDisplay.push({
              id: token.id,
              tokenId: tokenId.slice(0, 16),
              symbol,
              amount: formatted,
            });
            console.log(`✗ SPENT: ${formatted} ${symbol} (${tokenId.slice(0, 12)}...)`);
          } else {
            validDisplay.push({
              id: token.id,
              tokenId: tokenId.slice(0, 16),
              symbol,
              amount: formatted,
            });
            if (verbose) {
              console.log(`✓ Valid: ${formatted} ${symbol} (${tokenId.slice(0, 12)}...)`);
            }
          }
        }

        console.log('─'.repeat(60));
        console.log(`\nSummary:`);
        console.log(`  Valid tokens: ${validDisplay.length}`);
        console.log(`  Spent tokens: ${spentDisplay.length}`);
        if (result.errors.length > 0) {
          console.log(`  Errors: ${result.errors.length}`);
          if (verbose) {
            for (const err of result.errors) {
              console.log(`    - ${err}`);
            }
          }
        }

        // Move spent tokens to Sent folder if requested (per TOKEN_INVENTORY_SPEC.md)
        if (removeSpent && spentDisplay.length > 0) {
          console.log(`\nMoving ${spentDisplay.length} spent token(s) to Sent folder...`);

          // Access PaymentsModule's removeToken which:
          // 1. Archives token to Sent folder (archivedTokens)
          // 2. Creates tombstone to prevent re-sync
          // 3. Removes from active tokens
          const paymentsModule = sphere.payments as unknown as {
            removeToken?: (tokenId: string, recipientNametag?: string, skipHistory?: boolean) => Promise<void>;
          };

          if (!paymentsModule.removeToken) {
            console.error('  Error: removeToken method not available');
          } else {
            for (const spent of spentDisplay) {
              try {
                // Use removeToken which archives to Sent folder and creates tombstone
                // skipHistory=true since this is spent detection, not a new send
                await paymentsModule.removeToken(spent.id, undefined, true);
                console.log(`  Archived: ${spent.amount} ${spent.symbol} (${spent.tokenId}...)`);
              } catch (err) {
                console.error(`  Failed to archive ${spent.id}: ${err}`);
              }
            }
            console.log('  Tokens moved to Sent folder.');
          }
        } else if (spentDisplay.length > 0) {
          console.log(`\nTo move spent tokens to Sent folder, run: npm run cli -- verify-balance --remove`);
        }

        await closeSphere();
        break;
      }

      case 'sync': {
        const sphere = await getSphere();
        await syncIfEnabled(sphere, false);
        await closeSphere();
        break;
      }

      // === TRANSFERS ===
      case 'send': {
        const [, recipient, amountStr] = args;
        if (!recipient || !amountStr) {
          console.error('Usage: send <recipient> <amount> <coin> [--direct|--proxy] [--instant|--conservative]');
          console.error('  recipient: @nametag or DIRECT:// address');
          console.error('  amount: decimal amount (e.g., 0.5, 100)');
          console.error('  coin: token symbol (e.g., UCT, BTC, ETH, SOL) - default: UCT');
          console.error('  --direct: force DirectAddress transfer (requires new nametag with directAddress)');
          console.error('  --proxy: force PROXY address transfer (works with any nametag)');
          console.error('  --instant: send via Nostr immediately (default, receiver gets unconfirmed token)');
          console.error('  --conservative: collect all proofs first, receiver gets confirmed token');
          process.exit(1);
        }

        // Parse coin: positional arg[3]
        let coinSymbol: string;
        if (args[3] && !args[3].startsWith('--')) {
          coinSymbol = args[3];
        } else {
          coinSymbol = 'UCT'; // default
        }

        // Parse --direct and --proxy options
        const forceDirect = args.includes('--direct');
        const forceProxy = args.includes('--proxy');
        if (forceDirect && forceProxy) {
          console.error('Cannot use both --direct and --proxy');
          process.exit(1);
        }
        const addressMode = forceDirect ? 'direct' : forceProxy ? 'proxy' : 'auto';

        // Parse --instant and --conservative options
        const forceInstant = args.includes('--instant');
        const forceConservative = args.includes('--conservative');
        if (forceInstant && forceConservative) {
          console.error('Cannot use both --instant and --conservative');
          process.exit(1);
        }
        const transferMode = forceConservative ? 'conservative' as const : 'instant' as const;

        // Initialize Sphere first so TokenRegistry is loaded
        const sphere = await getSphere();

        // Resolve symbol/name/hex to coinId and get decimals
        const { coinId: coinIdHex, symbol: resolvedSymbol, decimals } = resolveCoin(coinSymbol);

        // Convert amount to smallest units (supports decimal input like "0.2")
        const amountSmallest = toSmallestUnit(amountStr, decimals).toString();

        const modeLabel = addressMode === 'auto' ? '' : ` (${addressMode})`;
        const txModeLabel = forceConservative ? ' [conservative]' : '';
        console.log(`\nSending ${amountStr} ${resolvedSymbol} to ${recipient}${modeLabel}${txModeLabel}...`);

        const result = await sphere.payments.send({
          recipient,
          amount: amountSmallest,
          coinId: coinIdHex,
          addressMode,
          transferMode,
        });

        if (result.status === 'completed' || result.status === 'submitted') {
          console.log('\n✓ Transfer successful!');
          console.log(`  Transfer ID: ${result.id}`);
          console.log(`  Status: ${result.status}`);
        } else {
          console.error('\n✗ Transfer failed:', result.error || result.status);
        }

        // Wait for background tasks (e.g., change token creation from instant split)
        await sphere.payments.waitForPendingOperations();
        const noSyncSend = args.includes('--no-sync');
        await syncIfEnabled(sphere, noSyncSend);
        await closeSphere();
        break;
      }

      case 'receive': {
        const finalize = args.includes('--finalize');
        const noSyncRecv = args.includes('--no-sync');
        const sphere = await getSphere();
        const identity = sphere.identity;

        if (!identity) {
          console.error('No wallet initialized.');
          process.exit(1);
        }

        // Show addresses
        console.log('\nReceive Address:');
        console.log('─'.repeat(50));
        console.log(`L3 (Direct): ${identity.directAddress || '(not available)'}`);
        console.log(`L1 (ALPHA):  ${identity.l1Address}`);
        if (identity.nametag) {
          console.log(`Nametag:     @${identity.nametag}`);
        }
        console.log('─'.repeat(50));

        // Fetch pending transfers
        console.log('\nChecking for incoming transfers...');
        const registry = TokenRegistry.getInstance();
        const result = await sphere.payments.receive({
          finalize,
          onProgress: (resolution) => {
            if (resolution.stillPending > 0) {
              console.log(`  ${resolution.stillPending} token(s) still finalizing...`);
            }
          },
        });

        if (result.transfers.length === 0) {
          console.log('No new transfers found.');
        } else {
          console.log(`\nReceived ${result.transfers.length} new transfer(s):`);
          for (const transfer of result.transfers) {
            for (const token of transfer.tokens) {
              const def = registry.getDefinition(token.coinId);
              const decimals = def?.decimals ?? token.decimals ?? 8;
              const symbol = def?.symbol || token.symbol;
              const formatted = toHumanReadable(token.amount, decimals);
              const statusTag = token.status === 'confirmed' ? '' : ` [${token.status}]`;
              console.log(`  ${formatted} ${symbol}${statusTag}`);
            }
          }
        }

        if (finalize && result.timedOut) {
          console.log('\nWarning: finalization timed out, some tokens still unconfirmed.');
        } else if (finalize && result.finalizationDurationMs) {
          console.log(`\nAll tokens finalized in ${(result.finalizationDurationMs / 1000).toFixed(1)}s.`);
        }

        await syncIfEnabled(sphere, noSyncRecv);
        await closeSphere();
        break;
      }

      case 'history': {
        const [, limitStr = '10'] = args;
        const limit = parseInt(limitStr);

        const sphere = await getSphere();
        const history = sphere.payments.getHistory();
        const limited = history.slice(0, limit);

        console.log(`\nTransaction History (last ${limit}):`)
        console.log('─'.repeat(60));

        if (limited.length === 0) {
          console.log('No transactions found.');
        } else {
          const registry = TokenRegistry.getInstance();
          for (const tx of limited) {
            const date = new Date(tx.timestamp).toLocaleString();
            const direction = tx.type === 'SENT' ? '→' : '←';
            // Look up decimals from registry, default to 8
            const coinDef = registry.getDefinition(tx.coinId);
            const decimals = coinDef?.decimals ?? 8;
            const amount = toHumanReadable(tx.amount?.toString() || '0', decimals);
            console.log(`${date} ${direction} ${amount} ${tx.symbol}`);
            const counterparty = tx.type === 'SENT' ? tx.recipientNametag : tx.senderPubkey;
            console.log(`  ${tx.type === 'SENT' ? 'To' : 'From'}: ${counterparty || 'unknown'}`);
            console.log('');
          }
        }
        console.log('─'.repeat(60));

        await closeSphere();
        break;
      }

      // === ADDRESSES ===
      case 'addresses': {
        const sphere = await getSphere();
        const all = sphere.getAllTrackedAddresses();
        const currentIndex = sphere.getCurrentAddressIndex();

        console.log('\nTracked Addresses:');
        console.log('─'.repeat(70));

        if (all.length === 0) {
          console.log('No tracked addresses.');
        } else {
          for (const addr of all) {
            const marker = addr.index === currentIndex ? '→ ' : '  ';
            const hidden = addr.hidden ? ' [hidden]' : '';
            const tag = addr.nametag ? ` @${addr.nametag}` : '';
            console.log(`${marker}#${addr.index}: ${addr.l1Address}${tag}${hidden}`);
            console.log(`    DIRECT: ${addr.directAddress}`);
          }
        }

        console.log('─'.repeat(70));
        await closeSphere();
        break;
      }

      case 'switch': {
        const [, indexStr] = args;
        if (!indexStr) {
          console.error('Usage: switch <index>');
          console.error('  index: HD address index (0, 1, 2, ...)');
          process.exit(1);
        }

        const index = parseInt(indexStr);
        if (isNaN(index) || index < 0) {
          console.error('Invalid index. Must be a non-negative integer.');
          process.exit(1);
        }

        const sphere = await getSphere();
        await sphere.switchToAddress(index);

        const identity = sphere.identity;
        console.log(`\nSwitched to address #${index}`);
        console.log(`  L1:      ${identity?.l1Address}`);
        console.log(`  DIRECT:  ${identity?.directAddress}`);
        console.log(`  Nametag: ${identity?.nametag || '(not set)'}`);

        await closeSphere();
        break;
      }

      case 'hide': {
        const [, indexStr] = args;
        if (!indexStr) {
          console.error('Usage: hide <index>');
          process.exit(1);
        }

        const sphere = await getSphere();
        await sphere.setAddressHidden(parseInt(indexStr), true);
        console.log(`Address #${indexStr} hidden.`);
        await closeSphere();
        break;
      }

      case 'unhide': {
        const [, indexStr] = args;
        if (!indexStr) {
          console.error('Usage: unhide <index>');
          process.exit(1);
        }

        const sphere = await getSphere();
        await sphere.setAddressHidden(parseInt(indexStr), false);
        console.log(`Address #${indexStr} unhidden.`);
        await closeSphere();
        break;
      }

      // === NAMETAGS ===
      case 'nametag': {
        const [, name] = args;
        if (!name) {
          console.error('Usage: nametag <name>');
          console.error('  name: desired nametag (without @)');
          process.exit(1);
        }

        const cleanName = name.replace('@', '');
        const sphere = await getSphere();

        console.log(`\nRegistering nametag @${cleanName}...`);

        try {
          await sphere.registerNametag(cleanName);
          console.log(`\n✓ Nametag @${cleanName} registered successfully!`);
        } catch (err) {
          console.error('\n✗ Registration failed:', err instanceof Error ? err.message : err);
        }

        await closeSphere();
        break;
      }

      case 'nametag-info': {
        const [, name] = args;
        if (!name) {
          console.error('Usage: nametag-info <name>');
          process.exit(1);
        }

        const cleanName = name.replace('@', '');
        const sphere = await getSphere();

        // Use transport provider to resolve nametag
        const transport = (sphere as unknown as { _transport?: { resolveNametagInfo?: (n: string) => Promise<unknown> } })._transport;
        const info = await transport?.resolveNametagInfo?.(cleanName);

        if (info) {
          console.log(`\nNametag Info: @${cleanName}`);
          console.log('─'.repeat(50));
          console.log(JSON.stringify(info, null, 2));
          console.log('─'.repeat(50));
        } else {
          console.log(`\nNametag @${cleanName} not found.`);
        }

        await closeSphere();
        break;
      }

      case 'my-nametag': {
        const sphere = await getSphere();
        const identity = sphere.identity;

        if (identity?.nametag) {
          console.log(`\nYour nametag: @${identity.nametag}`);
        } else {
          console.log('\nNo nametag registered.');
          console.log('Register one with: npm run cli -- nametag <name>');
        }

        await closeSphere();
        break;
      }

      case 'nametag-sync': {
        // Force re-publish nametag binding with chainPubkey
        // Useful for legacy nametags that were registered without chainPubkey
        const sphere = await getSphere();
        const identity = sphere.identity;

        if (!identity?.nametag) {
          console.error('\nNo nametag to sync.');
          console.error('Register one first with: npm run cli -- nametag <name>');
          process.exit(1);
        }

        console.log(`\nRe-publishing nametag @${identity.nametag} with chainPubkey...`);

        // Get transport provider and force re-publish
        const transport = (sphere as unknown as { _transport?: { publishIdentityBinding?: (ck: string, l1: string, da: string, nt: string) => Promise<boolean> } })._transport;
        if (!transport?.publishIdentityBinding) {
          console.error('Transport provider does not support identity binding');
          process.exit(1);
        }

        try {
          const success = await transport.publishIdentityBinding(
            identity.chainPubkey,
            identity.l1Address,
            identity.directAddress || '',
            identity.nametag,
          );

          if (success) {
            console.log(`\n✓ Nametag @${identity.nametag} synced successfully!`);
            console.log(`  chainPubkey: ${identity.chainPubkey.slice(0, 16)}...`);
          } else {
            console.error('\n✗ Nametag sync failed. The nametag may be taken by another pubkey.');
            process.exit(1);
          }
        } catch (err) {
          console.error('\n✗ Sync failed:', err instanceof Error ? err.message : err);
          process.exit(1);
        }

        await closeSphere();
        break;
      }

      // === ENCRYPTION ===
      case 'encrypt': {
        const [, data, password] = args;
        if (!data || !password) {
          console.error('Usage: encrypt <data> <password>');
          process.exit(1);
        }
        const result = encrypt(data, password);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'decrypt': {
        const [, encrypted, password] = args;
        if (!encrypted || !password) {
          console.error('Usage: decrypt <encrypted-json> <password>');
          process.exit(1);
        }
        const encryptedData = JSON.parse(encrypted);
        const result = decrypt(encryptedData, password);
        console.log(result);
        break;
      }

      // === WALLET PARSING ===
      case 'parse-wallet': {
        const [, filePath, password] = args;
        if (!filePath) {
          console.error('Usage: parse-wallet <file> [password]');
          process.exit(1);
        }

        if (!fs.existsSync(filePath)) {
          console.error('File not found:', filePath);
          process.exit(1);
        }

        if (filePath.endsWith('.dat')) {
          const data = fs.readFileSync(filePath);
          if (!isSQLiteDatabase(data)) {
            console.error('Not a valid wallet.dat (SQLite) file');
            process.exit(1);
          }
          const result = parseWalletDat(data);
          console.log(JSON.stringify(result, null, 2));
        } else {
          const content = fs.readFileSync(filePath, 'utf8');
          const isEncrypted = isTextWalletEncrypted(content);

          if (isEncrypted && !password) {
            console.log('Wallet is encrypted. Provide password: parse-wallet <file> <password>');
            process.exit(0);
          }

          const result = password
            ? parseAndDecryptWalletText(content, password)
            : parseWalletText(content);
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }

      case 'wallet-info': {
        const [, filePath] = args;
        if (!filePath) {
          console.error('Usage: wallet-info <file>');
          process.exit(1);
        }

        if (!fs.existsSync(filePath)) {
          console.error('File not found:', filePath);
          process.exit(1);
        }

        const info: Record<string, unknown> = { file: filePath };

        if (filePath.endsWith('.dat')) {
          const data = fs.readFileSync(filePath);
          info.format = 'dat';
          info.isSQLite = isSQLiteDatabase(data);
          info.isEncrypted = isWalletDatEncrypted(data);
        } else if (filePath.endsWith('.txt')) {
          const content = fs.readFileSync(filePath, 'utf8');
          info.format = 'txt';
          info.isEncrypted = isTextWalletEncrypted(content);
        } else if (filePath.endsWith('.json')) {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          info.format = 'json';
          info.isEncrypted = !!content.encrypted;
          info.hasChainCode = !!content.chainCode;
        }

        console.log(JSON.stringify(info, null, 2));
        break;
      }

      // === KEY OPERATIONS ===
      case 'generate-key': {
        const privateKey = generatePrivateKey();
        const publicKey = getPublicKey(privateKey);
        const wif = hexToWIF(privateKey);
        const addressInfo = generateAddressFromMasterKey(privateKey, 0);

        console.log(JSON.stringify({
          privateKey,
          publicKey,
          wif,
          address: addressInfo.address,
        }, null, 2));
        break;
      }

      case 'validate-key': {
        const [, hex] = args;
        if (!hex) {
          console.error('Usage: validate-key <hex>');
          process.exit(1);
        }
        const valid = isValidPrivateKey(hex);
        console.log(JSON.stringify({ valid, length: hex.length }));
        process.exit(valid ? 0 : 1);
        break;
      }

      case 'hex-to-wif': {
        const [, hex] = args;
        if (!hex) {
          console.error('Usage: hex-to-wif <hex>');
          process.exit(1);
        }
        console.log(hexToWIF(hex));
        break;
      }

      case 'derive-pubkey': {
        const [, privateKey] = args;
        if (!privateKey) {
          console.error('Usage: derive-pubkey <private-key-hex>');
          process.exit(1);
        }
        const publicKey = getPublicKey(privateKey);
        console.log(publicKey);
        break;
      }

      case 'derive-address': {
        const [, privateKey, index = '0'] = args;
        if (!privateKey) {
          console.error('Usage: derive-address <private-key-hex> [index]');
          console.error('Index: address derivation index (default: 0)');
          process.exit(1);
        }
        const addressInfo = generateAddressFromMasterKey(privateKey, parseInt(index));
        console.log(addressInfo.address);
        break;
      }

      // === CURRENCY ===
      case 'to-smallest': {
        const [, amount] = args;
        if (!amount) {
          console.error('Usage: to-smallest <amount> <coin>');
          process.exit(1);
        }
        const coinArgSmallest: string | undefined = (args[2] && !args[2].startsWith('--')) ? args[2] : undefined;
        let decimalsSmallest = 8;
        if (coinArgSmallest) {
          await getSphere();
          decimalsSmallest = resolveCoin(coinArgSmallest).decimals;
          await closeSphere();
        }
        console.log(toSmallestUnit(amount, decimalsSmallest));
        break;
      }

      case 'to-human': {
        const [, amount] = args;
        if (!amount) {
          console.error('Usage: to-human <amount> <coin>');
          process.exit(1);
        }
        const coinArgHuman: string | undefined = (args[2] && !args[2].startsWith('--')) ? args[2] : undefined;
        let decimalsHuman = 8;
        if (coinArgHuman) {
          await getSphere();
          decimalsHuman = resolveCoin(coinArgHuman).decimals;
          await closeSphere();
        }
        console.log(toHumanReadable(amount, decimalsHuman));
        break;
      }

      case 'format': {
        const [, amount, decimals = '8'] = args;
        if (!amount) {
          console.error('Usage: format <amount> [decimals]');
          process.exit(1);
        }
        console.log(formatAmount(amount, { decimals: parseInt(decimals) }));
        break;
      }

      // === ENCODING ===
      case 'base58-encode': {
        const [, hex] = args;
        if (!hex) {
          console.error('Usage: base58-encode <hex>');
          process.exit(1);
        }
        console.log(base58Encode(hex));
        break;
      }

      case 'base58-decode': {
        const [, str] = args;
        if (!str) {
          console.error('Usage: base58-decode <string>');
          process.exit(1);
        }
        const bytes = base58Decode(str);
        console.log(Buffer.from(bytes).toString('hex'));
        break;
      }

      // === FAUCET / TOPUP ===
      case 'topup':
      case 'top-up':
      case 'faucet': {
        // Get nametag from wallet
        const sphere = await getSphere();
        const nametag = sphere.getNametag();
        if (!nametag) {
          console.error('Error: No nametag registered. Use "nametag <name>" first.');
          await closeSphere();
          process.exit(1);
        }

        // Parse options: topup [<amount> <coin>]
        const amountArg: string | undefined = args[1];
        const coinArg: string | undefined = args[2];

        const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';

        // Default amounts for all coins
        const DEFAULT_COINS: Record<string, number> = {
          'unicity': 100,
          'bitcoin': 1,
          'ethereum': 42,
          'solana': 1000,
          'tether': 1000,
          'usd-coin': 1000,
          'unicity-usd': 1000,
        };

        async function requestFaucet(coin: string, amount: number): Promise<{ success: boolean; message?: string }> {
          try {
            const response = await fetch(FAUCET_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                unicityId: nametag,  // Without @ prefix - faucet API expects raw nametag
                coin,
                amount,
              }),
            });
            const result = await response.json() as { success: boolean; message?: string; error?: string };
            // API returns 'error' field on failure, normalize to 'message'
            return {
              success: result.success,
              message: result.message || result.error,
            };
          } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : 'Request failed' };
          }
        }

        if (coinArg) {
          // Request specific coin — accept symbols (UCT, BTC) as well as faucet names (unicity, bitcoin)
          const coin = FAUCET_COIN_MAP[coinArg.toUpperCase()] || coinArg.toLowerCase();
          const amount = amountArg ? parseFloat(amountArg) : (DEFAULT_COINS[coin] || 1);

          console.log(`Requesting ${amount} ${coin} from faucet for @${nametag}...`);
          const result = await requestFaucet(coin, amount);

          if (result.success) {
            console.log(`\n✓ Received ${amount} ${coin}`);
          } else {
            console.error(`\n✗ Failed: ${result.message || 'Unknown error'}`);
          }
        } else {
          // Request all coins
          console.log(`Requesting all test tokens for @${nametag}...`);
          console.log('─'.repeat(50));

          const results = await Promise.all(
            Object.entries(DEFAULT_COINS).map(async ([coin, amount]) => {
              const result = await requestFaucet(coin, amount);
              return { coin, amount, ...result };
            })
          );

          for (const result of results) {
            if (result.success) {
              console.log(`✓ ${result.coin}: ${result.amount}`);
            } else {
              console.log(`✗ ${result.coin}: Failed - ${result.message || 'Unknown error'}`);
            }
          }

          console.log('─'.repeat(50));
          console.log('TopUp complete! Run "balance" to see updated balances.');
        }

        await closeSphere();
        break;
      }

      // === MESSAGING (Direct Messages) ===
      case 'dm': {
        const [, recipient, ...messageParts] = args;
        // Collect message: everything after recipient that isn't a flag
        const message = messageParts.filter(p => !p.startsWith('--')).join(' ');
        if (!recipient || !message) {
          console.error('Usage: dm <@nametag|pubkey> <message>');
          console.error('  Example: npm run cli -- dm @alice "Hello!"');
          process.exit(1);
        }

        const sphere = await getSphere();
        const dm = await sphere.communications.sendDM(recipient, message);
        console.log(`\n✓ Message sent to ${recipient}`);
        console.log(`  ID: ${dm.id}`);
        console.log(`  Time: ${new Date(dm.timestamp).toLocaleString()}`);
        await closeSphere();
        break;
      }

      case 'dm-inbox': {
        const sphere = await getSphere();
        const conversations = sphere.communications.getConversations();
        const totalUnread = sphere.communications.getUnreadCount();

        console.log(`\nInbox (${conversations.size} conversation${conversations.size !== 1 ? 's' : ''}, ${totalUnread} unread):`);
        console.log('─'.repeat(60));

        if (conversations.size === 0) {
          console.log('No conversations found.');
        } else {
          for (const [peerPubkey, messages] of conversations) {
            const unread = sphere.communications.getUnreadCount(peerPubkey);
            const lastMsg = messages[messages.length - 1];
            const time = new Date(lastMsg.timestamp).toLocaleString();
            const peerLabel = lastMsg.senderPubkey === peerPubkey
              ? (lastMsg.senderNametag ? `@${lastMsg.senderNametag}` : peerPubkey.slice(0, 16) + '...')
              : peerPubkey.slice(0, 16) + '...';
            const unreadBadge = unread > 0 ? ` [${unread} unread]` : '';
            const preview = lastMsg.content.length > 60
              ? lastMsg.content.slice(0, 60) + '...'
              : lastMsg.content;

            console.log(`${peerLabel}${unreadBadge}`);
            console.log(`  Last: ${preview}`);
            console.log(`  Time: ${time}`);
            console.log('');
          }
        }
        console.log('─'.repeat(60));
        await closeSphere();
        break;
      }

      case 'dm-history': {
        const [, peer] = args;
        if (!peer) {
          console.error('Usage: dm-history <@nametag|pubkey> [--limit <n>]');
          console.error('  Example: npm run cli -- dm-history @alice --limit 20');
          process.exit(1);
        }

        const limitIndex = args.indexOf('--limit');
        const limit = limitIndex !== -1 && args[limitIndex + 1] ? parseInt(args[limitIndex + 1]) : 50;

        const sphere = await getSphere();

        // Resolve @nametag to pubkey if needed
        let peerPubkey = peer;
        if (peer.startsWith('@')) {
          const resolved = await sphere.resolve(peer);
          if (!resolved) {
            console.error(`Could not resolve ${peer}`);
            process.exit(1);
          }
          peerPubkey = resolved.chainPubkey;
        }

        const messages = sphere.communications.getConversation(peerPubkey);
        const limited = messages.slice(-limit);
        const myPubkey = sphere.identity?.chainPubkey;

        console.log(`\nConversation with ${peer} (${limited.length} message${limited.length !== 1 ? 's' : ''}):`);
        console.log('─'.repeat(60));

        if (limited.length === 0) {
          console.log('No messages found.');
        } else {
          for (const msg of limited) {
            const time = new Date(msg.timestamp).toLocaleString();
            const isMe = msg.senderPubkey === myPubkey;
            const sender = isMe ? 'You' : (msg.senderNametag ? `@${msg.senderNametag}` : msg.senderPubkey.slice(0, 12) + '...');
            console.log(`[${time}] ${sender}: ${msg.content}`);
          }
        }
        console.log('─'.repeat(60));
        await closeSphere();
        break;
      }

      // === GROUP CHAT (NIP-29) ===
      case 'group-create': {
        const groupName = args[1];
        if (!groupName) {
          console.error('Usage: group-create <name> [--description <text>] [--private]');
          console.error('  Example: npm run cli -- group-create "Trading Chat" --description "Discuss trades"');
          process.exit(1);
        }

        const descIndex = args.indexOf('--description');
        const description = descIndex !== -1 && args[descIndex + 1] ? args[descIndex + 1] : undefined;
        const isPrivate = args.includes('--private');

        const sphere = await getSphere();

        if (!sphere.groupChat) {
          console.error('Group chat module not available.');
          process.exit(1);
        }

        await sphere.groupChat.connect();
        const group = await sphere.groupChat.createGroup({
          name: groupName,
          description,
          visibility: isPrivate ? 'PRIVATE' : 'PUBLIC',
        });

        if (group) {
          console.log('\n✓ Group created!');
          console.log(`  ID: ${group.id}`);
          console.log(`  Name: ${group.name}`);
          console.log(`  Visibility: ${group.visibility}`);
          if (group.description) console.log(`  Description: ${group.description}`);
        } else {
          console.error('\n✗ Failed to create group.');
        }

        await closeSphere();
        break;
      }

      case 'group-list': {
        const sphere = await getSphere();

        if (!sphere.groupChat) {
          console.error('Group chat module not available.');
          process.exit(1);
        }

        await sphere.groupChat.connect();
        const groups = await sphere.groupChat.fetchAvailableGroups();

        console.log(`\nAvailable Groups (${groups.length}):`);
        console.log('─'.repeat(60));

        if (groups.length === 0) {
          console.log('No groups found on relay.');
        } else {
          for (const group of groups) {
            console.log(`${group.name} [${group.visibility}]`);
            console.log(`  ID: ${group.id}`);
            if (group.description) console.log(`  Description: ${group.description}`);
            if (group.memberCount != null) console.log(`  Members: ${group.memberCount}`);
            console.log('');
          }
        }
        console.log('─'.repeat(60));
        await closeSphere();
        break;
      }

      case 'group-my': {
        const sphere = await getSphere();

        if (!sphere.groupChat) {
          console.error('Group chat module not available.');
          process.exit(1);
        }

        await sphere.groupChat.connect();
        const groups = sphere.groupChat.getGroups();

        console.log(`\nYour Groups (${groups.length}):`);
        console.log('─'.repeat(60));

        if (groups.length === 0) {
          console.log('You have not joined any groups.');
        } else {
          for (const group of groups) {
            const unreadBadge = (group.unreadCount || 0) > 0 ? ` [${group.unreadCount} unread]` : '';
            console.log(`${group.name}${unreadBadge}`);
            console.log(`  ID: ${group.id}`);
            if (group.lastMessageText) {
              const preview = group.lastMessageText.length > 60
                ? group.lastMessageText.slice(0, 60) + '...'
                : group.lastMessageText;
              console.log(`  Last: ${preview}`);
            }
            console.log('');
          }
        }
        console.log('─'.repeat(60));
        await closeSphere();
        break;
      }

      case 'group-join': {
        const groupId = args[1];
        if (!groupId) {
          console.error('Usage: group-join <groupId> [--invite <code>]');
          console.error('  Example: npm run cli -- group-join tradingchat');
          process.exit(1);
        }

        const inviteIndex = args.indexOf('--invite');
        const inviteCode = inviteIndex !== -1 && args[inviteIndex + 1] ? args[inviteIndex + 1] : undefined;

        const sphere = await getSphere();

        if (!sphere.groupChat) {
          console.error('Group chat module not available.');
          process.exit(1);
        }

        await sphere.groupChat.connect();
        const success = await sphere.groupChat.joinGroup(groupId, inviteCode);

        if (success) {
          console.log(`\n✓ Joined group: ${groupId}`);
        } else {
          console.error(`\n✗ Failed to join group: ${groupId}`);
        }

        await closeSphere();
        break;
      }

      case 'group-leave': {
        const groupId = args[1];
        if (!groupId) {
          console.error('Usage: group-leave <groupId>');
          console.error('  Example: npm run cli -- group-leave tradingchat');
          process.exit(1);
        }

        const sphere = await getSphere();

        if (!sphere.groupChat) {
          console.error('Group chat module not available.');
          process.exit(1);
        }

        await sphere.groupChat.connect();
        const success = await sphere.groupChat.leaveGroup(groupId);

        if (success) {
          console.log(`\n✓ Left group: ${groupId}`);
        } else {
          console.error(`\n✗ Failed to leave group: ${groupId}`);
        }

        await closeSphere();
        break;
      }

      case 'group-send': {
        const groupId = args[1];
        // Collect message: everything after groupId that isn't a flag or flag value
        const msgParts: string[] = [];
        let skipNext = false;
        for (let i = 2; i < args.length; i++) {
          if (skipNext) { skipNext = false; continue; }
          if (args[i] === '--reply') { skipNext = true; continue; }
          if (args[i].startsWith('--')) continue;
          msgParts.push(args[i]);
        }
        const msgContent = msgParts.join(' ');

        if (!groupId || !msgContent) {
          console.error('Usage: group-send <groupId> <message> [--reply <eventId>]');
          console.error('  Example: npm run cli -- group-send tradingchat "Hello everyone!"');
          process.exit(1);
        }

        const replyIndex = args.indexOf('--reply');
        const replyToId = replyIndex !== -1 && args[replyIndex + 1] ? args[replyIndex + 1] : undefined;

        const sphere = await getSphere();

        if (!sphere.groupChat) {
          console.error('Group chat module not available.');
          process.exit(1);
        }

        await sphere.groupChat.connect();
        const sent = await sphere.groupChat.sendMessage(groupId, msgContent, replyToId);

        if (sent) {
          console.log('\n✓ Message sent!');
          console.log(`  ID: ${sent.id}`);
          console.log(`  Group: ${groupId}`);
        } else {
          console.error('\n✗ Failed to send message.');
        }

        await closeSphere();
        break;
      }

      case 'group-messages': {
        const groupId = args[1];
        if (!groupId) {
          console.error('Usage: group-messages <groupId> [--limit <n>]');
          console.error('  Example: npm run cli -- group-messages tradingchat --limit 20');
          process.exit(1);
        }

        const limitIndex = args.indexOf('--limit');
        const limit = limitIndex !== -1 && args[limitIndex + 1] ? parseInt(args[limitIndex + 1]) : 50;

        const sphere = await getSphere();

        if (!sphere.groupChat) {
          console.error('Group chat module not available.');
          process.exit(1);
        }

        await sphere.groupChat.connect();

        // Fetch latest from relay
        await sphere.groupChat.fetchMessages(groupId, undefined, limit);

        // Get from local state (sorted)
        const messages = sphere.groupChat.getMessages(groupId).slice(-limit);

        const group = sphere.groupChat.getGroup(groupId);
        const groupLabel = group?.name || groupId;

        console.log(`\nMessages in "${groupLabel}" (${messages.length}):`);
        console.log('─'.repeat(60));

        if (messages.length === 0) {
          console.log('No messages found.');
        } else {
          for (const msg of messages) {
            const time = new Date(msg.timestamp).toLocaleString();
            const sender = msg.senderNametag ? `@${msg.senderNametag}` : msg.senderPubkey.slice(0, 12) + '...';
            const replyTag = msg.replyToId ? ` (reply)` : '';
            console.log(`[${time}] ${sender}${replyTag}: ${msg.content}`);
          }
        }
        console.log('─'.repeat(60));

        // Mark as read
        sphere.groupChat.markGroupAsRead(groupId);
        await closeSphere();
        break;
      }

      case 'group-members': {
        const groupId = args[1];
        if (!groupId) {
          console.error('Usage: group-members <groupId>');
          console.error('  Example: npm run cli -- group-members tradingchat');
          process.exit(1);
        }

        const sphere = await getSphere();

        if (!sphere.groupChat) {
          console.error('Group chat module not available.');
          process.exit(1);
        }

        await sphere.groupChat.connect();
        const members = sphere.groupChat.getMembers(groupId);
        const group = sphere.groupChat.getGroup(groupId);
        const groupLabel = group?.name || groupId;

        console.log(`\nMembers of "${groupLabel}" (${members.length}):`);
        console.log('─'.repeat(60));

        if (members.length === 0) {
          console.log('No members found. Try joining the group first.');
        } else {
          for (const member of members) {
            const label = member.nametag ? `@${member.nametag}` : member.pubkey.slice(0, 16) + '...';
            const roleBadge = member.role === 'ADMIN' ? ' [ADMIN]' : member.role === 'MODERATOR' ? ' [MOD]' : '';
            const joined = new Date(member.joinedAt).toLocaleDateString();
            console.log(`  ${label}${roleBadge}  (joined ${joined})`);
          }
        }
        console.log('─'.repeat(60));
        await closeSphere();
        break;
      }

      case 'group-info': {
        const groupId = args[1];
        if (!groupId) {
          console.error('Usage: group-info <groupId>');
          console.error('  Example: npm run cli -- group-info tradingchat');
          process.exit(1);
        }

        const sphere = await getSphere();

        if (!sphere.groupChat) {
          console.error('Group chat module not available.');
          process.exit(1);
        }

        await sphere.groupChat.connect();
        const group = sphere.groupChat.getGroup(groupId);

        if (!group) {
          console.error(`Group "${groupId}" not found. You may need to join it first.`);
          process.exit(1);
        }

        const myRole = sphere.groupChat.getCurrentUserRole(groupId);
        const members = sphere.groupChat.getMembers(groupId);

        console.log('\nGroup Info:');
        console.log('─'.repeat(50));
        console.log(`ID:          ${group.id}`);
        console.log(`Name:        ${group.name}`);
        console.log(`Visibility:  ${group.visibility}`);
        if (group.description) console.log(`Description: ${group.description}`);
        console.log(`Members:     ${members.length}`);
        console.log(`Created:     ${new Date(group.createdAt).toLocaleString()}`);
        if (group.lastMessageTime) console.log(`Last Active: ${new Date(group.lastMessageTime).toLocaleString()}`);
        if (myRole) console.log(`Your Role:   ${myRole}`);
        console.log(`Relay:       ${group.relayUrl}`);
        console.log('─'.repeat(50));
        await closeSphere();
        break;
      }

      // === MARKET (Intent Bulletin Board) ===
      case 'market-post': {
        const description = args[1];
        if (!description) {
          console.error('Usage: market-post <description> --type <type> [--category <cat>] [--price <n>] [--currency <code>] [--location <loc>] [--contact <handle>] [--expires <days>]');
          process.exit(1);
        }

        const typeIndex = args.indexOf('--type');
        const intentType = typeIndex !== -1 ? args[typeIndex + 1] : undefined;
        if (!intentType) {
          console.error('Error: --type <type> is required (buy, sell, service, announcement, other)');
          process.exit(1);
        }

        const categoryIndex = args.indexOf('--category');
        const category = categoryIndex !== -1 ? args[categoryIndex + 1] : undefined;

        const priceIndex = args.indexOf('--price');
        const price = priceIndex !== -1 ? parseFloat(args[priceIndex + 1]) : undefined;

        const currencyIndex = args.indexOf('--currency');
        const currency = currencyIndex !== -1 ? args[currencyIndex + 1] : undefined;

        const locationIndex = args.indexOf('--location');
        const location = locationIndex !== -1 ? args[locationIndex + 1] : undefined;

        const contactIndex = args.indexOf('--contact');
        const contactHandle = contactIndex !== -1 ? args[contactIndex + 1] : undefined;

        const expiresIndex = args.indexOf('--expires');
        const expiresInDays = expiresIndex !== -1 ? parseInt(args[expiresIndex + 1]) : undefined;

        const sphere = await getSphere();

        if (!sphere.market) {
          console.error('Market module not available.');
          process.exit(1);
        }

        const result = await sphere.market.postIntent({
          description,
          intentType,
          category,
          price,
          currency,
          location,
          contactHandle,
          expiresInDays,
        });

        console.log('✓ Intent posted!');
        console.log(`  ID: ${result.intentId}`);
        console.log(`  Expires: ${result.expiresAt}`);

        await closeSphere();
        break;
      }

      case 'market-search': {
        const query = args[1];
        if (!query) {
          console.error('Usage: market-search <query> [--type <type>] [--category <cat>] [--min-price <n>] [--max-price <n>] [--min-score <0-1>] [--location <loc>] [--limit <n>]');
          process.exit(1);
        }

        const typeIndex = args.indexOf('--type');
        const intentType = typeIndex !== -1 ? args[typeIndex + 1] : undefined;

        const categoryIndex = args.indexOf('--category');
        const category = categoryIndex !== -1 ? args[categoryIndex + 1] : undefined;

        const minPriceIndex = args.indexOf('--min-price');
        const minPrice = minPriceIndex !== -1 ? parseFloat(args[minPriceIndex + 1]) : undefined;

        const maxPriceIndex = args.indexOf('--max-price');
        const maxPrice = maxPriceIndex !== -1 ? parseFloat(args[maxPriceIndex + 1]) : undefined;

        const minScoreIndex = args.indexOf('--min-score');
        const minScore = minScoreIndex !== -1 ? parseFloat(args[minScoreIndex + 1]) : undefined;

        const locationIndex = args.indexOf('--location');
        const location = locationIndex !== -1 ? args[locationIndex + 1] : undefined;

        const limitIndex = args.indexOf('--limit');
        const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : 10;

        const sphere = await getSphere();

        if (!sphere.market) {
          console.error('Market module not available.');
          process.exit(1);
        }

        const result = await sphere.market.search(query, {
          filters: {
            intentType,
            category,
            minPrice,
            maxPrice,
            minScore,
            location,
          },
          limit,
        });

        console.log(`Found ${result.count} intent(s):`);
        console.log('─'.repeat(50));

        for (const intent of result.intents) {
          const scoreStr = intent.score != null ? `[${intent.score.toFixed(2)}] ` : '';
          console.log(`${scoreStr}${intent.description}`);
          const byStr = intent.agentNametag ? `@${intent.agentNametag}` : intent.agentPublicKey.slice(0, 12) + '...';
          console.log(`  By: ${byStr}`);
          let details = `  Type: ${intent.intentType}`;
          if (intent.category) details += ` | Category: ${intent.category}`;
          if (intent.price != null) details += ` | Price: ${intent.price} ${intent.currency || ''}`;
          console.log(details);
          let extra = '';
          if (intent.contactHandle) extra += `  Contact: ${intent.contactHandle}`;
          if (intent.expiresAt) extra += `${extra ? ' | ' : '  '}Expires: ${intent.expiresAt.split('T')[0]}`;
          if (extra) console.log(extra);
          console.log('─'.repeat(50));
        }

        await closeSphere();
        break;
      }

      case 'market-my': {
        const sphere = await getSphere();

        if (!sphere.market) {
          console.error('Market module not available.');
          process.exit(1);
        }

        const intents = await sphere.market.getMyIntents();

        console.log(`Your intents (${intents.length}):`);
        for (const intent of intents) {
          const desc = intent.id;
          const cat = intent.category || '';
          const expires = intent.expiresAt ? intent.expiresAt.split('T')[0] : '';
          console.log(`  ${desc}  ${intent.intentType}  ${intent.status}  ${cat}  expires ${expires}`);
        }

        await closeSphere();
        break;
      }

      case 'market-close': {
        const intentId = args[1];
        if (!intentId) {
          console.error('Usage: market-close <intentId>');
          process.exit(1);
        }

        const sphere = await getSphere();

        if (!sphere.market) {
          console.error('Market module not available.');
          process.exit(1);
        }

        await sphere.market.closeIntent(intentId);
        console.log(`✓ Intent ${intentId} closed.`);

        await closeSphere();
        break;
      }

      case 'market-feed': {
        const useRest = args.includes('--rest');
        const sphere = await getSphere();

        if (!sphere.market) {
          console.error('Market module not available.');
          process.exit(1);
        }

        if (useRest) {
          // REST fallback: fetch recent listings once
          const listings = await sphere.market.getRecentListings();
          console.log(`Recent listings (${listings.length}):`);
          console.log('─'.repeat(50));
          for (const listing of listings) {
            console.log(`[${listing.type.toUpperCase()}] ${listing.agentName}: ${listing.title}`);
            if (listing.descriptionPreview !== listing.title) {
              console.log(`  ${listing.descriptionPreview}`);
            }
            console.log(`  ID: ${listing.id}  Posted: ${listing.createdAt}`);
            console.log('');
          }
          await closeSphere();
        } else {
          // WebSocket live feed
          console.log('Connecting to live feed... (Ctrl+C to stop)');
          const unsubscribe = sphere.market.subscribeFeed((message) => {
            if (message.type === 'initial') {
              console.log(`Connected — ${message.listings.length} recent listing(s):`);
              console.log('─'.repeat(50));
              for (const listing of message.listings) {
                console.log(`[${listing.type.toUpperCase()}] ${listing.agentName}: ${listing.title}`);
              }
              console.log('─'.repeat(50));
              console.log('Watching for new listings...\n');
            } else {
              const l = message.listing;
              console.log(`[NEW] [${l.type.toUpperCase()}] ${l.agentName}: ${l.title}`);
              if (l.descriptionPreview !== l.title) {
                console.log(`  ${l.descriptionPreview}`);
              }
            }
          });

          // Keep alive until Ctrl+C
          process.on('SIGINT', () => {
            console.log('\nDisconnecting...');
            unsubscribe();
            closeSphere().then(() => process.exit(0));
          });

          // Prevent the process from exiting
          await new Promise(() => {});
        }
        break;
      }

      // =================================================================
      // INVOICE MANAGEMENT (AccountingModule)
      // =================================================================

      case 'invoice-create': {
        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled. Initialize with accounting support.');
          process.exit(1);
        }

        // Parse options
        const targetIdx = args.indexOf('--target');
        const assetIdx = args.indexOf('--asset');
        const nftIdx = args.indexOf('--nft');
        const dueIdx = args.indexOf('--due');
        const memoIdx = args.indexOf('--memo');
        const deliveryIdx = args.indexOf('--delivery');
        const termsIdx = args.indexOf('--terms');

        if (termsIdx !== -1 && args[termsIdx + 1]) {
          // Load terms from JSON file
          const termsFile = args[termsIdx + 1];
          let termsJson: unknown;
          try {
            const resolvedPath = path.resolve(termsFile);
            const raw = fs.readFileSync(resolvedPath, 'utf8');
            termsJson = JSON.parse(raw);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Sanitize: only show whether it was a file read or JSON parse error
            if (msg.includes('ENOENT')) {
              console.error(`File not found: "${termsFile}"`);
            } else if (msg.includes('EACCES') || msg.includes('EPERM')) {
              console.error(`Access denied: "${termsFile}"`);
            } else if (msg.includes('Unexpected token') || msg.includes('JSON')) {
              console.error(`Invalid JSON in terms file "${termsFile}"`);
            } else {
              console.error(`Failed to read terms file "${termsFile}"`);
            }
            process.exit(1);
          }
          let result;
          try {
            result = await sphere.accounting.createInvoice(termsJson as import('../modules/accounting/types').CreateInvoiceRequest);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Failed to create invoice from terms file: ${msg}`);
            process.exit(1);
          }
          console.log('Invoice created:');
          console.log(JSON.stringify(result, null, 2));
        } else {
          // Build from individual options
          if (targetIdx === -1 || !args[targetIdx + 1]) {
            console.error('Usage: invoice-create --target <address> --asset "<amount> <coin>" [--nft <id>] [--due <ISO-date>] [--memo <text>] [--delivery <method>] [--terms <json-file>]');
            process.exit(1);
          }
          const targetAddress = args[targetIdx + 1];
          const nftId = nftIdx !== -1 ? args[nftIdx + 1] : undefined;
          const dueDate = dueIdx !== -1 ? new Date(args[dueIdx + 1]).getTime() : undefined;
          if (dueDate !== undefined && isNaN(dueDate)) {
            console.error('Invalid due date format. Use ISO-8601, e.g. 2026-12-31');
            process.exit(1);
          }
          const memo = memoIdx !== -1 ? args[memoIdx + 1] : undefined;
          const delivery = deliveryIdx !== -1 ? args[deliveryIdx + 1] : undefined;

          const assets: import('../modules/accounting/types').InvoiceRequestedAsset[] = [];
          if (assetIdx !== -1 && args[assetIdx + 1]) {
            const parsed = parseAssetArg(args[assetIdx + 1]);
            if (!/^[1-9][0-9]*$/.test(parsed.amount)) {
              console.error(`Invalid amount "${parsed.amount}" — must be a positive integer in smallest units (no decimals, no leading zeros)`);
              process.exit(1);
            }
            const { coinId: resolvedCoinId } = resolveCoin(parsed.coin);
            assets.push({ coin: [resolvedCoinId, parsed.amount] });
          } else if (nftId) {
            assets.push({ nft: { tokenId: nftId } });
          }

          const request: import('../modules/accounting/types').CreateInvoiceRequest = {
            targets: [{ address: targetAddress, assets }],
            dueDate,
            memo,
            deliveryMethods: delivery ? [delivery] : undefined,
          };
          const result = await sphere.accounting.createInvoice(request);
          console.log('Invoice created:');
          console.log(JSON.stringify(result, null, 2));
        }

        await closeSphere();
        break;
      }

      case 'invoice-import': {
        const tokenFile = args[1];
        if (!tokenFile) {
          console.error('Usage: invoice-import <token-file>');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        let tokenJson: unknown;
        try {
          tokenJson = JSON.parse(fs.readFileSync(path.resolve(tokenFile), 'utf8'));
        } catch (err: unknown) {
          // W23-R2 fix: Sanitize error messages to avoid leaking file system paths
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'ENOENT') {
            console.error(`Token file not found: "${tokenFile}"`);
          } else if (code === 'EACCES') {
            console.error(`Permission denied reading: "${tokenFile}"`);
          } else if (err instanceof SyntaxError) {
            console.error(`Invalid JSON in token file: "${tokenFile}"`);
          } else {
            console.error(`Failed to read token file: "${tokenFile}"`);
          }
          process.exit(1);
        }

        let terms;
        try {
          terms = await sphere.accounting.importInvoice(tokenJson as import('../types/txf').TxfToken);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Failed to import invoice: ${msg}`);
          process.exit(1);
        }
        console.log('Invoice imported:');
        console.log(JSON.stringify(terms, null, 2));

        await closeSphere();
        break;
      }

      case 'invoice-list': {
        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const stateIdx = args.indexOf('--state');
        const limitIdx2 = args.indexOf('--limit');
        const createdByMe = args.includes('--role') && args[args.indexOf('--role') + 1] === 'creator';
        const targetingMe = args.includes('--role') && args[args.indexOf('--role') + 1] === 'payer';
        const stateFilter = stateIdx !== -1 ? args[stateIdx + 1] : undefined;

        const validStates = new Set(['OPEN', 'PARTIAL', 'COVERED', 'CLOSED', 'CANCELLED', 'EXPIRED']);
        const options: import('../modules/accounting/types').GetInvoicesOptions = {};
        if (createdByMe) options.createdByMe = true;
        if (targetingMe) options.targetingMe = true;
        if (stateFilter) {
          const stateValues = stateFilter.split(',').map(s => s.trim());
          const invalid = stateValues.filter(s => !validStates.has(s));
          if (invalid.length > 0) {
            console.error(`Invalid state(s): ${invalid.join(', ')}. Valid: ${[...validStates].join(', ')}`);
            process.exit(1);
          }
          options.state = stateValues.length === 1 ? stateValues[0] as any : stateValues as any;
        }
        if (limitIdx2 !== -1 && args[limitIdx2 + 1]) {
          const limit = parseInt(args[limitIdx2 + 1], 10);
          if (!Number.isNaN(limit) && limit > 0) {
            options.limit = limit;
          }
        }

        const invoices = await sphere.accounting.getInvoices(options);

        if (invoices.length === 0) {
          console.log('No invoices found.');
        } else {
          console.log(`Invoices (${invoices.length}):`);
          console.log('─'.repeat(60));
          for (const inv of invoices) {
            console.log(`ID:        ${inv.invoiceId}`);
            console.log(`Creator:   ${inv.isCreator ? 'yes' : 'no'}`);
            console.log(`Cancelled: ${inv.cancelled}`);
            console.log(`Closed:    ${inv.closed}`);
            if (inv.terms.dueDate) console.log(`Due:       ${new Date(inv.terms.dueDate).toISOString()}`);
            if (inv.terms.memo) console.log(`Memo:      ${inv.terms.memo}`);
            console.log('─'.repeat(60));
          }
        }

        await closeSphere();
        break;
      }

      case 'invoice-status': {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          console.error('Usage: invoice-status <id-or-prefix>');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        // Resolve ID from prefix
        const allInvoices = await sphere.accounting.getInvoices();
        const matched = allInvoices.filter(inv => inv.invoiceId.startsWith(idOrPrefix));
        if (matched.length === 0) {
          console.error(`No invoice found matching prefix: ${idOrPrefix}`);
          process.exit(1);
        }
        if (matched.length > 1) {
          console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} invoices. Use more characters.`);
          process.exit(1);
        }
        const invoiceId = matched[0].invoiceId;

        const status = await sphere.accounting.getInvoiceStatus(invoiceId);
        console.log('Invoice Status:');
        console.log(JSON.stringify(status, null, 2));

        await closeSphere();
        break;
      }

      case 'invoice-close': {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          console.error('Usage: invoice-close <id-or-prefix>');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const allInvoices = await sphere.accounting.getInvoices();
        const matched = allInvoices.filter(inv => inv.invoiceId.startsWith(idOrPrefix));
        if (matched.length === 0) {
          console.error(`No invoice found matching prefix: ${idOrPrefix}`);
          process.exit(1);
        }
        if (matched.length > 1) {
          console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} invoices.`);
          process.exit(1);
        }
        const invoiceId = matched[0].invoiceId;

        const autoReturn = args.includes('--auto-return');
        await sphere.accounting.closeInvoice(invoiceId, autoReturn ? { autoReturn: true } : undefined);
        console.log(`Invoice ${invoiceId} closed.${autoReturn ? ' Auto-return triggered.' : ''}`);

        await closeSphere();
        break;
      }

      case 'invoice-cancel': {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          console.error('Usage: invoice-cancel <id-or-prefix>');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const allInvoices = await sphere.accounting.getInvoices();
        const matched = allInvoices.filter(inv => inv.invoiceId.startsWith(idOrPrefix));
        if (matched.length === 0) {
          console.error(`No invoice found matching prefix: ${idOrPrefix}`);
          process.exit(1);
        }
        if (matched.length > 1) {
          console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} invoices.`);
          process.exit(1);
        }
        const invoiceId = matched[0].invoiceId;

        await sphere.accounting.cancelInvoice(invoiceId);
        console.log(`Invoice ${invoiceId} cancelled.`);

        await closeSphere();
        break;
      }

      case 'invoice-pay': {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          console.error('Usage: invoice-pay <id-or-prefix> [--amount <value>] [--target-index <n>]');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const allInvoices = await sphere.accounting.getInvoices();
        const matched = allInvoices.filter(inv => inv.invoiceId.startsWith(idOrPrefix));
        if (matched.length === 0) {
          console.error(`No invoice found matching prefix: ${idOrPrefix}`);
          process.exit(1);
        }
        if (matched.length > 1) {
          console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} invoices.`);
          process.exit(1);
        }
        const invoiceId = matched[0].invoiceId;

        const amountIdx2 = args.indexOf('--amount');
        const targetIndexIdx = args.indexOf('--target-index');

        const rawTargetIdx = targetIndexIdx !== -1 ? args[targetIndexIdx + 1] : undefined;
        const targetIndex = rawTargetIdx !== undefined ? parseInt(rawTargetIdx, 10) : 0;
        if (isNaN(targetIndex) || targetIndex < 0) {
          console.error('--target-index must be a non-negative integer');
          process.exit(1);
        }

        const payParams: import('../modules/accounting/types').PayInvoiceParams = {
          targetIndex,
        };
        if (amountIdx2 !== -1 && args[amountIdx2 + 1]) {
          const rawAmount = args[amountIdx2 + 1];
          if (!/^[1-9][0-9]*$/.test(rawAmount)) {
            console.error(`Invalid amount "${rawAmount}" — must be a positive integer in smallest units (no decimals, no leading zeros)`);
            process.exit(1);
          }
          payParams.amount = rawAmount;
        }

        const result = await sphere.accounting.payInvoice(invoiceId, payParams);
        console.log('Payment result:');
        console.log(JSON.stringify({ id: result.id, status: result.status }, null, 2));

        await closeSphere();
        break;
      }

      case 'invoice-return': {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          console.error('Usage: invoice-return <id-or-prefix> --recipient <address> --asset "<amount> <coin>"');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const allInvoices = await sphere.accounting.getInvoices();
        const matched = allInvoices.filter(inv => inv.invoiceId.startsWith(idOrPrefix));
        if (matched.length === 0) {
          console.error(`No invoice found matching prefix: ${idOrPrefix}`);
          process.exit(1);
        }
        if (matched.length > 1) {
          console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} invoices.`);
          process.exit(1);
        }
        const invoiceId = matched[0].invoiceId;

        const recipientIdx = args.indexOf('--recipient');
        const assetIdx3 = args.indexOf('--asset');

        if (recipientIdx === -1 || !args[recipientIdx + 1]) {
          console.error('--recipient <address> is required for invoice-return');
          process.exit(1);
        }

        let returnAmount: string;
        let returnCoinId: string;

        if (assetIdx3 !== -1 && args[assetIdx3 + 1]) {
          const parsed = parseAssetArg(args[assetIdx3 + 1]);
          returnAmount = parsed.amount;
          returnCoinId = resolveCoin(parsed.coin).coinId;
        } else {
          console.error('--asset "<amount> <coin>" is required for invoice-return');
          process.exit(1);
        }

        if (!/^[1-9][0-9]*$/.test(returnAmount)) {
          console.error(`Invalid amount "${returnAmount}" — must be a positive integer string (smallest unit, no leading zeros, e.g. 1000000)`);
          process.exit(1);
        }

        const returnParams: import('../modules/accounting/types').ReturnPaymentParams = {
          recipient: args[recipientIdx + 1],
          amount: returnAmount,
          coinId: returnCoinId,
        };

        const result = await sphere.accounting.returnInvoicePayment(invoiceId, returnParams);
        console.log('Return payment result:');
        console.log(JSON.stringify({ id: result.id, status: result.status }, null, 2));

        await closeSphere();
        break;
      }

      case 'invoice-receipts': {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          console.error('Usage: invoice-receipts <id-or-prefix>');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const allInvoices = await sphere.accounting.getInvoices();
        const matched = allInvoices.filter(inv => inv.invoiceId.startsWith(idOrPrefix));
        if (matched.length === 0) {
          console.error(`No invoice found matching prefix: ${idOrPrefix}`);
          process.exit(1);
        }
        if (matched.length > 1) {
          console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} invoices.`);
          process.exit(1);
        }
        const invoiceId = matched[0].invoiceId;

        const result = await sphere.accounting.sendInvoiceReceipts(invoiceId);
        console.log('Receipts result:');
        console.log(JSON.stringify(result, null, 2));

        await closeSphere();
        break;
      }

      case 'invoice-notices': {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          console.error('Usage: invoice-notices <id-or-prefix>');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const allInvoices = await sphere.accounting.getInvoices();
        const matched = allInvoices.filter(inv => inv.invoiceId.startsWith(idOrPrefix));
        if (matched.length === 0) {
          console.error(`No invoice found matching prefix: ${idOrPrefix}`);
          process.exit(1);
        }
        if (matched.length > 1) {
          console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} invoices.`);
          process.exit(1);
        }
        const invoiceId = matched[0].invoiceId;

        const result = await sphere.accounting.sendCancellationNotices(invoiceId);
        console.log('Cancellation notices result:');
        console.log(JSON.stringify(result, null, 2));

        await closeSphere();
        break;
      }

      case 'invoice-auto-return': {
        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const enableFlag = args.includes('--enable');
        const disableFlag = args.includes('--disable');
        const invoiceIdx = args.indexOf('--invoice');
        // W7-R17 fix: Validate --invoice has a following argument
        if (invoiceIdx !== -1 && !args[invoiceIdx + 1]) {
          console.error('--invoice requires an invoice ID');
          process.exit(1);
        }
        const specificInvoice = invoiceIdx !== -1 ? args[invoiceIdx + 1] : undefined;

        if (!enableFlag && !disableFlag) {
          // Show current settings
          const settings = sphere.accounting.getAutoReturnSettings();
          console.log('Auto-return settings:');
          console.log(JSON.stringify(settings, null, 2));
        } else if (enableFlag && disableFlag) {
          console.error('Cannot use both --enable and --disable');
          process.exit(1);
        } else {
          const enabled = enableFlag;
          const invoiceId = specificInvoice ?? '*';
          await sphere.accounting.setAutoReturn(invoiceId, enabled);
          const scope = invoiceId === '*' ? 'globally' : `for invoice ${invoiceId}`;
          console.log(`Auto-return ${enabled ? 'enabled' : 'disabled'} ${scope}.`);
        }

        await closeSphere();
        break;
      }

      case 'invoice-transfers': {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          console.error('Usage: invoice-transfers <id-or-prefix>');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const allInvoices = await sphere.accounting.getInvoices();
        const matched = allInvoices.filter(inv => inv.invoiceId.startsWith(idOrPrefix));
        if (matched.length === 0) {
          console.error(`No invoice found matching prefix: ${idOrPrefix}`);
          process.exit(1);
        }
        if (matched.length > 1) {
          console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} invoices.`);
          process.exit(1);
        }
        const invoiceId = matched[0].invoiceId;

        const transfers = sphere.accounting.getRelatedTransfers(invoiceId);
        if (transfers.length === 0) {
          console.log('No related transfers found.');
        } else {
          console.log(`Related transfers (${transfers.length}):`);
          console.log(JSON.stringify(transfers, null, 2));
        }

        await closeSphere();
        break;
      }

      case 'invoice-export': {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          console.error('Usage: invoice-export <id-or-prefix>');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const allInvoices = await sphere.accounting.getInvoices();
        const matched = allInvoices.filter(inv => inv.invoiceId.startsWith(idOrPrefix));
        if (matched.length === 0) {
          console.error(`No invoice found matching prefix: ${idOrPrefix}`);
          process.exit(1);
        }
        if (matched.length > 1) {
          console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} invoices.`);
          process.exit(1);
        }
        const invoiceId = matched[0].invoiceId;

        // Get the invoice ref via getInvoice
        const invoiceRef = sphere.accounting.getInvoice(invoiceId);
        if (!invoiceRef) {
          console.error(`Invoice ${invoiceId} not found in memory.`);
          process.exit(1);
        }

        const outFile = `invoice-${invoiceId.slice(0, 8)}.json`;
        fs.writeFileSync(outFile, JSON.stringify(invoiceRef, null, 2));
        console.log(`Invoice exported to: ${outFile}`);

        await closeSphere();
        break;
      }

      case 'invoice-parse-memo': {
        const memoStr = args[1];
        if (!memoStr) {
          console.error('Usage: invoice-parse-memo <memo-string>');
          process.exit(1);
        }

        const sphere = await getSphere();
        if (!sphere.accounting) {
          console.error('Accounting module not enabled.');
          process.exit(1);
        }

        const parsed = sphere.accounting.parseInvoiceMemo(memoStr);
        if (!parsed) {
          console.log('Not a valid invoice memo.');
        } else {
          console.log('Parsed invoice memo:');
          console.log(JSON.stringify(parsed, null, 2));
        }

        await closeSphere();
        break;
      }

      // =====================================================================
      // Swap Commands
      // =====================================================================

      case 'swap-propose': {
        const toIdx = args.indexOf('--to');
        const escrowIdx = args.indexOf('--escrow');
        const timeoutIdx = args.indexOf('--timeout');
        const messageIdx = args.indexOf('--message');

        // Combined format: --offer "<amount> <coin>" --want "<amount> <coin>"
        const offerIdx = args.indexOf('--offer');
        const wantIdx = args.indexOf('--want');

        if (toIdx === -1 || !args[toIdx + 1] ||
            offerIdx === -1 || !args[offerIdx + 1] || args[offerIdx + 1].startsWith('--') ||
            wantIdx === -1 || !args[wantIdx + 1] || args[wantIdx + 1].startsWith('--')) {
          console.error('Usage: swap-propose --to <recipient> --offer "<amount> <coin>" --want "<amount> <coin>" [--escrow <address>] [--timeout <seconds>] [--message <text>]');
          process.exit(1);
        }

        const offer = parseAssetArg(args[offerIdx + 1]);
        const want = parseAssetArg(args[wantIdx + 1]);
        const offerAmount = offer.amount;
        const offerCoinValue = offer.coin;
        const wantAmount = want.amount;
        const wantCoinValue = want.coin;
        if (!/^[1-9][0-9]*$/.test(offerAmount)) {
          console.error(`Invalid amount "${offerAmount}" — must be a positive integer in smallest units (no decimals, no leading zeros)`);
          process.exit(1);
        }
        if (!/^[1-9][0-9]*$/.test(wantAmount)) {
          console.error(`Invalid amount "${wantAmount}" — must be a positive integer in smallest units (no decimals, no leading zeros)`);
          process.exit(1);
        }

        let timeout = 3600;
        if (timeoutIdx !== -1 && args[timeoutIdx + 1]) {
          timeout = parseInt(args[timeoutIdx + 1], 10);
          if (isNaN(timeout) || timeout < 60 || timeout > 86400) {
            console.error('--timeout must be an integer between 60 and 86400 seconds');
            process.exit(1);
          }
        }

        const sphere = await getSphere();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const swapModule = (sphere as any).swap;
        if (!swapModule) {
          console.error('Swap module not enabled. Initialize with swap support.');
          process.exit(1);
        }

        const escrow = escrowIdx !== -1 ? args[escrowIdx + 1] : undefined;
        const message = messageIdx !== -1 ? args[messageIdx + 1] : undefined;

        const deal = {
          partyA: sphere.identity!.directAddress!,
          partyB: args[toIdx + 1],
          partyACurrency: offerCoinValue,
          partyAAmount: offerAmount,
          partyBCurrency: wantCoinValue,
          partyBAmount: wantAmount,
          timeout: timeout,
          escrowAddress: escrow,
        };

        const result = await swapModule.proposeSwap(deal, message ? { message } : undefined);
        console.log('Swap proposed:');
        console.log(JSON.stringify({
          swap_id: result.swapId,
          counterparty: args[toIdx + 1],
          offer: `${offerAmount} ${offerCoinValue}`,
          want: `${wantAmount} ${wantCoinValue}`,
          escrow: deal.escrowAddress ?? '(config default)',
          timeout: timeout,
          status: result.swap?.progress ?? 'proposed',
        }, null, 2));

        await closeSphere();
        break;
      }

      case 'swap-list': {
        const allFlag = args.includes('--all');
        const roleIdx = args.indexOf('--role');
        const progressIdx = args.indexOf('--progress');

        const sphere = await getSphere();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const swapModule = (sphere as any).swap;
        if (!swapModule) {
          console.error('Swap module not enabled.');
          process.exit(1);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filter: any = {};
        if (roleIdx !== -1 && args[roleIdx + 1]) {
          const role = args[roleIdx + 1];
          if (role !== 'proposer' && role !== 'acceptor') {
            console.error('--role must be "proposer" or "acceptor"');
            process.exit(1);
          }
          filter.role = role;
        }
        if (progressIdx !== -1 && args[progressIdx + 1]) {
          filter.progress = args[progressIdx + 1];
        }
        if (!allFlag && !filter.progress) {
          filter.excludeTerminal = true;
        }

        const swaps = await swapModule.getSwaps(filter);
        if (!swaps || swaps.length === 0) {
          console.log('No swaps found.');
        } else {
          const isTTY = process.stdout.isTTY;
          const green = isTTY ? '\x1b[32m' : '';
          const red = isTTY ? '\x1b[31m' : '';
          const yellow = isTTY ? '\x1b[33m' : '';
          const reset = isTTY ? '\x1b[0m' : '';

          const header = [
            'SWAP ID'.padEnd(10),
            'ROLE'.padEnd(12),
            'PROGRESS'.padEnd(20),
            'OFFER'.padEnd(18),
            'WANT'.padEnd(18),
            'COUNTERPARTY'.padEnd(16),
            'CREATED',
          ].join('');
          console.log(header);

          for (const swap of swaps) {
            const id = (swap.swapId || '').slice(0, 8);
            const role = swap.role || '';
            const progress = swap.progress || '';

            // Determine counterparty display
            const isProposer = role === 'proposer';
            const offerStr = isProposer
              ? `${swap.deal?.partyAAmount ?? ''} ${swap.deal?.partyACurrency ?? ''}`
              : `${swap.deal?.partyBAmount ?? ''} ${swap.deal?.partyBCurrency ?? ''}`;
            const wantStr = isProposer
              ? `${swap.deal?.partyBAmount ?? ''} ${swap.deal?.partyBCurrency ?? ''}`
              : `${swap.deal?.partyAAmount ?? ''} ${swap.deal?.partyACurrency ?? ''}`;
            const counterparty = isProposer
              ? (swap.deal?.partyB ?? '').slice(0, 14)
              : (swap.deal?.partyA ?? '').slice(0, 14);

            // Relative time
            const elapsed = Date.now() - (swap.createdAt || 0);
            let timeStr: string;
            if (elapsed < 60_000) timeStr = 'just now';
            else if (elapsed < 3_600_000) timeStr = `${Math.floor(elapsed / 60_000)} min ago`;
            else if (elapsed < 86_400_000) timeStr = `${Math.floor(elapsed / 3_600_000)} hour ago`;
            else timeStr = `${Math.floor(elapsed / 86_400_000)} days ago`;

            // Color progress
            let coloredProgress = progress;
            if (progress === 'completed') coloredProgress = `${green}${progress}${reset}`;
            else if (progress === 'failed' || progress === 'cancelled') coloredProgress = `${red}${progress}${reset}`;
            else coloredProgress = `${yellow}${progress}${reset}`;

            const row = [
              id.padEnd(10),
              role.padEnd(12),
              // Pad the raw progress (color codes are zero-width for terminal)
              coloredProgress + ' '.repeat(Math.max(0, 20 - progress.length)),
              offerStr.padEnd(18),
              wantStr.padEnd(18),
              counterparty.padEnd(16),
              timeStr,
            ].join('');
            console.log(row);
          }
        }

        await closeSphere();
        break;
      }

      case 'swap-accept': {
        const swapId = args[1];
        if (!swapId) {
          console.error('Usage: swap-accept <swap_id> [--deposit] [--no-wait]');
          process.exit(1);
        }
        if (!/^[0-9a-f]{64}$/i.test(swapId)) {
          console.error('Invalid swap ID — must be 64 hex characters');
          process.exit(1);
        }

        const depositFlag = args.includes('--deposit');
        const noWaitFlag = args.includes('--no-wait');

        const sphere = await getSphere();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const swapModule = (sphere as any).swap;
        if (!swapModule) {
          console.error('Swap module not enabled.');
          process.exit(1);
        }

        await swapModule.acceptSwap(swapId);
        console.log('Swap accepted. Announced to escrow. Waiting for deposit invoice...');

        if (depositFlag) {
          const depositResult = await swapModule.deposit(swapId);
          console.log(`Deposit sent: ${depositResult.id}`);

          if (!noWaitFlag) {
            // Wait for terminal event
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const swapRef = await swapModule.getSwapStatus(swapId);
            const waitTimeout = 2 * (swapRef?.deal?.timeout ?? 3600) * 1000;
            const unsubs: (() => void)[] = [];
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                unsubs.forEach(u => u());
                reject(new Error(`Swap did not complete within timeout. Current progress: ${swapRef?.progress ?? 'unknown'}`));
              }, waitTimeout);

              const done = (msg: string) => {
                clearTimeout(timer);
                unsubs.forEach(u => u());
                console.log(msg);
                resolve();
              };

              unsubs.push(sphere.on('swap:completed', (e: { swapId: string }) => {
                if (e.swapId === swapId) done('[swap] Swap completed!');
              }));
              unsubs.push(sphere.on('swap:cancelled', (e: { swapId: string }) => {
                if (e.swapId === swapId) done('[swap] Swap cancelled.');
              }));
              unsubs.push(sphere.on('swap:failed', (e: { swapId: string; error: string }) => {
                if (e.swapId === swapId) done(`[swap] Swap failed: ${e.error}`);
              }));
              unsubs.push(sphere.on('swap:deposit_confirmed', (e: { swapId: string }) => {
                if (e.swapId === swapId) console.log('[swap] Deposit confirmed by escrow.');
              }));
              unsubs.push(sphere.on('swap:deposits_covered', (e: { swapId: string }) => {
                if (e.swapId === swapId) console.log('[swap] All deposits covered. Escrow concluding...');
              }));
              unsubs.push(sphere.on('swap:payout_received', (e: { swapId: string }) => {
                if (e.swapId === swapId) console.log('[swap] Payout received. Verifying...');
              }));
            });
          }
        } else {
          console.log(`Run 'swap-deposit ${swapId}' to deposit when ready.`);
        }

        await closeSphere();
        break;
      }

      case 'swap-status': {
        const swapId = args[1];
        if (!swapId) {
          console.error('Usage: swap-status <swap_id> [--query-escrow]');
          process.exit(1);
        }
        if (!/^[0-9a-f]{64}$/i.test(swapId)) {
          console.error('Invalid swap ID — must be 64 hex characters');
          process.exit(1);
        }

        const queryEscrow = args.includes('--query-escrow');

        const sphere = await getSphere();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const swapModule = (sphere as any).swap;
        if (!swapModule) {
          console.error('Swap module not enabled.');
          process.exit(1);
        }

        const status = await swapModule.getSwapStatus(swapId, queryEscrow ? { queryEscrow: true } : undefined);
        console.log('Swap Status:');
        console.log(JSON.stringify(status, null, 2));

        if (status.depositInvoiceId && sphere.accounting) {
          try {
            const invoiceStatus = await sphere.accounting.getInvoiceStatus(status.depositInvoiceId);
            console.log('\nDeposit Invoice Status:');
            console.log(JSON.stringify(invoiceStatus, null, 2));
          } catch {
            // Non-fatal: invoice may not be imported yet
          }
        }

        await closeSphere();
        break;
      }

      case 'swap-deposit': {
        const swapId = args[1];
        if (!swapId) {
          console.error('Usage: swap-deposit <swap_id>');
          process.exit(1);
        }
        if (!/^[0-9a-f]{64}$/i.test(swapId)) {
          console.error('Invalid swap ID — must be 64 hex characters');
          process.exit(1);
        }

        const sphere = await getSphere();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const swapModule = (sphere as any).swap;
        if (!swapModule) {
          console.error('Swap module not enabled.');
          process.exit(1);
        }

        const result = await swapModule.deposit(swapId);
        console.log('Deposit result:');
        console.log(JSON.stringify({ id: result.id, status: result.status }, null, 2));

        await closeSphere();
        break;
      }

      case 'daemon': {
        const sub = args[1] || 'start';
        const { runDaemon, stopDaemon, statusDaemon } = await import('./daemon.js');
        switch (sub) {
          case 'start':
            await runDaemon(args.slice(2), getSphere, closeSphere);
            break;
          case 'stop':
            await stopDaemon(args.slice(2));
            break;
          case 'status':
            await statusDaemon(args.slice(2));
            break;
          default:
            console.error(`Unknown daemon sub-command: ${sub}`);
            console.error('Usage: daemon start|stop|status');
            process.exit(1);
        }
        break;
      }

      case 'completions': {
        const shell = args[1];
        if (!shell || !['bash', 'zsh', 'fish'].includes(shell)) {
          console.error('Usage: completions <bash|zsh|fish>');
          console.error('Generate shell completion script for tab-completion.');
          console.error('\nSetup:');
          console.error('  sphere-cli completions bash >> ~/.bashrc');
          console.error('  sphere-cli completions zsh > ~/.zsh/completions/_sphere-cli');
          console.error('  sphere-cli completions fish > ~/.config/fish/completions/sphere-cli.fish');
          process.exit(1);
        }
        switch (shell) {
          case 'bash': console.log(generateBashCompletions()); break;
          case 'zsh': console.log(generateZshCompletions()); break;
          case 'fish': console.log(generateFishCompletions()); break;
        }
        break;
      }

      default:
        console.error('Unknown command:', command);
        console.error('Run with --help for usage');
        process.exit(1);
    }
  } catch (e) {
    console.error('Error:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

// =============================================================================
// Shell Completion Generators
// =============================================================================

interface CompletionCommand {
  name: string;
  description: string;
  flags?: string[];
  subcommands?: CompletionCommand[];
}

function getCompletionCommands(): CompletionCommand[] {
  return [
    { name: 'init', description: 'Create or import wallet', flags: ['--network', '--mnemonic', '--nametag', '--password', '--no-nostr'] },
    { name: 'status', description: 'Show wallet identity' },
    { name: 'config', description: 'Show or set CLI configuration' },
    { name: 'clear', description: 'Delete all wallet data' },
    { name: 'wallet', description: 'Manage wallet profiles', subcommands: [
      { name: 'list', description: 'List all wallet profiles' },
      { name: 'create', description: 'Create a new wallet profile', flags: ['--network'] },
      { name: 'use', description: 'Switch to a wallet profile' },
      { name: 'current', description: 'Show active profile' },
      { name: 'delete', description: 'Delete a wallet profile' },
    ]},
    { name: 'balance', description: 'Show L3 token balance', flags: ['--finalize', '--no-sync'] },
    { name: 'tokens', description: 'List all tokens', flags: ['--no-sync'] },
    { name: 'assets', description: 'List registered assets (coins & NFTs)', flags: ['--type'] },
    { name: 'asset-info', description: 'Show detailed info for an asset' },
    { name: 'l1-balance', description: 'Show L1 (ALPHA) balance' },
    { name: 'topup', description: 'Request test tokens from faucet' },
    { name: 'top-up', description: 'Alias for topup' },
    { name: 'faucet', description: 'Alias for topup' },
    { name: 'verify-balance', description: 'Verify tokens against aggregator', flags: ['--remove', '-v', '--verbose'] },
    { name: 'sync', description: 'Sync tokens with IPFS' },
    { name: 'send', description: 'Send L3 tokens', flags: ['--direct', '--proxy', '--instant', '--conservative', '--no-sync'] },
    { name: 'receive', description: 'Check for incoming transfers', flags: ['--finalize', '--no-sync'] },
    { name: 'history', description: 'Show transaction history' },
    { name: 'addresses', description: 'List tracked addresses' },
    { name: 'switch', description: 'Switch to HD address' },
    { name: 'hide', description: 'Hide address' },
    { name: 'unhide', description: 'Unhide address' },
    { name: 'nametag', description: 'Register a nametag' },
    { name: 'nametag-info', description: 'Look up nametag info' },
    { name: 'my-nametag', description: 'Show current nametag' },
    { name: 'nametag-sync', description: 'Re-publish nametag binding' },
    { name: 'dm', description: 'Send a direct message' },
    { name: 'dm-inbox', description: 'List conversations' },
    { name: 'dm-history', description: 'Show conversation history', flags: ['--limit'] },
    { name: 'group-create', description: 'Create a new group', flags: ['--description', '--private'] },
    { name: 'group-list', description: 'List available groups' },
    { name: 'group-my', description: 'List your joined groups' },
    { name: 'group-join', description: 'Join a group', flags: ['--invite'] },
    { name: 'group-leave', description: 'Leave a group' },
    { name: 'group-send', description: 'Send a message to a group', flags: ['--reply'] },
    { name: 'group-messages', description: 'Show group messages', flags: ['--limit'] },
    { name: 'group-members', description: 'List group members' },
    { name: 'group-info', description: 'Show group details' },
    { name: 'invoice-create', description: 'Create an invoice', flags: ['--target', '--asset', '--nft', '--due', '--memo', '--delivery', '--anonymous', '--terms'] },
    { name: 'invoice-import', description: 'Import invoice from token file' },
    { name: 'invoice-list', description: 'List invoices', flags: ['--state', '--limit'] },
    { name: 'invoice-status', description: 'Show invoice status' },
    { name: 'invoice-close', description: 'Close an invoice' },
    { name: 'invoice-cancel', description: 'Cancel an invoice' },
    { name: 'invoice-pay', description: 'Pay an invoice', flags: ['--target-index', '--asset-index', '--amount'] },
    { name: 'invoice-return', description: 'Return payment to sender', flags: ['--recipient', '--asset'] },
    { name: 'invoice-receipts', description: 'Send payment receipts' },
    { name: 'invoice-notices', description: 'Send cancellation notices' },
    { name: 'invoice-auto-return', description: 'Show/set auto-return settings', flags: ['--on', '--off', '--global', '--invoice'] },
    { name: 'invoice-transfers', description: 'List related transfers' },
    { name: 'invoice-export', description: 'Export invoice to JSON file' },
    { name: 'invoice-parse-memo', description: 'Parse invoice memo string' },
    { name: 'swap-propose', description: 'Propose a token swap', flags: ['--to', '--offer', '--want', '--escrow', '--timeout', '--message'] },
    { name: 'swap-list', description: 'List swap deals', flags: ['--all', '--role', '--progress'] },
    { name: 'swap-accept', description: 'Accept a swap deal', flags: ['--deposit', '--no-wait'] },
    { name: 'swap-status', description: 'Show swap status', flags: ['--query-escrow'] },
    { name: 'swap-deposit', description: 'Deposit into a swap' },
    { name: 'market-post', description: 'Post a market intent', flags: ['--type', '--category', '--price', '--currency', '--location', '--contact', '--expires'] },
    { name: 'market-search', description: 'Search market intents', flags: ['--type', '--category', '--min-price', '--max-price', '--limit'] },
    { name: 'market-my', description: 'List your intents' },
    { name: 'market-close', description: 'Close an intent' },
    { name: 'market-feed', description: 'Watch live listing feed', flags: ['--rest'] },
    { name: 'daemon', description: 'Manage event daemon', subcommands: [
      { name: 'start', description: 'Start daemon', flags: ['--config', '--detach', '--log', '--pid', '--event', '--action', '--verbose'] },
      { name: 'stop', description: 'Stop daemon' },
      { name: 'status', description: 'Check daemon status' },
    ]},
    { name: 'encrypt', description: 'Encrypt data with password' },
    { name: 'decrypt', description: 'Decrypt encrypted data' },
    { name: 'parse-wallet', description: 'Parse wallet file' },
    { name: 'wallet-info', description: 'Show wallet file info' },
    { name: 'generate-key', description: 'Generate random private key' },
    { name: 'validate-key', description: 'Validate a private key' },
    { name: 'hex-to-wif', description: 'Convert hex to WIF' },
    { name: 'derive-pubkey', description: 'Derive public key' },
    { name: 'derive-address', description: 'Derive L1 address' },
    { name: 'to-smallest', description: 'Convert to smallest unit' },
    { name: 'to-human', description: 'Convert to human-readable' },
    { name: 'format', description: 'Format amount' },
    { name: 'base58-encode', description: 'Encode hex to base58' },
    { name: 'base58-decode', description: 'Decode base58 to hex' },
    { name: 'completions', description: 'Generate shell completion script' },
    { name: 'help', description: 'Show help for a command' },
  ];
}

function generateBashCompletions(): string {
  const cmds = getCompletionCommands();
  const topLevel = cmds.map(c => c.name).join(' ');

  const subcommandCases: string[] = [];
  const flagCases: string[] = [];

  for (const cmd of cmds) {
    if (cmd.subcommands) {
      const subs = cmd.subcommands.map(s => s.name).join(' ');
      subcommandCases.push(`    ${cmd.name})\n      if [[ $cword -eq 2 ]]; then\n        COMPREPLY=($(compgen -W "${subs}" -- "$cur"))\n        return\n      fi\n      ;;`);
      for (const sub of cmd.subcommands) {
        if (sub.flags?.length) {
          flagCases.push(`    "${cmd.name} ${sub.name}") flags="${sub.flags.join(' ')}" ;;`);
        }
      }
    }
    if (cmd.flags?.length) {
      flagCases.push(`    ${cmd.name}) flags="${cmd.flags.join(' ')}" ;;`);
    }
  }

  return `# Bash completion for sphere-cli
# Generated by: sphere-cli completions bash
#
# Installation:
#   sphere-cli completions bash >> ~/.bashrc
#   # or
#   sphere-cli completions bash > /etc/bash_completion.d/sphere-cli
#   # or with npm:
#   eval "$(npm run --silent cli -- completions bash)"

_sphere_cli() {
  local cur prev words cword
  _init_completion || return

  local commands="${topLevel}"

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$commands" -- "$cur"))
    return
  fi

  # Subcommands
  case "\${words[1]}" in
${subcommandCases.join('\n')}
  esac

  # Flag completion
  if [[ "$cur" == -* ]]; then
    local flags=""
    local cmd_key="\${words[1]}"
    if [[ $cword -ge 3 ]]; then
      cmd_key="\${words[1]} \${words[2]}"
    fi
    case "$cmd_key" in
${flagCases.join('\n')}
    esac
    if [[ -n "$flags" ]]; then
      COMPREPLY=($(compgen -W "$flags" -- "$cur"))
    fi
  fi
}

complete -F _sphere_cli sphere-cli
# Also complete for npm run cli -- usage:
complete -F _sphere_cli npx
`;
}

function generateZshCompletions(): string {
  const cmds = getCompletionCommands();

  const commandList = cmds.map(c => `    '${c.name}:${c.description.replace(/'/g, "'\\''")}'`).join('\n');

  const subcases: string[] = [];
  for (const cmd of cmds) {
    if (cmd.subcommands) {
      const subList = cmd.subcommands.map(s => `'${s.name}:${s.description.replace(/'/g, "'\\''")}'`).join(' ');
      subcases.push(`        ${cmd.name})\n          _describe 'subcommand' ${subList}\n          ;;`);
    } else {
      const flagArgs = (cmd.flags || []).map(f => `'${f}[${cmd.description.replace(/'/g, "'\\''").slice(0, 30)}]'`).join(' ');
      if (flagArgs) {
        subcases.push(`        ${cmd.name})\n          _arguments ${flagArgs}\n          ;;`);
      }
    }
  }

  return `#compdef sphere-cli
# Zsh completion for sphere-cli
# Generated by: sphere-cli completions zsh
#
# Installation:
#   mkdir -p ~/.zsh/completions
#   sphere-cli completions zsh > ~/.zsh/completions/_sphere-cli
#   # Add to .zshrc: fpath=(~/.zsh/completions $fpath) && autoload -Uz compinit && compinit

_sphere_cli() {
  local -a commands
  commands=(
${commandList}
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case "$state" in
    command)
      _describe 'command' commands
      ;;
    args)
      case "\${words[1]}" in
${subcases.join('\n')}
      esac
      ;;
  esac
}

_sphere_cli "$@"
`;
}

function generateFishCompletions(): string {
  const cmds = getCompletionCommands();
  const lines: string[] = [
    '# Fish completion for sphere-cli',
    '# Generated by: sphere-cli completions fish',
    '#',
    '# Installation:',
    '#   sphere-cli completions fish > ~/.config/fish/completions/sphere-cli.fish',
    '',
  ];

  for (const cmd of cmds) {
    if (cmd.subcommands) {
      lines.push(`complete -c sphere-cli -n '__fish_use_subcommand' -a '${cmd.name}' -d '${cmd.description}'`);
      for (const sub of cmd.subcommands) {
        lines.push(`complete -c sphere-cli -n '__fish_seen_subcommand_from ${cmd.name}' -a '${sub.name}' -d '${sub.description}'`);
        for (const flag of sub.flags || []) {
          lines.push(`complete -c sphere-cli -n '__fish_seen_subcommand_from ${cmd.name}' -l '${flag.replace(/^--/, '')}' -d '${sub.description}'`);
        }
      }
    } else {
      lines.push(`complete -c sphere-cli -n '__fish_use_subcommand' -a '${cmd.name}' -d '${cmd.description}'`);
      for (const flag of cmd.flags || []) {
        lines.push(`complete -c sphere-cli -n '__fish_seen_subcommand_from ${cmd.name}' -l '${flag.replace(/^--/, '')}' -d '${flag}'`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

main().then(() => process.exit(0));
