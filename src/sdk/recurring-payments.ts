import type { ContractValue } from '../lib/contractValueCodec.ts';
import { isAccountAddress, isValidAddress, getAddressKind, type EthAddress } from './internal/crypto.ts';
import { RiadchainProvider } from './provider.ts';
import type { TransactionReceipt } from './types.ts';
import { WalletSession } from './wallet.ts';

export const RECURRING_PAYMENT_MAX_ACCOUNTS = 64n;
export const RECURRING_PAYMENT_MAX_PER_ACCOUNT = 32n;
export const RECURRING_PAYMENT_MAX_EXECUTIONS = 16;
export const RECURRING_PAYMENT_MAX_PAGE_SIZE = 32n;
const U64_MAX = (1n << 64n) - 1n;

export type RecurringPaymentStatus = 'active' | 'completed' | 'cancelled';

export type RecurringPaymentAccount = {
  owner: EthAddress;
  balance: bigint;
  paymentCount: bigint;
  createdAtHeight: bigint;
};

export type RecurringPayment = {
  owner: EthAddress;
  name: string;
  recipient: EthAddress;
  amount: bigint;
  intervalBlocks: bigint;
  firstExecutionHeight: bigint;
  executionCount: bigint;
  label: string;
  index: bigint;
  createdAtHeight: bigint;
  status: RecurringPaymentStatus;
  scheduleIds: string[];
  attempts: bigint;
  payments: bigint;
  nextExecutionHeight: bigint | null;
  updatedAtHeight: bigint;
  lastAttemptHeight: bigint | null;
  lastPaymentHeight: bigint | null;
};

export type RecurringPaymentInput = {
  name: string;
  recipient: EthAddress;
  amount: bigint;
  intervalBlocks: number;
  firstDelayBlocks?: number;
  executionCount: number;
  label: string;
};

export type RecurringPaymentPage = {
  payments: RecurringPayment[];
  nextCursor: bigint;
  hasMore: boolean;
  total: bigint;
};

export type RecurringPaymentMutationOptions = {
  gasLimit?: number;
  timeoutMs?: number;
  expiryHeight?: number | null;
};

function normalizeName(value: string): string {
  const name = value.trim().toLowerCase();
  if (name.length > 48 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('Recurring payment name must be 1-48 lowercase ASCII letters/digits in hyphen-separated segments');
  }
  return name;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeLabel(value: string): string {
  const label = value.trim();
  const length = utf8Length(label);
  if (length === 0 || length > 128) throw new Error('Recurring payment label must contain 1-128 UTF-8 bytes');
  return label;
}

function u64(value: bigint, field: string, positive = false): bigint {
  if (value < (positive ? 1n : 0n) || value > U64_MAX) throw new Error(`${field} must be ${positive ? 'a positive' : 'an'} u64`);
  return value;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
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

function recurringContract(value: EthAddress): EthAddress {
  const address = canonicalAddress(value, 'Recurring payment contract');
  if (!['contract', 'internal_contract', 'system_contract'].includes(getAddressKind(address))) {
    throw new Error('Recurring payment contract must use a contract address namespace');
  }
  return address;
}

function asRecord(value: unknown, field: string): Record<string, ContractValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is not a contract record`);
  return value as Record<string, ContractValue>;
}

function stringField(record: Record<string, ContractValue>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Recurring payment field ${field} is not a string`);
  return value;
}

function bigintField(record: Record<string, ContractValue>, field: string): bigint {
  const value = record[field];
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`Recurring payment field ${field} is not an unsigned integer`);
  return value;
}

function nullableBigintField(record: Record<string, ContractValue>, field: string): bigint | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`Recurring payment field ${field} is malformed`);
  return value;
}

function addressField(record: Record<string, ContractValue>, field: string): EthAddress {
  const value = stringField(record, field);
  if (!isValidAddress(value) || value !== value.toLowerCase()) throw new Error(`Recurring payment field ${field} is not a canonical address`);
  return value as EthAddress;
}

function decodeAccount(value: unknown): RecurringPaymentAccount {
  const record = asRecord(value, 'Recurring payment account');
  const owner = addressField(record, 'owner');
  if (!isAccountAddress(owner)) throw new Error('Recurring payment owner is malformed');
  const paymentCount = bigintField(record, 'paymentCount');
  if (paymentCount > RECURRING_PAYMENT_MAX_PER_ACCOUNT) throw new Error('Recurring payment count exceeds its bound');
  return {
    owner,
    balance: bigintField(record, 'balance'),
    paymentCount,
    createdAtHeight: bigintField(record, 'createdAtHeight'),
  };
}

