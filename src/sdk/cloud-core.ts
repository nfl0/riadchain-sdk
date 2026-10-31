import { encodeContractArguments, decodeContractArguments } from '../lib/contractArguments.ts';
import { encodeContractValue } from '../lib/contractValueCodec.ts';
import { buildContractCallTx } from '../lib/txUtils.ts';
import type { ProtocolParams } from '../lib/protocolParams.ts';
import { canonicalJson, setupDigest } from './appliance-setup.ts';
import { typedHash } from './typed-data.ts';
import { getAddressKind, isAccountAddress } from './internal/crypto.ts';
import { assertSigningTransaction } from './signingPolicy.ts';
import { classifyTransactionOutcome } from './transactionOutcome.ts';
import type { RiadchainProvider } from './provider.ts';
import type { EthAddress, Transaction, TransactionReceipt, UTXO } from './types.ts';

export const CLOUD_CORE_DAY_MS = 86400000n;
export const CLOUD_CORE_GRACE_DAYS = 7n;
export const CLOUD_CORE_APPROVAL_LIFETIME_MS = 48n * 60n * 60n * 1000n;
export const CLOUD_CORE_PENDING_APPROVAL_MS = 7n * CLOUD_CORE_DAY_MS;
export const CLOUD_CORE_MAX_OPERATIONS = 16;
export const CLOUD_CORE_MAX_SETUP_BYTES = 16384;
export const CLOUD_CORE_MAX_BATCH_BYTES = 32768;
export const CLOUD_CORE_CALL_GAS = 1500000;
export const CLOUD_CORE_ZERO_DIGEST = '0'.repeat(64);
/** Audited CallView surface. Forwarders cannot be declared `view` because the
 * high-level compiler treats every nested call as potentially mutating. */
