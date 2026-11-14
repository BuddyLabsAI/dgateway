import { GatewayError } from '../../decisions/schemas/types';
import { list, object, validateRequest } from '../../decisions/functions/validation';
import {
  defaultOutputPrice,
  defaultPrice,
  defaultPriceInput,
} from '../../decisions/functions/pricing';
import { AUTHORIZATION, defaultSendModel, validAuthHeader } from '../../decisions/functions/wire';
import {
  KNOWN_ANSWER,
  knownAnswerRequest,
  knownAnswerVerdict,
} from '../../decisions/functions/known-answer';
import type { DecisionResult } from '../../decisions/schemas/execution';
import type {
  LastTest,
  ModelHint,
  ModelReason,
  Provider,
  ProviderKey,
  PublicKey,
  Settings,
  StoredLastTest,
  Log,
} from '../schemas/types';
import type { Route } from '../../routing/schemas/types';
// A model as the admin API reports it. Only id is always present. price_per_m_input and price_per_m_output are the
// catalog's (or hint's) prices; the default_ prices are what the gateway charges when a route target sets none.
export type ModelInfo = {
  id: string;
  description?: string;
  price_per_m_input?: number;
  price_per_m_output?: number;
  default_price_per_m_input?: number;
  default_price_per_m_output?: number;
  context?: number;
};
// A provider's cached model catalog. It is refreshed by the models endpoint, never by a decision. parameters holds
// each listed model's supported_parameters (OpenRouter's listing has them), kept apart from the models the endpoint
// returns.
export type CatalogEntry = {
  expires: number;
  models: ModelInfo[];
  parameters?: Record<string, string[]>;
};
// The fields this gateway reads from an upstream model listing. Any of them may be missing or malformed.
export type UpstreamModel = {
  id?: unknown;
  description?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  context_length?: unknown;
  supported_parameters?: unknown;
};
// The fields a log row written before them lacks: the cost fields (before cost tracking) and who served the answer
// (before served_by). They read as null, as on a failed request.
type AddedLogField =
  | 'cost_usd'
  | 'cost_basis'
  | 'tokens'
  | 'cost_includes_output'
  | 'served_by'
  | 'upstream_model_resolved';
// Legacy 'free' basis is accepted only on read, normalized to unpriced without rewriting stored costs.
export type LegacyLog = Omit<Log, AddedLogField> &
  Partial<Pick<Log, Exclude<AddedLogField, 'cost_basis'>>> & {
    cost_basis?: Log['cost_basis'] | 'free';
  };

function invalid(s: string): never {
  throw new GatewayError(400, 'invalid_request_error', s);
}

export function missing(): never {
  throw new GatewayError(404, 'not_found_error', 'Resource not found');
}

// The code of the refusal to store a provider key while GATEWAY_SECRET is unset. The console matches the code,
// not the message.
export const SECRET_MISSING_CODE = 'gateway_secret_missing';

export function secretMissingError(): GatewayError {
  return new GatewayError(
    400,
    'invalid_request_error',
    'GATEWAY_SECRET must be set to store provider keys',
    SECRET_MISSING_CODE,
  );
}

function checkFields(o: unknown, allowed: string[]): Record<string, unknown> {
  if (!object(o)) return invalid('Expected an object');
  for (const k of Object.keys(o)) if (!allowed.includes(k)) invalid(`Unknown field: ${k}`);
  return o;
}

const name = (s: unknown) => typeof s === 'string' && /^[a-z0-9-]+$/.test(s);

const pos = (x: unknown) => Number.isInteger(x) && Number(x) > 0;

const validText = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;

const oneOf = (values: string[], v: unknown) => typeof v === 'string' && values.includes(v);

// A price in USD per million input tokens: a finite number of at least 0.
const nonNegative = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

// A route target's price: a price, or null or absent for the default.
const validPrice = (x: unknown) => x === undefined || x === null || nonNegative(x);

const HINT_FIELDS = ['id', 'price_per_m_input', 'price_per_m_output', 'context', 'description'];

