import { create } from '@bufbuild/protobuf';
import { ConnectError, Code } from '@connectrpc/connect';
import {
  BlockSchema,
  FileAvailabilitySchema,
  SuccessionProofSchema,
  TransactionSchema,
  Transaction_Type,
  type Block as ProtoBlock,
  type Transaction as ProtoTransaction,
} from './gen/proto/riadchain_pb.ts';
import { requireProtocolVersion } from './canonicalChainEncoding.ts';
import type { Block } from './blockTypes.ts';
import type { Transaction } from './txUtils.ts';
import type { EthAddress } from './crypto.ts';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bigintReplacer(_: string, entry: unknown): unknown {
  return typeof entry === 'bigint' ? entry.toString() : entry;
}

export function encodeJsonBytes(value: unknown, transform: (v: unknown) => unknown = identity): Uint8Array {
  return textEncoder.encode(JSON.stringify(transform(value), bigintReplacer));
}

export function decodeJsonBytes<T = unknown>(bytes: Uint8Array): T | null {
  if (bytes.byteLength === 0) return null;
  return JSON.parse(textDecoder.decode(bytes)) as T;
}

function identity(v: unknown): unknown {
  return v;
}

const TX_TYPE_TO_PROTO: Record<Transaction['type'], Transaction_Type> = {
  FILE: Transaction_Type.FILE,
  CONTRACT: Transaction_Type.CONTRACT,
  TRANSFER: Transaction_Type.TRANSFER,
  COINBASE: Transaction_Type.COINBASE,
};

const TX_TYPE_FROM_PROTO: Record<Transaction_Type, Transaction['type']> = {
  [Transaction_Type.FILE]: 'FILE',
  [Transaction_Type.CONTRACT]: 'CONTRACT',
  [Transaction_Type.TRANSFER]: 'TRANSFER',
  [Transaction_Type.COINBASE]: 'COINBASE',
};

export function txToProto(tx: Transaction, encodePayload: (v: unknown) => Uint8Array): ProtoTransaction {
  if (!Object.hasOwn(TX_TYPE_TO_PROTO, tx.type)) throw new ConnectError('Unknown transaction type', Code.InvalidArgument);
  return create(TransactionSchema, {
    id: tx.id,
    chainId: tx.chainId,
    type: TX_TYPE_TO_PROTO[tx.type],
    inputs: tx.inputs.map((input) => ({
      txId: input.txId,
      outputIndex: input.outputIndex,
      address: input.address,
      signature: input.signature,
    })),
    outputs: tx.outputs.map((output) => ({
      address: output.address,
      amountSatoshis: output.amount.toString(),
    })),
    payloadJson: encodePayload(tx.payload === undefined ? null : tx.payload),
    timestamp: BigInt(tx.timestamp),
    expiryHeight: tx.expiryHeight != null ? BigInt(tx.expiryHeight) : undefined,
    gasLimit: tx.gasLimit != null ? BigInt(tx.gasLimit) : undefined,
  });
}

type TxFromProtoOptions = {
  /** When true, wrap payload JSON parse errors as ConnectError(InvalidArgument). */
  strictPayload?: boolean;
};

export function txFromProto(proto: ProtoTransaction, opts: TxFromProtoOptions = {}): Transaction {
  let payload: unknown = null;
  if (proto.payloadJson.byteLength > 0) {
    try {
      payload = JSON.parse(textDecoder.decode(proto.payloadJson));
    } catch (err) {
      if (opts.strictPayload) {
        throw new ConnectError('Invalid JSON in transaction payload', Code.InvalidArgument);
      }
      throw err;
    }
  }
  if (!(proto.type in TX_TYPE_FROM_PROTO)) throw new ConnectError('Unknown transaction type', Code.InvalidArgument);
  return {
    id: proto.id,
    chainId: proto.chainId,
    type: TX_TYPE_FROM_PROTO[proto.type],
    inputs: proto.inputs.map((input) => ({
      txId: input.txId,
      outputIndex: input.outputIndex,
      address: input.address as EthAddress,
      signature: input.signature,
    })),
    outputs: proto.outputs.map((output) => ({
      address: output.address as EthAddress,
      amount: BigInt(output.amountSatoshis),
    })),
    payload,
    timestamp: Number(proto.timestamp),
    expiryHeight: proto.expiryHeight != null ? Number(proto.expiryHeight) : null,
    gasLimit: proto.gasLimit != null ? Number(proto.gasLimit) : null,
  };
}

export function blockToProto(block: Block, encodePayload: (v: unknown) => Uint8Array): ProtoBlock {
  return create(BlockSchema, {
    protocolVersion: requireProtocolVersion(block.protocolVersion),
    index: BigInt(block.index),
    chainId: block.chainId,
    timestamp: BigInt(block.timestamp),
    transactions: block.transactions.map((tx) => txToProto(tx, encodePayload)),
    fileAvailability: block.fileAvailability.map((entry) => create(FileAvailabilitySchema, {
      txId: entry.txId,
      cid: entry.cid,
      size: BigInt(entry.size),
    })),
    previousHash: block.previousHash,
    stateHash: block.stateHash,
    hash: block.hash,
    ...(block.validatorPublicKey !== null ? { validatorPublicKey: block.validatorPublicKey } : {}),
    validatorAddress: block.validatorAddress,
    validatorSignature: block.validatorSignature,
    isSuccession: block.isSuccession,
    ...(block.successionProof !== null
      ? {
          successionProof: create(SuccessionProofSchema, {
            txId: block.successionProof.txId,
            outputIndex: block.successionProof.outputIndex,
            amount: block.successionProof.amount.toString(),
          }),
        }
      : {}),
  });
}

export function blockFromProto(block: ProtoBlock, opts: TxFromProtoOptions = {}): Block {
  return {
    protocolVersion: requireProtocolVersion(block.protocolVersion),
    index: Number(block.index),
    chainId: block.chainId,
    timestamp: Number(block.timestamp),
    transactions: block.transactions.map((tx) => txFromProto(tx, opts)),
    fileAvailability: block.fileAvailability.map((entry) => ({
      txId: entry.txId,
      cid: entry.cid,
      size: Number(entry.size),
    })),
    previousHash: block.previousHash,
    stateHash: block.stateHash,
    hash: block.hash,
    validatorPublicKey: block.validatorPublicKey ?? null,
    validatorAddress: block.validatorAddress as EthAddress,
    validatorSignature: block.validatorSignature,
    isSuccession: block.isSuccession,
    successionProof: block.successionProof
      ? {
          txId: block.successionProof.txId,
          outputIndex: block.successionProof.outputIndex,
          amount: block.successionProof.amount,
        }
      : null,
  };
}
