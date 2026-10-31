# Native FILE storage

A Riadchain FILE transaction commits a content identifier (CID), size and
metadata. The bytes live in participating nodes' native content-addressed
archives and are served and replicated by the node. A confirmed transaction
does not by itself prove that a particular node currently has the bytes.

## Describe content locally

```ts
import { describeFileBytes } from '@riadchain/sdk/internal/fileDescriptor';

const bytes = new TextEncoder().encode('Example application record\n');
const { cid, size } = await describeFileBytes(bytes);
```

This computes the canonical UnixFS descriptor locally without uploading or
submitting a transaction. Keep the exact original bytes and descriptor through
interruption. The [local descriptor example](../examples/describe-file.mjs)
needs no network or keys.

## Upload lifecycle

To write a FILE, build its transaction with the canonical CID/size, review and
sign it, and persist the original transaction **and a recoverable copy of the
bytes** before broadcast. Submit the signed original, then call
`provider.uploadFileBytes(original.id, originalBytes)` on the same authorized
node. Follow the [transaction recovery rules](transactions.md).

The SDK stages at most 1 MiB per `StageFile` request, with exact offsets bound to
the original transaction. It reconciles interrupted acknowledgements using
`getUploadStatus`, and verifies completion against the CID and size. A node
restart may discard an incomplete staged spool; retrying byte staging uses the
same original transaction and bytes, not a replacement transaction or CID.
Node admission, required peer acknowledgements and successful transaction
execution still determine whether the FILE becomes confirmed.

`WalletSession.sendFile` and `sendFileBytes` combine these steps for convenience,
but do not provide a pre-broadcast durable journal hook. Use the lower-level
flow for crash-safe applications. The public byte-array API holds its complete
input in memory; bounded request chunks do not make that API a streaming input.

## Retrieve and verify bytes

```ts
const bytes = await provider.getFileBytes(expectedCid, {
  expectedSize: sizeFromConfirmedReference,
  maxBytes: applicationDownloadLimit,
  signal: abortController.signal,
});
```

Supply an explicit application download ceiling and, when available, the size
from the expected FILE reference. The SDK uses bounded chunks and verifies the
canonical CID. Do not interpret returned metadata, inclusion or a storage count
as byte availability. Missing confirmed archive content requires archive
recovery or replication, not rewriting chain history.

The [download example](../examples/read-file.mjs) verifies chain/genesis and
retrieves a size-bound object without writing it or sending a transaction.

Uploads and downloads use the configured node RPC endpoint. HTTPS reverse
proxies must forward the Connect/protobuf services and allow the bounded request
sizes and suitable timeouts. FILE support does not require a separate node port
or a hosted IPFS account. Configure TLS, origins and credentials for the actual
deployment; the SDK does not provision those services.