// One model hint: a non-empty id, and optionally input and output prices of at least 0, a positive whole context, and
// a description.
function validHint(h: unknown): boolean {
  if (!object(h) || Object.keys(h).some((k) => !HINT_FIELDS.includes(k))) return false;
  return (
    validText(h.id) &&
    (h.price_per_m_input === undefined || nonNegative(h.price_per_m_input)) &&
    (h.price_per_m_output === undefined || nonNegative(h.price_per_m_output)) &&
    (h.context === undefined || pos(h.context)) &&
    (h.description === undefined || typeof h.description === 'string')
  );
}

// A provider's model hints: absent, or a list of at most 200 valid hints whose ids are unique.
function validHints(v: unknown): boolean {
  if (v === undefined) return true;
  if (!list(v) || v.length > 200 || !v.every(validHint)) return false;
  const ids = v.map((h) => (h as ModelHint).id);
  return new Set(ids).size === ids.length;
}

// A provider's test model: absent or null for none, or a model id of at most 200 characters.
const validTestModel = (v: unknown) =>
  v === undefined || v === null || (validText(v) && v.length <= 200);

// The options a provider may leave out on create: send_model follows its kind and host (defaultSendModel), and the
// key goes in the authorization header. A header name is kept in lowercase, as HTTP compares it.
export function withProviderDefaults(p: Record<string, unknown>): Record<string, unknown> {
  return {
    ...p,
    send_model: p.send_model === undefined ? defaultSendModel(p.kind, p.base_url) : p.send_model,
    auth_header:
      p.auth_header === undefined
        ? AUTHORIZATION
        : typeof p.auth_header === 'string'
          ? p.auth_header.toLowerCase()
          : p.auth_header,
  };
}

function validateProviderOptions(p: Record<string, unknown>) {
  if (
    p.synthetic_methods !== undefined &&
    (!list(p.synthetic_methods) ||
      !p.synthetic_methods.length ||
      new Set(p.synthetic_methods).size !== p.synthetic_methods.length ||
      !p.synthetic_methods.every((m) => oneOf(['logprobs', 'sampling', 'json'], m)))
  )
    invalid('invalid synthetic_methods');
  if (
    p.sampling_n !== undefined &&
    (!pos(p.sampling_n) || Number(p.sampling_n) < 2 || Number(p.sampling_n) > 32)
  )
    invalid('sampling_n must be an integer from 2 to 32');
  if (p.json_transport !== undefined && !oneOf(['auto', 'json_schema', 'prompt'], p.json_transport))
    invalid('invalid json_transport');
  if (p.disable_reasoning !== undefined && typeof p.disable_reasoning !== 'boolean')
    invalid('disable_reasoning must be true or false');
  if (typeof p.send_model !== 'boolean') invalid('send_model must be true or false');
  if (!validAuthHeader(p.auth_header))
    invalid(
      'auth_header must be "authorization" or a header name of letters, digits and hyphens, other than content-type and host',
    );
  if (!validHints(p.model_hints))
    invalid(
      'model_hints must be a list of { id, price_per_m_input?, context?, description? } with unique ids',
    );
  if (!validTestModel(p.test_model))
    invalid('test_model must be a model id of at most 200 characters, or null for none');
}

