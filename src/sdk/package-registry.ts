import type { ContractValue } from '../lib/contractValueCodec.ts';
import { keccak256Hex } from './internal/crypto.ts';
import { normalizeCanonicalFileCid } from '../lib/filePayload.ts';
import { getAddressKind, isAccountAddress, isValidAddress, type EthAddress } from './internal/crypto.ts';
import { RiadchainProvider } from './provider.ts';
import type { TransactionReceipt } from './types.ts';
import { WalletSession } from './wallet.ts';

export const CHARLIE_PACKAGE_MAX_ENTRIES = 256n;
export const CHARLIE_PACKAGE_MAX_PAGE_SIZE = 50n;
export const CHARLIE_PACKAGE_MAX_SOURCE_BYTES = 49_152;
export const CHARLIE_PACKAGE_MAX_DEPLOYMENTS = 16;
export const CHARLIE_PACKAGE_MAX_HOST_CAPABILITIES = 32;

export type CharliePackageCompileStatus = 'pending' | 'validated';
export type CharliePackageStatus = 'active' | 'deprecated';
export type CharliePackageRecord = {
  name: string;
  version: string;
  owner: EthAddress;
  description: string;
  sourceHash: string;
  sourceCid: string | null;
  hostCapabilities: string[];
  compileStatus: CharliePackageCompileStatus;
  status: CharliePackageStatus;
  deployments: EthAddress[];
  index: bigint;
  revision: bigint;
  createdAtHeight: bigint;
  updatedAtHeight: bigint;
};
export type CharliePackagePage = { packages: CharliePackageRecord[]; nextCursor: bigint; hasMore: boolean; total: bigint };
export type CharliePackagePublication = {
  name: string;
  version: string;
  source: string;
  sourceCid?: string | null;
  description?: string;
  hostCapabilities?: readonly string[];
};
export type CharliePackageMutationOptions = { gasLimit?: number; timeoutMs?: number; expiryHeight?: number | null };

function utf8Length(value: string): number { return new TextEncoder().encode(value).length; }

export function normalizeCharliePackageName(value: string): string {
  const name = value.trim().toLowerCase();
  if (utf8Length(name) > 96 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(name)) {
    throw new Error('Charlie package name must be 1-96 lowercase ASCII letters/digits in dot or hyphen separated segments');
  }
  return name;
}

export function normalizeCharliePackageVersion(value: string): string {
  const version = value.trim().toLowerCase();
  const number = '(?:0|[1-9][0-9]*)';
  const prerelease = '(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)';
  if (utf8Length(version) > 64 || !new RegExp(`^${number}\\.${number}\\.${number}(?:-${prerelease})?$`).test(version)) {
    throw new Error('Charlie package version must be a canonical semantic version without build metadata');
  }
  return version;
}

function normalizeSource(value: string): string {
  if (typeof value !== 'string' || utf8Length(value) === 0 || utf8Length(value) > CHARLIE_PACKAGE_MAX_SOURCE_BYTES) {
    throw new Error(`Charlie package source must contain 1-${CHARLIE_PACKAGE_MAX_SOURCE_BYTES} UTF-8 bytes`);
  }
  return value;
}

function normalizeDescription(value = ''): string {
  if (utf8Length(value) > 512) throw new Error('Charlie package description must not exceed 512 UTF-8 bytes');
  return value;
}

function normalizeHostCapabilities(values: readonly string[] = []): string[] {
  if (!Array.isArray(values) || values.length > CHARLIE_PACKAGE_MAX_HOST_CAPABILITIES) {
    throw new Error('Charlie package may declare at most 32 host capabilities');
  }
  const normalized = values.map((value) => {
    if (typeof value !== 'string' || value.length === 0 || utf8Length(value) > 64
      || !/^[A-Za-z0-9@!?._:+-]+$/.test(value)) {
      throw new Error('Charlie package host capabilities must be 1-64 visible canonical word bytes');
    }
    return value;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error('Charlie package host capabilities must be unique');
  return normalized.sort();
}

function canonicalAddress(value: string, field: string): EthAddress {
  if (!isValidAddress(value) || value !== value.toLowerCase()) throw new Error(`${field} must be a canonical lowercase address`);
  return value as EthAddress;
}

function contractAddress(value: string): EthAddress {
  const address = canonicalAddress(value, 'Package registry contract');
  if (!['contract', 'internal_contract', 'system_contract'].includes(getAddressKind(address))) {
    throw new Error('Package registry must use a contract address namespace');
  }
  return address;
}

function asRecord(value: unknown, field: string): Record<string, ContractValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is not a contract record`);
  return value as Record<string, ContractValue>;
}

function stringField(record: Record<string, ContractValue>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Charlie package field ${field} is not a string`);
  return value;
}

function bigintField(record: Record<string, ContractValue>, field: string): bigint {
  const value = record[field];
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`Charlie package field ${field} is not an unsigned integer`);
  return value;
}

