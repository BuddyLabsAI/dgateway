import type { DecisionRequest } from '../schemas/types';
import type { Provider } from '../../management/schemas/types';
import { upstreamBody } from '../functions/execution';
import { customAuthHeader, upstreamHeaders } from '../functions/wire';
import { redactText } from '../../management/functions/redact';
import { CallFailure, type CallResult } from '../schemas/execution';
import { callChat } from './chat';
import { mockUpstream } from './mock';
export { CallFailure } from '../schemas/execution';
export type { CallResult } from '../schemas/execution';

export async function callUpstream(
  p: Provider,
  model: string,
  request: DecisionRequest,
  key: string | null,
  timeout: number,
  http: typeof fetch = fetch,
  // The model's supported_parameters from the provider's cached catalog, or null when none is cached.
  supported: readonly string[] | null = null,
): Promise<CallResult> {
  const body = upstreamBody(p, model, request);
  if (p.kind === 'mock') return { body: mockUpstream(body, model), request: body };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const send = async (payload: unknown) => {
      const response = await http(`${p.base_url.replace(/\/$/, '')}/${p.path.replace(/^\//, '')}`, {
        method: 'POST',
        headers: upstreamHeaders(p, key),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text;
      }
      if (!response.ok)
        throw new CallFailure('http', `upstream HTTP ${response.status}`, response.status, raw);
      if (typeof raw === 'string') {
        const header = customAuthHeader(p);
        throw new CallFailure(
          'invalid',
          `invalid upstream JSON: ${redactText(text.slice(0, 200), header ? [header] : [])}`,
          undefined,
          raw,
        );
      }
      return raw;
    };

    if (p.wire === 'chat') return await callChat(p, model, request, send, supported);
    return { body: await send(body), request: body };
  } catch (e) {
    if (controller.signal.aborted) throw new CallFailure('timeout', 'timeout');
    if (e instanceof CallFailure) throw e;
    throw new CallFailure(
      'network',
      `network error: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
