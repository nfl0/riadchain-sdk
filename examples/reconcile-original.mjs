import { waitForTransactionOutcome } from '@riadchain/sdk/browser';
import { verifiedProvider } from './connection.mjs';

// Supply the original ID saved before your application's first submission.
// This example only observes it; it never rebuilds, signs or resubmits anything.
const originalId = process.env.RIADCHAIN_ORIGINAL_TX_ID ?? '';
if (!/^[0-9a-f]{64}$/.test(originalId)) {
  throw new Error('Set RIADCHAIN_ORIGINAL_TX_ID to the saved 64-character hex ID');
}
const provider = await verifiedProvider();
const outcome = await waitForTransactionOutcome(provider, originalId, {
  timeoutMs: 30_000,
  pollIntervalMs: 2_000,
});
console.log({
  status: outcome.status,
  executionStatus: outcome.executionStatus,
  blockIndex: outcome.blockIndex,
});
if (outcome.status === 'pending' || outcome.status === 'unknown') {
  console.log('Keep the original transaction and reconcile it later.');
}
