# Riadchain SDK

TypeScript and JavaScript clients for Riadchain private application networks.
Query accounts and contracts, construct and sign transactions, retrieve native
FILE content, and track execution outcomes.

## Install

```sh
npm install @riadchain/sdk
```

Use Node.js **22.14 or later**, or a modern browser with a bundler that supports
ES modules and `bigint`. The package includes compiled JavaScript and TypeScript
declarations. It does not require the node daemon, Bun, a Rust toolchain or the
Riadchain monorepo to install and import.

## Read from a node

Configure your own endpoint and an RPC credential with only the access your
application needs. The following code performs reads and sends no transaction:

```js
import { createNodeProvider } from '@riadchain/sdk/node';

const provider = createNodeProvider(
  process.env.RIADCHAIN_NODE_URL,
  process.env.RIADCHAIN_NODE_AUTH_TOKEN,
  { nodeTimeoutMs: 10_000, maxInFlightRequests: 4 },
);

const status = await provider.getStatus();
console.log({ height: status.latestBlockIndex, ready: status.ready });
```

Use the [complete Node example](examples/read-node.mjs) to require and verify the
expected chain and genesis identity before reading. Keep tokens in private
service configuration; do not print them or place them in URLs or frontend
bundles.

For a browser application:

```ts
import { RiadchainProvider } from '@riadchain/sdk/browser';

const provider = new RiadchainProvider(configuredReadEndpoint, undefined, {
  nodeTimeoutMs: 10_000,
});
const status = await provider.getStatus();
```

The endpoint must explicitly permit the intended read methods and browser
origin. A server-held RPC token belongs behind an authenticated application
service or restricted relay. The SDK does not grant network access or configure
CORS. See the [browser example](examples/browser-read.ts).

## Choose an entry point

| Import | Purpose |
| --- | --- |
| `@riadchain/sdk/browser` | Portable provider, signer, wallet and core utilities |
| `@riadchain/sdk/node` | Node transport factories and request options |
| `@riadchain/sdk` | Main SDK surface, including Node factories and application helpers |
| `@riadchain/sdk/types` | Shared TypeScript types |
| `@riadchain/sdk/provider` | Provider and read-session API |
| `@riadchain/sdk/signer` | Explicit local-key transaction builders and signing |
| `@riadchain/sdk/wallet` | Provider/signer convenience workflows |

Application-specific helpers have dedicated subpaths, including `/names`,
`/gateway`, `/cloud-core`, `/cloud-handoff` and the household modules. Use public
exports rather than importing files inside `src/` or `dist/`.

`RiadchainProvider` holds connection configuration, not an account signing key.
`LocalSigner` holds a private key in application memory. `WalletSession` combines
the two and caches spend state; it does not supply a durable recovery journal or
an interactive wallet approval screen.

## Guides and examples

- [Runtime, protocol and chain identity](docs/compatibility.md)
- [Contracts, canonical values and pinned reads](docs/contracts.md)
- [Transactions, signing and recovery](docs/transactions.md)
- [Native FILE storage](docs/files.md)
- [Read-only and local examples](examples/README.md)
- [Contributing and releases](docs/contributing.md)

Amounts are `bigint` in base units. Parse decimal text with `toSatoshis` or
`parseTokenAmount`; avoid floating-point arithmetic for balances and fees.
Submission acknowledgement and block inclusion do not prove execution success.
Keep the original transaction and ID before any broadcast, then verify its
matching successful receipt.

## Source and license

This repository is generated from the authoritative
[`nfl0/riadchain`](https://github.com/nfl0/riadchain) source. Contributions go to
that repository's `sdk/`, `lib/` and `proto/` directories. The generated source is
included for inspection and independent builds; edits made only here would be
overwritten by a later export.

Licensed under [MIT](LICENSE).
