import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { getPublicKey, getSharedSecret, utils as secpUtils } from '@noble/secp256k1';

export type ChatIdentity = {
  privateKey: string;
  publicKey: string;
  sessionPrivateKey?: string;
  capabilities?: Record<string, { capabilityId: string; expiresAtHeight: number }>;
};

type PayloadKind = 'attachment' | 'message';
type PayloadEnvelope = {
  v: 2;
  kind: PayloadKind;
  nonce: string;
  data: string;
};
type KeyEnvelope = {
  v: 2;
  epk: string;
  nonce: string;
  data: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const PAYLOAD_KEYS = ['data', 'kind', 'nonce', 'v'];
const KEY_ENVELOPE_KEYS = ['data', 'epk', 'nonce', 'v'];
const PAYLOAD_DOMAIN = 'riadchat-payload-v2';
const KEY_DOMAIN = 'riadchat-conversation-key-v2';
const MAX_MESSAGE_PLAINTEXT_BYTES = 6_000;
const MAX_MESSAGE_ENVELOPE_LENGTH = 8_192;
const MAX_ATTACHMENT_PLAINTEXT_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_ENVELOPE_LENGTH = 2_800_000;
const MAX_KEY_ENVELOPE_LENGTH = 2_048;
const PRIVATE_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const COMPRESSED_PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-f]{64}$/i;

let randomSource = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

export function configureChatRandomSource(source: (length: number) => Uint8Array): void {
  if (typeof source !== 'function') throw new Error('Chat random source must be a function');
  randomSource = (length) => {
    const bytes = source(length);
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
      throw new Error('Chat random source returned an invalid byte sequence');
    }
    return bytes.slice();
  };
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length <= 0 || length > 65_536) {
    throw new Error('Chat random byte length is invalid');
  }
  return randomSource(length);
}

export function bytesToHex(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new Error('Hex input must be bytes');
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(value: string, maximumBytes = 4_096): Uint8Array {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumBytes * 2
    || !/^(?:[0-9a-f]{2})+$/i.test(value)
  ) {
    throw new Error('Invalid bounded hexadecimal data');
  }
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new Error('Base64 input must be bytes');
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

export function base64ToBytes(value: string, maximumBytes = 64): Uint8Array {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || value.length > Math.ceil(maximumBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Value is not bounded canonical base64');
  }
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('Value is not bounded canonical base64');
  }
  if (decoded.length > maximumBytes || bytesToBase64(decoded) !== value) {
    throw new Error('Value is not bounded canonical base64');
  }
  return decoded;
}

function privateKeyBytes(value: string): Uint8Array {
  if (!PRIVATE_KEY_PATTERN.test(value)) throw new Error('Invalid chat private key');
  const bytes = hexToBytes(value, 32);
  if (!secpUtils.isValidSecretKey(bytes)) throw new Error('Invalid chat private key');
  return bytes;
}

function publicKeyBytes(value: string): Uint8Array {
  if (!COMPRESSED_PUBLIC_KEY_PATTERN.test(value)) throw new Error('Invalid chat public key');
  const bytes = hexToBytes(value, 33);
  if (!secpUtils.isValidPublicKey(bytes)) throw new Error('Invalid chat public key');
  return bytes;
}

function encryptionKey(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error('Chat encryption keys must contain exactly 32 bytes');
  }
  return value;
}

function randomPrivateKey(): Uint8Array {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const candidate = randomBytes(32);
    if (secpUtils.isValidSecretKey(candidate)) return candidate;
  }
  throw new Error('Chat random source could not produce a valid private key');
}

export function createChatIdentity(): ChatIdentity {
  const privateKey = randomPrivateKey();
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(getPublicKey(privateKey, true)),
  };
}

export function publicKeyFor(privateKey: string): string {
  return bytesToHex(getPublicKey(privateKeyBytes(privateKey), true));
}

export function createConversationKey(): Uint8Array {
  return randomBytes(32);
}