function decodePayment(value: unknown): RecurringPayment {
  const outer = asRecord(value, 'Recurring payment');
  const config = asRecord(outer.config, 'Recurring payment config');
  const state = asRecord(outer.state, 'Recurring payment state');
  const status = stringField(state, 'status');
  if (!['active', 'completed', 'cancelled'].includes(status)) throw new Error('Recurring payment status is malformed');
  const executionCount = bigintField(config, 'executionCount');
  const attempts = bigintField(state, 'attempts');
  const payments = bigintField(state, 'payments');
  const scheduleIds = state.scheduleIds;
  if (executionCount === 0n || executionCount > BigInt(RECURRING_PAYMENT_MAX_EXECUTIONS)
    || attempts > executionCount || payments > attempts
    || !Array.isArray(scheduleIds) || scheduleIds.length !== Number(executionCount)
    || !scheduleIds.every((id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id))) {
    throw new Error('Recurring payment execution state is inconsistent');
  }
  const owner = addressField(config, 'owner');
  if (!isAccountAddress(owner)) throw new Error('Recurring payment owner is malformed');
  const index = bigintField(config, 'index');
  if (index === 0n || index > RECURRING_PAYMENT_MAX_PER_ACCOUNT) throw new Error('Recurring payment index exceeds its bound');
  const nextExecutionHeight = nullableBigintField(state, 'nextExecutionHeight');
  if ((status === 'active') !== (nextExecutionHeight !== null)) throw new Error('Recurring payment next height is inconsistent');
  return {
    owner,
    name: normalizeName(stringField(config, 'name')),
    recipient: addressField(config, 'recipient'),
    amount: bigintField(config, 'amount'),
    intervalBlocks: bigintField(config, 'intervalBlocks'),
    firstExecutionHeight: bigintField(config, 'firstExecutionHeight'),
    executionCount,
    label: stringField(config, 'label'),
    index,
    createdAtHeight: bigintField(config, 'createdAtHeight'),
    status: status as RecurringPaymentStatus,
    scheduleIds: [...scheduleIds] as string[],
    attempts,
    payments,
    nextExecutionHeight,
    updatedAtHeight: bigintField(state, 'updatedAtHeight'),
    lastAttemptHeight: nullableBigintField(state, 'lastAttemptHeight'),
    lastPaymentHeight: nullableBigintField(state, 'lastPaymentHeight'),
  };
}

function normalizeInput(input: RecurringPaymentInput) {
  return {
    name: normalizeName(input.name),
    recipient: canonicalAddress(input.recipient, 'Recurring payment recipient'),
    amount: u64(input.amount, 'Recurring payment amount', true),
    intervalBlocks: BigInt(boundedInteger(input.intervalBlocks, 'Recurring payment interval', 2, 1_000_000)),
    firstDelayBlocks: BigInt(boundedInteger(input.firstDelayBlocks ?? input.intervalBlocks, 'Recurring payment first delay', 2, 1_000_000)),
    executionCount: BigInt(boundedInteger(input.executionCount, 'Recurring payment execution count', 1, RECURRING_PAYMENT_MAX_EXECUTIONS)),
    label: normalizeLabel(input.label),
  };
}

function mutationOptions(options: RecurringPaymentMutationOptions, gasLimit = 1_000_000) {
  return {
    gasLimit: options.gasLimit ?? gasLimit,
    timeoutMs: options.timeoutMs ?? 60_000,
    expiryHeight: options.expiryHeight,
    waitForConfirmation: true,
  } as const;
}

export class RecurringPaymentClient {
  readonly provider: RiadchainProvider;
  readonly contractAddress: EthAddress;

  constructor(provider: RiadchainProvider, contractAddress: EthAddress) {
    this.provider = provider;
    this.contractAddress = recurringContract(contractAddress);
  }

  async getAccount(owner: EthAddress): Promise<RecurringPaymentAccount | null> {
    const result = await this.provider.callView(this.contractAddress, 'getAccount', { owner: accountAddress(owner, 'Recurring payment owner') });
    return result.returnValue === null ? null : decodeAccount(result.returnValue);
  }

