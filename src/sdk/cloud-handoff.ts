import { MAX_SETUP_BYTES, parseSetupFile } from './appliance-setup.ts';
export interface CloudHandoff { endpoint: string; token: string }
/** The fragment never becomes an HTTP URL, referrer or server access-log field. */
export function parseCloudHandoffLink(value: string): CloudHandoff {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid cloud setup link.');
  try {
    const url = new URL(value), fragment = new URLSearchParams(url.hash.slice(1)), token = fragment.get('token');
    if (url.protocol !== 'https:' || url.hostname !== 'cloud.riadchain.com' || url.port || url.username || url.password || url.search
      || !/^\/api\/handoff\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(url.pathname)
      || !token || !/^[A-Za-z0-9_-]{32,128}$/.test(token) || fragment.getAll('token').length !== 1 || [...fragment.keys()].some(key => key !== 'token')) throw new Error();
    url.hash = ''; return { endpoint: url.toString(), token };
  } catch { throw new Error('Use an HTTPS setup link from cloud.riadchain.com.'); }
}
export class CloudSetupPendingError extends Error {
  constructor(readonly requestId: string | null) { super('Cloud is still processing the saved original setup. Keep it and check this same step again.'); this.name = 'CloudSetupPendingError'; }
}
export class CloudSetupRetryRequiredError extends Error {
  constructor(readonly failedRequestId: string) { super('Cloud could not submit this setup. Your saved keys and signed setup are kept. Choose Retry setup.'); this.name = 'CloudSetupRetryRequiredError'; }
}
async function resultBody(response: Response, assertCurrent: () => void): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > MAX_SETUP_BYTES)) throw new Error('Cloud setup response exceeds its limit.');
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); assertCurrent(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_SETUP_BYTES) throw new Error('Cloud setup response exceeds its limit.');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseSetupFile(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  }
  if (!length) throw new Error('This device needs a bounded cloud setup response. Use the setup file instead.');
  return parseSetupFile(await response.text());
}
/** Polls only the same original body/endpoint. Foreground cancellation or timeout
 * never creates another setup, changes keys or loses the caller's saved original. */
export async function exchangeCloudSetup(handoff: CloudHandoff, action: 'request' | 'prepare' | 'sealed' | 'connections', body: unknown, assertCurrent: () => void, recovery?: { retryFailedRequestId: string }): Promise<unknown> {
  assertCurrent();
  const scoped = parseCloudHandoffLink(`${handoff.endpoint}#token=${handoff.token}`);
  if (scoped.endpoint !== handoff.endpoint || !['request','prepare','sealed','connections'].includes(action)
    || (action === 'request' || action === 'connections') !== (body === undefined)) throw new Error('Use the original scoped Cloud setup action.');
  if (recovery && (!['prepare','sealed'].includes(action) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(recovery.retryFailedRequestId))) throw new Error('Use the retained failed setup publication.');
  const retryFailedRequestId = recovery?.retryFailedRequestId;
  const url = handoff.endpoint + (action === 'request' ? '' : `/${action}`), text = body === undefined ? undefined : JSON.stringify(body);
  if (text && new TextEncoder().encode(text).length > MAX_SETUP_BYTES) throw new Error('Cloud setup is too large.');
  const deadline = Date.now() + 120000; let pendingId: string | null = null;
  for (;;) {
    assertCurrent(); const remaining = deadline - Date.now(); if (remaining <= 0) throw new CloudSetupPendingError(pendingId);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(20000, remaining));
    try {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', method: text === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${handoff.token}`, ...(text === undefined ? {} : { 'content-type': 'application/json' }), ...(retryFailedRequestId ? { 'x-riadchain-cloud-retry': retryFailedRequestId } : {}) }, body: text, redirect: 'error', signal: controller.signal });
      assertCurrent();
      if (response.url && response.url !== url) throw new Error('The cloud setup endpoint redirected.');
      if (!response.ok) {
        if (response.status === 409) {
          const failure = await resultBody(response, assertCurrent) as { error?: { code?: unknown; failedRequestId?: unknown } };
          if (failure?.error?.code === 'SETUP_BATCH_FAILED' && typeof failure.error.failedRequestId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(failure.error.failedRequestId)) throw new CloudSetupRetryRequiredError(failure.error.failedRequestId);
        } else await response.body?.cancel();
        throw new Error(response.status === 401 || response.status === 403 ? 'The scoped setup link expired. Reopen the original network setup from the cloud console.' : 'The cloud could not complete this setup step. Keep the original saved setup and try checking it again.');
      }
      const result = await resultBody(response, assertCurrent); assertCurrent();
      if (response.status !== 202) return result;
      const pending = result as { status?: unknown; requestId?: unknown };
      if (!pending || pending.status !== 'pending' || typeof pending.requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(pending.requestId)
        || Object.keys(pending).sort().join(',') !== 'requestId,status' || pendingId !== null && pendingId !== pending.requestId) throw new Error('Cloud returned a different original setup request. Keep the saved setup.');
      pendingId = pending.requestId;
    } catch (error) {
      assertCurrent();
      if (controller.signal.aborted) throw new CloudSetupPendingError(pendingId);
      throw error;
    } finally { clearTimeout(timer); controller.abort(); }
    if (Date.now() >= deadline) throw new CloudSetupPendingError(pendingId);
    await new Promise(resolve => setTimeout(resolve, Math.min(2000, deadline - Date.now()))); assertCurrent();
  }
}
