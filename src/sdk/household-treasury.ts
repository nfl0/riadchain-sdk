import type { ContractValue } from '../lib/contractValueCodec.ts';
import { getAddressKind, isAccountAddress, isValidAddress, type EthAddress } from './internal/crypto.ts';
import { RiadchainProvider } from './provider.ts';
import type { TransactionReceipt } from './types.ts';
import { WalletSession } from './wallet.ts';

export const HOUSEHOLD_TREASURY_MAX_ACCOUNTS = 64n;
export const HOUSEHOLD_TREASURY_MAX_ALLOWANCES = 64n;
export const HOUSEHOLD_TREASURY_MAX_PAGE_SIZE = 50n;
const U64_MAX = (1n << 64n) - 1n;

export type HouseholdTreasuryAccount = {
  owner: EthAddress;
  balance: bigint;
  approvalContract: EthAddress | null;
  approvalAbove: bigint;
  allowanceCount: bigint;
  createdAtHeight: bigint;
  updatedAtHeight: bigint;
};

export type HouseholdAllowanceStatus = 'active' | 'revoked';

export type HouseholdAllowance = {
  owner: EthAddress;
  name: string;
  recipient: EthAddress;
  totalLimit: bigint;
  perClaimLimit: bigint;
  spent: bigint;
  status: HouseholdAllowanceStatus;
  label: string;
  index: bigint;
  createdAtHeight: bigint;
  updatedAtHeight: bigint;
  expiresAtHeight: bigint;
};

export type HouseholdAllowancePage = {
  allowances: HouseholdAllowance[];
  nextCursor: bigint;
  hasMore: boolean;
  total: bigint;
};

export type HouseholdAllowanceInput = {
  name: string;
  recipient: EthAddress;
  totalLimit: bigint;
  perClaimLimit: bigint;
  expiresAtHeight: bigint;
  label: string;
};

export type HouseholdTreasuryMutationOptions = {
  gasLimit?: number;
  timeoutMs?: number;
  expiryHeight?: number | null;
};

export type HouseholdTreasuryApprovalAction = {
  target: EthAddress;
  method: 'withdraw' | 'createAllowance';
  data: Record<string, ContractValue>;
  value: 0n;
};

function normalizeName(value: string): string {
  const name = value.trim().toLowerCase();
  if (name.length > 48 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('Allowance name must be 1-48 lowercase ASCII letters/digits in hyphen-separated segments');
  }
  return name;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeLabel(value: string): string {
  const label = value.trim();
  const length = utf8Length(label);
  if (length === 0 || length > 128) throw new Error('Allowance label must contain 1-128 UTF-8 bytes');
  return label;
}

function u64(value: bigint, field: string, allowZero = true): bigint {
  if (value < (allowZero ? 0n : 1n) || value > U64_MAX) throw new Error(`${field} must be ${allowZero ? 'a' : 'a positive'} u64`);
  return value;
}

function accountAddress(value: EthAddress, field: string): EthAddress {
  if (!isAccountAddress(value)) throw new Error(`${field} must use an account address`);
  return value.toLowerCase() as EthAddress;
}

function canonicalAddress(value: EthAddress, field: string): EthAddress {
  if (!isValidAddress(value)) throw new Error(`${field} must be a Riadchain address`);
  return value.toLowerCase() as EthAddress;
}

function contractAddress(value: EthAddress, field: string): EthAddress {
  const normalized = canonicalAddress(value, field);
  if (!['contract', 'internal_contract', 'system_contract'].includes(getAddressKind(normalized))) {
    throw new Error(`${field} must use a contract address namespace`);
  }
  return normalized;
}

function asRecord(value: unknown, field: string): Record<string, ContractValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is not a contract record`);
  return value as Record<string, ContractValue>;
}

function stringField(record: Record<string, ContractValue>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Treasury field ${field} is not a string`);
  return value;
}

