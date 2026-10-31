import {
  RiadchainProvider, encodeContractArguments, decodeContractArguments,
  bytesSha256, typedHash, hexToUtf8, utf8ToHex,
} from '@riadchain/sdk/browser';
import { describeFileBytes } from '@riadchain/sdk/internal/fileDescriptor';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

// This same bundle can be served to a real browser by release qualification.
// It requires no credentials, live node, service or Node compatibility globals.
globalThis.sdkBrowserVerification = (async () => {
  check(typeof globalThis.process === 'undefined' && typeof globalThis.Buffer === 'undefined'
    && typeof globalThis.require === 'undefined' && typeof globalThis.Bun === 'undefined', 'Node globals leaked into the browser fixture');
  check(bytesSha256('616263') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'Browser byte hash mismatch');
  const value = 9007199254740993n;
  check(decodeContractArguments(encodeContractArguments({ value })).value === value, 'Browser integer precision lost');
  check(typedHash('sdk/release/v1', { a: value, b: null }) === typedHash('sdk/release/v1', { b: null, a: value }), 'Browser canonical ordering mismatch');
  check(hexToUtf8(utf8ToHex('\ufeffمرحبا 😀\0')) === '\ufeffمرحبا 😀\0', 'Browser Unicode codec mismatch');
  const bytes = Uint8Array.from({ length: 70_001 }, (_, index) => index & 255);
  const { cid } = await describeFileBytes(bytes);
  const provider = new RiadchainProvider('https://node.invalid', undefined, {
    transport: {
      async unary(method, _signal, _timeout, _headers, request) {
        check(method.name === 'ReadContentChunk' && request.cid === cid, 'Unexpected browser transport call');
        return {
          stream: false, method, header: new Headers(), trailer: new Headers(),
          message: { cid, totalSize: BigInt(bytes.length), offset: request.offset,
            content: bytes.slice(Number(request.offset), Number(request.offset) + request.length) },
        };
      },
      async stream() { throw new Error('Unexpected browser streaming request'); },
    },
  });
  const downloaded = await provider.getFileBytes(cid, { expectedSize: bytes.length, maxBytes: bytes.length });
  check(downloaded.length === bytes.length && downloaded.every((byte, index) => byte === bytes[index]), 'Browser FILE round-trip mismatch');
  return { verified: true, bytes: bytes.length };
})();
