import { WalletSession } from '../wallet.ts';

export async function runFileBurst(
  wallet: WalletSession,
  options: {
    count: number;
    bytes: number;
    prefix?: string;
    waitForConfirmation?: boolean;
    timeoutMs?: number;
  },
): Promise<{
  submitted: number;
  confirmed: number;
  cids: string[];
  txIds: string[];
  elapsedMs: number;
}> {
  const started = Date.now();
  const cids: string[] = [];
  const txIds: string[] = [];
  const useCachedUtxos = !options.waitForConfirmation;

  if (useCachedUtxos) {
    await wallet.refresh();
  }

  for (let i = 0; i < options.count; i += 1) {
    const filename = `${options.prefix ?? 'file'}-${i + 1}.txt`;
    const content = makeContent(filename, options.bytes);
    const result = useCachedUtxos
      ? await wallet.sendFileFromCachedUtxos(
        { filename, content, mimeType: 'text/plain' },
        { waitForConfirmation: false, timeoutMs: options.timeoutMs },
      )
      : await wallet.sendFile(
        { filename, content, mimeType: 'text/plain' },
        { waitForConfirmation: true, timeoutMs: options.timeoutMs },
      );
    cids.push(result.cid);
    txIds.push(result.tx.id);
  }

  return {
    submitted: txIds.length,
    confirmed: options.waitForConfirmation ? txIds.length : 0,
    cids,
    txIds,
    elapsedMs: Date.now() - started,
  };
}

function makeContent(label: string, bytes: number): string {
  const prefix = `[bun-file:${label}] `;
  const filler = 'abcdefghijklmnopqrstuvwxyz0123456789';
  if (bytes <= prefix.length) {
    return prefix.slice(0, bytes);
  }
  const remaining = bytes - prefix.length;
  const repeated = filler.repeat(Math.ceil(remaining / filler.length));
  return `${prefix}${repeated}`.slice(0, bytes);
}
