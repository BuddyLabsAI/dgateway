import { describe, expect, test } from 'bun:test';
import { CallFailure } from '../../src/modules/gateway/libs/decisions/schemas/execution';
import {
  GatewayError,
  type DecisionRequest,
} from '../../src/modules/gateway/libs/decisions/schemas/types';
import {
  eligibility,
  upstreamBody,
  classifyFailure,
  parseResult,
  initialState,
  reduceAttempt,
  finalize,
  failedOutcome,
  succeededOutcome,
} from '../../src/modules/gateway/libs/decisions/functions/execution';
import {
  clientAuth,
  publicModels,
  rejectionLog,
} from '../../src/modules/gateway/libs/decisions/functions/public';
import {
  seedProviders,
  seedRoutes,
  migrateOpenRouterPath,
} from '../../src/modules/gateway/libs/management/functions/seed';
import {
  prepareProviderKey,
  storedKey,
  providerDraft,
  applyProviderKey,
  uniqueProvider,
  completeProvider,
  routeDraft,
  completeRoute,
  requireUnreferenced,
  mergeSettings,
  playgroundRequest,
  clientName,
  logPage,
  statsWindow,
  mapModels,
  modelPlan,
  testRequest,
  modelTestInput,
  resource,
  health,
  playgroundResult,
  providerTestResult,
  providerView,
} from '../../src/modules/gateway/libs/management/functions/admin';
const providers = seedProviders('2026-01-01T00:00:00.000Z', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
const ids = Object.fromEntries(providers.map((p) => [p.name, p.id]));
const routes = seedRoutes('2026-01-01T00:00:00.000Z', ids, ['r1', 'r2', 'r3']);
const settings = { require_client_keys: false, capture_payloads: false, default_route: 'default' };
const request: DecisionRequest = {
  model: 'default',
  input: 'hi',
  questions: [{ name: 'q', type: 'predicate', instructions: 'test' }],
};

const start = () => initialState('default', settings, routes, providers).state;

const parsed = {
  answers: [{ type: 'predicate' as const, name: 'q', probability: 0.9 }],
  usage: null,
  confidenceMethod: 'normalized-entropy' as const,
  billed: null,
  servedBy: null,
  resolvedModel: null,
};
const charge = {
  tokens: 1,
  cost_usd: 0,
  cost_basis: 'upstream_cost' as const,
  cost_includes_output: true,
};

describe('pure routing and decision construction', () => {
  test('seed construction links routes and providers', () => {
    expect(providers.map((p) => p.name)).toEqual([
      'mock',
      'openai',
      'openrouter',
      'llamacpp',
      'typesafe',
      'openai-chat',
      'openrouter-chat',
    ]);
    expect(routes[1].targets.map((t) => t.provider_id)).toEqual(['b', 'c']);
    expect(providers[2].path).toBe('/api/alpha/decisions');
  });
  test('eligibility checks existence, enabled status, and both limits', () => {
    expect(eligibility(undefined, request)).toEqual({ ok: false, message: 'provider not found' });
    expect(eligibility(providers[3], request)).toEqual({ ok: false, message: 'provider disabled' });
    expect(
      eligibility({ ...providers[0], limits: { max_questions: 0, max_choices: 1 } }, request).ok,
    ).toBe(false);
    const choice: DecisionRequest = {
      ...request,
      questions: [
        {
          name: 'c',
          type: 'choice',
          instructions: 'x',
          choices: [
            { value: 'a', description: 'a' },
            { value: 'b', description: 'b' },
          ],
        },
      ],
    };
    expect(
      eligibility({ ...providers[0], limits: { max_questions: 2, max_choices: 1 } }, choice).ok,
    ).toBe(false);
    expect(eligibility(providers[0], request).ok).toBe(true);
  });
  test('key eligibility distinguishes absent env and undecryptable stored keys', () => {
    const envProvider = providers[1];
    expect(eligibility(envProvider, request, { ok: true, key: null })).toEqual({
      ok: false,
      message: 'OPENAI_API_KEY is not set on the gateway host',
    });
    expect(eligibility(envProvider, request, { ok: true, key: 'present' }).ok).toBe(true);
    const stored = {
      ...envProvider,
      key: { source: 'stored' as const, ciphertext: 'x', last4: 'tail' },
    };
    expect(eligibility(stored, request, { ok: false })).toEqual({
      ok: false,
      message: 'stored key cannot be decrypted (check GATEWAY_SECRET)',
    });
    expect(eligibility(providers[0], request, { ok: true, key: null }).ok).toBe(true);
  });
  test('migration changes only matching OpenRouter defaults', () => {
    const old = { ...providers[2], path: '/api/v1/alpha/decisions' };
    expect(migrateOpenRouterPath(old).path).toBe('/api/alpha/decisions');
    expect(old.path).toBe('/api/v1/alpha/decisions');
    const custom = { ...old, path: '/custom' };
    const alternate = { ...old, base_url: 'https://other.example' };
    const otherKind = { ...old, kind: 'systemone' as const };
    expect(migrateOpenRouterPath(custom)).toBe(custom);
    expect(migrateOpenRouterPath(alternate)).toBe(alternate);
    expect(migrateOpenRouterPath(otherKind)).toBe(otherKind);
  });
  test('wire builder handles mock, openai, map, and openrouter', () => {
    const mock = providers[0],
      openai = providers[1],
      router = providers[2],
      map = { ...providers[3], enabled: true };
    expect(upstreamBody(mock, 'x', request)).toEqual({
      state: 'hi',
      questions: { q0: { type: 'noul', instructions: 'test' } },
    });
    expect(upstreamBody(openai, 'upstream', request)).toEqual({ ...request, model: 'upstream' });
    expect(upstreamBody(map, 'x', request)).toEqual(upstreamBody(mock, 'x', request));
    expect(
      upstreamBody({ ...router, extra_body: { provider: { order: ['x'] } } }, 'x', request),
    ).toEqual({
      state: 'hi',
      questions: { q0: { type: 'noul', instructions: 'test' } },
      model: 'x',
      provider: { order: ['x'] },
    });
  });
  test('failure classification and parsing distinguish invalid and network', () => {
    expect(classifyFailure(new CallFailure('http', 'bad', 400)).kind).toBe('http');
    expect(classifyFailure(new Error('offline')).kind).toBe('network');
    expect(() => parseResult({ bad: true }, request, 'map', [])).toThrow(
      'invalid upstream response',
    );
    expect(
      parseResult({ answers: { q0: { probability: 0.9 } } }, request, 'map', []).answers[0],
    ).toEqual({ type: 'predicate', name: 'q', probability: 0.9 });
  });
  test('initial routing handles absent and empty routes', () => {
    expect(initialState('missing', settings, routes, providers).state.status).toBe(404);
    expect(
      initialState('empty', settings, [{ ...routes[0], alias: 'empty', targets: [] }], providers)
        .state.status,
    ).toBe(502);
    expect(start().route).toBe('default');
  });
  test('reducer continues for 500, 429, timeout and limit, stops for 400 or success', () => {
    for (const failure of [
      new CallFailure('http', 'bad', 500),
      new CallFailure('http', 'busy', 429),
      new CallFailure('http', 'auth', 401),
      new CallFailure('http', 'forbidden', 403),
      new CallFailure('http', 'not found', 404),
      new CallFailure('timeout', 'timeout'),
      new CallFailure('limit', 'limited'),
    ])
      expect(reduceAttempt(start(), failedOutcome('p', 'm', 0, 1, failure)).stop).toBe(false);
    expect(
      reduceAttempt(start(), failedOutcome('p', 'm', 0, 1, new CallFailure('http', 'bad', 400)))
        .stop,
    ).toBe(true);
    expect(
      reduceAttempt(start(), failedOutcome('p', 'm', 0, 1, new CallFailure('http', 'invalid', 422)))
        .stop,
    ).toBe(true);
    const next = reduceAttempt(
      start(),
      succeededOutcome('p', 'm', 0, 1, {}, {}, null, parsed, charge),
    );
    expect(next.stop).toBe(true);
    expect(next.attempts).toHaveLength(1);
  });
  test('finalization emits response, trace and captured log only when enabled', () => {
    const state = reduceAttempt(
      start(),
      succeededOutcome('p', 'm', 0, 20, { api_key: 'key' }, { ok: true }, 'key', parsed, charge),
    );
    const values = {
      start: 0,
      end: 20,
      created: 1000,
      timestamp: 1000,
      responseId: 'dec_x',
      logId: 'log_x',
    };
    const a = finalize(state, request, settings, values);
    expect(a.result.response?.id).toBe('dec_x');
    expect(a.log).not.toHaveProperty('request');
    expect(a.result.trace.upstream_request).toEqual({ api_key: '[REDACTED]' });
    const b = finalize(state, request, { ...settings, capture_payloads: true }, values);
    expect(b.log.request).toEqual(request);
    expect(b.log.response).toEqual(b.result.response);
    const failed = finalize(
      reduceAttempt(start(), failedOutcome('p', 'm', 0, 1, new CallFailure('timeout', 'timeout'))),
      request,
      settings,
      values,
    );
    expect(failed.result.status).toBe(504);
    expect(failed.result.error?.type).toBe('timeout_error');
  });
});
describe('pure public and management rules', () => {
  test('client authentication and public models', () => {
    expect(clientAuth(settings, undefined, undefined)).toBe('allow');
    const auth = { ...settings, require_client_keys: true };
    expect(clientAuth(auth, undefined, undefined)).toBe('deny');
    expect(clientAuth(auth, 'key', undefined)).toBe('check');
    expect(clientAuth(auth, 'key', false)).toBe('deny');
    expect(clientAuth(auth, 'key', true)).toBe('allow');
    expect(publicModels(routes).data.map((x) => x.id)).toEqual(['default', 'luna', 'elephant']);
    expect(publicModels(routes).data.map((x) => x.owned_by)).toEqual([
      'dgateway',
      'dgateway',
      'dgateway',
    ]);
  });
  test('rejection logs honor payload capture', () => {
    const e = new GatewayError(401, 'authentication_error', 'denied');
    expect(rejectionLog(0, e, request, settings, 'x', 1000, 10)).not.toHaveProperty('request');
    expect(
      rejectionLog(0, e, request, { ...settings, capture_payloads: true }, 'x', 1000, 10).request,
    ).toEqual(request);
  });
  test('provider key plans encrypt only stored values and preserve omitted PATCH key', () => {
    const old = providers[1];
    expect(providerDraft({ enabled: false }, old).value.key).toEqual(old.key);
    expect(providerDraft({ enabled: false }, old).plan).toBeUndefined();
    expect(applyProviderKey({ key: old.key }, undefined).key).toEqual(old.key);
    // A key under 12 characters keeps none of its characters beside the ciphertext.
    const plan = prepareProviderKey({ source: 'stored', value: 'secret' });
    expect(storedKey(plan, 'cipher')).toEqual({
      source: 'stored',
      ciphertext: 'cipher',
      last4: null,
    });
    const long = prepareProviderKey({ source: 'stored', value: 'sk-long-secret' });
    expect(storedKey(long, 'cipher')).toEqual({
      source: 'stored',
      ciphertext: 'cipher',
      last4: 'cret',
    });
    expect(prepareProviderKey({ source: 'env', env_var: 'KEY' })).toEqual({
      source: 'env',
      env_var: 'KEY',
    });
    expect(prepareProviderKey({ source: 'none' })).toEqual({ source: 'none' });
    expect(providerView(old, true).key).toEqual({
      source: 'env',
      env_var: 'OPENAI_API_KEY',
      present: true,
    });
    expect(() => prepareProviderKey({ source: 'stored' })).toThrow();
    expect(() => uniqueProvider({ name: 'mock' }, undefined, providers)).toThrow();
    expect(
      completeProvider({ ...old, enabled: false }, old, 'unused', 'unused', 'later').created_at,
    ).toBe(old.created_at);
  });
  test('route patch validation, completion and conflict', () => {
    const draft = routeDraft({ description: 'new' }, routes[0], providers, routes);
    expect(completeRoute(draft, routes[0], 'x', 'x', 'later').description).toBe('new');
    expect(() =>
      routeDraft(
        { targets: [{ provider_id: 'missing', model: 'x' }] },
        routes[0],
        providers,
        routes,
      ),
    ).toThrow();
    expect(() => requireUnreferenced('a', routes)).toThrow();
    expect(() => requireUnreferenced('unused', routes)).not.toThrow();
  });
  test('settings, playground and client input validation', () => {
    expect(mergeSettings({ capture_payloads: true }, settings)).toEqual({
      ...settings,
      capture_payloads: true,
    });
    expect(() => mergeSettings({ capture_payloads: 'yes' }, settings)).toThrow();
    expect(playgroundRequest({ request })).toEqual(request);
    expect(clientName({ name: 'client' })).toBe('client');
    expect(() => clientName({ name: '' })).toThrow();
  });
  test('logs pagination and stats window validation', () => {
    const log = rejectionLog(
      0,
      new GatewayError(400, 'invalid_request_error', 'x'),
      request,
      settings,
      'x',
      1000,
      10,
    );
    expect(logPage([log], new URLSearchParams()).items).toEqual([log]);
    expect(logPage([log], new URLSearchParams('before=x')).items).toEqual([]);
    expect(statsWindow(null)).toBe('24h');
    expect(() => statsWindow('bad')).toThrow();
  });
  test('model catalog mapping and model plans', () => {
    expect(
      mapModels({
        data: [
          { id: 'x', description: 'desc', pricing: { prompt: '0.000002' }, context_length: 42 },
        ],
      }),
    ).toEqual([{ id: 'x', description: 'desc', price_per_m_input: 2, context: 42 }]);
    expect(modelPlan(providers[0], undefined, 0)).toEqual({ models: [{ id: 'mock-1' }] });
    expect(modelPlan(providers[2], undefined, 0)).toEqual({
      url: 'https://openrouter.ai/api/v1/models?output_modalities=decisions',
      timeout: 20000,
      hints: [],
    });
    expect(modelPlan(providers[2], { expires: 10, models: [{ id: 'cached' }] }, 0)).toEqual({
      models: [{ id: 'cached' }],
    });
  });
  test('test request and resource selection', () => {
    expect(modelTestInput({ model: 'foo' })).toBe('foo');
    expect(modelTestInput({})).toBeUndefined();
    expect(testRequest(providers[0], 'foo').model).toBe('mock::foo');
    expect(() => modelTestInput({ model: '' })).toThrow();
    expect(resource(providers, 'a').name).toBe('mock');
    expect(() => resource(providers, 'absent')).toThrow();
  });
  test('health and playground output shaping', () => {
    expect(
      health([{ name: 'a', enabled: true, key: { source: 'env', present: false } }], 0, 1000, true)
        .providers[0].key_present,
    ).toBe(false);
    const result = finalize(start(), request, settings, {
      start: 0,
      end: 1,
      created: 1,
      timestamp: 1,
      responseId: 'd',
      logId: 'l',
    }).result;
    expect(playgroundResult(result).trace).toEqual(result.trace);
    const choice = { model: 'x', reason: 'requested' as const, route: null };
    expect(providerTestResult(choice, 0, 10, result)).toMatchObject({
      latency_ms: 10,
      model: 'x',
      model_reason: 'requested',
      model_route: null,
      matched: false,
      trace: result.trace,
    });
  });
});
