import { gcm } from '@noble/ciphers/aes.js';

export const VAULT_ALGORITHM = 'aes-256-gcm-v1' as const;
export const VAULT_MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;

export type VaultMasterKey = {
  algorithm: typeof VAULT_ALGORITHM;
  keyId: string;
  key: Uint8Array;
};
export type VaultKeyEnvelope = { keyId: string; wrapNonce: string; wrappedKey: string };
export type VaultObjectBinding = {
  objectId: string;
  label: string;
  filename: string;
  mimeType: string;
  plaintextSize: number;
  encryptedSize?: number;
};
export type PreparedVaultObject = VaultObjectBinding & {
  algorithm: typeof VAULT_ALGORITHM;
  encryptedSize: number;
  blob: string;
  keyEnvelope: VaultKeyEnvelope;
};

const encoder = new TextEncoder();
const BLOB_KEYS = ['algorithm', 'ciphertext', 'filename', 'label', 'mimeType', 'nonce', 'objectId', 'plaintextSize', 'v'];
const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const DATA_KEY_BYTES = 32;
const TAG_BYTES = 16;

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  globalThis.crypto.getRandomValues(value);
  return value;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string, expectedBytes: number): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || value.length > Math.ceil(expectedBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Vault envelope contains invalid canonical base64');
  }
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
  catch { throw new Error('Vault envelope contains invalid canonical base64'); }
  if (bytes.length !== expectedBytes || bytesToBase64(bytes) !== value) {
    throw new Error('Vault envelope field length is invalid');
  }
  return bytes;
}

function keyId(value: string): string {
  if (!/^[0-9a-f]{32}$/.test(value)) throw new Error('Vault key ID must be 32 lowercase hex characters');
  return value;
}

function objectId(value: string): string {
  if (!/^[0-9a-f]{32}$/.test(value)) throw new Error('Vault object ID must be 32 lowercase hex characters');
  return value;
}

function masterKey(value: VaultMasterKey): Uint8Array {
  if (value.algorithm !== VAULT_ALGORITHM || !(value.key instanceof Uint8Array) || value.key.length !== MASTER_KEY_BYTES) {
    throw new Error('Vault master key must be an AES-256-GCM key');
  }
  keyId(value.keyId);
  return value.key;
}

