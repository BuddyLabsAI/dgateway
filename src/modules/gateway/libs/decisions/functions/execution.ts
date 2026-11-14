import { GatewayError, type DecisionRequest, type DecisionResponse } from '../schemas/types';
import {
  CallFailure,
  type Charge,
  type Outcome,
  type Parsed,
  type State,
  type FailureKind,
  type Finalized,
  type KeyLookup,
} from '../schemas/execution';
import type { Provider, Settings } from '../../management/schemas/types';
import type { Target } from '../../routing/schemas/types';
import { resolveRoute, shouldFallback } from '../../routing/functions/routing';
import { redact, redactText } from '../../management/functions/redact';
import { maxOptions } from './validation';
import { fromUpstream, toMapWire } from './translation';
import { fromChat } from './chat';
import { sendsModel } from './wire';
import { upstreamErrorMessage, type Hidden } from './upstream-error';

export function eligibility(
  p: Provider | undefined,
  request: DecisionRequest,
  keyLookup?: KeyLookup,
): { ok: true; provider: Provider } | { ok: false; message: string } {
  if (!p || !p.enabled)
    return { ok: false, message: !p ? 'provider not found' : 'provider disabled' };
  if (
    request.questions.length > p.limits.max_questions ||
    (p.wire === 'chat' &&
      p.synthetic_methods?.length === 1 &&
      p.synthetic_methods[0] === 'logprobs' &&
      request.questions.some((q) => maxOptions(q) > 20)) ||
    request.questions.some((q) => maxOptions(q) > p.limits.max_choices)
  )
    return { ok: false, message: 'provider limits exceeded' };
  if (keyLookup && (!keyLookup.ok || !keyLookup.key)) {
    if (p.key.source === 'env')
      return { ok: false, message: `${p.key.env_var} is not set on the gateway host` };
    if (p.key.source === 'stored')
      return { ok: false, message: 'stored key cannot be decrypted (check GATEWAY_SECRET)' };
  }
  return { ok: true, provider: p };
}

// The body sent upstream. The openai wire sends the request with the upstream model; the map wire rewrites it as
// state and questions, and names the model only when the provider's send_model says so (see sendsModel).
export function upstreamBody(p: Provider, model: string, request: DecisionRequest): unknown {
  if (p.kind === 'mock') return toMapWire(request);
  if (p.wire === 'chat') return { model, input: request.input, questions: request.questions };
  if (p.wire === 'openai') return { ...p.extra_body, ...request, model };
  return { ...p.extra_body, ...toMapWire(request), ...(sendsModel(p) ? { model } : {}) };
}

// The wire an upstream answer is read in. The mock answers on the map wire whatever its setting.
export function responseWire(p: Pick<Provider, 'kind' | 'wire'>): Provider['wire'] {
  return p.kind === 'mock' ? 'map' : p.wire;
}

// What must not show in an attempt's error excerpt: the secrets so far plus this attempt's key, and the redacted
// field names so far plus this provider's custom auth header.
export function hiddenValues(
  state: Pick<State, 'secrets' | 'fields'>,
  key: string | null,
  header: string | null,
): { secrets: string[]; fields: string[] } {
  return {
    secrets: key ? [...state.secrets, key] : state.secrets,
    fields: header && !state.fields.includes(header) ? [...state.fields, header] : state.fields,
  };
}

export function classifyFailure(error: unknown): {
  kind: FailureKind;
  message: string;
  status?: number;
  raw?: unknown;
} {
  if (error instanceof CallFailure)
    return { kind: error.kind, message: error.message, status: error.status, raw: error.raw };
  return { kind: 'network', message: error instanceof Error ? error.message : 'upstream failure' };
}

export function parseResult(
  body: unknown,
  request: DecisionRequest,
  wire: Provider['wire'],
  secrets: string[],
  fields: readonly string[] = [],
) {
  try {
    return wire === 'chat' ? fromChat(body, request) : fromUpstream(body, request, wire);
  } catch (e) {
    let excerpt = '';
    try {
      excerpt = JSON.stringify(redact(body, secrets, true, fields)).slice(0, 200);
    } catch {
      /* An unserializable body leaves the excerpt empty. */
    }
    throw new CallFailure(
      'invalid',
      `invalid upstream response: ${e instanceof Error ? e.message : 'invalid shape'}; ${excerpt}`,
      undefined,
      body,
    );
  }
}

export function initialState(
  model: string | undefined,
  settings: Settings,
  routes: Parameters<typeof resolveRoute>[2],
  providers: Provider[],
): { state: State; targets: Target[] } {
  const resolved = resolveRoute(model, settings.default_route, routes, providers);
  const error: GatewayError | null = !resolved
    ? new GatewayError(404, 'not_found_error', 'Route or provider not found')
    : !resolved.targets.length
      ? new GatewayError(502, 'upstream_error', 'Route has no targets')
      : null;
  return {
    targets: resolved?.targets ?? [],
    state: {
      route: resolved?.route ?? null,
      attempts: [],
      secrets: [],
      fields: [],
      provider: null,
      model: null,
      upstreamRequest: null,
      upstreamResponse: null,
      answered: null,
      error: error?.body() ?? null,
      status: error?.status ?? 200,
      stop: !!error,
    },
  };
}

// An upstream body that was not JSON is kept as text; credential pairs in it (including a custom auth header's) are
// hidden as in an error excerpt.
const rawText = (response: unknown, fields: readonly string[]) =>
  typeof response === 'string' ? redactText(response, fields) : response;

