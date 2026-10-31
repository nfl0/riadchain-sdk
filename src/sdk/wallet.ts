import type { DeviceCapabilityGrant, EthAddress, TokenSpendIntent, Transaction, UTXO } from './types.ts';
import { RiadchainNodeError, RiadchainProvider } from './provider.ts';
import { classifyTransactionOutcome, waitForTransactionOutcome, type TransactionOutcome } from './transactionOutcome.ts';
import { normalizeProtocolParamsShape, type ProtocolParams } from './internal/protocolParams.ts';
import { LocalSigner } from './signer.ts';
import { describeFileBytes, describeFileText } from './internal/fileDescriptor.ts';
import {
  TOKEN_CREATED_EVENT,
  TOKEN_SYSTEM_CONTRACT_ADDRESS,
} from '../lib/protocolConstants.ts';

/** Keep the exact submitted transaction available for reconciliation before any retry. */
export class WalletTransactionError extends Error {
  constructor(
    message: string,
    readonly transaction: Transaction,
    readonly status: 'unknown' | 'failed',
    readonly outcome?: TransactionOutcome,
    cause?: unknown,
  ) {
    super(`${message} Transaction ${transaction.id}; reconcile this ID before sending again.`, { cause });
    this.name = 'WalletTransactionError';
  }
}

export class WalletSession {
  utxos: UTXO[] = [];
  balance: bigint = BigInt(0);
  rewardBalance: bigint = BigInt(0);
  private chainId: string | null = null;
  private protocolParams: ProtocolParams | null = null;
  readonly provider: RiadchainProvider;
  readonly signer: LocalSigner;

  constructor(
    provider: RiadchainProvider,
    signer: LocalSigner,
  ) {
    this.provider = provider;
    this.signer = signer;
  }

  get address(): EthAddress {
    return this.signer.address;
  }

  private async submitTransaction(
    tx: Transaction,
    options: { waitForConfirmation?: boolean; timeoutMs?: number },
    upload?: (txId: string) => Promise<unknown>,
  ): Promise<{ tx: Transaction }> {
    // Public balance reads do not establish access to the protected Send route.
    // Ask the node so intentionally unauthenticated local configurations still work.
    try {
      await this.provider.getProductionSigner(this.address);
    } catch (error) {
      if (error instanceof RiadchainNodeError && error.code === 16) {
        throw new Error('Node RPC credential is missing or rejected; configure the connection credential before signing or sending.', { cause: error });
      }
      throw error;
    }
    const signed = this.signer.sign(tx);
    let result: { tx: Transaction };
    try {
      result = await this.provider.sendTransaction(signed);
      if (upload) await upload(signed.id);
    } catch (error) {
      throw new WalletTransactionError('Submission could not be verified.', signed, 'unknown', undefined, error);
    }
    if (options.waitForConfirmation) {
      let outcome: TransactionOutcome;
      try {
        outcome = await waitForTransactionOutcome(this.provider, signed.id, { timeoutMs: options.timeoutMs });
      } catch (error) {
        throw new WalletTransactionError('Confirmation could not be verified.', signed, 'unknown', undefined, error);
      }
      if (outcome.status !== 'confirmed') {
        throw new WalletTransactionError(outcome.error || 'Transaction execution failed.', signed,
          outcome.status === 'failed' ? 'failed' : 'unknown', outcome);
      }
    }
    return result;
  }

  private consumeConfirmedInputs(tx: Transaction): void {
    const spent = new Set(tx.inputs.map((input) => `${input.txId}:${input.outputIndex}`));
    this.utxos = this.utxos.filter((utxo) => !spent.has(`${utxo.txId}:${utxo.outputIndex}`));
    this.balance = this.utxos.reduce((sum, utxo) => sum + utxo.amount, BigInt(0));
  }

  private requireChainId(): string {
    if (!this.chainId) {
      throw new Error('WalletSession has no cached chainId; call refresh() first');
    }
    return this.chainId;
  }

  private requireProtocolParams(): ProtocolParams {
    if (!this.protocolParams) throw new Error('WalletSession has no validated genesis policy; call refresh() first');
    return this.protocolParams;
  }

