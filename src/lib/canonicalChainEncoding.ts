import { Decoder, encode } from 'cbor-x';
import { keccak256 } from 'ethereum-cryptography/keccak';
import { bytesToHex } from 'ethereum-cryptography/utils';

export const CANONICAL_CHAIN_ENCODING_VERSION = 'canonical-cbor-v1';
const CANONICAL_TRANSACTION_HASH_LAYOUT_VERSION = 1;
const CANONICAL_SIGNED_TRANSACTION_LAYOUT_VERSION = 1;
const CANONICAL_BLOCK_LAYOUT_VERSION = 2;
const MAX_CANONICAL_CBOR_DEPTH = 128;
const CANONICAL_BLOCK_FIELD_COUNT = 15;
const CANONICAL_SIGNED_TRANSACTION_FIELD_COUNT = 10;
const CANONICAL_TX_INPUT_FIELD_COUNT = 4;
const CANONICAL_TX_OUTPUT_FIELD_COUNT = 2;
const CANONICAL_FILE_AVAILABILITY_FIELD_COUNT = 3;
const CANONICAL_SUCCESSION_PROOF_FIELD_COUNT = 3;
const CANONICAL_TRANSACTION_TYPES = new Set([
  'FILE',
  'CONTRACT',
  'TRANSFER',
  'COINBASE',
]);
// cbor-x intentionally rewrites an object-map key named "__proto__" when
// mapsAsObjects is enabled. Decode maps as Map instead, then copy them into
// null-prototype records after validating every key. This keeps canonical
// payload bytes lossless without exposing prototype setters.
const CANONICAL_DECODER = new Decoder({
  useRecords: false,
  mapsAsObjects: false,
});

type CanonicalTxInput = {
  txId: string;
  outputIndex: number;
  address: string;
  signature: string;
};

type CanonicalTxOutput = {
  address: string;
  amount: bigint;
};

export type CanonicalTransaction = {
  id: string;
  chainId: string;
  type: 'FILE' | 'CONTRACT' | 'TRANSFER' | 'COINBASE';
  inputs: CanonicalTxInput[];
  outputs: CanonicalTxOutput[];
  payload: unknown;
  timestamp: number;
  expiryHeight?: number | null;
  gasLimit?: number | null;
};

export type CanonicalBlock = {
  protocolVersion: number;
  index: number;
  chainId: string;
  timestamp: number;
  transactions: CanonicalTransaction[];
  fileAvailability: Array<{
    txId: string;
    cid: string;
    size: number;
  }>;
  previousHash: string;
  stateHash: string;
  hash: string;
  validatorPublicKey: string | null;
  validatorAddress: string;
  validatorSignature: string;
  isSuccession: boolean;
  successionProof: {
    txId: string;
    outputIndex: number;
    amount: string;
  } | null;
};

// These exact-key assertions make additions to the semantic protocol types a
// compile-time event. A new field cannot silently compile without a deliberate
// decision about its versioned canonical inclusion or exclusion.
const CANONICAL_TRANSACTION_SCHEMA_FIELDS = {
  id: true,
  chainId: true,
  type: true,
  inputs: true,
  outputs: true,
  payload: true,
  timestamp: true,
  expiryHeight: true,
  gasLimit: true,
} satisfies Record<keyof CanonicalTransaction, true>;

const CANONICAL_BLOCK_SCHEMA_FIELDS = {
  protocolVersion: true,
  index: true,
  chainId: true,
  timestamp: true,
  transactions: true,
  fileAvailability: true,
  previousHash: true,
  stateHash: true,
  hash: true,
  validatorPublicKey: true,
  validatorAddress: true,
  validatorSignature: true,
  isSuccession: true,
  successionProof: true,
} satisfies Record<keyof CanonicalBlock, true>;

void CANONICAL_TRANSACTION_SCHEMA_FIELDS;
void CANONICAL_BLOCK_SCHEMA_FIELDS;

type CanonicalPayloadValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | CanonicalPayloadValue[]
  | { [key: string]: CanonicalPayloadValue };