function validateProvider(p: Record<string, unknown>) {
  if (!name(p.name))
    invalid('provider name must contain only lowercase letters, digits, and hyphens');
  if (!oneOf(['openai', 'openrouter', 'systemone', 'openai-compatible', 'mock'], p.kind))
    invalid('invalid provider kind');
  if (typeof p.base_url !== 'string' || (p.kind !== 'mock' && !/^https?:\/\//.test(p.base_url)))
    invalid('invalid base_url');
  if (typeof p.path !== 'string' || (p.kind !== 'mock' && !p.path.startsWith('/')))
    invalid('invalid path');
  if (
    !oneOf(['openai', 'map', 'chat'], p.wire) ||
    typeof p.enabled !== 'boolean' ||
    !pos(p.timeout_ms)
  )
    invalid('invalid wire, enabled, or timeout_ms');
  if (
    !object(p.limits) ||
    !pos(p.limits.max_questions) ||
    !pos(p.limits.max_choices) ||
    Object.keys(p.limits).some((k) => !['max_questions', 'max_choices'].includes(k))
  )
    invalid('invalid limits');
  if (
    p.wire === 'chat' &&
    list(p.synthetic_methods) &&
    p.synthetic_methods.length === 1 &&
    p.synthetic_methods[0] === 'logprobs' &&
    object(p.limits) &&
    Number(p.limits.max_choices) > 20
  )
    invalid('chat wire max_choices cannot exceed 20');
  if (!object(p.extra_body)) invalid('extra_body must be an object');
  validateProviderOptions(p);
}

export type KeyPlan =
  | { source: 'env'; env_var: string }
  | { source: 'stored'; value: string; last4: string | null }
  | { source: 'none' };

// The fewest characters a stored key has for its last four to be shown, so the four are at most a third of it.
export const KEY_TAIL_MIN_LENGTH = 12;

// What reads of a stored key show of it, its last4: the last four characters (code points) of a key of at least
// KEY_TAIL_MIN_LENGTH characters, and null for a shorter key, which shows none, since four would be most or all of it.
export function keyTail(value: string): string | null {
  const characters = [...value];
  return characters.length >= KEY_TAIL_MIN_LENGTH ? characters.slice(-4).join('') : null;
}

// A provider read from a row written before keyTail's rule, whose stored last4 may be all of a short key: its tail
// recomputed from plain, the decrypted key. When the key cannot be decrypted, bytes is its length in UTF-8 bytes (read
// from the ciphertext's length), or null when unknown: a key of at least four bytes per character of
// KEY_TAIL_MIN_LENGTH has at least that many characters, so it keeps its tail; any other loses it, since its length
// in characters is then unknown. A provider without a stored key, or whose tail already follows the rule, is returned
// as it is.
export function withRuledKeyTail(
  p: Provider,
  plain: string | null,
  bytes: number | null = null,
): Provider {
  if (p.key.source !== 'stored') return p;
  const long = bytes !== null && bytes >= 4 * KEY_TAIL_MIN_LENGTH;
  const last4 = plain !== null ? keyTail(plain) : long ? p.key.last4 : null;
  return last4 === p.key.last4 ? p : { ...p, key: { ...p.key, last4 } };
}

export function prepareProviderKey(input: unknown): KeyPlan {
  const k = checkFields(input, ['source', 'env_var', 'value']);
  if (k.source === 'env') {
    if (!validText(k.env_var) || !/^\w+$/.test(k.env_var) || 'value' in k)
      return invalid('invalid env key');
    return { source: 'env', env_var: k.env_var };
  }
  if (k.source === 'stored') {
    if (!validText(k.value) || 'env_var' in k) return invalid('invalid stored key');
    return { source: 'stored', value: k.value, last4: keyTail(k.value) };
  }
  if (k.source === 'none') {
    if (Object.keys(k).length !== 1) return invalid('invalid none key');
    return { source: 'none' };
  }
  return invalid('invalid key source');
}

export function storedKey(plan: KeyPlan, ciphertext?: string): ProviderKey {
  return plan.source === 'stored'
    ? { source: 'stored', ciphertext: ciphertext!, last4: plan.last4 }
    : plan;
}

export function providerDraft(input: unknown, old: Provider | undefined) {
  const x = checkFields(input, [
    'name',
    'kind',
    'base_url',
    'path',
    'wire',
    'synthetic_methods',
    'sampling_n',
    'json_transport',
    'disable_reasoning',
    'enabled',
    'timeout_ms',
    'limits',
    'extra_body',
    'key',
    'send_model',
    'auth_header',
    'model_hints',
    'test_model',
  ]);
  const chatPath =
    x.kind === 'openrouter' || (!x.kind && old?.kind === 'openrouter')
      ? '/api/v1/chat/completions'
      : (typeof x.base_url === 'string' ? x.base_url : (old?.base_url ?? ''))
            .replace(/\/$/, '')
            .endsWith('/v1')
        ? '/chat/completions'
        : '/v1/chat/completions';
  const chatDefaults =
    !old && x.wire === 'chat'
      ? {
          path: chatPath,
          limits: {
            max_questions: 16,
            max_choices:
              list(x.synthetic_methods) &&
              x.synthetic_methods.length === 1 &&
              x.synthetic_methods[0] === 'logprobs'
                ? 20
                : 64,
          },
        }
      : {};
  const switched =
    old && old.wire !== 'chat' && x.wire === 'chat' && x.path === undefined
      ? { path: chatPath }
      : {};
  const value = withProviderDefaults({ ...chatDefaults, ...old, ...x, ...switched });
  validateProvider(value);
  if (x.key === undefined && !old) invalid('key is required');
  return { value, plan: x.key === undefined ? undefined : prepareProviderKey(x.key) };
}

export function applyProviderKey(value: Record<string, unknown>, key: ProviderKey | undefined) {
  return key ? { ...value, key } : value;
}

export function uniqueProvider(
  p: Record<string, unknown>,
  old: Provider | undefined,
  providers: Provider[],
) {
  if (providers.some((q) => q.name === p.name && q.id !== old?.id))
    invalid('provider name already exists');
}

export function completeProvider(
  p: Record<string, unknown>,
  old: Provider | undefined,
  newId: string,
  created: string,
  updated: string,
): Provider {
  return {
    ...p,
    id: old?.id ?? newId,
    created_at: old?.created_at ?? created,
    updated_at: updated,
  } as Provider;
}

export function routeDraft(
  input: unknown,
  old: Route | undefined,
  providers: Provider[],
  routes: Route[],
): Record<string, unknown> {
  const x = checkFields(input, ['alias', 'description', 'enabled', 'targets']);
  const r: Record<string, unknown> = { ...old, ...x };
  if (
    !name(r.alias) ||
    typeof r.description !== 'string' ||
    typeof r.enabled !== 'boolean' ||
    !list(r.targets) ||
    !r.targets.length
  )
    invalid('invalid route');
  for (const target of r.targets) {
    const t = checkFields(target, [
      'provider_id',
      'model',
      'timeout_ms',
      'price_per_m_input',
      'price_per_m_output',
    ]);
    if (
      typeof t.provider_id !== 'string' ||
      !providers.some((p) => p.id === t.provider_id) ||
      !validText(t.model) ||
      (t.timeout_ms !== undefined && !pos(t.timeout_ms))
    )
      invalid('invalid route target');
    if (!validPrice(t.price_per_m_output))
      invalid('price_per_m_output must be a number of at least 0, or null');
    if (!validPrice(t.price_per_m_input))
      invalid('price_per_m_input must be a number of at least 0, or null');
  }
  if (routes.some((q) => q.alias === r.alias && q.id !== old?.id))
    invalid('route alias already exists');
  return r;
}

export function completeRoute(
  r: Record<string, unknown>,
  old: Route | undefined,
  newId: string,
  created: string,
  updated: string,
): Route {
  return {
    ...r,
    id: old?.id ?? newId,
    created_at: old?.created_at ?? created,
    updated_at: updated,
  } as Route;
}

// Deleting a provider is refused while a route still targets it. The conflict names those routes.
export function requireUnreferenced(providerId: string, routes: Route[]) {
  const blocking = routes.filter((r) => r.targets.some((t) => t.provider_id === providerId));
  if (blocking.length > 0)
    throw new GatewayError(
      409,
      'invalid_request_error',
      `Provider is still a target of route ${blocking.map((r) => `"${r.alias}"`).join(', ')}. Remove it from those routes first.`,
      'provider_in_use',
      blocking.map((r) => ({ id: r.id, alias: r.alias })),
    );
}

export function mergeSettings(input: unknown, old: Settings): Settings {
  const x = checkFields(input, ['require_client_keys', 'capture_payloads', 'default_route']);
  if (
    (x.require_client_keys !== undefined && typeof x.require_client_keys !== 'boolean') ||
    (x.capture_payloads !== undefined && typeof x.capture_payloads !== 'boolean') ||
    (x.default_route !== undefined && x.default_route !== null && !name(x.default_route))
  )
    invalid('invalid settings');
  return { ...old, ...x };
}

export function playgroundRequest(input: unknown) {
  return validateRequest(checkFields(input, ['request']).request);
}

export function clientName(input: unknown): string {
  const x = checkFields(input, ['name']);
  if (!validText(x.name)) return invalid('name is required');
  return x.name;
}

export function logPage(all: Log[], params: URLSearchParams) {
  let entries = all;
  const route = params.get('route'),
    provider = params.get('provider'),
    status = params.get('status'),
    fallback = params.get('fallback'),
    before = params.get('before');
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) invalid('invalid limit');
  if (status && !['ok', 'error'].includes(status)) invalid('invalid status');
  if (fallback && !['used', 'none'].includes(fallback)) invalid('invalid fallback');
  if (before) {
    const index = entries.findIndex((l) => l.id === before);
    entries = index < 0 ? [] : entries.slice(index + 1);
  }
  if (route) entries = entries.filter((l) => l.route === route);
  if (provider) entries = entries.filter((l) => l.provider === provider);
  if (status) entries = entries.filter((l) => l.status === status);
  if (fallback) entries = entries.filter((l) => l.fallback_used === (fallback === 'used'));
  const items = entries.slice(0, limit);
  return { items, next_before: entries.length > limit ? items[items.length - 1].id : null };
}

export function statsWindow(window: string | null): '1h' | '24h' | '7d' {
  const w = window ?? '24h';
  if (!['1h', '24h', '7d'].includes(w)) return invalid('invalid stats window');
  return w as '1h' | '24h' | '7d';
}

// The catalog's prompt and completion prices are USD per token; this gives USD per million tokens. Missing, blank,
// negative and non-numeric prices give no price: OpenRouter reports -1 for a price that varies, and Number(null) is 0,
// which would read as zero cost.
const perMillion = (raw: unknown): number | undefined => {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return undefined;
  const perToken = Number(raw);
  // 12 significant digits drop the noise of the conversion: 0.0000001 per token is 0.1, not 0.09999999999999999.
  return Number.isFinite(perToken) && perToken >= 0
    ? Number((perToken * 1e6).toPrecision(12))
    : undefined;
};

export function mapModels(body: { data?: unknown }): ModelInfo[] {
  const data = list(body.data) ? (body.data as UpstreamModel[]) : [];
  return data
    .filter((x): x is UpstreamModel & { id: string } => typeof x.id === 'string')
    .map((x) => {
      const price = perMillion(x.pricing?.prompt);
      const output = perMillion(x.pricing?.completion);
      return {
        id: x.id,
        ...(typeof x.description === 'string' ? { description: x.description } : {}),
        ...(price === undefined ? {} : { price_per_m_input: price }),
        ...(output === undefined ? {} : { price_per_m_output: output }),
        ...(typeof x.context_length === 'number' && Number.isFinite(x.context_length)
          ? { context: x.context_length }
          : {}),
      };
    });
}

// Each listed model's supported_parameters, as OpenRouter's listing gives them: a list of parameter names such as
// "reasoning" and "logprobs". A model whose list is missing or not a list of strings is left out.
export function catalogParameters(body: { data?: unknown }): Record<string, string[]> {
  const data = list(body.data) ? (body.data as UpstreamModel[]) : [];
  return Object.fromEntries(
    data.flatMap((x) =>
      typeof x.id === 'string' &&
      list(x.supported_parameters) &&
      x.supported_parameters.every((name) => typeof name === 'string')
        ? [[x.id, x.supported_parameters]]
        : [],
    ),
  );
}

// The cached supported_parameters of a model, or null when the catalog or the model's list is not cached.
export function supportedParameters(
  entry: CatalogEntry | undefined,
  model: string,
): string[] | null {
  return entry?.parameters?.[model] ?? null;
}

// The cached input and output prices of a model in a provider's catalog; each is null when the catalog, the model or
// that price is not cached.
export function catalogPrice(
  entry: CatalogEntry | undefined,
  model: string,
): { input: number | null; output: number | null } {
  const m = entry?.models.find((m) => m.id === model);
  return { input: m?.price_per_m_input ?? null, output: m?.price_per_m_output ?? null };
}

// Each listed model with its default_price_per_m_input and default_price_per_m_output, where the gateway has them:
// the prices a decision is charged when its route target sets none. They are resolved as a decision resolves them
// (defaultPriceInput, then defaultPrice and defaultOutputPrice), from the provider and its cached catalog, never from
// the listed prices, where a hint's price wins over the catalog's. A model without a default carries no such field.
export function withDefaultPrices(
  p: Pick<Provider, 'kind' | 'base_url' | 'model_hints' | 'wire'>,
  models: ModelInfo[],
  catalog?: CatalogEntry,
): ModelInfo[] {
  return models.map((model) => {
    const input = defaultPriceInput(p, model.id, catalogPrice(catalog, model.id));
    const price = defaultPrice(input);
    const output = defaultOutputPrice(input);
    return {
      ...model,
      ...(price === null ? {} : { default_price_per_m_input: price.perMillion }),
      ...(output === null ? {} : { default_price_per_m_output: output }),
    };
  });
}

// The provider's hints and its upstream listing as one list: the hints first, in their order, then the listed models
// they do not name. Where both name a model, each field the hint sets wins (hints win on price), and the listing
// fills in the rest.
export function mergeHints(hints: readonly ModelHint[], listed: readonly ModelInfo[]): ModelInfo[] {
  const named = new Set(hints.map((hint) => hint.id));
  const merged = hints.map((hint): ModelInfo => ({
    ...listed.find((model) => model.id === hint.id),
    ...hint,
  }));
  return [...merged, ...listed.filter((model) => !named.has(model.id))];
}

// Where a provider's upstream lists its models: GET {base}/models, or, when the decision path has a /v1 segment
// (as in /v1/decisions or /decisions/v1/systemone), /models beside that segment, so a base URL without /v1 still
// reaches {base}/v1/models.
export function modelsUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  const v1 = /^(.*?\/v1)(?:\/|$)/.exec(path);
  return `${base}${v1 ? v1[1] : ''}/models`;
}

