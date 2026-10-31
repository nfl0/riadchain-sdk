export { RiadchainProvider, RiadchainNodeError } from './provider.ts';
export {
  createNodeProvider,
  createNodeTransport,
  createNodeTransportOptions,
  type NodeProviderOptions,
} from './node.ts';
// Preserve initialization order around the node and public client modules.
export { LocalSigner } from './signer.ts';
export { WalletSession, WalletTransactionError } from './wallet.ts';

// These public leaf modules intentionally expose all exports, including future ones.
// Review API additions and update the export-surface guard when extending a leaf.
export * from './household-identity.ts';
export * from './guest-access.ts';
export * from './household-approval.ts';
export * from './household-treasury.ts';
export * from './recurring-payments.ts';
export * from './state-condition-automation.ts';
export * from './household-escrow.ts';
export * from './package-registry.ts';
export * from './encrypted-vault.ts';
export * from './vault-crypto.ts';

export * from './core.ts';
export * as transferWorkloads from './workloads/transfers.ts';
export * as contractWorkloads from './workloads/contracts.ts';
export * as fileWorkloads from './workloads/files.ts';