const UTF8_ENCODER = new TextEncoder();

function assertBoundedCanonicalCbor(raw: Uint8Array): void {
  let offset = 0;

  const requireBytes = (length: number) => {
    if (length < 0 || length > raw.length - offset) {
      throw new Error('Canonical CBOR contains a truncated or oversized value');
    }
  };

  const readArgument = (additional: number, requireSafeInteger: boolean): number => {
    if (additional < 24) return additional;
    const byteLength = additional === 24 ? 1
      : additional === 25 ? 2
      : additional === 26 ? 4
      : additional === 27 ? 8
      : 0;
    if (byteLength === 0) {
      throw new Error('Canonical CBOR cannot use reserved or indefinite lengths');
    }
    requireBytes(byteLength);
    const view = new DataView(raw.buffer, raw.byteOffset + offset, byteLength);
    let value: number;
    if (byteLength === 1) value = view.getUint8(0);
    else if (byteLength === 2) value = view.getUint16(0);
    else if (byteLength === 4) value = view.getUint32(0);
    else {
      const wide = view.getBigUint64(0);
      if (requireSafeInteger && wide > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Canonical CBOR length exceeds the safe integer range');
      }
      value = requireSafeInteger ? Number(wide) : 0;
    }
    offset += byteLength;
    return value;
  };

  const visit = (depth: number): void => {
    if (depth > MAX_CANONICAL_CBOR_DEPTH) {
      throw new Error('Canonical CBOR nesting limit exceeded');
    }
    requireBytes(1);
    const initial = raw[offset++]!;
    const major = initial >>> 5;
    const additional = initial & 0x1f;

    if (major === 7) {
      readArgument(additional, false);
      return;
    }

    const argument = readArgument(additional, major >= 2 && major <= 5);
    if (major <= 1) return;
    if (major === 2 || major === 3) {
      requireBytes(argument);
      offset += argument;
      return;
    }
    if (major === 4 || major === 5) {
      const itemCount = major === 5 ? argument * 2 : argument;
      if (!Number.isSafeInteger(itemCount) || itemCount > raw.length - offset) {
        throw new Error('Canonical CBOR container length exceeds its payload');
      }
      for (let index = 0; index < itemCount; index += 1) visit(depth + 1);
      return;
    }
    if (major === 6) {
      visit(depth + 1);
      return;
    }
    throw new Error('Canonical CBOR contains an unsupported major type');
  };

  visit(0);
  if (offset !== raw.length) {
    throw new Error('Canonical CBOR contains trailing bytes');
  }
}

function toCanonicalNumber(value: unknown, field: string): number {
  const normalized = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(normalized)) {
    throw new Error(`Canonical encoding requires ${field} to be a safe integer`);
  }
  return normalized;
}

function toCanonicalBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return BigInt(value);
  } else if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      // Fall through to the canonical error below.
    }
  }
  throw new Error(`Canonical encoding requires ${field} to be an integer`);
}

function sortObjectKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .map((key) => ({ key, bytes: UTF8_ENCODER.encode(key) }))
    .sort((left, right) => {
      const leftBytes = left.bytes;
      const rightBytes = right.bytes;
      const sharedLength = Math.min(leftBytes.length, rightBytes.length);
      for (let index = 0; index < sharedLength; index += 1) {
        const difference = leftBytes[index]! - rightBytes[index]!;
        if (difference !== 0) return difference;
      }
      return leftBytes.length - rightBytes.length;
    })
    .map(({ key }) => key);
}

