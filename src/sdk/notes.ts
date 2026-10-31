import { encodeContractArguments } from '../lib/contractArguments.ts';
import { buildContractCallTx } from '../lib/txUtils.ts';
import { getAddressKind, isAccountAddress, type EthAddress } from './internal/crypto.ts';
import { RiadchainProvider } from './provider.ts';
import { LocalSigner } from './signer.ts';
import type { DeviceCapability, Transaction, UTXO } from './types.ts';
import { NOTES_MAX_CIPHERTEXT_BYTES, normalizeNotesId, normalizeNotesVersion } from './notesCrypto.ts';

export type NotesDescriptor = { noteId: string; revision: bigint };
export type EncryptedNote = NotesDescriptor & { ciphertext: string };
export type NotesPage = { ownerVersion: bigint; notes: NotesDescriptor[]; nextCursor: string | null };
export type NotesMetadata = { format: 'riadchain-notes'; version: 1n; maxCiphertextBytes: bigint; maxPageSize: bigint };
export type NotesAction = { method: 'putNote'; noteId: string; expectedRevision: bigint; expectedOwnerVersion: bigint; ciphertext: string }
  | { method: 'deleteNote'; noteId: string; expectedRevision: bigint; expectedOwnerVersion: bigint };
export const NOTES_METHODS = ['deleteNote', 'putNote', 'FILE'] as const;
export const NOTES_CALL_GAS = 150_000;

function canonicalAccount(value: EthAddress): EthAddress {
  if (!isAccountAddress(value) || value !== value.toLowerCase()) throw new Error('Invalid canonical Notes owner'); return value;
}
function canonicalContract(value: EthAddress): EthAddress {
  if (!['contract', 'internal_contract'].includes(getAddressKind(value)) || value !== value.toLowerCase()) throw new Error('Invalid Notes contract'); return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Notes contract result'); return value as Record<string, unknown>;
}
function descriptor(value: unknown): NotesDescriptor {
  const row = object(value), noteId = normalizeNotesId(row.noteId as string), revision = normalizeNotesVersion(row.revision as bigint);
  if (!revision) throw new Error('Malformed Notes descriptor revision'); return { noteId, revision };
}
export function notesActionArguments(action: NotesAction): Record<string, unknown> {
  normalizeNotesId(action.noteId); normalizeNotesVersion(action.expectedRevision); normalizeNotesVersion(action.expectedOwnerVersion);
  if (action.expectedOwnerVersion === (1n << 64n) - 1n || action.expectedRevision > action.expectedOwnerVersion) throw new Error('Invalid Notes mutation version');
  const data = { noteId: action.noteId, expectedRevision: action.expectedRevision, expectedOwnerVersion: action.expectedOwnerVersion };
  if (action.method === 'deleteNote') { if (!action.expectedRevision) throw new Error('Cannot delete an absent note'); return data; }
  if (action.method !== 'putNote' || typeof action.ciphertext !== 'string' || !action.ciphertext.length || new TextEncoder().encode(action.ciphertext).length > NOTES_MAX_CIPHERTEXT_BYTES) throw new Error('Invalid Notes ciphertext');
  return { ...data, ciphertext: action.ciphertext };
}
export function buildNotesCallTx(chainId: string, owner: EthAddress, contract: EthAddress, action: NotesAction, timestamp: number, utxos: UTXO[], options: Partial<Parameters<typeof buildContractCallTx>[7]> = {}) {
  return buildContractCallTx(chainId, canonicalAccount(owner), canonicalContract(contract), action.method, encodeContractArguments(notesActionArguments(action)), timestamp, utxos, { gasLimit: NOTES_CALL_GAS, ...options });
}
export function buildDelegatedNotesCall(signer: LocalSigner, chainId: string, contract: EthAddress, action: NotesAction, options: Parameters<LocalSigner['buildDelegatedContractCall']>[3]): Transaction {
  if (options.chainId !== chainId) throw new Error('Notes transaction chain mismatch');
  return signer.buildDelegatedContractCall(canonicalContract(contract), action.method, encodeContractArguments(notesActionArguments(action)), options);
}
/** Validate the complete permission, including native actor and FILE limits, before automation. */
export function assertNotesCapability(capability: DeviceCapability, expected: { owner: EthAddress; delegate: EthAddress; contract: EthAddress; height: number }): void {
  if (capability.owner !== expected.owner || capability.delegate !== expected.delegate || capability.contractAddress !== expected.contract || capability.delegateAsActor
    || capability.revoked || !Number.isSafeInteger(capability.expiresAtHeight) || capability.expiresAtHeight <= expected.height || capability.maxGasPerCall !== NOTES_CALL_GAS
    || !Number.isSafeInteger(capability.maxCallsPerBlock) || capability.maxCallsPerBlock < 1 || capability.maxCallsPerBlock > 4
    || capability.methods.length !== NOTES_METHODS.length || capability.methods.some(method => !NOTES_METHODS.includes(method as typeof NOTES_METHODS[number]))
    || new Set(capability.methods).size !== NOTES_METHODS.length || !Number.isSafeInteger(capability.nextSequence) || capability.nextSequence < 0
    || typeof capability.feeBalance !== 'bigint' || capability.feeBalance < 0n || !Number.isSafeInteger(capability.storageRemainingBytes) || capability.storageRemainingBytes < 0) throw new Error('Notes capability is inactive or does not match this device and notebook');
}