// How long the models endpoint waits for an upstream listing when the provider has hints to answer with anyway.
export const HINTED_LISTING_TIMEOUT_MS = 2000;

// How the models endpoint answers for a provider: with a fixed list, or by fetching a listing (url, waiting at most
// timeout ms) and merging it with the provider's hints, which are also the answer when the listing fails. Only
// systemone and openai-compatible use hints; a systemone provider without any keeps its fixed placeholder.
export type ModelPlan =
  { models: ModelInfo[] } | { url: string; timeout: number; hints: ModelInfo[] };

// The model id a test or a listing uses for a server that names no models: the server answers with the one it serves.
export const SERVER_CONFIGURED = 'server-configured';

export function modelPlan(
  p: Provider,
  cache: { expires: number; models: ModelInfo[] } | undefined,
  now: number,
): ModelPlan {
  if (p.wire === 'chat' && p.kind !== 'mock') {
    if (p.kind === 'openrouter' && cache && cache.expires > now) return { models: cache.models };
    const hints = p.model_hints ?? [];
    return {
      url: modelsUrl(p.base_url, p.path),
      timeout: hints.length ? Math.min(p.timeout_ms, HINTED_LISTING_TIMEOUT_MS) : p.timeout_ms,
      hints,
    };
  }
  if (p.kind === 'openai') return { models: [{ id: 'gpt-6-luna' }] };
  if (p.kind === 'mock') return { models: [{ id: 'mock-1' }] };
  if (p.kind === 'openrouter') {
    if (cache && cache.expires > now) return { models: cache.models };
    const url = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';
    return { url, timeout: p.timeout_ms, hints: [] };
  }
  const hints = p.model_hints ?? [];
  if (p.kind === 'systemone' && hints.length === 0) return { models: [{ id: SERVER_CONFIGURED }] };
  const timeout = hints.length ? Math.min(p.timeout_ms, HINTED_LISTING_TIMEOUT_MS) : p.timeout_ms;
  return { url: modelsUrl(p.base_url, p.path), timeout, hints };
}

