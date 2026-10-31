import { z } from 'zod';
import { encodeContractArguments } from '../lib/contractArguments.ts';
import { normalizeCanonicalFileCid } from '../lib/filePayload.ts';
import type { ProtocolParams } from '../lib/protocolParams.ts';
import { buildContractCallTx, calculateRequiredFee } from './internal/txUtils.ts';
import { getAddressKind, isAccountAddress, isValidAddress, type EthAddress } from './internal/crypto.ts';
import type { RiadchainProvider } from './provider.ts';
import type { Transaction, UTXO } from './types.ts';

export const NAME_MAX_ENTRIES = 4096n;
export const NAME_MAX_PAGE_SIZE = 50n;
export const NAME_ENTITY_KINDS = ['machine', 'robot', 'agent', 'service', 'person', 'node'] as const;

export type NameEntityKind = typeof NAME_ENTITY_KINDS[number];
export type NameServiceTransport = 'connect' | 'http' | 'https' | 'mqtt' | 'tcp' | 'custom';
export type NameDestination =
  | { kind: 'address'; target: EthAddress; transport: '' }
  | { kind: 'contract'; target: EthAddress; transport: '' }
  | { kind: 'file'; target: string; transport: '' }
  | { kind: 'service'; target: string; transport: NameServiceTransport };
export type NameDestinationInput =
  | { kind: 'address'; target: EthAddress; transport?: '' }
  | { kind: 'contract'; target: EthAddress; transport?: '' }
  | { kind: 'file'; target: string; transport?: '' }
  | { kind: 'service'; target: string; transport: NameServiceTransport };
export type NameProfile = {
  label: string;
  entityKind: NameEntityKind;
  destination: NameDestination;
  metadata: string;
};
export type NameProfileInput = Omit<NameProfile, 'destination'> & { destination: NameDestinationInput };
export type NameRecord = NameProfile & {
  name: string;
  owner: EthAddress;
  status: 'active' | 'revoked';
  index: bigint;
  revision: bigint;
  createdAtBlock: bigint;
  updatedAtBlock: bigint;
};
export type NamePage = { entries: NameRecord[]; nextCursor: bigint; hasMore: boolean; total: bigint };
export type NameRegistryAction =
  | { method: 'register'; name: string; profile: NameProfileInput }
  | { method: 'update'; name: string; profile: NameProfileInput; expectedRevision: bigint }
  | { method: 'transferOwnership'; name: string; owner: EthAddress; expectedRevision: bigint }
  | { method: 'revoke'; name: string; expectedRevision: bigint };
export type NameRegistryCallOptions = { gasLimit: number; expiryHeight: number; protocolParams: ProtocolParams };

