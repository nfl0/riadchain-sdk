import type {
  AddressTransactionsResult,
  AddressTokenBalancesResult,
  AuditHistoryResult,
  Block,
  BlockHeader,
  BlockReceipt,
  ContractCallViewResult,
  ContractCallTreeEntry,
  ContractEvent,
  ContractEventQueryResult,
  ContractEventSubscriptionMessage,
  ContractEventSubscriptionOptions,
  ContractStateResult,
  DaemonVersionInfo,
  DeviceCapability,
  DeviceCapabilityQueryResult,
  EthAddress,
  FileByCidResult,
  FileHasContentResult,
  FileReferenceLookupResult,
  FileStatResult,
  FileStorageMetrics,
  ProtocolInfo,
  ProtocolParamsResult,
  ReadAnchor,
  LocalNodeStatus,
  LocalSyncState,
  NodeMetrics,
  OperatorHealth,
  NodeStatus,
  ProviderOptions,
  ScheduledContractCall,
  ScheduledContractCallQueryResult,
  StorageIntegrityResult,
  SyncHealth,
  TokenMetadata,
  Transaction,
  TransactionContext,
  TransactionReceipt,
  TransactionSimulationResult,
  UTXO,
  UtxoPage,
  WaitOptions,
} from './types.ts';
import { Code, ConnectError, createClient, type CallOptions, type Client, type Interceptor } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { isAccountAddress } from '../lib/crypto.ts';
import { requireProtocolVersion } from '../lib/canonicalChainEncoding.ts';
import { normalizeProtocolParamsShape } from '../lib/protocolParams.ts';
import { describeFileBytes } from '../lib/fileDescriptor.ts';
import { decodeContractValueFromRpc, encodeContractValueForRpc, type ContractValue } from '../lib/contractValueCodec.ts';
import {
  blockFromProto as codecBlockFromProto,
  encodeJsonBytes,
  decodeJsonBytes,
  txFromProto as codecTxFromProto,
  txToProto as codecTxToProto,
} from '../lib/protoCodec.ts';
import {
  AccountService,
  AuditService,
  ChainService,
  ContractService,
  ExplorerService,
  FileService,
  NodeService,
  StorageService,
  TokenService,
  TxService,
  type ScheduledCall as ProtoScheduledCall,
  type DeviceCapability as ProtoDeviceCapability,
  type Block as ProtoBlock,
  type BlockHeader as ProtoBlockHeader,
  type FileStorageMetricsResponse,
  type FileReferenceLookupResponse,
  type FileSyncHealthMetrics as ProtoFileSyncHealthMetrics,
  type GetLocalStatusResponse,
  type ProtocolInfo as ProtoProtocolInfo,
  type GetStatusResponse,
  type GetSyncHealthResponse,
  type NodeMetricsResponse,
  type Transaction as ProtoTransaction,
  type TxReceiptEvent as ProtoTxReceiptEvent,
  type ReadAnchor as ProtoReadAnchor,
} from '../lib/gen/proto/riadchain_pb.ts';

export const FILE_CONTENT_CHUNK_BYTES = 64 * 1024;

export interface FileContentChunk {
  cid: string;
  totalSize: number;
  offset: number;
  content: Uint8Array;
}

export interface FileDownloadOptions {
  /** Explicit ceiling before accepting or allocating file content. */
  maxBytes: number;
  /** Bind retrieval to the size recorded by the caller's FILE reference. */
  expectedSize?: number;
  signal?: AbortSignal;
}

function checkedFileDownloadOptions(options: FileDownloadOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0
    || (options.expectedSize !== undefined && (!Number.isSafeInteger(options.expectedSize)
      || options.expectedSize < 0 || options.expectedSize > options.maxBytes))) {
    throw new Error('Invalid FILE download size bound');
  }
  options.signal?.throwIfAborted();
}

function safeFileNumber(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} is outside the JavaScript safe-integer range`);
  }
  return Number(value);
}

async function boundedUploadResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const maximum = 16 * 1024;
  signal.throwIfAborted();
  if (Number(response.headers.get('content-length')) > maximum) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('FILE upload response exceeds the size limit');
  }
  const reader = response.body?.getReader?.();
  let cancel!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => { void reader?.cancel(signal.reason).catch(() => undefined); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    // Native Fetch may expose arrayBuffer() without a response body stream.
    if (!reader) {
      const bytes = new Uint8Array(await Promise.race([response.arrayBuffer(), stopped]));
      signal.throwIfAborted();
      if (bytes.byteLength > maximum) throw new Error('FILE upload response exceeds the size limit');
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => undefined);
        throw new Error('FILE upload response exceeds the size limit');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader?.releaseLock();
  }
}

/** @internal Shared Fetch bound around the maintained Connect unary transport. */
export function createFileUploadFetch(timeoutMs: number, fetcher?: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await (fetcher ?? globalThis.fetch)(input, { ...init, redirect: 'error' });
    if (!/\/riadchain\.v1\.FileService\/(StageFile|GetUploadStatus)$/.test(String(input))) return response;
    const bytes = await boundedUploadResponse(response, init?.signal ?? AbortSignal.timeout(timeoutMs));
    return new Response(bytes.buffer as ArrayBuffer, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

function getEnv(name: string): string | undefined {
  const candidate = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return candidate?.env?.[name];
}

function sortObject(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of keys) {
    sorted[key] = sortObject(source[key]);
  }
  return sorted;
}

function jsonBytes(value: unknown): Uint8Array {
  return encodeJsonBytes(value === undefined ? null : value, (v) => sortObject(v));
}

function txToProto(tx: Transaction): ProtoTransaction {
  return codecTxToProto(tx, jsonBytes);
}

function createAuthInterceptor(token: string | undefined, requestHeaders: Record<string, string> = {}): Interceptor[] {
  if (!token && Object.keys(requestHeaders).length === 0) return [];
  return [
    (next) => async (req) => {
      for (const [key, value] of Object.entries(requestHeaders)) {
        req.header.set(key, value);
      }
      if (token) req.header.set('Authorization', `Bearer ${token}`);
      return next(req);
    },
  ];
}

function createRequestHeaders(
  base: Record<string, string>,
  token: string | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers = { ...base, ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function shouldTraceNodeCalls(): boolean {
  return getEnv('RIADCHAIN_BUN_TRACE_RPC') === '1';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeNodeContractValue<T = ContractValue>(value: unknown): T {
  return decodeContractValueFromRpc<T>(value);
}

function decodeNodeContractJson<T = ContractValue>(bytes: Uint8Array): T {
  return decodeNodeContractValue<T>(decodeJsonBytes(bytes));
}

function fromProtoContractEvent(event: Omit<ProtoTxReceiptEvent, '$typeName'>): TransactionReceipt['events'][number] {
  return {
    contractAddress: event.contractAddress,
    txId: event.txId,
    eventName: event.eventName,
    data: decodeNodeContractJson(event.dataJson),
    blockIndex: Number(event.blockIndex),
    timestamp: Number(event.timestamp),
  };
}

function fromProtoFileReferences(result: FileReferenceLookupResponse): FileReferenceLookupResult {
  return {
    limit: result.limit,
    offset: result.offset,
    total: result.total,
    hasMore: result.hasMore,
    references: result.references.map(ref => ({
      cid: ref.cid,
      txId: ref.txId,
      address: ref.address ?? null,
      blockIndex: ref.blockIndex,
      timestamp: Number(ref.timestamp),
      filename: ref.filename ?? null,
      mimeType: ref.mimeType ?? null,
      size: Number(ref.size),
    })),
  };
}

function eventCursor(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(value)) throw new Error('Event cursor is malformed');
  return value;
}

function safeEventNumber(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Event ${field} is malformed`);
  return value as number;
}

