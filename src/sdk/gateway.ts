import type { EthAddress, Transaction, TransactionReceipt, UTXO } from './types.ts';
import { decodeContractValueFromRpc, encodeContractValue, normalizeContractValue, type ContractValue } from '../lib/contractValueCodec.ts';
import { decodeContractArguments, encodeContractArguments } from '../lib/contractArguments.ts';
import { buildContractCallTx } from '../lib/txUtils.ts';
import { normalizeCanonicalFileCid } from '../lib/filePayload.ts';
import { getAddressKind, isAccountAddress, isValidAddress, verifyAndRecover } from './internal/crypto.ts';
import { assertSigningTransaction } from './signingPolicy.ts';
import { classifyTransactionOutcome } from './transactionOutcome.ts';
import type { ProtocolParams } from '../lib/protocolParams.ts';
import type { RiadchainProvider } from './provider.ts';
export type GatewayScalar = null | boolean | string | bigint;
export type GatewayArgumentConstraint = {
  kind: 'subject';
} | {
  kind: 'any';
} | {
  kind: 'actor';
} | {
  kind: 'fixed';
  value: ContractValue;
};
export type GatewayCondition = {
  kind: 'none';
} | {
  kind: 'storageEquals';
  contractAddress: EthAddress;
  codeHash: string;
  slot: string;
  value: GatewayScalar;
} | {
  kind: 'tokenBalance';
  tokenId: bigint;
  minBalance: bigint;
} | {
  kind: 'tokenBalanceAt';
  account: EthAddress | 'actor';
  tokenId: bigint;
  minBalance: bigint;
};
export type GatewayTokenSpendLimit = {
  operation: 'transfer' | 'burn';
  tokenId: bigint;
  maxAmount: bigint;
  to: EthAddress | null;
} | {
  operation: 'transfer' | 'burn';
  creatorAddress: EthAddress;
  tokenType: 'nft';
  maxAmount: 1n;
  maxEntries: bigint;
  to: EthAddress | null;
};
export type GatewayContractScope = {
  contractAddress: EthAddress;
  codeHash: string;
  method: string;
  arguments: Record<string, GatewayArgumentConstraint>;
};
type RuleBase = {
  ruleId: string;
  applicationId: string;
  enabled: boolean;
  subject: 'authenticated' | EthAddress | `service:${string}`;
  condition: GatewayCondition;
};
export type GatewayRule = RuleBase & ({
  kind: 'view';
  scope: GatewayContractScope;
} | {
  kind: 'call';
  scope: GatewayContractScope & {
    limits: {
      maxGas: bigint;
      maxValue: bigint;
      tokenSpend: GatewayTokenSpendLimit[];
    };
  };
} | {
  kind: 'managedCall';
  scope: GatewayContractScope & {
    walletId: string;
    capabilityId: string | null;
    limits: GatewayManagedLimits;
  };
} | {
  kind: 'events';
  scope: {
    contractAddress: EthAddress;
    codeHash: string;
    eventName: string;
  };
} | {
  kind: 'file';
  scope: {
    cid: string;
  };
} | {
  kind: 'chain';
  scope: Record<string, never>;
} | {
  kind: 'utxos';
  scope: { account: 'subject' | EthAddress };
} | {
  kind: 'code';
  scope: { contractAddress: EthAddress; codeHash: string };
} | {
  kind: 'token';
  scope: { tokenId: bigint };
} | {
  kind: 'transaction';
  scope: { applicationId: string; contractAddress: EthAddress; codeHash: string };
} | {
  kind: 'balance';
  scope: {
    account: 'subject' | EthAddress;
    tokenId: bigint | null;
  };
});
export type GatewayManagedLimits = { maxGas: bigint; maxFeeSatoshis: bigint; maxCallsPerMinute: bigint; maxFeePerDaySatoshis: bigint; maxQueueDepth: bigint };
export type GatewayManagedCallRule = Extract<GatewayRule, { kind: 'managedCall' }>;
export type GatewayClient = { clientId: string; label: string; enabled: boolean; connectionCount: bigint };
export type GatewayConnectionAuth = { type: 'bearer' } | { type: 'cloudflare'; issuer: string; audience: string; clientId: string };
export type GatewayConnection = { connectionId: string; applicationId: string; clientId: string; label: string; enabled: boolean; host: string; auth: GatewayConnectionAuth };
export type GatewayWallet = { walletId: string; label: string; enabled: boolean; address: EthAddress; ruleCount: bigint };
export type GatewayClientInput = Omit<GatewayClient, 'connectionCount'>;
export type GatewayWalletInput = Omit<GatewayWallet, 'ruleCount'>;
export type Gateway = {
  gatewayId: string;
  label: string;
  enabled: boolean;
  deleted: boolean;
  epoch: bigint;
  applicationCount: bigint;
  clientCount: bigint;
  connectionCount: bigint;
  walletCount: bigint;
};
export type GatewayApplication = {
  applicationId: string;
  label: string;
  enabled: boolean;
  ruleCount: bigint;
  connectionCount: bigint;
};
export type GatewayMetadata = {
  format: 'riadchain-gateway-access';
  version: 2n;
  bootstrapOwner: EthAddress;
  adminRecipient: EthAddress;
  adminTokenId: bigint | null;
};
export type GatewayAuthorization = {
  gatewayId: string;
  epoch: bigint;
  subject: EthAddress;
  allowed: boolean;
  rule: GatewayRule | null;
  application: GatewayApplication | null;
};
export type GatewayServiceAuthorization = Omit<GatewayAuthorization, 'subject'> & {
  subject: `service:${string}` | null;
  connection: GatewayConnection | null;
  client: GatewayClient | null;
  wallet: GatewayWallet | null;
};
export type GatewayPage<T> = {
  entries: Array<{
    key: string;
    value: T;
  }>;
  next: string | null;
};
export type GatewayPageOptions = {
  after?: string | null;
  limit?: number;
};
export type GatewayAction = {
  method: 'initialize';
} | {
  method: 'putGateway';
  gatewayId: string;
  expectedEpoch: bigint;
  label: string;
  enabled: boolean;
} | {
  method: 'deleteGateway';
  gatewayId: string;
  expectedEpoch: bigint;
} | {
  method: 'putApplication';
  gatewayId: string;
  expectedEpoch: bigint;
  applicationId: string;
  label: string;
  enabled: boolean;
} | {
  method: 'deleteApplication';
  gatewayId: string;
  expectedEpoch: bigint;
  applicationId: string;
} | {
  method: 'putRule';
  gatewayId: string;
  expectedEpoch: bigint;
  rule: GatewayRule;
} | {
  method: 'putRules';
  gatewayId: string;
  expectedEpoch: bigint;
  rules: GatewayRule[];
} | {
  method: 'deleteRule';
  gatewayId: string;
  expectedEpoch: bigint;
  ruleId: string;
} | {
  method: 'putClient'; gatewayId: string; expectedEpoch: bigint; client: GatewayClientInput;
} | {
  method: 'deleteClient'; gatewayId: string; expectedEpoch: bigint; clientId: string;
} | {
  method: 'putConnection'; gatewayId: string; expectedEpoch: bigint; connection: GatewayConnection;
} | {
  method: 'deleteConnection'; gatewayId: string; expectedEpoch: bigint; connectionId: string;
} | {
  method: 'putWallet'; gatewayId: string; expectedEpoch: bigint; wallet: GatewayWalletInput;
} | {
  method: 'deleteWallet'; gatewayId: string; expectedEpoch: bigint; walletId: string;
};
export type GatewayCallOptions = {
  protocolParams: ProtocolParams;
  gasLimit?: number;
  expiryHeight?: number | null;
};
export const GATEWAY_CALL_GAS = 500000;
export const GATEWAY_MAX_RULE_BATCH = 32;
/** Matches the contract's bounded canonical, lowercase hyphen-separated IDs. */
export const GATEWAY_ID_PATTERN = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error('Expected a Gateway record');
  return value as Record<string, unknown>;
}
function shape(row: Record<string, unknown>, names: string[]): void {
  if (Object.keys(row).sort().join(',') !== [...names].sort().join(','))
    throw new Error('Unexpected Gateway fields');
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || /[\x00-\x1f\x7f]/.test(value) || new TextEncoder().encode(value).length > max)
    throw new Error('Invalid Gateway text');
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !GATEWAY_ID_PATTERN.test(value))
    throw new Error('Invalid Gateway identifier');
  return value;
}
function address(value: unknown): EthAddress {
  if (typeof value !== 'string' || !isValidAddress(value) || value !== value.toLowerCase())
    throw new Error('Invalid canonical Gateway address');
  return value as EthAddress;
}
function account(value: unknown): EthAddress {
  const result = address(value);
  if (!isAccountAddress(result))
    throw new Error('Gateway subject must be an account');
  return result;
}
function contract(value: unknown): EthAddress {
  const result = address(value);
  if (!['contract', 'internal_contract'].includes(getAddressKind(result)))
    throw new Error('Gateway requires a deployed contract address');
  return result;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new Error('Invalid Gateway source digest');
  return value;
}
function integer(value: unknown, max = U128_MAX, json = false): bigint {
  if (json && typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && value.length <= 39)
    value = BigInt(value);
  if (typeof value !== 'bigint' || value < 0n || value > max)
    throw new Error('Invalid Gateway integer');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean')
    throw new Error('Invalid Gateway boolean');
  return value;
}
function positive(value: unknown, max = U128_MAX, json = false): bigint {
  const result = integer(value, max, json);
  if (!result)
    throw new Error('Gateway amount must be positive');
  return result;
}
function condition(value: unknown, json = false): GatewayCondition {
  const row = record(value);
  if (row.kind === 'none') {
    shape(row, ['kind']);
    return { kind: 'none' };
  }
  if (row.kind === 'tokenBalance') {
    shape(row, ['kind', 'tokenId', 'minBalance']);
    return { kind: 'tokenBalance', tokenId: positive(row.tokenId, U128_MAX, json), minBalance: positive(row.minBalance, U128_MAX, json) };
  }
  if (row.kind === 'tokenBalanceAt') {
    shape(row, ['kind', 'account', 'tokenId', 'minBalance']);
    return { kind: 'tokenBalanceAt', account: row.account === 'actor' ? 'actor' : account(row.account), tokenId: positive(row.tokenId, U128_MAX, json), minBalance: positive(row.minBalance, U128_MAX, json) };
  }
  if (row.kind !== 'storageEquals')
    throw new Error('Unknown Gateway condition');
  shape(row, ['kind', 'contractAddress', 'codeHash', 'slot', 'value']);
  const scalar = json ? decodeContractValueFromRpc(row.value) : normalizeContractValue(row.value);
  if (scalar !== null && !['boolean', 'string', 'bigint'].includes(typeof scalar))
    throw new Error('Gateway condition requires a scalar');
  return { kind: 'storageEquals', contractAddress: contract(row.contractAddress), codeHash: digest(row.codeHash), slot: text(row.slot, 256), value: scalar as GatewayScalar };
}
function argumentsPolicy(value: unknown, json: boolean): Record<string, GatewayArgumentConstraint> {
  const row = record(value);
  if (Object.keys(row).length > 16)
    throw new Error('Too many Gateway argument constraints');
  return Object.fromEntries(Object.entries(row).map(([field, raw]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field))
      throw new Error('Invalid Gateway argument field');
    const item = record(raw);
    if (item.kind === 'subject' || item.kind === 'any' || item.kind === 'actor') {
      shape(item, ['kind']);
      return [field, { kind: item.kind }];
    }
    if (item.kind !== 'fixed')
      throw new Error('Unknown Gateway argument constraint');
    shape(item, ['kind', 'value']);
    return [field, { kind: 'fixed', value: json ? decodeContractValueFromRpc(item.value) : normalizeContractValue(item.value) }];
  }));
}
export function normalizeGatewayClient(value: unknown): GatewayClientInput {
  const row = record(value); shape(row, ['clientId', 'label', 'enabled']);
  return { clientId: id(row.clientId), label: text(row.label), enabled: boolean(row.enabled) };
}
export function normalizeGatewayWallet(value: unknown): GatewayWalletInput {
  const row = record(value); shape(row, ['walletId', 'label', 'enabled', 'address']);
  return { walletId: id(row.walletId), label: text(row.label), enabled: boolean(row.enabled), address: account(row.address) };
}
export function normalizeGatewayConnection(value: unknown): GatewayConnection {
  const row = record(value); shape(row, ['connectionId', 'applicationId', 'clientId', 'label', 'enabled', 'host', 'auth']);
  const host = text(row.host, 253);
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/.test(host)
    || new URL(`https://${host}`).host !== host) throw new Error('Invalid Gateway connection host');
  const auth = record(row.auth); let normalized: GatewayConnectionAuth;
  if (auth.type === 'bearer') { shape(auth, ['type']); normalized = { type: 'bearer' }; }
  else if (auth.type === 'cloudflare') {
    shape(auth, ['type', 'issuer', 'audience', 'clientId']);
    const issuer = text(auth.issuer, 256), url = new URL(issuer);
    if (url.protocol !== 'https:' || url.origin !== issuer || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer)) throw new Error('Invalid Gateway Access team issuer');
    normalized = { type: 'cloudflare', issuer, audience: text(auth.audience, 256), clientId: text(auth.clientId, 256) };
  } else throw new Error('Invalid Gateway connection authentication');
  return { connectionId: id(row.connectionId), applicationId: id(row.applicationId), clientId: id(row.clientId), label: text(row.label), enabled: boolean(row.enabled), host, auth: normalized };
}
function principal(value: unknown): RuleBase['subject'] {
  if (value === 'authenticated') return value;
  if (typeof value === 'string' && value.startsWith('service:')) return `service:${id(value.slice(8))}`;
  return account(value);
}
/** Strict schema; only known integer fields accept decimal strings at the JSON boundary. */
export function normalizeGatewayRule(value: unknown, json = false): GatewayRule {
  const row = record(value);
  shape(row, ['ruleId', 'applicationId', 'enabled', 'subject', 'kind', 'scope', 'condition']);
  const base: RuleBase = { ruleId: id(row.ruleId), applicationId: id(row.applicationId), enabled: boolean(row.enabled), subject: principal(row.subject), condition: condition(row.condition, json) };
  const scope = record(row.scope);
  let result: GatewayRule;
  if (row.kind === 'view' || row.kind === 'call' || row.kind === 'managedCall') {
    shape(scope, row.kind === 'managedCall' ? ['contractAddress', 'codeHash', 'method', 'arguments', 'limits', 'walletId', 'capabilityId'] : row.kind === 'call' ? ['contractAddress', 'codeHash', 'method', 'arguments', 'limits'] : ['contractAddress', 'codeHash', 'method', 'arguments']);
    const common: GatewayContractScope = { contractAddress: contract(scope.contractAddress), codeHash: digest(scope.codeHash), method: text(scope.method), arguments: argumentsPolicy(scope.arguments, json) };
    if (row.kind === 'managedCall') {
      if (!base.subject.startsWith('service:')) throw new Error('Managed calls require an exact service principal');
      const limits = record(scope.limits); shape(limits, ['maxGas', 'maxFeeSatoshis', 'maxCallsPerMinute', 'maxFeePerDaySatoshis', 'maxQueueDepth']);
      const normalized = { maxGas: positive(limits.maxGas, U64_MAX, json), maxFeeSatoshis: positive(limits.maxFeeSatoshis, U128_MAX, json), maxCallsPerMinute: positive(limits.maxCallsPerMinute, 10000n, json), maxFeePerDaySatoshis: positive(limits.maxFeePerDaySatoshis, U128_MAX, json), maxQueueDepth: positive(limits.maxQueueDepth, 1000n, json) };
      if (normalized.maxFeeSatoshis > normalized.maxFeePerDaySatoshis) throw new Error('Gateway per-call fee exceeds daily budget');
      result = { ...base, kind: 'managedCall', scope: { ...common, walletId: id(scope.walletId), capabilityId: scope.capabilityId === null ? null : digest(scope.capabilityId), limits: normalized } };
    }
    else if (row.kind === 'view')
      result = { ...base, kind: 'view', scope: common };
    else {
      const limits = record(scope.limits);
      shape(limits, ['maxGas', 'maxValue', 'tokenSpend']);
      if (!Array.isArray(limits.tokenSpend) || limits.tokenSpend.length > 8)
        throw new Error('Invalid Gateway token limits');
      const tokenSpend = limits.tokenSpend.map(raw => {
        const spend = record(raw);
        if (spend.operation !== 'transfer' && spend.operation !== 'burn')
          throw new Error('Invalid Gateway spend operation');
        if (spend.operation === 'burn' && spend.to !== null || spend.operation === 'transfer' && spend.to === null)
          throw new Error('Invalid Gateway spend recipient');
        if (Object.hasOwn(spend, 'creatorAddress')) {
          shape(spend, ['operation', 'creatorAddress', 'tokenType', 'maxAmount', 'maxEntries', 'to']);
          if (spend.tokenType !== 'nft' || positive(spend.maxAmount, U128_MAX, json) !== 1n)
            throw new Error('Creator-selected spending requires one unit per NFT');
          return {
            operation: spend.operation, creatorAddress: contract(spend.creatorAddress), tokenType: 'nft',
            maxAmount: 1n, maxEntries: positive(spend.maxEntries, 16n, json),
            to: spend.to === null ? null : address(spend.to)
          } as GatewayTokenSpendLimit;
        }
        shape(spend, ['operation', 'tokenId', 'maxAmount', 'to']);
        return { operation: spend.operation, tokenId: positive(spend.tokenId, U128_MAX, json), maxAmount: positive(spend.maxAmount, U128_MAX, json), to: spend.to === null ? null : address(spend.to) } as GatewayTokenSpendLimit;
      });
      if (tokenSpend.reduce((total, item) => total + ('creatorAddress' in item ? item.maxEntries : 1n), 0n) > 16n)
        throw new Error('Gateway token limits exceed sixteen total entries');
      const identities = tokenSpend.map(item => `${item.operation}:${'tokenId' in item ? `token:${item.tokenId}` : `nft:${item.creatorAddress}`}:${item.to}`);
      if (new Set(identities).size !== identities.length)
        throw new Error('Duplicate Gateway token spend limit');
      result = { ...base, kind: 'call', scope: { ...common, limits: { maxGas: positive(limits.maxGas, U64_MAX, json), maxValue: integer(limits.maxValue, U128_MAX, json), tokenSpend } } };
    }
  }
  else if (row.kind === 'events') {
    shape(scope, ['contractAddress', 'codeHash', 'eventName']);
    result = { ...base, kind: 'events', scope: { contractAddress: contract(scope.contractAddress), codeHash: digest(scope.codeHash), eventName: text(scope.eventName) } };
  }
  else if (row.kind === 'file') {
    shape(scope, ['cid']);
    result = { ...base, kind: 'file', scope: { cid: normalizeCanonicalFileCid(scope.cid) } };
  }
  else if (row.kind === 'chain') {
    shape(scope, []);
    result = { ...base, kind: 'chain', scope: {} };
  }
  else if (row.kind === 'utxos') {
    shape(scope, ['account']);
    result = { ...base, kind: 'utxos', scope: { account: scope.account === 'subject' ? 'subject' : account(scope.account) } };
  }
  else if (row.kind === 'code') {
    shape(scope, ['contractAddress', 'codeHash']);
    result = { ...base, kind: 'code', scope: { contractAddress: contract(scope.contractAddress), codeHash: digest(scope.codeHash) } };
  }
  else if (row.kind === 'token') {
    shape(scope, ['tokenId']);
    result = { ...base, kind: 'token', scope: { tokenId: positive(scope.tokenId, U128_MAX, json) } };
  }
  else if (row.kind === 'transaction') {
    shape(scope, ['applicationId', 'contractAddress', 'codeHash']);
    result = { ...base, kind: 'transaction', scope: { applicationId: id(scope.applicationId), contractAddress: contract(scope.contractAddress), codeHash: digest(scope.codeHash) } };
  }
  else if (row.kind === 'balance') {
    shape(scope, ['account', 'tokenId']);
    result = { ...base, kind: 'balance', scope: { account: scope.account === 'subject' ? 'subject' : address(scope.account), tokenId: scope.tokenId === null ? null : positive(scope.tokenId, U128_MAX, json) } };
  }
  else
    throw new Error('Unknown Gateway rule kind');
  const service = base.subject.startsWith('service:');
  if (service && (result.kind === 'call' || base.condition.kind === 'tokenBalance'
    || ('arguments' in result.scope && Object.values(result.scope.arguments).some(arg => arg.kind === 'subject'))
    || ('account' in result.scope && result.scope.account === 'subject'))) throw new Error('Service principals have no wallet subject');
  if (result.kind !== 'managedCall' && (('arguments' in result.scope && Object.values(result.scope.arguments).some(arg => arg.kind === 'actor'))
    || base.condition.kind === 'tokenBalanceAt' && base.condition.account === 'actor')) throw new Error('Actor binding requires a managed call');
  if (new TextEncoder().encode(encodeContractValue(result)).length > 8192)
    throw new Error('Gateway rule exceeds 8 KiB');
  return result;
}
function normalizeAction(value: unknown, json: boolean): GatewayAction {
  const row = record(value);
  if (row.method === 'initialize') {
    shape(row, ['method']);
    return { method: 'initialize' };
  }
  const common = { gatewayId: id(row.gatewayId), expectedEpoch: integer(row.expectedEpoch, U64_MAX - 1n, json) };
  switch (row.method) {
    case 'putClient':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'client']);
      return { method: row.method, ...common, client: normalizeGatewayClient(row.client) };
    case 'putConnection':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'connection']);
      return { method: row.method, ...common, connection: normalizeGatewayConnection(row.connection) };
    case 'putWallet':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'wallet']);
      return { method: row.method, ...common, wallet: normalizeGatewayWallet(row.wallet) };
    case 'deleteClient':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'clientId']);
      return { method: row.method, ...common, clientId: id(row.clientId) };
    case 'deleteConnection':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'connectionId']);
      return { method: row.method, ...common, connectionId: id(row.connectionId) };
    case 'deleteWallet':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'walletId']);
      return { method: row.method, ...common, walletId: id(row.walletId) };
    case 'putGateway':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'label', 'enabled']);
      return { method: row.method, ...common, label: text(row.label), enabled: boolean(row.enabled) };
    case 'deleteGateway':
      shape(row, ['method', 'gatewayId', 'expectedEpoch']);
      return { method: row.method, ...common };
    case 'putApplication':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'applicationId', 'label', 'enabled']);
      return { method: row.method, ...common, applicationId: id(row.applicationId), label: text(row.label), enabled: boolean(row.enabled) };
    case 'deleteApplication':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'applicationId']);
      return { method: row.method, ...common, applicationId: id(row.applicationId) };
    case 'putRule':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'rule']);
      return { method: row.method, ...common, rule: normalizeGatewayRule(row.rule, json) };
    case 'putRules': {
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'rules']);
      if (!Array.isArray(row.rules) || row.rules.length < 1 || row.rules.length > GATEWAY_MAX_RULE_BATCH)
        throw new Error('Gateway rule batch must contain 1 to 32 rules');
      const rules = row.rules.map(rule => normalizeGatewayRule(rule, json));
      if (new Set(rules.map(rule => rule.ruleId)).size !== rules.length)
        throw new Error('Duplicate Gateway rule in batch');
      return { method: row.method, ...common, rules };
    }
    case 'deleteRule':
      shape(row, ['method', 'gatewayId', 'expectedEpoch', 'ruleId']);
      return { method: row.method, ...common, ruleId: id(row.ruleId) };
    default: throw new Error('Unknown Gateway action');
  }
}
export function normalizeGatewayActionJSON(value: unknown): GatewayAction { return normalizeAction(value, true); }
export function gatewayActionArguments(action: GatewayAction): Record<string, unknown> {
  const { method: _method, ...args } = normalizeAction(action, false);
  return args;
}
/** Unsigned owner intent. No native value, token spend or capability authorization. */
export function buildGatewayCallTx(chainId: string, owner: EthAddress, target: EthAddress, action: GatewayAction, timestamp: number, utxos: UTXO[], options: GatewayCallOptions): Transaction {
  account(owner);
  contract(target);
  if (utxos.some(input => input.address !== owner || typeof input.amount !== 'bigint' || input.amount <= 0n))
    throw new Error('Gateway inputs do not belong to the selected account');
  const result = buildContractCallTx(chainId, owner, target, action.method, encodeContractArguments(gatewayActionArguments(action)), timestamp, utxos, {
    protocolParams: options.protocolParams, gasLimit: options.gasLimit ?? GATEWAY_CALL_GAS, expiryHeight: options.expiryHeight, callValue: 0n
  });
  if ('error' in result)
    throw new Error(result.error);
  return result.tx;
}
function gatewayRecord(value: unknown): Gateway {
  const row = record(value);
  shape(row, ['gatewayId', 'label', 'enabled', 'deleted', 'epoch', 'applicationCount', 'clientCount', 'connectionCount', 'walletCount']);
  return { gatewayId: id(row.gatewayId), label: text(row.label), enabled: boolean(row.enabled), deleted: boolean(row.deleted), epoch: positive(row.epoch, U64_MAX), applicationCount: integer(row.applicationCount, U64_MAX), clientCount: integer(row.clientCount, U64_MAX), connectionCount: integer(row.connectionCount, U64_MAX), walletCount: integer(row.walletCount, U64_MAX) };
}
function applicationRecord(value: unknown): GatewayApplication {
  const row = record(value);
  shape(row, ['applicationId', 'label', 'enabled', 'ruleCount', 'connectionCount']);
  return { applicationId: id(row.applicationId), label: text(row.label), enabled: boolean(row.enabled), ruleCount: integer(row.ruleCount, U64_MAX), connectionCount: integer(row.connectionCount, U64_MAX) };
}
function clientRecord(value: unknown): GatewayClient {
  const { connectionCount, ...input } = record(value);
  return { ...normalizeGatewayClient(input), connectionCount: integer(connectionCount, U64_MAX) };
}
function walletRecord(value: unknown): GatewayWallet {
  const { ruleCount, ...input } = record(value);
  return { ...normalizeGatewayWallet(input), ruleCount: integer(ruleCount, U64_MAX) };
}
type ViewProvider = Pick<RiadchainProvider, 'callView'>;
export class GatewayAccessClient {
  constructor(readonly provider: ViewProvider, readonly contractAddress: EthAddress) { contract(contractAddress); }
  private async view(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return (await this.provider.callView(this.contractAddress, method, args)).returnValue;
  }
  async metadata(): Promise<GatewayMetadata> {
    const row = record(await this.view('getMetadata'));
    shape(row, ['format', 'version', 'bootstrapOwner', 'adminRecipient', 'adminTokenId']);
    if (row.format !== 'riadchain-gateway-access' || row.version !== 2n)
      throw new Error('Unknown Gateway contract format');
    return { format: row.format, version: 2n, bootstrapOwner: account(row.bootstrapOwner), adminRecipient: account(row.adminRecipient), adminTokenId: row.adminTokenId === null ? null : positive(row.adminTokenId) };
  }
  async isAdmin(subject: EthAddress): Promise<boolean> { return boolean(await this.view('isAdmin', { subject: account(subject) })); }
  async getGateway(gatewayId: string): Promise<Gateway | null> {
    const result = await this.view('getGateway', { gatewayId: id(gatewayId) });
    if (result === null)
      return null;
    const row = gatewayRecord(result);
    if (row.gatewayId !== gatewayId)
      throw new Error('Gateway response identity differs');
    return row;
  }
  async getApplication(gatewayId: string, applicationId: string): Promise<GatewayApplication | null> {
    const result = await this.view('getApplication', { gatewayId: id(gatewayId), applicationId: id(applicationId) });
    if (result === null)
      return null;
    const row = applicationRecord(result);
    if (row.applicationId !== applicationId)
      throw new Error('Gateway application identity differs');
    return row;
  }
  async getRule(gatewayId: string, ruleId: string): Promise<GatewayRule | null> {
    const result = await this.view('getRule', { gatewayId: id(gatewayId), ruleId: id(ruleId) });
    if (result === null)
      return null;
    const row = normalizeGatewayRule(result);
    if (row.ruleId !== ruleId)
      throw new Error('Gateway rule identity differs');
    return row;
  }
  async authorize(gatewayId: string, ruleId: string, subject: EthAddress): Promise<GatewayAuthorization> {
    const row = record(await this.view('authorize', { gatewayId: id(gatewayId), ruleId: id(ruleId), subject: account(subject) }));
    shape(row, ['gatewayId', 'epoch', 'subject', 'allowed', 'rule', 'application']);
    const rule = row.rule === null ? null : normalizeGatewayRule(row.rule);
    const application = row.application === null ? null : applicationRecord(row.application);
    if (row.gatewayId !== gatewayId || row.subject !== subject || rule && rule.ruleId !== ruleId || application && rule && application.applicationId !== rule.applicationId)
      throw new Error('Gateway authorization identity differs');
    const allowed = boolean(row.allowed);
    if (allowed && (!rule || !application || !rule.enabled || !application.enabled || rule.subject !== 'authenticated' && rule.subject !== subject))
      throw new Error('Inconsistent Gateway authorization');
    return { gatewayId, subject, epoch: integer(row.epoch, U64_MAX), allowed, rule, application };
  }
  async getClient(gatewayId: string, clientId: string): Promise<GatewayClient | null> {
    const value = await this.view('getClient', { gatewayId: id(gatewayId), clientId: id(clientId) });
    if (value === null) return null;
    const parsed = clientRecord(value); if (parsed.clientId !== clientId) throw new Error('Gateway client identity differs'); return parsed;
  }
  async getConnection(gatewayId: string, connectionId: string): Promise<GatewayConnection | null> {
    const value = await this.view('getConnection', { gatewayId: id(gatewayId), connectionId: id(connectionId) });
    if (value === null) return null;
    const parsed = normalizeGatewayConnection(value); if (parsed.connectionId !== connectionId) throw new Error('Gateway connection identity differs'); return parsed;
  }
  async getWallet(gatewayId: string, walletId: string): Promise<GatewayWallet | null> {
    const value = await this.view('getWallet', { gatewayId: id(gatewayId), walletId: id(walletId) });
    if (value === null) return null;
    const parsed = walletRecord(value); if (parsed.walletId !== walletId) throw new Error('Gateway wallet identity differs'); return parsed;
  }
  async authorizeService(gatewayId: string, connectionId: string, ruleId: string): Promise<GatewayServiceAuthorization> {
    const row = record(await this.view('authorizeService', { gatewayId: id(gatewayId), connectionId: id(connectionId), ruleId: id(ruleId) }));
    shape(row, ['gatewayId', 'epoch', 'subject', 'allowed', 'rule', 'application', 'connection', 'client', 'wallet']);
    const connection = row.connection === null ? null : normalizeGatewayConnection(row.connection), client = row.client === null ? null : clientRecord(row.client);
    const rule = row.rule === null ? null : normalizeGatewayRule(row.rule), application = row.application === null ? null : applicationRecord(row.application);
    const wallet = row.wallet === null ? null : walletRecord(row.wallet), subject = row.subject === null ? null : principal(row.subject);
    if (row.gatewayId !== gatewayId || connection && connection.connectionId !== connectionId || rule && rule.ruleId !== ruleId
      || subject !== (connection ? `service:${connection.clientId}` : null) || subject !== null && !subject.startsWith('service:')
      || client && connection && client.clientId !== connection.clientId || application && connection && application.applicationId !== connection.applicationId
      || wallet && (rule?.kind !== 'managedCall' || wallet.walletId !== rule.scope.walletId)) throw new Error('Gateway service authorization identity differs');
    const allowed = boolean(row.allowed);
    if (allowed && (!connection?.enabled || !client?.enabled || !application?.enabled || !rule?.enabled || rule.applicationId !== connection.applicationId || rule.subject !== subject
      || rule.kind === 'call' || rule.kind === 'managedCall' && (!wallet?.enabled || rule.scope.capabilityId === null))) throw new Error('Inconsistent Gateway service authorization');
    return { gatewayId, epoch: integer(row.epoch, U64_MAX), subject: subject as GatewayServiceAuthorization['subject'], allowed, connection, client, rule, application, wallet };
  }
  private async page<T>(method: string, args: Record<string, unknown>, prefix: string, decoder: (value: unknown) => T, identity: (value: T) => string, options: GatewayPageOptions): Promise<GatewayPage<T>> {
    const limit = options.limit ?? 50, after = options.after ?? null;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || after !== null && (!after.startsWith(prefix) || !GATEWAY_ID_PATTERN.test(after.slice(prefix.length))))
      throw new Error('Invalid Gateway page');
    const row = record(await this.view(method, { ...args, after, limit: BigInt(limit) }));
    shape(row, ['entries', 'next']);
    if (!Array.isArray(row.entries) || row.entries.length > limit)
      throw new Error('Malformed Gateway page');
    let previous = after;
    const entries = row.entries.map(raw => {
      const item = record(raw);
      shape(item, ['key', 'value']);
      const value = decoder(item.value), key = `${prefix}${identity(value)}`;
      if (item.key !== key || previous !== null && key <= previous)
        throw new Error('Invalid Gateway page ordering');
      previous = key;
      return { key, value };
    });
    if (row.next !== null && (!entries.length || row.next !== previous))
      throw new Error('Invalid Gateway continuation');
    return { entries, next: row.next as string | null };
  }
  listGateways(options: GatewayPageOptions = {}): Promise<GatewayPage<Gateway>> { return this.page('listGateways', {}, 'gateway/access/', gatewayRecord, row => row.gatewayId, options); }
  listApplications(gatewayId: string, options: GatewayPageOptions = {}): Promise<GatewayPage<GatewayApplication>> { return this.page('listApplications', { gatewayId: id(gatewayId) }, `gateway/app/${gatewayId}/`, applicationRecord, row => row.applicationId, options); }
  listRules(gatewayId: string, options: GatewayPageOptions = {}): Promise<GatewayPage<GatewayRule>> { return this.page('listRules', { gatewayId: id(gatewayId) }, `gateway/rule/${gatewayId}/`, normalizeGatewayRule, row => row.ruleId, options); }
  listClients(gatewayId: string, options: GatewayPageOptions = {}): Promise<GatewayPage<GatewayClient>> { return this.page('listClients', { gatewayId: id(gatewayId) }, `gateway/client/${gatewayId}/`, clientRecord, row => row.clientId, options); }
  listConnections(gatewayId: string, options: GatewayPageOptions = {}): Promise<GatewayPage<GatewayConnection>> { return this.page('listConnections', { gatewayId: id(gatewayId) }, `gateway/connection/${gatewayId}/`, normalizeGatewayConnection, row => row.connectionId, options); }
  listWallets(gatewayId: string, options: GatewayPageOptions = {}): Promise<GatewayPage<GatewayWallet>> { return this.page('listWallets', { gatewayId: id(gatewayId) }, `gateway/wallet/${gatewayId}/`, walletRecord, row => row.walletId, options); }
}
export type ConfirmedGatewayIntent = {
  chainId: string;
  contract: EthAddress;
  owner: EthAddress;
  txId: string;
  action: GatewayAction;
};
export async function verifyConfirmedGatewayIntent(provider: Pick<RiadchainProvider, 'getChainId' | 'getTransaction' | 'getReceipt'>, expected: ConfirmedGatewayIntent): Promise<{
  transaction: Transaction;
  receipt: TransactionReceipt;
}> {
  if (await provider.getChainId() !== expected.chainId)
    throw new Error('Gateway node chain differs');
  const context = await provider.getTransaction(expected.txId), receipt = await provider.getReceipt(expected.txId), tx = context.transaction;
  if (tx.id !== expected.txId || receipt.txId !== expected.txId || classifyTransactionOutcome(context, receipt).executionStatus !== 'succeeded')
    throw new Error('Original Gateway intent lacks a matching successful receipt');
  assertSigningTransaction(tx, account(expected.owner), expected.chainId);
  shape(record(tx.payload), ['action', 'contractAddress', 'method', 'data']);
  if (tx.type !== 'CONTRACT' || tx.payload.action !== 'call' || tx.payload.contractAddress !== contract(expected.contract)
    || tx.payload.method !== expected.action.method || tx.payload.authorization || tx.payload.tokenSpend?.length || BigInt(tx.payload.value ?? 0) !== 0n
    || !tx.inputs.length || tx.inputs.some(input => !verifyAndRecover(tx.id, input.signature, expected.owner))
    || tx.outputs.some(output => output.address !== expected.owner)
    || encodeContractValue(decodeContractArguments(tx.payload.data)) !== encodeContractValue(gatewayActionArguments(expected.action)))
    throw new Error('Original Gateway transaction intent differs');
  return { transaction: tx, receipt };
}
