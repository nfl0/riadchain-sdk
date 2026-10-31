# Runtime and protocol compatibility

## JavaScript runtimes

Use Node.js 22.14 or later for the published Node entry point. Browser and
portable clients use `@riadchain/sdk/browser`, which avoids the Node transport
adapter. Modern browsers need ES modules, `bigint`, Fetch, AbortController,
TextEncoder and Web Crypto support; use a bundler for npm dependencies.

The package is ESM. CommonJS consumers must use dynamic `import()` or configure
their application for ESM. No Bun FFI or native Rust binary is required by the
published JavaScript package. React Native applications must supply compatible
platform APIs; a successful web build alone is not device qualification.

## Protocol IDs are separate from package versions

The current node source supports consensus protocols **1, 2 and 3**. SDK package
version `2.0.0` is a software release number, not an assertion that protocol 2 is
active. A chain's participant-agreed activation schedule determines its active
and next-block protocols.

```ts
const info = await provider.getProtocolInfo();
if (!info.compatible) throw new Error('Node cannot execute its next protocol');

const params = await provider.getProtocolParams();
```

`supportedProtocolVersions` describes that node's software support;
`activeProtocolVersion` and `nextBlockProtocolVersion` describe its schedule.
Read the selected chain's genesis fee and resource limits with
`getProtocolParams()` before constructing transactions. Do not use a package
version, a hardcoded fee or a local SDK default as chain policy.

Protocol 2 adds contract storage operations. Protocol 3 adds canonical typed-data
hashing, authenticated chain/genesis VM context and strict byte hashing/codecs.
Local SDK hashing utilities can run without a node; contracts using their
protocol-3 VM counterparts must execute under protocol 3 or later. Snapshot-pinned
RPC reads additionally require a node implementing the read-session API.

The distributed schema and generated clients describe the current RPC API.
Support for historical consensus execution does not promise compatibility with
every older daemon's RPC surface. Check the node API and release notes when
deploying a client. The isolated package checks validate packaging and selected
client behavior; they are not a live multi-node compatibility test.

## Verify the intended chain

A wallet network selection ID, endpoint URL or account address is not sufficient
chain identity. Obtain the expected chain ID and genesis hash through your
trusted network setup, then compare them with the node:

```ts
const [chainId, genesis] = await Promise.all([
  provider.getChainId(),
  provider.getBlockHeaderByHeight(0),
]);
if (chainId !== expectedChainId || genesis?.hash !== expectedGenesisHash) {
  throw new Error('Unexpected Riadchain network');
}
```

Recheck account, network, fee policy, funding and expiry after transaction review
and before submission. Discard partial work when its account or chain context
changes. An unreachable balance is unknown, not zero.

Riadchain is a permissioned succession chain for trusted participants. The SDK
does not change that trust model, create public validator admission or confer
chain governance authority through contract ownership.
