import type { ContractValue } from '../lib/contractValueCodec.ts';
import { isAccountAddress, isValidAddress, type EthAddress } from './internal/crypto.ts';
import { RiadchainProvider } from './provider.ts';
import type { TransactionReceipt } from './types.ts';
import { WalletSession } from './wallet.ts';

export const HOUSEHOLD_IDENTITY_MAX_ENTRIES = 256n;
export const HOUSEHOLD_IDENTITY_MAX_PAGE_SIZE = 50n;

export type HouseholdIdentityKind = 'person' | 'device' | 'service' | 'node';
export type HouseholdIdentityStatus = 'active' | 'revoked';

export type HouseholdIdentityProfile = {
  label: string;
  kind: HouseholdIdentityKind;
  signingAddress?: EthAddress | null;
  roles?: string[];
  tags?: string[];
  metadata?: string;
  capabilityRefs?: string[];
};

export type HouseholdIdentityRecord = {
  name: string;
  controller: EthAddress;
  label: string;
  kind: HouseholdIdentityKind;
  signingAddress: EthAddress | null;
  roles: string[];
  tags: string[];
  metadata: string;
  capabilityRefs: string[];
  status: HouseholdIdentityStatus;
  index: bigint;
  revision: bigint;
  createdAtBlock: bigint;
  updatedAtBlock: bigint;
};

export type HouseholdIdentityPage = {
  entries: HouseholdIdentityRecord[];
  nextCursor: bigint;
  hasMore: boolean;
  total: bigint;
};

export type HouseholdIdentityMutationOptions = {
  gasLimit?: number;
  timeoutMs?: number;
  expiryHeight?: number | null;
};

export function normalizeHouseholdIdentityName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 48 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error('Identity name must be 1-48 lowercase ASCII letters/digits in hyphen-separated segments');
  }
  return normalized;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeHumanLabel(value: string): string {
  const label = value.trim();
  if (utf8Length(label) === 0 || utf8Length(label) > 80) {
    throw new Error('Identity label must contain 1-80 UTF-8 bytes');
  }
  return label;
}

function normalizeNameList(
  values: readonly string[] | undefined,
  field: string,
  maximum: number,
): string[] {
  const normalized = (values ?? []).map((value) => {
    const item = value.trim().toLowerCase();
    if (item.length > 64 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(item)) {
      throw new Error(`${field} entries must be 1-64 canonical household names`);
    }
    return item;
  });
  if (normalized.length > maximum) {
    throw new Error(`${field} supports at most ${maximum} entries`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  return normalized;
}

function normalizeProfile(profile: HouseholdIdentityProfile): Required<HouseholdIdentityProfile> {
  if (!['person', 'device', 'service', 'node'].includes(profile.kind)) {
    throw new Error('Identity kind must be person, device, service, or node');
  }
  const signingAddress = profile.signingAddress ?? null;
  if (signingAddress !== null && !isAccountAddress(signingAddress)) {
    throw new Error('Identity signingAddress must be a canonical account address');
  }
  const normalizedSigningAddress = signingAddress === null
    ? null
    : signingAddress.toLowerCase() as EthAddress;
  const metadata = profile.metadata ?? '';
  if (utf8Length(metadata) > 512) {
    throw new Error('Identity metadata must not exceed 512 UTF-8 bytes');
  }
  return {
    label: normalizeHumanLabel(profile.label),
    kind: profile.kind,
    signingAddress: normalizedSigningAddress,
    roles: normalizeNameList(profile.roles, 'roles', 8),
    tags: normalizeNameList(profile.tags, 'tags', 12),
    metadata,
    capabilityRefs: normalizeNameList(profile.capabilityRefs, 'capabilityRefs', 16),
  };
}

function asRecord(value: unknown, field: string): Record<string, ContractValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} returned a malformed contract record`);
  }
  return value as Record<string, ContractValue>;
}

function stringField(record: Record<string, ContractValue>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Identity field ${field} is not a string`);
  return value;
}

function bigintField(record: Record<string, ContractValue>, field: string): bigint {
  const value = record[field];
  if (typeof value !== 'bigint' || value < 0n) {
    throw new Error(`Identity field ${field} is not an unsigned integer`);
  }
  return value;
}

