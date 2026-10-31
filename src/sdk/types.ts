import type { EthAddress } from './internal/crypto.ts';
import type { DeviceCapabilityGrant, Transaction, UTXO } from './internal/txUtils.ts';
import type { ContractValue } from '../lib/contractValueCodec.ts';
export type { DeviceCapabilityGrant, EthAddress, Transaction, UTXO };

export type UtxoPage = { utxos: UTXO[]; nextPageToken: string };
export type AddressTokenBalancesResult = {
  address: EthAddress;
  tokenBalances: Array<{ tokenId: string; name: string; symbol: string; type: string; balance: string; uri: string | null }>;
  limit: number; offset: number; total: number; hasMore: boolean;
};

export type DaemonVersionInfo = {
  daemonName: string;
  daemonVersion: string;
  packageName: string;
};

export type ProtocolActivation = { targetProtocolVersion: number; activationHeight: number };
export type ProtocolInfo = {
  activeProtocolVersion: number;
  supportedProtocolVersions: number[];
  nextBlockProtocolVersion: number;
  /** Whether this node supports the configured protocol for the next block. */
  compatible: boolean;
  activations: ProtocolActivation[];
};

export type LocalNodeStatus = {
  daemon: DaemonVersionInfo;
  localAddress: EthAddress;
  productionOwner: EthAddress;
  productionSignerAuthorized: boolean;
  chainId: string;
  isValidator: boolean;
  hasLocalStake: boolean;
  peerCount: number;
  archival: {
    fileCount: number;
    availableFileCount: number;
    missingFileCount: number;
    fileReferenceCount: number;
    stagedFileCount: number;
    hydrationQueueDepth: number;
    archivalDegraded: boolean;
  };
  protocolInfo: ProtocolInfo;
  blockProduction: {
    canProduceNow: boolean;
    role: 'current_producer' | 'funded_standby' | 'archive';
    summary: string;
  };
};

export type NodeStatus = LocalNodeStatus & {
  latestBlockIndex: number;
  latestBlockHash: string | null;
  isMining: boolean;
  blockIntervalMs: number;
  nextBlockAt: number | null;
  msUntilNextBlock: number | null;
  pendingTransactions: number;
  currentValidator: EthAddress | null;
  successionTimeoutMs: number;
  recoverable: boolean;
  peers: string[];
  ready: boolean;
  stateHash: string;
  localTipFresh: boolean;
  clockSane: boolean;
  storageFault: string | null;
  forkAlarm: boolean;
};

export type SyncHealth = {
  localHeight: number;
  localHash: string | null;
  peerCount: number;
  reachablePeerCount: number;
  bestPeerHeight: number;
  lag: number;
  syncing: boolean;
  caughtUp: boolean;
  peerComparisonAvailable: boolean;
  forkAlarm: boolean;
  localTip: {
    nowMs: number;
    tipTimestampMs: number;
    tipObservedAtMs: number;
    tipAgeMs: number;
    freshnessWindowMs: number;
    clockSane: boolean;
    tipFresh: boolean;
    forkAlarm: boolean;
    ready: boolean;
  } | null;
  archival: {
    missingFileCount: number;
    hydrationQueueDepth: number;
    archivalDegraded: boolean;
  };
  peers: Array<{
    peer: string;
    reachable: boolean;
    height: number | null;
    error: string | null;
    lastSuccessMs: number | null;
    lastErrorMs: number | null;
    caughtUpHint: boolean | null;
    consecutiveFailures: number;
  }>;
};

export type OperatorHealth = {
  observedAtUnixMs: number;
  status: NodeStatus;
  sync: SyncHealth;
  ready: boolean;
  localTipFresh: boolean;
  clockSane: boolean;
  forkAlarm: boolean;
  equivocationEvidenceCount: number;
  persistent: boolean;
  canonicalStorage: {
    healthy: boolean;
    storedBlocks: number;
    canonicalLogBytes: number;
    tipHeight: number;
    tipHash: string;
    stateHash: string;
  };
  derivedStorage: {
    storedReceipts: number;
    receiptCacheHealthy: boolean;
    derivedBlockReceipts: number;
    checkpointCount: number;
    latestCheckpointHeight: number | null;
    loadedCheckpointHeight: number | null;
    checkpointHealthy: boolean;
  };
  fileArchive: {
    storedObjects: number;
    storedBytes: number;
    committedFiles: number;
    availableFiles: number;
    missingFiles: number;
    availableBytes: number;
    missingBytes: number;
    fileReferences: number;
    hydrationQueueDepth: number;
    degraded: boolean;
  };
};

