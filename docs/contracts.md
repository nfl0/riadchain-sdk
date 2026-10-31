# Contract reads and canonical values

Use `callView` for a contract's public read methods. Check that the expected
contract code is deployed on the intended chain; an address namespace alone does
not establish this.

```ts
const result = await provider.callView(contractAddress, 'getRecord', {
  recordId: 'example-record',
});
const record = result.returnValue;
```

Arguments and results use Riadchain `ContractValue`: null, booleans, integers,
strings, arrays and string-keyed records. Preserve `bigint` values. View transport
encoding is handled by the provider; it is distinct from the contract transaction
argument codec.

For a transaction calling a Charlie/high-level contract, encode its argument
value with `encodeContractArguments` before passing it to the transaction
builder. Decode those bytes with `decodeContractArguments`. Native/system
contracts may define explicit string-encoded fields; follow that method's ABI.
Do not substitute ordinary JSON bytes for the contract argument codec.

## Read a consistent snapshot

Several moving-tip calls can observe different blocks. Use a read session when
multiple values must come from the same immutable state:

```ts
const snapshot = await provider.withReadSession(async session => {
  const first = await session.callView(contractAddress, 'getRecord', {
    recordId: 'first',
  });
  const second = await session.callView(contractAddress, 'getRecord', {
    recordId: 'second',
  });
  return { anchor: session.anchor, first: first.returnValue, second: second.returnValue };
});
```

Read sequentially within one session. Its client exposes only the anchor,
contract state and public views; it has no signing, submission or simulation
methods. If the session expires or its anchor mismatches, discard the partial
results and start a complete new read. A read snapshot grants no future write
reservation, so contracts must still validate mutable state during execution.

## Hash typed application data

```ts
import { typedHash } from '@riadchain/sdk/browser';

const digest = typedHash('example.ping/checkpoint/v1', {
  chainId: verifiedChainId,
  genesisHash: verifiedGenesisHash,
  contract: verifiedContractAddress,
  sequence: 1n,
  value: { available: true, samples: 12n },
});
```

`typedHash` uses a domain-separated canonical contract-value encoding. Its
`number` values must be safe integers; use `bigint` for larger integers.
Object insertion order does not alter the digest. The utility does not supply
signature verification, nonce consumption, replay protection or application
authorization. Put the necessary chain, genesis, contract and action context in
your application's envelope and enforce it in the verifier.

For exact bytes, `bytesSha256` and `bytesKeccak256` accept canonical lowercase
even-length hex without `0x`. `utf8ToHex`, `hexToUtf8`, `base64ToHex` and
`hexToBase64` provide strict lossless conversions. Do not confuse hashing hex
text with hashing the represented bytes. See the local-only
[typed-data example](../examples/typed-data.mjs).
