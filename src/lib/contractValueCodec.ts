const CONTRACT_BIGINT_TYPE_KEY = '$riadchain.type';
const CONTRACT_BIGINT_VALUE_KEY = '$riadchain.value';
const CONTRACT_BIGINT_TYPE = 'bigint';

const RESERVED_CONTRACT_VALUE_KEYS = new Set([
  CONTRACT_BIGINT_TYPE_KEY,
  CONTRACT_BIGINT_VALUE_KEY,
]);

// Hard semantic codec ceilings, matching Rust core's contract_value module.
// A selected chain's VM limits and each RPC's response limits may be lower.
const MAX_VALUE_DEPTH = 256;
const MAX_VALUE_NODES = 1_048_576;
const MAX_CONTAINER_ITEMS = 100_000;
const MAX_TEXT_BYTES = 1_000_000;
const MAX_AGGREGATE_BYTES = 4 * 1024 * 1024;
const MAX_INTEGER_BITS = 65_536;
const MAX_INTEGER_DECIMAL_CHARS = 19_730;
// Decimal envelopes and escaped JSON text can exceed their semantic byte cost.
const MAX_JSON_INPUT_CHARS = 64 * 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

type ContractPrimitiveValue = null | boolean | string | number | bigint;
export type ContractValue = ContractPrimitiveValue | ContractValue[] | ContractValueRecord;
export type ContractValueRecord = { readonly [key: string]: ContractValue };

function isPlainContractObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class ValueBudget {
  nodes = 0;
  bytes = 0;
  readonly ancestors = new WeakSet<object>();

  node(depth: number): void {
    if (depth > MAX_VALUE_DEPTH) throw new Error('Contract value nesting limit exceeded');
    if (++this.nodes > MAX_VALUE_NODES) throw new Error('Contract value node limit exceeded');
  }

  addBytes(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > MAX_AGGREGATE_BYTES) throw new Error('Contract value byte limit exceeded');
  }

  text(text: string): void {
    if (text.length > MAX_TEXT_BYTES) throw new Error('Contract value text limit exceeded');
    const bytes = TEXT_ENCODER.encode(text);
    if (bytes.length > MAX_TEXT_BYTES) throw new Error('Contract value text limit exceeded');
    if (TEXT_DECODER.decode(bytes) !== text) throw new Error('Contract value text must contain well-formed Unicode');
    this.addBytes(bytes.length);
  }

  integer(value: bigint): bigint {
    // Check the value itself without constructing a ceiling beyond Hermes's
    // BigInt capacity during module initialization.
    const bits = value === 0n ? 0 : value.toString(2).length - (value < 0n ? 1 : 0);
    if (bits > MAX_INTEGER_BITS) throw new Error('Contract integer bit limit exceeded');
    this.addBytes(4 + Math.ceil(bits / 8));
    return value;
  }
}

function integerFromEnvelope(descriptors: Record<string, PropertyDescriptor>, budget: ValueBudget): bigint {
  const decimal = descriptors[CONTRACT_BIGINT_VALUE_KEY]?.value;
  if (Object.keys(descriptors).length !== 2
    || descriptors[CONTRACT_BIGINT_TYPE_KEY]?.value !== CONTRACT_BIGINT_TYPE
    || typeof decimal !== 'string')
    throw new Error('Invalid RPC contract integer envelope');
  if (decimal.length > MAX_INTEGER_DECIMAL_CHARS)
    throw new Error('Contract integer bit limit exceeded');
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(decimal) || decimal.trim() !== decimal)
    throw new Error('Invalid RPC contract integer decimal');
  return budget.integer(BigInt(decimal));
}

