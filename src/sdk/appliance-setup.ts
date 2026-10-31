import { Encrypter } from 'age-encryption';
import { deriveAccountFromMnemonic, mnemonicFromEntropy, validateMnemonic } from '../lib/mnemonic.ts';
import { DEFAULT_PROTOCOL_PARAMS, normalizeNativeProtocolParamsShape, serializeProtocolParams, type ProtocolParams } from '../lib/protocolParams.ts';
import { getPublicKeyFromPrivateKey, hashData, isAccountAddress, signData, verifyAndRecover } from './internal/crypto.ts';
import {
  calculateCanonicalBlockHash, calculateCanonicalTransactionHash,
  type CanonicalBlock, type CanonicalTransaction,
} from './internal/canonicalChainEncoding.ts';

export const MAX_SETUP_BYTES = 262_144;
export const MAX_SEALED_KEY_BYTES = 12_288;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
export type SetupMachine = { device_id: string; setup_recipient: string; endpoint: string; rpc_endpoint: string };
export type CloudSetupMachine = { device_id: string; setup_recipient: string };
export type SetupProtocolActivation = { target_protocol_version: number; activation_height: number };
type SetupRequestBase = { version: 1; setup_id: string; chain_id: string; created_at_ms: number; protocol_params: ObjectValue; protocol_upgrades: SetupProtocolActivation[] };
export type SetupRequest = SetupRequestBase & (
  {kind:'riadchain-setup-request';machines:SetupMachine[]}
  | {kind:'riadchain-cloud-setup-request';machines:CloudSetupMachine[];network_id:string;initial_supply_satoshis:string}
);
export type GenesisConfig = { chain_id: string; initial_validator: string; protocol_params: ObjectValue; allocations: {address: string; amount_satoshis: string}[]; production_signers: Record<string, string>; timestamp_ms: number };
export type SetupPlan = { version: 1; kind: 'riadchain-setup-plan'; request: SetupRequest; genesis_config: GenesisConfig };
export type PreparedGenesis = { formatVersion: 1; config: GenesisConfig; genesisHash: string; genesisBlock: ObjectValue };
export type SealedSetup = { version: 1; kind: 'riadchain-sealed-setup'; setup_id: string; genesis: PreparedGenesis; protocol_upgrades: SetupProtocolActivation[]; machines: {device_id: string; production_owner: string; operational_address: string; sealed_key: string}[] };
export type SetupSecrets = { version: 1; request_digest: string; phrases: [string, string, string]; sealed_digest?: string; pending_sealed_digest?: string };
export type SetupDraft = { request: SetupRequest; plan: SetupPlan; backed_up: boolean; sealed?: SealedSetup };
/** Disposable fixtures may sign without claiming that a human made offline backups. */
export type SetupCustodyPolicy = 'require-offline-backup' | 'disposable-test';
function custodyReady(draft: SetupDraft, policy: SetupCustodyPolicy): boolean {
  return policy === 'disposable-test' || policy === 'require-offline-backup' && draft.backed_up;
}
const hex32 = /^[0-9a-f]{32}$/; const hex64 = /^[0-9a-f]{64}$/;
const zeroHash = '0'.repeat(64);
function object(value: unknown, keys?: string[]): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid setup object.');
  const result = value as ObjectValue;
  if (keys && (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)))) throw new Error('Unexpected or missing setup fields.');
  return result;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  const result = JSON.stringify(value); if (result === undefined) throw new Error('Invalid setup value.'); return result;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export const setupDigest = (value: unknown): string => hashData(canonicalJson(value));
