import { createNodeProvider } from '@riadchain/sdk/node';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in your private process environment`);
  return value;
}

// Read-only connection setup. This module never signs or submits transactions.
export async function verifiedProvider() {
  const nodeUrl = required('RIADCHAIN_NODE_URL');
  const parsed = new URL(nodeUrl);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    throw new Error('Use an HTTP(S) endpoint without URL credentials, query or fragment');
  }
  const expectedChainId = required('RIADCHAIN_EXPECTED_CHAIN_ID');
  const expectedGenesisHash = required('RIADCHAIN_EXPECTED_GENESIS_HASH');
  if (!/^[0-9a-f]{64}$/.test(expectedGenesisHash)) {
    throw new Error('Expected genesis hash must be 64 lowercase hex characters');
  }
  const provider = createNodeProvider(nodeUrl, process.env.RIADCHAIN_NODE_AUTH_TOKEN, {
    nodeTimeoutMs: 10_000,
    maxInFlightRequests: 4,
  });
  const [chainId, genesis] = await Promise.all([
    provider.getChainId(),
    provider.getBlockHeaderByHeight(0),
  ]);
  if (chainId !== expectedChainId || genesis?.hash !== expectedGenesisHash) {
    throw new Error('Unexpected Riadchain network');
  }
  return provider;
}
