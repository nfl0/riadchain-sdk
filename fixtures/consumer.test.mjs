import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as sdk from '@riadchain/sdk';
import * as browser from '@riadchain/sdk/browser';
import * as providerModule from '@riadchain/sdk/provider';
import * as signerModule from '@riadchain/sdk/signer';
import * as walletModule from '@riadchain/sdk/wallet';
import { createNodeProvider } from '@riadchain/sdk/node';
import { buildContractCallTx, calculateFeeBreakdown } from '@riadchain/sdk/internal/txUtils';
import { calculateCanonicalTransactionHash } from '@riadchain/sdk/internal/canonicalChainEncoding';
import { describeFileBytes, describeFileByteStream } from '@riadchain/sdk/internal/fileDescriptor';

// No fixture is allowed to fall through to a real node or external service.
globalThis.fetch = async () => { throw new Error('Package verification attempted network access'); };

test('every declared public entry imports from the installed tarball', async () => {
  const specifiers = JSON.parse(await readFile(new URL('./exports.json', import.meta.url), 'utf8'));
  for (const specifier of specifiers) {
    assert(import.meta.resolve(specifier).startsWith(new URL('./node_modules/@riadchain/sdk/', import.meta.url).href));
    await import(specifier);
  }
});

test('public entry points share provider, signer and wallet class identities', () => {
  for (const [name, leaf] of [
    ['RiadchainProvider', providerModule],
    ['LocalSigner', signerModule],
    ['WalletSession', walletModule],
    ['WalletTransactionError', walletModule],
  ]) {
    assert.equal(sdk[name], browser[name], `${name}: root/browser identity`);
    assert.equal(sdk[name], leaf[name], `${name}: root/leaf identity`);
  }
  assert(createNodeProvider('https://node.invalid') instanceof sdk.RiadchainProvider);
});

test('canonical data preserves exact integers, domains and bytes', () => {
  assert.equal(Buffer.from(sdk.encodeCanonicalContractValue({ a: true })).toString('hex'), '8205a161618201f5');
  assert.equal(sdk.bytesSha256('616263'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sdk.bytesKeccak256(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  const value = 9007199254740993n;
  assert.equal(sdk.typedHash('sdk/release/v1', { b: value, a: null }), sdk.typedHash('sdk/release/v1', { a: null, b: value }));
  assert.notEqual(sdk.typedHash('sdk/release/v1', value), sdk.typedHash('sdk/release/v2', value));
  assert.notEqual(sdk.typedHash('sdk/release/v1', value), sdk.typedHash('sdk/release/v1', value.toString()));
  const data = { amount: value, nested: [null, -value, '9007199254740993'] };
  assert.deepEqual(sdk.decodeContractArguments(sdk.encodeContractArguments(data)), data);
  assert.throws(() => sdk.encodeContractArguments({ amount: Number(value) }), /safe integer/);
  for (const text of ['', '\0', '\ufeff', 'مرحبا 😀']) assert.equal(sdk.hexToUtf8(sdk.utf8ToHex(text)), text);
  assert.equal(sdk.base64ToHex(sdk.hexToBase64('fffe000102')), 'fffe000102');
});

test('an unsigned contract transaction retains bigint value and funding exactly', () => {
  const sender = `0x${'11'.repeat(20)}`;
  const recipient = `0xc0${'22'.repeat(19)}`;
  const funding = 10n ** 24n;
  const value = 9007199254740993n;
  const encoded = sdk.encodeContractArguments({ amount: value, memo: 'release fixture' });
  const built = buildContractCallTx('riadchain-sdk-fixture', sender, recipient, 'record', encoded, 1_700_000_000_000,
    [{ txId: 'ab'.repeat(32), outputIndex: 0, address: sender, amount: funding }],
    { gasLimit: 100_000, callValue: value, expiryHeight: 100 });
  assert(!('error' in built), 'error' in built ? built.error : '');
  assert.equal(built.tx.type, 'CONTRACT');
  assert.equal(built.tx.payload.value, value.toString());
  assert.equal(sdk.decodeContractArguments(built.tx.payload.data).amount, value);
  assert.equal(built.tx.outputs.reduce((sum, output) => sum + output.amount, 0n), funding - value - calculateFeeBreakdown(built.tx).totalFee);
  assert.equal(built.tx.id, calculateCanonicalTransactionHash(built.tx));
  assert(built.tx.inputs.every((input) => input.signature === ''), 'Fixture must remain unsigned');
});

test('FILE descriptions and bounded verified downloads round-trip arbitrary bytes', async () => {
  const bytes = Uint8Array.from({ length: 140_003 }, (_, index) => index & 255);
  const described = await describeFileBytes(bytes);
  async function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += 8191) yield bytes.subarray(offset, offset + 8191);
  }
  assert.deepEqual(await describeFileByteStream(chunks(), bytes.length), described);
  assert.equal((await describeFileBytes(new Uint8Array())).cid, 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
  const offsets = [];
  let corrupt = false;
  const transport = {
    async unary(method, _signal, _timeout, _headers, request) {
      assert.equal(method.parent.typeName, 'riadchain.v1.FileService');
      assert.equal(method.name, 'ReadContentChunk');
      assert.equal(request.cid, described.cid);
      const offset = Number(request.offset);
      offsets.push(offset);
      const content = bytes.slice(offset, offset + request.length);
      if (corrupt && offset > 0) content[0] ^= 1;
      return {
        stream: false, method, header: new Headers(), trailer: new Headers(),
        message: { cid: described.cid, totalSize: BigInt(bytes.length), offset: request.offset, content },
      };
    },
    async stream() { throw new Error('Unexpected streaming request'); },
  };
  const provider = new sdk.RiadchainProvider('https://node.invalid', undefined, { transport });
  assert.deepEqual(await provider.getFileBytes(described.cid, { maxBytes: bytes.length, expectedSize: bytes.length }), bytes);
  assert.deepEqual(offsets, [0, 65_536, 131_072]);
  await assert.rejects(provider.getFileBytes(described.cid, { maxBytes: 10 }), /download bounds/);
  corrupt = true;
  await assert.rejects(provider.getFileBytes(described.cid, { maxBytes: bytes.length }), /canonical CID/);
});

if (process.env.RIADCHAIN_VERIFY_BROWSER_BUNDLE === '1') {
  test('the browser bundle executes without process, Buffer, require or Bun', async () => {
    const context = {
      console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
      URL, URLSearchParams, Headers, Request, Response, AbortController, AbortSignal,
      Event, EventTarget, CustomEvent, MessageEvent, DOMException,
      ReadableStream, WritableStream, TransformStream, Blob, File,
      atob, btoa, crypto: webcrypto, setTimeout, clearTimeout, structuredClone,
      fetch: globalThis.fetch,
    };
    const source = await readFile(new URL('./browser.bundle.mjs', import.meta.url), 'utf8');
    runInNewContext(source, context, { timeout: 10_000, filename: 'browser.bundle.mjs' });
    const result = await context.sdkBrowserVerification;
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { verified: true, bytes: 70_001 });
  });
}