function decodePackage(value: unknown): CharliePackageRecord {
  const record = asRecord(value, 'Charlie package');
  const owner = canonicalAddress(stringField(record, 'owner'), 'Charlie package owner');
  if (!isAccountAddress(owner)) throw new Error('Charlie package owner must be an account');
  const sourceHash = stringField(record, 'sourceHash');
  if (!/^[0-9a-f]{64}$/.test(sourceHash)) throw new Error('Charlie package source hash is malformed');
  const sourceCidValue = record.sourceCid;
  const sourceCid = sourceCidValue === null
    ? null
    : normalizeCanonicalFileCid(typeof sourceCidValue === 'string' ? sourceCidValue : '');
  if (!Array.isArray(record.hostCapabilities)) throw new Error('Charlie package host capabilities are malformed');
  const hostCapabilities = normalizeHostCapabilities(record.hostCapabilities as string[]);
  if (!Array.isArray(record.deployments) || record.deployments.length > CHARLIE_PACKAGE_MAX_DEPLOYMENTS) {
    throw new Error('Charlie package deployment list is malformed');
  }
  const deployments = record.deployments.map((address) => contractAddress(String(address)));
  if (new Set(deployments).size !== deployments.length) throw new Error('Charlie package deployments must be unique');
  const compileStatus = stringField(record, 'compileStatus');
  const status = stringField(record, 'status');
  if (compileStatus !== 'pending' && compileStatus !== 'validated') throw new Error('Charlie package compile status is malformed');
  if (status !== 'active' && status !== 'deprecated') throw new Error('Charlie package status is malformed');
  const index = bigintField(record, 'index');
  const revision = bigintField(record, 'revision');
  if (index === 0n || index > CHARLIE_PACKAGE_MAX_ENTRIES || revision === 0n) {
    throw new Error('Charlie package index or revision exceeds its bound');
  }
  if ((compileStatus === 'validated') !== (deployments.length > 0)) {
    throw new Error('Charlie package compile status is inconsistent with deployments');
  }
  return {
    name: normalizeCharliePackageName(stringField(record, 'name')),
    version: normalizeCharliePackageVersion(stringField(record, 'version')),
    owner,
    description: normalizeDescription(stringField(record, 'description')),
    sourceHash,
    sourceCid,
    hostCapabilities,
    compileStatus,
    status,
    deployments,
    index,
    revision,
    createdAtHeight: bigintField(record, 'createdAtHeight'),
    updatedAtHeight: bigintField(record, 'updatedAtHeight'),
  };
}

function mutationOptions(options: CharliePackageMutationOptions, gasLimit: number) {
  return {
    gasLimit: options.gasLimit ?? gasLimit,
    timeoutMs: options.timeoutMs ?? 60_000,
    expiryHeight: options.expiryHeight,
    waitForConfirmation: true,
  } as const;
}

function deploymentSalt(value: string): string {
  const salt = value.trim().toLowerCase();
  if (utf8Length(salt) > 96 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(salt)) {
    throw new Error('Charlie package deployment salt must be a canonical name');
  }
  return salt;
}

export class CharliePackageRegistryClient {
  readonly provider: RiadchainProvider;
  readonly contractAddress: EthAddress;

  constructor(provider: RiadchainProvider, registryAddress: EthAddress) {
    this.provider = provider;
    this.contractAddress = contractAddress(registryAddress);
  }

  async get(name: string, version: string): Promise<CharliePackageRecord | null> {
    const result = await this.provider.callView(this.contractAddress, 'get', {
      name: normalizeCharliePackageName(name), version: normalizeCharliePackageVersion(version),
    });
    return result.returnValue === null ? null : decodePackage(result.returnValue);
  }

  async resolve(name: string, version: string): Promise<CharliePackageRecord | null> {
    const result = await this.provider.callView(this.contractAddress, 'resolve', {
      name: normalizeCharliePackageName(name), version: normalizeCharliePackageVersion(version),
    });
    return result.returnValue === null ? null : decodePackage(result.returnValue);
  }

  async resolveCurrent(name: string): Promise<CharliePackageRecord | null> {
    const result = await this.provider.callView(this.contractAddress, 'resolveCurrent', {
      name: normalizeCharliePackageName(name),
    });
    return result.returnValue === null ? null : decodePackage(result.returnValue);
  }

  async list(cursor = 0n, limit = CHARLIE_PACKAGE_MAX_PAGE_SIZE): Promise<CharliePackagePage> {
    if (cursor < 0n || cursor > CHARLIE_PACKAGE_MAX_ENTRIES) throw new Error('Charlie package cursor exceeds its bound');
    if (limit <= 0n || limit > CHARLIE_PACKAGE_MAX_PAGE_SIZE) throw new Error('Charlie package page limit must be between 1 and 50');
    const result = await this.provider.callView(this.contractAddress, 'list', { cursor, limit });
    const page = asRecord(result.returnValue, 'Charlie package page');
    if (!Array.isArray(page.packages) || typeof page.hasMore !== 'boolean') throw new Error('Charlie package page is malformed');
    const nextCursor = bigintField(page, 'nextCursor');
    const total = bigintField(page, 'total');
    if (page.packages.length > Number(limit) || total > CHARLIE_PACKAGE_MAX_ENTRIES
      || nextCursor < cursor || nextCursor > total || page.hasMore !== (nextCursor < total)) {
      throw new Error('Charlie package page cursors are inconsistent');
    }
    return { packages: page.packages.map(decodePackage), nextCursor, hasMore: page.hasMore, total };
  }