function bigintField(record: Record<string, ContractValue>, field: string): bigint {
  const value = record[field];
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`Treasury field ${field} is not an unsigned integer`);
  return value;
}

function addressField(record: Record<string, ContractValue>, field: string): EthAddress {
  const value = stringField(record, field);
  if (!isValidAddress(value) || value !== value.toLowerCase()) throw new Error(`Treasury field ${field} is not a canonical address`);
  return value as EthAddress;
}

function decodeAccount(value: unknown): HouseholdTreasuryAccount {
  const record = asRecord(value, 'Treasury account');
  const owner = addressField(record, 'owner');
  if (!isAccountAddress(owner)) throw new Error('Treasury owner is not an account address');
  const approvalContractValue = record.approvalContract;
  let approvalContract: EthAddress | null = null;
  if (approvalContractValue !== null) {
    if (typeof approvalContractValue !== 'string') throw new Error('Treasury approval contract is malformed');
    approvalContract = contractAddress(approvalContractValue as EthAddress, 'Treasury approval contract');
  }
  const allowanceCount = bigintField(record, 'allowanceCount');
  if (allowanceCount > HOUSEHOLD_TREASURY_MAX_ALLOWANCES) throw new Error('Treasury allowance count exceeds its bound');
  const approvalAbove = bigintField(record, 'approvalAbove');
  if (approvalContract === null && approvalAbove !== 0n) throw new Error('Disabled treasury approval has a non-zero threshold');
  return {
    owner,
    balance: bigintField(record, 'balance'),
    approvalContract,
    approvalAbove,
    allowanceCount,
    createdAtHeight: bigintField(record, 'createdAtHeight'),
    updatedAtHeight: bigintField(record, 'updatedAtHeight'),
  };
}

function decodeAllowance(value: unknown): HouseholdAllowance {
  const record = asRecord(value, 'Treasury allowance');
  const status = stringField(record, 'status');
  if (status !== 'active' && status !== 'revoked') throw new Error('Treasury allowance status is malformed');
  const totalLimit = bigintField(record, 'totalLimit');
  const perClaimLimit = bigintField(record, 'perClaimLimit');
  const spent = bigintField(record, 'spent');
  if (totalLimit === 0n || perClaimLimit === 0n || perClaimLimit > totalLimit || spent > totalLimit) {
    throw new Error('Treasury allowance limits are inconsistent');
  }
  const index = bigintField(record, 'index');
  if (index === 0n || index > HOUSEHOLD_TREASURY_MAX_ALLOWANCES) throw new Error('Treasury allowance index exceeds its bound');
  const owner = addressField(record, 'owner');
  if (!isAccountAddress(owner)) throw new Error('Treasury allowance owner is malformed');
  return {
    owner,
    name: normalizeName(stringField(record, 'name')),
    recipient: addressField(record, 'recipient'),
    totalLimit,
    perClaimLimit,
    spent,
    status,
    label: stringField(record, 'label'),
    index,
    createdAtHeight: bigintField(record, 'createdAtHeight'),
    updatedAtHeight: bigintField(record, 'updatedAtHeight'),
    expiresAtHeight: bigintField(record, 'expiresAtHeight'),
  };
}

function normalizeAllowance(input: HouseholdAllowanceInput) {
  const totalLimit = u64(input.totalLimit, 'Allowance total limit', false);
  const perClaimLimit = u64(input.perClaimLimit, 'Allowance per-claim limit', false);
  if (perClaimLimit > totalLimit) throw new Error('Allowance per-claim limit cannot exceed its total limit');
  return {
    name: normalizeName(input.name),
    recipient: canonicalAddress(input.recipient, 'Allowance recipient'),
    totalLimit,
    perClaimLimit,
    expiresAtHeight: u64(input.expiresAtHeight, 'Allowance expiry height', false),
    label: normalizeLabel(input.label),
  };
}