function normalizeContractValueInternal(
  value: unknown, path: string, budget: ValueBudget, depth: number, decodeEnvelopes: boolean,
  allowReservedKeys: boolean,
): ContractValue {
  budget.node(depth);
  if (value === null) { budget.addBytes(2); return null; }

  switch (typeof value) {
    case 'boolean':
      budget.addBytes(2);
      return value;
    case 'string':
      budget.text(value);
      budget.addBytes(6);
      return value;
    case 'bigint':
      return budget.integer(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
      if (!Number.isSafeInteger(value)) throw new Error(`${path} must be a safe integer`);
      return budget.integer(BigInt(Object.is(value, -0) ? 0 : value));
    case 'undefined':
      throw new Error(`${path} must not be undefined`);
    case 'function':
    case 'symbol':
      throw new Error(`${path} has unsupported type ${typeof value}`);
    case 'object':
      break;
    default:
      throw new Error(`${path} has unsupported type ${typeof value}`);
  }

  if (!Array.isArray(value) && !isPlainContractObject(value))
    throw new Error(`${path} must be a plain contract value object`);
  if (Array.isArray(value) && value.length > MAX_CONTAINER_ITEMS)
    throw new Error('Contract value container limit exceeded');
  const names = Object.getOwnPropertyNames(value);
  if (names.length > MAX_CONTAINER_ITEMS + (Array.isArray(value) ? 1 : 0))
    throw new Error('Contract value container limit exceeded');
  if (Object.getOwnPropertySymbols(value).length)
    throw new Error(`${path} must not contain symbol keys`);
  if (budget.ancestors.has(value)) throw new Error(`${path} must not contain cycles`);
  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (names.some((key) => key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))
        throw new Error(`${path} must not contain named array properties`);
      budget.addBytes(6);
      const normalized: ContractValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) throw new Error(`${path}[${index}] must not be a sparse array hole`);
        if (!('value' in descriptor)) throw new Error(`${path} must not contain accessors`);
        normalized.push(normalizeContractValueInternal(descriptor.value, `${path}[${index}]`, budget, depth + 1, decodeEnvelopes, allowReservedKeys));
      }
      return normalized;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (!('value' in descriptor)) throw new Error(`${path} must not contain accessors`);
      if (!descriptor.enumerable) throw new Error(`${path} must contain enumerable fields`);
    }
    const hasReservedKey = names.some((key) => RESERVED_CONTRACT_VALUE_KEYS.has(key));
    if (hasReservedKey && !allowReservedKeys) {
      if (decodeEnvelopes) return integerFromEnvelope(descriptors, budget);
      throw new Error(`${path} uses a reserved contract value key`);
    }
    budget.addBytes(6);
    const normalized = Object.create(null) as Record<string, ContractValue>;
    for (const key of names.sort()) {
      budget.text(key);
      budget.addBytes(5);
      normalized[key] = normalizeContractValueInternal(descriptors[key]!.value, `${path}.${key}`, budget, depth + 1, decodeEnvelopes, allowReservedKeys);
    }
    return normalized;
  } finally {
    budget.ancestors.delete(value);
  }
}

function readContractValue(value: unknown, decodeEnvelopes: boolean, allowReservedKeys = false): ContractValue {
  return normalizeContractValueInternal(value, 'contract value', new ValueBudget(), 0, decodeEnvelopes, allowReservedKeys);
}

export function normalizeContractValue(value: unknown): ContractValue {
  return readContractValue(value, false);
}

/** Binary values have explicit type tags; RPC integer-marker keys are ordinary record keys. */
export function normalizeCanonicalContractValue(value: unknown): ContractValue {
  return readContractValue(value, false, true);
}

export function encodeContractValue(value: unknown): string {
  const normalized = normalizeContractValue(value);
  return JSON.stringify(normalized, (_, entry) =>
    typeof entry === 'bigint'
      ? {
          [CONTRACT_BIGINT_TYPE_KEY]: CONTRACT_BIGINT_TYPE,
          [CONTRACT_BIGINT_VALUE_KEY]: entry.toString(),
        }
      : entry,
  );
}

export function decodeContractValue(value: null): null;
export function decodeContractValue<T = ContractValue>(value: string): T;
export function decodeContractValue<T = ContractValue>(value: string | null): T | null;
export function decodeContractValue<T = ContractValue>(value: string | null): T | null {
  if (value === null) return null;
  if (value.length > MAX_JSON_INPUT_CHARS) throw new Error('Contract value JSON input limit exceeded');
  return readContractValue(JSON.parse(value), true) as T;
}

export function encodeContractValueForRpc(value: unknown): ContractValue {
  return JSON.parse(encodeContractValue(value)) as ContractValue;
}

export function decodeContractValueFromRpc<T = ContractValue>(value: unknown): T {
  return readContractValue(value === undefined ? null : value, true) as T;
}