  async publish(wallet: WalletSession, input: CharliePackagePublication, options: CharliePackageMutationOptions = {}) {
    const source = normalizeSource(input.source);
    const name = normalizeCharliePackageName(input.name);
    const version = normalizeCharliePackageVersion(input.version);
    await this.mutate(wallet, 'publish', {
      name,
      version,
      source,
      sourceHash: keccak256Hex(source),
      sourceCid: input.sourceCid == null ? null : normalizeCanonicalFileCid(input.sourceCid),
      description: normalizeDescription(input.description),
      hostCapabilities: normalizeHostCapabilities(input.hostCapabilities),
    }, options, 1_500_000);
    const packageRecord = await this.get(name, version);
    if (packageRecord === null) throw new Error('Confirmed Charlie package publication is unavailable');
    return packageRecord;
  }

  async setCurrent(wallet: WalletSession, name: string, version: string, options: CharliePackageMutationOptions = {}) {
    const normalizedName = normalizeCharliePackageName(name);
    const normalizedVersion = normalizeCharliePackageVersion(version);
    await this.mutate(wallet, 'setCurrent', { name: normalizedName, version: normalizedVersion }, options, 500_000);
    const current = await this.resolveCurrent(normalizedName);
    if (current?.version !== normalizedVersion) throw new Error('Confirmed current Charlie package is unavailable');
    return current;
  }

  async deprecate(wallet: WalletSession, name: string, version: string, options: CharliePackageMutationOptions = {}) {
    const normalizedName = normalizeCharliePackageName(name);
    const normalizedVersion = normalizeCharliePackageVersion(version);
    await this.mutate(wallet, 'deprecate', { name: normalizedName, version: normalizedVersion }, options, 500_000);
    const record = await this.get(normalizedName, normalizedVersion);
    if (record?.status !== 'deprecated') throw new Error('Confirmed Charlie package deprecation is unavailable');
    return record;
  }

  async deployPackage(
    wallet: WalletSession,
    input: { name: string; version: string; source: string; salt: string; initData?: Record<string, ContractValue> },
    options: CharliePackageMutationOptions = {},
  ): Promise<{ contractAddress: EthAddress; package: CharliePackageRecord }> {
    const name = normalizeCharliePackageName(input.name);
    const version = normalizeCharliePackageVersion(input.version);
    const source = normalizeSource(input.source);
    const before = await this.get(name, version);
    if (before === null || before.status !== 'active') throw new Error('Active Charlie package version is unavailable');
    if (before.sourceHash !== keccak256Hex(source)) throw new Error('Charlie package source does not match the registered hash');
    await this.mutate(wallet, 'deployPackage', {
      name, version, source, salt: deploymentSalt(input.salt), initData: input.initData ?? {},
    }, options, 4_000_000);
    const packageRecord = await this.get(name, version);
    const contractAddress = packageRecord?.deployments.at(-1);
    if (!packageRecord || packageRecord.deployments.length !== before.deployments.length + 1 || !contractAddress) {
      throw new Error('Confirmed Charlie package deployment is unavailable');
    }
    return { contractAddress, package: packageRecord };
  }

  private async mutate(
    wallet: WalletSession,
    method: string,
    data: Record<string, unknown>,
    options: CharliePackageMutationOptions,
    gasLimit: number,
  ): Promise<TransactionReceipt> {
    const sent = await wallet.sendContractCall(this.contractAddress, method, data, mutationOptions(options, gasLimit));
    const receipt = await this.provider.getReceipt(sent.tx.id);
    if (!receipt.success) throw new Error(receipt.error ?? `Charlie package registry ${method} failed`);
    return receipt;
  }
}

export async function deployCharliePackageRegistry(
  wallet: WalletSession,
  charlieSource: string,
  options: { salt: string; gasLimit?: number; timeoutMs?: number; upgradeAuthority?: EthAddress | null },
): Promise<{ txId: string; contractAddress: EthAddress; client: CharliePackageRegistryClient }> {
  if (!charlieSource.trim()) throw new Error('Charlie package registry source must not be empty');
  const deployed = await wallet.sendContractDeploy(charlieSource, {
    salt: options.salt,
    gasLimit: options.gasLimit ?? 2_000_000,
    timeoutMs: options.timeoutMs ?? 60_000,
    waitForConfirmation: true,
    upgradeAuthority: options.upgradeAuthority,
  });
  const address = contractAddress(deployed.contractAddress);
  return { txId: deployed.tx.id, contractAddress: address, client: new CharliePackageRegistryClient(wallet.provider, address) };
}
