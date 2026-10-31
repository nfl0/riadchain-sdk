/**
 * Transaction utilities that can be used in both client and server
 * Pure functions only - no Node.js or browser-specific dependencies
 */

import { deriveContractAddress, deriveUpgradeableContractAddress, signData, getAddressFromPrivateKey, getAddressKind, isAccountAddress, isValidAddress } from './crypto.ts';
import type { EthAddress } from './crypto.ts';
import { calculateGasExecutionFee } from './feeSchedule.ts';
import { DEFAULT_PROTOCOL_PARAMS, type ProtocolParams } from './protocolParams.ts';
import { calculateCanonicalTransactionHash, encodeCanonicalSignedTransaction } from './canonicalChainEncoding.ts';
import { normalizeCanonicalFilePayload } from './filePayload.ts';
import type { CanonicalFilePayload } from './filePayload.ts';
import { PRODUCTION_SIGNER_GAS_LIMIT, PRODUCTION_SIGNER_SYSTEM_CONTRACT_ADDRESS } from './protocolConstants.ts';

export const SATOSHIS_PER_RDC = 100_000_000;
export const TOKEN_DECIMALS = 8;
export const TOKEN_BASE_UNITS = 10 ** TOKEN_DECIMALS;
const MAX_DECIMAL_AMOUNT_DIGITS = Math.ceil(
  DEFAULT_PROTOCOL_PARAMS.vmLimits.maxBigIntBits * Math.LOG10E * Math.LN2,
);
const TX_ID_PLACEHOLDER = '0'.repeat(64);
const SIGNATURE_PLACEHOLDER = '0'.repeat(130);

export interface TxInput {
  txId: string;
  outputIndex: number;
  address: EthAddress;
  signature: string;
}

export interface TxOutput {
  address: EthAddress;
  amount: bigint;
}

export interface Transaction {
  id: string;
  chainId: string;
  type: 'FILE' | 'CONTRACT' | 'TRANSFER' | 'COINBASE';
  inputs: TxInput[];
  outputs: TxOutput[];
  payload: any;
  timestamp: number;
  expiryHeight?: number | null;
  gasLimit?: number | null;
}

export interface CapabilityAuthorization {
  capabilityId: string;
  sequence: number;
  signature: string;
}

export interface DeviceCapabilityGrant {
  delegate: EthAddress;
  contractAddress: EthAddress;
  methods: string[];
  expiresAtHeight: number;
  maxGasPerCall: number;
  maxCallsPerBlock: number;
  delegateAsActor: boolean;
  feeBudget: bigint;
  storageBudgetBytes: number;
}

export interface UTXO {
  txId: string;
  outputIndex: number;
  address: EthAddress;
  amount: bigint;
}

export interface FeeBreakdown {
  baseFee: bigint;
  sizeFee: bigint;
  executionFee: bigint;
  storageFee: bigint;
  totalFee: bigint;
}

function parseDecimalAmount(
  amount: number | string | bigint,
  unitsPerWhole: number,
  decimals: number,
  assetLabel: string,
): bigint {
  if (typeof amount === 'bigint') {
    if (amount < BigInt(0)) throw new Error(`${assetLabel} amount cannot be negative`);
    return amount;
  }
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) throw new Error(`Invalid ${assetLabel} amount`);
    if (amount < 0) throw new Error(`${assetLabel} amount cannot be negative`);
  } else if (amount.startsWith('-')) {
    throw new Error(`${assetLabel} amount cannot be negative`);
  }

  const text = amount.toString();
  if (text.length > MAX_DECIMAL_AMOUNT_DIGITS + decimals + 32) {
    throw new Error(`${assetLabel} amount exceeds supported precision`);
  }
  const match = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) {
    throw new Error(`Invalid ${assetLabel} amount`);
  }

  const whole = match[1] ?? '';
  const fraction = match[2] ?? match[3] ?? '';
  const exponentText = match[4] ?? '0';
  // Parsing an unbounded exponent and then padding to it is a trivial memory
  // exhaustion vector. The protocol's bigint limit is the useful upper bound.
  if (exponentText.replace(/^[+-]/, '').length > 6) {
    throw new Error(`${assetLabel} amount exceeds supported precision`);
  }
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_AMOUNT_DIGITS + decimals) {
    throw new Error(`${assetLabel} amount exceeds supported precision`);
  }

  const digits = `${whole}${fraction}`;
  const scaledPosition = whole.length + exponent + decimals;
  let unitsDigits: string;
  if (scaledPosition < digits.length) {
    const discarded = digits.slice(Math.max(0, scaledPosition));
    if (scaledPosition < 0 || /[1-9]/.test(discarded)) {
      throw new Error(`${assetLabel} amount has more than ${decimals} decimal places`);
    }
    unitsDigits = digits.slice(0, scaledPosition);
  } else {
    const padding = scaledPosition - digits.length;
    if (digits.replace(/^0+/, '').length + padding > MAX_DECIMAL_AMOUNT_DIGITS) {
      throw new Error(`${assetLabel} amount exceeds supported precision`);
    }
    unitsDigits = `${digits}${'0'.repeat(padding)}`;
  }

  unitsDigits = unitsDigits.replace(/^0+/, '') || '0';
  if (unitsDigits.length > MAX_DECIMAL_AMOUNT_DIGITS) {
    throw new Error(`${assetLabel} amount exceeds supported precision`);
  }
  const units = BigInt(unitsDigits);
  // Keep the scale parameter honest if another asset adopts a non-power-of-ten
  // base in the future; the decimal-position algorithm assumes this identity.
  if (BigInt(10) ** BigInt(decimals) !== BigInt(unitsPerWhole)) {
    throw new Error(`${assetLabel} decimal scale is invalid`);
  }
  return units;
}