function concatenateBytes(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function encodeCborArrayHeader(length: number): Uint8Array {
  if (length < 24) return Uint8Array.of(0x80 | length);
  if (length <= 0xff) return Uint8Array.of(0x98, length);
  if (length <= 0xffff) return Uint8Array.of(0x99, length >>> 8, length & 0xff);
  return Uint8Array.of(0x9a, length >>> 24, length >>> 16, length >>> 8, length);
}

function encodeCanonicalCbor(value: CanonicalPayloadValue, depth = 0): Uint8Array {
  if (depth > MAX_CANONICAL_CBOR_DEPTH) {
    throw new Error('Canonical CBOR nesting limit exceeded');
  }
  if (Array.isArray(value)) {
    return concatenateBytes([
      encodeCborArrayHeader(value.length),
      ...value.map((entry) => encodeCanonicalCbor(entry, depth + 1)),
    ]);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, CanonicalPayloadValue>;
    const keys = sortObjectKeys(record);
    if (keys.length > 0xffff) {
      throw new Error('Canonical encoding cannot serialize an object with more than 65535 keys');
    }
    const chunks: Uint8Array[] = [Uint8Array.of(0xb9, keys.length >>> 8, keys.length & 0xff)];
    for (const key of keys) {
      chunks.push(Uint8Array.from(encode(key)), encodeCanonicalCbor(record[key]!, depth + 1));
    }
    return concatenateBytes(chunks);
  }
  return Uint8Array.from(encode(value));
}

function isPlainCanonicalObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalizePayload(
  value: unknown,
  depth = 0,
  ancestors: WeakSet<object> = new WeakSet(),
): CanonicalPayloadValue {
  if (depth > MAX_CANONICAL_CBOR_DEPTH) {
    throw new Error('Canonical payload nesting limit exceeded');
  }
  if (value === undefined) {
    return null;
  }
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical encoding cannot serialize a non-finite number');
    }
    return value;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error('Canonical encoding cannot serialize a cyclic payload');
    }
    ancestors.add(value);
    try {
      // Index explicitly so sparse holes normalize to null, matching JSON's
      // array semantics at the RPC boundary.
      return Array.from(
        { length: value.length },
        (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor && !('value' in descriptor)) {
            throw new Error(`Canonical encoding cannot serialize accessor property ${index}`);
          }
          return canonicalizePayload(descriptor?.value, depth + 1, ancestors);
        },
      );
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === 'object') {
    if (!isPlainCanonicalObject(value)) {
      throw new Error('Canonical encoding requires payload objects to be plain objects');
    }
    if (ancestors.has(value)) {
      throw new Error('Canonical encoding cannot serialize a cyclic payload');
    }
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const normalized = Object.create(null) as Record<string, CanonicalPayloadValue>;
    try {
      for (const key of sortObjectKeys(record)) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !('value' in descriptor)) {
          throw new Error(`Canonical encoding cannot serialize accessor property ${key}`);
        }
        const entry = descriptor.value;
        if (entry !== undefined) {
          Object.defineProperty(normalized, key, {
            value: canonicalizePayload(entry, depth + 1, ancestors),
            enumerable: true,
            configurable: false,
            writable: false,
          });
        }
      }
    } finally {
      ancestors.delete(value);
    }
    return normalized;
  }
  throw new Error(`Canonical encoding cannot serialize value of type ${typeof value}`);
}

function encodeCanonicalInput(input: {
  txId: string;
  outputIndex: number;
  address: string;
  signature?: string;
}, includeSignature: boolean) {
  return includeSignature
    ? [
        String(input.txId),
        toCanonicalNumber(input.outputIndex, 'tx input outputIndex'),
        String(input.address),
        String(input.signature ?? ''),
      ]
    : [
        String(input.txId),
        toCanonicalNumber(input.outputIndex, 'tx input outputIndex'),
        String(input.address),
      ];
}

function encodeCanonicalOutput(output: { address: string; amount: unknown }) {
  return [
    String(output.address),
    toCanonicalBigInt(output.amount, 'tx output amount'),
  ];
}