function mutationOptions(options: HouseholdTreasuryMutationOptions, gasLimit = 1_000_000) {
  return {
    gasLimit: options.gasLimit ?? gasLimit,
    timeoutMs: options.timeoutMs ?? 60_000,
    expiryHeight: options.expiryHeight,
    waitForConfirmation: true,
  } as const;
}

export class HouseholdTreasuryClient {
  readonly provider: RiadchainProvider;
  readonly contractAddress: EthAddress;

  constructor(provider: RiadchainProvider, contract: EthAddress) {
    this.provider = provider;
    this.contractAddress = contractAddress(contract, 'Treasury contract');
  }

  async getAccount(owner: EthAddress): Promise<HouseholdTreasuryAccount | null> {
    const result = await this.provider.callView(this.contractAddress, 'getAccount', { owner: accountAddress(owner, 'Treasury owner') });
    return result.returnValue === null ? null : decodeAccount(result.returnValue);
  }

  async getAllowance(owner: EthAddress, name: string): Promise<HouseholdAllowance | null> {
    const result = await this.provider.callView(this.contractAddress, 'getAllowance', {
      owner: accountAddress(owner, 'Treasury owner'),
      name: normalizeName(name),
    });
    return result.returnValue === null ? null : decodeAllowance(result.returnValue);
  }

  async listAllowances(
    owner: EthAddress,
    cursor = 0n,
    limit = HOUSEHOLD_TREASURY_MAX_PAGE_SIZE,
  ): Promise<HouseholdAllowancePage> {
    if (cursor < 0n || cursor > HOUSEHOLD_TREASURY_MAX_ALLOWANCES) throw new Error('Allowance cursor is outside the bounded account');
    if (limit <= 0n || limit > HOUSEHOLD_TREASURY_MAX_PAGE_SIZE) throw new Error('Allowance page limit must be between 1 and 50');
    const result = await this.provider.callView(this.contractAddress, 'listAllowances', {
      owner: accountAddress(owner, 'Treasury owner'), cursor, limit,
    });
    const page = asRecord(result.returnValue, 'Allowance page');
    if (!Array.isArray(page.allowances) || typeof page.hasMore !== 'boolean') throw new Error('Allowance page is malformed');
    const nextCursor = bigintField(page, 'nextCursor');
    const total = bigintField(page, 'total');
    if (page.allowances.length > Number(limit) || total > HOUSEHOLD_TREASURY_MAX_ALLOWANCES
      || nextCursor < cursor || nextCursor > total || page.hasMore !== (nextCursor < total)) {
      throw new Error('Allowance page cursors are inconsistent');
    }
    return { allowances: page.allowances.map(decodeAllowance), nextCursor, hasMore: page.hasMore, total };
  }

  async deposit(wallet: WalletSession, amount: bigint, options: HouseholdTreasuryMutationOptions = {}) {
    u64(amount, 'Treasury deposit', false);
    return this.send(wallet, 'deposit', {}, options, amount);
  }

  async configureApproval(
    wallet: WalletSession,
    approvalContract: EthAddress | null,
    approvalAbove: bigint,
    options: HouseholdTreasuryMutationOptions = {},
  ) {
    u64(approvalAbove, 'Treasury approval threshold');
    if (approvalContract === null && approvalAbove !== 0n) throw new Error('Disabled treasury approval threshold must be zero');
    return this.send(wallet, 'configureApproval', {
      approvalContractValue: approvalContract === null ? null : contractAddress(approvalContract, 'Treasury approval contract'),
      approvalAbove,
    }, options);
  }

  async withdraw(
    wallet: WalletSession,
    recipient: EthAddress,
    amount: bigint,
    options: HouseholdTreasuryMutationOptions = {},
  ) {
    u64(amount, 'Treasury withdrawal', false);
    const account = await this.getAccount(wallet.address);
    if (account === null) throw new Error('Treasury account not found');
    if (account.approvalContract !== null && amount > account.approvalAbove) {
      throw new Error('Treasury withdrawal requires household approval; use withdrawAction');
    }
    return this.send(wallet, 'withdraw', {
      owner: wallet.address,
      recipient: canonicalAddress(recipient, 'Treasury recipient'),
      amount,
    }, options);
  }

