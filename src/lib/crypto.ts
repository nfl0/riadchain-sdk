import { secp256k1 } from 'ethereum-cryptography/secp256k1';
import { keccak256 as rawKeccak256 } from 'ethereum-cryptography/keccak';
import { hexToBytes, bytesToHex } from 'ethereum-cryptography/utils';

/**
 * Ethereum address format: 0x + 40 hex characters
 */
export type EthAddress = `0x${string}`;

/**
 * Generate a new SECP256k1 key pair for signing transactions
 * @returns Object containing hex-encoded publicKey (uncompressed) and privateKey
 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  while (true) {
    const privateKeyBytes = secp256k1.utils.randomPrivateKey();
    const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, false);
    const publicKey = bytesToHex(publicKeyBytes);
    if (getAddressKind(getAddressFromPublicKey(publicKey)) === 'account') {
      return { privateKey: bytesToHex(privateKeyBytes), publicKey };
    }
  }
}

/**
 * Derive Ethereum address from an uncompressed public key
 * @param publicKeyHex - Hex-encoded public key (65 bytes uncompressed, may include 0x04 prefix)
 * @returns Checksummed Ethereum address (0x + 40 hex chars)
 */
export function getAddressFromPublicKey(publicKeyHex: string): EthAddress {
  // Remove 0x04 prefix if present (uncompressed key marker)
  let pubKey = publicKeyHex;
  if (pubKey.startsWith('0x') || pubKey.startsWith('0X')) {
    pubKey = pubKey.slice(2);
  }
  if (pubKey.length === 130 && pubKey.startsWith('04')) {
    pubKey = pubKey.slice(2); // Remove uncompressed marker
  }
  
  // Convert to bytes
  const pubKeyBytes = hexToBytes(pubKey);
  
  // Hash with Keccak-256
  const hash = rawKeccak256(pubKeyBytes);
  
  // Take last 20 bytes
  const addressBytes = hash.slice(-20);
  
  // Convert to hex with 0x prefix
  return ('0x' + bytesToHex(addressBytes)) as EthAddress;
}

export function getAddressFromPrivateKey(privateKeyHex: string): EthAddress {
  const privateKeyBytes = hexToBytes(normalizeSignature(privateKeyHex));
  if (privateKeyBytes.length !== 32) {
    throw new Error('Invalid private key: must be 32 bytes');
  }
  if (!secp256k1.utils.isValidPrivateKey(privateKeyBytes)) {
    throw new Error('Invalid private key: out of range or zero');
  }
  const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, false);
  return getAddressFromPublicKey(bytesToHex(publicKeyBytes));
}

export function getPublicKeyFromPrivateKey(privateKeyHex: string): string {
  const privateKeyBytes = hexToBytes(normalizeSignature(privateKeyHex));
  return bytesToHex(secp256k1.getPublicKey(privateKeyBytes, false));
}

/**
 * Validate Ethereum address format (0x + 40 hex characters)
 * @param address - String to validate
 * @returns True if valid Ethereum address format
 */
export function isValidAddress(address: string): address is EthAddress {
  if (!address || typeof address !== 'string') return false;
  
  // Must be 42 chars (0x + 40 hex)
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  
  return true;
}

/**
 * Normalize a signature by removing 0x prefix and whitespace, converting to lowercase
 * @param signature - Raw signature string
 * @returns Normalized hex signature
 */
export function normalizeSignature(signature: string): string {
  const normalized = signature.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized) && !/^[0-9a-f]{130}$/.test(normalized) && !/^[0-9a-f]{128}$/.test(normalized) && !/^[0-9a-f]{66}$/.test(normalized)) {
    throw new Error('Invalid hex string format');
  }
  return normalized;
}

/**
 * Check if signature is valid 65-byte format (r + s + recovery)
 * @param signature - Signature string to validate
 * @returns True if valid 130-character hex string
 */
