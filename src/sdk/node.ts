import { createConnectTransport } from '@connectrpc/connect-node';
import { createConnectTransport as createFetchConnectTransport } from '@connectrpc/connect-web';
import type { Interceptor, Transport } from '@connectrpc/connect';
import { createFileUploadFetch, RiadchainProvider } from './provider.ts';
import type { ProviderOptions } from './types.ts';

export type NodeProviderOptions = ProviderOptions & {
  transport?: Transport;
  hostHeader?: string;
  maxInFlightRequests?: number;
};

function createAuthInterceptor(token: string | undefined, requestHeaders: Record<string, string> = {}): Interceptor[] {
  if (!token && Object.keys(requestHeaders).length === 0) return [];
  return [
    (next) => async (req) => {
      for (const [key, value] of Object.entries(requestHeaders)) {
        req.header.set(key, value);
      }
      if (token) req.header.set('authorization', `Bearer ${token}`);
      return next(req);
    },
  ];
}

export function createRequestConcurrencyInterceptor(limit: number): Interceptor {
  const boundedLimit = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = async () => {
    if (active < boundedLimit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };

  const release = () => {
    const next = waiters.shift();
    // Transfer the occupied slot directly to the oldest waiter. Decrementing
    // first lets a new arrival claim it before that waiter resumes.
    if (next) next();
    else active -= 1;
  };

  return (next) => async (req) => {
    await acquire();
    try {
      if (req.signal.aborted) throw req.signal.reason;
      return await next(req);
    } finally {
      release();
    }
  };
}

type ConnectTransportOptions = Parameters<typeof createConnectTransport>[0];

function nodeRequestHeaders(options: NodeProviderOptions): Record<string, string> {
  const headers = { ...(options.requestHeaders ?? {}) };
  const hostHeader = options.hostHeader ?? process.env.RIADCHAIN_NODE_HOST_HEADER;
  if (hostHeader) headers.host = hostHeader;
  return headers;
}

function defaultNodeTimeoutMs(): number {
  const raw = process.env.RIADCHAIN_NODE_TIMEOUT_MS;
  if (!raw) return 30_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

function defaultMaxInFlightRequests(): number {
  const raw = process.env.RIADCHAIN_NODE_MAX_IN_FLIGHT;
  if (!raw) return 8;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 8;
}

export function createNodeTransportOptions(
  baseUrl: string,
  nodeToken?: string,
  options: NodeProviderOptions = {},
): ConnectTransportOptions {
  const requestHeaders = nodeRequestHeaders(options);
  const maxInFlightRequests = options.maxInFlightRequests ?? defaultMaxInFlightRequests();
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    interceptors: [
      ...createAuthInterceptor(nodeToken, requestHeaders),
      createRequestConcurrencyInterceptor(maxInFlightRequests),
    ],
    defaultTimeoutMs: Math.max(1_000, options.nodeTimeoutMs ?? defaultNodeTimeoutMs()),
    httpVersion: '1.1',
    // The native daemon closes every HTTP/1 response. Avoid reusing a socket
    // while its close is still propagating through Node/Bun's HTTP client.
    nodeOptions: { agent: false },
    useBinaryFormat: true,
  };
}

export function createNodeTransport(baseUrl: string, nodeToken?: string, options: NodeProviderOptions = {}): Transport {
  const transportOptions = createNodeTransportOptions(baseUrl, nodeToken, options);
  // Use Bun's native Fetch for response bodies; its node:http path can stall.
  // Connect Fetch buffers unary requests and retains server-streaming support.
  if (process.versions.bun) {
    const fetchWithoutReuse = ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, { ...init, keepalive: false })) as typeof fetch;
    return createFetchConnectTransport({
      ...transportOptions,
      fetch: createFileUploadFetch(transportOptions.defaultTimeoutMs ?? defaultNodeTimeoutMs(), fetchWithoutReuse),
      useBinaryFormat: true,
    });
  }
  return createConnectTransport(transportOptions);
}

export function createNodeProvider(
  nodeUrl: string,
  nodeToken?: string,
  options: NodeProviderOptions = {},
): RiadchainProvider {
  return new RiadchainProvider(nodeUrl, nodeToken, {
    ...options,
    requestHeaders: nodeRequestHeaders(options),
    transport: options.transport ?? createNodeTransport(nodeUrl, nodeToken, options),
  });
}
