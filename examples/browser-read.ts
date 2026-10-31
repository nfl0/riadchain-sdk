import { RiadchainProvider } from '@riadchain/sdk/browser';

export async function readNetwork(config: {
  readEndpoint: string;
  expectedChainId: string;
  expectedGenesisHash: string;
}) {
  // Configure a read-only endpoint with the intended browser origin allowed.
  // Broader node RPC credentials belong in your authenticated backend service.
  const provider = new RiadchainProvider(config.readEndpoint, undefined, {
    nodeTimeoutMs: 10_000,
  });
  const [status, genesis] = await Promise.all([
    provider.getStatus(),
    provider.getBlockHeaderByHeight(0),
  ]);
  if (status.chainId !== config.expectedChainId
    || genesis?.hash !== config.expectedGenesisHash) {
    throw new Error('Unexpected Riadchain network');
  }
  return { height: status.latestBlockIndex, ready: status.ready };
}