function boundedText(value: string, label: string, maximum: number, trim: boolean): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = trim ? value.trim() : value;
  const bytes = encoder.encode(normalized);
  if (bytes.length === 0 || bytes.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} must contain 1-${maximum} safe UTF-8 bytes`);
  }
  return normalized;
}

function filename(value: string): string {
  const normalized = boundedText(value, 'Vault filename', 255, true);
  if (/[\\/]/u.test(normalized) || normalized === '.' || normalized === '..') throw new Error('Vault filename is unsafe');
  return normalized;
}

function mimeType(value: string): string {
  const normalized = boundedText(value, 'Vault MIME type', 127, true).toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)) {
    throw new Error('Vault MIME type must be canonical type/subtype');
  }
  return normalized;
}

function normalizeBinding(value: VaultObjectBinding): VaultObjectBinding {
  if (!Number.isSafeInteger(value.plaintextSize) || value.plaintextSize < 1 || value.plaintextSize > VAULT_MAX_PLAINTEXT_BYTES) {
    throw new Error(`Vault plaintext must contain 1-${VAULT_MAX_PLAINTEXT_BYTES} bytes`);
  }
  if (value.encryptedSize !== undefined && (!Number.isSafeInteger(value.encryptedSize) || value.encryptedSize < 1)) {
    throw new Error('Vault encrypted size must be a positive safe integer');
  }
  return {
    objectId: objectId(value.objectId),
    label: boundedText(value.label, 'Vault label', 128, true),
    filename: filename(value.filename),
    mimeType: mimeType(value.mimeType),
    plaintextSize: value.plaintextSize,
    ...(value.encryptedSize === undefined ? {} : { encryptedSize: value.encryptedSize }),
  };
}

export function normalizeVaultObjectBinding(value: VaultObjectBinding): VaultObjectBinding {
  return normalizeBinding(value);
}

function dataAad(value: VaultObjectBinding): Uint8Array {
  const binding = normalizeBinding(value);
  return encoder.encode(JSON.stringify({
    domain: 'riadchain-household-vault-data-v1',
    objectId: binding.objectId,
    label: binding.label,
    filename: binding.filename,
    mimeType: binding.mimeType,
    plaintextSize: binding.plaintextSize,
  }));
}

function wrapAad(objectIdValue: string, keyIdValue: string): Uint8Array {
  return encoder.encode(JSON.stringify({
    domain: 'riadchain-household-vault-key-v1',
    objectId: objectId(objectIdValue),
    keyId: keyId(keyIdValue),
  }));
}

function wrapDataKey(objectIdValue: string, dataKey: Uint8Array, recipient: VaultMasterKey): VaultKeyEnvelope {
  const recipientKey = masterKey(recipient);
  if (!(dataKey instanceof Uint8Array) || dataKey.length !== DATA_KEY_BYTES) throw new Error('Vault data key is invalid');
  const nonce = randomBytes(NONCE_BYTES);
  const wrapped = gcm(recipientKey, nonce, wrapAad(objectIdValue, recipient.keyId)).encrypt(dataKey);
  return { keyId: recipient.keyId, wrapNonce: bytesToBase64(nonce), wrappedKey: bytesToBase64(wrapped) };
}

function unwrapDataKey(objectIdValue: string, envelope: VaultKeyEnvelope, recipient: VaultMasterKey): Uint8Array {
  const recipientKey = masterKey(recipient);
  if (keyId(envelope.keyId) !== recipient.keyId) throw new Error('Vault object belongs to another local master key');
  const nonce = base64ToBytes(envelope.wrapNonce, NONCE_BYTES);
  const wrapped = base64ToBytes(envelope.wrappedKey, DATA_KEY_BYTES + TAG_BYTES);
  try {
    const key = gcm(recipientKey, nonce, wrapAad(objectIdValue, recipient.keyId)).decrypt(wrapped);
    if (key.length !== DATA_KEY_BYTES) throw new Error('length');
    return key;
  } catch {
    throw new Error('Vault key envelope authentication failed');
  }
}

export function generateVaultMasterKey(): VaultMasterKey {
  return { algorithm: VAULT_ALGORITHM, keyId: bytesToHex(randomBytes(16)), key: randomBytes(MASTER_KEY_BYTES) };
}

export function encryptVaultObject(
  plaintext: Uint8Array,
  input: { label: string; filename: string; mimeType: string; objectId?: string },
  recipient: VaultMasterKey,
): PreparedVaultObject {
  masterKey(recipient);
  if (!(plaintext instanceof Uint8Array) || plaintext.length < 1 || plaintext.length > VAULT_MAX_PLAINTEXT_BYTES) {
    throw new Error(`Vault plaintext must contain 1-${VAULT_MAX_PLAINTEXT_BYTES} bytes`);
  }
  const binding = normalizeBinding({
    objectId: input.objectId ?? bytesToHex(randomBytes(16)),
    label: input.label,
    filename: input.filename,
    mimeType: input.mimeType,
    plaintextSize: plaintext.length,
  });
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const ciphertext = gcm(dataKey, nonce, dataAad(binding)).encrypt(plaintext);
    const blob = JSON.stringify({
      v: 1,
      algorithm: VAULT_ALGORITHM,
      objectId: binding.objectId,
      label: binding.label,
      filename: binding.filename,
      mimeType: binding.mimeType,
      plaintextSize: binding.plaintextSize,
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(ciphertext),
    });
    return {
      ...binding,
      algorithm: VAULT_ALGORITHM,
      encryptedSize: encoder.encode(blob).length,
      blob,
      keyEnvelope: wrapDataKey(binding.objectId, dataKey, recipient),
    };
  } finally {
    dataKey.fill(0);
  }
}

function parseBlob(blob: string, expected: VaultObjectBinding): { nonce: Uint8Array; ciphertext: Uint8Array } {
  if (typeof blob !== 'string' || encoder.encode(blob).length > Math.ceil(VAULT_MAX_PLAINTEXT_BYTES * 4 / 3) + 4_096) {
    throw new Error('Encrypted vault FILE exceeds its bound');
  }
  let value: unknown;
  try { value = JSON.parse(blob); } catch { throw new Error('Encrypted vault FILE is malformed'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Encrypted vault FILE is malformed');
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.length !== BLOB_KEYS.length || actualKeys.some((key, index) => key !== BLOB_KEYS[index])
    || record.v !== 1 || record.algorithm !== VAULT_ALGORITHM || typeof record.nonce !== 'string'
    || typeof record.ciphertext !== 'string' || typeof record.objectId !== 'string'
    || typeof record.label !== 'string' || typeof record.filename !== 'string'
    || typeof record.mimeType !== 'string' || !Number.isSafeInteger(record.plaintextSize)) {
    throw new Error('Encrypted vault FILE has an unsupported format');
  }
  const binding = normalizeBinding({
    objectId: record.objectId, label: record.label, filename: record.filename,
    mimeType: record.mimeType, plaintextSize: record.plaintextSize as number,
  });
  const canonicalExpected = normalizeBinding(expected);
  if (JSON.stringify(binding) !== JSON.stringify({
    objectId: canonicalExpected.objectId,
    label: canonicalExpected.label,
    filename: canonicalExpected.filename,
    mimeType: canonicalExpected.mimeType,
    plaintextSize: canonicalExpected.plaintextSize,
  })) {
    throw new Error('Encrypted vault FILE metadata does not match the registry');
  }
  return {
    nonce: base64ToBytes(record.nonce, NONCE_BYTES),
    ciphertext: base64ToBytes(record.ciphertext, binding.plaintextSize + TAG_BYTES),
  };
}

export function decryptVaultObject(
  blob: string,
  binding: VaultObjectBinding,
  envelope: VaultKeyEnvelope,
  recipient: VaultMasterKey,
): Uint8Array {
  const normalized = normalizeBinding(binding);
  if (normalized.encryptedSize !== undefined && encoder.encode(blob).length !== normalized.encryptedSize) {
    throw new Error('Encrypted vault FILE size does not match the registry');
  }
  const parsed = parseBlob(blob, normalized);
  const dataKey = unwrapDataKey(normalized.objectId, envelope, recipient);
  try {
    const plaintext = gcm(dataKey, parsed.nonce, dataAad(normalized)).decrypt(parsed.ciphertext);
    if (plaintext.length !== normalized.plaintextSize) throw new Error('length');
    return plaintext;
  } catch {
    throw new Error('Encrypted vault FILE authentication failed');
  } finally {
    dataKey.fill(0);
  }
}

export function validatePreparedVaultObject(value: PreparedVaultObject): PreparedVaultObject {
  if (value.algorithm !== VAULT_ALGORITHM || encoder.encode(value.blob).length !== value.encryptedSize) {
    throw new Error('Prepared vault object algorithm or size is inconsistent');
  }
  const binding = normalizeBinding(value);
  parseBlob(value.blob, binding);
  keyId(value.keyEnvelope.keyId);
  base64ToBytes(value.keyEnvelope.wrapNonce, NONCE_BYTES);
  base64ToBytes(value.keyEnvelope.wrappedKey, DATA_KEY_BYTES + TAG_BYTES);
  return value;
}

export function rewrapVaultKey(
  objectIdValue: string,
  envelope: VaultKeyEnvelope,
  previous: VaultMasterKey,
  next: VaultMasterKey,
): VaultKeyEnvelope {
  if (previous.keyId === next.keyId) throw new Error('Vault rotation requires a different key ID');
  const dataKey = unwrapDataKey(objectIdValue, envelope, previous);
  try { return wrapDataKey(objectIdValue, dataKey, next); }
  finally { dataKey.fill(0); }
}
