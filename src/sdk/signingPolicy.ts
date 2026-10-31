import { z } from 'zod';
import { isAccountAddress, isValidAddress, type EthAddress } from './internal/crypto.ts';
import type { Transaction } from './types.ts';
import { calculateTxHash } from './internal/txUtils.ts';

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const transactionSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  chainId: z.string().min(1),
  type: z.enum(['TRANSFER', 'CONTRACT', 'FILE']),
  inputs: z.array(z.object({
    txId: z.string().regex(/^[0-9a-f]{64}$/),
    outputIndex: safeInteger,
    address: z.string().refine(isAccountAddress, 'Expected an account address'),
    signature: z.string().regex(/^(?:[0-9a-f]{130})?$/i),
  }).strict()).min(1),
  outputs: z.array(z.object({
    address: z.string().refine(isValidAddress, 'Expected a canonical address'),
    amount: z.bigint().positive(),
  }).strict()),
  payload: z.record(z.string(), z.unknown()).nullable(),
  timestamp: safeInteger,
  expiryHeight: safeInteger.nullish(),
  gasLimit: safeInteger.nullish(),
}).strict();

/** The approved payload must be exactly the transaction whose digest is signed. */
export function assertSigningTransaction(
  transaction: unknown,
  signerAddress: EthAddress,
  chainId: string,
): asserts transaction is Transaction {
  const parsed = transactionSchema.safeParse(transaction);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid transaction${issue?.path.length ? ` at ${issue.path.join('.')}` : ''}: ${issue?.message ?? 'unsupported transaction'}`);
  }
  const tx = parsed.data;
  if (!chainId || tx.chainId !== chainId) {
    throw new Error('Transaction chain does not match the selected network');
  }
  if (tx.inputs.some((input) => input.address.toLowerCase() !== signerAddress.toLowerCase())) {
    throw new Error('Transaction inputs must all belong to the selected account');
  }
  const digest = calculateTxHash(
    tx.chainId, tx.type, tx.inputs as Transaction['inputs'],
    tx.outputs as Transaction['outputs'], tx.payload, tx.timestamp,
    tx.expiryHeight, tx.gasLimit,
  );
  if (tx.id !== digest) {
    throw new Error('Transaction ID does not match its contents');
  }
}

export function assertSignableMessage(message: unknown): asserts message is string {
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('Message must be non-empty text');
  }
  if (message.length > 10_000) {
    throw new Error('Message exceeds the 10,000 character limit');
  }
  // Message and transaction signatures currently share the same crypto primitive.
  if (/^(?:0x)?[0-9a-f]{64}$/i.test(message.trim())) {
    throw new Error('Use transaction approval to sign a transaction digest');
  }
}
