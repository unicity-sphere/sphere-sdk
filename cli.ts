#!/usr/bin/env npx tsx
/**
 * Sphere SDK CLI
 * Usage: npx tsx cli.ts <command> [args...]
 */

import * as fs from 'fs';
import { encrypt, decrypt, generateRandomKey } from './core/encryption';
import { parseWalletText, isTextWalletEncrypted, parseAndDecryptWalletText } from './serialization/wallet-text';
import { parseWalletDat, isSQLiteDatabase, isWalletDatEncrypted } from './serialization/wallet-dat';
import { isValidPrivateKey, base58Encode, base58Decode } from './core/utils';
import { hexToWIF, generatePrivateKey } from './l1/crypto';
import { toSmallestUnit, toHumanReadable, formatAmount } from './core/currency';
import { getPublicKey } from './core/crypto';
import { generateAddressFromMasterKey } from './l1/address';

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`
Sphere SDK CLI v0.1.0

Usage: npm run cli -- <command> [args...]
   or: npx tsx cli.ts <command> [args...]

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
  npm run cli -- generate-key
  npm run cli -- derive-address a1b2c3...64chars 0
  npm run cli -- parse-wallet wallet.txt
  npm run cli -- encrypt "secret" mypassword
  npm run cli -- to-human 100000000
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  try {
    switch (command) {
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
