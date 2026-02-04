#!/usr/bin/env npx tsx
/**
 * Sphere SDK CLI
 * Usage: npx tsx cli.ts <command> [args...]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { encrypt, decrypt, generateRandomKey } from './core/encryption';
import { parseWalletText, isTextWalletEncrypted, parseAndDecryptWalletText } from './serialization/wallet-text';
import { parseWalletDat, isSQLiteDatabase, isWalletDatEncrypted } from './serialization/wallet-dat';
import { isValidPrivateKey, base58Encode, base58Decode } from './core/utils';
import { hexToWIF, generatePrivateKey } from './l1/crypto';
import { toSmallestUnit, toHumanReadable, formatAmount } from './core/currency';
import { getPublicKey } from './core/crypto';
import { generateAddressFromMasterKey } from './l1/address';
import { Sphere } from './core/Sphere';
import { createNodeProviders } from './impl/nodejs';
import { TokenRegistry } from './registry/TokenRegistry';
import type { NetworkType } from './constants';

const args = process.argv.slice(2);
const command = args[0];

// =============================================================================
// CLI Configuration
// =============================================================================

const DEFAULT_DATA_DIR = './.sphere-cli';
const DEFAULT_TOKENS_DIR = './.sphere-cli/tokens';
const CONFIG_FILE = './.sphere-cli/config.json';

interface CliConfig {
  network: NetworkType;
  dataDir: string;
  tokensDir: string;
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
// Sphere Instance Management
// =============================================================================

let sphereInstance: Sphere | null = null;

async function getSphere(options?: { autoGenerate?: boolean; mnemonic?: string; nametag?: string }): Promise<Sphere> {
  if (sphereInstance) return sphereInstance;

  const config = loadConfig();
  const providers = createNodeProviders({
    network: config.network,
    dataDir: config.dataDir,
    tokensDir: config.tokensDir,
  });

  const result = await Sphere.init({
    ...providers,
    autoGenerate: options?.autoGenerate,
    mnemonic: options?.mnemonic,
    nametag: options?.nametag,
  });

  sphereInstance = result.sphere;
  return sphereInstance;
}

async function closeSphere(): Promise<void> {
  if (sphereInstance) {
    await sphereInstance.destroy();
    sphereInstance = null;
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
Sphere SDK CLI v0.2.0

Usage: npm run cli -- <command> [args...]
   or: npx tsx cli.ts <command> [args...]

WALLET MANAGEMENT:
  init [--network <net>]            Create new wallet (mainnet|testnet|dev)
  init --mnemonic "<words>"         Import wallet from mnemonic
  status                            Show wallet status and identity
  config                            Show current configuration
  config set <key> <value>          Set configuration (network, dataDir, tokensDir)

BALANCE & TOKENS:
  balance                           Show L3 token balance
  tokens                            List all tokens with details
  l1-balance                        Show L1 (ALPHA) balance

TRANSFERS:
  send <to> <amount> [--coin SYM]   Send tokens (to: @nametag or address, SYM: UCT/BTC/ETH/SOL)
  receive                           Show address for receiving tokens
  history [limit]                   Show transaction history

NAMETAGS:
  nametag <name>                    Register a nametag (@name)
  nametag-info <name>               Lookup nametag info
  my-nametag                        Show current nametag

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
`);
}

async function main() {
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

      // === BALANCE & TOKENS ===
      case 'balance': {
        const sphere = await getSphere();
        const balances = sphere.payments.getBalance();

        console.log('\nL3 Balance:');
        console.log('─'.repeat(50));

        if (balances.length === 0) {
          console.log('No tokens found.');
        } else {
          for (const bal of balances) {
            const decimals = bal.decimals ?? 8;
            const amountBigInt = BigInt(bal.totalAmount);
            const divisor = BigInt(10 ** decimals);
            const wholePart = amountBigInt / divisor;
            const fracPart = amountBigInt % divisor;
            const formatted = fracPart > 0
              ? `${wholePart}.${fracPart.toString().padStart(decimals, '0').replace(/0+$/, '')}`
              : wholePart.toString();
            console.log(`${bal.symbol}: ${formatted} (${bal.tokenCount} tokens)`);
          }
        }
        console.log('─'.repeat(50));

        await closeSphere();
        break;
      }

      case 'tokens': {
        const sphere = await getSphere();
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
            const amountBigInt = BigInt(token.amount || '0');
            const divisor = BigInt(10 ** decimals);
            const wholePart = amountBigInt / divisor;
            const fracPart = amountBigInt % divisor;
            const formatted = fracPart > 0
              ? `${wholePart}.${fracPart.toString().padStart(decimals, '0').replace(/0+$/, '')}`
              : wholePart.toString();
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

      // === TRANSFERS ===
      case 'send': {
        const [, recipient, amountStr] = args;
        if (!recipient || !amountStr) {
          console.error('Usage: send <recipient> <amount> [--coin <symbol>]');
          console.error('  recipient: @nametag or DIRECT:// address');
          console.error('  amount: decimal amount (e.g., 0.5, 100)');
          console.error('  --coin: token symbol (e.g., UCT, BTC, ETH, SOL) - default: UCT');
          process.exit(1);
        }

        // Parse --coin option (symbol like UCT, BTC, ETH)
        const coinIndex = args.indexOf('--coin');
        const coinSymbol = coinIndex !== -1 && args[coinIndex + 1] ? args[coinIndex + 1] : 'UCT';

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

        console.log(`\nSending ${amountStr} ${coinSymbol} to ${recipient}...`);

        const result = await sphere.payments.send({
          recipient,
          amount: amountSmallest,
          coinId: coinIdHex,
        });

        if (result.status === 'completed' || result.status === 'submitted') {
          console.log('\n✓ Transfer successful!');
          console.log(`  Transfer ID: ${result.id}`);
          console.log(`  Status: ${result.status}`);
        } else {
          console.error('\n✗ Transfer failed:', result.error || result.status);
        }

        await closeSphere();
        break;
      }

      case 'receive': {
        const sphere = await getSphere();
        const identity = sphere.identity;

        if (!identity) {
          console.error('No wallet initialized.');
          process.exit(1);
        }

        console.log('\nReceive Address:');
        console.log('─'.repeat(50));
        console.log(`L3 (Direct): ${identity.directAddress || '(not available)'}`);
        console.log(`L1 (ALPHA):  ${identity.l1Address}`);
        if (identity.nametag) {
          console.log(`Nametag:     @${identity.nametag}`);
        }
        console.log('─'.repeat(50));
        console.log('\nShare your nametag or Direct address to receive tokens.');

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
          for (const tx of limited) {
            const date = new Date(tx.timestamp).toLocaleString();
            const direction = tx.type === 'SENT' ? '→' : '←';
            const amount = toHumanReadable(tx.amount?.toString() || '0');
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

main();
