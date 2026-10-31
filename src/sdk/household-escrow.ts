import { getAddressKind, isAccountAddress, isValidAddress, type EthAddress } from './internal/crypto.ts';
import { RiadchainProvider } from './provider.ts';
import type { ContractValue } from '../lib/contractValueCodec.ts';
import type { TransactionReceipt } from './types.ts';
import { WalletSession } from './wallet.ts';

export const HOUSEHOLD_ESCROW_MAX_ENTRIES = 256n;
export const HOUSEHOLD_ESCROW_MAX_PAGE_SIZE = 50n;
const U64_MAX = (1n << 64n) - 1n;

export type HouseholdEscrowStatus = 'funded' | 'released' | 'refunded';
export type HouseholdEscrow = {
  escrowId: string;
  depositor: EthAddress;
  beneficiary: EthAddress;
  approver: EthAddress | null;
  amount: bigint;
  timeoutHeight: bigint;
  status: HouseholdEscrowStatus;
  label: string;
  index: bigint;
  createdAtHeight: bigint;
  settledAtHeight: bigint | null;
};
export type HouseholdEscrowPage = { escrows: HouseholdEscrow[]; nextCursor: bigint; hasMore: boolean; total: bigint };
export type HouseholdEscrowMutationOptions = { gasLimit?: number; timeoutMs?: number; expiryHeight?: number | null };

function escrowId(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Escrow ID must be 64 lowercase hex characters');
  return value;
}

function canonicalAddress(value: EthAddress, field: string): EthAddress {
  if (!isValidAddress(value)) throw new Error(`${field} must be a Riadchain address`);
  return value.toLowerCase() as EthAddress;
}

function contractAddress(value: EthAddress): EthAddress {
  const address = canonicalAddress(value, 'Escrow contract');
  if (!['contract', 'internal_contract', 'system_contract'].includes(getAddressKind(address))) {
    throw new Error('Escrow contract must use a contract address namespace');
  }
  return address;
}

function utf8Length(value: string): number { return new TextEncoder().encode(value).length; }

function asRecord(value: unknown, field: string): Record<string, ContractValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is not a contract record`);
  return value as Record<string, ContractValue>;
}

function stringField(record: Record<string, ContractValue>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Escrow field ${field} is not a string`);
  return value;
}

function bigintField(record: Record<string, ContractValue>, field: string): bigint {
  const value = record[field];
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`Escrow field ${field} is not an unsigned integer`);
  return value;
}

function addressField(record: Record<string, ContractValue>, field: string): EthAddress {
  const value = stringField(record, field);
  if (!isValidAddress(value) || value !== value.toLowerCase()) throw new Error(`Escrow field ${field} is not a canonical address`);
  return value as EthAddress;
}

function decodeEscrow(value: unknown): HouseholdEscrow {
  const record = asRecord(value, 'Escrow');
  const status = stringField(record, 'status');
  if (!['funded', 'released', 'refunded'].includes(status)) throw new Error('Escrow status is malformed');
  const depositor = addressField(record, 'depositor');
  if (!isAccountAddress(depositor)) throw new Error('Escrow depositor is not an account');
  const approverValue = record.approver;
  let approver: EthAddress | null = null;
  if (approverValue !== null) {
    if (typeof approverValue !== 'string' || !isValidAddress(approverValue) || approverValue !== approverValue.toLowerCase()) {
      throw new Error('Escrow approver is malformed');
    }
    approver = approverValue as EthAddress;
  }
  const settledAtHeight = record.settledAtHeight;
  if (settledAtHeight !== null && (typeof settledAtHeight !== 'bigint' || settledAtHeight < 0n)) {
    throw new Error('Escrow settlement height is malformed');
  }
  if ((status === 'funded') !== (settledAtHeight === null)) throw new Error('Escrow terminal state is inconsistent');
  const index = bigintField(record, 'index');
  if (index === 0n || index > HOUSEHOLD_ESCROW_MAX_ENTRIES) throw new Error('Escrow index exceeds its bound');
  return {
    escrowId: escrowId(stringField(record, 'escrowId')),
    depositor,
    beneficiary: addressField(record, 'beneficiary'),
    approver,
    amount: bigintField(record, 'amount'),
    timeoutHeight: bigintField(record, 'timeoutHeight'),
    status: status as HouseholdEscrowStatus,
    label: stringField(record, 'label'),
    index,
    createdAtHeight: bigintField(record, 'createdAtHeight'),
    settledAtHeight,
  };
}

function mutationOptions(options: HouseholdEscrowMutationOptions, gasLimit = 750_000) {
  return { gasLimit: options.gasLimit ?? gasLimit, timeoutMs: options.timeoutMs ?? 60_000, expiryHeight: options.expiryHeight, waitForConfirmation: true } as const;
}

export class HouseholdEscrowClient {
  readonly provider: RiadchainProvider;
  readonly contractAddress: EthAddress;

  constructor(provider: RiadchainProvider, contract: EthAddress) {
    this.provider = provider;
    this.contractAddress = contractAddress(contract);
  }

