import { verifiedProvider } from './connection.mjs';

const cid = process.env.RIADCHAIN_FILE_CID;
const rawSize = process.env.RIADCHAIN_FILE_EXPECTED_SIZE ?? '';
const maxBytes = 4 * 1024 * 1024;
if (!cid || !/^(?:0|[1-9]\d*)$/.test(rawSize)) {
  throw new Error('Set RIADCHAIN_FILE_CID and RIADCHAIN_FILE_EXPECTED_SIZE');
}
const expectedSize = Number(rawSize);
if (!Number.isSafeInteger(expectedSize) || expectedSize > maxBytes) {
  throw new Error('Expected FILE size must be at most 4 MiB for this example');
}
const provider = await verifiedProvider();
const bytes = await provider.getFileBytes(cid, {
  expectedSize,
  maxBytes,
  signal: AbortSignal.timeout(30_000),
});
console.log({ verifiedBytes: bytes.byteLength });
