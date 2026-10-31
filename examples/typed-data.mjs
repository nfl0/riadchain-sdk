import { bytesSha256, typedHash, utf8ToHex } from '@riadchain/sdk/browser';

// Fictional application data. This computes hashes locally; it signs nothing.
const value = { sequence: 1n, samples: 12n, available: true };
const hash = typedHash('example.ping/checkpoint/v1', value);
const byteHash = bytesSha256(utf8ToHex('Example application record\n'));
console.log({ hash, byteHash });
