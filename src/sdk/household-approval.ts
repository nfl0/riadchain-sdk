import type { ContractValue } from '../lib/contractValueCodec.ts';
import { getAddressKind, isAccountAddress, isValidAddress, type EthAddress } from './internal/crypto.ts';
import { RiadchainProvider } from './provider.ts';
import type { TransactionReceipt } from './types.ts';
import { WalletSession } from './wallet.ts';

export const HOUSEHOLD_APPROVAL_MAX_PROPOSALS = 256n;
export const HOUSEHOLD_APPROVAL_MAX_SIGNERS = 16;
export const HOUSEHOLD_APPROVAL_MAX_PAGE_SIZE = 50n;
const U64_MAX = (1n << 64n) - 1n;

export type HouseholdApprovalKind = 'call' | 'transfer';
export type HouseholdApprovalStatus = 'pending' | 'executed' | 'cancelled' | 'expired';

export type HouseholdApprovalProposal = {
  proposalHash: string;
  creator: EthAddress;
  kind: HouseholdApprovalKind;
  target: EthAddress;
  method: string;
  data: Record<string, ContractValue>;
  value: bigint;
  signers: EthAddress[];
  threshold: bigint;
  approvers: EthAddress[];
  approvals: bigint;
  status: HouseholdApprovalStatus;
  result: ContractValue;
  label: string;
  index: bigint;
  createdAtHeight: bigint;
  expiresAtHeight: bigint;
  executedAtHeight: bigint | null;
};

export type HouseholdApprovalPage = {
  proposals: HouseholdApprovalProposal[];
  nextCursor: bigint;
  hasMore: boolean;
  total: bigint;
};

export type HouseholdApprovalMutationOptions = {
  gasLimit?: number;
  timeoutMs?: number;
  expiryHeight?: number | null;
};

export type HouseholdApprovalPolicy = {
  signers: readonly EthAddress[];
  threshold: number;
  expiresAtHeight: bigint;
  label: string;
};

function proposalHash(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Proposal hash must be 64 lowercase hex characters');
  return value;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeLabel(value: string): string {
  const label = value.trim();
  const length = utf8Length(label);
  if (length === 0 || length > 128) throw new Error('Approval label must contain 1-128 UTF-8 bytes');
  return label;
}

function normalizePolicy(policy: HouseholdApprovalPolicy) {
  const signers = policy.signers.map((signer) => {
    if (!isAccountAddress(signer)) throw new Error('Approval signers must use account addresses');
    return signer.toLowerCase() as EthAddress;
  });
  if (signers.length < 2 || signers.length > HOUSEHOLD_APPROVAL_MAX_SIGNERS) {
    throw new Error('Approval policy requires 2-16 signers');
  }
  if (new Set(signers).size !== signers.length) throw new Error('Approval signers must be unique');
  if (!Number.isSafeInteger(policy.threshold) || policy.threshold <= 0 || policy.threshold > signers.length) {
    throw new Error('Approval threshold must be between 1 and the signer count');
  }
  if (policy.expiresAtHeight <= 0n || policy.expiresAtHeight > U64_MAX) {
    throw new Error('Approval expiry must be a positive u64 block height');
  }
  return {
    signers,
    threshold: BigInt(policy.threshold),
    expiresAtHeight: policy.expiresAtHeight,
    label: normalizeLabel(policy.label),
  };
}

function normalizedAddress(value: EthAddress, field: string): EthAddress {
  if (!isValidAddress(value)) throw new Error(`${field} must be a canonical Riadchain address`);
  return value.toLowerCase() as EthAddress;
}

function normalizedContract(value: EthAddress): EthAddress {
  const address = normalizedAddress(value, 'Approval target');
  if (!['contract', 'internal_contract', 'system_contract'].includes(getAddressKind(address))) {
    throw new Error('Approval call target must use a contract address namespace');
  }
  return address;
}

function asRecord(value: unknown, field: string): Record<string, ContractValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} is not a contract record`);
  }
  return value as Record<string, ContractValue>;
}

function stringField(record: Record<string, ContractValue>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Approval field ${field} is not a string`);
  return value;
}

function bigintField(record: Record<string, ContractValue>, field: string): bigint {
  const value = record[field];
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`Approval field ${field} is not an unsigned integer`);
  return value;
}

function addressField(record: Record<string, ContractValue>, field: string): EthAddress {
  const value = stringField(record, field);
  if (!isValidAddress(value) || value !== value.toLowerCase()) throw new Error(`Approval field ${field} is not a canonical address`);
  return value as EthAddress;
}

function addressListField(record: Record<string, ContractValue>, field: string): EthAddress[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`Approval field ${field} is not a signer list`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || !isAccountAddress(entry) || entry !== entry.toLowerCase()) {
      throw new Error(`Approval field ${field} contains a malformed signer`);
    }
    return entry as EthAddress;
  });
}

