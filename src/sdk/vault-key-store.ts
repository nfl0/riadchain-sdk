import fs from 'node:fs';
import path from 'node:path';
import { generateVaultMasterKey, VAULT_ALGORITHM, type VaultMasterKey } from './vault-crypto.ts';

const MAX_KEY_FILE_BYTES = 4_096;
const KEY_FILE_KEYS = ['algorithm', 'key', 'keyId', 'v'];

function keyBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{3}=)$/.test(value)) {
    throw new Error('Vault master key file contains invalid canonical base64');
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
  if (bytes.length !== 32 || Buffer.from(bytes).toString('base64') !== value) {
    throw new Error('Vault master key file must contain exactly 32 key bytes');
  }
  return bytes;
}

function parseKeyFile(encoded: string): VaultMasterKey {
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new Error('Vault master key file is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Vault master key file is malformed');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== KEY_FILE_KEYS.length || keys.some((key, index) => key !== KEY_FILE_KEYS[index])
    || record.v !== 1 || record.algorithm !== VAULT_ALGORITHM || typeof record.keyId !== 'string'
    || !/^[0-9a-f]{32}$/.test(record.keyId) || typeof record.key !== 'string') {
    throw new Error('Vault master key file has an unsupported format');
  }
  return { algorithm: VAULT_ALGORITHM, keyId: record.keyId, key: keyBytes(record.key) };
}

function keyFileFlags(mode: 'read' | 'create'): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  return mode === 'read'
    ? fs.constants.O_RDONLY | noFollow
    : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
}

export function loadVaultMasterKeyFile(filePath: string): VaultMasterKey {
  if (!path.isAbsolute(filePath) || filePath.includes('\0')) throw new Error('Vault master key path must be absolute');
  const descriptor = fs.openSync(filePath, keyFileFlags('read'));
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile() || (status.mode & 0o077) !== 0 || status.size < 2 || status.size > MAX_KEY_FILE_BYTES) {
      throw new Error('Vault master key file must be a private regular file of bounded size');
    }
    if (typeof process.getuid === 'function' && status.uid !== process.getuid()) {
      throw new Error('Vault master key file must be owned by the current user');
    }
    const encoded = fs.readFileSync(descriptor, 'utf8');
    return parseKeyFile(encoded);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function createVaultMasterKeyFile(filePath: string): VaultMasterKey {
  if (!path.isAbsolute(filePath) || filePath.includes('\0')) throw new Error('Vault master key path must be absolute');
  const parent = fs.statSync(path.dirname(filePath));
  if (!parent.isDirectory()) throw new Error('Vault master key parent must be a directory');
  const key = generateVaultMasterKey();
  const encoded = `${JSON.stringify({
    v: 1,
    algorithm: key.algorithm,
    keyId: key.keyId,
    key: Buffer.from(key.key).toString('base64'),
  })}\n`;
  const descriptor = fs.openSync(filePath, keyFileFlags('create'), 0o600);
  try {
    fs.writeFileSync(descriptor, encoded, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const directory = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return key;
}