  withdrawAction(owner: EthAddress, recipient: EthAddress, amount: bigint): HouseholdTreasuryApprovalAction {
    return {
      target: this.contractAddress,
      method: 'withdraw',
      data: {
        owner: accountAddress(owner, 'Treasury owner'),
        recipient: canonicalAddress(recipient, 'Treasury recipient'),
        amount: u64(amount, 'Treasury withdrawal', false),
      },
      value: 0n,
    };
  }

  async createAllowance(
    wallet: WalletSession,
    input: HouseholdAllowanceInput,
    options: HouseholdTreasuryMutationOptions = {},
  ) {
    const allowance = normalizeAllowance(input);
    const account = await this.getAccount(wallet.address);
    if (account === null) throw new Error('Treasury account not found');
    if (account.approvalContract !== null && allowance.totalLimit > account.approvalAbove) {
      throw new Error('Treasury allowance requires household approval; use createAllowanceAction');
    }
    return this.send(wallet, 'createAllowance', { owner: wallet.address, ...allowance }, options);
  }

  createAllowanceAction(owner: EthAddress, input: HouseholdAllowanceInput): HouseholdTreasuryApprovalAction {
    return {
      target: this.contractAddress,
      method: 'createAllowance',
      data: { owner: accountAddress(owner, 'Treasury owner'), ...normalizeAllowance(input) },
      value: 0n,
    };
  }

  async claimAllowance(
    wallet: WalletSession,
    owner: EthAddress,
    name: string,
    amount: bigint,
    options: HouseholdTreasuryMutationOptions = {},
  ) {
    return this.send(wallet, 'claimAllowance', {
      owner: accountAddress(owner, 'Treasury owner'),
      name: normalizeName(name),
      amount: u64(amount, 'Allowance claim', false),
    }, options);
  }

  async revokeAllowance(wallet: WalletSession, name: string, options: HouseholdTreasuryMutationOptions = {}) {
    return this.send(wallet, 'revokeAllowance', { owner: wallet.address, name: normalizeName(name) }, options);
  }

  private async send(
    wallet: WalletSession,
    method: string,
    data: Record<string, ContractValue>,
    options: HouseholdTreasuryMutationOptions,
    callValue?: bigint,
  ): Promise<{ txId: string; receipt: TransactionReceipt }> {
    const sent = await wallet.sendContractCall(this.contractAddress, method, data, {
      ...mutationOptions(options),
      ...(callValue === undefined ? {} : { callValue }),
    });
    const receipt = await this.provider.getReceipt(sent.tx.id);
    if (!receipt.success) throw new Error(receipt.error ?? `Treasury ${method} failed`);
    return { txId: sent.tx.id, receipt };
  }
}

export async function deployHouseholdTreasury(
  wallet: WalletSession,
  charlieSource: string,
  options: { salt: string; gasLimit?: number; timeoutMs?: number; upgradeAuthority?: EthAddress | null },
): Promise<{ txId: string; contractAddress: EthAddress; client: HouseholdTreasuryClient }> {
  if (!charlieSource.trim()) throw new Error('Household treasury Charlie source must not be empty');
  const deployed = await wallet.sendContractDeploy(charlieSource, {
    salt: options.salt,
    gasLimit: options.gasLimit ?? 2_000_000,
    timeoutMs: options.timeoutMs ?? 60_000,
    waitForConfirmation: true,
    upgradeAuthority: options.upgradeAuthority,
  });
  const contractAddressValue = deployed.contractAddress as EthAddress;
  return {
    txId: deployed.tx.id,
    contractAddress: contractAddressValue,
    client: new HouseholdTreasuryClient(wallet.provider, contractAddressValue),
  };
}
