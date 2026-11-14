import { GatewayError } from '../schemas/types';
import type { Route } from '../../routing/schemas/types';
import type { Settings, Log } from '../../management/schemas/types';
import { redact } from '../../management/functions/redact';
import { list, object } from './validation';

export function clientAuth(
  settings: Settings,
  token: string | undefined,
  valid: boolean | undefined,
): 'allow' | 'check' | 'deny' {
  if (!settings.require_client_keys) return 'allow';
  if (!token) return 'deny';
  if (valid === undefined) return 'check';
  return valid ? 'allow' : 'deny';
}

export function publicModels(routes: Route[]) {
  return {
    object: 'list',
    data: routes
      .filter((r) => r.enabled)
      .map((r) => ({
        id: r.alias,
        object: 'model',
        owned_by: 'dgateway',
        description: r.description,
      })),
  };
}

export function rejectionLog(
  start: number,
  error: GatewayError,
  body: unknown,
  settings: Settings,
  logId: string,
  timestamp: number,
  end: number,
): Log {
  return {
    id: logId,
    ts: new Date(timestamp).toISOString(),
    route: null,
    provider: null,
    upstream_model: null,
    served_by: null,
    upstream_model_resolved: null,
    status: 'error',
    fallback_used: false,
    http_status: error.status,
    latency_ms: Math.max(0, end - start),
    questions: object(body) && list(body.questions) ? body.questions.length : 0,
    prompt_tokens: null,
    cost_usd: null,
    cost_basis: null,
    tokens: null,
    error: error.message,
    attempts: [],
    ...(settings.capture_payloads
      ? { request: redact(body), response: { error: error.body() } }
      : {}),
  };
}
