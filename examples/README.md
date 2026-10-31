# Examples

These examples never sign or broadcast transactions. The Node examples use the
installed `@riadchain/sdk`; run them from this repository after `npm ci` and
`npm run build`, or copy them to a project that installs the package.

| Example | Behavior |
| --- | --- |
| `read-node.mjs` | Read status after checking expected chain and genesis |
| `browser-read.ts` | Export a browser read function for a configured read-only endpoint |
| `typed-data.mjs` | Compute typed and byte hashes locally |
| `describe-file.mjs` | Compute a FILE CID/size locally |
| `read-file.mjs` | Download and CID-check one size-bound FILE |
| `reconcile-original.mjs` | Observe a previously saved transaction ID |

For example:

```sh
node examples/typed-data.mjs
node examples/describe-file.mjs
node examples/read-node.mjs
```

Read examples require `RIADCHAIN_NODE_URL`, `RIADCHAIN_EXPECTED_CHAIN_ID` and
`RIADCHAIN_EXPECTED_GENESIS_HASH` in your private process environment. Supply
`RIADCHAIN_NODE_AUTH_TOKEN` only if the endpoint requires it. Obtain expected
identity independently from your network setup, not from the same unverified
endpoint you are checking. The examples do not print credentials.

`read-file.mjs` also requires `RIADCHAIN_FILE_CID` and
`RIADCHAIN_FILE_EXPECTED_SIZE` (a non-negative integer number of bytes). It caps
downloads at 4 MiB deliberately; choose a justified bound for your application.
`reconcile-original.mjs` requires `RIADCHAIN_ORIGINAL_TX_ID`, a 64-character
lowercase hex ID retained by your application's durable journal.

`browser-read.ts` is a module to include in your application's TypeScript
bundler. It contains no RPC token. A browser-delivered bearer token is visible
to that browser user; keep broader node credentials behind your service.