function encodeCanonicalTransactionShape(
  tx: Omit<CanonicalTransaction, 'id'> | CanonicalTransaction,
  options: {
    includeId: boolean;
    includeSignatures: boolean;
  },
) {
  if (!CANONICAL_TRANSACTION_TYPES.has(tx.type)) throw new Error(`Unsupported canonical transaction type: ${String(tx.type)}`);
  let payload = canonicalizePayload(tx.payload ?? null) as any;
  if (!options.includeSignatures && payload?.authorization && typeof payload.authorization === 'object') {
    const { signature: _signature, ...authorization } = payload.authorization;
    payload = { ...payload, authorization };
  }
  return [
    options.includeId ? CANONICAL_SIGNED_TRANSACTION_LAYOUT_VERSION : CANONICAL_TRANSACTION_HASH_LAYOUT_VERSION,
    ...(options.includeId ? [String((tx as CanonicalTransaction).id)] : []),
    String(tx.chainId),
    String(tx.type),
    Array.isArray(tx.inputs) ? tx.inputs.map((input) => encodeCanonicalInput(input, options.includeSignatures)) : [],
    Array.isArray(tx.outputs) ? tx.outputs.map((output) => encodeCanonicalOutput(output)) : [],
    payload,
    toCanonicalNumber(tx.timestamp, 'tx timestamp'),
    tx.expiryHeight === undefined || tx.expiryHeight === null ? null : toCanonicalNumber(tx.expiryHeight, 'tx expiryHeight'),
    tx.gasLimit === undefined || tx.gasLimit === null ? null : toCanonicalNumber(tx.gasLimit, 'tx gasLimit'),
  ];
}

function encodeCanonicalFileAvailabilityEntry(entry: { txId: string; cid: string; size: number }) {
  return [
    String(entry.txId),
    String(entry.cid),
    toCanonicalNumber(entry.size, 'file availability size'),
  ];
}

function encodeCanonicalSuccessionProof(proof: { txId: string; outputIndex: number; amount: string } | null | undefined) {
  if (!proof) {
    return null;
  }
  return [
    String(proof.txId),
    toCanonicalNumber(proof.outputIndex, 'succession proof outputIndex'),
    String(proof.amount),
  ];
}

export function encodeCanonicalTransactionForHash(tx: Omit<CanonicalTransaction, 'id'> | CanonicalTransaction): Uint8Array {
  return encodeCanonicalCbor(encodeCanonicalTransactionShape(tx, {
    includeId: false,
    includeSignatures: false,
  }) as CanonicalPayloadValue);
}

export function encodeCanonicalSignedTransaction(tx: CanonicalTransaction): Uint8Array {
  return encodeCanonicalCbor(encodeCanonicalTransactionShape(tx, {
    includeId: true,
    includeSignatures: true,
  }) as CanonicalPayloadValue);
}

export function requireProtocolVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new Error('Canonical block protocolVersion must be a positive uint32');
  }
  return value;
}

export function encodeCanonicalBlockForHash(block: Omit<CanonicalBlock, 'hash' | 'validatorSignature' | 'validatorPublicKey'>): Uint8Array {
  return encodeCanonicalCbor([
    CANONICAL_BLOCK_LAYOUT_VERSION,
    requireProtocolVersion(block.protocolVersion),
    toCanonicalNumber(block.index, 'block index'),
    String(block.chainId),
    toCanonicalNumber(block.timestamp, 'block timestamp'),
    Array.isArray(block.transactions) ? block.transactions.map((tx) => encodeCanonicalTransactionShape(tx, {
      includeId: true,
      includeSignatures: true,
    })) : [],
    Array.isArray(block.fileAvailability) ? block.fileAvailability.map((entry) => encodeCanonicalFileAvailabilityEntry(entry)) : [],
    String(block.previousHash),
    String(block.stateHash),
    String(block.validatorAddress),
    !!block.isSuccession,
    encodeCanonicalSuccessionProof(block.successionProof),
  ] as CanonicalPayloadValue);
}

export function encodeCanonicalBlock(block: CanonicalBlock): Uint8Array {
  return encodeCanonicalCbor([
    CANONICAL_BLOCK_LAYOUT_VERSION,
    requireProtocolVersion(block.protocolVersion),
    toCanonicalNumber(block.index, 'block index'),
    String(block.chainId),
    toCanonicalNumber(block.timestamp, 'block timestamp'),
    Array.isArray(block.transactions) ? block.transactions.map((tx) => encodeCanonicalTransactionShape(tx, {
      includeId: true,
      includeSignatures: true,
    })) : [],
    Array.isArray(block.fileAvailability) ? block.fileAvailability.map((entry) => encodeCanonicalFileAvailabilityEntry(entry)) : [],
    String(block.previousHash),
    String(block.stateHash),
    String(block.hash),
    block.validatorPublicKey === null || block.validatorPublicKey === undefined ? null : String(block.validatorPublicKey),
    String(block.validatorAddress),
    String(block.validatorSignature),
    !!block.isSuccession,
    encodeCanonicalSuccessionProof(block.successionProof),
  ] as CanonicalPayloadValue);
}

