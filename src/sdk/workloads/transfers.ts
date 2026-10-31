import type { EthAddress, TransferBurstMetrics } from '../types.ts';
import { WalletSession } from '../wallet.ts';

export async function runTransferBurst(
  wallet: WalletSession,
  recipient: EthAddress,
  amount: bigint,
  count: number,
  options: { waitForConfirmation?: boolean; timeoutMs?: number } = {},
): Promise<TransferBurstMetrics> {
  const started = Date.now();
  const txIds: string[] = [];
  let confirmed = 0;
  let failed = 0;
  const useCachedUtxos = !options.waitForConfirmation;

  if (useCachedUtxos) {
    await wallet.refresh();
  }

  for (let index = 0; index < count; index += 1) {
    try {
      const result = useCachedUtxos
        ? await wallet.sendTransferFromCachedUtxos(recipient, amount, {
          waitForConfirmation: false,
          timeoutMs: options.timeoutMs,
        })
        : await wallet.sendTransfer(recipient, amount, {
          waitForConfirmation: true,
          timeoutMs: options.timeoutMs,
        });
      txIds.push(result.tx.id);
      if (options.waitForConfirmation) {
        confirmed += 1;
      }
    } catch (error) {
      failed += 1;
      throw new Error(`Transfer burst failed at item ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    submitted: txIds.length,
    confirmed,
    failed,
    elapsedMs: Date.now() - started,
    txIds,
  };
}

export async function runConcurrentTransferActors(
  actors: Array<{
    name: string;
    wallet: WalletSession;
    recipient: EthAddress;
    amount: bigint;
    count: number;
  }>,
  options: { waitForConfirmation?: boolean; timeoutMs?: number } = {},
): Promise<{
  actors: Array<TransferBurstMetrics & { name: string }>;
  submitted: number;
  confirmed: number;
  failed: number;
  elapsedMs: number;
}> {
  const started = Date.now();
  const results = await Promise.all(actors.map(async (actor) => ({
    name: actor.name,
    ...(await runTransferBurst(
      actor.wallet,
      actor.recipient,
      actor.amount,
      actor.count,
      options,
    )),
  })));

  return {
    actors: results,
    submitted: results.reduce((sum, actor) => sum + actor.submitted, 0),
    confirmed: results.reduce((sum, actor) => sum + actor.confirmed, 0),
    failed: results.reduce((sum, actor) => sum + actor.failed, 0),
    elapsedMs: Date.now() - started,
  };
}