  async get(id: string): Promise<HouseholdEscrow | null> {
    const result = await this.provider.callView(this.contractAddress, 'get', { escrowId: escrowId(id) });
    return result.returnValue === null ? null : decodeEscrow(result.returnValue);
  }

  async list(cursor = 0n, limit = HOUSEHOLD_ESCROW_MAX_PAGE_SIZE): Promise<HouseholdEscrowPage> {
    if (cursor < 0n || cursor > HOUSEHOLD_ESCROW_MAX_ENTRIES) throw new Error('Escrow cursor exceeds its bound');
    if (limit <= 0n || limit > HOUSEHOLD_ESCROW_MAX_PAGE_SIZE) throw new Error('Escrow page limit must be between 1 and 50');
    const result = await this.provider.callView(this.contractAddress, 'list', { cursor, limit });
    const page = asRecord(result.returnValue, 'Escrow page');
    if (!Array.isArray(page.escrows) || typeof page.hasMore !== 'boolean') throw new Error('Escrow page is malformed');
    const nextCursor = bigintField(page, 'nextCursor');
    const total = bigintField(page, 'total');
    if (page.escrows.length > Number(limit) || total > HOUSEHOLD_ESCROW_MAX_ENTRIES
      || nextCursor < cursor || nextCursor > total || page.hasMore !== (nextCursor < total)) {
      throw new Error('Escrow page cursors are inconsistent');
    }
    return { escrows: page.escrows.map(decodeEscrow), nextCursor, hasMore: page.hasMore, total };
  }

  async create(
    wallet: WalletSession,
    input: { beneficiary: EthAddress; approver?: EthAddress | null; amount: bigint; timeoutHeight: bigint; label: string },
    options: HouseholdEscrowMutationOptions = {},
  ): Promise<{ escrow: HouseholdEscrow; receipt: TransactionReceipt }> {
    if (input.amount <= 0n || input.amount > U64_MAX) throw new Error('Escrow amount must be a positive u64');
    if (input.timeoutHeight <= 0n || input.timeoutHeight > U64_MAX) throw new Error('Escrow timeout must be a positive u64 height');
    const label = input.label.trim();
    if (utf8Length(label) === 0 || utf8Length(label) > 128) throw new Error('Escrow label must contain 1-128 UTF-8 bytes');
    const beneficiary = canonicalAddress(input.beneficiary, 'Escrow beneficiary');
    const approver = input.approver == null ? null : canonicalAddress(input.approver, 'Escrow approver');
    if (beneficiary === wallet.address || approver === wallet.address || approver === beneficiary) {
      throw new Error('Escrow beneficiary, depositor, and approver must use independent addresses');
    }
    const sent = await wallet.sendContractCall(this.contractAddress, 'create', {
      beneficiary, approver, timeoutHeight: input.timeoutHeight, label,
    }, { ...mutationOptions(options), callValue: input.amount });
    const receipt = await this.provider.getReceipt(sent.tx.id);
    if (!receipt.success) throw new Error(receipt.error ?? 'Escrow creation failed');
    const created = await this.get(sent.tx.id);
    if (created === null) throw new Error('Confirmed escrow is unavailable');
    return { escrow: created, receipt };
  }

  async release(wallet: WalletSession, id: string, options: HouseholdEscrowMutationOptions = {}) {
    return this.settle(wallet, 'release', id, options);
  }

  async refund(wallet: WalletSession, id: string, options: HouseholdEscrowMutationOptions = {}) {
    return this.settle(wallet, 'refund', id, options);
  }

  private async settle(wallet: WalletSession, method: string, id: string, options: HouseholdEscrowMutationOptions) {
    const normalizedId = escrowId(id);
    const sent = await wallet.sendContractCall(this.contractAddress, method, { escrowId: normalizedId }, mutationOptions(options));
    const receipt = await this.provider.getReceipt(sent.tx.id);
    if (!receipt.success) throw new Error(receipt.error ?? `Escrow ${method} failed`);
    const escrow = await this.get(normalizedId);
    if (escrow === null || escrow.status === 'funded') throw new Error('Confirmed escrow settlement is unavailable');
    return { escrow, receipt };
  }
}

export async function deployHouseholdEscrow(
  wallet: WalletSession,
  charlieSource: string,
  options: { salt: string; gasLimit?: number; timeoutMs?: number; upgradeAuthority?: EthAddress | null },
): Promise<{ txId: string; contractAddress: EthAddress; client: HouseholdEscrowClient }> {
  if (!charlieSource.trim()) throw new Error('Household escrow Charlie source must not be empty');
  const deployed = await wallet.sendContractDeploy(charlieSource, {
    salt: options.salt, gasLimit: options.gasLimit ?? 1_500_000, timeoutMs: options.timeoutMs ?? 60_000,
    waitForConfirmation: true, upgradeAuthority: options.upgradeAuthority,
  });
  const contractAddress = deployed.contractAddress as EthAddress;
  return { txId: deployed.tx.id, contractAddress, client: new HouseholdEscrowClient(wallet.provider, contractAddress) };
}