  async get(owner: EthAddress, name: string): Promise<RecurringPayment | null> {
    const result = await this.provider.callView(this.contractAddress, 'get', {
      owner: accountAddress(owner, 'Recurring payment owner'), name: normalizeName(name),
    });
    return result.returnValue === null ? null : decodePayment(result.returnValue);
  }

  async list(owner: EthAddress, cursor = 0n, limit = RECURRING_PAYMENT_MAX_PAGE_SIZE): Promise<RecurringPaymentPage> {
    if (cursor < 0n || cursor > RECURRING_PAYMENT_MAX_PER_ACCOUNT) throw new Error('Recurring payment cursor exceeds its bound');
    if (limit <= 0n || limit > RECURRING_PAYMENT_MAX_PAGE_SIZE) throw new Error('Recurring payment page limit must be between 1 and 32');
    const result = await this.provider.callView(this.contractAddress, 'list', {
      owner: accountAddress(owner, 'Recurring payment owner'), cursor, limit,
    });
    const page = asRecord(result.returnValue, 'Recurring payment page');
    if (!Array.isArray(page.payments) || typeof page.hasMore !== 'boolean') throw new Error('Recurring payment page is malformed');
    const nextCursor = bigintField(page, 'nextCursor');
    const total = bigintField(page, 'total');
    if (page.payments.length > Number(limit) || total > RECURRING_PAYMENT_MAX_PER_ACCOUNT
      || nextCursor < cursor || nextCursor > total || page.hasMore !== (nextCursor < total)) {
      throw new Error('Recurring payment page cursors are inconsistent');
    }
    return { payments: page.payments.map(decodePayment), nextCursor, hasMore: page.hasMore, total };
  }

  async deposit(wallet: WalletSession, amount: bigint, options: RecurringPaymentMutationOptions = {}) {
    u64(amount, 'Recurring payment deposit', true);
    return this.send(wallet, 'deposit', {}, options, amount);
  }

  async withdraw(wallet: WalletSession, recipient: EthAddress, amount: bigint, options: RecurringPaymentMutationOptions = {}) {
    return this.send(wallet, 'withdraw', {
      recipient: canonicalAddress(recipient, 'Recurring withdrawal recipient'),
      amount: u64(amount, 'Recurring withdrawal', true),
    }, options);
  }

  async create(wallet: WalletSession, input: RecurringPaymentInput, options: RecurringPaymentMutationOptions = {}) {
    return this.send(wallet, 'create', normalizeInput(input), options);
  }

  async cancel(wallet: WalletSession, name: string, options: RecurringPaymentMutationOptions = {}) {
    return this.send(wallet, 'cancel', { name: normalizeName(name) }, options);
  }

  private async send(
    wallet: WalletSession,
    method: string,
    data: Record<string, ContractValue>,
    options: RecurringPaymentMutationOptions,
    callValue?: bigint,
  ): Promise<{ txId: string; receipt: TransactionReceipt }> {
    const sent = await wallet.sendContractCall(this.contractAddress, method, data, {
      ...mutationOptions(options),
      ...(callValue === undefined ? {} : { callValue }),
    });
    const receipt = await this.provider.getReceipt(sent.tx.id);
    if (!receipt.success) throw new Error(receipt.error ?? `Recurring payment ${method} failed`);
    return { txId: sent.tx.id, receipt };
  }
}

export async function deployRecurringPayment(
  wallet: WalletSession,
  charlieSource: string,
  options: { salt: string; gasLimit?: number; timeoutMs?: number; upgradeAuthority?: EthAddress | null },
): Promise<{ txId: string; contractAddress: EthAddress; client: RecurringPaymentClient }> {
  if (!charlieSource.trim()) throw new Error('Recurring payment Charlie source must not be empty');
  const deployed = await wallet.sendContractDeploy(charlieSource, {
    salt: options.salt,
    gasLimit: options.gasLimit ?? 2_000_000,
    timeoutMs: options.timeoutMs ?? 60_000,
    waitForConfirmation: true,
    upgradeAuthority: options.upgradeAuthority,
  });
  const contractAddress = deployed.contractAddress as EthAddress;
  return { txId: deployed.tx.id, contractAddress, client: new RecurringPaymentClient(wallet.provider, contractAddress) };
}