function safeProtoNumber(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} is outside the JavaScript safe-integer range`);
  }
  return Number(value);
}

function parseSseFrame(rawFrame: string): ContractEventSubscriptionMessage | null {
  let eventType = 'message';
  const dataLines: string[] = [];
  for (const line of rawFrame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventType = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
  switch (eventType) {
    case 'ready': {
      const p = parsed as { contractAddress: string | null; eventName: string | null; fromBlock: number | null; cursor: unknown; tipCursor: unknown };
      return { kind: 'ready', contractAddress: p.contractAddress, eventName: p.eventName, fromBlock: p.fromBlock, cursor: eventCursor(p.cursor), tipCursor: eventCursor(p.tipCursor) };
    }
    case 'event': {
      const p = parsed as Omit<ContractEvent, 'data'> & { data: unknown };
      return {
        kind: 'event',
        event: {
          contractAddress: p.contractAddress,
          txId: p.txId,
          eventName: p.eventName,
          data: decodeNodeContractValue(p.data),
          blockIndex: safeEventNumber(p.blockIndex, 'block index'),
          timestamp: safeEventNumber(p.timestamp, 'timestamp'),
          blockHash: p.blockHash ?? null,
          txIndex: safeEventNumber(p.txIndex, 'transaction index'),
          eventIndex: safeEventNumber(p.eventIndex, 'event index'),
          cursor: eventCursor((p as typeof p & { cursor: unknown }).cursor),
        },
      };
    }
    case 'replay-complete': {
      const p = parsed as { count: unknown; cursor: unknown };
      return { kind: 'replay-complete', count: safeEventNumber(p.count, 'replay count'), cursor: eventCursor(p.cursor) };
    }
    case 'error':
      return { kind: 'error', message: String((parsed as { message: string }).message) };
    default:
      return null;
  }
}

function fromProtoScheduledCall(call: ProtoScheduledCall): ScheduledContractCall {
  return { scheduleId: call.scheduleId, caller: call.caller as EthAddress, creatorContract: (call.creatorContract as EthAddress) ?? null,
    contractAddress: call.contractAddress as EthAddress, method: call.method, data: decodeNodeContractJson(call.dataJson),
    executeAtHeight: safeProtoNumber(call.executeAtHeight, 'executeAtHeight'), scheduledAtHeight: safeProtoNumber(call.scheduledAtHeight, 'scheduledAtHeight'),
    gasLimit: safeProtoNumber(call.gasLimit, 'gasLimit'), codeHash: call.codeHash ?? null };
}

function fromProtoDeviceCapability(capability: ProtoDeviceCapability): DeviceCapability {
  return normalizeDeviceCapability({ capabilityId: capability.capabilityId, owner: capability.owner as EthAddress,
    delegate: capability.delegate as EthAddress, contractAddress: capability.contractAddress as EthAddress, methods: capability.methods,
    expiresAtHeight: capability.expiresAtHeight, maxGasPerCall: capability.maxGasPerCall, maxCallsPerBlock: capability.maxCallsPerBlock,
    delegateAsActor: capability.delegateAsActor, feeBalance: capability.feeBalance, storageRemainingBytes: capability.storageRemainingBytes,
    nextSequence: capability.nextSequence, lastUsedHeight: capability.lastUsedHeight ?? null, callsAtLastHeight: capability.callsAtLastHeight,
    revoked: capability.revoked });
}

function fromProtoTx(proto: ProtoTransaction): Transaction {
  return codecTxFromProto(proto);
}

function fromProtoBlock(block: ProtoBlock): Block {
  return codecBlockFromProto(block);
}

function fromProtoBlockHeader(header: ProtoBlockHeader): BlockHeader {
  return {
    protocolVersion: requireProtocolVersion(header.protocolVersion),
    index: safeProtoNumber(header.index, 'block header index'),
    chainId: header.chainId,
    hash: header.hash,
    previousHash: header.previousHash,
    stateHash: header.stateHash,
    timestamp: safeProtoNumber(header.timestamp, 'block header timestamp'),
    validatorAddress: header.validatorAddress as EthAddress,
    validatorPublicKey: header.validatorPublicKey ?? null,
    txCount: header.txCount,
    isSuccession: header.isSuccession,
  };
}

function fromProtocolInfo(info: ProtoProtocolInfo): ProtocolInfo {
  const protocolId = (version: number) => Number.isInteger(version) && version > 0 && version <= 0xffff_ffff;
  if (!protocolId(info.activeProtocolVersion) || !protocolId(info.nextBlockProtocolVersion)
    || !info.supportedProtocolVersions.length || info.supportedProtocolVersions.some(version => !protocolId(version))
    || new Set(info.supportedProtocolVersions).size !== info.supportedProtocolVersions.length
    || info.compatible !== info.supportedProtocolVersions.includes(info.nextBlockProtocolVersion)) {
    throw new Error('ProtocolInfo contains invalid protocol support information');
  }
  if (info.activations.length > 64) throw new Error('Protocol activation schedule exceeds 64 entries');
  let previousVersion = 1, previousHeight = 0;
  const activations = info.activations.map(activation => {
    const activationHeight = safeProtoNumber(activation.activationHeight, 'protocol activation height');
    if (!protocolId(activation.targetProtocolVersion) || activation.targetProtocolVersion <= previousVersion
      || activationHeight <= previousHeight) throw new Error('Invalid protocol activation schedule');
    previousVersion = activation.targetProtocolVersion;
    previousHeight = activationHeight;
    return { targetProtocolVersion: activation.targetProtocolVersion, activationHeight };
  });
  return { activeProtocolVersion: info.activeProtocolVersion,
    supportedProtocolVersions: [...info.supportedProtocolVersions],
    nextBlockProtocolVersion: info.nextBlockProtocolVersion, compatible: info.compatible, activations };
}

export function fromLocalStatus(local: GetLocalStatusResponse): LocalNodeStatus {
  if (!local.daemon || !local.archival || !local.protocolInfo || !local.blockProduction) {
    throw new Error('LocalStatus response missing required fields');
  }
  return {
    daemon: {
      daemonName: local.daemon.daemonName,
      daemonVersion: local.daemon.daemonVersion,
      packageName: local.daemon.packageName,
    },
    localAddress: local.localAddress as EthAddress,
    productionOwner: local.productionOwner as EthAddress,
    productionSignerAuthorized: local.productionSignerAuthorized,
    chainId: local.chainId,
    isValidator: local.isValidator,
    hasLocalStake: local.hasLocalStake,
    peerCount: local.peerCount,
    archival: {
      fileCount: safeProtoNumber(local.archival.fileCount, 'status FILE count'),
      availableFileCount: safeProtoNumber(local.archival.availableFileCount, 'status available FILE count'),
      missingFileCount: safeProtoNumber(local.archival.missingFileCount, 'status missing FILE count'),
      fileReferenceCount: safeProtoNumber(local.archival.fileReferenceCount, 'status FILE reference count'),
      stagedFileCount: safeProtoNumber(local.archival.stagedFileCount, 'status staged FILE count'),
      hydrationQueueDepth: safeProtoNumber(local.archival.hydrationQueueDepth, 'status hydration queue depth'),
      archivalDegraded: local.archival.archivalDegraded,
    },
    protocolInfo: fromProtocolInfo(local.protocolInfo),
    blockProduction: {
      canProduceNow: local.blockProduction.canProduceNow,
      role: local.blockProduction.role as LocalNodeStatus['blockProduction']['role'],
      summary: local.blockProduction.summary,
    },
  };
}

function fromProtoNodeStatus(result: GetStatusResponse): NodeStatus {
  if (!result.local) throw new Error('node_getStatus response missing local field');
  return {
    ...fromLocalStatus(result.local),
    latestBlockIndex: safeProtoNumber(result.latestBlockIndex, 'status height'),
    latestBlockHash: result.latestBlockHash ?? null,
    isMining: result.isMining,
    blockIntervalMs: safeProtoNumber(result.blockIntervalMs, 'status block interval'),
    nextBlockAt: result.nextBlockAt == null ? null : safeProtoNumber(result.nextBlockAt, 'status next block time'),
    msUntilNextBlock: result.msUntilNextBlock == null ? null : safeProtoNumber(result.msUntilNextBlock, 'status next block delay'),
    pendingTransactions: safeProtoNumber(result.pendingTransactions, 'status pending transactions'),
    currentValidator: (result.currentValidator ?? null) as EthAddress | null,
    successionTimeoutMs: safeProtoNumber(result.successionTimeoutMs, 'status succession timeout'),
    recoverable: result.recoverable,
    peers: result.peers,
    ready: result.ready,
    stateHash: result.stateHash,
    localTipFresh: result.localTipFresh,
    clockSane: result.clockSane,
    storageFault: result.storageFault ?? null,
    forkAlarm: result.forkAlarm,
  };
}

function fromProtoSyncHealth(result: GetSyncHealthResponse): SyncHealth {
  if (!result.archival) throw new Error('node_getSyncHealth response missing archival field');
  const tip = result.localTip;
  return {
    localHeight: safeProtoNumber(result.localHeight, 'sync local height'),
    localHash: result.localHash ?? null,
    peerCount: result.peerCount,
    reachablePeerCount: result.reachablePeerCount,
    bestPeerHeight: safeProtoNumber(result.bestPeerHeight, 'sync best peer height'),
    lag: safeProtoNumber(result.lag, 'sync lag'),
    syncing: result.syncing,
    caughtUp: result.caughtUp,
    peerComparisonAvailable: result.peerComparisonAvailable,
    forkAlarm: result.forkAlarm,
    localTip: tip ? {
      nowMs: safeProtoNumber(tip.nowMs, 'sync observation time'),
      tipTimestampMs: safeProtoNumber(tip.tipTimestampMs, 'sync tip timestamp'),
      tipObservedAtMs: safeProtoNumber(tip.tipObservedAtMs, 'sync tip observed time'),
      tipAgeMs: safeProtoNumber(tip.tipAgeMs, 'sync tip age'),
      freshnessWindowMs: safeProtoNumber(tip.freshnessWindowMs, 'sync freshness window'),
      clockSane: tip.clockSane, tipFresh: tip.tipFresh, forkAlarm: tip.forkAlarm, ready: tip.ready,
    } : null,
    archival: {
      missingFileCount: safeProtoNumber(result.archival.missingFileCount, 'sync missing files'),
      hydrationQueueDepth: safeProtoNumber(result.archival.hydrationQueueDepth, 'sync hydration queue'),
      archivalDegraded: result.archival.archivalDegraded,
    },
    peers: result.peers.map(peer => ({
      peer: peer.peer, reachable: peer.reachable,
      height: peer.height == null ? null : safeProtoNumber(peer.height, 'sync peer height'),
      error: peer.error ?? null,
      lastSuccessMs: peer.lastSuccessMs == null ? null : safeProtoNumber(peer.lastSuccessMs, 'sync peer last success'),
      lastErrorMs: peer.lastErrorMs == null ? null : safeProtoNumber(peer.lastErrorMs, 'sync peer last error'),
      caughtUpHint: peer.caughtUpHint ?? null,
      consecutiveFailures: peer.consecutiveFailures,
    })),
  };
}

function fromProtoFileStorageMetrics(result: FileStorageMetricsResponse): FileStorageMetrics {
  const packs = result.packs;
  const blocks = result.blocks;
  const bytes = result.bytes;
  if (!packs || !blocks || !bytes) {
    throw new Error('storage_getMetrics response missing metrics sections');
  }
  return {
    packs: {
      total: Number(packs.total),
      active: Number(packs.active),
      sealed: Number(packs.sealed),
      compacting: Number(packs.compacting),
      obsolete: Number(packs.obsolete),
    },
    blocks: {
      total: Number(blocks.total),
      referenced: Number(blocks.referenced),
      reclaimable: Number(blocks.reclaimable),
    },
    bytes: {
      total: Number(bytes.total),
      live: Number(bytes.live),
      reclaimable: Number(bytes.reclaimable),
    },
    fileObjects: safeProtoNumber(result.fileObjects, 'storage file objects'),
    stagedObjects: safeProtoNumber(result.stagedObjects, 'storage staged objects'),
    stagedBytes: safeProtoNumber(result.stagedBytes, 'storage staged bytes'),
    missingFiles: safeProtoNumber(result.missingFiles, 'storage missing files'),
    fileReferenceCount: safeProtoNumber(result.fileReferenceCount, 'storage file reference count'),
  };
}

function fromProtoFileSyncHealth(result: ProtoFileSyncHealthMetrics) {
  return {
    fileCount: Number(result.fileCount),
    availableFileCount: Number(result.availableFileCount),
    missingFileCount: Number(result.missingFileCount),
    availableBytes: Number(result.availableBytes),
    missingBytes: Number(result.missingBytes),
    fileReferenceCount: Number(result.fileReferenceCount),
    hydrationQueueDepth: Number(result.hydrationQueueDepth),
    archivalDegraded: result.archivalDegraded,
  };
}

function fromProtoNodeMetrics(result: NodeMetricsResponse): NodeMetrics {
  const processMetrics = result.process;
  const memory = processMetrics?.memory;
  const counters = result.counters;
  const chain = result.chain;
  const storage = result.storage;
  const fileSync = storage?.fileSync;
  if (!processMetrics || !memory || !counters || !chain || !storage || !fileSync) {
    throw new Error('node_getMetrics response missing required metrics sections');
  }
  return {
    startedAt: Number(result.startedAt),
    uptimeMs: Number(result.uptimeMs),
    process: {
      pid: processMetrics.pid,
      uptimeSeconds: Number(processMetrics.uptimeSeconds),
      memory: {
        rss: Number(memory.rss),
      },
    },
    counters: {
      blocksAccepted: Number(counters.blocksAccepted),
    },
    chain: {
      latestBlock: chain.latestBlock ? fromProtoBlockHeader(chain.latestBlock) : null,
      pendingTransactions: Number(chain.pendingTransactions),
    },
    storage: {
      fileSync: fromProtoFileSyncHealth(fileSync),
    },
  };
}

function defaultNodeTimeoutMs(): number {
  return Math.max(1_000, Number(getEnv('RIADCHAIN_BUN_RPC_TIMEOUT_MS') ?? 10_000));
}

type DeviceCapabilityWire = Omit<DeviceCapability,
  | 'expiresAtHeight'
  | 'maxGasPerCall'
  | 'maxCallsPerBlock'
  | 'feeBalance'
  | 'storageRemainingBytes'
  | 'nextSequence'
  | 'lastUsedHeight'
  | 'callsAtLastHeight'
> & {
  expiresAtHeight: number | string | bigint;
  maxGasPerCall: number | string | bigint;
  maxCallsPerBlock: number | string | bigint;
  feeBalance: number | string | bigint;
  storageRemainingBytes: number | string | bigint;
  nextSequence: number | string | bigint;
  lastUsedHeight: number | string | bigint | null;
  callsAtLastHeight: number | string | bigint;
};

export function normalizeDeviceCapability(capability: DeviceCapabilityWire): DeviceCapability {
  const safeNumber = (value: unknown, field: string): number => {
    const parsed = typeof value === 'bigint'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? BigInt(value)
        : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
          ? BigInt(value)
          : null;
    if (parsed === null || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Device capability ${field} is outside the JavaScript safe-integer range`);
    }
    return Number(parsed);
  };
  return {
    ...capability,
    expiresAtHeight: safeNumber(capability.expiresAtHeight, 'expiresAtHeight'),
    maxGasPerCall: safeNumber(capability.maxGasPerCall, 'maxGasPerCall'),
    maxCallsPerBlock: safeNumber(capability.maxCallsPerBlock, 'maxCallsPerBlock'),
    delegateAsActor: Boolean(capability.delegateAsActor),
    feeBalance: BigInt(capability.feeBalance ?? 0),
    storageRemainingBytes: safeNumber(capability.storageRemainingBytes ?? 0, 'storageRemainingBytes'),
    nextSequence: safeNumber(capability.nextSequence, 'nextSequence'),
    lastUsedHeight: capability.lastUsedHeight === null
      ? null
      : safeNumber(capability.lastUsedHeight, 'lastUsedHeight'),
    callsAtLastHeight: safeNumber(capability.callsAtLastHeight, 'callsAtLastHeight'),
  };
}