export function isValidSignatureFormat(signature: string): boolean {
  if (!signature || typeof signature !== 'string') return false;
  try {
    const normalized = normalizeSignature(signature);
    // 130 hex chars = 65 bytes (r + s + recovery)
    return /^[0-9a-f]{130}$/.test(normalized);
  } catch {
    return false;
  }
}

/**
 * Sign data with a private key and return recoverable signature
 * @param data - Data to sign
 * @param privateKeyHex - Hex-encoded private key
 * @returns 65-byte signature (r || s || recovery) as hex string
 */
export function signData(data: string, privateKeyHex: string): string {
  const privateKey = hexToBytes(normalizeSignature(privateKeyHex));
  if (privateKey.length !== 32) {
    throw new Error('Invalid private key: must be 32 bytes');
  }
  if (!secp256k1.utils.isValidPrivateKey(privateKey)) {
    throw new Error('Invalid private key: out of range or zero');
  }
  const messageHash = hexToBytes(hashData(data));

  // Sign with recovery bit. ethereum-cryptography's secp256k1.sign defaults to
  // low-S form, which is required to prevent ECDSA signature malleability:
  // an attacker who observes (r, s) can produce (r, n - s) — a different but
  // still-valid signature for the same message. Enforcing low-S here means
  // tx hashes remain stable for the same payload+key.
  const signature = secp256k1.sign(messageHash, privateKey, { lowS: true });

  // Return as hex: r (32 bytes) + s (32 bytes) + recovery (1 byte)
  return signature.toCompactHex() + signature.recovery!.toString(16).padStart(2, '0');
}

// secp256k1 group order n; high-S range is (n/2, n).
const SECP256K1_HALF_N = BigInt('0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0');

function isLowS(sHex: string): boolean {
  try {
    return BigInt('0x' + sHex) <= SECP256K1_HALF_N;
  } catch {
    return false;
  }
}

/**
 * Verify a signature against data and public key
 * @param data - Original signed data
 * @param signatureHex - Hex-encoded signature
 * @param publicKeyHex - Hex-encoded public key
 * @returns True if signature is valid
 */
export function verifySignature(data: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const messageHash = hexToBytes(hashData(data));
    const publicKey = hexToBytes(normalizeSignature(publicKeyHex));

    // Parse signature (r || s || recovery)
    const sigHex = normalizeSignature(signatureHex);
    const r = sigHex.slice(0, 64);
    const s = sigHex.slice(64, 128);

    // Reject high-S signatures to prevent malleability — see signData.
    if (!isLowS(s)) {
      return false;
    }

    // Create signature object
    const signature = secp256k1.Signature.fromCompact(r + s);

    return secp256k1.verify(signature, messageHash, publicKey);
  } catch (e) {
    return false;
  }
}

/**
 * Recover public key from signature and data
 * @param data - Original signed data
 * @param signatureHex - Hex-encoded signature with recovery bit
 * @returns Recovered public key or null if recovery fails
 */
export function recoverPublicKey(data: string, signatureHex: string): string | null {
  try {
    const messageHash = hexToBytes(hashData(data));
    const sigHex = normalizeSignature(signatureHex);

    // Parse r, s, recovery
    const r = sigHex.slice(0, 64);
    const s = sigHex.slice(64, 128);
    const recovery = parseInt(sigHex.slice(128, 130), 16);

    // Reject high-S signatures to prevent malleability — see signData.
    if (!isLowS(s)) {
      return null;
    }

    // Create signature with recovery
    const signature = secp256k1.Signature.fromCompact(r + s).addRecoveryBit(recovery);

    // Recover public key
    const publicKey = signature.recoverPublicKey(messageHash);

    return publicKey.toHex(false); // uncompressed
  } catch (e) {
    return null;
  }
}

/**
 * Verify signature, recover public key, and validate against claimed address
 * @param data - Original signed data
 * @param signatureHex - Hex-encoded signature
 * @param claimedAddress - Address claimed to have signed the data
 * @returns Object with publicKey and address if valid, null otherwise
 */