export type AuditHistoryEntry = {
  cursor: string;
  blockIndex: number;
  itemIndex: number;
  txIndex: number | null;
  transactionId: string;
  canonicalTransaction: boolean;
  timestampMs: number;
  kind: string;
  summary: string;
  actor: EthAddress | null;
  actorLabel: string | null;
  target: EthAddress | null;
  targetLabel: string | null;
  amountSatoshis: bigint | null;
  status: 'succeeded' | 'failed';
  contractAddress: EthAddress | null;
  method: string | null;
  fileCid: string | null;
  scheduleId: string | null;
  events: Array<{ contractAddress: EthAddress; name: string }>;
};

export type AuditHistoryResult = {
  entries: AuditHistoryEntry[];
  nextCursor: string | null;
  hasMore: boolean;
  canonicalComplete: boolean;
};

export type LocalSyncState = {
  localHeight: number;
  localHash: string | null;
  archival: {
    missingFileCount: number;
    hydrationQueueDepth: number;
    archivalDegraded: boolean;
  };
};

export type SuccessionProof = {
  txId: string;
  outputIndex: number;
  amount: string;
};

export type Block = {
  protocolVersion: number;
  index: number;
  chainId: string;
  timestamp: number;
  transactions: Transaction[];
  fileAvailability: Array<{
    txId: string;
    cid: string;
    size: number;
  }>;
  previousHash: string;
  stateHash: string;
  hash: string;
  validatorPublicKey: string | null;
  validatorAddress: EthAddress;
  validatorSignature: string;
  isSuccession: boolean;
  successionProof: SuccessionProof | null;
};

export type BlockHeader = {
  protocolVersion: number;
  index: number;
  chainId: string;
  hash: string;
  previousHash: string;
  stateHash: string;
  timestamp: number;
  validatorAddress: EthAddress;
  validatorPublicKey: string | null;
  txCount: number;
  isSuccession: boolean;
};

export type TransactionContext = {
  transaction: Transaction;
  blockIndex: number | null;
  blockHash: string | null;
  status: 'pending' | 'confirmed';
};

export type PendingFileStatus = {
  txId: string;
  cid: string;
  expectedSize: number;
  canonicalAvailable: boolean;
  stagedLocally: boolean;
  peerAckCount: number;
  minPeerAcksRequired: number;
  requiresPeerAck: boolean;
  mineable: boolean;
};

export type ContractCallTreeEntry = {
  callIndex: number;
  parentCallIndex: number;
  depth: number;
  caller: EthAddress;
  callee: EthAddress;
  method: string | null;
  valueSatoshis: string;
  succeeded: boolean;
  error?: string;
  gasUsed: string;
};

export type TransactionReceipt = {
  txId: string;
  blockIndex: number;
  blockHash: string | null;
  success: boolean;
  executionStatus: 'succeeded' | 'failed';
  gasUsed: string;
  feeCharged: string;
  gasRefund: string;
  eventCount: number;
  error: string | null;
  events: Array<{
    contractAddress: string;
    txId: string;
    eventName: string;
    data: ContractValue;
    blockIndex: number;
    timestamp: number;
  }>;
  /** Ordered contract-call tree captured during execution. Empty for non-CONTRACT receipts. */
  callTree: ContractCallTreeEntry[];
};

export type BlockReceipt = {
  txId: string;
  blockIndex: number;
  success: boolean;
  executionStatus: 'succeeded' | 'failed';
  gasUsed: string;
  feeCharged: string;
  gasRefund: string;
  eventCount: number;
  error: string | null;
};

export type WaitOptions = {
  timeoutMs?: number;
  intervalMs?: number;
};