export class RiadchainNodeError extends Error {
  code: number;
  data?: Record<string, unknown>;

  constructor(message: string, code: number, data?: Record<string, unknown>) {
    super(message);
    this.name = 'RiadchainNodeError';
    this.code = code;
    this.data = data;
  }
}

function readAnchorFromProto(anchor: ProtoReadAnchor): ReadAnchor {
  if (!anchor.chainId || anchor.chainId.length > 256
    || ![anchor.genesisHash, anchor.blockHash].every(hash => /^[0-9a-f]{64}$/.test(hash))
    || !/^(?:00|(?:02|03)[0-9a-f]{64})$/.test(anchor.stateHash)
    || !Number.isSafeInteger(anchor.protocolVersion) || anchor.protocolVersion < 1) {
    throw new Error('Node returned an invalid read anchor');
  }
  return {
    chainId: anchor.chainId,
    genesisHash: anchor.genesisHash,
    blockIndex: safeProtoNumber(anchor.blockIndex, 'read anchor block index'),
    blockHash: anchor.blockHash,
    stateHash: anchor.stateHash,
    protocolVersion: anchor.protocolVersion,
    timestampMs: safeProtoNumber(anchor.timestampMs, 'read anchor timestamp'),
  };
}

/** Restricted immutable read client. It has no signing, submission or simulation methods. */
export class ContractReadSession {
  readonly anchor: Readonly<ReadAnchor>;
  private closed = false;
  private active = false;

  constructor(
    private readonly provider: RiadchainProvider,
    readonly id: string,
    anchor: ReadAnchor,
    readonly expiresAtUnixMs: number,
  ) { this.anchor = Object.freeze({ ...anchor }); }

  private async read<T extends { readAnchor?: ReadAnchor }>(operation: () => Promise<T>): Promise<T & { readAnchor: ReadAnchor }> {
    if (this.closed) throw new Error('Read session is closed');
    if (this.active) throw new Error('A read is already active for this session');
    this.active = true;
    try {
      const result = await operation();
      if (!result.readAnchor || (Object.keys(this.anchor) as Array<keyof ReadAnchor>)
        .some(key => result.readAnchor![key] !== this.anchor[key])) {
        throw new Error('Read session anchor changed or is missing; discard partial results');
      }
      return result as T & { readAnchor: ReadAnchor };
    } finally { this.active = false; }
  }

  getContractState(address: EthAddress, options: { storageCursor?: string | null; storageLimit?: number } = {}): Promise<ContractStateResult & { readAnchor: ReadAnchor }> {
    return this.read(() => this.provider.getContractState(address, { ...options, readSessionId: this.id }));
  }

