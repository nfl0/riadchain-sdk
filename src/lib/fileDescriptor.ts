import {
  unixfsDescribeBytes,
  unixfsDescribeByteStream,
  type ByteStreamSource,
} from './unixfsCodec.ts';

export interface CanonicalFileDescription {
  cid: string;
  size: number;
  blocks: number;
}

export type CanonicalFileByteStream = ByteStreamSource;

// CID-only description: the importer hashes the canonical UnixFS DAG but the
// descriptor path discards block bodies instead of retaining a second full
// in-memory copy of large uploads.
export async function describeFileBytes(bytes: Uint8Array): Promise<CanonicalFileDescription> {
  const described = await unixfsDescribeBytes(bytes);
  return {
    cid: described.cid.toString(),
    size: Number(described.size ?? BigInt(bytes.byteLength)),
    blocks: described.blocks,
  };
}

export async function describeFileText(text: string): Promise<CanonicalFileDescription> {
  return describeFileBytes(new TextEncoder().encode(text));
}

export async function describeFileByteStream(
  stream: CanonicalFileByteStream,
  fallbackSize?: number,
): Promise<CanonicalFileDescription> {
  const described = await unixfsDescribeByteStream(stream);
  return {
    cid: described.cid.toString(),
    size: Number(described.size ?? BigInt(fallbackSize ?? 0)),
    blocks: described.blocks,
  };
}
