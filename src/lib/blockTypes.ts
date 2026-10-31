import type { EthAddress } from './crypto.ts';
import type { CanonicalBlock } from './canonicalChainEncoding.ts';
import type { Transaction } from './txUtils.ts';

export type FileAvailabilityEntry = CanonicalBlock['fileAvailability'][number];
export type SuccessionProof = NonNullable<CanonicalBlock['successionProof']>;

export type Block = Omit<CanonicalBlock, 'transactions' | 'fileAvailability' | 'validatorAddress' | 'successionProof'> & {
  transactions: Transaction[];
  fileAvailability: FileAvailabilityEntry[];
  validatorAddress: EthAddress;
  successionProof: SuccessionProof | null;
};
