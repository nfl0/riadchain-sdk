// Shared, explicitly curated public API for the main and browser entrypoints.
export { RiadchainProvider, RiadchainNodeError, ContractReadSession, FILE_CONTENT_CHUNK_BYTES, type FileContentChunk, type FileDownloadOptions } from './provider.ts';
export { classifyTransactionOutcome, waitForTransactionOutcome, type TransactionOutcome } from './transactionOutcome.ts';
export { assertSignableMessage, assertSigningTransaction } from './signingPolicy.ts';
export { encodeContractArguments, decodeContractArguments } from '../lib/contractArguments.ts';
export { encodeCanonicalContractValue, typedHash, bytesSha256, bytesKeccak256, utf8ToHex, hexToUtf8, base64ToHex, hexToBase64 } from './typed-data.ts';
export type { TypedDataOptions } from './typed-data.ts';
export { NotesClient, NOTES_METHODS, NOTES_CALL_GAS, notesActionArguments, buildNotesCallTx, buildDelegatedNotesCall, assertNotesCapability } from './notes.ts';
export type { NotesDescriptor, EncryptedNote, NotesPage, NotesMetadata, NotesAction } from './notes.ts';
export { NOTES_MAX_ATTACHMENT_BYTES, NOTES_ATTACHMENT_OVERHEAD, NOTES_MAX_NOTE_PLAINTEXT_BYTES, NOTES_MAX_CIPHERTEXT_BYTES, NOTES_MAX_ATTACHMENTS, createNotesId, deriveNotesKey, parseNoteContent, encryptNote, decryptNote, encryptNotesAttachment, decryptNotesAttachment } from './notesCrypto.ts';
export type { NotesScope, NotesAttachment, NoteContent, NotesRandomSource } from './notesCrypto.ts';
export { LocalSigner } from './signer.ts';
export { WalletSession, WalletTransactionError } from './wallet.ts';
export { NAME_MAX_ENTRIES, NAME_MAX_PAGE_SIZE, NAME_ENTITY_KINDS, NameRegistryClient, normalizeName, normalizeNameProfile, normalizeNameRegistryAction, buildNameRegistryCallTx } from './names.ts';
export type { NameEntityKind, NameServiceTransport, NameDestination, NameDestinationInput, NameProfile, NameProfileInput, NameRecord, NamePage, NameRegistryAction, NameRegistryCallOptions } from './names.ts';
export {
  DEFAULT_HD_PATH_PREFIX,
  DEFAULT_MNEMONIC_WORD_COUNT,
  buildMnemonicDerivationPath,
  deriveAccountFromMnemonic,
  deriveAccountsFromMnemonic,
  derivePrivateKeyFromMnemonic,
  generateMnemonic,
  mnemonicFromEntropy,
  mnemonicToSeedHex,
  validateMnemonic,
} from '../lib/mnemonic.ts';
export {
  TOKEN_BASE_UNITS,
  TOKEN_DECIMALS,
  calculateFeeBreakdown,
  estimateTxSizeBytes,
  formatSatoshisAsRdcString,
  formatTokenAmount,
  parseTokenAmount,
  toSatoshis,
  buildProductionSignerSetTx,
  buildProductionSignerRevokeTx,
} from '../lib/txUtils.ts';
export {
  FEE_SCHEDULE,
  GAS_SCHEDULE,
  calculateGasExecutionFee,
  ceilDiv,
} from '../lib/feeSchedule.ts';
export {
  DEFAULT_PROTOCOL_PARAMS,
  REGTEST_PROTOCOL_PARAMS,
  DEFAULT_VM_LIMITS,
  normalizeProtocolParamsShape,
  normalizeNativeProtocolParamsShape,
  serializeProtocolParams,
  withDefaultProtocolParams,
} from '../lib/protocolParams.ts';
export type {
  FeeSchedule,
  GasSchedule,
  NetworkMode,
  ProtocolParams,
  SerializedProtocolParams,
  VmLimits,
} from '../lib/protocolParams.ts';
export { getAddressFromPrivateKey, getPublicKeyFromPrivateKey, getAddressKind, isAccountAddress, isValidAddress } from '../lib/crypto.ts';
export { REWARD_VAULT_SYSTEM_CONTRACT_ADDRESS, TOKEN_SYSTEM_CONTRACT_ADDRESS,
  PRODUCTION_SIGNER_SYSTEM_CONTRACT_ADDRESS, PRODUCTION_SIGNER_GAS_LIMIT } from '../lib/protocolConstants.ts';
export type {
  AddressTokenBalancesResult,
  AddressTransactionsResult,
  AuditHistoryEntry,
  AuditHistoryResult,
  Block,
  BlockHeader,
  BlockReceipt,
  ContractCallTreeEntry,
  ContractEvent,
  ContractEventQueryResult,
  ContractEventSubscriptionMessage,
  ContractEventSubscriptionOptions,
  ContractStateResult,
  ContractCallViewResult,
  ContractViewEvent,
  DeviceCapability,
  DeviceCapabilityQueryResult,
  EthAddress,
  FeeAccountingResult,
  FileByCidResult,
  FileStorageMetrics,
  ProtocolActivation,
  ProtocolInfo,
  ProtocolParamsResult,
  LocalNodeStatus,
  LocalSyncState,
  NodeMetrics,
  OperatorHealth,
  NodeStatus,
  ProviderOptions,
  ReadAnchor,
  StorageIntegrityResult,
  SyncHealth,
  TokenSpendIntent,
  TokenMetadata,
  Transaction,
  TransactionContext,
  TransactionReceipt,
  TransactionSimulationResult,
  UTXO,
  UtxoPage,
  WaitOptions,
} from './types.ts';
