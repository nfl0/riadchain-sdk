import type { EthAddress } from '../types.ts';
import { WalletSession } from '../wallet.ts';

let counterDeploySalt = 0;
export const COUNTER_CONTRACT_CODE = `
: count@ contract-address@ "count" load-storage dup null? if drop 0 then ;
: count! "count" store-storage ;

: main
  count@
  1+
  dup count!
  "incremented" emit-event ;
`.trim();

export async function deployCounterContract(
  wallet: WalletSession,
  gasLimit = 500_000,
): Promise<{ txId: string; contractAddress: EthAddress }> {
  const result = await wallet.sendContractDeploy(COUNTER_CONTRACT_CODE, {
    salt: `counter-contract-${counterDeploySalt++}-${Date.now()}`,
    waitForConfirmation: true,
    timeoutMs: 60_000,
    gasLimit,
  });
  return {
    txId: result.tx.id,
    contractAddress: result.contractAddress as EthAddress,
  };
}

export async function runContractCallBurst(
  wallet: WalletSession,
  contractAddress: EthAddress,
  count: number,
  gasLimit = 500_000,
): Promise<{ submitted: number; txIds: string[]; elapsedMs: number }> {
  const started = Date.now();
  const txIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await wallet.sendContractCall(
      contractAddress,
      'inc',
      { method: 'inc' },
      {
        waitForConfirmation: true,
        timeoutMs: 60_000,
        gasLimit,
      },
    );
    txIds.push(result.tx.id);
  }
  return {
    submitted: txIds.length,
    txIds,
    elapsedMs: Date.now() - started,
  };
}