function formatDecimalAmount(value: bigint, unitsPerWhole: number, decimals: number): string {
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const whole = absolute / BigInt(unitsPerWhole);
  const fraction = (absolute % BigInt(unitsPerWhole)).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/**
 * Convert RDC amount to satoshis
 */
export function toSatoshis(rdcAmount: number | string | bigint): bigint {
  return parseDecimalAmount(rdcAmount, SATOSHIS_PER_RDC, TOKEN_DECIMALS, 'RDC');
}

/**
 * Convert satoshis to RDC amount
 */
export function toRDC(satoshis: bigint): number {
  return Number(satoshis) / SATOSHIS_PER_RDC;
}

export function formatSatoshisAsRdcString(satoshis: bigint): string {
  return formatDecimalAmount(satoshis, SATOSHIS_PER_RDC, TOKEN_DECIMALS);
}

export function parseTokenAmount(tokenAmount: number | string | bigint): bigint {
  return parseDecimalAmount(tokenAmount, TOKEN_BASE_UNITS, TOKEN_DECIMALS, 'token');
}

export function formatTokenAmount(tokenAmount: bigint): string {
  return formatDecimalAmount(tokenAmount, TOKEN_BASE_UNITS, TOKEN_DECIMALS);
}

/**
 * Calculate transaction hash
 * Must match the server-side implementation exactly
 */
export function calculateTxHash(
  chainId: string,
  type: string,
  inputs: TxInput[],
  outputs: TxOutput[],
  payload: any,
  timestamp: number,
  expiryHeight?: number | null,
  gasLimit?: number | null
): string {
  return calculateCanonicalTransactionHash({
    chainId,
    type,
    inputs: inputs.map((input) => ({
      txId: input.txId,
      outputIndex: input.outputIndex,
      address: input.address,
      signature: '',
    })),
    outputs,
    payload,
    timestamp,
    expiryHeight: expiryHeight ?? null,
    gasLimit: gasLimit ?? null,
  } as any);
}



export function estimateTxSizeBytes(tx: Transaction, options?: { assumeSigned?: boolean }): number {
  const normalizedTx = {
    id: tx.id || TX_ID_PLACEHOLDER,
    chainId: tx.chainId,
    type: tx.type,
    inputs: tx.inputs.map((input) => ({
      txId: input.txId,
      outputIndex: input.outputIndex,
      address: input.address,
      signature: options?.assumeSigned
        ? (input.signature || SIGNATURE_PLACEHOLDER)
        : input.signature,
    })),
    outputs: tx.outputs.map((output) => ({
      address: output.address,
      amount: output.amount,
    })),
    payload: options?.assumeSigned && tx.payload?.authorization
      ? { ...tx.payload, authorization: { ...tx.payload.authorization, signature: tx.payload.authorization.signature || SIGNATURE_PLACEHOLDER } }
      : tx.payload,
    timestamp: tx.timestamp,
    expiryHeight: tx.expiryHeight ?? null,
    gasLimit: tx.gasLimit ?? null,
  };
  return encodeCanonicalSignedTransaction(normalizedTx as any).length;
}

export function getContractCallValue(tx: Pick<Transaction, 'type' | 'payload'>): bigint {
  if (tx.type !== 'CONTRACT') return BigInt(0);
  const rawValue = tx.payload?.value;
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return BigInt(0);
  }
  if (
    typeof rawValue !== 'bigint'
    && typeof rawValue !== 'number'
    && typeof rawValue !== 'string'
  ) {
    throw new Error('Contract call value must be a non-negative integer');
  }
  if (typeof rawValue === 'number' && !Number.isSafeInteger(rawValue)) {
    throw new Error('Contract call value must be a non-negative integer');
  }
  if (typeof rawValue === 'string' && !/^\d+$/.test(rawValue)) {
    throw new Error('Contract call value must be a non-negative integer');
  }
  const value = BigInt(rawValue);
  if (value < BigInt(0)) {
    throw new Error('Contract call value must be a non-negative integer');
  }
  return value;
}