import type { Transport } from '@connectrpc/connect';

export type ProviderOptions = {
  nodeTimeoutMs?: number;
  transport?: Transport;
  requestHeaders?: Record<string, string>;
};

export type TransferBurstMetrics = {
  submitted: number;
  confirmed: number;
  failed: number;
  elapsedMs: number;
  txIds: string[];
};

export type TokenSpendIntent = {
  operation: 'transfer' | 'burn';
  tokenId: bigint;
  maxAmount: bigint;
  allowedContract: EthAddress;
  allowedMethod: string;
  to?: EthAddress | null;
};

export type FileByCidResult = {
  file: {
    cid: string;
    size: number;
    firstSeenTxId: string;
    firstSeenBlockIndex: number;
    firstSeenBy: string | null;
    firstFilename: string | null;
    latestFilename: string | null;
    mimeType: string | null;
    referenceCount: number;
    contentStatus: 'available' | 'missing';
    lastHydrationAttemptAt: number | null;
    lastHydrationSuccessAt: number | null;
    hydrationPriority: 'high' | 'medium' | 'low' | 'manual';
    hydrationFailureCount: number;
    nextHydrationAttemptAt: number | null;
    attestedBy: string | null;
    attestedAtBlockIndex: number | null;
    attestedSourcePeer: string | null;
    verifiedAtAcceptTime: number | null;
    lastHydrationSource: string | null;
  } | null;
};

/** Exact canonical observation returned by a native read session; not a state proof. */
export type ReadAnchor = {
  chainId: string;
  genesisHash: string;
  blockIndex: number;
  blockHash: string;
  stateHash: string;
  protocolVersion: number;
  timestampMs: number;
};

export type ContractStateResult = {
  contract: {
    address: EthAddress;
    code: string;
    deployedTxId?: string | null;
    upgradeAuthority?: EthAddress | null;
  } | null;
  balance: string;
  storage: Array<{ slot: string; value: ContractValue | null }>;
  storageCursor: string | null;
  storageHasMore: boolean;
  nextStorageCursor: string | null;
  readAnchor?: ReadAnchor;
};

export type ContractEvent = {
  contractAddress: string;
  txId: string;
  eventName: string;
  data: ContractValue;
  blockIndex: number;
  timestamp: number;
  blockHash: string | null;
  txIndex: number;
  eventIndex: number;
  /** Append-only canonical event cursor, or null for ordinary paged queries. */
  cursor: string | null;
};

export type ContractEventQueryResult = {
  events: ContractEvent[];
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
};

export type ContractEventSubscriptionOptions = {
  contractAddress?: EthAddress;
  eventName?: string;
  /** If set, replay historical events at or after this block height before streaming live events. */
  fromBlock?: number;
  /** Resume strictly after a cursor previously delivered by this stream. Mutually exclusive with fromBlock. */
  cursor?: string;
  /** Optional AbortSignal to close the subscription. */
  signal?: AbortSignal;
};

export type ContractEventSubscriptionMessage =
  | { kind: 'ready'; contractAddress: string | null; eventName: string | null; fromBlock: number | null; cursor: string; tipCursor: string }
  | { kind: 'event'; event: ContractEvent }
  | { kind: 'replay-complete'; count: number; cursor: string }
  | { kind: 'error'; message: string };

export type ScheduledContractCall = {
  scheduleId: string;
  caller: EthAddress;
  creatorContract: EthAddress | null;
  contractAddress: EthAddress;
  method: string;
  data: ContractValue;
  executeAtHeight: number;
  scheduledAtHeight: number;
  gasLimit: number;
  codeHash: string | null;
};

export type ScheduledContractCallQueryResult = {
  scheduledCalls: ScheduledContractCall[];
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
};

export type DeviceCapability = {
  capabilityId: string;
  owner: EthAddress;
  delegate: EthAddress;
  contractAddress: EthAddress;
  methods: string[];
  expiresAtHeight: number;
  maxGasPerCall: number;
  maxCallsPerBlock: number;
  delegateAsActor: boolean;
  feeBalance: bigint;
  storageRemainingBytes: number;
  nextSequence: number;
  lastUsedHeight: number | null;
  callsAtLastHeight: number;
  revoked: boolean;
};

