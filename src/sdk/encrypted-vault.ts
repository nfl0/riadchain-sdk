import type { ContractValue } from '../lib/contractValueCodec.ts';
import { describeFileText } from '../lib/fileDescriptor.ts';
import { normalizeCanonicalFileCid } from '../lib/filePayload.ts';
import { getAddressKind, isAccountAddress, isValidAddress, type EthAddress } from './internal/crypto.ts';
import { RiadchainProvider } from './provider.ts';
import type { TransactionReceipt } from './types.ts';
import {
  decryptVaultObject,
  encryptVaultObject,
  normalizeVaultObjectBinding,
  rewrapVaultKey,
  validatePreparedVaultObject,
  VAULT_ALGORITHM,
  VAULT_MAX_PLAINTEXT_BYTES,
  type PreparedVaultObject,
  type VaultKeyEnvelope,
  type VaultMasterKey,
} from './vault-crypto.ts';
import { WalletSession } from './wallet.ts';

export const ENCRYPTED_VAULT_MAX_OBJECTS = 512n;
export const ENCRYPTED_VAULT_MAX_PAGE_SIZE = 50n;
export const ENCRYPTED_VAULT_MAX_ENCRYPTED_BYTES = Math.ceil(VAULT_MAX_PLAINTEXT_BYTES * 4 / 3) + 4_096;

export type EncryptedVaultObjectStatus = 'active' | 'revoked';
export type EncryptedVaultObject = {
  objectId: string;
  owner: EthAddress;
  label: string;
  filename: string;
  mimeType: string;
  cid: string;
  encryptedSize: bigint;
  plaintextSize: bigint;
  algorithm: typeof VAULT_ALGORITHM;
  keyId: string;
  wrapNonce: string;
  wrappedKey: string;
  status: EncryptedVaultObjectStatus;
  index: bigint;
  revision: bigint;
  createdAtHeight: bigint;
  updatedAtHeight: bigint;
};
export type EncryptedVaultPage = { objects: EncryptedVaultObject[]; nextCursor: bigint; hasMore: boolean; total: bigint };
export type EncryptedVaultMutationOptions = { gasLimit?: number; timeoutMs?: number; expiryHeight?: number | null };

function canonicalAddress(value: string, field: string): EthAddress {
  if (!isValidAddress(value) || value !== value.toLowerCase()) throw new Error(`${field} must be a canonical lowercase address`);
  return value as EthAddress;
}

function contractAddress(value: string): EthAddress {
  const address = canonicalAddress(value, 'Encrypted vault contract');
  if (!['contract', 'internal_contract', 'system_contract'].includes(getAddressKind(address))) {
    throw new Error('Encrypted vault must use a contract address namespace');
  }
  return address;
}

function asRecord(value: unknown, field: string): Record<string, ContractValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is not a contract record`);
  return value as Record<string, ContractValue>;
}

function stringField(record: Record<string, ContractValue>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Encrypted vault field ${field} is not a string`);
  return value;
}

function bigintField(record: Record<string, ContractValue>, field: string): bigint {
  const value = record[field];
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`Encrypted vault field ${field} is not an unsigned integer`);
  return value;
}

function safeSize(value: bigint, maximum: number, field: string): number {
  if (value <= 0n || value > BigInt(maximum)) throw new Error(`Encrypted vault ${field} exceeds its supported bound`);
  return Number(value);
}

