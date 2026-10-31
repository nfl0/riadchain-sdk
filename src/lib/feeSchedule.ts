import { DEFAULT_PROTOCOL_PARAMS } from './protocolParams.ts';

export const FEE_SCHEDULE = {
  BASE_FEE_SATOSHIS: DEFAULT_PROTOCOL_PARAMS.feeSchedule.baseFeeSatoshis,
  BYTE_RATE_SATOSHIS: DEFAULT_PROTOCOL_PARAMS.feeSchedule.byteRateSatoshis,
  GAS_RATE_SATOSHIS: DEFAULT_PROTOCOL_PARAMS.feeSchedule.gasRateSatoshis,
  GAS_UNITS_PER_SATOSHI: DEFAULT_PROTOCOL_PARAMS.feeSchedule.gasUnitsPerSatoshi,
  STORAGE_RATE_SATOSHIS: DEFAULT_PROTOCOL_PARAMS.feeSchedule.storageRateSatoshis,
} as const;

export const GAS_SCHEDULE = {
  MAX_GAS_PER_TX: DEFAULT_PROTOCOL_PARAMS.gasSchedule.maxGasPerTx,
  BLOCK_GAS_LIMIT: DEFAULT_PROTOCOL_PARAMS.gasSchedule.blockGasLimit,
} as const;

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) {
    throw new Error('denominator must be positive');
  }
  if (numerator <= BigInt(0)) {
    return BigInt(0);
  }
  return ((numerator - BigInt(1)) / denominator) + BigInt(1);
}

export function calculateGasExecutionFee(
  gasUsed: bigint,
  feeSchedule = DEFAULT_PROTOCOL_PARAMS.feeSchedule
): bigint {
  return ceilDiv(gasUsed, feeSchedule.gasUnitsPerSatoshi) * feeSchedule.gasRateSatoshis;
}