export type DeviceCapabilityQueryResult = {
  capabilities: DeviceCapability[];
  limit: number;
  offset: number;
  total: number;
};

export type ContractViewEvent = {
  contractAddress: string;
  txId: string;
  name: string;
  data: ContractValue;
  timestamp: number;
};

export type ContractCallViewResult<T = ContractValue> = {
  readAnchor?: ReadAnchor;
  returnValue: T;
  events: ContractViewEvent[];
};

export type FeeAccountingResult = {
  reservedValue: bigint;
  rawReservedAmount: bigint;
  reservedFeeBudget: bigint;
  maxRequiredFee: bigint;
  actualRequiredFee: bigint;
  actualFeeCharged: bigint;
  gasUsed: bigint;
  gasRefund: bigint;
};

export type TransactionSimulationResult = {
  result: {
    fee: FeeAccountingResult;
    events?: Array<{
      contractAddress: string;
      txId: string;
      eventName: string;
      data: ContractValue;
      blockIndex: number;
      timestamp: number;
      txIndex: number;
      eventIndex: number;
    }>;
    executionStatus: 'succeeded' | 'failed';
    executionError?: string;
  };
};

export type ProtocolParamsResult = import('../lib/protocolParams.ts').ProtocolParams;

export type TokenMetadata = {
  'token-id': bigint;
  name: string;
  symbol: string;
  type: bigint;
  creator: EthAddress;
  supply: bigint;
  'max-supply': bigint;
  uri: string | null;
};

export type AddressTransactionsResult = {
  address: EthAddress;
  transactions: Array<{
    transaction: Transaction;
    blockIndex: number | null;
    blockHash: string | null;
    status: 'pending' | 'confirmed';
    involvement: 'input' | 'output' | 'both';
  }>;
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
};

export type StoredBlockInfo = {
  cid: string;
  packId: number;
  filename: string;
  offset: number;
  length: number;
  recordLength: number;
  checksum: string;
  live: boolean;
};

export type UnixTime = {
  Seconds: string;
  FractionalNanoseconds?: number;
};

export type FileStatResult = {
  cid: string;
  stats: {
    type: string;
    size: string;
    mode: number;
    mtime: UnixTime | null;
  };
};

export type FileHasContentResult = {
  cid: string;
  present: boolean;
};

export type FileReferenceLookupResult = {
  references: Array<{
    cid: string;
    txId: string;
    address: string | null;
    blockIndex: number;
    timestamp: number;
    filename: string | null;
    mimeType: string | null;
    size: number;
  }>;
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
};

export type BlockstoreMetrics = {
  packs: {
    total: number;
    active: number;
    sealed: number;
    compacting: number;
    obsolete: number;
  };
  blocks: {
    total: number;
    referenced: number;
    reclaimable: number;
  };
  bytes: {
    total: number;
    live: number;
    reclaimable: number;
  };
};

export type FileStorageMetrics = BlockstoreMetrics & {
  fileObjects: number;
  stagedObjects: number;
  stagedBytes: number;
  missingFiles: number;
  fileReferenceCount: number;
};

export type FileSyncHealthMetrics = {
  fileCount: number;
  availableFileCount: number;
  missingFileCount: number;
  availableBytes: number;
  missingBytes: number;
  fileReferenceCount: number;
  hydrationQueueDepth: number;
  archivalDegraded: boolean;
};

export type NodeMetrics = {
  startedAt: number;
  uptimeMs: number;
  process: {
    pid: number;
    uptimeSeconds: number;
    memory: {
      rss: number;
    };
  };
  counters: {
    blocksAccepted: number;
  };
  chain: {
    latestBlock: BlockHeader | null;
    pendingTransactions: number;
  };
  storage: {
    fileSync: FileSyncHealthMetrics;
  };
};

export type StorageIntegrityResult = {
  ok: boolean;
  checkedBlocks: number;
  errorCount: number;
  errorSamples: string[];
};