export function inviteCommitment(token: string): string {
  if (typeof token !== 'string' || token.length < 20 || token.length > 256) {
    throw new Error('Invalid invite token');
  }
  return bytesToHex(sha256(encoder.encode(`riadchat-invite-v1:${token}`)));
}

function keyAssociatedData(ephemeralPublicKey: string, recipientPublicKey: string): Uint8Array {
  return encoder.encode(
    `${KEY_DOMAIN}\0${ephemeralPublicKey.toLowerCase()}\0${recipientPublicKey.toLowerCase()}`,
  );
}

function sharedKey(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  associatedData: Uint8Array,
): Uint8Array {
  return hkdf(
    sha256,
    getSharedSecret(privateKey, publicKey, true),
    encoder.encode(`${KEY_DOMAIN}:salt`),
    associatedData,
    32,
  );
}

export function encryptKeyFor(publicKey: string, key: Uint8Array): string {
  const recipientPublicKey = publicKeyBytes(publicKey);
  const recipientPublicKeyHex = bytesToHex(recipientPublicKey);
  const ephemeralPrivateKey = randomPrivateKey();
  const ephemeralPublicKey = bytesToHex(getPublicKey(ephemeralPrivateKey, true));
  const nonce = randomBytes(12);
  const aad = keyAssociatedData(ephemeralPublicKey, recipientPublicKeyHex);
  const data = gcm(
    sharedKey(ephemeralPrivateKey, recipientPublicKey, aad),
    nonce,
    aad,
  ).encrypt(encryptionKey(key));
  const encoded = JSON.stringify({
    v: 2,
    epk: ephemeralPublicKey,
    nonce: bytesToBase64(nonce),
    data: bytesToBase64(data),
  } satisfies KeyEnvelope);
  if (encoded.length > MAX_KEY_ENVELOPE_LENGTH) {
    throw new Error('Chat key envelope exceeds its size limit');
  }
  return encoded;
}

export function decryptKeyEnvelope(privateKey: string, encoded: string): Uint8Array {
  if (
    typeof encoded !== 'string'
    || encoded.length === 0
    || encoded.length > MAX_KEY_ENVELOPE_LENGTH
  ) {
    throw new Error('Chat key envelope exceeds its size limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error('Chat key envelope is malformed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chat key envelope is malformed');
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).sort().join(',') !== KEY_ENVELOPE_KEYS.join(',')
    || envelope.v !== 2
    || typeof envelope.epk !== 'string'
    || typeof envelope.nonce !== 'string'
    || typeof envelope.data !== 'string'
  ) {
    throw new Error('Chat key envelope has an unsupported format');
  }
  const recipientPrivateKey = privateKeyBytes(privateKey);
  const recipientPublicKey = bytesToHex(getPublicKey(recipientPrivateKey, true));
  const ephemeralPublicKey = publicKeyBytes(envelope.epk);
  const nonce = base64ToBytes(envelope.nonce, 12);
  const data = base64ToBytes(envelope.data, 48);
  if (nonce.length !== 12 || data.length !== 48) {
    throw new Error('Chat key envelope has invalid field lengths');
  }
  const aad = keyAssociatedData(envelope.epk, recipientPublicKey);
  try {
    const key = gcm(
      sharedKey(recipientPrivateKey, ephemeralPublicKey, aad),
      nonce,
      aad,
    ).decrypt(data);
    return encryptionKey(key);
  } catch {
    throw new Error('Chat key envelope authentication failed');
  }
}

function payloadAssociatedData(kind: PayloadKind): Uint8Array {
  return encoder.encode(`${PAYLOAD_DOMAIN}:${kind}`);
}

