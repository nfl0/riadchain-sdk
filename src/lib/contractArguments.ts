import { normalizeContractValue } from './contractValueCodec.ts';
import { DEFAULT_VM_LIMITS } from './protocolParams.ts';

/** Preserve Charlie integer types in transaction JSON; read-only RPC views use their own codec. */
export function encodeContractArguments(
  argumentsValue: Record<string, unknown>,
  options: { maxBigIntBits?: number } = {},
): Record<string, unknown> {
  const maxBits = options.maxBigIntBits ?? DEFAULT_VM_LIMITS.maxBigIntBits;
  if (!Number.isSafeInteger(maxBits) || maxBits < 1 || maxBits > 65_536)
    throw new Error('Invalid contract integer limit');
  if (
    !argumentsValue ||
    typeof argumentsValue !== 'object' ||
    Array.isArray(argumentsValue)
  )
    throw new Error('Contract arguments must be a record');
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  function bound(value: unknown, depth = 0): void {
    if (depth > 64 || ++nodes > 10_000)
      throw new Error('Contract arguments exceed the nesting or size limit');
    if (!value || typeof value !== 'object') return;
    if (ancestors.has(value))
      throw new Error('Contract arguments must not contain cycles');
    if (Object.getOwnPropertySymbols(value).length)
      throw new Error('Contract arguments must not contain symbol keys');
    ancestors.add(value);
    if (Object.hasOwn(value, '__riadchainCanonicalBigInt'))
      throw new Error(
        'Contract arguments use a reserved native integer marker',
      );
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!('value' in descriptor))
        throw new Error('Contract arguments must not contain accessors');
      bound(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  function encode(value: unknown): unknown {
    if (typeof value === 'bigint') {
      if ((value < 0n ? -value : value).toString(2).length > maxBits)
        throw new Error('Contract integer exceeds the VM bit limit');
      return { __riadchainCanonicalBigInt: value.toString() };
    }
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, encode(entry)]),
      );
    }
    return value;
  }
  bound(argumentsValue);
  const encoded = encode(normalizeContractValue(argumentsValue)) as Record<
    string,
    unknown
  >;
  if (new TextEncoder().encode(JSON.stringify(encoded)).length > 512 * 1024)
    throw new Error('Contract arguments exceed the encoded size limit');
  return encoded;
}

/** Inspect transaction arguments without treating decimal strings as Charlie integers. */
export function decodeContractArguments(
  argumentsValue: Record<string, unknown>,
  options: { maxBigIntBits?: number } = {},
): Record<string, unknown> {
  const maxBits = options.maxBigIntBits ?? DEFAULT_VM_LIMITS.maxBigIntBits;
  if (!Number.isSafeInteger(maxBits) || maxBits < 1 || maxBits > 65_536)
    throw new Error('Invalid contract integer limit');
  if (
    !argumentsValue ||
    typeof argumentsValue !== 'object' ||
    Array.isArray(argumentsValue)
  )
    throw new Error('Contract arguments must be a record');
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  function decode(value: unknown, depth = 0): unknown {
    if (depth > 64 || ++nodes > 10_000)
      throw new Error('Contract arguments exceed the nesting or size limit');
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'string'
    )
      return value;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value))
        throw new Error('Contract arguments must contain safe integers');
      const integer = BigInt(value);
      if ((integer < 0n ? -integer : integer).toString(2).length > maxBits)
        throw new Error('Contract integer exceeds the VM bit limit');
      return integer;
    }
    if (!value || typeof value !== 'object')
      throw new Error('Unsupported encoded contract argument');
    const prototype = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      throw new Error('Contract arguments must contain plain records');
    if (ancestors.has(value))
      throw new Error('Contract arguments must not contain cycles');
    if (Object.getOwnPropertySymbols(value).length)
      throw new Error('Contract arguments must not contain symbol keys');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.values(descriptors).some((descriptor) => !('value' in descriptor))
    )
      throw new Error('Contract arguments must not contain accessors');
    if (
      !Array.isArray(value) &&
      Object.values(descriptors).some((descriptor) => !descriptor.enumerable)
    )
      throw new Error('Contract arguments must contain enumerable fields');
    if (Object.hasOwn(descriptors, '__riadchainCanonicalBigInt')) {
      const decimal = descriptors.__riadchainCanonicalBigInt!.value;
      if (
        Array.isArray(value) ||
        Object.keys(descriptors).length !== 1 ||
        typeof decimal !== 'string' ||
        decimal.length > Math.ceil(maxBits * Math.LOG10E * Math.LN2) + 1 ||
        !/^(?:0|-?[1-9][0-9]*)$/.test(decimal)
      )
        throw new Error('Invalid native contract integer marker');
      const integer = BigInt(decimal);
      if ((integer < 0n ? -integer : integer).toString(2).length > maxBits)
        throw new Error('Contract integer exceeds the VM bit limit');
      return integer;
    }
    ancestors.add(value);
    let decoded: unknown;
    if (Array.isArray(value)) {
      if (value.length > 10_000)
        throw new Error('Contract arguments exceed the nesting or size limit');
      decoded = Array.from({ length: value.length }, (_, index) => {
        if (!Object.hasOwn(descriptors, String(index)))
          throw new Error('Contract arguments must not contain sparse arrays');
        return decode(descriptors[String(index)]!.value, depth + 1);
      });
    } else {
      decoded = Object.fromEntries(
        Object.entries(descriptors).map(([key, descriptor]) => [
          key,
          decode(descriptor.value, depth + 1),
        ]),
      );
    }
    ancestors.delete(value);
    return decoded;
  }
  const decoded = decode(argumentsValue);
  if (typeof decoded === 'bigint')
    throw new Error('Contract arguments must be a record');
  if (
    new TextEncoder().encode(JSON.stringify(argumentsValue)).length >
    512 * 1024
  )
    throw new Error('Contract arguments exceed the encoded size limit');
  return decoded as Record<string, unknown>;
}
