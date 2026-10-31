import { describeFileBytes } from '@riadchain/sdk/internal/fileDescriptor';

// Descriptor computation is local: no node connection, upload or transaction.
const bytes = new TextEncoder().encode('Example application record\n');
const { cid, size } = await describeFileBytes(bytes);
console.log({ cid, size });