function parsePayloadEnvelope(
  encoded: string,
  expectedKind: PayloadKind,
  maximumEnvelopeLength: number,
  maximumPlaintextBytes: number,
): { nonce: Uint8Array; data: Uint8Array } {
  if (
    typeof encoded !== 'string'
    || encoded.length === 0
    || encoded.length > maximumEnvelopeLength
  ) {
    throw new Error('Encrypted payload exceeds its size limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error('Encrypted payload is malformed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Encrypted payload is malformed');
  }
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).sort().join(',') !== PAYLOAD_KEYS.join(',')
    || payload.v !== 2
    || payload.kind !== expectedKind
    || typeof payload.nonce !== 'string'
    || typeof payload.data !== 'string'
  ) {
    throw new Error('Encrypted payload has an unsupported format');
  }
  const nonce = base64ToBytes(payload.nonce, 12);
  if (nonce.length !== 12) throw new Error('Encrypted payload nonce must be 96 bits');
  const data = base64ToBytes(payload.data, maximumPlaintextBytes + 16);
  if (data.length < 16 || data.length > maximumPlaintextBytes + 16) {
    throw new Error('Encrypted payload exceeds its size limit');
  }
  return { nonce, data };
}

function encryptPayload(
  key: Uint8Array,
  plaintext: Uint8Array,
  kind: PayloadKind,
  maximumPlaintextBytes: number,
  maximumEnvelopeLength: number,
): string {
  encryptionKey(key);
  if (!(plaintext instanceof Uint8Array) || plaintext.length > maximumPlaintextBytes) {
    throw new Error(`${kind} plaintext exceeds its size limit`);
  }
  const nonce = randomBytes(12);
  const data = gcm(key, nonce, payloadAssociatedData(kind)).encrypt(plaintext);
  const encoded = JSON.stringify({
    v: 2,
    kind,
    nonce: bytesToBase64(nonce),
    data: bytesToBase64(data),
  } satisfies PayloadEnvelope);
  if (encoded.length > maximumEnvelopeLength) {
    throw new Error(`${kind} ciphertext exceeds its on-chain size limit`);
  }
  return encoded;
}

function decryptPayload(
  key: Uint8Array,
  encoded: string,
  kind: PayloadKind,
  maximumPlaintextBytes: number,
  maximumEnvelopeLength: number,
): Uint8Array {
  encryptionKey(key);
  const { nonce, data } = parsePayloadEnvelope(
    encoded,
    kind,
    maximumEnvelopeLength,
    maximumPlaintextBytes,
  );
  try {
    return gcm(key, nonce, payloadAssociatedData(kind)).decrypt(data);
  } catch {
    throw new Error('Encrypted payload authentication failed');
  }
}

export function encryptChatBytes(key: Uint8Array, plaintext: Uint8Array): string {
  return encryptPayload(
    key,
    plaintext,
    'attachment',
    MAX_ATTACHMENT_PLAINTEXT_BYTES,
    MAX_ATTACHMENT_ENVELOPE_LENGTH,
  );
}

export function decryptChatBytes(key: Uint8Array, encoded: string): Uint8Array {
  return decryptPayload(
    key,
    encoded,
    'attachment',
    MAX_ATTACHMENT_PLAINTEXT_BYTES,
    MAX_ATTACHMENT_ENVELOPE_LENGTH,
  );
}

export function encryptChatJson(key: Uint8Array, value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Message payload is not serializable');
  }
  if (serialized === undefined) throw new Error('Message payload is not serializable');
  return encryptPayload(
    key,
    encoder.encode(serialized),
    'message',
    MAX_MESSAGE_PLAINTEXT_BYTES,
    MAX_MESSAGE_ENVELOPE_LENGTH,
  );
}

export function decryptChatJson<T = unknown>(key: Uint8Array, encoded: string): T {
  const plaintext = decryptPayload(
    key,
    encoded,
    'message',
    MAX_MESSAGE_PLAINTEXT_BYTES,
    MAX_MESSAGE_ENVELOPE_LENGTH,
  );
  try {
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    throw new Error('Message payload is not valid UTF-8 JSON');
  }
}

export function guestAddress(privateKey: string): string {
  const publicKey = getPublicKey(privateKeyBytes(privateKey), false).slice(1);
  return `0x${bytesToHex(keccak_256(publicKey).slice(-20))}`;
}