// A failed attempt's error text: the failure's own message, cut to 300 characters as it always was, and for an HTTP
// error the upstream's readable message after it, as "upstream HTTP 404: <message>". The message is redacted with the
// secrets and field names so far. The 300-character cut applies to the failure's own message only, so the upstream's
// message, which upstreamErrorMessage has already kept to about 300 characters, is never cut again.
function failureText(outcome: Extract<Outcome, { ok: false }>, hidden: Hidden): string {
  const head = String(redact(outcome.message, hidden.secrets)).slice(0, 300);
  const detail = outcome.kind === 'http' ? upstreamErrorMessage(outcome.response, hidden) : null;
  return detail ? `${head}: ${detail}` : head;
}

export function reduceAttempt(state: State, outcome: Outcome): State {
  const secrets = outcome.secret ? [...state.secrets, outcome.secret] : state.secrets;
  const fields =
    outcome.header && !state.fields.includes(outcome.header)
      ? [...state.fields, outcome.header]
      : state.fields;
  const message = outcome.ok ? undefined : failureText(outcome, { secrets, fields });
  const attempt = {
    provider: outcome.provider,
    model: outcome.model,
    ok: outcome.ok,
    latency_ms: outcome.latency,
    ...(message !== undefined ? { error: message } : {}),
  };
  return {
    ...state,
    attempts: [...state.attempts, attempt],
    secrets,
    fields,
    provider: outcome.provider,
    model: outcome.model,
    upstreamRequest: redact(outcome.request, secrets, true, fields),
    upstreamResponse: redact(rawText(outcome.response, fields), secrets, true, fields),
    answered: outcome.ok ? { parsed: outcome.parsed, charge: outcome.charge } : null,
    error: outcome.ok
      ? null
      : {
          message: message!,
          type: outcome.kind === 'timeout' ? 'timeout_error' : 'upstream_error',
        },
    status: outcome.ok ? 200 : outcome.kind === 'timeout' ? 504 : 502,
    stop: outcome.ok || !shouldFallback(outcome.kind, outcome.status),
  };
}

export function finalize(
  state: State,
  request: DecisionRequest,
  settings: Settings,
  values: {
    start: number;
    end: number;
    created: number;
    timestamp: number;
    responseId: string;
    logId: string;
  },
): Finalized {
  const answered = state.answered;
  const response: DecisionResponse | null = answered
    ? {
        id: values.responseId,
        object: 'decision',
        created: Math.floor(values.created / 1000),
        model: request.model ?? settings.default_route!,
        answers: answered.parsed.answers,
        usage: answered.parsed.usage,
        gateway: {
          route: state.route,
          provider: state.provider!,
          upstream_model: state.model!,
          served_by: answered.parsed.servedBy,
          upstream_model_resolved: answered.parsed.resolvedModel,
          synthetic: answered.parsed.synthetic ?? false,
          latency_ms: Math.max(0, values.end - values.start),
          attempts: state.attempts,
          confidence_method: answered.parsed.confidenceMethod,
          cost_usd: answered.charge.cost_usd,
          cost_basis: answered.charge.cost_basis,
          cost_includes_output: answered.charge.cost_includes_output,
          tokens: answered.charge.tokens,
        },
      }
    : null;
  const safeResponse = response
    ? (redact(response, state.secrets, false) as DecisionResponse)
    : null;
  const error = state.error
    ? (redact(state.error, state.secrets, true, state.fields) as typeof state.error)
    : undefined;
  const trace = redact(
    {
      attempts: state.attempts,
      upstream_request: state.upstreamRequest,
      upstream_response: state.upstreamResponse,
    },
    state.secrets,
    true,
    state.fields,
  ) as Finalized['result']['trace'];
  const log = {
    id: values.logId,
    ts: new Date(values.timestamp).toISOString(),
    route: state.route,
    provider: state.provider,
    upstream_model: state.model,
    served_by: safeResponse?.gateway.served_by ?? null,
    upstream_model_resolved: safeResponse?.gateway.upstream_model_resolved ?? null,
    status: safeResponse ? ('ok' as const) : ('error' as const),
    fallback_used: state.attempts.length > 1,
    http_status: state.status,
    latency_ms: Math.max(0, values.end - values.start),
    questions: request.questions.length,
    prompt_tokens: response?.usage?.input_tokens ?? null,
    cost_usd: answered?.charge.cost_usd ?? null,
    cost_basis: answered?.charge.cost_basis ?? null,
    cost_includes_output: answered?.charge.cost_includes_output ?? null,
    tokens: answered?.charge.tokens ?? null,
    error: error?.message ?? null,
    attempts: trace.attempts,
    ...(settings.capture_payloads
      ? {
          request: redact(request, state.secrets, true, state.fields),
          response: safeResponse ?? { error },
        }
      : {}),
  };
  return {
    result: {
      response: safeResponse,
      ...(!safeResponse && error ? { error } : {}),
      status: state.status,
      trace,
    },
    log,
  };
}

export function failedOutcome(
  provider: string,
  model: string,
  start: number,
  end: number,
  error: unknown,
  request: unknown = null,
  secret: string | null = null,
  header: string | null = null,
): Outcome {
  const failure = classifyFailure(error);
  return {
    ok: false,
    provider,
    model,
    latency: Math.max(0, end - start),
    request,
    response: failure.raw ?? null,
    secret,
    header,
    ...failure,
  };
}

export function succeededOutcome(
  provider: string,
  model: string,
  start: number,
  end: number,
  request: unknown,
  response: unknown,
  secret: string | null,
  parsed: Parsed,
  charge: Charge,
  header: string | null = null,
): Outcome {
  return {
    ok: true,
    provider,
    model,
    latency: Math.max(0, end - start),
    request,
    response,
    secret,
    header,
    parsed,
    charge,
  };
}
