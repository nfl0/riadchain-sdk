import { Encoder } from 'cbor-x';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { normalizeCanonicalContractValue, type ContractValue } from '../lib/contractValueCodec.ts';
import { DEFAULT_VM_LIMITS, type VmLimits } from '../lib/protocolParams.ts';

/** Selected execution limits. maxStringChars measures UTF-8 bytes, including encoded strings. */
export type TypedDataOptions = {
  limits?: Pick<VmLimits, 'maxStringChars' | 'maxArrayLength' | 'maxBigIntBits'>;
};

type ValueLimits = NonNullable<TypedDataOptions['limits']>;
type BinaryValue =
  | [0]
  | [1, boolean]
  | [2, boolean, Uint8Array]
  | [3, string]
  | [4, BinaryValue[]]
  | [5, Map<string, BinaryValue>];

const MAX_CANONICAL_BYTES = 65_536;
const HARD_LIMITS: ValueLimits = { maxStringChars: 1_000_000, maxArrayLength: 100_000, maxBigIntBits: 65_536 };
const UTF8 = new TextEncoder();
// ignoreBOM preserves the U+FEFF byte sequence rather than silently stripping it.
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const TYPED_PREFIX = UTF8.encode('riadchain/typed-data/v1\0');
const VALUE_ENCODER = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false, structuredClone: false });

function limits(options?: TypedDataOptions): ValueLimits {
  const selected = options?.limits ?? DEFAULT_VM_LIMITS;
  for (const name of Object.keys(HARD_LIMITS) as Array<keyof ValueLimits>) {
    if (!Number.isSafeInteger(selected[name]) || selected[name] < 1 || selected[name] > HARD_LIMITS[name])
      throw new Error(`Invalid typed data limit: ${name}`);
  }
  return selected;
}

function stringInput(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string') throw new Error('Expected a string');
  if (value.length > maximum) throw new Error('String byte limit exceeded');
}

function utf8Bytes(value: unknown, maximum: number): Uint8Array {
  stringInput(value, maximum);
  const bytes = UTF8.encode(value);
  if (bytes.length > maximum) throw new Error('String byte limit exceeded');
  if (UTF8_DECODER.decode(bytes) !== value) throw new Error('Text must contain well-formed Unicode');
  return bytes;
}

function outputLength(length: number, maximum: number): void {
  if (length > maximum) throw new Error('String output byte limit exceeded');
}

function canonicalHex(value: unknown, maximum: number): Uint8Array {
  stringInput(value, maximum);
  if (value.length % 2 || !/^[0-9a-f]*$/.test(value))
    throw new Error('Expected canonical lowercase even-length hex without 0x');
  return hexToBytes(value);
}

