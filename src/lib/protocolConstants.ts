/** Canonical address of the native token system contract. */
export const TOKEN_SYSTEM_CONTRACT_ADDRESS = '0x0000000000000000000000000000000000001000';

/** Canonical address of the native validator reward vault. */
export const REWARD_VAULT_SYSTEM_CONTRACT_ADDRESS = '0x0000000000000000000000000000000000001001';

/** Native account-level authorization for limited block production keys. */
export const PRODUCTION_SIGNER_SYSTEM_CONTRACT_ADDRESS = '0x0000000000000000000000000000000000001002';
export const PRODUCTION_SIGNER_GAS_LIMIT = 1_000;

/** Event emitted when the native token system creates a token. */
export const TOKEN_CREATED_EVENT = 'TokenCreated';