export function parseSetupFile(text: string): unknown {
  if (new TextEncoder().encode(text).length > MAX_SETUP_BYTES) throw new Error('Setup file is too large.');
  return JSON.parse(text);
}
function endpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) throw new Error('Invalid machine endpoint.');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.port !== '8545' || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Machine endpoints must use a local numeric address on port 8545.');
  const ipv6 = /^\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(parsed.hostname);
  const octets = parsed.hostname.split('.').map(Number);
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname) && octets.every(n=>n<=255) && (octets[0]===10||octets[0]===192&&octets[1]===168||octets[0]===172&&octets[1]!>=16&&octets[1]!<=31||octets[0]===169&&octets[1]===254||octets[0]===100&&octets[1]!>=64&&octets[1]!<=127);
  if (!ipv4 && !ipv6) throw new Error('Use a numeric private LAN or VPN address. Scoped IPv6 addresses need an IPv4 route for setup.');
  return parsed.toString();
}
export function validateSetupRequest(value: unknown): SetupRequest {
  const cloud=object(value).kind==='riadchain-cloud-setup-request';
  const request = object(value, ['version','kind','setup_id','chain_id','created_at_ms','machines','protocol_params','protocol_upgrades',...(cloud?['network_id','initial_supply_satoshis']:[])]);
  // The authenticated appliance selects its latest implemented rules. Wallet
  // validation binds that public choice without maintaining a consensus table.
  if (!Array.isArray(request.protocol_upgrades) || request.protocol_upgrades.length > 1) throw new Error('Invalid starting protocol schedule.');
  for (const entry of request.protocol_upgrades) {
    const activation = object(entry, ['target_protocol_version','activation_height']);
    if (typeof activation.target_protocol_version !== 'number' || !Number.isSafeInteger(activation.target_protocol_version) || activation.target_protocol_version <= 1 || activation.target_protocol_version > 0xffff_ffff || activation.activation_height !== 1) throw new Error('The starting protocol must activate at block 1.');
  }
  if (request.version !== 1 || request.kind !== (cloud?'riadchain-cloud-setup-request':'riadchain-setup-request') || typeof request.setup_id !== 'string' || !hex32.test(request.setup_id) || request.chain_id !== `riadchain-${request.setup_id}` || typeof request.created_at_ms !== 'number' || !Number.isSafeInteger(request.created_at_ms) || request.created_at_ms < 0) throw new Error('Invalid network setup identity.');
  if (!Array.isArray(request.machines) || request.machines.length < 1 || request.machines.length > 32) throw new Error('Select between 1 and 32 appliances.');
  if(cloud && (request.machines.length!==2 || typeof request.network_id!=='string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(request.network_id)))throw new Error('Cloud setup requires an original network ID and two independent machines.');
  const ids = new Set(); const routes = new Set(); const recipients = new Set();
  for (const item of request.machines) {
    const machine = object(item, cloud ? ['device_id','setup_recipient'] : ['device_id','setup_recipient','endpoint','rpc_endpoint']);
    if (typeof machine.device_id !== 'string' || !hex32.test(machine.device_id) || ids.has(machine.device_id) || typeof machine.setup_recipient !== 'string' || !/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(machine.setup_recipient) || recipients.has(machine.setup_recipient)) throw new Error('Invalid or repeated machine identity.');
    const encrypter = new Encrypter(); encrypter.addRecipient(machine.setup_recipient); // Library verifies the complete recipient checksum.
    if (!cloud) {
      const route = endpoint(machine.endpoint); if (routes.has(route) || endpoint(machine.rpc_endpoint) !== route) throw new Error('Machine routes must be distinct and match the RPC endpoint.');
      routes.add(route);
    }
    ids.add(machine.device_id); recipients.add(machine.setup_recipient);
  }
  const params = normalizeNativeProtocolParamsShape(request.protocol_params);
  if(!params)throw new Error('Invalid protocol settings.');
  if(cloud){
    if(params.networkMode!=='private'||params.blockIntervalMs!==10000||params.fileMinPeerAcksForMining!==1||!same(request.protocol_params,nativeSetupProtocolParams(params)))throw new Error('Cloud setup requires reviewed private-network settings and one FILE replica acknowledgement.');
    cloudSupply(request.initial_supply_satoshis,params.minStakeSatoshis);
  }else{
    const defaults={...DEFAULT_PROTOCOL_PARAMS,fileMinPeerAcksForMining:request.machines.length===1?0:1};
    if(!same(serializeProtocolParams(params),serializeProtocolParams(defaults))||!same(request.protocol_params,nativeSetupProtocolParams(defaults)))throw new Error('This setup supports the standard private-network settings only.');
  }
  return JSON.parse(JSON.stringify(value)) as SetupRequest;
}
/** Match the native genesis wire codec; Rust remains responsible for validating consensus bounds. */
export function nativeSetupProtocolParams(params:ProtocolParams):ObjectValue{
  const serialized=serializeProtocolParams(params);
  const snake=(source:Record<string,unknown>):ObjectValue=>Object.fromEntries(Object.entries(source).map(([key,value])=>[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),value&&typeof value==='object'?snake(value as Record<string,unknown>):value])) as ObjectValue;
  const result=snake(serialized);
  result.gas_schedule={max_gas_per_tx:Number(serialized.gasSchedule.maxGasPerTx),block_gas_limit:Number(serialized.gasSchedule.blockGasLimit)};
  return result;
}
function cloudSupply(value:unknown,stake:bigint):bigint{
  if(typeof value!=='string'||!/^[1-9][0-9]{0,38}$/.test(value))throw new Error('Invalid initial cloud supply.');
  const total=BigInt(value);
  if(stake<=0n||total<3n*stake||total>(1n<<128n)-1n)throw new Error('Fund both hosted owners and the offline rescue owner at genesis.');
  return total;
}
export type SetupKeyPurpose = 0 | 1001 | 1002 | 1003;
/** Owner accounts use purpose 0; 1001/1002/1003 isolate signer/RPC/P2P material. */
export function deriveSetupAccount(phrase: string, purpose: SetupKeyPurpose, index: number) {
  if (![0, 1001, 1002, 1003].includes(purpose) || !Number.isSafeInteger(index) || index < 0 || index >= 32) throw new Error('Invalid setup key derivation.');
  const account = purpose === 0 ? deriveAccountFromMnemonic(phrase, index) : deriveAccountFromMnemonic(phrase, 0, {pathPrefix: `m/44'/60'/${purpose}'/${index}'`});
  if ((purpose === 0 || purpose === 1001) && !isAccountAddress(account.address)) throw new Error('Generated key resolves to a reserved address.');
  return account;
}
export function deriveSetupMachineKeys(phrases: SetupSecrets['phrases'], index: number) {
  if (phrases.length !== 3 || !Number.isSafeInteger(index) || index < 0 || index >= 32) throw new Error('Invalid setup machine index.');
  const phrase = index === 0 ? phrases[0] : phrases[1]; const ownerIndex = index === 0 ? 0 : index - 1;
  return {phrase, owner: deriveSetupAccount(phrase, 0, ownerIndex), operational: deriveSetupAccount(phrase, 1001, ownerIndex), rpcToken: deriveSetupAccount(phrase, 1002, ownerIndex).privateKey};
}
export function buildSetupPlan(request: SetupRequest, phrases: SetupSecrets['phrases']): SetupPlan {
  if (phrases.length !== 3 || new Set(phrases).size !== 3 || phrases.some(phrase => !validateMnemonic(phrase))) throw new Error('Three independent valid recovery phrases are required.');
  const keys = request.machines.map((_, index) => deriveSetupMachineKeys(phrases, index));
  const reservedRecovery = keys.length === 1 ? deriveSetupMachineKeys(phrases, 1) : null;
  const replacement = deriveSetupAccount(phrases[2], 0, 0); const replacementSigner = deriveSetupAccount(phrases[2], 1001, 0);
  const stake = normalizeNativeProtocolParamsShape(request.protocol_params)!.minStakeSatoshis.toString();
  const allocations=request.kind==='riadchain-cloud-setup-request'
    ?[{address:keys[0]!.owner.address,amount_satoshis:(cloudSupply(request.initial_supply_satoshis,BigInt(stake))-2n*BigInt(stake)).toString()},{address:keys[1]!.owner.address,amount_satoshis:stake},{address:replacement.address,amount_satoshis:stake}]
    :[{address:keys[0]!.owner.address,amount_satoshis:stake},{address:replacement.address,amount_satoshis:stake}];
  return {version:1, kind:'riadchain-setup-plan', request, genesis_config: {
    chain_id:request.chain_id, initial_validator:keys[0]!.owner.address, protocol_params:request.protocol_params,
    allocations,
    production_signers:Object.fromEntries([...keys.map(key => [key.owner.address, key.operational.address]), ...(reservedRecovery ? [[reservedRecovery.owner.address,reservedRecovery.operational.address]] : []), [replacement.address, replacementSigner.address]]),
    timestamp_ms:request.created_at_ms,
  }};
}
export function createSetupSecrets(request: SetupRequest, entropy: () => Uint8Array): SetupSecrets {
  // Only unpublished generation can retry a protocol-reserved address. Durable
  // setup material is always reopened, never regenerated after a write attempt.
  for(let attempt=0;attempt<32;attempt++){
    const phrases = [0,1,2].map(() => { const bytes = entropy(); try { return mnemonicFromEntropy(bytes); } finally { bytes.fill(0); } }) as SetupSecrets['phrases'];
    try { buildSetupPlan(request, phrases); return {version:1, request_digest:setupDigest(request), phrases}; }
    catch(error){if(!(error instanceof Error)||error.message!=='Generated key resolves to a reserved address.')throw error;}
  }
  throw new Error('Unable to generate eligible appliance keys. Keep the request and retry with a new setup ID.');
}
export function validateSetupSecrets(request: SetupRequest, value: unknown): SetupSecrets {
  const secret = value as SetupSecrets;
  if (!secret || secret.version !== 1 || secret.request_digest !== setupDigest(request) || !Array.isArray(secret.phrases) || secret.phrases.length !== 3 || secret.phrases.some(p => typeof p !== 'string' || !validateMnemonic(p)) || new Set(secret.phrases).size !== 3 || secret.sealed_digest !== undefined && !hex64.test(secret.sealed_digest) || secret.pending_sealed_digest !== undefined && !hex64.test(secret.pending_sealed_digest)) throw new Error('Setup recovery material does not match this request. Keep the original backups.');
  return secret;
}
export function validatePreparedGenesis(draft: SetupDraft, value: unknown): PreparedGenesis {
  const incoming = object(value, ['version','kind','request','prepared']);
  if (incoming.version !== 1 || incoming.kind !== 'riadchain-prepared-genesis' || !same(incoming.request, draft.request)) throw new Error('Prepared genesis belongs to another setup.');
  const prepared = object(incoming.prepared, ['formatVersion','config','genesisHash','genesisBlock']) as unknown as PreparedGenesis;
  if (prepared.formatVersion !== 1 || !hex64.test(prepared.genesisHash) || !same(prepared.config, draft.plan.genesis_config)) throw new Error('Prepared genesis changed the reviewed network plan.');
  const block = object(prepared.genesisBlock, ['protocol_version','index','chain_id','timestamp_ms','transactions','file_availability','previous_hash','state_hash','hash','validator_public_key','validator_address','validator_signature','is_succession','succession_proof']);
  if (block.protocol_version !== 1 || block.index !== 0 || block.chain_id !== draft.request.chain_id || block.timestamp_ms !== draft.request.created_at_ms || block.previous_hash !== zeroHash || block.validator_address !== prepared.config.initial_validator || block.validator_public_key !== null || block.validator_signature !== '' || block.is_succession !== false || block.succession_proof !== null || !same(block.file_availability, []) || typeof block.state_hash !== 'string' || !/^(02|03)[0-9a-f]{64}$/.test(block.state_hash) || block.hash !== prepared.genesisHash || !Array.isArray(block.transactions) || block.transactions.length !== 1) throw new Error('Prepared genesis has an unexpected block body.');
  const nativeTx = object(block.transactions[0], ['id','chain_id','type','inputs','outputs','payload','timestamp_ms','expiry_height','gas_limit']);
  if (typeof nativeTx.id !== 'string' || !hex64.test(nativeTx.id) || nativeTx.chain_id !== draft.request.chain_id || nativeTx.type !== 'COINBASE' || !same(nativeTx.inputs, []) || !same(nativeTx.outputs, prepared.config.allocations) || !same(nativeTx.payload, {type:'COINBASE'}) || nativeTx.timestamp_ms !== draft.request.created_at_ms || nativeTx.expiry_height !== null || nativeTx.gas_limit !== null) throw new Error('Genesis allocations or transaction changed.');
  const tx: CanonicalTransaction = {id:nativeTx.id, chainId:draft.request.chain_id, type:'COINBASE', inputs:[], outputs:prepared.config.allocations.map(entry => ({address:entry.address, amount:BigInt(entry.amount_satoshis)})), payload:null, timestamp:draft.request.created_at_ms, expiryHeight:null, gasLimit:null};
  if (calculateCanonicalTransactionHash(tx) !== tx.id) throw new Error('Genesis transaction hash does not match its allocations.');
  const canonical: CanonicalBlock = {protocolVersion:1,index:0,chainId:draft.request.chain_id,timestamp:draft.request.created_at_ms,transactions:[tx],fileAvailability:[],previousHash:zeroHash,stateHash:block.state_hash,hash:prepared.genesisHash,validatorPublicKey:null,validatorAddress:prepared.config.initial_validator,validatorSignature:'',isSuccession:false,successionProof:null};
  if (calculateCanonicalBlockHash(canonical) !== prepared.genesisHash) throw new Error('Genesis hash does not match the reviewed block.');
  return JSON.parse(JSON.stringify(prepared)) as PreparedGenesis;
}
export async function sealSetup(draft: SetupDraft, secrets: SetupSecrets, prepared: PreparedGenesis, assertCurrent: () => void = () => {}, custody: SetupCustodyPolicy = 'require-offline-backup'): Promise<SealedSetup> {
  validateSetupSecrets(draft.request, secrets);
  if (!same(buildSetupPlan(draft.request, secrets.phrases), draft.plan) || !custodyReady(draft, custody)) throw new Error('Back up the three recovery phrases and review the original plan first.');
  validatePreparedGenesis(draft, {version:1,kind:'riadchain-prepared-genesis',request:draft.request,prepared});
  const initial = deriveSetupAccount(secrets.phrases[0],0,0);
  const genesis = JSON.parse(JSON.stringify(prepared)) as PreparedGenesis;
  genesis.genesisBlock.validator_public_key = getPublicKeyFromPrivateKey(initial.privateKey);
  genesis.genesisBlock.validator_signature = signData(prepared.genesisHash, initial.privateKey);
  return sealMachineKeys(draft, secrets, genesis, assertCurrent);
}
async function sealMachineKeys(draft: SetupDraft, secrets: SetupSecrets, genesis: PreparedGenesis, assertCurrent: () => void): Promise<SealedSetup> {
  const p2pSecret = deriveSetupAccount(secrets.phrases[0],1003,0).privateKey;
  const machines = [];
  for (let index=0; index<draft.request.machines.length; index++) {
    assertCurrent();
    const machine = draft.request.machines[index]!; const key = deriveSetupMachineKeys(secrets.phrases,index);
    const payload = {version:1,device_id:machine.device_id,setup_id:draft.request.setup_id,genesis_hash:genesis.genesisHash,production_owner:key.owner.address,operational_address:key.operational.address,operational_private_key:key.operational.privateKey,rpc_token:key.rpcToken,p2p_shared_secret:p2pSecret};
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    try {
      const encrypter = new Encrypter(); encrypter.addRecipient(machine.setup_recipient);
      // The byte-array overload uses Response(stream), which React Native's
      // fetch implementation stringifies. The supported stream overload keeps
      // encryption in the library and lets us collect actual bounded bytes.
      const input = new globalThis.ReadableStream<Uint8Array>({start(controller) { controller.enqueue(plaintext); controller.close(); }});
      const output = await encrypter.encrypt(input);
      try {
        assertCurrent();
        const encrypted = await collectSealedKey(output, assertCurrent);
        assertAgeHeader(encrypted);
        machines.push({device_id:machine.device_id,production_owner:key.owner.address,operational_address:key.operational.address,sealed_key:bytesBase64(encrypted)});
      } catch (error) { try { await output.cancel(); } catch {} throw error; }
    }
    finally { plaintext.fill(0); }
  }
  return {version:1,kind:'riadchain-sealed-setup',setup_id:draft.request.setup_id,genesis,protocol_upgrades:draft.request.protocol_upgrades.map(entry => ({...entry})),machines};
}
export async function collectSealedKey(stream: globalThis.ReadableStream<Uint8Array>, assertCurrent: () => void = () => {}): Promise<Uint8Array> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      assertCurrent();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_SEALED_KEY_BYTES - size) throw new Error('Encrypted appliance key exceeds its size limit.');
      size += value.byteLength; chunks.push(value);
    }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally { reader.releaseLock(); }
}
const agePrefix = new TextEncoder().encode('age-encryption.org/v1\n-> X25519 ');
function assertAgeHeader(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_SEALED_KEY_BYTES || bytes.byteLength < 199 || agePrefix.some((byte, index) => bytes[index] !== byte)) throw new Error('The setup file has invalid encrypted machine keys. Repair it before exporting.');
}
function sealedKeyBytes(encoded: string): Uint8Array {
  if (typeof encoded !== 'string' || encoded.length > 16_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid encrypted appliance key.');
  return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}
export function validateSealedEnvelopes(sealed: SealedSetup): void {
  if (!Array.isArray(sealed.machines) || sealed.machines.length < 1 || sealed.machines.length > 32) throw new Error('Invalid sealed machine list.');
  for (const machine of sealed.machines) assertAgeHeader(sealedKeyBytes(machine.sealed_key));
}
export function hasValidSealedEnvelopes(sealed: SealedSetup): boolean {
  try { validateSealedEnvelopes(sealed); return true; } catch { return false; }
}
export function validateSignedSetup(draft: SetupDraft, secrets: SetupSecrets, sealed: SealedSetup, custody: SetupCustodyPolicy = 'require-offline-backup'): void {
  validateSetupSecrets(draft.request, secrets);
  object(sealed, ['version','kind','setup_id','genesis','protocol_upgrades','machines']);
  if (!same(buildSetupPlan(draft.request, secrets.phrases), draft.plan) || !custodyReady(draft, custody) || sealed.version !== 1 || sealed.kind !== 'riadchain-sealed-setup' || sealed.setup_id !== draft.request.setup_id || !same(sealed.protocol_upgrades, draft.request.protocol_upgrades) || !Array.isArray(sealed.machines) || sealed.machines.length !== draft.request.machines.length) throw new Error('Signed setup does not match the original network.');
  const unsigned = JSON.parse(JSON.stringify(sealed.genesis)) as PreparedGenesis;
  unsigned.genesisBlock.validator_public_key = null; unsigned.genesisBlock.validator_signature = '';
  validatePreparedGenesis(draft, {version:1,kind:'riadchain-prepared-genesis',request:draft.request,prepared:unsigned});
  const owner = deriveSetupAccount(secrets.phrases[0],0,0); const block = sealed.genesis.genesisBlock;
  const signature = typeof block.validator_signature === 'string' ? block.validator_signature : '';
  if (block.validator_public_key !== getPublicKeyFromPrivateKey(owner.privateKey) || !verifyAndRecover(sealed.genesis.genesisHash, signature, owner.address)) throw new Error('Keep the original owner-signed genesis.');
  for (let index = 0; index < sealed.machines.length; index++) {
    const machine = sealed.machines[index]!; const expected = deriveSetupMachineKeys(secrets.phrases,index);
    if (machine.device_id !== draft.request.machines[index]!.device_id || machine.production_owner !== expected.owner.address || machine.operational_address !== expected.operational.address) throw new Error('The saved machine identities changed. Keep the original setup.');
  }
}
export async function repairSealedSetup(draft: SetupDraft, secrets: SetupSecrets, assertCurrent: () => void = () => {}): Promise<SealedSetup> {
  const original = draft.sealed;
  if (!original || secrets.sealed_digest !== setupDigest(original)) throw new Error('Unlock the original signed setup before repairing it.');
  validateSignedSetup(draft, secrets, original);
  if (hasValidSealedEnvelopes(original)) throw new Error('This setup already contains encrypted machine keys.');
  assertCurrent();
  // Explicit repair changes encryption envelopes only. It keeps the exact
  // signed genesis, phrases, operational identities and connection credentials.
  return sealMachineKeys(draft, secrets, JSON.parse(JSON.stringify(original.genesis)) as PreparedGenesis, assertCurrent);
}
function bytesBase64(bytes: Uint8Array): string { let binary=''; for(const byte of bytes)binary+=String.fromCharCode(byte); return btoa(binary); }
