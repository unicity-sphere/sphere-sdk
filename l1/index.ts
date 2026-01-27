/**
 * L1 SDK - ALPHA blockchain operations
 */

// Types
export * from './types';

// Bech32 encoding (from core)
export {
  createBech32,
  encodeBech32,
  decodeBech32,
  convertBits,
  CHARSET,
} from '../core/bech32';

// Address utilities
export { addressToScriptHash } from './addressToScriptHash';

// Crypto utilities (from core)
export {
  computeHash160,
  hash160,
  hash160ToBytes,
  publicKeyToAddress,
  privateKeyToAddressInfo,
  generateAddressInfo,
  ec,
} from '../core/crypto';

// Encryption and WIF
export {
  encrypt,
  decrypt,
  encryptWallet,
  decryptWallet,
  generatePrivateKey,
  hexToWIF,
} from './crypto';

// Address derivation
export {
  deriveChildKeyBIP32,
  deriveKeyAtPath,
  generateMasterKeyFromSeed,
  generateHDAddressBIP32,
  generateAddressFromMasterKey,
  deriveChildKey,
  generateHDAddress,
} from './address';

// Network (Fulcrum WebSocket)
export {
  connect,
  disconnect,
  rpc,
  isWebSocketConnected,
  waitForConnection,
  getUtxo,
  getBalance,
  broadcast,
  subscribeBlocks,
  getTransactionHistory,
  getTransaction,
  getBlockHeader,
  getCurrentBlockHeight,
} from './network';
export type { BlockHeader, TransactionHistoryItem, TransactionDetail } from './network';

// Transaction building
export {
  createScriptPubKey,
  buildSegWitTransaction,
  createAndSignTransaction,
  collectUtxosForAmount,
  createTransactionPlan,
  sendAlpha,
} from './tx';

// Vesting classification
export { vestingClassifier, VESTING_THRESHOLD } from './vesting';
export { vestingState } from './vestingState';

// Address helpers
export { WalletAddressHelper } from './addressHelpers';