  callView<T = ContractValue>(contract: EthAddress, method: string, args: unknown = {}): Promise<ContractCallViewResult<T> & { readAnchor: ReadAnchor }> {
    return this.read(() => this.provider.callView<T>(contract, method, args, { readSessionId: this.id }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.provider.closeReadSession(this.id);
  }
}

export class RiadchainProvider {
  private readonly accountClient: Client<typeof AccountService>;
  private readonly auditClient: Client<typeof AuditService>;
  private readonly nodeClient: Client<typeof NodeService>;
  private readonly chainClient: Client<typeof ChainService>;
  private readonly explorerClient: Client<typeof ExplorerService>;
  private readonly txClient: Client<typeof TxService>;
  private readonly contractClient: Client<typeof ContractService>;
  private readonly tokenClient: Client<typeof TokenService>;
  private readonly fileClient: Client<typeof FileService>;
  private readonly storageClient: Client<typeof StorageService>;
  readonly nodeTimeoutMs: number;
  readonly nodeUrl: string;
  readonly nodeToken?: string;
  private readonly requestHeaders: Record<string, string>;

  constructor(
    nodeUrl: string,
    nodeToken?: string,
    options: ProviderOptions = {},
  ) {
    if (typeof nodeUrl !== 'string' || nodeUrl.length === 0) {
      throw new Error(`RiadchainProvider requires a valid nodeUrl string, received: ${String(nodeUrl)}`);
    }
    this.nodeUrl = nodeUrl.replace(/\/+$/, '');
    this.nodeToken = nodeToken;
    this.requestHeaders = { ...(options.requestHeaders ?? {}) };
    this.nodeTimeoutMs = Math.max(1_000, options.nodeTimeoutMs ?? defaultNodeTimeoutMs());
    const transport = options.transport ?? createConnectTransport({
      baseUrl: this.nodeUrl,
      interceptors: createAuthInterceptor(nodeToken, this.requestHeaders),
      defaultTimeoutMs: this.nodeTimeoutMs,
      useBinaryFormat: true,
      fetch: createFileUploadFetch(this.nodeTimeoutMs),
    });
    this.accountClient = createClient(AccountService, transport);
    this.nodeClient = createClient(NodeService, transport);
    this.auditClient = createClient(AuditService, transport);
    this.chainClient = createClient(ChainService, transport);
    this.explorerClient = createClient(ExplorerService, transport);
    this.txClient = createClient(TxService, transport);
    this.contractClient = createClient(ContractService, transport);
    this.tokenClient = createClient(TokenService, transport);
    this.fileClient = createClient(FileService, transport);
    this.storageClient = createClient(StorageService, transport);
  }

  private async traced<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const trace = shouldTraceNodeCalls();
    const started = Date.now();
    if (trace) {
      console.error(JSON.stringify({ phase: 'node:start', nodeUrl: this.nodeUrl, method, startedAt: started }));
    }
    try {
      const result = await fn();
      if (trace) {
        console.error(JSON.stringify({
          phase: 'node:done',
          nodeUrl: this.nodeUrl,
          method,
          elapsedMs: Date.now() - started,
        }));
      }
      return result;
    } catch (error) {
      if (trace) {
        console.error(JSON.stringify({
          phase: 'node:error',
          nodeUrl: this.nodeUrl,
          method,
          elapsedMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      if (error instanceof ConnectError) {
        throw new RiadchainNodeError(error.rawMessage, error.code, {
          connectCode: error.code,
        });
      }
      throw error;
    }
  }


  async getLocalStatus(): Promise<LocalNodeStatus> {
    return this.traced('node_getLocalStatus', async () => {
      const result = await this.nodeClient.getLocalStatus({});
      return fromLocalStatus(result);
    });
  }

  async getChainId(): Promise<string> {
    return (await this.getLocalStatus()).chainId;
  }

  async getStatus(): Promise<NodeStatus> {
    return this.traced('node_getStatus', async () => {
      return fromProtoNodeStatus(await this.nodeClient.getStatus({}));
    });
  }

  async getMetrics(): Promise<NodeMetrics> {
    return this.traced('node_getMetrics', async () => {
      return fromProtoNodeMetrics(await this.nodeClient.getMetrics({}));
    });
  }

  async getOperatorHealth(): Promise<OperatorHealth> {
    return this.traced('node_getOperatorHealth', async () => {
      const result = await this.nodeClient.getOperatorHealth({});
      const status = result.status;
      const sync = result.sync;
      const canonical = result.canonicalStorage;
      const derived = result.derivedStorage;
      const fileArchive = result.fileArchive;
      if (!status?.local || !sync?.archival || !canonical || !derived || !fileArchive) {
        throw new Error('node_getOperatorHealth response missing required sections');
      }
      const nodeStatus = fromProtoNodeStatus(status);
      const syncHealth = fromProtoSyncHealth(sync);
      return {
        observedAtUnixMs: safeProtoNumber(result.observedAtUnixMs, 'operator observation time'),
        status: nodeStatus,
        sync: syncHealth,
        ready: result.ready,
        localTipFresh: result.localTipFresh,
        clockSane: result.clockSane,
        forkAlarm: result.forkAlarm,
        equivocationEvidenceCount: safeProtoNumber(result.equivocationEvidenceCount, 'operator equivocation evidence count'),
        persistent: result.persistent,
        canonicalStorage: {
          healthy: canonical.healthy,
          storedBlocks: safeProtoNumber(canonical.storedBlocks, 'operator stored blocks'),
          canonicalLogBytes: safeProtoNumber(canonical.canonicalLogBytes, 'operator canonical log bytes'),
          tipHeight: safeProtoNumber(canonical.tipHeight, 'operator tip height'),
          tipHash: canonical.tipHash,
          stateHash: canonical.stateHash,
        },
        derivedStorage: {
          storedReceipts: safeProtoNumber(derived.storedReceipts, 'operator stored receipts'),
          receiptCacheHealthy: derived.receiptCacheHealthy,
          derivedBlockReceipts: safeProtoNumber(derived.derivedBlockReceipts, 'operator derived receipts'),
          checkpointCount: safeProtoNumber(derived.checkpointCount, 'operator checkpoint count'),
          latestCheckpointHeight: derived.latestCheckpointHeight == null ? null : safeProtoNumber(derived.latestCheckpointHeight, 'operator latest checkpoint height'),
          loadedCheckpointHeight: derived.loadedCheckpointHeight == null ? null : safeProtoNumber(derived.loadedCheckpointHeight, 'operator loaded checkpoint height'),
          checkpointHealthy: derived.checkpointHealthy,
        },
        fileArchive: {
          storedObjects: safeProtoNumber(fileArchive.storedObjects, 'operator stored FILE objects'),
          storedBytes: safeProtoNumber(fileArchive.storedBytes, 'operator stored FILE bytes'),
          committedFiles: safeProtoNumber(fileArchive.committedFiles, 'operator committed FILE records'),
          availableFiles: safeProtoNumber(fileArchive.availableFiles, 'operator available FILE records'),
          missingFiles: safeProtoNumber(fileArchive.missingFiles, 'operator missing FILE records'),
          availableBytes: safeProtoNumber(fileArchive.availableBytes, 'operator available FILE bytes'),
          missingBytes: safeProtoNumber(fileArchive.missingBytes, 'operator missing FILE bytes'),
          fileReferences: safeProtoNumber(fileArchive.fileReferences, 'operator FILE references'),
          hydrationQueueDepth: safeProtoNumber(fileArchive.hydrationQueueDepth, 'operator FILE hydration queue'),
          degraded: fileArchive.degraded,
        },
      };
    });
  }

  async getAuditHistory(params: {
    cursor?: string;
    limit?: number;
    identityRegistryAddress?: EthAddress;
  } = {}): Promise<AuditHistoryResult> {
    return this.traced('audit_listHistory', async () => {
      const limit = params.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('Audit history limit must be an integer from 1 to 50');
      }
      const result = await this.auditClient.listHistory({
        cursor: params.cursor ?? '',
        limit,
        ...(params.identityRegistryAddress
          ? { identityRegistryAddress: params.identityRegistryAddress }
          : {}),
      });
      return {
        entries: result.entries.map((entry) => ({
          cursor: entry.cursor,
          blockIndex: safeProtoNumber(entry.blockIndex, 'audit block index'),
          itemIndex: entry.itemIndex,
          txIndex: entry.txIndex ?? null,
          transactionId: entry.transactionId,
          canonicalTransaction: entry.canonicalTransaction,
          timestampMs: safeProtoNumber(entry.timestampMs, 'audit timestamp'),
          kind: entry.kind,
          summary: entry.summary,
          actor: (entry.actor ?? null) as EthAddress | null,
          actorLabel: entry.actorLabel ?? null,
          target: (entry.target ?? null) as EthAddress | null,
          targetLabel: entry.targetLabel ?? null,
          amountSatoshis: entry.amountSatoshis == null ? null : BigInt(entry.amountSatoshis),
          status: entry.status as 'succeeded' | 'failed',
          contractAddress: (entry.contractAddress ?? null) as EthAddress | null,
          method: entry.method ?? null,
          fileCid: entry.fileCid ?? null,
          scheduleId: entry.scheduleId ?? null,
          events: entry.events.map((event) => ({
            contractAddress: event.contractAddress as EthAddress,
            name: event.name,
          })),
        })),
        nextCursor: result.nextCursor ?? null,
        hasMore: result.hasMore,
        canonicalComplete: result.canonicalComplete,
      };
    });
  }

  async getSyncHealth(): Promise<SyncHealth> {
    return this.traced('node_getSyncHealth', async () => {
      return fromProtoSyncHealth(await this.nodeClient.getSyncHealth({}));
    });
  }

  async getLocalSyncState(): Promise<LocalSyncState> {
    return this.traced('node_getLocalSyncState', async () => {
      const result = await this.nodeClient.getLocalSyncState({});
      const archival = result.archival;
      if (!archival) {
        throw new Error('node_getLocalSyncState response missing archival field');
      }
      return {
        localHeight: Number(result.localHeight),
        localHash: result.localHash ?? null,
        archival: {
          missingFileCount: Number(archival.missingFileCount),
          hydrationQueueDepth: Number(archival.hydrationQueueDepth),
          archivalDegraded: archival.archivalDegraded,
        },
      };
    });
  }

  async getVersion(): Promise<DaemonVersionInfo> {
    return this.traced('node_getVersion', async () => {
      const result = await this.nodeClient.getVersion({});
      return {
        daemonName: result.daemonName,
        daemonVersion: result.daemonVersion,
        packageName: result.packageName,
      };
    });
  }

  async getBlockByHeight(height: number): Promise<Block> {
    return this.traced('chain_getBlockByHeight', async () => {
      const result = await this.chainClient.getBlockByHeight({ height: BigInt(height) });
      return fromProtoBlock(result);
    });
  }

  async getBlockByHash(hash: string): Promise<Block> {
    return this.traced('chain_getBlockByHash', async () => {
      const result = await this.chainClient.getBlockByHash({ hash });
      return fromProtoBlock(result);
    });
  }

  async getTip(): Promise<{ latestBlock: BlockHeader | null }> {
    const headers = await this.getBlockHeaders(1, 0, 'desc');
    return { latestBlock: headers[0] ?? null };
  }

  async getBlockHeaders(limit = 1, offset = 0, order: 'asc' | 'desc' = 'desc'): Promise<BlockHeader[]> {
    return this.traced('chain_getBlockHeaders', async () => {
      const result = await this.chainClient.getBlockHeaders({ limit, offset, order });
      return result.headers.map(fromProtoBlockHeader);
    });
  }

  async getBlockHeaderByHeight(height: number): Promise<BlockHeader | null> {
    const headers = await this.getBlockHeaders(1, height, 'asc');
    return headers[0] ?? null;
  }

  async getLatestHeight(): Promise<number> {
    const headers = await this.getBlockHeaders(1, 0, 'desc');
    return headers[0]?.index ?? -1;
  }

  async getBalance(address: EthAddress): Promise<bigint> {
    return (await this.getBalanceSummary(address)).balance;
  }

  async getValidatorRewardBalance(address: EthAddress): Promise<bigint> {
    return (await this.getBalanceSummary(address)).rewardBalance;
  }

  async getBalanceSummary(address: EthAddress): Promise<{ balance: bigint; rewardBalance: bigint }> {
    return this.traced('chain_getBalanceSummary', async () => {
      const result = await this.chainClient.getBalance({ address });
      return {
        balance: BigInt(result.balance),
        rewardBalance: BigInt(result.rewardBalance || '0'),
      };
    });
  }

  async getUtxosPage(address: EthAddress, params: { pageToken?: string; limit?: number } = {}, options?: CallOptions): Promise<UtxoPage> {
    const limit = params.limit ?? 256;
    const pageToken = params.pageToken ?? '';
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || pageToken.length > 4096) throw new Error('Invalid UTXO page');
    const page = await this.chainClient.getUtxos({ address, pageToken, pageSize: limit }, options);
    if (page.utxos.length > limit || page.nextPageToken.length > 4096 || (page.nextPageToken && (page.nextPageToken === pageToken || page.utxos.length === 0))) throw new Error('Invalid UTXO continuation');
    const keys = new Set<string>();
    const utxos = page.utxos.map(entry => {
      const key = `${entry.txId}:${entry.outputIndex}`;
      if (!/^[0-9a-f]{64}$/.test(entry.txId) || entry.address.toLowerCase() !== address.toLowerCase() || !/^[1-9][0-9]*$/.test(entry.amount) || keys.has(key)) throw new Error('Invalid spendable output');
      keys.add(key);
      return { txId: entry.txId, outputIndex: entry.outputIndex, address: entry.address as EthAddress, amount: BigInt(entry.amount) };
    });
    return { utxos, nextPageToken: page.nextPageToken };
  }

  async getAddressTokens(address: EthAddress, params: { limit?: number; offset?: number } = {}, options?: CallOptions): Promise<AddressTokenBalancesResult> {
    const limit = params.limit ?? 20; const offset = params.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid token page');
    const page = await this.explorerClient.listAddressTokens({ address, limit, offset: BigInt(offset) }, options);
    if (page.address.toLowerCase() !== address.toLowerCase() || page.tokenBalances.length > limit || page.offset !== BigInt(offset) || page.total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid address token page');
    const total = Number(page.total);
    if (offset < total && page.tokenBalances.length === 0) throw new Error('Node returned an empty token continuation');
    return { address: page.address as EthAddress, tokenBalances: page.tokenBalances.map(token => ({ tokenId: token.tokenId, name: token.name, symbol: token.symbol, type: token.type, balance: token.balance, uri: token.uri ?? null })), limit, offset, total, hasMore: offset + page.tokenBalances.length < total };
  }

  async getUtxos(address: EthAddress): Promise<UTXO[]> {
    return this.traced('chain_getUtxos', async () => {
      const utxos = new Map<string, { txId: string; outputIndex: number; amount: string; address: string }>();
      let pageToken = '';
      do {
        const page = await this.chainClient.getUtxos({ address, pageToken, pageSize: 1000 });
        for (const utxo of page.utxos) {
          utxos.set(`${utxo.txId}:${utxo.outputIndex}`, {
            txId: utxo.txId,
            outputIndex: utxo.outputIndex,
            amount: utxo.amount,
            address: utxo.address,
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return [...utxos.values()].map((utxo) => ({
        txId: utxo.txId,
        outputIndex: utxo.outputIndex,
        address: utxo.address as EthAddress,
        amount: BigInt(utxo.amount),
      }));
    });
  }

  async getTransactionsByAddress(address: EthAddress, params: { limit?: number; offset?: number } = {}): Promise<AddressTransactionsResult> {
    return this.traced('chain_getTransactionsByAddress', async () => {
      const result = await this.chainClient.getTransactionsByAddress({
        address,
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
      });
      return {
        address: result.address as EthAddress,
        transactions: result.transactions.map((entry) => {
          if (!entry.transaction) {
            throw new Error('Address transaction entry missing transaction field');
          }
          return {
            transaction: fromProtoTx(entry.transaction),
            blockIndex: entry.blockIndex != null ? Number(entry.blockIndex) : null,
            blockHash: entry.blockHash ?? null,
            status: entry.status as 'pending' | 'confirmed',
            involvement: entry.involvement as 'input' | 'output' | 'both',
          };
        }),
        limit: result.limit,
        offset: result.offset,
        total: result.total,
        hasMore: result.hasMore,
      };
    });
  }

  async getTransaction(txId: string): Promise<TransactionContext> {
    return this.traced('tx_getById', async () => {
      const result = await this.txClient.getById({ txId });
      if (!result.transaction) {
        throw new Error('tx_getById response missing transaction field');
      }
      if (result.transaction.id !== txId) throw new Error('Node returned a different transaction');
      return {
        transaction: fromProtoTx(result.transaction),
        blockIndex: result.blockIndex != null ? Number(result.blockIndex) : null,
        blockHash: result.blockHash ?? null,
        status: result.status as 'pending' | 'confirmed',
      };
    });
  }

  async getReceipt(txId: string): Promise<TransactionReceipt> {
    return this.traced('tx_getReceipt', async () => {
      const receipt = await this.txClient.getReceipt({ txId });
      if (receipt.txId !== txId) throw new Error('Node returned a receipt for a different transaction');
      if (!['succeeded', 'failed'].includes(receipt.executionStatus)
        || receipt.success !== (receipt.executionStatus === 'succeeded')) {
        throw new Error('Node returned an inconsistent execution receipt');
      }
      return {
        txId: receipt.txId,
        blockIndex: Number(receipt.blockIndex),
        blockHash: receipt.blockHash ?? null,
        success: receipt.success,
        executionStatus: receipt.executionStatus as 'succeeded' | 'failed',
        gasUsed: receipt.gasUsed,
        feeCharged: receipt.feeCharged,
        gasRefund: receipt.gasRefund,
        eventCount: receipt.eventCount,
        error: receipt.error ?? null,
        events: receipt.events.map(fromProtoContractEvent),
        callTree: receipt.callTree.map((call) => ({
          callIndex: call.callIndex,
          parentCallIndex: call.parentCallIndex,
          depth: call.depth,
          caller: call.caller as EthAddress,
          callee: call.callee as EthAddress,
          method: call.method || null,
          valueSatoshis: call.valueSatoshis,
          succeeded: call.succeeded,
          ...(call.error == null ? {} : { error: call.error }),
          gasUsed: call.gasUsed,
        })),
      };
    });
  }

  async getBlockReceipts(height: number): Promise<{ blockIndex: number; receipts: BlockReceipt[] }> {
    return this.traced('chain_getBlockReceipts', async () => {
      const result = await this.chainClient.getBlockReceipts({ height: BigInt(height) });
      return {
        blockIndex: Number(result.blockIndex),
        receipts: result.receipts.map((r) => ({
          txId: r.txId,
          blockIndex: Number(r.blockIndex),
          success: r.success,
          executionStatus: r.executionStatus as 'succeeded' | 'failed',
          gasUsed: r.gasUsed,
          feeCharged: r.feeCharged,
          gasRefund: r.gasRefund,
          eventCount: r.eventCount,
          error: r.error ?? null,
        })),
      };
    });
  }

  async sendTransaction(tx: Transaction): Promise<{ message: string; tx: Transaction }> {
    return this.traced('tx_send', async () => {
      const result = await this.txClient.send({ tx: txToProto(tx) });
      if (!result.tx) {
        throw new Error('tx_send response missing tx field');
      }
      if (result.tx.id !== tx.id) throw new Error('Node acknowledged a different transaction');
      return { message: result.message, tx: fromProtoTx(result.tx) };
    });
  }

  async sendTransactionBatch(txs: Transaction[]): Promise<{
    rejected: Array<{ txId: string | null; error: string; code?: string }>;
    acceptedCount: number;
    rejectedCount: number;
  }> {
    return this.traced('tx_sendBatch', async () => {
      const result = await this.txClient.sendBatch({ txs: txs.map(txToProto) });
      return {
        rejected: result.rejected.map((entry) => ({
          txId: entry.txId ?? null,
          error: entry.error,
          ...(entry.code !== undefined ? { code: entry.code } : {}),
        })),
        acceptedCount: result.acceptedCount,
        rejectedCount: result.rejectedCount,
      };
    });
  }

  async getPendingTransactions(): Promise<Transaction[]> {
    return this.traced('tx_getPending', async () => {
      const result = await this.txClient.getPending({});
      return result.transactions.map(fromProtoTx);
    });
  }

  async getPendingTransactionIds(): Promise<{ txIds: string[] }> {
    return this.traced('tx_getPendingIds', async () => {
      const response = await this.txClient.getPendingIds({});
      return { txIds: response.txIds };
    });
  }

  async getPendingTransactionsByIds(txIds: string[]): Promise<{ txs: Transaction[] }> {
    return this.traced('tx_getPendingByIds', async () => {
      const result = await this.txClient.getPendingByIds({ txIds });
      return { txs: result.transactions.map(fromProtoTx) };
    });
  }

  async getUploadStatus(txId: string): Promise<{
    txId: string;
    cid: string;
    expectedSize: number;
    uploadedBytes: number;
    fileStaged: boolean;
    complete: boolean;
  }> {
    return this.traced('file_getUploadStatus', async () => {
      const result = await this.fileClient.getUploadStatus({ txId });
      return {
        txId: result.txId,
        cid: result.cid,
        expectedSize: Number(result.expectedSize),
        uploadedBytes: Number(result.uploadedBytes),
        fileStaged: result.fileStaged,
        complete: result.complete,
      };
    });
  }

  async uploadFileBytes(txId: string, bytes: Uint8Array): Promise<{ status: string; cid?: string; txId?: string; size?: number }> {
    return this.traced('file_stageFile', async () => {
      if (!/^[0-9a-f]{64}$/.test(txId) || !(bytes instanceof Uint8Array)) throw new Error('Invalid FILE upload identity or bytes');
      const expected = await describeFileBytes(bytes);
      const checkedStatus = async () => {
        const status = await this.getUploadStatus(txId);
        if (status.txId !== txId || status.cid !== expected.cid || status.expectedSize !== bytes.byteLength
          || !Number.isSafeInteger(status.uploadedBytes) || status.uploadedBytes < 0 || status.uploadedBytes > bytes.byteLength
          || status.complete !== status.fileStaged || status.complete && status.uploadedBytes !== bytes.byteLength) {
          throw new Error('FILE upload status does not match the original transaction, CID, size or offset');
        }
        return status;
      };
      const completed = (status: string) => ({ status, txId, cid: expected.cid, size: bytes.byteLength });
      let status = await checkedStatus();
      if (status.complete) return completed('already_present');
      const chunkBytes = 1024 * 1024;
      let failures = 0;
      for (;;) {
        // Full bytes still need CID verification/adoption. An empty append at
        // that exact offset finishes the same original spool after interruption.
        const offset = status.uploadedBytes;
        const end = Math.min(bytes.byteLength, offset + chunkBytes);
        let result;
        try {
          result = await this.fileClient.stageFile({ txId, offset: BigInt(offset), content: bytes.subarray(offset, end) });
        } catch (error) {
          const retryable = error instanceof ConnectError && (
            [Code.Unavailable, Code.DeadlineExceeded, Code.Unknown, Code.ResourceExhausted].includes(error.code)
            || error.rawMessage.includes('HTTP 429')
          );
          if (!retryable) throw error;
          // A timeout may follow an accepted chunk. Reconcile this same FILE ID
          // before sending any more bytes; never rebuild or rebroadcast its tx.
          status = await checkedStatus();
          if (status.complete) return completed('already_present');
          if (++failures >= 5) throw error;
          await wait(Math.min(2_000, failures * 250));
          continue;
        }
        const uploaded = safeFileNumber(result.uploadedBytes, 'FILE uploaded bytes');
        if (result.txId !== txId || result.cid !== expected.cid || result.size !== BigInt(bytes.byteLength)
          || uploaded > bytes.byteLength || uploaded < end
          || result.complete && (!['staged', 'stored', 'already_present'].includes(result.status) || uploaded !== bytes.byteLength)
          || !result.complete && (result.status !== 'uploading' || uploaded !== end || uploaded === bytes.byteLength)) {
          throw new Error('FILE upload response does not match the original transaction, CID, size or offset');
        }
        if (result.complete) return completed(result.status);
        status = { ...status, uploadedBytes: uploaded };
      }
    });
  }

  uploadFileText(txId: string, content: string): Promise<{ status: string; cid?: string; txId?: string; size?: number }> {
    return this.uploadFileBytes(txId, new TextEncoder().encode(content));
  }

  async fileGetByCid(cid: string): Promise<FileByCidResult> {
    return this.traced('file_getByCid', async () => {
      const result = await this.fileClient.getByCid({ cid });
      if (!result.file) {
        return { file: null };
      }
      return {
        file: {
          ...result.file,
          size: Number(result.file.size),
          firstSeenBy: result.file.firstSeenBy ?? null,
          firstFilename: result.file.firstFilename ?? null,
          latestFilename: result.file.latestFilename ?? null,
          mimeType: result.file.mimeType ?? null,
          contentStatus: result.file.contentStatus as 'available' | 'missing',
          lastHydrationAttemptAt: result.file.lastHydrationAttemptAt ? Number(result.file.lastHydrationAttemptAt) : null,
          lastHydrationSuccessAt: result.file.lastHydrationSuccessAt ? Number(result.file.lastHydrationSuccessAt) : null,
          hydrationPriority: result.file.hydrationPriority as 'high' | 'medium' | 'low' | 'manual',
          nextHydrationAttemptAt: result.file.nextHydrationAttemptAt ? Number(result.file.nextHydrationAttemptAt) : null,
          attestedBy: result.file.attestedBy ?? null,
          attestedAtBlockIndex: result.file.attestedAtBlockIndex ?? null,
          attestedSourcePeer: result.file.attestedSourcePeer ?? null,
          verifiedAtAcceptTime: result.file.verifiedAtAcceptTime ? Number(result.file.verifiedAtAcceptTime) : null,
          lastHydrationSource: result.file.lastHydrationSource ?? null,
        }
      };
    });
  }

  async fileCatText(cid: string): Promise<{ cid: string; content: string }> {
    return this.traced('file_catText', async () => {
      const result = await this.fileClient.catText({ cid });
      return { cid: result.cid, content: result.content ?? '' };
    });
  }

  async fileReadContentChunk(
    cid: string,
    offset: number,
    length = FILE_CONTENT_CHUNK_BYTES,
    options: { signal?: AbortSignal } = {},
  ): Promise<FileContentChunk> {
    if (!cid || cid.length > 256 || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(length) || length < 1 || length > FILE_CONTENT_CHUNK_BYTES) {
      throw new Error('Invalid FILE chunk request');
    }
    options.signal?.throwIfAborted();
    return this.traced('file_readContentChunk', async () => {
      const result = await this.fileClient.readContentChunk({ cid, offset: BigInt(offset), length }, options);
      options.signal?.throwIfAborted();
      const totalSize = safeFileNumber(result.totalSize, 'FILE total size');
      const returnedOffset = safeFileNumber(result.offset, 'FILE chunk offset');
      if (result.cid !== cid || returnedOffset !== offset || offset > totalSize
        || result.content.byteLength !== Math.min(length, totalSize - offset)) {
        throw new Error('FILE chunk response does not match the requested identity, offset or size');
      }
      return { cid, totalSize, offset, content: result.content };
    });
  }

  /** Sequential bounded reads. Consumers must verify the final CID before using
   * streamed content; getFileBytes performs that verification automatically. */
  async *iterateFileBytes(cid: string, options: FileDownloadOptions): AsyncGenerator<Uint8Array> {
    checkedFileDownloadOptions(options);
    let offset = 0;
    let total: number | undefined;
    do {
      const chunk = await this.fileReadContentChunk(cid, offset, FILE_CONTENT_CHUNK_BYTES,
        options.signal ? { signal: options.signal } : {});
      if (chunk.totalSize > options.maxBytes
        || (options.expectedSize !== undefined && chunk.totalSize !== options.expectedSize)
        || (total !== undefined && chunk.totalSize !== total)) {
        throw new Error('FILE content size does not match the download bounds');
      }
      total = chunk.totalSize;
      if (chunk.content.byteLength > 0) yield chunk.content;
      offset += chunk.content.byteLength;
    } while (offset < total!);
  }

  /** Download a bounded confirmed FILE and verify its canonical UnixFS CID. */
  async getFileBytes(cid: string, options: FileDownloadOptions): Promise<Uint8Array> {
    checkedFileDownloadOptions(options);
    // Allocate the exact confirmed size after validating the first response,
    // rather than retaining all chunks and copying them into a second buffer.
    const first = await this.fileReadContentChunk(cid, 0, FILE_CONTENT_CHUNK_BYTES,
      options.signal ? { signal: options.signal } : {});
    if (first.totalSize > options.maxBytes
      || (options.expectedSize !== undefined && first.totalSize !== options.expectedSize)) {
      throw new Error('FILE content size does not match the download bounds');
    }
    const bytes = new Uint8Array(first.totalSize);
    bytes.set(first.content);
    for (let offset = first.content.byteLength; offset < bytes.byteLength;) {
      const chunk = await this.fileReadContentChunk(cid, offset, FILE_CONTENT_CHUNK_BYTES,
        options.signal ? { signal: options.signal } : {});
      if (chunk.totalSize !== bytes.byteLength) throw new Error('FILE content size changed during download');
      bytes.set(chunk.content, offset);
      offset += chunk.content.byteLength;
    }
    options.signal?.throwIfAborted();
    const described = await describeFileBytes(bytes);
    options.signal?.throwIfAborted();
    if (described.cid !== cid || described.size !== bytes.byteLength) {
      throw new Error('Downloaded FILE bytes do not match the canonical CID');
    }
    return bytes;
  }

  async previewContractDeploy(code: string, deployerAddress: EthAddress, salt: string): Promise<{ contractAddress: EthAddress }> {
    return this.traced('contract_previewDeploy', async () => {
      const result = await this.contractClient.previewDeploy({ code, deployerAddress, salt });
      return { contractAddress: result.contractAddress as EthAddress };
    });
  }

  async getPendingFileStatus(txId: string): Promise<import('./types.ts').PendingFileStatus> {
    return this.traced('file_getPendingStatus', async () => {
      const result = await this.fileClient.getPendingStatus({ txId });
      return {
        txId: result.txId,
        cid: result.cid,
        expectedSize: Number(result.expectedSize),
        canonicalAvailable: result.canonicalAvailable,
        stagedLocally: result.stagedLocally,
        peerAckCount: result.peerAckCount,
        minPeerAcksRequired: result.minPeerAcksRequired,
        requiresPeerAck: result.requiresPeerAck,
        mineable: result.mineable,
      };
    });
  }

  async fileStat(cid: string): Promise<FileStatResult> {
    return this.traced('file_stat', async () => {
      const result = await this.fileClient.stat({ cid });
      return {
        cid: result.cid,
        stats: {
          type: result.stats!.type as 'raw' | 'directory' | 'file' | 'identity',
          size: result.stats!.size,
          mode: result.stats!.mode ?? 0,
          mtime: result.stats!.mtime != null ? { Seconds: result.stats!.mtime.toString() } : null,
        },
      };
    });
  }

  async fileHasContent(cid: string): Promise<FileHasContentResult> {
    return this.traced('file_hasContent', async () => {
      const result = await this.fileClient.hasContent({ cid });
      return { cid: result.cid, present: result.present };
    });
  }

  async fileGetProvenance(cid: string, params: { limit?: number; offset?: number } = {}): Promise<FileReferenceLookupResult> {
    return this.traced('file_getProvenance', async () => {
      const result = await this.fileClient.getProvenance({
        cid,
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
      });
      return fromProtoFileReferences(result);
    });
  }

  async fileListByAddress(address: EthAddress, params: { limit?: number; offset?: number } = {}): Promise<FileReferenceLookupResult> {
    return this.traced('file_listByAddress', async () => {
      const result = await this.fileClient.listByAddress({
        address,
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
      });
      return fromProtoFileReferences(result);
    });
  }

  /** Acquire a fixed-lifetime immutable read session. Expiry never reopens it implicitly. */
  async openReadSession(options: { expectedBlockHash?: string } = {}): Promise<ContractReadSession> {
    if (options.expectedBlockHash !== undefined && !/^[0-9a-f]{64}$/.test(options.expectedBlockHash)) {
      throw new Error('Expected block hash must be 64 lowercase hexadecimal characters');
    }
    return this.traced('contract_openReadSession', async () => {
      const opened = await this.contractClient.openReadSession({ expectedBlockHash: options.expectedBlockHash });
      if (!/^[0-9a-f]{64}$/.test(opened.id)) throw new Error('Node returned an invalid read session');
      try {
        if (!opened.anchor) throw new Error('Node omitted the read session anchor');
        const anchor = readAnchorFromProto(opened.anchor);
        if (options.expectedBlockHash !== undefined && anchor.blockHash !== options.expectedBlockHash) {
          throw new Error('Read session anchor does not match the expected block');
        }
        return new ContractReadSession(this, opened.id, anchor, safeProtoNumber(opened.expiresAtUnixMs, 'read session expiry'));
      } catch (error) {
        // Failed validation cannot turn this into a moving-tip read. Release the
        // unusable lease best-effort; its native hard lifetime remains the backstop.
        await this.contractClient.closeReadSession({ id: opened.id }).catch(() => {});
        throw error;
      }
    });
  }

  async withReadSession<T>(operation: (session: ContractReadSession) => Promise<T>, options: { expectedBlockHash?: string } = {}): Promise<T> {
    const session = await this.openReadSession(options);
    let completed = false;
    try { const result = await operation(session); completed = true; return result; }
    finally {
      try { await session.close(); }
      catch (error) { if (completed) throw error; }
    }
  }

  /** Explicit close is idempotent. A handle never grants mutation authority. */
  async closeReadSession(id: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid read session ID');
    await this.traced('contract_closeReadSession', async () => { await this.contractClient.closeReadSession({ id }); });
  }

  async getContractState(address: EthAddress, options: { storageCursor?: string | null; storageLimit?: number; readSessionId?: string } = {}): Promise<ContractStateResult> {
    return this.traced('contract_getState', async () => {
      const state = await this.contractClient.getState({
        address,
        storageCursor: options.storageCursor ?? '',
        storageLimit: options.storageLimit ?? 0,
        readSessionId: options.readSessionId,
      });
      if (options.readSessionId !== undefined && !state.readAnchor) throw new Error('Node omitted the requested read-session anchor');
      if (!state.contract) {
        throw new RiadchainNodeError('Contract not found', -32004, { code: 'NOT_FOUND' });
      }
      return {
        contract: {
          address: state.contract.address as EthAddress,
          code: state.contract.code,
          ...(state.readAnchor ? { deployedTxId: state.contract.deployedTxId ?? null, upgradeAuthority: (state.contract.upgradeAuthority ?? null) as EthAddress | null } : {}),
        },
        balance: state.balance,
        storage: state.storage.map((entry) => ({
          slot: entry.slot,
          value: decodeNodeContractJson(entry.valueJson),
        })),
        storageCursor: state.storageCursor ?? null,
        storageHasMore: state.storageHasMore,
        nextStorageCursor: state.nextStorageCursor ?? null,
        ...(state.readAnchor ? { readAnchor: readAnchorFromProto(state.readAnchor) } : {}),
      };
    });
  }

  async getFullContractState(address: EthAddress, options: { storageLimit?: number } = {}): Promise<ContractStateResult> {
    const storage: ContractStateResult['storage'] = [];
    const seenCursors = new Set<string>();
    let storageCursor: string | null = null;
    let latest: ContractStateResult | null = null;

    for (;;) {
      latest = await this.getContractState(address, {
        storageCursor,
        storageLimit: options.storageLimit,
      });
      storage.push(...latest.storage);

      if (!latest.storageHasMore || !latest.nextStorageCursor) {
        break;
      }
      if (seenCursors.has(latest.nextStorageCursor)) {
        throw new Error(`contract_getState pagination loop for ${address} at cursor ${latest.nextStorageCursor}`);
      }
      seenCursors.add(latest.nextStorageCursor);
      storageCursor = latest.nextStorageCursor;
    }

    return {
      ...latest,
      storage,
      storageCursor: null,
      storageHasMore: false,
      nextStorageCursor: null,
    };
  }

  async callView<T = ContractValue>(contractAddress: EthAddress, method: string, args: unknown = {}, options: { readSessionId?: string } = {}): Promise<ContractCallViewResult<T>> {
    return this.traced('contract_callView', async () => {
      const encodedArgs = args === undefined ? {} : encodeContractValueForRpc(args);
      const result = await this.contractClient.callView({
        contractAddress,
        method,
        argsJson: jsonBytes(encodedArgs),
        readSessionId: options.readSessionId,
      });
      if (options.readSessionId !== undefined && !result.readAnchor) throw new Error('Node omitted the requested read-session anchor');
      return {
        ...(result.readAnchor ? { readAnchor: readAnchorFromProto(result.readAnchor) } : {}),
        returnValue: decodeNodeContractJson<T>(result.returnValueJson),
        events: result.events.map((event) => ({
          contractAddress: event.contractAddress,
          txId: event.txId,
          name: event.name,
          data: decodeNodeContractJson(event.dataJson),
          timestamp: Number(event.timestamp),
        })),
      };
    });
  }

  async simulate(tx: Transaction, options?: { includeEvents?: boolean }): Promise<TransactionSimulationResult> {
    return this.traced('transaction_simulate', async () => {
      const includeEvents = Boolean(options?.includeEvents);
      const result = await this.txClient.simulate({
        tx: txToProto(tx),
        includeEvents,
      });
      if (!result.fee) {
        throw new Error('transaction_simulate response missing fee field');
      }
      return {
        result: {
          fee: {
            reservedValue: BigInt(result.fee.reservedValue),
            rawReservedAmount: BigInt(result.fee.rawReservedAmount),
            reservedFeeBudget: BigInt(result.fee.reservedFeeBudget),
            maxRequiredFee: BigInt(result.fee.maxRequiredFee),
            actualRequiredFee: BigInt(result.fee.actualRequiredFee),
            actualFeeCharged: BigInt(result.fee.actualFeeCharged),
            gasUsed: BigInt(result.fee.gasUsed),
            gasRefund: BigInt(result.fee.gasRefund),
          },
          ...(includeEvents ? {
            events: result.events.map((event) => ({
              ...fromProtoContractEvent(event),
              txIndex: event.txIndex,
              eventIndex: event.eventIndex,
            })),
          } : {}),
          executionStatus: result.executionStatus as 'succeeded' | 'failed',
          ...(result.executionError ? { executionError: result.executionError } : {}),
        },
      };
    });
  }

  async getTokenBalance(tokenId: bigint, owner: EthAddress): Promise<bigint> {
    return this.traced('token_getBalance', async () => {
      const result = await this.tokenClient.getBalance({ tokenId: tokenId.toString(), owner });
      return BigInt(result.balance);
    });
  }

  async getTokenSupply(tokenId: bigint): Promise<bigint> {
    return this.traced('token_getSupply', async () => {
      const result = await this.tokenClient.getSupply({ tokenId: tokenId.toString() });
      return BigInt(result.supply);
    });
  }

  async getTokenMetadata(tokenId: bigint): Promise<TokenMetadata> {
    return this.traced('token_getMetadata', async () => {
      const result = await this.tokenClient.getMetadata({ tokenId: tokenId.toString() });
      return {
        'token-id': BigInt(result.tokenId),
        name: result.name,
        symbol: result.symbol,
        type: BigInt(result.type),
        creator: result.creator as EthAddress,
        supply: BigInt(result.supply),
        'max-supply': BigInt(result.maxSupply),
        uri: result.uri ?? null,
      };
    });
  }

  async getProtocolParams(): Promise<ProtocolParamsResult> {
    return this.traced('node_getProtocolParams', async () => {
      const result = await this.nodeClient.getProtocolParams({});
      if (result.networkMode !== 'private' && result.networkMode !== 'regtest') throw new Error('Invalid network mode');
      const params = normalizeProtocolParamsShape({
        networkMode: result.networkMode,
        blockIntervalMs: result.blockIntervalMs,
        blockSubsidySatoshis: BigInt(result.blockSubsidySatoshis),
        minStakeSatoshis: BigInt(result.minStakeSatoshis),
        successionTimeoutMs: result.successionTimeoutMs,
        maxTxBytes: result.maxTxBytes,
        maxFileBytes: result.maxFileBytes,
        maxBlockBytes: result.maxBlockBytes,
        maxTransactionsPerBlock: result.maxTransactionsPerBlock,
        maxOutputsPerTransaction: result.maxOutputsPerTransaction,
        mempoolMaxAgeMs: result.mempoolMaxAgeMs,
        fileMinPeerAcksForMining: result.fileMinPeerAcksForMining,
        filePeerAckTtlMs: result.filePeerAckTtlMs,
        feeSchedule: {
          baseFeeSatoshis: BigInt(result.feeSchedule!.baseFeeSatoshis),
          byteRateSatoshis: BigInt(result.feeSchedule!.byteRateSatoshis),
          gasRateSatoshis: BigInt(result.feeSchedule!.gasRateSatoshis),
          gasUnitsPerSatoshi: BigInt(result.feeSchedule!.gasUnitsPerSatoshi),
          storageRateSatoshis: BigInt(result.feeSchedule!.storageRateSatoshis),
        },
        gasSchedule: {
          maxGasPerTx: BigInt(result.gasSchedule!.maxGasPerTx),
          blockGasLimit: BigInt(result.gasSchedule!.blockGasLimit),
        },
        vmLimits: {
          maxStackDepth: result.vmLimits!.maxStackDepth,
          maxReturnStackDepth: result.vmLimits!.maxReturnStackDepth,
          maxMemoryCells: result.vmLimits!.maxMemoryCells,
          maxInstructions: result.vmLimits!.maxInstructions,
          maxStringChars: result.vmLimits!.maxStringChars,
          maxArrayLength: result.vmLimits!.maxArrayLength,
          maxBigIntBits: result.vmLimits!.maxBigIntBits,
          maxPowExponent: result.vmLimits!.maxPowExponent,
        },
      });
      if (!params) throw new Error('Node returned invalid genesis protocol parameters');
      return params;
    });
  }

  async getProtocolInfo(): Promise<ProtocolInfo> {
    return this.traced('node_getProtocolInfo', async () => fromProtocolInfo(await this.nodeClient.getProtocolInfo({})));
  }

  /**
   * Fetch the contract-call tree captured during execution of `txId`. Returns
   * an ordered list of every nested call frame with `parentCallIndex` linking
   * back to the immediate ancestor. Non-CONTRACT transactions yield [].
   * Captured by the typed transaction receipt API.
   */
  async getContractCallTree(txId: string): Promise<ContractCallTreeEntry[]> {
    return this.traced('tx_getCallTree', async () => {
      try { return (await this.getReceipt(txId)).callTree; }
      catch (error) { if (error instanceof RiadchainNodeError && error.code === Code.NotFound) return []; throw error; }
    });
  }

  async getContractEvents(params: {
    contractAddress?: EthAddress;
    eventName?: string;
    txId?: string;
    fromBlock?: number;
    toBlock?: number;
    limit?: number;
    offset?: number;
    order?: 'asc' | 'desc';
  }): Promise<ContractEventQueryResult> {
    return this.traced('contract_getEvents', async () => {
      const result = await this.contractClient.getEvents({
        contractAddress: params.contractAddress ?? '',
        eventName: params.eventName ?? '',
        txId: params.txId ?? '',
        fromBlock: params.fromBlock == null ? undefined : BigInt(params.fromBlock),
        toBlock: params.toBlock == null ? undefined : BigInt(params.toBlock),
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
        order: params.order ?? 'desc',
      });
      return {
        events: result.events.map((event) => ({
          ...fromProtoContractEvent(event),
          blockHash: event.blockHash ?? null,
          txIndex: event.txIndex,
          eventIndex: event.eventIndex,
          cursor: null,
        })),
        limit: result.limit,
        offset: result.offset,
        total: result.total,
        hasMore: result.hasMore,
      };
    });
  }

  async listScheduledContractCalls(params: {
    caller?: EthAddress; contractAddress?: EthAddress; limit?: number; offset?: number;
  } = {}): Promise<ScheduledContractCallQueryResult> {
    return this.traced('contract_listScheduledCalls', async () => {
      const result = await this.contractClient.listScheduledCalls({
        caller: params.caller ?? '', contractAddress: params.contractAddress ?? '',
        limit: params.limit ?? 50, offset: BigInt(params.offset ?? 0),
      });
      return { scheduledCalls: result.scheduledCalls.map(fromProtoScheduledCall), limit: result.limit,
        offset: safeProtoNumber(result.offset, 'schedule offset'), total: safeProtoNumber(result.total, 'schedule total'), hasMore: result.hasMore };
    });
  }

  async getScheduledContractCall(scheduleId: string): Promise<ScheduledContractCall | null> {
    return this.traced('contract_getScheduledCall', async () => {
      try { return fromProtoScheduledCall(await this.contractClient.getScheduledCall({ scheduleId })); }
      catch (error) { if (error instanceof ConnectError && error.code === Code.NotFound) return null; throw error; }
    });
  }

  /** Return the additional limited signer, or null when only the owner is authorized. */
  async getProductionSigner(owner: EthAddress): Promise<EthAddress | null> {
    if (!isAccountAddress(owner)) throw new Error('Production owner must be an account address');
    return this.traced('account_getProductionSigner', async () => {
      const result = await this.accountClient.getProductionSigner({ ownerAddress: owner });
      if (!isAccountAddress(result.ownerAddress) || result.ownerAddress.toLowerCase() !== owner.toLowerCase()
        || (result.signerAddress != null && !isAccountAddress(result.signerAddress))) {
        throw new Error('Invalid production signer response');
      }
      return result.signerAddress == null ? null : result.signerAddress.toLowerCase() as EthAddress;
    });
  }

  async listDeviceCapabilities(params: {
    owner?: EthAddress; delegate?: EthAddress; contractAddress?: EthAddress; limit?: number; offset?: number;
  } = {}): Promise<DeviceCapabilityQueryResult> {
    return this.traced('account_listDeviceCapabilities', async () => {
      const result = await this.accountClient.listCapabilities({ owner: params.owner ?? '', delegate: params.delegate ?? '',
        contractAddress: params.contractAddress ?? '', limit: params.limit ?? 50, offset: BigInt(params.offset ?? 0) });
      return { capabilities: result.capabilities.map(fromProtoDeviceCapability), limit: result.limit,
        offset: safeProtoNumber(result.offset, 'capability offset'), total: safeProtoNumber(result.total, 'capability total') };
    });
  }

  async getDeviceCapability(capabilityId: string): Promise<DeviceCapability | null> {
    return this.traced('account_getDeviceCapability', async () => {
      try { return fromProtoDeviceCapability(await this.accountClient.getCapability({ capabilityId })); }
      catch (error) { if (error instanceof ConnectError && error.code === Code.NotFound) return null; throw error; }
    });
  }

  /**
   * Subscribe to contract events in real time. Returns an async iterable of
   * subscription messages (`ready`, `event`, `replay-complete`,
   * `error`). Stream closes when the AbortSignal aborts or the connection
   * ends. Auth uses the same bearer token as other user RPCs.
   *
   * If `fromBlock` is set, historical events at or after that height are
   * replayed (oldest-first) before live events are streamed. Live events
   * are de-duped against the replay tail so the iterator never yields the
   * same event twice.
   */
  async *subscribeContractEvents(
    options: ContractEventSubscriptionOptions = {},
  ): AsyncGenerator<ContractEventSubscriptionMessage, void, void> {
    const url = new URL(`${this.nodeUrl}/events`);
    if (options.contractAddress) url.searchParams.set('contract', options.contractAddress);
    if (options.eventName) {
      if (new TextEncoder().encode(options.eventName).length > 128) throw new Error('Event name exceeds 128 bytes');
      url.searchParams.set('name', options.eventName);
    }
    if (options.fromBlock !== undefined) {
      if (!Number.isSafeInteger(options.fromBlock) || options.fromBlock < 0) throw new Error('fromBlock must be a non-negative safe integer');
      url.searchParams.set('fromBlock', String(options.fromBlock));
    }
    if (options.cursor !== undefined) {
      if (options.fromBlock !== undefined) throw new Error('Event cursor and fromBlock are mutually exclusive');
      url.searchParams.set('cursor', eventCursor(options.cursor));
    }

    const headers = createRequestHeaders(this.requestHeaders, this.nodeToken, { accept: 'text/event-stream' });
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new RiadchainNodeError(
          `Event subscription failed: HTTP ${response.status}${text ? `: ${text}` : ''}`,
          response.status,
        );
      }
      if (!response.body) {
        throw new RiadchainNodeError('Event subscription returned no body', 500);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separator = buffer.indexOf('\n\n');
          while (separator !== -1) {
            const rawFrame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            separator = buffer.indexOf('\n\n');
            const message = parseSseFrame(rawFrame);
            if (message) yield message;
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
      }
    } finally {
      controller.abort();
      options.signal?.removeEventListener('abort', abort);
    }
  }

  /**
   * Convenience: subscribe and yield only `event` messages, discarding control
   * frames (ready and replay-complete). Errors are thrown.
   */
  async *streamContractEvents(
    options: ContractEventSubscriptionOptions = {},
  ): AsyncGenerator<ContractEvent, void, void> {
    for await (const msg of this.subscribeContractEvents(options)) {
      if (msg.kind === 'event') {
        yield msg.event;
      } else if (msg.kind === 'error') {
        throw new RiadchainNodeError(msg.message, 500);
      }
    }
  }

  async getStorageMetrics(): Promise<FileStorageMetrics> {
    return this.traced('storage_getMetrics', async () => {
      return fromProtoFileStorageMetrics(await this.storageClient.getMetrics({}));
    });
  }

  async verifyStorageIntegrity(): Promise<StorageIntegrityResult> {
    return this.traced('storage_verifyIntegrity', async () => {
      const result = await this.storageClient.verifyIntegrity({});
      const errorSamples = result.errorSamples.length > 0 ? result.errorSamples : result.errors;
      return {
        ok: result.ok,
        checkedBlocks: Number(result.checkedBlocks),
        errorCount: result.errorCount || errorSamples.length,
        errorSamples,
      };
    });
  }

  async waitForTransaction(txId: string, options: WaitOptions = {}): Promise<TransactionContext> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const intervalMs = options.intervalMs ?? 500;
    const started = Date.now();
    let seenAsPending = false;

    while (Date.now() - started < timeoutMs) {
      try {
        const tx = await this.getTransaction(txId);
        if (tx.status === 'confirmed') {
          return tx;
        }
        seenAsPending = true;
      } catch (error) {
        if (!(error instanceof RiadchainNodeError) || error.code !== Code.NotFound) {
          throw error;
        }
        if (seenAsPending) {
          throw new Error(
            `Transaction ${txId} was evicted from the mempool before it could be confirmed`
          );
        }
      }
      await wait(intervalMs);
    }

    throw new Error(`Timed out waiting for transaction ${txId}`);
  }

  async waitForHeight(height: number, options: WaitOptions = {}): Promise<SyncHealth> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const intervalMs = options.intervalMs ?? 500;
    const started = Date.now();
    let lastSync: SyncHealth | null = null;

    while (Date.now() - started < timeoutMs) {
      lastSync = await this.getSyncHealth();
      if (lastSync.localHeight >= height) {
        return lastSync;
      }
      await wait(intervalMs);
    }

    throw new Error(`Timed out waiting for height ${height}; last local height ${lastSync?.localHeight ?? 'unknown'}`);
  }

  async waitForChainHeight(height: number, options: WaitOptions = {}): Promise<number> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const intervalMs = options.intervalMs ?? 500;
    const started = Date.now();
    let lastHeight = -1;

    while (Date.now() - started < timeoutMs) {
      lastHeight = await this.getLatestHeight();
      if (lastHeight >= height) {
        return lastHeight;
      }
      await wait(intervalMs);
    }

    throw new Error(`Timed out waiting for chain height ${height}; last height ${lastHeight}`);
  }

  async waitForNoPending(options: WaitOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const intervalMs = options.intervalMs ?? 500;
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const pending = await this.getPendingTransactions();
      if (pending.length === 0) {
        return;
      }
      await wait(intervalMs);
    }

    throw new Error('Timed out waiting for pending transactions to clear');
  }

  async waitForSyncLag(maxLag: number, options: WaitOptions = {}): Promise<SyncHealth> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const intervalMs = options.intervalMs ?? 1_000;
    const started = Date.now();
    let lastSync: SyncHealth | null = null;

    while (Date.now() - started < timeoutMs) {
      lastSync = await this.getSyncHealth();
      if (lastSync.lag <= maxLag && !lastSync.archival.archivalDegraded) {
        return lastSync;
      }
      await wait(intervalMs);
    }

    throw new Error(`Timed out waiting for sync lag <= ${maxLag}; last lag ${lastSync?.lag ?? 'unknown'}`);
  }
}