export const CLOUD_CORE_READ_METHODS = ['isAdmin', 'getMetadata', 'getHead', 'getLedger', 'getService', 'getCustomer', 'getPayment', 'getOperation', 'getProfile', 'getNetwork', 'getJob', 'getSetup', 'getSetupPayload', 'listCustomers', 'listProfiles', 'listPendingPayments', 'listPendingNetworkApprovals', 'listPayments', 'listNetworks', 'listAllNetworks', 'listPending', 'listPendingSetups'] as const;
const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
export type CloudCoreScope = { chainId: string; genesisHash: string; contract: EthAddress };
export type CloudCoreProfile = { profileId: string; cpuMilli: bigint; memoryMiB: bigint; storageGiB: bigint; dailyRate: bigint; creditsPerAct: bigint; shutdownReserve: bigint };
export type CloudCoreGenesisOptions = { chainId: string; networkMode: 'private'; successionTimeoutMs: bigint; fileMinPeerAcks: 1n };
export type CloudCoreJobAction = 'provision' | 'start' | 'stop' | 'restart' | 'endHosting';
export type CloudCoreSetupStage = 'prepareSetup' | 'prepareGenesis' | 'finalizeSetup';
export type CloudCoreObservations = { bothReady: boolean; genesisHash: string; tipHash: string; tipHeight: bigint; stopped: boolean; leaseClosed: boolean; cpuMilli: bigint; memoryMiB: bigint; storageGiB: bigint };
export type CloudCoreCustomer = { customerKey: string; customerId: bigint; enabled: boolean; revision: bigint; available: bigint; allocated: bigint; spent: bigint; createdAtMs: bigint };
export type CloudCorePayment = { paymentId: string; customerKey: string; providerId: string; amount: bigint; evidenceDigest: string; paymentHash: string; status: 'pending' | 'approved' | 'rejected'; requestedAtMs: bigint; resolvedAtMs: bigint };
export type CloudCoreService = { role: 'runtime' | 'executor'; wallet: EthAddress; enabled: boolean; expiresAtHeight: bigint };
export type CloudCoreHead = { revision: bigint; authorityEpoch: bigint; sequence: bigint; batchId: string };
export type CloudCoreMetadata = { format: 'riadchain-cloud-core'; version: 1n; initialized: boolean; bootstrapOwner: EthAddress; adminRecipient: EthAddress; adminTokenId: bigint; creditsTokenId: bigint; hostingContract: EthAddress; maxSupply: bigint; topupsEnabled: boolean; purchasesEnabled: boolean; withdrawalsEnabled: false; backupsIncluded: false; maxOperations: bigint; maxSetupBytes: bigint; identity: CloudCoreScope & { version: 1n } };
export type CloudCoreSetupJob = { networkId: string; requestId: bigint; stage: CloudCoreSetupStage; inputDigest: string; state: 'requested' | 'succeeded' | 'failed'; resultDigest: string; reportHash: string; requestedAtMs: bigint; completedAtMs: bigint };
export type CloudCoreSetup = { phase: bigint; requestSequence: bigint; prepareSetupRequestId: bigint; prepareGenesisRequestId: bigint; finalizeSetupRequestId: bigint; recipientDigest: string; genesisHash: string; setupDigest: string; job: CloudCoreSetupJob | null };
export type CloudCoreJob = { networkId: string; requestId: bigint; action: CloudCoreJobAction; payloadDigest: string; state: 'requested' | 'running' | 'succeeded' | 'failed'; requestedAtMs: bigint; previousLifecycle: string; resultDigest: string; observations: CloudCoreObservations | null; completedAtMs: bigint };
export type CloudCoreNetwork = {
  terms: { networkId: string; customerKey: string; customerId: bigint; profileId: string; region: string; genesisOptions: CloudCoreGenesisOptions; configurationJson: string; configDigest: string; dailyRate: bigint; shutdownReserve: bigint; creditsPerAct: bigint; maxSpend: bigint; fundingCredits: bigint; durationMs: bigint; requestDigest: string; requestedAtMs: bigint; approvalExpiresAtMs: bigint; expiresAtMs: bigint; approvedAtMs: bigint };
  state: { available: bigint; reserve: bigint; activatedAtMs: bigint; closeAtMs: bigint; status: 'awaiting_approval' | 'approved' | 'active' | 'closing' | 'closed'; refunded: bigint; providerCost: bigint; spent: bigint; usageSequence: bigint; usageDigest: string; platform: { lifecycle: string; requestSequence: bigint; genesisHash: string; setupDigest: string; stoppedTipHash: string; stoppedTipHeight: bigint; provisioned: boolean } };
  review: { status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'; expiresAtMs: bigint; reviewedAtMs: bigint }; setup: CloudCoreSetup; job: CloudCoreJob | null; nodes: { nodeId: string; url: string }[]; closure: { automatic: boolean; graceUntilMs: bigint; reason?: string } | null; settlementDigest: string | null; machineReceiptIds: bigint[]; machineReceiptsActive: boolean; terminationRequested: boolean;
};
export type CloudCoreOperation = { operationId: string; customerKey: string } & (
  | { kind: 'registerCustomer' }
  | { kind: 'requestPayment'; paymentId: string; providerId: string; amount: bigint; evidenceDigest: string }
  | { kind: 'requestNetwork'; networkId: string; profileId: string; region: string; genesisOptions: CloudCoreGenesisOptions; configurationJson: string; configDigest: string; dailyRate: bigint; maxSpend: bigint; durationMs: bigint; fundingCredits: bigint }
  | { kind: 'fundNetwork' | 'releaseNetworkBudget'; networkId: string; amount: bigint }
  | { kind: 'requestSetup'; networkId: string; stage: CloudCoreSetupStage; requestId: bigint; inputJson: string; inputDigest: string }
  | { kind: 'requestAction'; networkId: string; action: Exclude<CloudCoreJobAction, 'endHosting'>; requestId: bigint; payloadDigest: string }
  | { kind: 'requestTermination'; networkId: string }
);
export type CloudCoreBatch = { authorityEpoch: bigint; sequence: bigint; expectedRevision: bigint; batchId: string; operations: CloudCoreOperation[] };
export type CloudCoreAction =
  | { method: 'initialize'; maxSupply: bigint }
  | { method: 'configure'; expectedRevision: bigint; topupsEnabled: boolean; purchasesEnabled: boolean }
  | { method: 'setService'; expectedEpoch: bigint; role: 'runtime' | 'executor'; wallet: EthAddress; enabled: boolean; expiresAtHeight: bigint }
  | { method: 'setCustomerEnabled'; customerKey: string; expectedCustomerRevision: bigint; enabled: boolean }
  | ({ method: 'publishProfile' } & Omit<CloudCoreProfile, 'shutdownReserve'>)
  | { method: 'approvePayment' | 'rejectPayment'; paymentId: string; expectedPaymentHash: string }
  | { method: 'reviewNetwork'; networkId: string; expectedRequestDigest: string; approved: boolean; expiresAtMs: bigint }
  | ({ method: 'applyBatch' } & CloudCoreBatch)
  | { method: 'reportSetup'; networkId: string; requestId: bigint; stage: CloudCoreSetupStage; inputDigest: string; status: 'succeeded' | 'failed'; resultJson: string; resultDigest: string; recipientDigest: string; genesisHash: string; setupDigest: string }
  | { method: 'reportPlacement'; networkId: string; requestId: bigint; nodes: { nodeId: string; url: string }[] }
  | { method: 'reportAction'; networkId: string; requestId: bigint; status: 'running' | 'succeeded' | 'failed'; resultDigest: string; observations: CloudCoreObservations }
  | { method: 'failProvision'; networkId: string; requestId: bigint; resultDigest: string }
  | { method: 'settleUsage'; networkId: string; usageSequence: bigint; providerCost: bigint; statementDigest: string }
  | { method: 'settleShutdown'; networkId: string; statementDigest: string }
  | { method: 'advanceClose'; networkId: string };
export type CloudCoreOperationResult = { operationId: string; operationHash: string; kind: string; customerKey: string; revision: bigint };
export type CloudCorePage<T> = { entries: { key: string; value: T }[]; next: string | null };

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected CloudCore record'); return value as Record<string, unknown>; }
function shape(row: Record<string, unknown>, fields: readonly string[]) { if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))) throw new Error('Unexpected CloudCore fields'); }
function uint(value: unknown, label = 'integer', max = U64): bigint { if (typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value)) value = BigInt(value); if (typeof value === 'number' && Number.isSafeInteger(value)) value = BigInt(value); if (typeof value !== 'bigint' || value < 0n || value > max) throw new Error(`Invalid CloudCore ${label}`); return value; }
function positive(value: unknown, label = 'amount') { const number = uint(value, label); if (number === 0n) throw new Error(`Invalid CloudCore ${label}`); return number; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('Expected CloudCore boolean'); return value; }
function text(value: unknown, max = 128): string { if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).length > max) throw new Error('Invalid CloudCore text'); return value; }
export function normalizeCloudCoreDigest(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid CloudCore digest'); return value; }
export function normalizeCloudCoreId(value: unknown): string { if (typeof value !== 'string' || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error('Invalid CloudCore identifier'); return value; }
export function normalizeCloudCoreNetworkId(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error('Invalid canonical CloudCore UUID'); return value; }
export function cloudCoreShutdownReserve(dailyRate: bigint): bigint { const rate = positive(dailyRate, 'daily ceiling'); if (rate > U64 / 8n) throw new Error('CloudCore reserve exceeds amount bound'); return rate * CLOUD_CORE_GRACE_DAYS; }
export function cloudCoreUsageCharge(providerCost: bigint, creditsPerAct: bigint, maxCharge = U64): bigint { const cost = uint(providerCost, 'provider consumption'), rate = positive(creditsPerAct, 'conversion rate'), limit = uint(maxCharge, 'charge limit'); if (rate > U64 / 100000000n) throw new Error('CloudCore conversion rate exceeds amount bound'); const charge = cost * rate / 100000000n; return charge < limit ? charge : limit; }
export function normalizeCloudCoreJson(value: unknown, digest: unknown, maximum = CLOUD_CORE_MAX_SETUP_BYTES): string {
  const json = text(value, maximum), parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || canonicalJson(parsed) !== json || setupDigest(parsed) !== normalizeCloudCoreDigest(digest)) throw new Error('CloudCore JSON must be canonical and match its digest');
  return json;
}
function account(value: unknown): EthAddress { if (typeof value !== 'string' || value !== value.toLowerCase() || !isAccountAddress(value)) throw new Error('Invalid CloudCore account'); return value as EthAddress; }
function contract(value: unknown): EthAddress { if (typeof value !== 'string' || value !== value.toLowerCase() || !['contract', 'internal_contract'].includes(getAddressKind(value))) throw new Error('Invalid CloudCore contract'); return value as EthAddress; }
function stage(value: unknown): CloudCoreSetupStage { if (!['prepareSetup', 'prepareGenesis', 'finalizeSetup'].includes(String(value))) throw new Error('Invalid CloudCore setup stage'); return value as CloudCoreSetupStage; }
function genesisOptions(value: unknown): CloudCoreGenesisOptions { const row = object(value); shape(row, ['chainId', 'networkMode', 'successionTimeoutMs', 'fileMinPeerAcks']); if (row.networkMode !== 'private' || uint(row.fileMinPeerAcks) !== 1n || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text(row.chainId))) throw new Error('Invalid CloudCore genesis options'); return { chainId: row.chainId as string, networkMode: 'private', successionTimeoutMs: positive(row.successionTimeoutMs), fileMinPeerAcks: 1n }; }
export function normalizeCloudCoreOperation(value: unknown): CloudCoreOperation {
  const row = object(value), base = { operationId: normalizeCloudCoreDigest(row.operationId), customerKey: normalizeCloudCoreDigest(row.customerKey) };
  let fields: string[], data: Record<string, unknown>;
  switch (row.kind) {
    case 'registerCustomer': fields = []; data = {}; break;
    case 'requestPayment': fields = ['paymentId', 'providerId', 'amount', 'evidenceDigest']; data = { paymentId: normalizeCloudCoreDigest(row.paymentId), providerId: normalizeCloudCoreId(row.providerId), amount: positive(row.amount), evidenceDigest: normalizeCloudCoreDigest(row.evidenceDigest) }; break;
    case 'requestNetwork': fields = ['networkId', 'profileId', 'region', 'genesisOptions', 'configurationJson', 'configDigest', 'dailyRate', 'maxSpend', 'durationMs', 'fundingCredits']; data = { networkId: normalizeCloudCoreNetworkId(row.networkId), profileId: normalizeCloudCoreId(row.profileId), region: normalizeCloudCoreId(row.region), genesisOptions: genesisOptions(row.genesisOptions), configurationJson: normalizeCloudCoreJson(row.configurationJson, row.configDigest, 8192), configDigest: normalizeCloudCoreDigest(row.configDigest), dailyRate: positive(row.dailyRate), maxSpend: positive(row.maxSpend), durationMs: positive(row.durationMs), fundingCredits: positive(row.fundingCredits) }; break;
    case 'fundNetwork': case 'releaseNetworkBudget': fields = ['networkId', 'amount']; data = { networkId: normalizeCloudCoreNetworkId(row.networkId), amount: positive(row.amount) }; break;
    case 'requestSetup': fields = ['networkId', 'stage', 'requestId', 'inputJson', 'inputDigest']; data = { networkId: normalizeCloudCoreNetworkId(row.networkId), stage: stage(row.stage), requestId: positive(row.requestId), inputJson: normalizeCloudCoreJson(row.inputJson, row.inputDigest), inputDigest: normalizeCloudCoreDigest(row.inputDigest) }; if (row.stage === 'prepareSetup' && row.inputJson !== '{}') throw new Error('Setup recipients are generated only by the executor'); break;
    case 'requestAction': fields = ['networkId', 'action', 'requestId', 'payloadDigest']; if (!['provision', 'start', 'stop', 'restart'].includes(String(row.action))) throw new Error('Unknown CloudCore lifecycle action'); data = { networkId: normalizeCloudCoreNetworkId(row.networkId), action: row.action, requestId: positive(row.requestId), payloadDigest: normalizeCloudCoreDigest(row.payloadDigest) }; break;
    case 'requestTermination': fields = ['networkId']; data = { networkId: normalizeCloudCoreNetworkId(row.networkId) }; break;
    default: throw new Error('Unknown CloudCore operation');
  }
  shape(row, ['operationId', 'customerKey', 'kind', ...fields]);
  return { ...base, kind: row.kind, ...data } as CloudCoreOperation;
}
export function cloudCoreIdentity(scope: CloudCoreScope) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scope.chainId)) throw new Error('Invalid CloudCore chain'); return { chainId: scope.chainId, genesisHash: normalizeCloudCoreDigest(scope.genesisHash), contract: contract(scope.contract), version: 1n }; }
export function cloudCoreOperationHash(scope: CloudCoreScope, operation: CloudCoreOperation): string { return typedHash('riadchain/cloud-operation/v1', { identity: cloudCoreIdentity(scope), operation: normalizeCloudCoreOperation(operation) }); }
export function cloudCoreBatchHash(scope: CloudCoreScope, value: Omit<CloudCoreBatch, 'batchId'>): string {
  if (!Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > CLOUD_CORE_MAX_OPERATIONS) throw new Error('CloudCore batch must contain 1–16 operations');
  const operations = value.operations.map(normalizeCloudCoreOperation); if (new Set(operations.map(op => op.operationId)).size !== operations.length) throw new Error('Duplicate CloudCore operation ID');
  const body = { identity: cloudCoreIdentity(scope), authorityEpoch: uint(value.authorityEpoch), sequence: positive(value.sequence), expectedRevision: uint(value.expectedRevision), operations };
  if (new TextEncoder().encode(encodeContractValue({ authorityEpoch: body.authorityEpoch, sequence: body.sequence, expectedRevision: body.expectedRevision, operations, batchId: CLOUD_CORE_ZERO_DIGEST })).length > CLOUD_CORE_MAX_BATCH_BYTES) throw new Error('CloudCore batch exceeds 32KiB argument bound');
  return typedHash('riadchain/cloud-batch/v1', body);
}
export function normalizeCloudCoreBatch(value: unknown): CloudCoreBatch {
  const row = object(value); shape(row, ['authorityEpoch', 'sequence', 'expectedRevision', 'batchId', 'operations']);
  if (!Array.isArray(row.operations) || row.operations.length < 1 || row.operations.length > 16) throw new Error('CloudCore batch must contain 1–16 operations');
  const result = { authorityEpoch: uint(row.authorityEpoch), sequence: positive(row.sequence), expectedRevision: uint(row.expectedRevision), batchId: normalizeCloudCoreDigest(row.batchId), operations: row.operations.map(normalizeCloudCoreOperation) };
  if (new Set(result.operations.map(op => op.operationId)).size !== result.operations.length || new TextEncoder().encode(encodeContractValue(result)).length > CLOUD_CORE_MAX_BATCH_BYTES) throw new Error('CloudCore batch is duplicate or exceeds 32KiB argument bound');
  return result;
}