function stringListField(record: Record<string, ContractValue>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Identity field ${field} is not a string list`);
  }
  return [...value] as string[];
}

function isCanonicalAddress(value: string): value is EthAddress {
  return isValidAddress(value) && value === value.toLowerCase();
}

function decodeIdentity(value: unknown): HouseholdIdentityRecord {
  const record = asRecord(value, 'identity');
  const controller = stringField(record, 'controller');
  const signingAddress = record.signingAddress;
  const kind = stringField(record, 'kind');
  const status = stringField(record, 'status');
  if (!isCanonicalAddress(controller)) throw new Error('Identity controller is not a canonical address');
  if (signingAddress !== null && (
    typeof signingAddress !== 'string'
    || !isCanonicalAddress(signingAddress)
    || !isAccountAddress(signingAddress)
  )) {
    throw new Error('Identity signingAddress is malformed');
  }
  if (!['person', 'device', 'service', 'node'].includes(kind)) throw new Error('Identity kind is malformed');
  if (status !== 'active' && status !== 'revoked') throw new Error('Identity status is malformed');
  const index = bigintField(record, 'index');
  const revision = bigintField(record, 'revision');
  if (index === 0n || index > HOUSEHOLD_IDENTITY_MAX_ENTRIES) {
    throw new Error('Identity index is outside the bounded registry');
  }
  if (revision === 0n) throw new Error('Identity revision must be positive');
  return {
    name: normalizeHouseholdIdentityName(stringField(record, 'name')),
    controller: controller as EthAddress,
    label: stringField(record, 'label'),
    kind: kind as HouseholdIdentityKind,
    signingAddress: signingAddress as EthAddress | null,
    roles: stringListField(record, 'roles'),
    tags: stringListField(record, 'tags'),
    metadata: stringField(record, 'metadata'),
    capabilityRefs: stringListField(record, 'capabilityRefs'),
    status,
    index,
    revision,
    createdAtBlock: bigintField(record, 'createdAtBlock'),
    updatedAtBlock: bigintField(record, 'updatedAtBlock'),
  };
}

function mutationOptions(options: HouseholdIdentityMutationOptions) {
  return {
    gasLimit: options.gasLimit ?? 750_000,
    timeoutMs: options.timeoutMs ?? 60_000,
    expiryHeight: options.expiryHeight,
    waitForConfirmation: true,
  } as const;
}

export class HouseholdIdentityRegistryClient {
  readonly provider: RiadchainProvider;
  readonly contractAddress: EthAddress;

  constructor(provider: RiadchainProvider, contractAddress: EthAddress) {
    if (!isValidAddress(contractAddress)) {
      throw new Error('Identity registry contractAddress must be a canonical address');
    }
    this.provider = provider;
    this.contractAddress = contractAddress.toLowerCase() as EthAddress;
  }

  async get(name: string): Promise<HouseholdIdentityRecord | null> {
    const normalized = normalizeHouseholdIdentityName(name);
    const result = await this.provider.callView(this.contractAddress, 'get', { name: normalized });
    return result.returnValue === null ? null : decodeIdentity(result.returnValue);
  }

  async list(cursor = 0n, limit = HOUSEHOLD_IDENTITY_MAX_PAGE_SIZE): Promise<HouseholdIdentityPage> {
    if (cursor < 0n || cursor > HOUSEHOLD_IDENTITY_MAX_ENTRIES) {
      throw new Error('Identity cursor is outside the bounded registry');
    }
    if (limit <= 0n || limit > HOUSEHOLD_IDENTITY_MAX_PAGE_SIZE) {
      throw new Error('Identity page limit must be between 1 and 50');
    }
    const result = await this.provider.callView(this.contractAddress, 'list', { cursor, limit });
    const page = asRecord(result.returnValue, 'identity page');
    if (!Array.isArray(page.entries)) throw new Error('Identity page entries are malformed');
    if (typeof page.hasMore !== 'boolean') throw new Error('Identity page hasMore is malformed');
    if (page.entries.length > Number(limit)) throw new Error('Identity page exceeds requested limit');
    const nextCursor = bigintField(page, 'nextCursor');
    const total = bigintField(page, 'total');
    if (total > HOUSEHOLD_IDENTITY_MAX_ENTRIES || nextCursor < cursor || nextCursor > total) {
      throw new Error('Identity page returned invalid bounded cursors');
    }
    if (page.hasMore !== (nextCursor < total)) throw new Error('Identity page hasMore is inconsistent');
    return {
      entries: page.entries.map(decodeIdentity),
      nextCursor,
      hasMore: page.hasMore,
      total,
    };
  }

  async listAll(): Promise<HouseholdIdentityRecord[]> {
    const entries: HouseholdIdentityRecord[] = [];
    let cursor = 0n;
    while (true) {
      const page = await this.list(cursor);
      entries.push(...page.entries);
      if (!page.hasMore) return entries;
      if (page.nextCursor <= cursor) throw new Error('Identity registry cursor did not advance');
      cursor = page.nextCursor;
    }
  }

  async register(
    wallet: WalletSession,
    name: string,
    profile: HouseholdIdentityProfile,
    options: HouseholdIdentityMutationOptions = {},
  ): Promise<{ txId: string; receipt: TransactionReceipt }> {
    return this.mutate(wallet, 'register', {
      name: normalizeHouseholdIdentityName(name),
      ...normalizeProfile(profile),
    }, options);
  }

  async update(
    wallet: WalletSession,
    name: string,
    profile: HouseholdIdentityProfile,
    options: HouseholdIdentityMutationOptions = {},
  ): Promise<{ txId: string; receipt: TransactionReceipt }> {
    return this.mutate(wallet, 'update', {
      name: normalizeHouseholdIdentityName(name),
      ...normalizeProfile(profile),
    }, options);
  }

  async transferControl(
    wallet: WalletSession,
    name: string,
    controller: EthAddress,
    options: HouseholdIdentityMutationOptions = {},
  ): Promise<{ txId: string; receipt: TransactionReceipt }> {
    if (!isValidAddress(controller)) throw new Error('New identity controller must be a canonical address');
    return this.mutate(wallet, 'transferControl', {
      name: normalizeHouseholdIdentityName(name),
      controller: controller.toLowerCase() as EthAddress,
    }, options);
  }

  async revoke(
    wallet: WalletSession,
    name: string,
    options: HouseholdIdentityMutationOptions = {},
  ): Promise<{ txId: string; receipt: TransactionReceipt }> {
    return this.mutate(wallet, 'revoke', { name: normalizeHouseholdIdentityName(name) }, options);
  }

  private async mutate(
    wallet: WalletSession,
    method: string,
    data: Record<string, unknown>,
    options: HouseholdIdentityMutationOptions,
  ): Promise<{ txId: string; receipt: TransactionReceipt }> {
    const result = await wallet.sendContractCall(
      this.contractAddress,
      method,
      data,
      mutationOptions(options),
    );
    const receipt = await this.provider.getReceipt(result.tx.id);
    if (!receipt.success) {
      throw new Error(receipt.error ?? `Identity registry ${method} failed`);
    }
    return { txId: result.tx.id, receipt };
  }
}

export async function deployHouseholdIdentityRegistry(
  wallet: WalletSession,
  charlieSource: string,
  options: {
    salt: string;
    gasLimit?: number;
    timeoutMs?: number;
    upgradeAuthority?: EthAddress | null;
  },
): Promise<{ txId: string; contractAddress: EthAddress; client: HouseholdIdentityRegistryClient }> {
  if (!charlieSource.trim()) throw new Error('Identity registry Charlie source must not be empty');
  const deployed = await wallet.sendContractDeploy(charlieSource, {
    salt: options.salt,
    gasLimit: options.gasLimit ?? 2_000_000,
    timeoutMs: options.timeoutMs ?? 60_000,
    waitForConfirmation: true,
    upgradeAuthority: options.upgradeAuthority,
  });
  const contractAddress = deployed.contractAddress as EthAddress;
  return {
    txId: deployed.tx.id,
    contractAddress,
    client: new HouseholdIdentityRegistryClient(wallet.provider, contractAddress),
  };
}