function decodeProposal(value: unknown): HouseholdApprovalProposal {
  const record = asRecord(value, 'Approval proposal');
  const kind = stringField(record, 'kind');
  const status = stringField(record, 'status');
  if (kind !== 'call' && kind !== 'transfer') throw new Error('Approval kind is malformed');
  if (!['pending', 'executed', 'cancelled', 'expired'].includes(status)) throw new Error('Approval status is malformed');
  const signers = addressListField(record, 'signers');
  const approvers = addressListField(record, 'approvers');
  if (new Set(signers).size !== signers.length || new Set(approvers).size !== approvers.length
    || approvers.some((approver) => !signers.includes(approver))) {
    throw new Error('Approval signer lists are inconsistent');
  }
  const threshold = bigintField(record, 'threshold');
  const approvals = bigintField(record, 'approvals');
  if (signers.length < 2 || signers.length > HOUSEHOLD_APPROVAL_MAX_SIGNERS
    || threshold === 0n || threshold > BigInt(signers.length)
    || approvals !== BigInt(approvers.length) || approvals > BigInt(signers.length)) {
    throw new Error('Approval signer counts are inconsistent');
  }
  const data = asRecord(record.data, 'Approval action data');
  const creator = addressField(record, 'creator');
  const target = addressField(record, 'target');
  if (!isAccountAddress(creator) || !signers.includes(creator) || !approvers.includes(creator)) {
    throw new Error('Approval creator is inconsistent with signer policy');
  }
  if (kind === 'call' && !['contract', 'internal_contract', 'system_contract'].includes(getAddressKind(target))) {
    throw new Error('Approval call target is malformed');
  }
  const executedAtHeight = record.executedAtHeight;
  if (executedAtHeight !== null && (typeof executedAtHeight !== 'bigint' || executedAtHeight < 0n)) {
    throw new Error('Approval executedAtHeight is malformed');
  }
  return {
    proposalHash: proposalHash(stringField(record, 'proposalHash')),
    creator,
    kind,
    target,
    method: stringField(record, 'method'),
    data,
    value: bigintField(record, 'value'),
    signers,
    threshold,
    approvers,
    approvals,
    status: status as HouseholdApprovalStatus,
    result: record.result ?? null,
    label: stringField(record, 'label'),
    index: bigintField(record, 'index'),
    createdAtHeight: bigintField(record, 'createdAtHeight'),
    expiresAtHeight: bigintField(record, 'expiresAtHeight'),
    executedAtHeight,
  };
}

function mutationOptions(options: HouseholdApprovalMutationOptions, gasLimit = 1_500_000) {
  return {
    gasLimit: options.gasLimit ?? gasLimit,
    timeoutMs: options.timeoutMs ?? 60_000,
    expiryHeight: options.expiryHeight,
    waitForConfirmation: true,
  } as const;
}

export class HouseholdApprovalClient {
  readonly provider: RiadchainProvider;
  readonly contractAddress: EthAddress;

  constructor(provider: RiadchainProvider, contractAddress: EthAddress) {
    this.provider = provider;
    this.contractAddress = normalizedContract(contractAddress);
  }

  async get(hash: string): Promise<HouseholdApprovalProposal | null> {
    const result = await this.provider.callView(this.contractAddress, 'get', { proposalHash: proposalHash(hash) });
    return result.returnValue === null ? null : decodeProposal(result.returnValue);
  }

  async list(cursor = 0n, limit = HOUSEHOLD_APPROVAL_MAX_PAGE_SIZE): Promise<HouseholdApprovalPage> {
    if (cursor < 0n || cursor > HOUSEHOLD_APPROVAL_MAX_PROPOSALS) throw new Error('Approval cursor is outside the bounded registry');
    if (limit <= 0n || limit > HOUSEHOLD_APPROVAL_MAX_PAGE_SIZE) throw new Error('Approval page limit must be between 1 and 50');
    const result = await this.provider.callView(this.contractAddress, 'list', { cursor, limit });
    const page = asRecord(result.returnValue, 'Approval page');
    if (!Array.isArray(page.proposals) || typeof page.hasMore !== 'boolean') throw new Error('Approval page is malformed');
    if (page.proposals.length > Number(limit)) throw new Error('Approval page exceeds requested limit');
    const nextCursor = bigintField(page, 'nextCursor');
    const total = bigintField(page, 'total');
    if (total > HOUSEHOLD_APPROVAL_MAX_PROPOSALS || nextCursor < cursor || nextCursor > total
      || page.hasMore !== (nextCursor < total)) throw new Error('Approval page cursors are inconsistent');
    return {
      proposals: page.proposals.map(decodeProposal),
      nextCursor,
      hasMore: page.hasMore,
      total,
    };
  }

