import { getAddressKind, isAccountAddress, isValidAddress, type EthAddress } from './internal/crypto.ts';
import { RiadchainProvider } from './provider.ts';
import type { DeviceCapability } from './types.ts';
import { WalletSession } from './wallet.ts';

export type TemporaryAccessScope = {
  delegate: EthAddress;
  contractAddress: EthAddress;
  methods: string[];
  expiresAtHeight?: number;
  durationBlocks?: number;
  maxGasPerCall: number;
  maxCallsPerBlock?: number;
  feeBudget: bigint;
  storageBudgetBytes?: number;
  delegateAsActor?: boolean;
};

export type TemporaryAccessOptions = {
  gasLimit?: number;
  timeoutMs?: number;
  transactionExpiryHeight?: number | null;
};

function safePositive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function normalizeCapabilityId(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Capability ID must be 64 lowercase hex characters');
  }
  return value;
}

function normalizedContract(value: EthAddress): EthAddress {
  if (!isValidAddress(value)) throw new Error('Temporary access contract must be a canonical address');
  const address = value.toLowerCase() as EthAddress;
  if (!['contract', 'internal_contract', 'system_contract'].includes(getAddressKind(address))) {
    throw new Error('Temporary access target must use a contract address namespace');
  }
  return address;
}

function normalizedDelegate(value: EthAddress): EthAddress {
  if (!isAccountAddress(value)) throw new Error('Temporary access delegate must be an account address');
  return value.toLowerCase() as EthAddress;
}

function normalizedMethods(values: readonly string[]): string[] {
  const encoder = new TextEncoder();
  const methods = [...new Set(values)].sort();
  if (methods.length === 0 || methods.length > 32
    || methods.some((method) => typeof method !== 'string'
      || encoder.encode(method).length === 0
      || encoder.encode(method).length > 128)) {
    throw new Error('Temporary access must allow 1-32 methods of at most 128 UTF-8 bytes');
  }
  return methods;
}

export function temporaryAccessRemainingBlocks(
  capability: Pick<DeviceCapability, 'expiresAtHeight' | 'revoked'>,
  currentHeight: number,
): number {
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) {
    throw new Error('Current height must be a non-negative safe integer');
  }
  if (capability.revoked || capability.expiresAtHeight <= currentHeight) return 0;
  return capability.expiresAtHeight - currentHeight;
}

export function estimateTemporaryAccessDuration(
  remainingBlocks: number,
  expectedBlockIntervalMs: number,
): number {
  if (!Number.isSafeInteger(remainingBlocks) || remainingBlocks < 0) {
    throw new Error('Remaining blocks must be a non-negative safe integer');
  }
  safePositive(expectedBlockIntervalMs, 'Expected block interval');
  const duration = remainingBlocks * expectedBlockIntervalMs;
  if (!Number.isSafeInteger(duration)) throw new Error('Estimated duration exceeds safe integer range');
  return duration;
}

export class TemporaryAccessClient {
  readonly provider: RiadchainProvider;

  constructor(provider: RiadchainProvider) {
    this.provider = provider;
  }

  async issue(
    wallet: WalletSession,
    scope: TemporaryAccessScope,
    options: TemporaryAccessOptions = {},
  ): Promise<DeviceCapability> {
    const currentHeight = await this.provider.getLatestHeight();
    if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) {
      throw new Error('Node returned an invalid current height');
    }
    if ((scope.expiresAtHeight === undefined) === (scope.durationBlocks === undefined)) {
      throw new Error('Set exactly one of expiresAtHeight or durationBlocks');
    }
    const expiresAtHeight = scope.expiresAtHeight === undefined
      ? currentHeight + safePositive(scope.durationBlocks!, 'Temporary access durationBlocks')
      : safePositive(scope.expiresAtHeight, 'Temporary access expiresAtHeight');
    if (!Number.isSafeInteger(expiresAtHeight) || expiresAtHeight <= currentHeight) {
      throw new Error('Temporary access expiry must be a future safe block height');
    }
    const maxCallsPerBlock = scope.maxCallsPerBlock ?? 1;
    if (maxCallsPerBlock > 1_024) throw new Error('Temporary access maxCallsPerBlock cannot exceed 1024');
    const storageBudgetBytes = scope.storageBudgetBytes ?? 0;
    if (!Number.isSafeInteger(storageBudgetBytes) || storageBudgetBytes < 0) {
      throw new Error('Temporary access storage budget must be a non-negative safe integer');
    }
    if (scope.feeBudget <= 0n) throw new Error('Temporary access fee budget must be positive');

    const issued = await wallet.grantDeviceCapability({
      delegate: normalizedDelegate(scope.delegate),
      contractAddress: normalizedContract(scope.contractAddress),
      methods: normalizedMethods(scope.methods),
      expiresAtHeight,
      maxGasPerCall: safePositive(scope.maxGasPerCall, 'Temporary access maxGasPerCall'),
      maxCallsPerBlock: safePositive(maxCallsPerBlock, 'Temporary access maxCallsPerBlock'),
      delegateAsActor: scope.delegateAsActor ?? true,
      feeBudget: scope.feeBudget,
      storageBudgetBytes,
    }, {
      gasLimit: options.gasLimit,
      timeoutMs: options.timeoutMs,
      expiryHeight: options.transactionExpiryHeight,
    });
    const capability = await this.provider.getDeviceCapability(issued.tx.id);
    if (capability === null) throw new Error('Confirmed temporary access capability is unavailable');
    return capability;
  }

  async get(capabilityId: string): Promise<DeviceCapability | null> {
    return this.provider.getDeviceCapability(normalizeCapabilityId(capabilityId));
  }

  async list(params: {
    owner?: EthAddress;
    delegate?: EthAddress;
    contractAddress?: EthAddress;
    includeInactive?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<DeviceCapability[]> {
    const currentHeight = await this.provider.getLatestHeight();
    const result = await this.provider.listDeviceCapabilities({
      owner: params.owner,
      delegate: params.delegate,
      contractAddress: params.contractAddress,
      limit: params.limit,
      offset: params.offset,
    });
    return params.includeInactive
      ? result.capabilities
      : result.capabilities.filter((capability) => temporaryAccessRemainingBlocks(capability, currentHeight) > 0);
  }

  async revoke(
    wallet: WalletSession,
    capabilityId: string,
    options: TemporaryAccessOptions = {},
  ): Promise<DeviceCapability> {
    const id = normalizeCapabilityId(capabilityId);
    await wallet.revokeDeviceCapability(id, {
      gasLimit: options.gasLimit,
      timeoutMs: options.timeoutMs,
      expiryHeight: options.transactionExpiryHeight,
    });
    const capability = await this.provider.getDeviceCapability(id);
    if (capability === null || !capability.revoked) {
      throw new Error('Confirmed temporary access revocation is unavailable');
    }
    return capability;
  }

  async topUp(
    wallet: WalletSession,
    capabilityId: string,
    amount: bigint,
    options: TemporaryAccessOptions = {},
  ): Promise<DeviceCapability> {
    const id = normalizeCapabilityId(capabilityId);
    if (amount <= 0n) throw new Error('Temporary access top-up must be positive');
    await wallet.topUpDeviceCapability(id, amount, {
      gasLimit: options.gasLimit,
      timeoutMs: options.timeoutMs,
      expiryHeight: options.transactionExpiryHeight,
    });
    const capability = await this.provider.getDeviceCapability(id);
    if (capability === null) throw new Error('Confirmed temporary access capability is unavailable');
    return capability;
  }
}
