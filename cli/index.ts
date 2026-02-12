#!/usr/bin/env npx tsx
/**
 * Sphere SDK CLI
 * Usage: npx tsx cli/index.ts <command> [args...]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { encrypt, decrypt, generateRandomKey } from '../core/encryption';
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
import { tokenToTxf, getCurrentStateHash } from '../serialization/txf-serializer';
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
  });

  const initProviders = noNostrGlobal
    ? { ...providers, transport: createNoopTransport() }
    : providers;

  const result = await Sphere.init({
    ...initProviders,
    autoGenerate: options?.autoGenerate,
    mnemonic: options?.mnemonic,
    nametag: options?.nametag,
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

function prompt(question: string): Promise<string> {
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

function printUsage() {
  console.log(`
Sphere SDK CLI v0.2.2

Usage: npm run cli -- <command> [args...]
   or: npx tsx cli/index.ts <command> [args...]

WALLET MANAGEMENT:
  init [--network <net>]            Create new wallet (mainnet|testnet|dev)
  init --mnemonic "<words>"         Import wallet from mnemonic
  status                            Show wallet status and identity
  clear                             Delete all wallet data (keys + tokens)
  config                            Show current configuration
  config set <key> <value>          Set configuration (network, dataDir, tokensDir)

WALLET PROFILES:
  wallet list                       List all wallet profiles
  wallet use <name>                 Switch to a wallet profile
  wallet create <name> [--network]  Create a new wallet profile
  wallet delete <name>              Delete a wallet profile
  wallet current                    Show current wallet profile

BALANCE & TOKENS:
  balance [--finalize] [--no-sync]  Show L3 token balance
                                    --finalize: wait for unconfirmed tokens to be finalized
                                    --no-sync: skip IPFS sync before showing balance
  tokens [--no-sync]                List all tokens with details
  l1-balance                        Show L1 (ALPHA) balance
  topup [coin] [amount]             Request test tokens from faucet
                                    Without args: requests all supported coins
                                    With coin: requests specific coin (bitcoin, ethereum, etc.)
  verify-balance [--remove] [-v]    Verify tokens against aggregator
                                    Detects spent tokens not removed from storage
                                    --remove: Remove spent tokens from storage
                                    -v/--verbose: Show all tokens, not just spent
  sync                              Sync tokens with IPFS remote storage

TRANSFERS:
  send <to> <amount> [options]      Send tokens (to: @nametag or address)
                                    --coin SYM       Token symbol (UCT/BTC/ETH/SOL)
                                    --direct         Force DirectAddress transfer
                                    --proxy          Force PROXY address transfer
                                    --instant        Send immediately via Nostr (default)
                                    --conservative   Collect all proofs first, then send
                                    --no-sync        Skip IPFS sync after sending
  receive [--finalize] [--no-sync]  Check for incoming transfers
                                    --finalize: wait for unconfirmed tokens to be finalized
                                    --no-sync: skip IPFS sync after receiving
  history [limit]                   Show transaction history

ADDRESSES:
  addresses                         List all tracked addresses
  switch <index>                    Switch to address at HD index
  hide <index>                      Hide address from active list
  unhide <index>                    Unhide address

NAMETAGS:
  nametag <name>                    Register a nametag (@name)
  nametag-info <name>               Lookup nametag info
  my-nametag                        Show current nametag
  nametag-sync                      Re-publish nametag with chainPubkey (fixes legacy nametags)

ENCRYPTION:
  encrypt <data> <password>         Encrypt data with password
  decrypt <json> <password>         Decrypt encrypted JSON data

WALLET PARSING:
  parse-wallet <file> [password]    Parse wallet file (.txt, .dat)
  wallet-info <file>                Show wallet file info (encrypted?, format)

KEY OPERATIONS:
  generate-key                      Generate random private key
  validate-key <hex>                Validate secp256k1 private key
  hex-to-wif <hex>                  Convert hex to WIF format
  derive-pubkey <hex>               Derive public key from private
  derive-address <hex> [index]      Derive address at index (default: 0)

CURRENCY:
  to-smallest <amount>              Convert to smallest unit (satoshi)
  to-human <amount>                 Convert from smallest to human readable
  format <amount> [decimals]        Format amount with decimals

ENCODING:
  base58-encode <hex>               Encode hex to base58
  base58-decode <string>            Decode base58 to hex

Examples:
  npm run cli -- init --network testnet
  npm run cli -- init --mnemonic "word1 word2 ... word24"
  npm run cli -- status
  npm run cli -- balance
  npm run cli -- send @alice 1000000 --coin ETH
  npm run cli -- nametag myname
  npm run cli -- history 10

Wallet Profile Examples:
  npm run cli -- wallet create alice              Create profile "alice"
  npm run cli -- init --nametag alice             Initialize wallet in profile
  npm run cli -- wallet create bob                Create another profile
  npm run cli -- init --nametag bob               Initialize second wallet
  npm run cli -- wallet list                      List all profiles
  npm run cli -- wallet use alice                 Switch to alice
  npm run cli -- send @bob 0.1 --coin BTC         Send from alice to bob
  npm run cli -- wallet use bob                   Switch to bob
  npm run cli -- balance                          Check bob's balance
`);
}

async function main() {
  // Global flag: --no-nostr disables Nostr transport (uses no-op)
  noNostrGlobal = args.includes('--no-nostr');

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
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
          console.error('Usage: send <recipient> <amount> [--coin <symbol>] [--direct|--proxy] [--instant|--conservative]');
          console.error('  recipient: @nametag or DIRECT:// address');
          console.error('  amount: decimal amount (e.g., 0.5, 100)');
          console.error('  --coin: token symbol (e.g., UCT, BTC, ETH, SOL) - default: UCT');
          console.error('  --direct: force DirectAddress transfer (requires new nametag with directAddress)');
          console.error('  --proxy: force PROXY address transfer (works with any nametag)');
          console.error('  --instant: send via Nostr immediately (default, receiver gets unconfirmed token)');
          console.error('  --conservative: collect all proofs first, receiver gets confirmed token');
          process.exit(1);
        }

        // Parse --coin option (symbol like UCT, BTC, ETH)
        const coinIndex = args.indexOf('--coin');
        const coinSymbol = coinIndex !== -1 && args[coinIndex + 1] ? args[coinIndex + 1] : 'UCT';

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

        // Resolve symbol to coinId hex and get decimals
        const registry = TokenRegistry.getInstance();
        const coinDef = registry.getDefinitionBySymbol(coinSymbol);
        if (!coinDef) {
          console.error(`Unknown coin symbol: ${coinSymbol}`);
          console.error('Available symbols: UCT, BTC, ETH, SOL, USDT, USDC, USDU, EURU, ALPHT');
          process.exit(1);
        }
        const coinIdHex = coinDef.id;
        const decimals = coinDef.decimals ?? 8;

        // Convert amount to smallest units (supports decimal input like "0.2")
        const amountSmallest = toSmallestUnit(amountStr, decimals).toString();

        const sphere = await getSphere();

        const modeLabel = addressMode === 'auto' ? '' : ` (${addressMode})`;
        const txModeLabel = forceConservative ? ' [conservative]' : '';
        console.log(`\nSending ${amountStr} ${coinSymbol} to ${recipient}${modeLabel}${txModeLabel}...`);

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

        // Get transport provider and force re-register
        const transport = (sphere as unknown as { _transport?: { registerNametag?: (n: string, pk: string, da: string) => Promise<boolean> } })._transport;
        if (!transport?.registerNametag) {
          console.error('Transport provider does not support nametag registration');
          process.exit(1);
        }

        try {
          const success = await transport.registerNametag(
            identity.nametag,
            identity.chainPubkey,
            identity.directAddress || ''
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
          console.error('Usage: to-smallest <amount>');
          process.exit(1);
        }
        console.log(toSmallestUnit(amount));
        break;
      }

      case 'to-human': {
        const [, amount] = args;
        if (!amount) {
          console.error('Usage: to-human <amount>');
          process.exit(1);
        }
        console.log(toHumanReadable(amount));
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

        // Parse options
        const coinArg = args[1];  // Optional: specific coin
        const amountArg = args[2]; // Optional: specific amount

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
          // Request specific coin
          const coin = coinArg.toLowerCase();
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

main().then(() => process.exit(0));