export function cloudCoreActionArguments(action: CloudCoreAction): Record<string, unknown> {
  const row = object(action), data = { ...row }; delete data.method;
  const numeric = ['maxSupply', 'expectedRevision', 'expectedEpoch', 'expectedCustomerRevision', 'expiresAtHeight', 'cpuMilli', 'memoryMiB', 'storageGiB', 'dailyRate', 'creditsPerAct', 'authorityEpoch', 'sequence', 'requestId', 'usageSequence', 'providerCost', 'expiresAtMs'];
  for (const key of numeric) if (Object.hasOwn(data, key)) data[key] = uint(data[key], key);
  for (const key of ['topupsEnabled', 'purchasesEnabled', 'enabled', 'approved']) if (Object.hasOwn(data, key)) data[key] = bool(data[key]);
  for (const key of ['paymentId', 'expectedPaymentHash', 'expectedRequestDigest', 'customerKey', 'batchId', 'inputDigest', 'resultDigest', 'recipientDigest', 'genesisHash', 'setupDigest', 'statementDigest']) if (Object.hasOwn(data, key)) data[key] = normalizeCloudCoreDigest(data[key]);
  if (Object.hasOwn(data, 'networkId')) data.networkId = normalizeCloudCoreNetworkId(data.networkId);
  if (Object.hasOwn(data, 'profileId')) data.profileId = normalizeCloudCoreId(data.profileId);
  if (Object.hasOwn(data, 'wallet')) data.wallet = account(data.wallet);
  const shapes: Record<CloudCoreAction['method'], string[]> = {
    initialize: ['maxSupply'], configure: ['expectedRevision', 'topupsEnabled', 'purchasesEnabled'], setService: ['expectedEpoch', 'role', 'wallet', 'enabled', 'expiresAtHeight'], setCustomerEnabled: ['customerKey', 'expectedCustomerRevision', 'enabled'], publishProfile: ['profileId', 'cpuMilli', 'memoryMiB', 'storageGiB', 'dailyRate', 'creditsPerAct'], approvePayment: ['paymentId', 'expectedPaymentHash'], rejectPayment: ['paymentId', 'expectedPaymentHash'], reviewNetwork: ['networkId', 'expectedRequestDigest', 'approved', 'expiresAtMs'], applyBatch: ['authorityEpoch', 'sequence', 'expectedRevision', 'batchId', 'operations'], reportSetup: ['networkId', 'requestId', 'stage', 'inputDigest', 'status', 'resultJson', 'resultDigest', 'recipientDigest', 'genesisHash', 'setupDigest'], reportPlacement: ['networkId', 'requestId', 'nodes'], reportAction: ['networkId', 'requestId', 'status', 'resultDigest', 'observations'], failProvision: ['networkId', 'requestId', 'resultDigest'], settleUsage: ['networkId', 'usageSequence', 'providerCost', 'statementDigest'], settleShutdown: ['networkId', 'statementDigest'], advanceClose: ['networkId'],
  };
  if (!Object.hasOwn(shapes, action.method)) throw new Error('Unknown CloudCore method');
  shape(data, shapes[action.method]);
  if (action.method === 'initialize') data.maxSupply = positive(data.maxSupply, 'maximum supply');
  if (action.method === 'publishProfile') {
    for (const key of ['cpuMilli', 'memoryMiB', 'storageGiB', 'dailyRate', 'creditsPerAct']) data[key] = positive(data[key], key);
    if ((data.dailyRate as bigint) > U64 / 8n || (data.creditsPerAct as bigint) > U64 / 100000000n) throw new Error('CloudCore profile reserve or conversion exceeds integer bound');
  }
  if (Object.hasOwn(data, 'requestId')) data.requestId = positive(data.requestId, 'request sequence');
  if (action.method === 'settleUsage') data.usageSequence = positive(data.usageSequence, 'usage sequence');
  if (action.method === 'reviewNetwork' && (action.approved ? data.expiresAtMs === 0n : data.expiresAtMs !== 0n)) throw new Error('Invalid CloudCore approval expiry');
  if (action.method === 'setService' && !['runtime', 'executor'].includes(action.role)) throw new Error('Unknown CloudCore service role');
  if (action.method === 'applyBatch') {
    return normalizeCloudCoreBatch(data);
  }
  if (action.method === 'reportPlacement') { if (action.nodes.length !== 2) throw new Error('Two CloudCore node routes required'); data.nodes = action.nodes.map(node => { const row = object(node); shape(row, ['nodeId', 'url']); if (typeof row.nodeId !== 'string' || !/^[0-9a-f]{32}$/.test(row.nodeId)) throw new Error('Invalid CloudCore node ID'); const url = new URL(text(row.url, 512)); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid CloudCore HTTPS ingress origin'); return { nodeId: row.nodeId, url: row.url }; }); if (action.nodes[0].nodeId === action.nodes[1].nodeId || action.nodes[0].url === action.nodes[1].url) throw new Error('CloudCore node routes must differ'); }
  if (action.method === 'reportSetup') { data.stage = stage(action.stage); if (!['succeeded', 'failed'].includes(action.status)) throw new Error('Invalid setup result status'); data.resultJson = normalizeCloudCoreJson(action.resultJson, action.resultDigest); }
  if (action.method === 'reportAction') { if (!['running', 'succeeded', 'failed'].includes(action.status)) throw new Error('Invalid lifecycle result status'); const obs = object(action.observations); shape(obs, ['bothReady', 'genesisHash', 'tipHash', 'tipHeight', 'stopped', 'leaseClosed', 'cpuMilli', 'memoryMiB', 'storageGiB']); data.observations = { bothReady: bool(obs.bothReady), stopped: bool(obs.stopped), leaseClosed: bool(obs.leaseClosed), genesisHash: normalizeCloudCoreDigest(obs.genesisHash), tipHash: normalizeCloudCoreDigest(obs.tipHash), tipHeight: uint(obs.tipHeight), cpuMilli: uint(obs.cpuMilli), memoryMiB: uint(obs.memoryMiB), storageGiB: uint(obs.storageGiB) }; }
  if (new TextEncoder().encode(encodeContractValue(data)).length > CLOUD_CORE_MAX_BATCH_BYTES) throw new Error('CloudCore arguments exceed 32KiB bound');
  return data;
}

export function buildCloudCoreCallTx(chainId: string, owner: EthAddress, core: EthAddress, action: CloudCoreAction, timestamp: number, utxos: UTXO[], options: { protocolParams: ProtocolParams; gasLimit?: number; expiryHeight?: number | null }): Transaction {
  account(owner); contract(core);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(chainId) || utxos.some(input => input.address !== owner || input.amount <= 0n)) throw new Error('CloudCore chain/input scope differs');
  const result = buildContractCallTx(chainId, owner, core, action.method, encodeContractArguments(cloudCoreActionArguments(action)), timestamp, utxos, { protocolParams: options.protocolParams, gasLimit: options.gasLimit ?? CLOUD_CORE_CALL_GAS, expiryHeight: options.expiryHeight });
  if ('error' in result) throw new Error(result.error); return result.tx;
}

type ViewProvider = Pick<RiadchainProvider, 'callView'>;
export class CloudCoreClient {
  constructor(readonly provider: ViewProvider, readonly contractAddress: EthAddress) { contract(contractAddress); }
  private async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> { return (await this.provider.callView(this.contractAddress, method, args)).returnValue as T; }
  async metadata(): Promise<CloudCoreMetadata> { const row = object(await this.view('getMetadata')); if (row.format !== 'riadchain-cloud-core' || row.version !== 1n || row.withdrawalsEnabled !== false || row.backupsIncluded !== false) throw new Error('Unknown CloudCore format'); return row as CloudCoreMetadata; }
  async getHead(): Promise<CloudCoreHead> { return this.view('getHead'); }
  async isAdmin(subject: EthAddress): Promise<boolean> { return this.view('isAdmin', { subject: account(subject) }); }
  async getService(role: 'runtime' | 'executor'): Promise<CloudCoreService | null> { return this.view('getService', { role }); }
  async getCustomer(customerKey: string): Promise<CloudCoreCustomer | null> { return this.view('getCustomer', { customerKey: normalizeCloudCoreDigest(customerKey) }); }
  async getPayment(paymentId: string): Promise<CloudCorePayment | null> { return this.view('getPayment', { paymentId: normalizeCloudCoreDigest(paymentId) }); }
  async getOperation(operationId: string): Promise<CloudCoreOperationResult | null> { return this.view('getOperation', { operationId: normalizeCloudCoreDigest(operationId) }); }
  async getProfile(profileId: string): Promise<CloudCoreProfile | null> { return this.view('getProfile', { profileId: normalizeCloudCoreId(profileId) }); }
  async getNetwork(networkId: string): Promise<CloudCoreNetwork | null> { return this.view('getNetwork', { networkId: normalizeCloudCoreNetworkId(networkId) }); }
  async getJob(networkId: string): Promise<CloudCoreJob | null> { return this.view('getJob', { networkId: normalizeCloudCoreNetworkId(networkId) }); }
  async getSetup(networkId: string): Promise<CloudCoreSetup | null> { return this.view('getSetup', { networkId: normalizeCloudCoreNetworkId(networkId) }); }
  async getSetupPayload(networkId: string, requestId: bigint, kind: 'input' | 'result'): Promise<string | null> { if (!['input', 'result'].includes(kind)) throw new Error('Invalid setup payload kind'); return this.view('getSetupPayload', { networkId: normalizeCloudCoreNetworkId(networkId), requestId: positive(requestId), kind }); }
  async getLedger(): Promise<{ issued: bigint; burned: bigint; available: bigint; allocated: bigint }> { return this.view('getLedger'); }
  private async page<T>(method: string, args: Record<string, unknown>, after: string | null, limit: number): Promise<CloudCorePage<T>> { if (after !== null && (typeof after !== 'string' || after.length > 256) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid CloudCore page'); const row = object(await this.view(method, { ...args, after, limit: BigInt(limit) })); if (!Array.isArray(row.entries) || row.entries.length > limit || row.next !== null && typeof row.next !== 'string') throw new Error('Invalid CloudCore page result'); return row as unknown as CloudCorePage<T>; }
  listCustomers(after: string | null = null, limit = 50): Promise<CloudCorePage<CloudCoreCustomer>> { return this.page('listCustomers', {}, after, limit); }
  listProfiles(after: string | null = null, limit = 50): Promise<CloudCorePage<CloudCoreProfile>> { return this.page('listProfiles', {}, after, limit); }
  listPendingPayments(after: string | null = null, limit = 50): Promise<CloudCorePage<CloudCorePayment>> { return this.page('listPendingPayments', {}, after, limit); }
  listPendingNetworkApprovals(after: string | null = null, limit = 50): Promise<CloudCorePage<CloudCoreNetwork['terms']>> { return this.page('listPendingNetworkApprovals', {}, after, limit); }
  listPayments(customerKey: string, after: string | null = null, limit = 50): Promise<CloudCorePage<CloudCorePayment>> { return this.page('listPayments', { customerKey: normalizeCloudCoreDigest(customerKey) }, after, limit); }
  listNetworks(customerKey: string, after: string | null = null, limit = 50): Promise<CloudCorePage<string>> { return this.page('listNetworks', { customerKey: normalizeCloudCoreDigest(customerKey) }, after, limit); }
  listAllNetworks(after: string | null = null, limit = 50): Promise<CloudCorePage<string>> { return this.page('listAllNetworks', {}, after, limit); }
  listPending(after: string | null = null, limit = 50): Promise<CloudCorePage<CloudCoreJob>> { return this.page('listPending', {}, after, limit); }
  listPendingSetups(after: string | null = null, limit = 50): Promise<CloudCorePage<CloudCoreSetupJob>> { return this.page('listPendingSetups', {}, after, limit); }
}

export async function verifyConfirmedCloudCoreIntent(provider: Pick<RiadchainProvider, 'getChainId' | 'getTransaction' | 'getReceipt'>, expected: { chainId: string; contract: EthAddress; owner: EthAddress; txId: string; action: CloudCoreAction }): Promise<{ transaction: Transaction; receipt: TransactionReceipt }> {
  const [chainId, context, receipt] = await Promise.all([provider.getChainId(), provider.getTransaction(expected.txId), provider.getReceipt(expected.txId)]);
  const tx = context.transaction;
  assertSigningTransaction(tx, expected.owner, expected.chainId);
  if (chainId !== expected.chainId || tx.id !== expected.txId || receipt.txId !== expected.txId || tx.type !== 'CONTRACT' || tx.payload.action !== 'call' || tx.payload.contractAddress !== expected.contract || tx.payload.method !== expected.action.method || tx.outputs.some(output => output.address !== expected.owner) || tx.payload.token_spend || tx.payload.value && tx.payload.value !== '0' || typedHash('riadchain/cloud-intent/v1', decodeContractArguments(tx.payload.data)) !== typedHash('riadchain/cloud-intent/v1', cloudCoreActionArguments(expected.action)) || classifyTransactionOutcome(context, receipt).executionStatus !== 'succeeded') throw new Error('CloudCore original, intent or successful matching receipt differs');
  return { transaction: tx, receipt };
}
