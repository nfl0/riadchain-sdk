import { verifiedProvider } from './connection.mjs';

const provider = await verifiedProvider();
const status = await provider.getStatus();
console.log({
  height: status.latestBlockIndex,
  ready: status.ready,
  activeProtocol: status.protocolInfo.activeProtocolVersion,
  nextProtocol: status.protocolInfo.nextBlockProtocolVersion,
});