export function calculateFeeBreakdown(
  tx: Transaction,
  actualGasUsed?: bigint | null,
  protocolParams: ProtocolParams = DEFAULT_PROTOCOL_PARAMS
): FeeBreakdown {
  const feeSchedule = protocolParams.feeSchedule;
  const baseFee = feeSchedule.baseFeeSatoshis;
  const sizeFee = BigInt(estimateTxSizeBytes(tx, { assumeSigned: true }))
    * feeSchedule.byteRateSatoshis;
  const gasForFee = actualGasUsed ?? BigInt(tx.gasLimit ?? 0);
  const executionFee = tx.type === 'CONTRACT'
    ? calculateGasExecutionFee(gasForFee, feeSchedule)
    : BigInt(0);
  const storageFee = tx.type === 'FILE'
    ? BigInt(tx.payload?.size ?? 0) * feeSchedule.storageRateSatoshis
    : BigInt(0);
  const totalFee = baseFee + sizeFee + executionFee + storageFee;

  return { baseFee, sizeFee, executionFee, storageFee, totalFee };
}

export function calculateRequiredFee(
  tx: Transaction,
  actualGasUsed?: bigint | null,
  protocolParams: ProtocolParams = DEFAULT_PROTOCOL_PARAMS
): bigint {
  return calculateFeeBreakdown(tx, actualGasUsed, protocolParams).totalFee;
}

/**
 * Select UTXOs to cover a target amount
 * Returns selected UTXOs, total gathered, and change
 */
export function selectUtxos(
  utxos: UTXO[],
  targetAmount: bigint
): { selected: UTXO[]; gathered: bigint; change: bigint } {
  let gathered = BigInt(0);
  const selected: UTXO[] = [];
  
  for (const utxo of utxos) {
    selected.push(utxo);
    gathered += utxo.amount;
    if (gathered >= targetAmount) break;
  }
  
  const change = gathered - targetAmount;
  return { selected, gathered, change };
}

function sumOutputAmounts(outputs: TxOutput[]): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, BigInt(0));
}

export function normalizeTransactionWirePayload(payload: any): any {
  if (payload === undefined) return undefined;
  return JSON.parse(JSON.stringify(payload, (_, v) => typeof v === 'bigint' ? v.toString() : v));
}

function buildFundedTx(params: {
  chainId: string;
  type: Transaction['type'];
  senderAddress: EthAddress;
  payload: any;
  timestamp: number;
  utxos: UTXO[];
  fixedOutputs: TxOutput[];
  reservedValue?: bigint;
  expiryHeight?: number | null;
  gasLimit?: number | null;
  protocolParams?: ProtocolParams;
}): { tx: Transaction } | { error: string } {
  const protocolParams = params.protocolParams ?? DEFAULT_PROTOCOL_PARAMS;
  const normalizedPayload = normalizeTransactionWirePayload(params.payload);
  const reservedValue = params.reservedValue ?? BigInt(0);
  if (params.type === 'CONTRACT') {
    if (params.gasLimit === undefined || params.gasLimit === null) {
      return { error: 'gasLimit is required for CONTRACT transactions' };
    }
    const normalizedGasLimit = BigInt(params.gasLimit);
    if (normalizedGasLimit <= BigInt(0) || normalizedGasLimit > protocolParams.gasSchedule.maxGasPerTx) {
      return { error: 'gasLimit is out of range' };
    }
  }

  const fixedAmount = sumOutputAmounts(params.fixedOutputs);
  let gathered = BigInt(0);
  let minimumRequired = fixedAmount + reservedValue
    + protocolParams.feeSchedule.baseFeeSatoshis;
  const selected: UTXO[] = [];
  for (const utxo of params.utxos) {
    selected.push(utxo);
    gathered += utxo.amount;
    if (gathered < minimumRequired) continue;

    const inputs = buildTxInputs(selected, params.senderAddress);
    let change = gathered - fixedAmount - reservedValue;

    for (let iteration = 0; iteration < 8; iteration++) {
      const outputs = [
        ...params.fixedOutputs,
        ...(change > BigInt(0) ? [{ address: params.senderAddress, amount: change }] : []),
      ];
      const candidate: Transaction = {
        id: '',
        chainId: params.chainId,
        type: params.type,
        inputs,
        outputs,
        payload: normalizedPayload,
        timestamp: params.timestamp,
        expiryHeight: params.expiryHeight ?? undefined,
        gasLimit: params.gasLimit ?? undefined,
      };
      const requiredFee = calculateRequiredFee(candidate, undefined, protocolParams);
      const nextChange = gathered - fixedAmount - reservedValue - requiredFee;
      if (nextChange < BigInt(0)) {
        minimumRequired = fixedAmount + reservedValue + requiredFee;
        break;
      }
      if (nextChange === change) {
        if (outputs.length > protocolParams.maxOutputsPerTransaction) return { error: 'Too many transaction outputs' };
        if (estimateTxSizeBytes(candidate, { assumeSigned: true }) > protocolParams.maxTxBytes) return { error: 'Transaction exceeds maxTxBytes' };
        const finalOutputs = [
          ...params.fixedOutputs,
          ...(nextChange > BigInt(0) ? [{ address: params.senderAddress, amount: nextChange }] : []),
        ];
        const txId = calculateTxHash(
          params.chainId,
          params.type,
          inputs,
          finalOutputs,
          normalizedPayload,
          params.timestamp,
          params.expiryHeight,
          params.gasLimit
        );
        return {
          tx: {
            id: txId,
            chainId: params.chainId,
            type: params.type,
            inputs,
            outputs: finalOutputs,
            payload: normalizedPayload,
            timestamp: params.timestamp,
            expiryHeight: params.expiryHeight ?? undefined,
            gasLimit: params.gasLimit ?? undefined,
          },
        };
      }
      change = nextChange;
    }
  }

  return { error: 'Insufficient funds' };
}