export class NotesClient {
  readonly provider: RiadchainProvider;
  readonly contractAddress: EthAddress;
  constructor(provider: RiadchainProvider, contract: EthAddress) { this.provider = provider; this.contractAddress = canonicalContract(contract); }
  async metadata(): Promise<NotesMetadata> {
    const row = object((await this.provider.callView(this.contractAddress, 'getMetadata')).returnValue);
    if (row.format !== 'riadchain-notes' || row.version !== 1n || row.maxCiphertextBytes !== BigInt(NOTES_MAX_CIPHERTEXT_BYTES) || row.maxPageSize !== 50n) throw new Error('Selected contract is not the supported Notes contract');
    return row as NotesMetadata;
  }
  async ownerVersion(account: EthAddress): Promise<bigint> {
    return normalizeNotesVersion((await this.provider.callView(this.contractAddress, 'ownerVersion', { owner: canonicalAccount(account) })).returnValue as bigint);
  }
  async get(account: EthAddress, noteId: string): Promise<EncryptedNote | null> {
    const value = (await this.provider.callView(this.contractAddress, 'getNote', { owner: canonicalAccount(account), noteId: normalizeNotesId(noteId) })).returnValue;
    if (value === null) return null;
    const row = object(value), d = descriptor(row);
    if (d.noteId !== noteId || typeof row.ciphertext !== 'string' || !row.ciphertext.length || new TextEncoder().encode(row.ciphertext).length > NOTES_MAX_CIPHERTEXT_BYTES) throw new Error('Node returned another or malformed encrypted note');
    return { ...d, ciphertext: row.ciphertext };
  }
  async list(account: EthAddress, options: { after?: string | null; limit?: number } = {}): Promise<NotesPage> {
    canonicalAccount(account); const limit = options.limit ?? 50, prefix = `notes/index/${account}/`, after = options.after ?? null;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (after !== null && (!after.startsWith(prefix) || !/^[0-9a-f]{32}$/.test(after.slice(prefix.length))))) throw new Error('Invalid Notes page cursor or limit');
    const row = object((await this.provider.callView(this.contractAddress, 'listNotes', { owner: account, after, limit: BigInt(limit) })).returnValue);
    const ownerVersion = normalizeNotesVersion(row.ownerVersion as bigint);
    if (!Array.isArray(row.notes) || row.notes.length > limit || (row.nextCursor !== null && typeof row.nextCursor !== 'string')) throw new Error('Malformed Notes page');
    const notes = row.notes.map(descriptor); let previous = after;
    for (const note of notes) { const cursor = `${prefix}${note.noteId}`; if ((previous !== null && cursor <= previous) || note.revision > ownerVersion) throw new Error('Notes page ordering or revision is inconsistent'); previous = cursor; }
    if (row.nextCursor !== null && (!notes.length || row.nextCursor !== previous)) throw new Error('Malformed Notes continuation cursor');
    return { ownerVersion, notes, nextCursor: row.nextCursor as string | null };
  }
}