const textEncoder = new TextEncoder();
const MAX_U64 = (1n << 64n) - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const chainIdSchema = z.string().min(1).max(128).refine(value => value.trim() === value, 'Expected the exact consensus chain ID');
const nameSchema = z.string().min(1).max(96).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
const accountDestinationSchema = z.string().refine(value => value === value.toLowerCase() && isAccountAddress(value), 'Expected a canonical account address').transform(value => value as EthAddress);
const accountSchema = accountDestinationSchema.refine(value => value !== ZERO_ADDRESS, 'Expected a nonzero account owner');
const contractSchema = z.string().refine(value => value === value.toLowerCase() && isValidAddress(value) && getAddressKind(value) !== 'account', 'Expected a canonical contract address').transform(value => value as EthAddress);
const unicodeSchema = z.string().refine(value => new TextDecoder('utf-8', { ignoreBOM: true }).decode(textEncoder.encode(value)) === value, 'Expected well-formed Unicode text');
const labelSchema = unicodeSchema.min(1).refine(value => textEncoder.encode(value).length <= 80, 'Label must contain 1-80 UTF-8 bytes');
const metadataSchema = unicodeSchema.refine(value => textEncoder.encode(value).length <= 512, 'Metadata must not exceed 512 UTF-8 bytes');
const uintSchema = z.bigint().min(0n).max(MAX_U64);
const revisionSchema = uintSchema.min(1n);
const mutableRevisionSchema = revisionSchema.max(MAX_U64 - 1n);
const destinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('address'), target: accountDestinationSchema, transport: z.literal('') }).strict(),
  z.object({ kind: z.literal('contract'), target: contractSchema, transport: z.literal('') }).strict(),
  z.object({ kind: z.literal('file'), target: z.string().refine(value => {
    try { return normalizeCanonicalFileCid(value) === value; } catch { return false; }
  }, 'Expected a canonical FILE CID'), transport: z.literal('') }).strict(),
  z.object({ kind: z.literal('service'), target: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/), transport: z.enum(['connect', 'http', 'https', 'mqtt', 'tcp', 'custom']) }).strict(),
]);
const profileShape = { label: labelSchema, entityKind: z.enum(NAME_ENTITY_KINDS), destination: destinationSchema, metadata: metadataSchema };
const profileSchema: z.ZodType<NameProfile> = z.object(profileShape).strict();
const recordSchema: z.ZodType<NameRecord> = z.object({
  ...profileShape,
  name: nameSchema,
  owner: accountSchema,
  status: z.enum(['active', 'revoked']),
  index: uintSchema.min(1n).max(NAME_MAX_ENTRIES),
  revision: revisionSchema,
  createdAtBlock: uintSchema,
  updatedAtBlock: uintSchema,
}).strict().refine(value => value.updatedAtBlock >= value.createdAtBlock, 'Updated height precedes creation');
const actionSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('register'), name: nameSchema, profile: profileSchema }).strict(),
  z.object({ method: z.literal('update'), name: nameSchema, profile: profileSchema, expectedRevision: mutableRevisionSchema }).strict(),
  z.object({ method: z.literal('transferOwnership'), name: nameSchema, owner: accountSchema, expectedRevision: mutableRevisionSchema }).strict(),
  z.object({ method: z.literal('revoke'), name: nameSchema, expectedRevision: mutableRevisionSchema }).strict(),
]);

/** Normalize user input. Node-returned identity fields are validated without rewriting. */
export function normalizeName(value: string): string {
  return nameSchema.parse(value.trim().toLowerCase());
}

export function normalizeNameProfile(input: NameProfileInput): NameProfile {
  const destination = input.destination;
  return profileSchema.parse({
    ...input,
    destination: {
      ...destination,
      target: destination.kind === 'address' || destination.kind === 'contract'
        ? destination.target.toLowerCase() : destination.kind === 'service' ? destination.target.trim() : destination.target,
      transport: destination.transport ?? '',
    },
  });
}

export function normalizeNameRegistryAction(input: NameRegistryAction): NameRegistryAction {
  return actionSchema.parse({
    ...input,
    name: normalizeName(input.name),
    ...('profile' in input ? { profile: normalizeNameProfile(input.profile) } : {}),
    ...(input.method === 'transferOwnership' ? { owner: input.owner.toLowerCase() } : {}),
  });
}

/** Build an ordinary unsigned transaction. Callers own review, chain/code checks and durable submission recovery. */
export function buildNameRegistryCallTx(
  chainId: string,
  sender: EthAddress,
  registryAddress: EthAddress,
  action: NameRegistryAction,
  timestamp: number,
  utxos: UTXO[],
  options: NameRegistryCallOptions,
): { tx: Transaction; fee: bigint } {
  chainIdSchema.parse(chainId);
  const account = accountSchema.parse(sender.toLowerCase());
  const address = contractSchema.parse(registryAddress.toLowerCase());
  if (!Number.isSafeInteger(timestamp) || timestamp < 0
    || !Number.isSafeInteger(options.gasLimit) || options.gasLimit <= 0
    || !Number.isSafeInteger(options.expiryHeight) || options.expiryHeight <= 0
    || !options.protocolParams) throw new Error('Name transaction requires timestamp, gas, expiry and live protocol parameters');
  const intent = normalizeNameRegistryAction(action);
  const { method, name } = intent;
  const data = method === 'register' || method === 'update'
    ? { name, ...intent.profile, ...(method === 'update' ? { expectedRevision: intent.expectedRevision } : {}) }
    : method === 'transferOwnership'
      ? { name, owner: intent.owner, expectedRevision: intent.expectedRevision }
      : { name, expectedRevision: intent.expectedRevision };
  const built = buildContractCallTx(chainId, account, address, method, encodeContractArguments(data, { maxBigIntBits: options.protocolParams.vmLimits.maxBigIntBits }), timestamp, utxos, { gasLimit: options.gasLimit, expiryHeight: options.expiryHeight, protocolParams: options.protocolParams });
  if ('error' in built) throw new Error(built.error);
  return { tx: built.tx, fee: calculateRequiredFee(built.tx, undefined, options.protocolParams) };
}

