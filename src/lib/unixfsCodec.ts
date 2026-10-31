// Direct UnixFS import/export against a blockstore, replacing the former
// @helia/unixfs + libp2p wrapper. @helia/unixfs was only a thin shim over
// ipfs-unixfs-importer / ipfs-unixfs-exporter, and its libp2p instance was
// fully inert (no transports/discovery/services) — peer file transfer goes
// over ConnectRPC, not libp2p. Using the importer/exporter directly drops the
// entire libp2p + Helia dependency trees with byte-identical CIDs.
//
// CONSENSUS-CRITICAL: FILE-transaction CIDs are chain state. `ADD_OPTIONS`
// must stay byte-identical to the historical @helia/unixfs defaults used
// here (cidVersion 1, rawLeaves, fixedSize(FILE_CHUNK_SIZE), balanced).
// Verified via CID-parity spike across empty/tiny/exact-chunk/multi-chunk.
import type { Blockstore } from 'interface-blockstore';
import { importer, type ImportResult, type WritableStorage } from 'ipfs-unixfs-importer';
import { exporter } from 'ipfs-unixfs-exporter';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import type { CID } from 'multiformats/cid';
import { FILE_CHUNK_SIZE } from './fileConstants.ts';

// Importer byte-source input (a Node Readable satisfies AsyncIterable<Uint8Array>).
export type ByteStreamSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

type UnixFsStat = {
  type: string;
  size: bigint;
  mode?: number;
  mtime?: { secs: bigint; nsecs?: number };
  unixfs?: { blockSizes: bigint[] };
};

export type UnixFsDescription = {
  cid: CID;
  size: bigint;
  blocks: number;
};

function addOptions() {
  return {
    cidVersion: 1 as const,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: FILE_CHUNK_SIZE }),
    layout: balanced(),
  };
}

async function importLast(
  blockstore: Blockstore,
  content: Uint8Array | ByteStreamSource,
): Promise<CID> {
  const last = await importLastResult(blockstore, content);
  return last.cid;
}

async function importLastResult(
  blockstore: WritableStorage,
  content: Uint8Array | ByteStreamSource,
): Promise<ImportResult> {
  let last: ImportResult | undefined;
  for await (const entry of importer([{ content }], blockstore, addOptions())) {
    last = entry;
  }
  if (!last) {
    throw new Error('unixfs importer produced no entry');
  }
  return last;
}

export async function unixfsAddBytes(blockstore: Blockstore, bytes: Uint8Array): Promise<CID> {
  return importLast(blockstore, bytes);
}

export async function unixfsAddByteStream(
  blockstore: Blockstore,
  stream: ByteStreamSource,
): Promise<CID> {
  return importLast(blockstore, stream);
}

async function describeImport(content: Uint8Array | ByteStreamSource): Promise<UnixFsDescription> {
  // The importer computes every leaf and parent CID before calling put. A
  // descriptor needs only the final import result, so retaining the complete
  // file DAG in a MemoryBlockstore would multiply client memory for large
  // uploads without changing the canonical CID.
  const discardBlockstore: WritableStorage = {
    put(cid) {
      return cid;
    },
  };
  const result = await importLastResult(discardBlockstore, content);
  return {
    cid: result.cid,
    size: result.unixfs?.fileSize() ?? result.size,
    blocks: result.unixfs?.blockSizes.length ?? 1,
  };
}

export async function unixfsDescribeBytes(bytes: Uint8Array): Promise<UnixFsDescription> {
  return describeImport(bytes);
}

export async function unixfsDescribeByteStream(stream: ByteStreamSource): Promise<UnixFsDescription> {
  return describeImport(stream);
}

export async function unixfsStat(blockstore: Blockstore, cid: CID): Promise<UnixFsStat> {
  const entry = await exporter(cid, blockstore);
  // exporter's UnixFSEntry is an awkward union (not every member exposes
  // `size`); structural view over the fields we read (runtime shape verified
  // against the former @helia/unixfs stat via the CID-parity spike).
  const e = entry as unknown as {
    type: string;
    size?: bigint | number;
    unixfs?: { blockSizes?: bigint[]; mode?: number; mtime?: { secs: bigint; nsecs?: number } };
  };
  const meta = e.unixfs;
  return {
    type: e.type,
    size: BigInt(e.size ?? 0n),
    mode: meta?.mode,
    mtime: meta?.mtime,
    unixfs: meta?.blockSizes ? { blockSizes: meta.blockSizes } : undefined,
  };
}

export async function* unixfsCat(blockstore: Blockstore, cid: CID): AsyncGenerator<Uint8Array> {
  const entry = await exporter(cid, blockstore);
  if (entry.type !== 'file' && entry.type !== 'raw') {
    throw new Error(`CID ${cid.toString()} is not a UnixFS file (type=${entry.type})`);
  }
  yield* entry.content();
}
