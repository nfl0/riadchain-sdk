import {
  RiadchainProvider as RootProvider, LocalSigner as RootSigner, WalletSession as RootWallet,
  encodeContractArguments, decodeContractArguments, typedHash, type Transaction,
} from '@riadchain/sdk';
import {
  RiadchainProvider as BrowserProvider, LocalSigner as BrowserSigner, WalletSession as BrowserWallet,
} from '@riadchain/sdk/browser';
import { RiadchainProvider as LeafProvider } from '@riadchain/sdk/provider';
import { LocalSigner as LeafSigner } from '@riadchain/sdk/signer';
import { WalletSession as LeafWallet } from '@riadchain/sdk/wallet';
import { createNodeProvider } from '@riadchain/sdk/node';
import { buildContractCallTx } from '@riadchain/sdk/internal/txUtils';
import { describeFileBytes } from '@riadchain/sdk/internal/fileDescriptor';

// Assignments of classes with private members expose accidentally duplicated
// declaration trees. NodeNext also resolves every public subpath appended here.
declare const rootProvider: RootProvider;
declare const rootSigner: RootSigner;
declare const rootWallet: RootWallet;
const browserProvider: BrowserProvider = rootProvider;
const leafProvider: LeafProvider = browserProvider;
const browserSigner: BrowserSigner = rootSigner;
const leafSigner: LeafSigner = browserSigner;
const browserWallet: BrowserWallet = rootWallet;
const leafWallet: LeafWallet = browserWallet;
const nodeProvider: RootProvider = createNodeProvider('https://node.invalid');
const amount = 9007199254740993n;
const args = encodeContractArguments({ amount, nested: [null, -amount] });
const decoded: Record<string, unknown> = decodeContractArguments(args);
const hash: string = typedHash('sdk/release/v1', decoded);
const built = buildContractCallTx('riadchain-sdk-fixture', '0x1111111111111111111111111111111111111111',
  '0xc022222222222222222222222222222222222222', 'record', args, 1_700_000_000_000, [],
  { gasLimit: 100_000, callValue: amount });
if ('tx' in built) {
  const transaction: Transaction = built.tx;
  const output: bigint | undefined = transaction.outputs[0]?.amount;
  void output;
}
const description: Promise<{ cid: string; size: number; blocks: number }> = describeFileBytes(new Uint8Array([0, 255]));
const content: Promise<Uint8Array> = leafProvider.getFileBytes('fixture-cid', { expectedSize: 2, maxBytes: 2 });
void [leafSigner, leafWallet, nodeProvider, hash, description, content];