/** Names are scoped to this provider's chain and this registry. Destinations are public intent, not proof of endpoint identity or availability. */
export class NameRegistryClient {
  readonly provider: Pick<RiadchainProvider, 'callView' | 'getChainId'>;
  readonly contractAddress: EthAddress;
  readonly chainId: string;

  constructor(provider: Pick<RiadchainProvider, 'callView' | 'getChainId'>, registryAddress: EthAddress, expectedChainId: string) {
    this.provider = provider;
    this.contractAddress = contractSchema.parse(registryAddress.toLowerCase());
    this.chainId = chainIdSchema.parse(expectedChainId);
  }

  async get(name: string): Promise<NameRecord | null> {
    const canonical = normalizeName(name);
    const result = await this.view('get', { name: canonical });
    if (result.returnValue === null) return null;
    const record = recordSchema.parse(result.returnValue);
    if (record.name !== canonical) throw new Error('Registry returned a different name');
    return record;
  }

  async resolve(name: string): Promise<NameDestination | null> {
    const result = await this.view('resolve', { name: normalizeName(name) });
    return result.returnValue === null ? null : destinationSchema.parse(result.returnValue);
  }

  async resolveAddress(name: string): Promise<EthAddress | null> {
    return (await this.resolveExpected(name, 'address'))?.target ?? null;
  }

  async resolveContract(name: string): Promise<EthAddress | null> {
    return (await this.resolveExpected(name, 'contract'))?.target ?? null;
  }

  async resolveFile(name: string): Promise<string | null> {
    return (await this.resolveExpected(name, 'file'))?.target ?? null;
  }

  async resolveService(name: string): Promise<Extract<NameDestination, { kind: 'service' }> | null> {
    return this.resolveExpected(name, 'service');
  }

  async list(cursor = 0n, limit = NAME_MAX_PAGE_SIZE): Promise<NamePage> {
    uintSchema.max(NAME_MAX_ENTRIES).parse(cursor);
    uintSchema.min(1n).max(NAME_MAX_PAGE_SIZE).parse(limit);
    const result = await this.view('list', { cursor, limit });
    const page = z.object({ entries: z.array(recordSchema).max(Number(limit)), nextCursor: uintSchema, hasMore: z.boolean(), total: uintSchema.max(NAME_MAX_ENTRIES) }).strict().parse(result.returnValue);
    const count = page.total < cursor ? -1n : page.total - cursor < limit ? page.total - cursor : limit;
    if (BigInt(page.entries.length) !== count || page.nextCursor !== cursor + count
      || page.hasMore !== (page.nextCursor < page.total)
      || page.entries.some((entry, index) => entry.index !== cursor + BigInt(index) + 1n)
      || new Set(page.entries.map(entry => entry.name)).size !== page.entries.length) {
      throw new Error('Registry returned inconsistent page identities or cursors');
    }
    return page;
  }

  private async resolveExpected<K extends NameDestination['kind']>(name: string, kind: K): Promise<Extract<NameDestination, { kind: K }> | null> {
    const destination = await this.resolve(name);
    if (destination === null) return null;
    if (destination.kind !== kind) throw new Error(`Name ${normalizeName(name)} resolves to ${destination.kind}, not ${kind}`);
    return destination as Extract<NameDestination, { kind: K }>;
  }

  private async view(method: string, data: Record<string, unknown>) {
    if (await this.provider.getChainId() !== this.chainId) throw new Error('Name registry node reports a different chain');
    const result = await this.provider.callView(this.contractAddress, method, data);
    if (await this.provider.getChainId() !== this.chainId) throw new Error('Name registry node changed chains during the read');
    return result;
  }
}