function checkValue(value: ContractValue, selected: ValueLimits): void {
  if (typeof value === 'string') { utf8Bytes(value, selected.maxStringChars); return; }
  if (typeof value === 'bigint' || typeof value === 'number') {
    const integer = BigInt(value);
    const bits = integer === 0n ? 0 : (integer < 0n ? -integer : integer).toString(2).length;
    if (bits > selected.maxBigIntBits) throw new Error('Contract integer bit limit exceeded');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  const entries = Array.isArray(value) ? value : Object.entries(value);
  if (entries.length > selected.maxArrayLength) throw new Error('Contract container limit exceeded');
  if (Array.isArray(value)) {
    for (const item of value) checkValue(item, selected);
  } else {
    for (const [key, item] of Object.entries(value)) {
      utf8Bytes(key, selected.maxStringChars);
      checkValue(item, selected);
    }
  }
}

function normalizedValue(value: unknown, selected: ValueLimits): ContractValue {
  const normalized = normalizeCanonicalContractValue(value);
  checkValue(normalized, selected);
  return normalized;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

// CBOR is written by the established encoder. This preflight counts its exact
// fixed tagged layout so oversized values stop before building a large encoding.
function cborHeaderBytes(length: number): number {
  return length < 24 ? 1 : length <= 0xff ? 2 : length <= 0xffff ? 3 : 5;
}

function encodeNormalized(value: ContractValue): Uint8Array {
  let byteCount = 0;
  const add = (count: number) => {
    byteCount += count;
    if (byteCount > MAX_CANONICAL_BYTES) throw new Error('Canonical contract value exceeds 65536 bytes');
  };
  const visit = (entry: ContractValue): BinaryValue => {
    if (entry === null) { add(2); return [0]; }
    if (typeof entry === 'boolean') { add(3); return [1, entry]; }
    if (typeof entry === 'number' || typeof entry === 'bigint') {
      const integer = BigInt(entry);
      const magnitude = integer < 0n ? -integer : integer;
      const hex = magnitude.toString(16);
      const bytes = magnitude === 0n ? new Uint8Array() : hexToBytes(hex.length % 2 ? `0${hex}` : hex);
      add(3 + cborHeaderBytes(bytes.length) + bytes.length);
      return [2, integer < 0n, bytes];
    }
    if (typeof entry === 'string') {
      const size = UTF8.encode(entry).length;
      add(2 + cborHeaderBytes(size) + size);
      return [3, entry];
    }
    if (Array.isArray(entry)) {
      add(2 + cborHeaderBytes(entry.length));
      return [4, entry.map(visit)];
    }
    const entries = Object.entries(entry).map(([key, item]) => ({ key, item, bytes: UTF8.encode(key) }));
    entries.sort((a, b) => compareBytes(a.bytes, b.bytes));
    add(2 + cborHeaderBytes(entries.length));
    const record = new Map<string, BinaryValue>();
    for (const { key, item, bytes } of entries) {
      add(cborHeaderBytes(bytes.length) + bytes.length);
      record.set(key, visit(item));
    }
    return [5, record];
  };
  const bytes = Uint8Array.from(VALUE_ENCODER.encode(visit(value)));
  if (bytes.length !== byteCount) throw new Error('Canonical contract value encoder mismatch');
  return bytes;
}

/** Protocol-3 bounded canonical ContractValue CBOR, distinct from RPC/transaction JSON and CBOR. */
export function encodeCanonicalContractValue(value: unknown, options?: TypedDataOptions): Uint8Array {
  return encodeNormalized(normalizedValue(value, limits(options)));
}

/** SHA-256(prefix + NUL + canonical {domain,value}); does not supply application authorization policy. */
export function typedHash(domain: string, value: unknown, options?: TypedDataOptions): string {
  const selected = limits(options);
  utf8Bytes(domain, selected.maxStringChars);
  if (!/^[\x21-\x7e]{1,128}$/.test(domain)) throw new Error('Typed hash domain must be 1 to 128 printable ASCII bytes');
  outputLength(64, selected.maxStringChars);
  const canonical = encodeNormalized({ domain, value: normalizedValue(value, selected) });
  return bytesToHex(sha256.create().update(TYPED_PREFIX).update(canonical).digest());
}

export function bytesSha256(hex: string, options?: TypedDataOptions): string {
  const selected = limits(options);
  outputLength(64, selected.maxStringChars);
  return bytesToHex(sha256(canonicalHex(hex, selected.maxStringChars)));
}

export function bytesKeccak256(hex: string, options?: TypedDataOptions): string {
  const selected = limits(options);
  outputLength(64, selected.maxStringChars);
  return bytesToHex(keccak_256(canonicalHex(hex, selected.maxStringChars)));
}

export function utf8ToHex(text: string, options?: TypedDataOptions): string {
  const selected = limits(options);
  const bytes = utf8Bytes(text, selected.maxStringChars);
  outputLength(bytes.length * 2, selected.maxStringChars);
  return bytesToHex(bytes);
}

export function hexToUtf8(hex: string, options?: TypedDataOptions): string {
  const selected = limits(options);
  const bytes = canonicalHex(hex, selected.maxStringChars);
  try { return UTF8_DECODER.decode(bytes); }
  catch { throw new Error('Hex bytes must contain valid UTF-8'); }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16_384) binary += String.fromCharCode(...bytes.subarray(i, i + 16_384));
  return btoa(binary);
}

export function base64ToHex(text: string, options?: TypedDataOptions): string {
  const selected = limits(options);
  stringInput(text, selected.maxStringChars);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    throw new Error('Expected canonical padded standard Base64');
  const decodedLength = text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
  outputLength(decodedLength * 2, selected.maxStringChars);
  const bytes = Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  if (base64(bytes) !== text) throw new Error('Expected canonical padded standard Base64');
  return bytesToHex(bytes);
}

export function hexToBase64(hex: string, options?: TypedDataOptions): string {
  const selected = limits(options);
  stringInput(hex, selected.maxStringChars);
  outputLength(Math.ceil(hex.length / 2 / 3) * 4, selected.maxStringChars);
  return base64(canonicalHex(hex, selected.maxStringChars));
}