// How long a decision waits before it fetches a provider's catalog again after a fetch failed.
export const CATALOG_RETRY_MS = 5 * 60 * 1000;

// Whether a decision should fetch the provider's catalog before it runs: only a chat-wire OpenRouter provider needs
// it (reasoning gating and catalog prices), only when none is cached (an expired entry is still read), and not within
// CATALOG_RETRY_MS of a failed fetch.
export function catalogFetchDue(
  p: Pick<Provider, 'kind' | 'wire'>,
  cached: boolean,
  failedAt: number | undefined,
  now: number,
): boolean {
  return (
    p.kind === 'openrouter' &&
    p.wire === 'chat' &&
    !cached &&
    (failedAt === undefined || now - failedAt >= CATALOG_RETRY_MS)
  );
}

// The listing a decision fetches: the models endpoint's request, waited for at most 2 seconds (or timeout_ms).
export function catalogFetchPlan(p: Pick<Provider, 'base_url' | 'path' | 'timeout_ms'>): {
  url: string;
  timeout: number;
} {
  return {
    url: modelsUrl(p.base_url, p.path),
    timeout: Math.min(p.timeout_ms, HINTED_LISTING_TIMEOUT_MS),
  };
}

// The model a provider test asked for, if any. Anything but a non-empty model id is refused before the test runs.
export function modelTestInput(input: unknown): string | undefined {
  const x = checkFields(input, ['model']);
  if (x.model !== undefined && !validText(x.model)) invalid('invalid model');
  return x.model;
}

