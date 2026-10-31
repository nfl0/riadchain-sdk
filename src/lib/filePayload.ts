import { CID } from 'multiformats/cid';

export const MAX_FILE_NAME_BYTES = 255;
export const MAX_FILE_MIME_TYPE_BYTES = 127;
const RAW_CODEC = 0x55;
const DAG_PB_CODEC = 0x70;
const SHA2_256_MULTIHASH = 0x12;
const SHA2_256_BYTES = 32;
const MIME_TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const FILE_PAYLOAD_KEYS = new Set(['cid', 'size', 'storage', 'filename', 'mimeType']);
const textEncoder = new TextEncoder();

export interface CanonicalFilePayload {
  filename?: string;
  cid: string;
  size: number;
  storage: 'helia';
  mimeType?: string;
}

/** Validate and return the one canonical CID profile accepted by FILE transactions. */
export function normalizeCanonicalFileCid(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Canonical FILE payload requires a CID');
  }
  const cid = CID.parse(value);
  if (
    cid.version !== 1
    || (cid.code !== RAW_CODEC && cid.code !== DAG_PB_CODEC)
    || cid.multihash.code !== SHA2_256_MULTIHASH
    || cid.multihash.size !== SHA2_256_BYTES
    || cid.toString() !== value
  ) {
    throw new Error('Canonical FILE payload requires a CIDv1 base32 sha2-256 raw or dag-pb CID');
  }
  return cid.toString();
}

function asPayloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('FILE payload must be an object');
  }
  return payload as Record<string, unknown>;
}

export function normalizeCanonicalFilePayload(payload: unknown, maxFileSizeBytes?: number): CanonicalFilePayload {
  const record = asPayloadRecord(payload);

  if ('content' in record || 'contentBase64' in record) {
    throw new Error('Canonical FILE payloads cannot contain inline content');
  }
  const unknownKey = Object.keys(record).find((key) => !FILE_PAYLOAD_KEYS.has(key));
  if (unknownKey) {
    throw new Error(`Canonical FILE payload contains unsupported field ${unknownKey}`);
  }

  if (record.storage !== 'helia') {
    throw new Error('Canonical FILE payload must use helia storage');
  }

  const cid = normalizeCanonicalFileCid(record.cid);

  if (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0) {
    throw new Error('Canonical FILE payload requires a non-negative safe integer size');
  }
  const size = record.size;
  if (maxFileSizeBytes !== undefined && (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes < 0)) {
    throw new Error('Maximum FILE size must be a non-negative safe integer');
  }
  if (maxFileSizeBytes !== undefined && size > maxFileSizeBytes) {
    throw new Error(`Canonical FILE payload exceeds maximum allowed ${maxFileSizeBytes} bytes`);
  }

  const filename = normalizeFilename(record.filename);
  const mimeType = normalizeMimeType(record.mimeType);

  return {
    cid,
    size,
    storage: 'helia',
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

function normalizeFilename(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('FILE filename must be a string');
  const filename = value.trim();
  if (!filename) throw new Error('FILE filename cannot be empty');
  if (textEncoder.encode(filename).byteLength > MAX_FILE_NAME_BYTES) {
    throw new Error(`FILE filename exceeds ${MAX_FILE_NAME_BYTES} UTF-8 bytes`);
  }
  if (/[\u0000-\u001f\u007f/\\]/u.test(filename) || filename === '.' || filename === '..') {
    throw new Error('FILE filename contains an unsafe character or path component');
  }
  return filename;
}

function normalizeMimeType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('FILE MIME type must be a string');
  const mimeType = value.trim().toLowerCase();
  if (!mimeType) throw new Error('FILE MIME type cannot be empty');
  if (textEncoder.encode(mimeType).byteLength > MAX_FILE_MIME_TYPE_BYTES) {
    throw new Error(`FILE MIME type exceeds ${MAX_FILE_MIME_TYPE_BYTES} bytes`);
  }
  const parts = mimeType.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1] || !parts.every((part) => MIME_TOKEN.test(part))) {
    throw new Error('FILE MIME type must be a canonical type/subtype without parameters');
  }
  return mimeType;
}