  async proposeCall(
    wallet: WalletSession,
    action: { target: EthAddress; method: string; data?: Record<string, ContractValue>; value?: bigint },
    policy: HouseholdApprovalPolicy,
    options: HouseholdApprovalMutationOptions = {},
  ): Promise<{ proposal: HouseholdApprovalProposal; receipt: TransactionReceipt }> {
    const method = action.method.trim();
    if (utf8Length(method) === 0 || utf8Length(method) > 64) throw new Error('Approval method must contain 1-64 UTF-8 bytes');
    const data = action.data ?? {};
    if (Object.keys(data).length > 32) throw new Error('Approval call data supports at most 32 top-level fields');
    const value = action.value ?? 0n;
    if (value < 0n || value > U64_MAX) throw new Error('Approval call value must be a u64 amount');
    return this.propose(wallet, 'proposeCall', {
      target: normalizedContract(action.target),
      actionMethod: method,
      data,
      value,
      ...normalizePolicy(policy),
    }, options);
  }

  async proposeTransfer(
    wallet: WalletSession,
    recipient: EthAddress,
    amount: bigint,
    policy: HouseholdApprovalPolicy,
    options: HouseholdApprovalMutationOptions = {},
  ): Promise<{ proposal: HouseholdApprovalProposal; receipt: TransactionReceipt }> {
    if (amount <= 0n || amount > U64_MAX) throw new Error('Approval transfer amount must be a positive u64');
    return this.propose(wallet, 'proposeTransfer', {
      recipient: normalizedAddress(recipient, 'Approval recipient'),
      amount,
      ...normalizePolicy(policy),
    }, options);
  }

  async approve(wallet: WalletSession, hash: string, options: HouseholdApprovalMutationOptions = {}) {
    return this.mutate(wallet, 'approve', hash, options);
  }

  async execute(wallet: WalletSession, hash: string, options: HouseholdApprovalMutationOptions = {}) {
    return this.mutate(wallet, 'execute', hash, options, 2_000_000);
  }

  async cancel(wallet: WalletSession, hash: string, options: HouseholdApprovalMutationOptions = {}) {
    return this.mutate(wallet, 'cancel', hash, options);
  }

  async expire(wallet: WalletSession, hash: string, options: HouseholdApprovalMutationOptions = {}) {
    return this.mutate(wallet, 'expire', hash, options);
  }

  async deposit(wallet: WalletSession, amount: bigint, options: HouseholdApprovalMutationOptions = {}) {
    if (amount <= 0n || amount > U64_MAX) throw new Error('Approval deposit must be a positive u64');
    const sent = await wallet.sendContractCall(this.contractAddress, 'deposit', {}, {
      ...mutationOptions(options),
      callValue: amount,
    });
    const receipt = await this.provider.getReceipt(sent.tx.id);
    if (!receipt.success) throw new Error(receipt.error ?? 'Approval deposit failed');
    return { txId: sent.tx.id, receipt };
  }

  private async propose(
    wallet: WalletSession,
    method: string,
    data: Record<string, ContractValue>,
    options: HouseholdApprovalMutationOptions,
  ): Promise<{ proposal: HouseholdApprovalProposal; receipt: TransactionReceipt }> {
    const sent = await wallet.sendContractCall(this.contractAddress, method, data, mutationOptions(options));
    const receipt = await this.provider.getReceipt(sent.tx.id);
    if (!receipt.success) throw new Error(receipt.error ?? `Approval ${method} failed`);
    const proposal = await this.get(sent.tx.id);
    if (proposal === null || proposal.proposalHash !== sent.tx.id) throw new Error('Confirmed approval proposal is unavailable');
    return { proposal, receipt };
  }

  private async mutate(
    wallet: WalletSession,
    method: string,
    hash: string,
    options: HouseholdApprovalMutationOptions,
    defaultGas?: number,
  ): Promise<{ proposal: HouseholdApprovalProposal; receipt: TransactionReceipt }> {
    const normalizedHash = proposalHash(hash);
    const sent = await wallet.sendContractCall(
      this.contractAddress,
      method,
      { proposalHash: normalizedHash },
      mutationOptions(options, defaultGas),
    );
    const receipt = await this.provider.getReceipt(sent.tx.id);
    if (!receipt.success) throw new Error(receipt.error ?? `Approval ${method} failed`);
    const proposal = await this.get(normalizedHash);
    if (proposal === null) throw new Error('Confirmed approval proposal is unavailable');
    return { proposal, receipt };
  }
}

export async function deployHouseholdApproval(
  wallet: WalletSession,
  charlieSource: string,
  options: { salt: string; gasLimit?: number; timeoutMs?: number; upgradeAuthority?: EthAddress | null },
): Promise<{ txId: string; contractAddress: EthAddress; client: HouseholdApprovalClient }> {
  if (!charlieSource.trim()) throw new Error('Household approval Charlie source must not be empty');
  const deployed = await wallet.sendContractDeploy(charlieSource, {
    salt: options.salt,
    gasLimit: options.gasLimit ?? 2_000_000,
    timeoutMs: options.timeoutMs ?? 60_000,
    waitForConfirmation: true,
    upgradeAuthority: options.upgradeAuthority,
  });
  const contractAddress = deployed.contractAddress as EthAddress;
  return { txId: deployed.tx.id, contractAddress, client: new HouseholdApprovalClient(wallet.provider, contractAddress) };
}
