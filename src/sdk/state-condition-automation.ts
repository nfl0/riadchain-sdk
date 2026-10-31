import type { ContractValue } from '../lib/contractValueCodec.ts';
import { getAddressKind, isAccountAddress, isValidAddress, type EthAddress } from './internal/crypto.ts';
import { RiadchainProvider } from './provider.ts';
import type { TransactionReceipt } from './types.ts';
import { WalletSession } from './wallet.ts';

export const STATE_AUTOMATION_MAX_PER_OWNER = 16n;
export const STATE_AUTOMATION_MAX_CHECKS = 16;
export const STATE_AUTOMATION_MAX_PAGE_SIZE = 16n;
const U64_MAX = (1n << 64n) - 1n;

export type StateAutomationComparator = 'equals' | 'gte';
export type StateAutomationExpected = null | boolean | bigint | string;
export type StateAutomationStatus = 'active' | 'triggered' | 'exhausted' | 'cancelled';

export type StateConditionAutomationInput = {
  name: string;
  sourceContract: EthAddress;
  sourceSlot: string;
  comparator: StateAutomationComparator;
  expected: StateAutomationExpected;
  actionContract: EthAddress;
  actionMethod: string;
  actionData: Record<string, ContractValue>;
  pollIntervalBlocks: number;
  maxChecks: number;
  label: string;
};

export type StateConditionAutomation = StateConditionAutomationInput & {
  owner: EthAddress;
  index: bigint;
  createdAtHeight: bigint;
  status: StateAutomationStatus;
  checks: bigint;
  nextCheckHeight: bigint | null;
  scheduleIds: string[];
  actionScheduleId: string | null;
  lastObserved: ContractValue;
  updatedAtHeight: bigint;
  triggeredAtHeight: bigint | null;
};

export type StateConditionAutomationPage = {
  automations: StateConditionAutomation[];
  nextCursor: bigint;
  hasMore: boolean;
  total: bigint;
};

export type StateAutomationMutationOptions = {
  gasLimit?: number;
  timeoutMs?: number;
  expiryHeight?: number | null;
};

function normalizeName(value: string): string {
  const name = value.trim().toLowerCase();
  if (name.length > 48 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('Automation name must be 1-48 lowercase ASCII letters/digits in hyphen-separated segments');
  }
  return name;
}