function expectExactArray(value: unknown, length: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`Canonical ${field} must be an array with exactly ${length} fields`);
  }
  return value;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Canonical ${field} must be a string`);
  }
  return value;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Canonical ${field} must be a boolean`);
  }
  return value;
}

function expectCanonicalDecodedNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Canonical ${field} must be a safe integer`);
  }
  return value;
}

function expectCanonicalDecodedBigInt(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint') {
    throw new Error(`Canonical ${field} must be a bigint`);
  }
  return value;
}

function decodeCanonicalPayload(value: unknown, depth = 0): CanonicalPayloadValue {
  if (depth > MAX_CANONICAL_CBOR_DEPTH) {
    throw new Error('Canonical payload nesting limit exceeded');
  }
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'string'
    || typeof value === 'bigint'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical payload numbers must be finite');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => decodeCanonicalPayload(entry, depth + 1));
  }
  if (value instanceof Map) {
    const normalized = Object.create(null) as Record<string, CanonicalPayloadValue>;
    for (const [key, entry] of value.entries()) {
      if (typeof key !== 'string') {
        throw new Error('Canonical payload object keys must be strings');
      }
      Object.defineProperty(normalized, key, {
        value: decodeCanonicalPayload(entry, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return normalized;
  }
  throw new Error(`Canonical payload contains unsupported value of type ${typeof value}`);
}

function decodeCanonicalTransactionShape(raw: unknown): CanonicalTransaction {
  const fields = expectExactArray(
    raw,
    CANONICAL_SIGNED_TRANSACTION_FIELD_COUNT,
    'signed transaction',
  );
  const [
    layoutVersion,
    id,
    chainId,
    type,
    inputs,
    outputs,
    payload,
    timestamp,
    expiryHeight,
    gasLimit,
  ] = fields;
  if (layoutVersion !== CANONICAL_SIGNED_TRANSACTION_LAYOUT_VERSION) {
    throw new Error(`Unsupported canonical signed transaction layout version: ${String(layoutVersion)}`);
  }
  if (!CANONICAL_TRANSACTION_TYPES.has(type as string)) {
    throw new Error(`Unsupported canonical transaction type: ${String(type)}`);
  }
  if (!Array.isArray(inputs)) {
    throw new Error('Canonical transaction inputs must be an array');
  }
  if (!Array.isArray(outputs)) {
    throw new Error('Canonical transaction outputs must be an array');
  }
  return {
    id: expectString(id, 'transaction id'),
    chainId: expectString(chainId, 'transaction chainId'),
    type: type as CanonicalTransaction['type'],
    inputs: inputs.map((entry) => {
      const input = expectExactArray(entry, CANONICAL_TX_INPUT_FIELD_COUNT, 'tx input');
      return {
        txId: expectString(input[0], 'tx input txId'),
        outputIndex: expectCanonicalDecodedNumber(input[1], 'tx input outputIndex'),
        address: expectString(input[2], 'tx input address'),
        signature: expectString(input[3], 'tx input signature'),
      };
    }),
    outputs: outputs.map((entry) => {
      const output = expectExactArray(entry, CANONICAL_TX_OUTPUT_FIELD_COUNT, 'tx output');
      return {
        address: expectString(output[0], 'tx output address'),
        amount: expectCanonicalDecodedBigInt(output[1], 'tx output amount'),
      };
    }),
    payload: decodeCanonicalPayload(payload),
    timestamp: expectCanonicalDecodedNumber(timestamp, 'transaction timestamp'),
    expiryHeight: expiryHeight === null
      ? null
      : expectCanonicalDecodedNumber(expiryHeight, 'transaction expiryHeight'),
    gasLimit: gasLimit === null
      ? null
      : expectCanonicalDecodedNumber(gasLimit, 'transaction gasLimit'),
  };
}

export function decodeCanonicalBlock(raw: Uint8Array | ArrayBuffer): CanonicalBlock {
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
  assertBoundedCanonicalCbor(bytes);
  const decoded = expectExactArray(
    CANONICAL_DECODER.decode(bytes),
    CANONICAL_BLOCK_FIELD_COUNT,
    'block',
  );
  const [
    layoutVersion,
    protocolVersion,
    index,
    chainId,
    timestamp,
    transactions,
    fileAvailability,
    previousHash,
    stateHash,
    hash,
    validatorPublicKey,
    validatorAddress,
    validatorSignature,
    isSuccession,
    successionProof,
  ] = decoded;
  if (layoutVersion !== CANONICAL_BLOCK_LAYOUT_VERSION) {
    throw new Error(`Unsupported canonical block layout version: ${String(layoutVersion)}`);
  }
  if (!Array.isArray(transactions)) {
    throw new Error('Canonical block transactions must be an array');
  }
  if (!Array.isArray(fileAvailability)) {
    throw new Error('Canonical block fileAvailability must be an array');
  }
  if (validatorPublicKey !== null && typeof validatorPublicKey !== 'string') {
    throw new Error('Canonical block validatorPublicKey must be a string or null');
  }
  const block: CanonicalBlock = {
    protocolVersion: requireProtocolVersion(protocolVersion),
    index: expectCanonicalDecodedNumber(index, 'block index'),
    chainId: expectString(chainId, 'block chainId'),
    timestamp: expectCanonicalDecodedNumber(timestamp, 'block timestamp'),
    transactions: transactions.map((tx) => decodeCanonicalTransactionShape(tx)),
    fileAvailability: fileAvailability.map((entry) => {
      const availability = expectExactArray(
        entry,
        CANONICAL_FILE_AVAILABILITY_FIELD_COUNT,
        'file availability entry',
      );
      return {
        txId: expectString(availability[0], 'file availability txId'),
        cid: expectString(availability[1], 'file availability cid'),
        size: expectCanonicalDecodedNumber(availability[2], 'file availability size'),
      };
    }),
    previousHash: expectString(previousHash, 'block previousHash'),
    stateHash: expectString(stateHash, 'block stateHash'),
    hash: expectString(hash, 'block hash'),
    validatorPublicKey,
    validatorAddress: expectString(validatorAddress, 'block validatorAddress'),
    validatorSignature: expectString(validatorSignature, 'block validatorSignature'),
    isSuccession: expectBoolean(isSuccession, 'block isSuccession'),
    successionProof: successionProof === null || successionProof === undefined
      ? null
      : (() => {
          const proof = expectExactArray(
            successionProof,
            CANONICAL_SUCCESSION_PROOF_FIELD_COUNT,
            'succession proof',
          );
          return {
            txId: expectString(proof[0], 'succession proof txId'),
            outputIndex: expectCanonicalDecodedNumber(proof[1], 'succession proof outputIndex'),
            amount: expectString(proof[2], 'succession proof amount'),
          };
        })(),
  };
  const canonicalBytes = encodeCanonicalBlock(block);
  if (
    canonicalBytes.length !== bytes.length
    || canonicalBytes.some((byte, index) => byte !== bytes[index])
  ) {
    throw new Error('Canonical block contains a non-canonical representation');
  }
  return block;
}

export function calculateCanonicalTransactionHash(tx: Omit<CanonicalTransaction, 'id'> | CanonicalTransaction): string {
  return bytesToHex(keccak256(encodeCanonicalTransactionForHash(tx)));
}

export function calculateCanonicalBlockHash(block: Omit<CanonicalBlock, 'hash' | 'validatorSignature' | 'validatorPublicKey'>): string {
  return bytesToHex(keccak256(encodeCanonicalBlockForHash(block)));
}
