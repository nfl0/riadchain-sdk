# Transactions, signing and recovery

`LocalSigner` builds unsigned transactions and signs with an explicitly supplied
private key. Keep it in a trusted service or deliberate local signing context.
For interactive applications, prefer a wallet that holds the key and asks the
user to approve an immutable transaction. A dapp should not request a recovery
phrase or private key in a web form.

## A safe transaction lifecycle

1. Verify the account, expected chain/genesis and deployed contract identity.
   Query current funding, protocol limits and fees.
2. Build the transaction and review the exact action, recipient/value, method,
   limits, expiry, fee and original transaction ID. Simulation is evidence about
   current state, not authorization or a guarantee of later execution.
3. Recheck the review context. Sign only the reviewed transaction under the
   correct account and chain policy.
4. **Durably save the exact original transaction, its ID and operation context
   before any broadcast-capable call.** A journal write must finish successfully
   before calling `provider.sendTransaction` or a wallet method that may send.
5. Submit that original once. Verify that the response identifies the same
   transaction. A lost response is an unknown outcome.
6. Query the original ID and its matching execution receipt. Only a successful
   matching receipt proves an ordinary transaction executed successfully.

Store journals in application-appropriate durable storage: a committed database
transaction for a service, or a completed IndexedDB transaction for a browser.
An in-memory variable, console log or unawaited write is not crash recovery.
Persist the exact payload with a lossless codec for `bigint`; do not use a
blanket JSON string conversion that changes transaction values. Journal entries
can contain sensitive application data and must not include private keys or RPC
tokens.

`WalletSession` convenience send methods do not expose a pre-broadcast durable
journal hook. Use unsigned builders plus an explicit signing/submission flow
when crash-safe persistence is required. For a broadcast-capable interactive
wallet, save the reviewed original ID and unsigned payload before the request,
then retain its returned signed original when available. The wallet's signature
does not authorize changing the reviewed transaction.

## Confirm the original

```ts
import { waitForTransactionOutcome } from '@riadchain/sdk/browser';

const outcome = await waitForTransactionOutcome(provider, savedOriginalId, {
  timeoutMs: 120_000,
  pollIntervalMs: 2_000,
  signal: abortController.signal,
});

switch (outcome.status) {
  case 'confirmed':
    // Ordinary transactions also have executionStatus === 'succeeded'.
    break;
  case 'failed':
    // Matching execution receipt reports failure. Review before a new action.
    break;
  case 'pending':
  case 'unknown':
    // Retain the original. Reconcile it later; do not automatically rebuild.
    break;
}
```

Submission, mempool presence, block inclusion and execution success are separate
observations. A timeout, disconnected wallet or absent mempool entry does not
mean failure. Never replace an uncertain operation with a freshly timestamped
transaction. Reconcile the saved ID after a restart or reconnect. Genesis
allocations are a special case: inclusion is authenticated by the initial block
and has no normal execution receipt or fee settlement.

`WalletTransactionError` preserves the signed `transaction`, its original ID,
status and available outcome when a convenience workflow cannot confirm.
Preserve that information, but remember that the exception itself is only an
in-memory result.

The [reconciliation example](../examples/reconcile-original.mjs) checks a saved
ID against the configured chain and never signs or submits anything.
