import { getAddressFromPrivateKey, type EthAddress } from './internal/crypto.ts';
import { buildBatchTransferTx, buildCancelScheduledContractCallTx, buildCapabilityContractCallTx, buildCapabilityFileTx, buildContractCallTx, buildContractDeployTx, buildContractUpgradeTx, buildDeviceCapabilityGrantTx, buildDeviceCapabilityRevokeTx, buildDeviceCapabilityTopUpTx, buildFileTx, buildProductionSignerSetTx, buildProductionSignerRevokeTx, buildScheduledContractCallTx, buildSweepTx, buildTransferTx, signDelegatedTransaction, signTransaction, type CapabilityAuthorization, type DeviceCapabilityGrant, type Transaction, type UTXO } from './internal/txUtils.ts';
import type { TokenSpendIntent } from './types.ts';
import type { ProtocolParams } from './internal/protocolParams.ts';
import { REWARD_VAULT_SYSTEM_CONTRACT_ADDRESS } from '../lib/protocolConstants.ts';

export class LocalSigner {
  readonly privateKey: string;
  readonly address: EthAddress;

  constructor(privateKey: string) {
    const normalized = privateKey.trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
      throw new Error('Expected a 64-hex private key');
    }
    this.privateKey = normalized;
    this.address = getAddressFromPrivateKey(normalized);
  }

  buildTransfer(
    recipient: EthAddress,
    amount: bigint,
    utxos: UTXO[],
    options: { chainId: string; timestamp?: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildTransferTx(
      options.chainId,
      this.address,
      recipient,
      amount,
      options.timestamp ?? Date.now(),
      utxos,
      options.expiryHeight,
      options.protocolParams,
    );
    if ('error' in built) {
      throw new Error(built.error);
    }
    return built.tx;
  }

  buildSweep(
    recipient: EthAddress,
    utxos: UTXO[],
    options: { chainId: string; timestamp?: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildSweepTx(
      options.chainId,
      this.address,
      recipient,
      options.timestamp ?? Date.now(),
      utxos,
      options.expiryHeight,
      options.protocolParams,
    );
    if ('error' in built) throw new Error(built.error);
    return built.tx;
  }

  buildProductionSignerSet(
    signerAddress: EthAddress,
    utxos: UTXO[],
    options: { chainId: string; timestamp?: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildProductionSignerSetTx(options.chainId, this.address, signerAddress,
      options.timestamp ?? Date.now(), utxos, options);
    if ('error' in built) throw new Error(built.error);
    return built.tx;
  }

  buildProductionSignerRevoke(
    utxos: UTXO[],
    options: { chainId: string; timestamp?: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildProductionSignerRevokeTx(options.chainId, this.address,
      options.timestamp ?? Date.now(), utxos, options);
    if ('error' in built) throw new Error(built.error);
    return built.tx;
  }

  buildValidatorRewardClaim(
    amount: bigint,
    utxos: UTXO[],
    options: { chainId: string; gasLimit: number; timestamp?: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
  ): Transaction {
    if (amount <= BigInt(0)) throw new Error('Reward claim amount must be positive');
    const built = buildContractCallTx(
      options.chainId,
      this.address,
      REWARD_VAULT_SYSTEM_CONTRACT_ADDRESS as EthAddress,
      'claim',
      { amount: amount.toString() },
      options.timestamp ?? Date.now(),
      utxos,
      {
        gasLimit: options.gasLimit,
        expiryHeight: options.expiryHeight,
        protocolParams: options.protocolParams,
      },
    );
    if ('error' in built) throw new Error(built.error);
    return built.tx;
  }

  buildBatchTransfer(
    recipients: Array<{ address: EthAddress; amount: bigint }>,
    utxos: UTXO[],
    options: { chainId: string; timestamp?: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildBatchTransferTx(
      options.chainId,
      this.address,
      recipients,
      options.timestamp ?? Date.now(),
      utxos,
      options.expiryHeight,
      options.protocolParams,
    );
    if ('error' in built) {
      throw new Error(built.error);
    }
    return built.tx;
  }

  buildFile(
    file: { filename?: string; cid: string; size: number; storage: 'helia'; mimeType?: string },
    utxos: UTXO[],
    options: { chainId: string; timestamp?: number; expiryHeight?: number | null; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildFileTx(
      options.chainId,
      this.address,
      file,
      options.timestamp ?? Date.now(),
      utxos,
      options.expiryHeight,
      options.protocolParams,
    );
    if ('error' in built) {
      throw new Error(built.error);
    }
    return built.tx;
  }

  buildContractDeploy(
    code: string,
    utxos: UTXO[],
    options: {
      chainId: string;
      salt: string;
      timestamp?: number;
      expiryHeight?: number | null;
      gasLimit: number;
      upgradeAuthority?: EthAddress | null;
      protocolParams?: ProtocolParams;
    },
  ): { tx: Transaction; contractAddress: string } {
    const built = buildContractDeployTx(
      options.chainId,
      this.address,
      code,
      options.salt,
      options.timestamp ?? Date.now(),
      utxos,
      {
        gasLimit: options.gasLimit,
        expiryHeight: options.expiryHeight,
        upgradeAuthority: options.upgradeAuthority,
        protocolParams: options.protocolParams,
      },
    );
    if ('error' in built) {
      throw new Error(built.error);
    }
    return built;
  }

  buildContractUpgrade(
    contractAddress: EthAddress,
    newCode: string,
    utxos: UTXO[],
    options: {
      chainId: string;
      timestamp?: number;
      expiryHeight?: number | null;
      gasLimit: number;
      newAuthority?: EthAddress | null;
      protocolParams?: ProtocolParams;
    },
  ): Transaction {
    const built = buildContractUpgradeTx(
      options.chainId,
      this.address,
      contractAddress,
      newCode,
      options.timestamp ?? Date.now(),
      utxos,
      {
        gasLimit: options.gasLimit,
        expiryHeight: options.expiryHeight,
        protocolParams: options.protocolParams,
        ...('newAuthority' in options ? { newAuthority: options.newAuthority ?? null } : {}),
      },
    );
    if ('error' in built) {
      throw new Error(built.error);
    }
    return built.tx;
  }

  buildContractCall(
    contractAddress: EthAddress,
    method: string,
    data: any,
    utxos: UTXO[],
    options: { chainId: string; callValue?: bigint; tokenSpend?: TokenSpendIntent[]; authorization?: CapabilityAuthorization; expiryHeight?: number | null; gasLimit: number; timestamp?: number; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildContractCallTx(
      options.chainId,
      this.address,
      contractAddress,
      method,
      data,
      options.timestamp ?? Date.now(),
      utxos,
      {
        gasLimit: options.gasLimit,
        callValue: options.callValue,
        tokenSpend: options.tokenSpend,
        expiryHeight: options.expiryHeight,
        authorization: options.authorization,
        protocolParams: options.protocolParams,
      },
    );
    if ('error' in built) {
      throw new Error(built.error);
    }
    return built.tx;
  }

  buildDeviceCapabilityGrant(
    grant: DeviceCapabilityGrant,
    utxos: UTXO[],
    options: { chainId: string; gasLimit: number; expiryHeight?: number | null; timestamp?: number; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildDeviceCapabilityGrantTx(
      options.chainId, this.address, grant, options.timestamp ?? Date.now(), utxos, options,
    );
    if ('error' in built) throw new Error(built.error);
    return built.tx;
  }

  buildDeviceCapabilityRevoke(
    capabilityId: string,
    utxos: UTXO[],
    options: { chainId: string; gasLimit: number; expiryHeight?: number | null; timestamp?: number; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildDeviceCapabilityRevokeTx(
      options.chainId, this.address, capabilityId, options.timestamp ?? Date.now(), utxos, options,
    );
    if ('error' in built) throw new Error(built.error);
    return built.tx;
  }

  buildDeviceCapabilityTopUp(
    capabilityId: string,
    amount: bigint,
    utxos: UTXO[],
    options: { chainId: string; gasLimit: number; expiryHeight?: number | null; timestamp?: number; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildDeviceCapabilityTopUpTx(
      options.chainId, this.address, capabilityId, amount, options.timestamp ?? Date.now(), utxos, options,
    );
    if ('error' in built) throw new Error(built.error);
    return built.tx;
  }

  signDelegated(tx: Transaction): Transaction {
    return signDelegatedTransaction(tx, this.privateKey);
  }

  buildDelegatedContractCall(
    contractAddress: EthAddress,
    method: string,
    data: any,
    options: {
      chainId: string;
      capabilityId: string;
      sequence: number;
      gasLimit: number;
      expiryHeight?: number | null;
      timestamp?: number;
      protocolParams?: ProtocolParams;
    },
  ): Transaction {
    const built = buildCapabilityContractCallTx(
      options.chainId,
      contractAddress,
      method,
      data,
      options.timestamp ?? Date.now(),
      {
        gasLimit: options.gasLimit,
        expiryHeight: options.expiryHeight,
        capabilityId: options.capabilityId,
        sequence: options.sequence,
        protocolParams: options.protocolParams,
      },
    );
    return this.signDelegated(built);
  }

  buildDelegatedFile(
    file: { filename?: string; cid: string; size: number; storage: 'helia'; mimeType?: string },
    options: { chainId: string; capabilityId: string; sequence: number; expiryHeight?: number | null; timestamp?: number; protocolParams?: ProtocolParams },
  ): Transaction {
    return this.signDelegated(buildCapabilityFileTx(
      options.chainId,
      file,
      options.timestamp ?? Date.now(),
      options,
    ));
  }

  buildScheduledContractCall(
    contractAddress: EthAddress,
    method: string,
    data: any,
    executeAtHeight: number,
    utxos: UTXO[],
    options: { chainId: string; expiryHeight?: number | null; gasLimit: number; timestamp?: number; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildScheduledContractCallTx(
      options.chainId,
      this.address,
      contractAddress,
      method,
      data,
      executeAtHeight,
      options.timestamp ?? Date.now(),
      utxos,
      { gasLimit: options.gasLimit, expiryHeight: options.expiryHeight, protocolParams: options.protocolParams },
    );
    if ('error' in built) throw new Error(built.error);
    return built.tx;
  }

  buildCancelScheduledContractCall(
    scheduleId: string,
    utxos: UTXO[],
    options: { chainId: string; expiryHeight?: number | null; gasLimit: number; timestamp?: number; protocolParams?: ProtocolParams },
  ): Transaction {
    const built = buildCancelScheduledContractCallTx(
      options.chainId,
      this.address,
      scheduleId,
      options.timestamp ?? Date.now(),
      utxos,
      { gasLimit: options.gasLimit, expiryHeight: options.expiryHeight, protocolParams: options.protocolParams },
    );
    if ('error' in built) throw new Error(built.error);
    return built.tx;
  }

  sign(tx: Transaction): Transaction {
    return signTransaction(tx, this.privateKey);
  }
}