function buildCapabilityVaultTx(params: {
  chainId: string;
  type: 'CONTRACT' | 'FILE';
  payload: any;
  timestamp: number;
  expiryHeight?: number | null;
  gasLimit?: number | null;
  protocolParams?: ProtocolParams;
}): Transaction {
  const protocolParams = params.protocolParams ?? DEFAULT_PROTOCOL_PARAMS;
  if (params.type === 'CONTRACT' && (!Number.isSafeInteger(params.gasLimit) || BigInt(params.gasLimit!) <= 0n
    || BigInt(params.gasLimit!) > protocolParams.gasSchedule.maxGasPerTx)) throw new Error('gasLimit is out of range');
  const payload = normalizeTransactionWirePayload(params.payload);
  const tx: Transaction = {
    id: '',
    chainId: params.chainId,
    type: params.type,
    inputs: [],
    outputs: [],
    payload,
    timestamp: params.timestamp,
    expiryHeight: params.expiryHeight ?? undefined,
    gasLimit: params.gasLimit ?? undefined,
  };
  if (estimateTxSizeBytes(tx, { assumeSigned: true }) > protocolParams.maxTxBytes) throw new Error('Transaction exceeds maxTxBytes');
  tx.id = calculateTxHash(
    tx.chainId,
    tx.type,
    tx.inputs,
    tx.outputs,
    tx.payload,
    tx.timestamp,
    tx.expiryHeight,
    tx.gasLimit,
  );
  return tx;
}