// The model a provider test uses, why, and the route that uses it when that is the reason.
export type TestModelChoice = { model: string; reason: ModelReason; route: string | null };

const choose = (model: string, reason: ModelReason, route: string | null = null) => ({
  model,
  reason,
  route,
});

// The route a test borrows its model from: the first enabled route with a step on the provider, else the first such
// route; and the model of its first step on the provider.
function routeUsing(providerId: string, routes: readonly Route[]) {
  const using = routes.filter((r) => r.targets.some((t) => t.provider_id === providerId));
  const route = using.find((r) => r.enabled) ?? using[0];
  const target = route?.targets.find((t) => t.provider_id === providerId);
  return route && target ? { alias: route.alias, model: target.model } : null;
}

// The test model that needs no model listing: the one asked for, else the one a route sends this provider, else the
// provider's own test model, else its first model hint. Null when none of them applies.
export function preferredTestModel(
  requested: string | undefined,
  p: Pick<Provider, 'id' | 'test_model' | 'model_hints'>,
  routes: readonly Route[],
): TestModelChoice | null {
  if (requested !== undefined) return choose(requested, 'requested');
  const routed = routeUsing(p.id, routes);
  if (routed) return choose(routed.model, 'used_by_route', routed.alias);
  if (p.test_model) return choose(p.test_model, 'provider_default');
  const hint = p.model_hints?.[0];
  return hint ? choose(hint.id, 'hint') : null;
}

