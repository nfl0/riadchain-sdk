import { RiadchainNodeError, type RiadchainProvider } from './provider.ts';
import type { TransactionContext, TransactionReceipt } from './types.ts';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export type TransactionOutcome = {
  status: 'unknown' | 'pending' | 'confirmed' | 'failed';
  executionStatus: 'succeeded' | 'failed' | null;
  blockIndex: number | null;
  feeCharged: string | null;
  error: string | null;
};

const unknownOutcome = (): TransactionOutcome => ({ status: 'unknown', executionStatus: null, blockIndex: null, feeCharged: null, error: null });

/** Block inclusion alone does not prove that a contract call executed successfully. */
export function classifyTransactionOutcome(context: TransactionContext | null, receipt?: TransactionReceipt | null): TransactionOutcome {
  if (!context) return unknownOutcome();
  if (context.status === 'pending') return { ...unknownOutcome(), status: 'pending' };
  if (context.status !== 'confirmed' || context.blockIndex === null || !Number.isSafeInteger(context.blockIndex) || context.blockIndex < 0) {
    return unknownOutcome();
  }
  const included = { ...unknownOutcome(), blockIndex: context.blockIndex };
  // Genesis allocations are authenticated by the initial block, outside normal
  // execution. They have no gas settlement or execution receipt.
  if (context.blockIndex === 0 && context.transaction.type === 'COINBASE') {
    return { ...included, status: 'confirmed' };
  }
  if (!receipt) return { ...included, error: 'Included in a block; execution receipt is not available yet' };
  if (receipt.txId !== context.transaction.id || receipt.blockIndex !== context.blockIndex
    || (context.blockHash !== null && receipt.blockHash !== context.blockHash)) {
    return { ...included, error: 'Execution receipt does not match this transaction and block' };
  }
  if (receipt.executionStatus === 'failed' || !receipt.success) {
    return { ...included, status: 'failed', executionStatus: 'failed', feeCharged: receipt.feeCharged, error: receipt.error || 'Transaction execution failed' };
  }
  if (receipt.executionStatus === 'succeeded' && receipt.success) {
    return { ...included, status: 'confirmed', executionStatus: 'succeeded', feeCharged: receipt.feeCharged };
  }
  return { ...included, error: 'Execution receipt has an unknown status' };
}

class ConfirmationTimeout extends Error {}

function aborted(): DOMException {
  return new DOMException('Transaction confirmation cancelled', 'AbortError');
}

async function withinDeadline<T>(operation: () => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw aborted();
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new ConfirmationTimeout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => rejectStop(aborted());
  let rejectStop!: (error: Error) => void;
  const stop = new Promise<never>((_, reject) => {
    rejectStop = reject;
    timer = setTimeout(() => reject(new ConfirmationTimeout()), remaining);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), stop]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function waitForTransactionOutcome(
  provider: Pick<RiadchainProvider, 'getTransaction' | 'getReceipt'>,
  txId: string,
  options: { signal?: AbortSignal; timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<TransactionOutcome> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 600_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 10_000) {
    throw new Error('Invalid transaction confirmation timing');
  }
  const deadline = performance.now() + timeoutMs;
  let outcome = unknownOutcome();
  while (performance.now() < deadline) {
    let context: TransactionContext | null = null;
    try {
      const found = await withinDeadline(() => provider.getTransaction(txId), deadline, options.signal);
      if (found.transaction.id !== txId) throw new Error('Node returned a different transaction');
      context = found;
      outcome = classifyTransactionOutcome(context);
      if (outcome.status === 'confirmed') return outcome;
      if (context.status === 'confirmed') {
        const receipt = await withinDeadline(() => provider.getReceipt(txId), deadline, options.signal);
        outcome = classifyTransactionOutcome(context, receipt);
        if (outcome.status === 'confirmed' || outcome.status === 'failed') return outcome;
      }
    } catch (error) {
      if (options.signal?.aborted) throw aborted();
      if (error instanceof ConfirmationTimeout) break;
      outcome = { ...(context ? classifyTransactionOutcome(context) : unknownOutcome()), error: error instanceof RiadchainNodeError && error.code === 5
        ? context?.status === 'confirmed'
          ? 'Included in a block; execution receipt is not available yet'
          : 'Transaction is not visible on this node; confirmation is unknown'
        : errorMessage(error, 'Unable to check transaction confirmation') };
    }
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await withinDeadline(() => new Promise<void>((resolve) => {
        pauseTimer = setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - performance.now())));
      }), deadline, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw aborted();
      if (error instanceof ConfirmationTimeout) break;
      throw error;
    } finally {
      clearTimeout(pauseTimer);
    }
  }
  if (options.signal?.aborted) throw aborted();
  return { ...outcome, error: outcome.error || (outcome.status === 'pending'
    ? 'Confirmation is still pending; check activity for updates'
    : 'Confirmation could not be verified; check activity before sending again') };
}
