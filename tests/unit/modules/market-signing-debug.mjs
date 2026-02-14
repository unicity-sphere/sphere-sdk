import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

function hexToBytes(hex) {
  const len = hex.length >> 1;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const privateKey = 'a'.repeat(64);
const body = { public_key: '02' + 'ab'.repeat(32) };
const timestamp = Date.now();
const payload = JSON.stringify({ body, timestamp });
const messageHash = sha256(new TextEncoder().encode(payload));
const privateKeyBytes = hexToBytes(privateKey);

console.log('Payload:', payload);

const signature = secp256k1.sign(messageHash, privateKeyBytes);
const sigHex = signature.toCompactHex();
const publicKey = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));

console.log('Signature hex length:', sigHex.length);
console.log('Public key:', publicKey);

// Try to verify - method 1
const sig2 = secp256k1.Signature.fromCompact(sigHex);
const isValid1 = secp256k1.verify(sig2, messageHash, hexToBytes(publicKey));
console.log('Verify with fromCompact (hex):', isValid1);

// Try to verify - method 2 
const sigBytes = hexToBytes(sigHex);
const sig3 = secp256k1.Signature.fromCompact(sigBytes);
const isValid2 = secp256k1.verify(sig3, messageHash, hexToBytes(publicKey));
console.log('Verify with fromCompact (bytes):', isValid2);