  private async ensureSpendCache(): Promise<void> {
    if (this.utxos.length > 0 && this.chainId && this.protocolParams) {
      return;
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.protocolParams = null;
    const [balances, utxos, chainId, fetchedParams] = await Promise.all([
      this.provider.getBalanceSummary(this.address),
      this.provider.getUtxos(this.address),
      this.provider.getChainId(),
      this.provider.getProtocolParams(),
    ]);
    const protocolParams = normalizeProtocolParamsShape(fetchedParams);
    if (!protocolParams) throw new Error('Node returned invalid genesis protocol parameters');
    this.balance = balances.balance;
    this.rewardBalance = balances.rewardBalance;
    this.utxos = utxos;
    this.chainId = chainId;
    this.protocolParams = protocolParams;
  }

  async refreshUtxos(): Promise<void> {
    this.protocolParams = null;
    const [utxos, chainId, fetchedParams] = await Promise.all([
      this.provider.getUtxos(this.address), this.provider.getChainId(), this.provider.getProtocolParams(),
    ]);
    const protocolParams = normalizeProtocolParamsShape(fetchedParams);
    if (!protocolParams) throw new Error('Node returned invalid genesis protocol parameters');
    this.utxos = utxos;
    this.balance = utxos.reduce((sum, utxo) => sum + utxo.amount, BigInt(0));
    this.chainId = chainId;
    this.protocolParams = protocolParams;
  }

  async buildTransfer(recipient: EthAddress, amount: bigint, options: { expiryHeight?: number | null } = {}): Promise<Transaction> {
    await this.refresh();
    return this.signer.buildTransfer(recipient, amount, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      expiryHeight: options.expiryHeight,
    });
  }