function canonicalBase64(value: string, bytes: number, field: string): string {
  let decoded: Uint8Array;
  try { decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
  catch { throw new Error(`Encrypted vault ${field} is malformed`); }
  let encoded = '';
  for (const byte of decoded) encoded += String.fromCharCode(byte);
  if (decoded.length !== bytes || btoa(encoded) !== value) {
    throw new Error(`Encrypted vault ${field} is malformed`);
  }
  return value;
}

function decodeObject(value: unknown): EncryptedVaultObject {
  const record = asRecord(value, 'Encrypted vault object');
  const owner = canonicalAddress(stringField(record, 'owner'), 'Encrypted vault owner');
  if (!isAccountAddress(owner)) throw new Error('Encrypted vault owner must be an account');
  const encryptedSize = bigintField(record, 'encryptedSize');
  const plaintextSize = bigintField(record, 'plaintextSize');
  const binding = normalizeVaultObjectBinding({
    objectId: stringField(record, 'objectId'),
    label: stringField(record, 'label'),
    filename: stringField(record, 'filename'),
    mimeType: stringField(record, 'mimeType'),
    plaintextSize: safeSize(plaintextSize, VAULT_MAX_PLAINTEXT_BYTES, 'plaintext size'),
    encryptedSize: safeSize(encryptedSize, ENCRYPTED_VAULT_MAX_ENCRYPTED_BYTES, 'encrypted size'),
  });
  const algorithm = stringField(record, 'algorithm');
  if (algorithm !== VAULT_ALGORITHM) throw new Error('Encrypted vault algorithm is unsupported');
  const keyId = stringField(record, 'keyId');
  if (!/^[0-9a-f]{32}$/.test(keyId)) throw new Error('Encrypted vault key ID is malformed');
  const wrapNonce = canonicalBase64(stringField(record, 'wrapNonce'), 12, 'wrap nonce');
  const wrappedKey = canonicalBase64(stringField(record, 'wrappedKey'), 48, 'wrapped key');
  const status = stringField(record, 'status');
  if (status !== 'active' && status !== 'revoked') throw new Error('Encrypted vault status is malformed');
  const index = bigintField(record, 'index');
  const revision = bigintField(record, 'revision');
  if (index === 0n || index > ENCRYPTED_VAULT_MAX_OBJECTS || revision === 0n) {
    throw new Error('Encrypted vault index or revision exceeds its bound');
  }
  return {
    objectId: binding.objectId,
    owner,
    label: binding.label,
    filename: binding.filename,
    mimeType: binding.mimeType,
    cid: normalizeCanonicalFileCid(stringField(record, 'cid')),
    encryptedSize,
    plaintextSize,
    algorithm,
    keyId,
    wrapNonce,
    wrappedKey,
    status,
    index,
    revision,
    createdAtHeight: bigintField(record, 'createdAtHeight'),
    updatedAtHeight: bigintField(record, 'updatedAtHeight'),
  };
}

function objectId(value: string): string {
  if (!/^[0-9a-f]{32}$/.test(value)) throw new Error('Encrypted vault object ID must be 32 lowercase hex characters');
  return value;
}

function options(value: EncryptedVaultMutationOptions, gasLimit = 750_000) {
  return {
    gasLimit: value.gasLimit ?? gasLimit,
    timeoutMs: value.timeoutMs ?? 60_000,
    expiryHeight: value.expiryHeight,
    waitForConfirmation: true,
  } as const;
}

function binding(record: EncryptedVaultObject) {
  return {
    objectId: record.objectId,
    label: record.label,
    filename: record.filename,
    mimeType: record.mimeType,
    plaintextSize: safeSize(record.plaintextSize, VAULT_MAX_PLAINTEXT_BYTES, 'plaintext size'),
    encryptedSize: safeSize(record.encryptedSize, ENCRYPTED_VAULT_MAX_ENCRYPTED_BYTES, 'encrypted size'),
  };
}

function envelope(record: EncryptedVaultObject): VaultKeyEnvelope {
  return { keyId: record.keyId, wrapNonce: record.wrapNonce, wrappedKey: record.wrappedKey };
}

export class EncryptedHouseholdVaultClient {
  readonly provider: RiadchainProvider;
  readonly contractAddress: EthAddress;

  constructor(provider: RiadchainProvider, vaultAddress: EthAddress) {
    this.provider = provider;
    this.contractAddress = contractAddress(vaultAddress);
  }

  async get(id: string): Promise<EncryptedVaultObject | null> {
    const result = await this.provider.callView(this.contractAddress, 'get', { objectId: objectId(id) });
    return result.returnValue === null ? null : decodeObject(result.returnValue);
  }

  async list(cursor = 0n, limit = ENCRYPTED_VAULT_MAX_PAGE_SIZE): Promise<EncryptedVaultPage> {
    if (cursor < 0n || cursor > ENCRYPTED_VAULT_MAX_OBJECTS) throw new Error('Encrypted vault cursor exceeds its bound');
    if (limit <= 0n || limit > ENCRYPTED_VAULT_MAX_PAGE_SIZE) throw new Error('Encrypted vault page limit must be between 1 and 50');
    const result = await this.provider.callView(this.contractAddress, 'list', { cursor, limit });
    const page = asRecord(result.returnValue, 'Encrypted vault page');
    if (!Array.isArray(page.objects) || typeof page.hasMore !== 'boolean') throw new Error('Encrypted vault page is malformed');
    const nextCursor = bigintField(page, 'nextCursor');
    const total = bigintField(page, 'total');
    if (page.objects.length > Number(limit) || total > ENCRYPTED_VAULT_MAX_OBJECTS
      || nextCursor < cursor || nextCursor > total || page.hasMore !== (nextCursor < total)) {
      throw new Error('Encrypted vault page cursors are inconsistent');
    }
    return { objects: page.objects.map(decodeObject), nextCursor, hasMore: page.hasMore, total };
  }

  prepare(
    plaintext: Uint8Array,
    input: { label: string; filename: string; mimeType: string; objectId?: string },
    masterKey: VaultMasterKey,
  ): PreparedVaultObject {
    return encryptVaultObject(plaintext, input, masterKey);
  }

  async registerUploaded(
    wallet: WalletSession,
    prepared: PreparedVaultObject,
    cid: string,
    mutation: EncryptedVaultMutationOptions = {},
  ): Promise<EncryptedVaultObject> {
    validatePreparedVaultObject(prepared);
    const canonicalCid = normalizeCanonicalFileCid(cid);
    const described = await describeFileText(prepared.blob);
    if (described.cid !== canonicalCid || described.size !== prepared.encryptedSize) {
      throw new Error('Encrypted vault upload CID or size does not match prepared bytes');
    }
    await this.mutate(wallet, 'register', {
      objectId: prepared.objectId,
      label: prepared.label,
      filename: prepared.filename,
      mimeType: prepared.mimeType,
      cid: canonicalCid,
      encryptedSize: BigInt(prepared.encryptedSize),
      plaintextSize: BigInt(prepared.plaintextSize),
      keyId: prepared.keyEnvelope.keyId,
      wrapNonce: prepared.keyEnvelope.wrapNonce,
      wrappedKey: prepared.keyEnvelope.wrappedKey,
    }, mutation);
    const record = await this.get(prepared.objectId);
    if (record === null || record.cid !== canonicalCid || record.owner !== wallet.address) {
      throw new Error('Confirmed encrypted vault metadata is unavailable');
    }
    return record;
  }

  async encryptAndUpload(
    wallet: WalletSession,
    plaintext: Uint8Array,
    input: { label: string; filename: string; mimeType: string; objectId?: string },
    masterKey: VaultMasterKey,
    mutation: EncryptedVaultMutationOptions = {},
  ): Promise<{ object: EncryptedVaultObject; fileTxId: string }> {
    const prepared = this.prepare(plaintext, input, masterKey);
    return this.uploadPrepared(wallet, prepared, mutation);
  }

  async uploadPrepared(
    wallet: WalletSession,
    prepared: PreparedVaultObject,
    mutation: EncryptedVaultMutationOptions = {},
  ): Promise<{ object: EncryptedVaultObject; fileTxId: string }> {
    validatePreparedVaultObject(prepared);
    const uploaded = await wallet.sendFile({
      filename: `${prepared.objectId}.riadvault`,
      content: prepared.blob,
      mimeType: 'application/vnd.riadchain.vault+json',
    }, { waitForConfirmation: true, timeoutMs: mutation.timeoutMs ?? 180_000, expiryHeight: mutation.expiryHeight });
    const object = await this.registerUploaded(wallet, prepared, uploaded.cid, mutation);
    return { object, fileTxId: uploaded.tx.id };
  }

  async downloadAndDecrypt(
    record: EncryptedVaultObject,
    masterKey: VaultMasterKey,
    options: { allowRevoked?: boolean } = {},
  ): Promise<Uint8Array> {
    if (record.status === 'revoked' && !options.allowRevoked) throw new Error('Encrypted vault object is revoked');
    const downloaded = await this.provider.fileCatText(record.cid);
    if (downloaded.cid !== record.cid) throw new Error('Node returned another encrypted FILE CID');
    const described = await describeFileText(downloaded.content);
    if (described.cid !== record.cid || BigInt(described.size) !== record.encryptedSize) {
      throw new Error('Downloaded encrypted FILE failed CID or size verification');
    }
    return decryptVaultObject(downloaded.content, binding(record), envelope(record), masterKey);
  }

  async rotateEnvelope(
    wallet: WalletSession,
    record: EncryptedVaultObject,
    previous: VaultMasterKey,
    next: VaultMasterKey,
    mutation: EncryptedVaultMutationOptions = {},
  ): Promise<EncryptedVaultObject> {
    if (record.status !== 'active') throw new Error('Encrypted vault object is revoked');
    const nextEnvelope = rewrapVaultKey(record.objectId, envelope(record), previous, next);
    await this.mutate(wallet, 'rotateEnvelope', { objectId: record.objectId, ...nextEnvelope }, mutation);
    const updated = await this.get(record.objectId);
    if (updated === null || updated.keyId !== next.keyId || updated.revision !== record.revision + 1n) {
      throw new Error('Confirmed encrypted vault key rotation is unavailable');
    }
    return updated;
  }

  async revoke(wallet: WalletSession, id: string, mutation: EncryptedVaultMutationOptions = {}): Promise<EncryptedVaultObject> {
    const normalizedId = objectId(id);
    await this.mutate(wallet, 'revoke', { objectId: normalizedId }, mutation);
    const record = await this.get(normalizedId);
    if (record?.status !== 'revoked') throw new Error('Confirmed encrypted vault revocation is unavailable');
    return record;
  }

  private async mutate(
    wallet: WalletSession,
    method: string,
    data: Record<string, unknown>,
    mutation: EncryptedVaultMutationOptions,
  ): Promise<TransactionReceipt> {
    const sent = await wallet.sendContractCall(this.contractAddress, method, data, options(mutation));
    const receipt = await this.provider.getReceipt(sent.tx.id);
    if (!receipt.success) throw new Error(receipt.error ?? `Encrypted vault ${method} failed`);
    return receipt;
  }
}

export async function deployEncryptedHouseholdVault(
  wallet: WalletSession,
  charlieSource: string,
  options: { salt: string; gasLimit?: number; timeoutMs?: number; upgradeAuthority?: EthAddress | null },
): Promise<{ txId: string; contractAddress: EthAddress; client: EncryptedHouseholdVaultClient }> {
  if (!charlieSource.trim()) throw new Error('Encrypted household vault source must not be empty');
  const deployed = await wallet.sendContractDeploy(charlieSource, {
    salt: options.salt,
    gasLimit: options.gasLimit ?? 1_500_000,
    timeoutMs: options.timeoutMs ?? 60_000,
    waitForConfirmation: true,
    upgradeAuthority: options.upgradeAuthority,
  });
  const address = contractAddress(deployed.contractAddress);
  return { txId: deployed.tx.id, contractAddress: address, client: new EncryptedHouseholdVaultClient(wallet.provider, address) };
}