export function buildCapabilityContractCallTx(
  chainId: string,
  contractAddress: EthAddress,
  method: string,
  data: any,
  timestamp: number,
  options: { capabilityId: string; sequence: number; gasLimit: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
): Transaction {
  return buildCapabilityVaultTx({
    chainId,
    type: 'CONTRACT',
    payload: {
      action: 'call', contractAddress, method, data,
      authorization: { capabilityId: options.capabilityId, sequence: options.sequence, signature: '' },
    },
    timestamp,
    expiryHeight: options.expiryHeight,
    gasLimit: options.gasLimit,
    protocolParams: options.protocolParams,
  });
}

export function buildCapabilityFileTx(
  chainId: string,
  file: CanonicalFilePayload,
  timestamp: number,
  options: { capabilityId: string; sequence: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
): Transaction {
  const normalized = normalizeCanonicalFilePayload(file, (options.protocolParams ?? DEFAULT_PROTOCOL_PARAMS).maxFileBytes);
  return buildCapabilityVaultTx({
    chainId,
    type: 'FILE',
    payload: {
      ...(normalized.filename ? { filename: normalized.filename } : {}),
      cid: normalized.cid,
      size: normalized.size,
      storage: 'helia',
      ...(normalized.mimeType ? { mimeType: normalized.mimeType } : {}),
      authorization: { capabilityId: options.capabilityId, sequence: options.sequence, signature: '' },
    },
    timestamp,
    expiryHeight: options.expiryHeight,
    protocolParams: options.protocolParams,
  });
}

/**
 * Build transaction inputs from selected UTXOs
 */
export function buildTxInputs(
  selectedUtxos: UTXO[],
  address: EthAddress
): TxInput[] {
  return selectedUtxos.map((utxo) => ({
    txId: utxo.txId,
    outputIndex: utxo.outputIndex,
    address,
    signature: '', // To be filled after signing
  }));
}

/**
 * Build a contract deployment transaction.
 *
 * `options.gasLimit` is required: omitting it is a compile-time error for TypeScript
 * callers and a runtime error (`{ error: ... }`) for JavaScript callers.
 */
export function buildContractDeployTx(
  chainId: string,
  deployerAddress: EthAddress,
  code: string,
  salt: string,
  timestamp: number,
  utxos: UTXO[],
  options: {
    gasLimit: number;
    expiryHeight?: number | null;
    protocolParams?: ProtocolParams;
    /**
     * Optional address allowed to upgrade this contract via `CONTRACT/upgrade`
     * transactions. When provided, the contract is deployed using the
     * code-hash-free address derivation (see `deriveUpgradeableContractAddress`).
     */
    upgradeAuthority?: EthAddress | null;
  }
): { tx: Transaction; contractAddress: string } | { error: string } {
  const { gasLimit, expiryHeight, upgradeAuthority, protocolParams } = options ?? {};
  if (gasLimit === undefined || gasLimit === null) {
    return { error: 'gasLimit is required for CONTRACT transactions' };
  }

  const isUpgradeable = upgradeAuthority !== undefined && upgradeAuthority !== null && (upgradeAuthority as string).length > 0;
  const contractAddress = isUpgradeable
    ? deriveUpgradeableContractAddress(deployerAddress, salt)
    : deriveContractAddress(deployerAddress, salt, code);
  const payload: Record<string, unknown> = {
    action: 'deploy',
    code,
    salt,
  };
  if (isUpgradeable) {
    payload.upgradeAuthority = upgradeAuthority;
  }

  const built = buildFundedTx({
    chainId,
    type: 'CONTRACT',
    senderAddress: deployerAddress,
    payload,
    timestamp,
    utxos,
    fixedOutputs: [],
    expiryHeight,
    gasLimit,
    protocolParams,
  });
  if ('error' in built) {
    return built;
  }

  return { tx: built.tx, contractAddress };
}

/**
 * Build a transaction that replaces an upgradeable contract's bytecode.
 * The sender must equal the contract's current `upgrade_authority`. Optionally
 * transfers or renounces the authority via `newAuthority` (null = renounce).
 */
export function buildContractUpgradeTx(
  chainId: string,
  senderAddress: EthAddress,
  contractAddress: EthAddress,
  newCode: string,
  timestamp: number,
  utxos: UTXO[],
  options: { gasLimit: number; expiryHeight?: number | null; newAuthority?: EthAddress | null; protocolParams?: ProtocolParams }
): { tx: Transaction } | { error: string } {
  const { gasLimit, expiryHeight } = options ?? {};
  if (gasLimit === undefined || gasLimit === null) {
    return { error: 'gasLimit is required for CONTRACT transactions' };
  }
  const payload: Record<string, unknown> = {
    action: 'upgrade',
    contractAddress,
    newCode,
  };
  if ('newAuthority' in options) {
    payload.newAuthority = options.newAuthority ?? null;
  }
  const built = buildFundedTx({
    chainId,
    type: 'CONTRACT',
    senderAddress,
    payload,
    timestamp,
    utxos,
    fixedOutputs: [],
    expiryHeight,
    gasLimit,
    protocolParams: options.protocolParams,
  });
  if ('error' in built) return built;
  return { tx: built.tx };
}

/**
 * Build a contract call transaction.
 *
 * `options.gasLimit` is required: omitting it is a compile-time error for TypeScript
 * callers and a runtime error (`{ error: ... }`) for JavaScript callers.
 */
export function buildContractCallTx(
  chainId: string,
  callerAddress: EthAddress,
  contractAddress: EthAddress,
  method: string,
  data: any,
  timestamp: number,
  utxos: UTXO[],
  options: {
    gasLimit: number;
    callValue?: bigint;
    tokenSpend?: Array<{
      operation: 'transfer' | 'burn';
      tokenId: bigint;
      maxAmount: bigint;
      allowedContract: EthAddress;
      allowedMethod: string;
      to?: EthAddress | null;
    }>;
    expiryHeight?: number | null;
    authorization?: CapabilityAuthorization;
    protocolParams?: ProtocolParams;
  }
): { tx: Transaction } | { error: string } {
  const { gasLimit, callValue = BigInt(0), tokenSpend, expiryHeight, authorization, protocolParams } = options ?? {};
  if (gasLimit === undefined || gasLimit === null) {
    return { error: 'gasLimit is required for CONTRACT transactions' };
  }

  const payload = {
    action: 'call',
    contractAddress,
    method,
    data,
    ...(callValue > BigInt(0) ? { value: callValue.toString() } : {}),
    ...(tokenSpend && tokenSpend.length > 0 ? { tokenSpend } : {}),
    ...(authorization ? { authorization } : {}),
  };

  return buildFundedTx({
    chainId,
    type: 'CONTRACT',
    senderAddress: callerAddress,
    payload,
    timestamp,
    utxos,
    fixedOutputs: [],
    reservedValue: callValue,
    expiryHeight,
    gasLimit,
    protocolParams,
  });
}

/** Authorize one operational block signer without granting spending authority. */
export function buildProductionSignerSetTx(
  chainId: string,
  ownerAddress: EthAddress,
  signerAddress: EthAddress,
  timestamp: number,
  utxos: UTXO[],
  options: { expiryHeight?: number | null; protocolParams?: ProtocolParams } = {},
): { tx: Transaction } | { error: string } {
  if (!isAccountAddress(ownerAddress) || !isAccountAddress(signerAddress)) {
    return { error: 'Production owner and signer must be account addresses' };
  }
  return buildContractCallTx(chainId, ownerAddress, PRODUCTION_SIGNER_SYSTEM_CONTRACT_ADDRESS,
    'setSigner', { signer: signerAddress.toLowerCase() }, timestamp, utxos,
    { expiryHeight: options.expiryHeight, protocolParams: options.protocolParams,
      gasLimit: PRODUCTION_SIGNER_GAS_LIMIT, callValue: 0n });
}

/** Remove the additional signer; the owner always retains production authority. */
export function buildProductionSignerRevokeTx(
  chainId: string,
  ownerAddress: EthAddress,
  timestamp: number,
  utxos: UTXO[],
  options: { expiryHeight?: number | null; protocolParams?: ProtocolParams } = {},
): { tx: Transaction } | { error: string } {
  if (!isAccountAddress(ownerAddress)) return { error: 'Production owner must be an account address' };
  return buildContractCallTx(chainId, ownerAddress, PRODUCTION_SIGNER_SYSTEM_CONTRACT_ADDRESS,
    'revokeSigner', {}, timestamp, utxos,
    { expiryHeight: options.expiryHeight, protocolParams: options.protocolParams,
      gasLimit: PRODUCTION_SIGNER_GAS_LIMIT, callValue: 0n });
}

/** Grant one device key a bounded, fee-sponsored contract-call capability. */
export function buildDeviceCapabilityGrantTx(
  chainId: string,
  ownerAddress: EthAddress,
  grant: DeviceCapabilityGrant,
  timestamp: number,
  utxos: UTXO[],
  options: { gasLimit: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
): { tx: Transaction } | { error: string } {
  if (!Number.isSafeInteger(options?.gasLimit) || options.gasLimit <= 0) {
    return { error: 'gasLimit is required for CONTRACT transactions' };
  }
  if (!isAccountAddress(grant.delegate)) return { error: 'capability delegate must be an account address' };
  if (!isValidAddress(grant.contractAddress)
    || !['contract', 'internal_contract', 'system_contract'].includes(getAddressKind(grant.contractAddress))) {
    return { error: 'capability target must be a contract address' };
  }
  if (!Number.isSafeInteger(grant.expiresAtHeight) || grant.expiresAtHeight <= 0) {
    return { error: 'capability expiry height must be a positive safe integer' };
  }
  if (!Number.isSafeInteger(grant.maxGasPerCall) || grant.maxGasPerCall <= 0) {
    return { error: 'capability gas ceiling must be a positive safe integer' };
  }
  if (!Number.isSafeInteger(grant.maxCallsPerBlock)
    || grant.maxCallsPerBlock <= 0
    || grant.maxCallsPerBlock > 1_024) {
    return { error: 'capability block rate must be between 1 and 1024' };
  }
  if (grant.feeBudget <= 0n) return { error: 'capability fee budget must be positive' };
  if (!Number.isSafeInteger(grant.storageBudgetBytes) || grant.storageBudgetBytes < 0) {
    return { error: 'capability storage budget must be a non-negative safe integer' };
  }
  if (!Array.isArray(grant.methods)) return { error: 'capability methods must be a list' };
  const methods = [...new Set(grant.methods)].sort();
  const encoder = new TextEncoder();
  if (methods.length === 0 || methods.length > 32
    || methods.some((method) => typeof method !== 'string' || encoder.encode(method).length === 0 || encoder.encode(method).length > 128)) {
    return { error: 'capability methods must contain 1-32 names of at most 128 UTF-8 bytes' };
  }
  return buildFundedTx({
    chainId,
    type: 'CONTRACT',
    senderAddress: ownerAddress,
    payload: {
      action: 'grant_capability',
      ...grant,
      delegate: grant.delegate.toLowerCase(),
      contractAddress: grant.contractAddress.toLowerCase(),
      methods,
      feeBudget: grant.feeBudget.toString(),
    },
    timestamp,
    utxos,
    fixedOutputs: [],
    reservedValue: grant.feeBudget,
    expiryHeight: options.expiryHeight,
    gasLimit: options.gasLimit,
    protocolParams: options.protocolParams,
  });
}

/** Permanently revoke a native device capability. */
export function buildDeviceCapabilityRevokeTx(
  chainId: string,
  ownerAddress: EthAddress,
  capabilityId: string,
  timestamp: number,
  utxos: UTXO[],
  options: { gasLimit: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
): { tx: Transaction } | { error: string } {
  if (!/^[0-9a-f]{64}$/.test(capabilityId)) return { error: 'capability ID must be 64 lowercase hex characters' };
  return buildFundedTx({
    chainId,
    type: 'CONTRACT',
    senderAddress: ownerAddress,
    payload: { action: 'revoke_capability', capabilityId },
    timestamp,
    utxos,
    fixedOutputs: [],
    expiryHeight: options.expiryHeight,
    gasLimit: options.gasLimit,
    protocolParams: options.protocolParams,
  });
}

/** Add RDC to an existing capability fee vault without changing its scope. */
export function buildDeviceCapabilityTopUpTx(
  chainId: string,
  ownerAddress: EthAddress,
  capabilityId: string,
  amount: bigint,
  timestamp: number,
  utxos: UTXO[],
  options: { gasLimit: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
): { tx: Transaction } | { error: string } {
  if (!/^[0-9a-f]{64}$/.test(capabilityId)) return { error: 'capability ID must be 64 lowercase hex characters' };
  if (amount <= 0n) return { error: 'capability top-up amount must be positive' };
  return buildFundedTx({
    chainId,
    type: 'CONTRACT',
    senderAddress: ownerAddress,
    payload: { action: 'top_up_capability', capabilityId, amount: amount.toString() },
    timestamp,
    utxos,
    fixedOutputs: [],
    reservedValue: amount,
    expiryHeight: options.expiryHeight,
    gasLimit: options.gasLimit,
    protocolParams: options.protocolParams,
  });
}

/** Build a prepaid one-shot contract call for deterministic future execution. */
export function buildScheduledContractCallTx(
  chainId: string,
  callerAddress: EthAddress,
  contractAddress: EthAddress,
  method: string,
  data: any,
  executeAtHeight: number,
  timestamp: number,
  utxos: UTXO[],
  options: { gasLimit: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
): { tx: Transaction } | { error: string } {
  const { gasLimit, expiryHeight } = options ?? {};
  if (gasLimit === undefined || gasLimit === null) {
    return { error: 'gasLimit is required for scheduled CONTRACT transactions' };
  }
  if (!Number.isSafeInteger(executeAtHeight) || executeAtHeight <= 0) {
    return { error: 'executeAtHeight must be a positive safe integer' };
  }
  return buildFundedTx({
    chainId,
    type: 'CONTRACT',
    senderAddress: callerAddress,
    payload: {
      action: 'schedule_call',
      contractAddress,
      method,
      data,
      executeAtHeight,
    },
    timestamp,
    utxos,
    fixedOutputs: [],
    expiryHeight,
    gasLimit,
    protocolParams: options.protocolParams,
  });
}

/** Build an owner-authorized cancellation for a pending scheduled call. */
export function buildCancelScheduledContractCallTx(
  chainId: string,
  callerAddress: EthAddress,
  scheduleId: string,
  timestamp: number,
  utxos: UTXO[],
  options: { gasLimit: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
): { tx: Transaction } | { error: string } {
  const { gasLimit, expiryHeight } = options ?? {};
  if (gasLimit === undefined || gasLimit === null) {
    return { error: 'gasLimit is required for scheduled call cancellation' };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(scheduleId)) {
    return { error: 'scheduleId must be a 32-byte hexadecimal transaction id' };
  }
  return buildFundedTx({
    chainId,
    type: 'CONTRACT',
    senderAddress: callerAddress,
    payload: {
      action: 'cancel_scheduled_call',
      scheduleId: scheduleId.toLowerCase(),
    },
    timestamp,
    utxos,
    fixedOutputs: [],
    expiryHeight,
    gasLimit,
    protocolParams: options.protocolParams,
  });
}

/**
 * Build a transfer transaction
 */
export function buildTransferTx(
  chainId: string,
  senderAddress: EthAddress,
  recipientAddress: EthAddress,
  amount: bigint,
  timestamp: number,
  utxos: UTXO[],
  expiryHeight?: number | null,
  protocolParams?: ProtocolParams,
): { tx: Transaction } | { error: string } {
  return buildFundedTx({
    chainId,
    type: 'TRANSFER',
    senderAddress,
    payload: null,
    timestamp,
    utxos,
    fixedOutputs: [{ address: recipientAddress, amount }],
    expiryHeight,
    protocolParams,
  });
}

/**
 * Spend every supplied UTXO into one output, deducting the exact transaction
 * fee from that output. This is used for max-value sends and UTXO compaction.
 */
export function buildSweepTx(
  chainId: string,
  senderAddress: EthAddress,
  recipientAddress: EthAddress,
  timestamp: number,
  utxos: UTXO[],
  expiryHeight?: number | null,
  protocolParams: ProtocolParams = DEFAULT_PROTOCOL_PARAMS,
): { tx: Transaction } | { error: string } {
  if (utxos.length === 0) return { error: 'Insufficient funds' };

  const gathered = utxos.reduce((sum, utxo) => sum + utxo.amount, BigInt(0));
  const inputs = buildTxInputs(utxos, senderAddress);
  let amount = gathered;

  for (let iteration = 0; iteration < 8; iteration++) {
    const outputs = amount > BigInt(0) ? [{ address: recipientAddress, amount }] : [];
    const candidate: Transaction = {
      id: '',
      chainId,
      type: 'TRANSFER',
      inputs,
      outputs,
      payload: null,
      timestamp,
      expiryHeight: expiryHeight ?? undefined,
    };
    const nextAmount = gathered - calculateRequiredFee(candidate, undefined, protocolParams);
    if (nextAmount <= BigInt(0)) return { error: 'Insufficient funds for transaction fee' };
    if (nextAmount === amount) {
      if (estimateTxSizeBytes(candidate, { assumeSigned: true }) > protocolParams.maxTxBytes) return { error: 'Transaction exceeds maxTxBytes' };
      const txId = calculateTxHash(
        chainId,
        'TRANSFER',
        inputs,
        outputs,
        null,
        timestamp,
        expiryHeight,
      );
      return { tx: { ...candidate, id: txId } };
    }
    amount = nextAmount;
  }

  return { error: 'Unable to calculate transaction fee' };
}

export function buildBatchTransferTx(
  chainId: string,
  senderAddress: EthAddress,
  recipients: Array<{ address: EthAddress; amount: bigint }>,
  timestamp: number,
  utxos: UTXO[],
  expiryHeight?: number | null,
  protocolParams?: ProtocolParams,
): { tx: Transaction } | { error: string } {
  if (recipients.length === 0) {
    return { error: 'At least one recipient is required' };
  }
  return buildFundedTx({
    chainId,
    type: 'TRANSFER',
    senderAddress,
    payload: null,
    timestamp,
    utxos,
    fixedOutputs: recipients.map((recipient) => ({
      address: recipient.address,
      amount: recipient.amount,
    })),
    expiryHeight,
    protocolParams,
  });
}

/**
 * Build a FILE transaction
 * Used for storing file data on chain
 */
export function buildFileTx(
  chainId: string,
  senderAddress: EthAddress,
  file: CanonicalFilePayload,
  timestamp: number,
  utxos: UTXO[],
  expiryHeight?: number | null,
  protocolParams: ProtocolParams = DEFAULT_PROTOCOL_PARAMS,
): { tx: Transaction } | { error: string } {
  let normalized: CanonicalFilePayload;
  try {
    normalized = normalizeCanonicalFilePayload(file, protocolParams.maxFileBytes);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid canonical FILE payload' };
  }
  const payload = {
    ...(normalized.filename ? { filename: normalized.filename } : {}),
    cid: normalized.cid,
    size: normalized.size,
    storage: 'helia' as const,
    ...(normalized.mimeType ? { mimeType: normalized.mimeType } : {}),
  };

  return buildFundedTx({
    chainId,
    type: 'FILE',
    senderAddress,
    payload,
    timestamp,
    utxos,
    fixedOutputs: [],
    expiryHeight,
    protocolParams,
  });
}

/**
 * Sign a transaction with a private key
 * Returns the signed transaction
 */
export function signTransaction(
  tx: Transaction,
  privateKey: string
): Transaction {
  const signerAddress = getAddressFromPrivateKey(privateKey).toLowerCase();
  const mismatchedInput = tx.inputs.find((input) => input.address.toLowerCase() !== signerAddress);
  if (mismatchedInput) {
    throw new Error('Transaction inputs must all belong to the signing key');
  }
  const signature = signData(tx.id, privateKey);
  
  return {
    ...tx,
    inputs: tx.inputs.map((input) => ({
      ...input,
      signature,
    })),
  };
}

/**
 * Sign a sponsored call with its delegated device key. The transaction inputs
 * remain owned by the household sponsor and consensus checks the capability.
 */
export function signDelegatedTransaction(tx: Transaction, delegatePrivateKey: string): Transaction {
  const authorization = tx.payload?.authorization;
  if (!authorization || !((tx.type === 'CONTRACT' && tx.payload?.action === 'call') || tx.type === 'FILE')) {
    throw new Error('Delegated signing requires an authorized contract call or file');
  }
  if (tx.inputs.length !== 0 || tx.outputs.length !== 0) {
    throw new Error('Capability-vault transactions cannot contain UTXO inputs or outputs');
  }
  const signature = signData(tx.id, delegatePrivateKey);
  return {
    ...tx,
    payload: { ...tx.payload, authorization: { ...authorization, signature } },
  };
}