const byPriceThenId = (a: ModelInfo, b: ModelInfo) =>
  a.price_per_m_input! - b.price_per_m_input! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The test model from what the provider lists: the cheapest priced model (ties broken by id), else the first listed,
// else the server-configured placeholder, which is never a listed model of its own.
export function listedTestModel(models: readonly ModelInfo[]): TestModelChoice {
  const listed = models.filter((m) => m.id !== SERVER_CONFIGURED);
  const [cheapest] = listed.filter((m) => m.price_per_m_input !== undefined).sort(byPriceThenId);
  if (cheapest) return choose(cheapest.id, 'cheapest');
  return listed[0]
    ? choose(listed[0].id, 'first_listed')
    : choose(SERVER_CONFIGURED, 'server_configured');
}

// The model a provider test uses, in the order of ModelReason.
export function chooseTestModel(
  requested: string | undefined,
  p: Pick<Provider, 'id' | 'test_model' | 'model_hints'>,
  routes: readonly Route[],
  models: readonly ModelInfo[],
): TestModelChoice {
  return preferredTestModel(requested, p, routes) ?? listedTestModel(models);
}

// A provider test's decision: the known-answer check, sent to the model on this provider directly.
export function testRequest(p: Pick<Provider, 'name'>, model: string) {
  return knownAnswerRequest(`${p.name}::${model}`);
}