  buildTransferFromCachedUtxos(
    recipient: EthAddress,
    amount: bigint,
    options: { expiryHeight?: number | null; timestamp?: number } = {},
  ): Transaction {
    if (this.utxos.length === 0) {
      throw new Error('WalletSession has no cached UTXOs; call refresh() first');
    }
    return this.signer.buildTransfer(recipient, amount, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      expiryHeight: options.expiryHeight,
      timestamp: options.timestamp,
    });
  }

  async buildBatchTransfer(
    recipients: Array<{ address: EthAddress; amount: bigint }>,
    options: { expiryHeight?: number | null } = {},
  ): Promise<Transaction> {
    await this.refresh();
    return this.signer.buildBatchTransfer(recipients, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      expiryHeight: options.expiryHeight,
    });
  }

  buildBatchTransferFromCachedUtxos(
    recipients: Array<{ address: EthAddress; amount: bigint }>,
    options: { expiryHeight?: number | null; timestamp?: number } = {},
  ): Transaction {
    if (this.utxos.length === 0) {
      throw new Error('WalletSession has no cached UTXOs; call refresh() first');
    }
    return this.signer.buildBatchTransfer(recipients, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      expiryHeight: options.expiryHeight,
      timestamp: options.timestamp,
    });
  }

  async sendTransfer(recipient: EthAddress, amount: bigint, options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number } = {}): Promise<{ tx: Transaction; confirmed: boolean }> {
    const tx = options.waitForConfirmation
      ? await this.buildTransfer(recipient, amount, options)
      : (await this.ensureSpendCache(), this.buildTransferFromCachedUtxos(recipient, amount, options));
    const result = await this.submitTransaction(tx, options);
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return {
      tx: result.tx,
      confirmed: !!options.waitForConfirmation,
    };
  }

  async sendTransferFromCachedUtxos(
    recipient: EthAddress,
    amount: bigint,
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; timestamp?: number } = {},
  ): Promise<{ tx: Transaction; confirmed: boolean }> {
    const tx = this.buildTransferFromCachedUtxos(recipient, amount, options);
    const result = await this.submitTransaction(tx, options);
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return {
      tx: result.tx,
      confirmed: !!options.waitForConfirmation,
    };
  }

  async sendBatchTransfer(
    recipients: Array<{ address: EthAddress; amount: bigint }>,
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number } = {},
  ): Promise<{ tx: Transaction; confirmed: boolean }> {
    const tx = options.waitForConfirmation
      ? await this.buildBatchTransfer(recipients, options)
      : (await this.ensureSpendCache(), this.buildBatchTransferFromCachedUtxos(recipients, options));
    const result = await this.submitTransaction(tx, options);
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return {
      tx: result.tx,
      confirmed: !!options.waitForConfirmation,
    };
  }

  async sendBatchTransferFromCachedUtxos(
    recipients: Array<{ address: EthAddress; amount: bigint }>,
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; timestamp?: number } = {},
  ): Promise<{ tx: Transaction; confirmed: boolean }> {
    const tx = this.buildBatchTransferFromCachedUtxos(recipients, options);
    const result = await this.submitTransaction(tx, options);
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return {
      tx: result.tx,
      confirmed: !!options.waitForConfirmation,
    };
  }

  buildFileFromCachedUtxos(
    file: { filename?: string; cid: string; size: number; storage: 'helia'; mimeType?: string },
    options: { expiryHeight?: number | null; timestamp?: number } = {},
  ): Transaction {
    if (this.utxos.length === 0) {
      throw new Error('WalletSession has no cached UTXOs; call refresh() first');
    }
    return this.signer.buildFile(file, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      expiryHeight: options.expiryHeight,
      timestamp: options.timestamp,
    });
  }

  async sendFile(
    file: { filename?: string; content: string; mimeType?: string },
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number } = {},
  ): Promise<{ tx: Transaction; cid: string }> {
    const described = await describeFileText(file.content);
    const builtFile = {
      filename: file.filename,
      cid: described.cid,
      size: described.size,
      storage: 'helia' as const,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    };
    const tx = options.waitForConfirmation
      ? (await this.refresh(), this.signer.buildFile(builtFile, this.utxos, {
        chainId: this.requireChainId(),
        protocolParams: this.requireProtocolParams(),
        expiryHeight: options.expiryHeight,
      }))
      : (await this.ensureSpendCache(), this.buildFileFromCachedUtxos(builtFile, options));
    const result = await this.submitTransaction(tx, options, txId => this.provider.uploadFileText(txId, file.content));
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return {
      tx: result.tx,
      cid: described.cid,
    };
  }

  async sendFileFromCachedUtxos(
    file: { filename?: string; content: string; mimeType?: string },
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; timestamp?: number } = {},
  ): Promise<{ tx: Transaction; cid: string }> {
    const described = await describeFileText(file.content);
    const tx = this.buildFileFromCachedUtxos({
      filename: file.filename,
      cid: described.cid,
      size: described.size,
      storage: 'helia',
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    }, options);
    const result = await this.submitTransaction(tx, options, txId => this.provider.uploadFileText(txId, file.content));
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return {
      tx: result.tx,
      cid: described.cid,
    };
  }

  async sendFileBytes(
    file: { filename?: string; content: Uint8Array; mimeType?: string },
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number } = {},
  ): Promise<{ tx: Transaction; cid: string }> {
    const described = await describeFileBytes(file.content);
    const builtFile = {
      filename: file.filename,
      cid: described.cid,
      size: described.size,
      storage: 'helia' as const,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    };
    const tx = options.waitForConfirmation
      ? (await this.refresh(), this.signer.buildFile(builtFile, this.utxos, {
        chainId: this.requireChainId(),
        protocolParams: this.requireProtocolParams(),
        expiryHeight: options.expiryHeight,
      }))
      : (await this.ensureSpendCache(), this.buildFileFromCachedUtxos(builtFile, options));
    const result = await this.submitTransaction(tx, options, txId => this.provider.uploadFileBytes(txId, file.content));
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return {
      tx: result.tx,
      cid: described.cid,
    };
  }

  async sendFileBytesFromCachedUtxos(
    file: { filename?: string; content: Uint8Array; mimeType?: string },
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; timestamp?: number } = {},
  ): Promise<{ tx: Transaction; cid: string }> {
    const described = await describeFileBytes(file.content);
    const tx = this.buildFileFromCachedUtxos({
      filename: file.filename,
      cid: described.cid,
      size: described.size,
      storage: 'helia',
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    }, options);
    const result = await this.submitTransaction(tx, options, txId => this.provider.uploadFileBytes(txId, file.content));
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return {
      tx: result.tx,
      cid: described.cid,
    };
  }

  buildContractDeployFromCachedUtxos(
    code: string,
    options: {
      salt: string;
      expiryHeight?: number | null;
      gasLimit: number;
      timestamp?: number;
      upgradeAuthority?: EthAddress | null;
    },
  ): { tx: Transaction; contractAddress: string } {
    if (this.utxos.length === 0) {
      throw new Error('WalletSession has no cached UTXOs; call refresh() first');
    }
    return this.signer.buildContractDeploy(code, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      salt: options.salt,
      expiryHeight: options.expiryHeight,
      gasLimit: options.gasLimit,
      timestamp: options.timestamp,
      upgradeAuthority: options.upgradeAuthority,
    });
  }

  async sendContractDeploy(
    code: string,
    options: {
      salt: string;
      expiryHeight?: number | null;
      waitForConfirmation?: boolean;
      timeoutMs?: number;
      gasLimit: number;
      upgradeAuthority?: EthAddress | null;
    },
  ): Promise<{ tx: Transaction; contractAddress: string }> {
    const built = options.waitForConfirmation
      ? (await this.refresh(), this.signer.buildContractDeploy(code, this.utxos, {
        chainId: this.requireChainId(),
        protocolParams: this.requireProtocolParams(),
        salt: options.salt,
        expiryHeight: options.expiryHeight,
        gasLimit: options.gasLimit,
        upgradeAuthority: options.upgradeAuthority,
      }))
      : (await this.ensureSpendCache(), this.buildContractDeployFromCachedUtxos(code, options));
    const result = await this.submitTransaction(built.tx, options);
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(built.tx);
    }
    return {
      tx: result.tx,
      contractAddress: built.contractAddress,
    };
  }

  async sendContractUpgrade(
    contractAddress: EthAddress,
    newCode: string,
    options: {
      expiryHeight?: number | null;
      waitForConfirmation?: boolean;
      timeoutMs?: number;
      gasLimit: number;
      newAuthority?: EthAddress | null;
    },
  ): Promise<{ tx: Transaction }> {
    await this.refresh();
    const tx = this.signer.buildContractUpgrade(contractAddress, newCode, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      expiryHeight: options.expiryHeight,
      gasLimit: options.gasLimit,
      ...('newAuthority' in options ? { newAuthority: options.newAuthority ?? null } : {}),
    });
    const result = await this.submitTransaction(tx, options);
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return { tx: result.tx };
  }

  async sendContractCall(
    contractAddress: EthAddress,
    method: string,
    data: any,
    options: { callValue?: bigint; tokenSpend?: TokenSpendIntent[]; expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; gasLimit: number },
  ): Promise<{ tx: Transaction }> {
    const tx = options.waitForConfirmation
      ? (await this.refresh(), this.signer.buildContractCall(contractAddress, method, data, this.utxos, {
        chainId: this.requireChainId(),
        protocolParams: this.requireProtocolParams(),
        callValue: options.callValue,
        tokenSpend: options.tokenSpend,
        expiryHeight: options.expiryHeight,
        gasLimit: options.gasLimit,
      }))
      : (await this.ensureSpendCache(), this.buildContractCallFromCachedUtxos(contractAddress, method, data, options));
    const result = await this.submitTransaction(tx, options);
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return { tx: result.tx };
  }

  /** Build an unsigned owner transaction for review before signing and submission. */
  async buildProductionSignerSet(
    signerAddress: EthAddress,
    options: { expiryHeight?: number | null; timestamp?: number } = {},
  ): Promise<Transaction> {
    await this.refresh();
    return this.signer.buildProductionSignerSet(signerAddress, this.utxos, {
      ...options, chainId: this.requireChainId(), protocolParams: this.requireProtocolParams(),
    });
  }

  /** Build an unsigned revocation; the owner remains able to sign blocks. */
  async buildProductionSignerRevoke(
    options: { expiryHeight?: number | null; timestamp?: number } = {},
  ): Promise<Transaction> {
    await this.refresh();
    return this.signer.buildProductionSignerRevoke(this.utxos, {
      ...options, chainId: this.requireChainId(), protocolParams: this.requireProtocolParams(),
    });
  }

  async claimValidatorRewards(
    amount?: bigint,
    options: { timeoutMs?: number; gasLimit?: number } = {},
  ): Promise<{ tx: Transaction }> {
    await this.refresh();
    const claimAmount = amount ?? this.rewardBalance;
    if (claimAmount <= BigInt(0)) throw new Error('No validator rewards are available to claim');
    if (claimAmount > this.rewardBalance) throw new Error('Reward claim exceeds available balance');
    const tx = this.signer.buildValidatorRewardClaim(claimAmount, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      gasLimit: options.gasLimit ?? 10_000,
    });
    const result = await this.submitTransaction(tx, { ...options, waitForConfirmation: true });
    await this.refresh();
    return { tx: result.tx };
  }

  async scheduleContractCall(
    contractAddress: EthAddress,
    method: string,
    data: any,
    executeAtHeight: number,
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; gasLimit: number },
  ): Promise<{ tx: Transaction }> {
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      await this.ensureSpendCache();
    }
    const tx = this.signer.buildScheduledContractCall(
      contractAddress,
      method,
      data,
      executeAtHeight,
      this.utxos,
      {
        chainId: this.requireChainId(),
        protocolParams: this.requireProtocolParams(),
        expiryHeight: options.expiryHeight,
        gasLimit: options.gasLimit,
      },
    );
    const result = await this.submitTransaction(tx, options);
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return { tx: result.tx };
  }

  async cancelScheduledContractCall(
    scheduleId: string,
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; gasLimit: number },
  ): Promise<{ tx: Transaction }> {
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      await this.ensureSpendCache();
    }
    const tx = this.signer.buildCancelScheduledContractCall(scheduleId, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      expiryHeight: options.expiryHeight,
      gasLimit: options.gasLimit,
    });
    const result = await this.submitTransaction(tx, options);
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return { tx: result.tx };
  }

  async grantDeviceCapability(
    grant: DeviceCapabilityGrant,
    options: { expiryHeight?: number | null; timeoutMs?: number; gasLimit?: number } = {},
  ): Promise<{ tx: Transaction }> {
    await this.refresh();
    const tx = this.signer.buildDeviceCapabilityGrant(grant, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      expiryHeight: options.expiryHeight,
      gasLimit: options.gasLimit ?? 100_000,
    });
    const result = await this.submitTransaction(tx, { ...options, waitForConfirmation: true });
    await this.refresh();
    return { tx: result.tx };
  }

  async revokeDeviceCapability(
    capabilityId: string,
    options: { expiryHeight?: number | null; timeoutMs?: number; gasLimit?: number } = {},
  ): Promise<{ tx: Transaction }> {
    await this.refresh();
    const tx = this.signer.buildDeviceCapabilityRevoke(capabilityId, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      expiryHeight: options.expiryHeight,
      gasLimit: options.gasLimit ?? 50_000,
    });
    const result = await this.submitTransaction(tx, { ...options, waitForConfirmation: true });
    await this.refresh();
    return { tx: result.tx };
  }

  async topUpDeviceCapability(
    capabilityId: string,
    amount: bigint,
    options: { expiryHeight?: number | null; timeoutMs?: number; gasLimit?: number } = {},
  ): Promise<{ tx: Transaction }> {
    await this.refresh();
    const tx = this.signer.buildDeviceCapabilityTopUp(capabilityId, amount, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      expiryHeight: options.expiryHeight,
      gasLimit: options.gasLimit ?? 50_000,
    });
    const result = await this.submitTransaction(tx, { ...options, waitForConfirmation: true });
    await this.refresh();
    return { tx: result.tx };
  }

  buildContractCallFromCachedUtxos(
    contractAddress: EthAddress,
    method: string,
    data: any,
    options: { callValue?: bigint; tokenSpend?: TokenSpendIntent[]; expiryHeight?: number | null; gasLimit: number; timestamp?: number },
  ): Transaction {
    if (this.utxos.length === 0) {
      throw new Error('WalletSession has no cached UTXOs; call refresh() first');
    }
    return this.signer.buildContractCall(contractAddress, method, data, this.utxos, {
      chainId: this.requireChainId(),
      protocolParams: this.requireProtocolParams(),
      callValue: options.callValue,
      tokenSpend: options.tokenSpend,
      expiryHeight: options.expiryHeight,
      gasLimit: options.gasLimit,
      timestamp: options.timestamp,
    });
  }

  async sendContractCallFromCachedUtxos(
    contractAddress: EthAddress,
    method: string,
    data: any,
    options: { callValue?: bigint; tokenSpend?: TokenSpendIntent[]; expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; gasLimit: number; timestamp?: number },
  ): Promise<{ tx: Transaction }> {
    const tx = this.buildContractCallFromCachedUtxos(contractAddress, method, data, options);
    const result = await this.submitTransaction(tx, options);
    if (options.waitForConfirmation) {
      await this.refresh();
    } else {
      this.consumeConfirmedInputs(tx);
    }
    return { tx: result.tx };
  }

  async createToken(
    params: {
      name: string;
      symbol: string;
      type: bigint;
      maxSupply: bigint;
      uri?: string | null;
    },
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; gasLimit: number },
  ): Promise<{ tx: Transaction; tokenId?: bigint }> {
    const result = await this.sendContractCall(
      TOKEN_SYSTEM_CONTRACT_ADDRESS as EthAddress,
      'create',
      {
        method: 'create',
        name: params.name,
        symbol: params.symbol,
        type: params.type,
        maxSupply: params.maxSupply,
        ...(params.uri !== undefined ? { uri: params.uri } : {}),
      },
      options,
    );

    if (!options.waitForConfirmation) {
      return result;
    }

    let receipt;
    try {
      const [context, fetchedReceipt] = await Promise.all([
        this.provider.getTransaction(result.tx.id), this.provider.getReceipt(result.tx.id),
      ]);
      const outcome = classifyTransactionOutcome(context, fetchedReceipt);
      if (context.transaction.id !== result.tx.id || outcome.status !== 'confirmed') {
        throw new WalletTransactionError(outcome.error || 'Token creation receipt could not be verified.', result.tx,
          outcome.status === 'failed' ? 'failed' : 'unknown', outcome);
      }
      receipt = fetchedReceipt;
    } catch (error) {
      if (error instanceof WalletTransactionError) throw error;
      throw new WalletTransactionError('Token creation receipt could not be verified.', result.tx, 'unknown', undefined, error);
    }
    const createdEvent = receipt.events.find(
      (event) => event.contractAddress.toLowerCase() === TOKEN_SYSTEM_CONTRACT_ADDRESS.toLowerCase()
        && event.eventName === TOKEN_CREATED_EVENT,
    );
    const tokenId = typeof createdEvent?.data === 'object' && createdEvent.data && 'token-id' in (createdEvent.data as Record<string, unknown>)
      ? BigInt(String((createdEvent.data as Record<string, unknown>)['token-id']))
      : undefined;

    return { tx: result.tx, tokenId };
  }

  mintToken(
    tokenId: bigint,
    to: EthAddress,
    amount: bigint,
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; gasLimit: number },
  ): Promise<{ tx: Transaction }> {
    return this.sendContractCall(
      TOKEN_SYSTEM_CONTRACT_ADDRESS as EthAddress,
      'mint',
      {
        method: 'mint',
        tokenId,
        to,
        amount,
      },
      options,
    );
  }

  burnToken(
    tokenId: bigint,
    from: EthAddress,
    amount: bigint,
    options: { expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; gasLimit: number },
  ): Promise<{ tx: Transaction }> {
    return this.sendContractCall(
      TOKEN_SYSTEM_CONTRACT_ADDRESS as EthAddress,
      'burn',
      {
        method: 'burn',
        tokenId,
        from,
        amount,
      },
      options,
    );
  }

  transferToken(
    tokenId: bigint,
    to: EthAddress,
    amount: bigint,
    options: { from?: EthAddress; expiryHeight?: number | null; waitForConfirmation?: boolean; timeoutMs?: number; gasLimit: number },
  ): Promise<{ tx: Transaction }> {
    return this.sendContractCall(
      TOKEN_SYSTEM_CONTRACT_ADDRESS as EthAddress,
      'transfer',
      {
        method: 'transfer',
        tokenId,
        from: options.from ?? this.address,
        to,
        amount,
      },
      options,
    );
  }

}