function utf8(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  const length = new TextEncoder().encode(normalized).length;
  if (length === 0 || length > maximum) throw new Error(`${field} must contain 1-${maximum} UTF-8 bytes`);
  return normalized;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function contractAddress(value: EthAddress, field: string): EthAddress {
  if (!isValidAddress(value) || !['contract', 'internal_contract', 'system_contract'].includes(getAddressKind(value))) {
    throw new Error(`${field} must use a contract address`);
  }
  return value.toLowerCase() as EthAddress;
}

function accountAddress(value: EthAddress): EthAddress {
  if (!isAccountAddress(value)) throw new Error('Automation owner must use an account address');
  return value.toLowerCase() as EthAddress;
}

function normalizeExpected(comparator: StateAutomationComparator, expected: StateAutomationExpected): StateAutomationExpected {
  if (comparator === 'gte') {
    if (typeof expected !== 'bigint' || expected < 0n || expected > U64_MAX) {
      throw new Error('Automation gte expected value must be an unsigned u64 bigint');
    }
    return expected;
  }
  if (comparator !== 'equals') throw new Error('Automation comparator must be equals or gte');
  if (typeof expected === 'bigint' && (expected < 0n || expected > U64_MAX)) {
    throw new Error('Automation integer expected value must be an unsigned u64 bigint');
  }
  if (typeof expected === 'string' && new TextEncoder().encode(expected).length > 128) {
    throw new Error('Automation string expected value exceeds 128 UTF-8 bytes');
  }
  if (expected !== null && typeof expected !== 'boolean' && typeof expected !== 'bigint' && typeof expected !== 'string') {
    throw new Error('Automation equals expected value must be null, boolean, unsigned u64 bigint, or string');
  }
  return expected;
}

function normalizeInput(input: StateConditionAutomationInput, self: EthAddress) {
  const actionContract = contractAddress(input.actionContract, 'Automation action contract');
  if (actionContract === self) throw new Error('Automation cannot schedule itself as the action');
  if (!input.actionData || typeof input.actionData !== 'object' || Array.isArray(input.actionData)) {
    throw new Error('Automation action data must be a record');
  }
  const keys = Object.keys(input.actionData);
  if (keys.length > 32) throw new Error('Automation action data cannot contain more than 32 fields');
  return {
    name: normalizeName(input.name),
    sourceContract: contractAddress(input.sourceContract, 'Automation source contract'),
    sourceSlot: utf8(input.sourceSlot, 'Automation source slot', 128),
    comparator: input.comparator,
    expected: normalizeExpected(input.comparator, input.expected),
    actionContract,
    actionMethod: utf8(input.actionMethod, 'Automation action method', 64),
    actionData: input.actionData,
    pollIntervalBlocks: BigInt(boundedInteger(input.pollIntervalBlocks, 'Automation poll interval', 2, 1_000_000)),
    maxChecks: BigInt(boundedInteger(input.maxChecks, 'Automation check count', 1, STATE_AUTOMATION_MAX_CHECKS)),
    label: utf8(input.label, 'Automation label', 128),
  };
}

function record(value: unknown, field: string): Record<string, ContractValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is malformed`);
  return value as Record<string, ContractValue>;
}

function stringField(value: Record<string, ContractValue>, field: string): string {
  const selected = value[field];
  if (typeof selected !== 'string') throw new Error(`Automation field ${field} is malformed`);
  return selected;
}

function bigintField(value: Record<string, ContractValue>, field: string): bigint {
  const selected = value[field];
  if (typeof selected !== 'bigint' || selected < 0n) throw new Error(`Automation field ${field} is malformed`);
  return selected;
}

function nullableBigint(value: Record<string, ContractValue>, field: string): bigint | null {
  return value[field] === null ? null : bigintField(value, field);
}

function decodeAutomation(value: unknown): StateConditionAutomation {
  const outer = record(value, 'Automation');
  const config = record(outer.config, 'Automation config');
  const state = record(outer.state, 'Automation state');
  const owner = stringField(config, 'owner') as EthAddress;
  const sourceContract = stringField(config, 'sourceContract') as EthAddress;
  const actionContract = stringField(config, 'actionContract') as EthAddress;
  accountAddress(owner);
  contractAddress(sourceContract, 'Automation source contract');
  contractAddress(actionContract, 'Automation action contract');
  const comparator = stringField(config, 'comparator') as StateAutomationComparator;
  const expected = normalizeExpected(comparator, config.expected as StateAutomationExpected);
  const status = stringField(state, 'status') as StateAutomationStatus;
  if (!['active', 'triggered', 'exhausted', 'cancelled'].includes(status)) throw new Error('Automation status is malformed');
  const maxChecks = bigintField(config, 'maxChecks');
  const pollIntervalBlocks = bigintField(config, 'pollIntervalBlocks');
  const checks = bigintField(state, 'checks');
  const scheduleIds = state.scheduleIds;
  if (pollIntervalBlocks < 2n || pollIntervalBlocks > 1_000_000n
    || maxChecks === 0n || maxChecks > BigInt(STATE_AUTOMATION_MAX_CHECKS) || checks > maxChecks
    || !Array.isArray(scheduleIds) || scheduleIds.length !== Number(maxChecks)
    || !scheduleIds.every((id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id))) {
    throw new Error('Automation schedule state is inconsistent');
  }
  const nextCheckHeight = nullableBigint(state, 'nextCheckHeight');
  if ((status === 'active') !== (nextCheckHeight !== null)) throw new Error('Automation next check state is inconsistent');
  const actionScheduleId = state.actionScheduleId;
  if (actionScheduleId !== null && (typeof actionScheduleId !== 'string' || !/^[0-9a-f]{64}$/.test(actionScheduleId))) {
    throw new Error('Automation action schedule ID is malformed');
  }
  if (!Object.prototype.hasOwnProperty.call(state, 'lastObserved')) {
    throw new Error('Automation last observed value is missing');
  }
  return {
    owner,
    name: normalizeName(stringField(config, 'name')),
    sourceContract,
    sourceSlot: stringField(config, 'sourceSlot'),
    comparator,
    expected,
    actionContract,
    actionMethod: stringField(config, 'actionMethod'),
    actionData: record(config.actionData, 'Automation action data'),
    pollIntervalBlocks: Number(pollIntervalBlocks),
    maxChecks: Number(maxChecks),
    label: stringField(config, 'label'),
    index: bigintField(config, 'index'),
    createdAtHeight: bigintField(config, 'createdAtHeight'),
    status,
    checks,
    nextCheckHeight,
    scheduleIds: [...scheduleIds] as string[],
    actionScheduleId,
    lastObserved: state.lastObserved as ContractValue,
    updatedAtHeight: bigintField(state, 'updatedAtHeight'),
    triggeredAtHeight: nullableBigint(state, 'triggeredAtHeight'),
  };
}

export class StateConditionAutomationClient {
  readonly provider: RiadchainProvider;
  readonly contractAddress: EthAddress;

  constructor(provider: RiadchainProvider, contractAddressValue: EthAddress) {
    this.provider = provider;
    this.contractAddress = contractAddress(contractAddressValue, 'Automation contract');
  }

  async get(owner: EthAddress, name: string): Promise<StateConditionAutomation | null> {
    const result = await this.provider.callView(this.contractAddress, 'get', {
      owner: accountAddress(owner), name: normalizeName(name),
    });
    return result.returnValue === null ? null : decodeAutomation(result.returnValue);
  }

  async list(owner: EthAddress, cursor = 0n, limit = STATE_AUTOMATION_MAX_PAGE_SIZE): Promise<StateConditionAutomationPage> {
    if (cursor < 0n || cursor > STATE_AUTOMATION_MAX_PER_OWNER) throw new Error('Automation cursor exceeds its bound');
    if (limit <= 0n || limit > STATE_AUTOMATION_MAX_PAGE_SIZE) throw new Error('Automation page limit must be between 1 and 16');
    const result = await this.provider.callView(this.contractAddress, 'list', {
      owner: accountAddress(owner), cursor, limit,
    });
    const page = record(result.returnValue, 'Automation page');
    if (!Array.isArray(page.automations) || typeof page.hasMore !== 'boolean') throw new Error('Automation page is malformed');
    const nextCursor = bigintField(page, 'nextCursor');
    const total = bigintField(page, 'total');
    if (page.automations.length > Number(limit) || total > STATE_AUTOMATION_MAX_PER_OWNER
      || nextCursor < cursor || nextCursor > total || page.hasMore !== (nextCursor < total)) {
      throw new Error('Automation page cursors are inconsistent');
    }
    return { automations: page.automations.map(decodeAutomation), nextCursor, hasMore: page.hasMore, total };
  }

  async create(wallet: WalletSession, input: StateConditionAutomationInput, options: StateAutomationMutationOptions = {}) {
    return this.send(wallet, 'create', normalizeInput(input, this.contractAddress), options, 5_000_000);
  }

  async cancel(wallet: WalletSession, name: string, options: StateAutomationMutationOptions = {}) {
    return this.send(wallet, 'cancel', { name: normalizeName(name) }, options, 1_000_000);
  }

  private async send(
    wallet: WalletSession,
    method: string,
    data: Record<string, ContractValue>,
    options: StateAutomationMutationOptions,
    defaultGas: number,
  ): Promise<{ txId: string; receipt: TransactionReceipt }> {
    const sent = await wallet.sendContractCall(this.contractAddress, method, data, {
      gasLimit: options.gasLimit ?? defaultGas,
      timeoutMs: options.timeoutMs ?? 60_000,
      expiryHeight: options.expiryHeight,
      waitForConfirmation: true,
    });
    const receipt = await this.provider.getReceipt(sent.tx.id);
    if (!receipt.success) throw new Error(receipt.error ?? `State automation ${method} failed`);
    return { txId: sent.tx.id, receipt };
  }
}

export async function deployStateConditionAutomation(
  wallet: WalletSession,
  charlieSource: string,
  options: { salt: string; gasLimit?: number; timeoutMs?: number; upgradeAuthority?: EthAddress | null },
): Promise<{ txId: string; contractAddress: EthAddress; client: StateConditionAutomationClient }> {
  if (!charlieSource.trim()) throw new Error('State automation Charlie source must not be empty');
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
    client: new StateConditionAutomationClient(wallet.provider, contractAddressValue),
  };
}
