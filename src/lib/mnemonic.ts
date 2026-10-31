import {
  generateMnemonic as generateBip39Mnemonic,
  entropyToMnemonic,
  mnemonicToSeedSync,
  validateMnemonic as validateBip39Mnemonic,
} from 'ethereum-cryptography/bip39/index.js';
import { wordlist as englishWordlist } from 'ethereum-cryptography/bip39/wordlists/english.js';
import { HDKey } from 'ethereum-cryptography/hdkey.js';
import { bytesToHex } from 'ethereum-cryptography/utils.js';
import { getAddressFromPrivateKey, getPublicKeyFromPrivateKey, type EthAddress } from './crypto.ts';

export const DEFAULT_MNEMONIC_WORD_COUNT = 12;
export const DEFAULT_HD_PATH_PREFIX = "m/44'/60'/0'/0";

type DerivedMnemonicAccount = {
  index: number;
  path: string;
  privateKey: string;
  publicKey: string;
  address: EthAddress;
};

function mnemonicWordCountToStrength(wordCount: number): number {
  switch (wordCount) {
    case 12: return 128;
    case 15: return 160;
    case 18: return 192;
    case 21: return 224;
    case 24: return 256;
    default:
      throw new Error('Mnemonic word count must be one of 12, 15, 18, 21, or 24');
  }
}

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

function assertValidIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('Mnemonic account index must be a non-negative integer');
  }
}

export function buildMnemonicDerivationPath(
  index: number,
  pathPrefix = DEFAULT_HD_PATH_PREFIX,
): string {
  assertValidIndex(index);
  return `${pathPrefix}/${index}`;
}

export function generateMnemonic(wordCount = DEFAULT_MNEMONIC_WORD_COUNT): string {
  return generateBip39Mnemonic(englishWordlist, mnemonicWordCountToStrength(wordCount));
}

export function mnemonicFromEntropy(entropy: Uint8Array): string {
  if (![16, 20, 24, 28, 32].includes(entropy.byteLength)) {
    throw new Error('Mnemonic entropy must be 16, 20, 24, 28, or 32 bytes');
  }
  return entropyToMnemonic(entropy, englishWordlist);
}

export function validateMnemonic(mnemonic: string): boolean {
  try {
    return validateBip39Mnemonic(normalizeMnemonic(mnemonic), englishWordlist);
  } catch {
    return false;
  }
}

export function mnemonicToSeedHex(mnemonic: string, passphrase = ''): string {
  return bytesToHex(mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase));
}

export function derivePrivateKeyFromMnemonic(
  mnemonic: string,
  index = 0,
  options: { passphrase?: string; pathPrefix?: string } = {},
): string {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized)) {
    throw new Error('Invalid mnemonic');
  }
  const seed = mnemonicToSeedSync(normalized, options.passphrase ?? '');
  const hdKey = HDKey.fromMasterSeed(seed);
  const derived = hdKey.derive(buildMnemonicDerivationPath(index, options.pathPrefix));
  if (!derived.privateKey) {
    throw new Error('Unable to derive child private key from mnemonic');
  }
  return bytesToHex(derived.privateKey);
}

export function deriveAccountFromMnemonic(
  mnemonic: string,
  index = 0,
  options: { passphrase?: string; pathPrefix?: string } = {},
): DerivedMnemonicAccount {
  const privateKey = derivePrivateKeyFromMnemonic(mnemonic, index, options);
  const path = buildMnemonicDerivationPath(index, options.pathPrefix);
  return {
    index,
    path,
    privateKey,
    publicKey: getPublicKeyFromPrivateKey(privateKey),
    address: getAddressFromPrivateKey(privateKey),
  };
}

export function deriveAccountsFromMnemonic(
  mnemonic: string,
  count: number,
  options: { passphrase?: string; pathPrefix?: string; startIndex?: number } = {},
): DerivedMnemonicAccount[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('Mnemonic account count must be a positive integer');
  }
  const startIndex = options.startIndex ?? 0;
  assertValidIndex(startIndex);
  return Array.from({ length: count }, (_, offset) => deriveAccountFromMnemonic(
    mnemonic,
    startIndex + offset,
    options,
  ));
}