export function resource<T extends { id: string }>(items: T[], id: string): T {
  return items.find((x) => x.id === id) ?? missing();
}

// secretConfigured says whether GATEWAY_SECRET is set. Only that fact is reported, never the value.
export function health(
  providers: {
    name: string;
    enabled: boolean;
    key: { source: 'none' } | { source: 'env'; present: boolean } | { source: 'stored' };
  }[],
  started: number,
  now: number,
  secretConfigured: boolean,
) {
  return {
    ok: true,
    version: '0.1.0',
    uptime_s: Math.floor((now - started) / 1000),
    secret_configured: secretConfigured,
    providers: providers.map((p) => ({
      name: p.name,
      enabled: p.enabled,
      // A provider that needs no key (source none) is ready; an env key is present when the variable is set.
      key_present: p.key.source === 'env' ? p.key.present : true,
    })),
  };
}

export function playgroundResult(result: DecisionResult) {
  return {
    response: result.response,
    ...(result.error ? { error: result.error } : {}),
    trace: result.trace,
  };
}

// What a provider test answers: whether the model answered, the model and why it was chosen, the expected answer
// beside the one given (with its probability) and whether they match, the decision itself, and its trace.
export function providerTestResult(
  choice: TestModelChoice,
  start: number,
  end: number,
  result: DecisionResult,
) {
  const verdict = knownAnswerVerdict(result.response);
  return {
    ok: !!result.response,
    latency_ms: end - start,
    model: choice.model,
    model_reason: choice.reason,
    model_route: choice.route,
    expected: KNOWN_ANSWER.expected,
    answer: verdict.answer,
    probability: verdict.probability,
    matched: verdict.matched,
    ...(result.error ? { error: result.error.message } : {}),
    ...(result.response ? { response: result.response } : {}),
    trace: result.trace,
  };
}

// The last_test record a provider test leaves on its provider. It is kept on failure as well as success.
export function lastTestRecord(
  result: DecisionResult,
  choice: TestModelChoice,
  start: number,
  end: number,
): LastTest {
  const ok = result.response !== null;
  return {
    ok,
    at: new Date(start).toISOString(),
    latency_ms: Math.max(0, end - start),
    model: choice.model,
    model_reason: choice.reason,
    matched: knownAnswerVerdict(result.response).matched,
    error: ok ? null : (result.error?.message ?? null),
  };
}

// A stored last test as the admin API reads it: one recorded before model_reason and matched existed reads them as
// null.
export function readLastTest(stored: StoredLastTest): LastTest {
  return { ...stored, model_reason: stored.model_reason ?? null, matched: stored.matched ?? null };
}

export type ProviderView = Omit<Provider, 'key'> & {
  key: PublicKey;
  send_model: boolean;
  auth_header: string;
  model_hints: ModelHint[];
  test_model: string | null;
  last_test: LastTest | null;
};

// A provider as the admin API reads it: the key without its secret, every option set (a row written before
// migration 3 reads with its defaults, and one without a test model reads null), and last_test null until the first
// test.
export function providerView(p: Provider, present: boolean): ProviderView {
  const key =
    p.key.source === 'stored'
      ? { source: 'stored' as const, last4: p.key.last4 }
      : p.key.source === 'env'
        ? { source: 'env' as const, env_var: p.key.env_var, present }
        : { source: 'none' as const };
  return {
    ...p,
    key,
    send_model: p.send_model ?? defaultSendModel(p.kind, p.base_url),
    auth_header: p.auth_header ?? AUTHORIZATION,
    model_hints: p.model_hints ?? [],
    test_model: p.test_model ?? null,
    last_test: p.last_test ? readLastTest(p.last_test) : null,
  };
}

export function readLog(raw: LegacyLog): Log {
  return {
    ...raw,
    served_by: raw.served_by ?? null,
    upstream_model_resolved: raw.upstream_model_resolved ?? null,
    cost_usd: raw.cost_usd ?? null,
    cost_basis: raw.cost_basis === 'free' ? 'unpriced' : (raw.cost_basis ?? null),
    cost_includes_output: raw.cost_includes_output ?? null,
    tokens: raw.tokens ?? null,
  };
}