export function verifyAndRecover(data: string, signatureHex: string, claimedAddress: EthAddress): { publicKey: string; address: EthAddress } | null {
  const publicKey = recoverPublicKey(data, signatureHex);
  if (!publicKey || !verifySignature(data, signatureHex, publicKey)) {
    return null;
  }
  const address = getAddressFromPublicKey(publicKey);
  if (address.toLowerCase() !== claimedAddress.toLowerCase()) {
    return null;
  }
  return { publicKey, address };
}

function toKeccakInput(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

export function keccak256Hex(data: string | Uint8Array | ArrayBuffer): string {
  return bytesToHex(rawKeccak256(toKeccakInput(data)));
}

export function ecrecoverAddress(data: string, signatureHex: string): EthAddress | null {
  const publicKey = recoverPublicKey(data, signatureHex);
  if (!publicKey) {
    return null;
  }
  return getAddressFromPublicKey(publicKey);
}

/**
 * Hash data using Keccak-256
 * @param data - String to hash
 * @returns 32-byte hash as hex string
 */
export function hashData(data: string): string {
  return keccak256Hex(data);
}

/**
 * Derive deterministic top-level contract address from deployer, salt, and code hash.
 * @param deployer - Deployer address
 * @param salt - Explicit deploy salt
 * @param code - Contract source code
 * @returns Deterministic contract address
 */
export function deriveContractAddress(
  deployer: EthAddress | string,
  salt: string,
  code: string,
): EthAddress {
  const codeHash = hashData(code);
  return (`0xc0${hashData(`riadchain:deploy:v1:${String(deployer).toLowerCase()}:${salt}:${codeHash}`).slice(-38)}`) as EthAddress;
}

/**
 * Derive an address for an *upgradeable* contract. Unlike the immutable
 * derivation, the code hash is NOT part of the address — this is the price of
 * making the contract's bytecode mutable. Anyone reasoning about the address
 * must look up the current code via state, not derive it from the address.
 *
 * The "upgradeable" salt namespace is separated from the immutable one so
 * the two address spaces cannot collide.
 */
export function deriveUpgradeableContractAddress(
  deployer: EthAddress | string,
  salt: string,
): EthAddress {
  return (`0xc0${hashData(`riadchain:deploy-upgradeable:v1:${String(deployer).toLowerCase()}:${salt}`).slice(-38)}`) as EthAddress;
}

export function deriveInternalContractAddress(
  parentContractAddress: EthAddress | string,
  salt: string,
  code: string,
): EthAddress {
  const codeHash = hashData(code);
  return (`0xc1${hashData(`riadchain:internal-deploy:v1:${String(parentContractAddress).toLowerCase()}:${salt}:${codeHash}`).slice(-38)}`) as EthAddress;
}

/** Native address namespace marker used by top-level contract deployments. */
export function isTopLevelContractAddress(address: string): boolean {
  return /^0xc0[0-9a-f]{38}$/i.test(address);
}

/** Native address namespace marker used by contracts deployed by contracts. */
export function isInternalContractAddress(address: string): boolean {
  return /^0xc1[0-9a-f]{38}$/i.test(address);
}

/** Classify an address using Riadchain's protocol-reserved contract prefixes. */
export function getAddressKind(address: string): 'account' | 'contract' | 'internal_contract' | 'system_contract' {
  if ([
    '0x0000000000000000000000000000000000001000',
    '0x0000000000000000000000000000000000001001',
    '0x0000000000000000000000000000000000001002',
  ].includes(address.toLowerCase())) return 'system_contract';
  if (isTopLevelContractAddress(address)) return 'contract';
  if (isInternalContractAddress(address)) return 'internal_contract';
  return 'account';
}

/** Whether an address is allowed to act as a transaction signer. */
export function isAccountAddress(address: string): boolean {
  return isValidAddress(address) && getAddressKind(address) === 'account';
}

// Convert hex string to bytes
export { hexToBytes, bytesToHex };
