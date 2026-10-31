import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getAddressFromPrivateKey, getAddressKind, isAccountAddress, type EthAddress } from './internal/crypto.ts';
import { normalizeCanonicalFileCid } from '../lib/filePayload.ts';

export type NotesScope = { account: EthAddress; chainId: string; contract: EthAddress };
export type NotesAttachment = { id: string; cid: string; fileTxId: string; size: number; encryptedSize: number; name: string; mimeType: string };
export type NoteContent = { title: string; body: string; attachments: NotesAttachment[] };
export type NotesRandomSource = (length: number) => Uint8Array;
export const NOTES_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const NOTES_ATTACHMENT_OVERHEAD = 32;
export const NOTES_MAX_NOTE_PLAINTEXT_BYTES = 45_000;
export const NOTES_MAX_CIPHERTEXT_BYTES = 64_000;
export const NOTES_MAX_ATTACHMENTS = 16;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const NOTE_MAGIC = new Uint8Array([82, 78, 78, 49]); // RNN1
const FILE_MAGIC = new Uint8Array([82, 78, 70, 49]); // RNF1
const U64_MAX = (1n << 64n) - 1n;

export function normalizeNotesScope(scope: NotesScope): NotesScope {
  if (!scope || !isAccountAddress(scope.account) || scope.account !== scope.account.toLowerCase()
    || !['contract', 'internal_contract'].includes(getAddressKind(scope.contract)) || scope.contract !== scope.contract.toLowerCase()
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scope.chainId)) throw new Error('Invalid Notes account, chain or contract binding');
  return { account: scope.account, chainId: scope.chainId, contract: scope.contract };
}
export function normalizeNotesId(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new Error('Notes ID must be 32 lowercase hexadecimal characters');
  return value;
}
export function normalizeNotesVersion(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw new Error('Notes revision must be an unsigned 64-bit integer');
  return value;
}
function random(length: number, source?: NotesRandomSource): Uint8Array {
  const bytes = source ? source(length) : globalThis.crypto.getRandomValues(new Uint8Array(length));
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('Notes random source returned invalid bytes');
  return bytes.slice();
}
export function createNotesId(source?: NotesRandomSource): string { return bytesToHex(random(16, source)); }
function keyBytes(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('Notes key must contain exactly 32 bytes');
  return key;
}
function scopeParts(scope: NotesScope) { const s = normalizeNotesScope(scope); return [s.account, s.chainId, s.contract]; }
/** Derive a dedicated encryption key; never use the spending key directly as an AES key. */
export function deriveNotesKey(privateKey: string, scope: NotesScope): Uint8Array {
  let address: string | null = null;
  try { if (/^[0-9a-f]{64}$/i.test(privateKey)) address = getAddressFromPrivateKey(privateKey); } catch { /* Secret material never enters an error message. */ }
  if (address !== scope.account) throw new Error('Wallet key does not match the Notes owner');
  const source = hexToBytes(privateKey);
  try { return hkdf(sha256, source, sha256(encoder.encode('riadchain.notes.key.v1')), encoder.encode(JSON.stringify(scopeParts(scope))), 32); }
  finally { source.fill(0); }
}
function aad(kind: 'note' | 'attachment', scope: NotesScope, id: string, revision?: bigint) {
  const binding = [`riadchain.notes.${kind}.v1`, ...scopeParts(scope), normalizeNotesId(id)];
  if (kind === 'note') {
    normalizeNotesVersion(revision!); if (revision === 0n) throw new Error('Encrypted note revision must be positive');
    binding.push(revision!.toString());
  }
  return encoder.encode(JSON.stringify(binding));
}
function seal(key: Uint8Array, magic: Uint8Array, associated: Uint8Array, plaintext: Uint8Array, source?: NotesRandomSource) {
  const nonce = random(12, source), encrypted = gcm(keyBytes(key), nonce, associated).encrypt(plaintext);
  const result = new Uint8Array(16 + encrypted.length);
  result.set(magic); result.set(nonce, 4); result.set(encrypted, 16); return result;
}
function open(key: Uint8Array, magic: Uint8Array, associated: Uint8Array, encrypted: Uint8Array, maximum: number) {
  if (!(encrypted instanceof Uint8Array) || encrypted.length < NOTES_ATTACHMENT_OVERHEAD || encrypted.length > maximum + NOTES_ATTACHMENT_OVERHEAD
    || magic.some((byte, index) => encrypted[index] !== byte)) throw new Error('Unsupported or oversized Notes encrypted envelope');
  try { return gcm(keyBytes(key), encrypted.subarray(4, 16), associated).decrypt(encrypted.subarray(16)); }
  catch { throw new Error('Notes content authentication failed'); }
}
function base64(bytes: Uint8Array) {
  let text = ''; for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
function unbase64(text: string) {
  if (typeof text !== 'string' || text.length > NOTES_MAX_CIPHERTEXT_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('Invalid Notes ciphertext encoding');
  const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
  if (base64(bytes) !== text) throw new Error('Invalid Notes ciphertext encoding'); return bytes;
}
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error('Invalid Notes content schema');
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid Notes ${field}`);
  if (encoder.encode(value).length > maximum) throw new Error(`Notes ${field} exceeds the ${maximum.toLocaleString('en-US')}-byte limit`);
  return value;
}
export function parseNoteContent(value: unknown): NoteContent {
  const row = record(value, ['title', 'body', 'attachments']);
  if (!Array.isArray(row.attachments) || row.attachments.length > NOTES_MAX_ATTACHMENTS) throw new Error('Invalid Notes attachments');
  const attachments = row.attachments.map(value => {
    const a = record(value, ['id', 'cid', 'fileTxId', 'size', 'encryptedSize', 'name', 'mimeType']);
    const id = normalizeNotesId(a.id as string), cid = normalizeCanonicalFileCid(a.cid as string);
    if (typeof a.fileTxId !== 'string' || !/^[0-9a-f]{64}$/.test(a.fileTxId) || !Number.isSafeInteger(a.size) || (a.size as number) < 1 || (a.size as number) > NOTES_MAX_ATTACHMENT_BYTES
      || a.encryptedSize !== (a.size as number) + NOTES_ATTACHMENT_OVERHEAD) throw new Error('Invalid Notes attachment identity or size');
    const name = boundedText(a.name, 255, 'filename'), mimeType = boundedText(a.mimeType, 127, 'MIME type');
    if (!name || /[\x00-\x1f]/.test(name) || !mimeType || /[\x00-\x1f]/.test(mimeType)) throw new Error('Invalid Notes attachment presentation');
    return { id, cid, fileTxId: a.fileTxId, size: a.size as number, encryptedSize: a.encryptedSize as number, name, mimeType };
  });
  if (new Set(attachments.map(a => a.id)).size !== attachments.length) throw new Error('Duplicate Notes attachment ID');
  const content = { title: boundedText(row.title, 256, 'title'), body: boundedText(row.body, NOTES_MAX_NOTE_PLAINTEXT_BYTES, 'body'), attachments };
  if (encoder.encode(JSON.stringify(content)).length > NOTES_MAX_NOTE_PLAINTEXT_BYTES) throw new Error('Note content exceeds the 45,000-byte encrypted-document limit');
  return content;
}
export function encryptNote(key: Uint8Array, scope: NotesScope, noteId: string, revision: bigint, content: NoteContent, source?: NotesRandomSource): string {
  return base64(seal(key, NOTE_MAGIC, aad('note', scope, noteId, revision), encoder.encode(JSON.stringify(parseNoteContent(content))), source));
}
export function decryptNote(key: Uint8Array, scope: NotesScope, noteId: string, revision: bigint, ciphertext: string): NoteContent {
  const plaintext = open(key, NOTE_MAGIC, aad('note', scope, noteId, revision), unbase64(ciphertext), NOTES_MAX_NOTE_PLAINTEXT_BYTES);
  try { return parseNoteContent(JSON.parse(decoder.decode(plaintext))); }
  catch { throw new Error('Authenticated Notes document has an invalid format'); }
  finally { plaintext.fill(0); }
}
/** A stable attachment ID permits same-owner conflict copies to reuse its original FILE. */
export function encryptNotesAttachment(key: Uint8Array, scope: NotesScope, attachmentId: string, bytes: Uint8Array, source?: NotesRandomSource): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > NOTES_MAX_ATTACHMENT_BYTES) throw new Error('Notes attachment must contain 1 byte to 10 MiB');
  return seal(key, FILE_MAGIC, aad('attachment', scope, attachmentId), bytes, source);
}
export function decryptNotesAttachment(key: Uint8Array, scope: NotesScope, attachmentId: string, bytes: Uint8Array): Uint8Array {
  const plaintext = open(key, FILE_MAGIC, aad('attachment', scope, attachmentId), bytes, NOTES_MAX_ATTACHMENT_BYTES);
  if (!plaintext.length) throw new Error('Empty Notes attachment'); return plaintext;
}
