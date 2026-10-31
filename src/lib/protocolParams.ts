/** Genesis policy shared by transaction builders and typed node queries. */
export interface FeeSchedule {
  baseFeeSatoshis: bigint;
  byteRateSatoshis: bigint;
  gasRateSatoshis: bigint;
  gasUnitsPerSatoshi: bigint;
  storageRateSatoshis: bigint;
}
export interface GasSchedule { maxGasPerTx: bigint; blockGasLimit: bigint }
export interface VmLimits {
  maxStackDepth: number;
  maxReturnStackDepth: number;
  maxMemoryCells: number;
  maxInstructions: number;
  maxStringChars: number;
  maxArrayLength: number;
  maxBigIntBits: number;
  maxPowExponent: number;
}
export type NetworkMode = 'private' | 'regtest';
export interface ProtocolParams {
  networkMode: NetworkMode;
  blockIntervalMs: number;
  blockSubsidySatoshis: bigint;
  minStakeSatoshis: bigint;
  successionTimeoutMs: number;
  maxTxBytes: number;
  maxFileBytes: number;
  maxBlockBytes: number;
  maxTransactionsPerBlock: number;
  maxOutputsPerTransaction: number;
  mempoolMaxAgeMs: number;
  fileMinPeerAcksForMining: number;
  filePeerAckTtlMs: number;
  feeSchedule: FeeSchedule;
  gasSchedule: GasSchedule;
  vmLimits: VmLimits;
}
export type SerializedProtocolParams = Omit<ProtocolParams,
  'blockSubsidySatoshis' | 'minStakeSatoshis' | 'feeSchedule' | 'gasSchedule'> & {
  blockSubsidySatoshis: string;
  minStakeSatoshis: string;
  feeSchedule: { [K in keyof FeeSchedule]: string };
  gasSchedule: { [K in keyof GasSchedule]: string };
};
export const DEFAULT_VM_LIMITS: Readonly<VmLimits> = Object.freeze({
  maxStackDepth: 8192, maxReturnStackDepth: 8192, maxMemoryCells: 1_048_576,
  maxInstructions: 1_000_000, maxStringChars: 65_536, maxArrayLength: 16_384,
  maxBigIntBits: 4096, maxPowExponent: 1024,
});
export const DEFAULT_PROTOCOL_PARAMS: ProtocolParams = {
  networkMode: 'private', blockIntervalMs: 10_000,
  blockSubsidySatoshis: 1000n * 100_000_000n, minStakeSatoshis: 100_000_000n,
  successionTimeoutMs: 120_000, maxTxBytes: 1_000_000,
  maxFileBytes: 300 * 1024 * 1024, maxBlockBytes: 10_000_000,
  maxTransactionsPerBlock: 10_000, maxOutputsPerTransaction: 512,
  mempoolMaxAgeMs: 24 * 60 * 60 * 1000,
  fileMinPeerAcksForMining: 1, filePeerAckTtlMs: 30_000,
  feeSchedule: { baseFeeSatoshis: 100_000n, byteRateSatoshis: 100n, gasRateSatoshis: 1n,
    gasUnitsPerSatoshi: 10n, storageRateSatoshis: 1000n },
  gasSchedule: { maxGasPerTx: 10_000_000n, blockGasLimit: 50_000_000n },
  vmLimits: { ...DEFAULT_VM_LIMITS },
};
export const REGTEST_PROTOCOL_PARAMS: ProtocolParams = {
  ...DEFAULT_PROTOCOL_PARAMS, networkMode: 'regtest', blockIntervalMs: 100,
  successionTimeoutMs: 1200, fileMinPeerAcksForMining: 0,
  feeSchedule: { ...DEFAULT_PROTOCOL_PARAMS.feeSchedule },
  gasSchedule: { ...DEFAULT_PROTOCOL_PARAMS.gasSchedule },
  vmLimits: { ...DEFAULT_VM_LIMITS },
};
export function serializeProtocolParams(params: ProtocolParams): SerializedProtocolParams {
  return {
    ...params,
    blockSubsidySatoshis: params.blockSubsidySatoshis.toString(),
    minStakeSatoshis: params.minStakeSatoshis.toString(),
    feeSchedule: {
      baseFeeSatoshis: params.feeSchedule.baseFeeSatoshis.toString(),
      byteRateSatoshis: params.feeSchedule.byteRateSatoshis.toString(),
      gasRateSatoshis: params.feeSchedule.gasRateSatoshis.toString(),
      gasUnitsPerSatoshi: params.feeSchedule.gasUnitsPerSatoshi.toString(),
      storageRateSatoshis: params.feeSchedule.storageRateSatoshis.toString(),
    },
    gasSchedule: { maxGasPerTx: params.gasSchedule.maxGasPerTx.toString(),
      blockGasLimit: params.gasSchedule.blockGasLimit.toString() },
    vmLimits: { ...params.vmLimits },
  };
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function integer(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}
function amount(value: unknown, min: bigint, max: bigint): bigint | null {
  if (typeof value !== 'bigint' && !(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))) return null;
  // All policy values are below uint128 and fit in 39 decimal digits.
  if (typeof value === 'string' && value.length > 39) return null;
  const parsed = BigInt(value);
  return parsed >= min && parsed <= max ? parsed : null;
}
/** Validate the complete current shape; native Rust remains consensus authority. */
export function normalizeProtocolParamsShape(value: unknown): ProtocolParams | null {
  const c = record(value);
  if (!c || (c.networkMode !== 'private' && c.networkMode !== 'regtest')) return null;
  if (Object.keys(c).some(key => !Object.hasOwn(DEFAULT_PROTOCOL_PARAMS, key))) return null;
  const interval = c.networkMode === 'private' ? 10_000 : 100;
  const numberRanges = {
    blockIntervalMs: [interval, interval], successionTimeoutMs: [3 * interval, 60 * interval],
    maxTxBytes: [128 * 1024, 16 * 1024 * 1024], maxFileBytes: [1024 * 1024, 300 * 1024 * 1024],
    maxBlockBytes: [192 * 1024, 64 * 1024 * 1024], maxTransactionsPerBlock: [2, 10_000],
    maxOutputsPerTransaction: [2, 4096], mempoolMaxAgeMs: [interval, 7 * 24 * 60 * 60 * 1000],
    fileMinPeerAcksForMining: [0, 8], filePeerAckTtlMs: [interval, 600_000],
  } as const;
  for (const [key, [min, max]] of Object.entries(numberRanges)) if (integer(c[key], min, max) === null) return null;
  const blockSubsidySatoshis = amount(c.blockSubsidySatoshis, 0n, 1_000_000_000_000n);
  const minStakeSatoshis = amount(c.minStakeSatoshis, 1n, 100_000_000_000_000n);
  const fee = record(c.feeSchedule), gas = record(c.gasSchedule), vm = record(c.vmLimits);
  if (blockSubsidySatoshis === null || minStakeSatoshis === null || !fee || !gas || !vm) return null;
  const feeRanges: Record<keyof FeeSchedule, readonly [bigint, bigint]> = {
    baseFeeSatoshis: [0n, 100_000_000n], byteRateSatoshis: [0n, 1000n], gasRateSatoshis: [0n, 1000n],
    gasUnitsPerSatoshi: [1n, 50_000_000n], storageRateSatoshis: [0n, 10_000n],
  };
  const feeSchedule = {} as FeeSchedule;
  for (const key of Object.keys(feeRanges) as (keyof FeeSchedule)[]) {
    const parsed = amount(fee[key], ...feeRanges[key]);
    if (parsed === null) return null;
    feeSchedule[key] = parsed;
  }
  const maxGasPerTx = amount(gas.maxGasPerTx, 100_000n, 10_000_000n);
  const blockGasLimit = amount(gas.blockGasLimit, 100_000n, 50_000_000n);
  if (maxGasPerTx === null || blockGasLimit === null || maxGasPerTx > blockGasLimit) return null;
  const vmMins: VmLimits = { maxStackDepth: 64, maxReturnStackDepth: 64, maxMemoryCells: 1024,
    maxInstructions: 10_000, maxStringChars: 4096, maxArrayLength: 256, maxBigIntBits: 256, maxPowExponent: 256 };
  const vmLimits = {} as VmLimits;
  for (const key of Object.keys(vmMins) as (keyof VmLimits)[]) {
    const parsed = integer(vm[key], vmMins[key], DEFAULT_VM_LIMITS[key]);
    if (parsed === null) return null;
    vmLimits[key] = parsed;
  }
  if ((c.maxBlockBytes as number) < (c.maxTxBytes as number) + 64 * 1024) return null;
  return { ...(c as unknown as ProtocolParams), blockSubsidySatoshis, minStakeSatoshis,
    feeSchedule, gasSchedule: { maxGasPerTx, blockGasLimit }, vmLimits };
}
export function withDefaultProtocolParams(overrides?: Partial<ProtocolParams>): ProtocolParams {
  const defaults = overrides?.networkMode === 'regtest' ? REGTEST_PROTOCOL_PARAMS : DEFAULT_PROTOCOL_PARAMS;
  return { ...defaults, ...overrides,
    feeSchedule: { ...defaults.feeSchedule, ...overrides?.feeSchedule },
    gasSchedule: { ...defaults.gasSchedule, ...overrides?.gasSchedule },
    vmLimits: { ...defaults.vmLimits, ...overrides?.vmLimits } };
}
/** Decode the Rust node's serde representation, used by the in-browser node. */
export function normalizeNativeProtocolParamsShape(value: unknown): ProtocolParams | null {
  const source = record(value);
  if (!source) return null;
  const camel = (input: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
    Object.entries(input).map(([key, entry]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), entry]),
  );
  const mapped = camel(source);
  for (const key of ['feeSchedule', 'gasSchedule', 'vmLimits']) {
    const nested = record(mapped[key]);
    if (!nested) return null;
    mapped[key] = camel(nested);
  }
  const gas = mapped.gasSchedule as Record<string, unknown>;
  for (const key of ['maxGasPerTx', 'blockGasLimit']) {
    if (integer(gas[key], 0, Number.MAX_SAFE_INTEGER) === null) return null;
    gas[key] = String(gas[key]);
  }
  return normalizeProtocolParamsShape(mapped);
}
