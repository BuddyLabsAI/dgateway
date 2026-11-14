import { describe, expect, test } from 'bun:test';
import { isLocalHost } from '../../src/modules/gateway/libs/decisions/functions/hosts';
import {
  authHeaders,
  customAuthHeader,
  defaultSendModel,
  sendsModel,
  upstreamHeaders,
  validAuthHeader,
} from '../../src/modules/gateway/libs/decisions/functions/wire';
import {
  failedOutcome,
  finalize,
  hiddenValues,
  initialState,
  reduceAttempt,
  succeededOutcome,
  upstreamBody,
} from '../../src/modules/gateway/libs/decisions/functions/execution';
import { CallFailure } from '../../src/modules/gateway/libs/decisions/schemas/execution';
import {
  chargeFor,
  defaultPrice,
  hintPrice,
  providerPricing,
  resolvePrice,
} from '../../src/modules/gateway/libs/decisions/functions/pricing';
import type { DecisionRequest } from '../../src/modules/gateway/libs/decisions/schemas/types';
import {
  mergeHints,
  modelPlan,
  modelsUrl,
  providerDraft,
  providerView,
  withDefaultPrices,
} from '../../src/modules/gateway/libs/management/functions/admin';
import {
  migrateProviderOptions,
  seedProviders,
  seedRoutes,
} from '../../src/modules/gateway/libs/management/functions/seed';
import { redact, redactText } from '../../src/modules/gateway/libs/management/functions/redact';
import type { Provider } from '../../src/modules/gateway/libs/management/schemas/types';

const seeded = seedProviders('2026-11-08T00:00:00.000Z', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);

const byName = (name: string) => seeded.find((p) => p.name === name)!;

// An OpenAI-compatible server on the Docker host, such as one run with vLLM.
const compatible: Provider = {
  ...byName('openai'),
  id: 'compat',
  name: 'compat',
  kind: 'openai-compatible',
  base_url: 'http://host.docker.internal:8000/v1',
  path: '/decisions',
  enabled: false,
  key: { source: 'none' },
  limits: { max_questions: 16, max_choices: 16 },
};

const request: DecisionRequest = {
  model: 'x',
  input: 'hi',
  questions: [{ name: 'q', type: 'predicate', instructions: 'test' }],
};

// A hosted SystemOne vendor, as a direct preset creates it.
const vendor: Provider = {
  ...byName('llamacpp'),
  id: 'vendor',
  name: 'vendor',
  base_url: 'https://api.vendor.example',
  enabled: true,
  send_model: true,
  auth_header: 'x-api-key',
  key: { source: 'none' },
  model_hints: [
    { id: 'vendor-big', price_per_m_input: 0.042, context: 262144, description: 'Big' },
    { id: 'vendor-free-listing' },
  ],
};

describe('local host detection', () => {
  test('localhost, loopback, ::1, the Docker host, *.local and the private ranges are local', () => {
    for (const url of [
      'http://localhost:8080',
      'http://LOCALHOST',
      'http://127.0.0.1:8080/v1',
      'http://127.255.255.254',
      'http://[::1]:11434',
      'http://host.docker.internal:11434',
      'http://gpu-box.local:8000',
      'http://gpu-box.local.:8000',
      'http://10.0.0.5',
      'http://10.255.255.255',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://192.168.1.20:8000',
      // The URL parser writes other IPv4 spellings in dotted form.
      'http://0x7f.0.0.1',
      'http://2130706433',
    ])
      expect(isLocalHost(url), url).toBe(true);
  });

  test('public hosts, the edges of the private ranges, and unparseable URLs are hosted', () => {
    for (const url of [
      'https://api.typesafe.ai',
      'https://inference.baseten.co',
      'http://172.15.255.255',
      'http://172.32.0.1',
      'http://192.169.0.1',
      'http://11.0.0.1',
      'http://8.8.8.8',
      'http://local',
      'http://notlocal',
      'http://localhost.example.com',
      'http://10.0.0.1.example.com',
      'http://[::2]',
      'not a url',
      '',
    ])
      expect(isLocalHost(url), url).toBe(false);
  });
});

describe('send_model', () => {
  test('defaults: hosted systemone and every other kind true, local systemone false', () => {
    expect(defaultSendModel('systemone', 'https://api.typesafe.ai')).toBe(true);
    expect(defaultSendModel('systemone', 'http://host.docker.internal:8080')).toBe(false);
    expect(defaultSendModel('systemone', 'http://127.0.0.1:8080')).toBe(false);
    expect(defaultSendModel('openrouter', 'https://openrouter.ai')).toBe(true);
    expect(defaultSendModel('openai', 'https://api.openai.com/v1')).toBe(true);
    expect(defaultSendModel('openai-compatible', 'http://localhost:8000')).toBe(true);
    expect(defaultSendModel('systemone', undefined)).toBe(true);
  });

  test('the seeds: OpenRouter is sent the model, the local llama.cpp server is not', () => {
    expect(byName('openrouter').send_model).toBe(true);
    expect(byName('llamacpp').send_model).toBe(false);
    expect(seeded.every((p) => p.auth_header === 'authorization')).toBe(true);
  });

  test('the openai wire always names the model; the map wire follows the setting', () => {
    const openai = byName('openai');
    expect(sendsModel({ ...openai, send_model: false })).toBe(true);
    expect(sendsModel(vendor)).toBe(true);
    expect(sendsModel({ ...vendor, send_model: false })).toBe(false);
    // A row from before migration 3 reads with the default for its kind and host.
    expect(sendsModel({ ...vendor, send_model: undefined })).toBe(true);
    expect(sendsModel({ ...byName('llamacpp'), send_model: undefined })).toBe(false);
  });
});

describe('the upstream body', () => {
  const map = { state: 'hi', questions: { q0: { type: 'noul', instructions: 'test' } } };

  test('a hosted systemone vendor is sent the model; with send_model off it is not', () => {
    expect(upstreamBody(vendor, 'vendor-big', request)).toEqual({ ...map, model: 'vendor-big' });
    expect(upstreamBody({ ...vendor, send_model: false }, 'vendor-big', request)).toEqual(map);
  });

  test('a local systemone server is sent no model by default, and one when it asks', () => {
    const llama = { ...byName('llamacpp'), enabled: true };
    expect(upstreamBody(llama, 'server-configured', request)).toEqual(map);
    expect(upstreamBody({ ...llama, send_model: true }, 'd1', request)).toEqual({
      ...map,
      model: 'd1',
    });
  });

  test('openrouter keeps sending the model, and the openai wire ignores the setting', () => {
    expect(upstreamBody(byName('openrouter'), 'baseten/elephant-1', request)).toEqual({
      ...map,
      model: 'baseten/elephant-1',
    });
    const compat = { ...compatible, send_model: false };
    expect(upstreamBody(compat, 'local-7b', request)).toEqual({ ...request, model: 'local-7b' });
    expect(upstreamBody({ ...byName('openai'), send_model: false }, 'gpt-6-luna', request)).toEqual(
      {
        ...request,
        model: 'gpt-6-luna',
      },
    );
  });

  test('the mock is sent the map wire without a model, whatever its setting', () => {
    expect(upstreamBody({ ...byName('mock'), send_model: true }, 'mock-1', request)).toEqual(map);
  });
});

describe('the auth header', () => {
  test('authorization carries "Bearer <key>"; a custom header carries the raw key', () => {
    expect(authHeaders('authorization', 'sk-1')).toEqual({ authorization: 'Bearer sk-1' });
    expect(authHeaders(undefined, 'sk-1')).toEqual({ authorization: 'Bearer sk-1' });
    expect(authHeaders('Authorization', 'sk-1')).toEqual({ authorization: 'Bearer sk-1' });
    expect(authHeaders('x-api-key', 'sk-1')).toEqual({ 'x-api-key': 'sk-1' });
    expect(authHeaders('X-Api-Key', 'sk-1')).toEqual({ 'x-api-key': 'sk-1' });
    expect(authHeaders('x-api-key', null)).toEqual({});
  });

  test('a decision call adds the JSON content type', () => {
    expect(upstreamHeaders({ auth_header: 'x-api-key' }, 'sk-1')).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-1',
    });
    expect(upstreamHeaders({ auth_header: 'authorization' }, null)).toEqual({
      'content-type': 'application/json',
    });
  });

  test('only a custom header is reported for redaction', () => {
    expect(customAuthHeader({ auth_header: 'x-api-key' })).toBe('x-api-key');
    expect(customAuthHeader({ auth_header: 'authorization' })).toBeNull();
    expect(customAuthHeader({})).toBeNull();
  });

  test('header names: letters, digits and hyphens, not content-type or host', () => {
    for (const good of ['authorization', 'x-api-key', 'X-API-Key', 'apikey2'])
      expect(validAuthHeader(good), good).toBe(true);
    for (const bad of [
      'content-type',
      'Content-Type',
      'host',
      'HOST',
      'x api key',
      'x_api_key',
      '',
      'x:y',
      7,
    ])
      expect(validAuthHeader(bad), String(bad)).toBe(false);
  });
});

describe('prices: local and hosted systemone use hints or stay unpriced', () => {
  test('local and hosted systemone servers are unpriced without a hint', () => {
    const base = { model: 'm', target: undefined, catalog: null };
    expect(resolvePrice({ ...base, kind: 'systemone', local: true })).toBeNull();
    expect(resolvePrice({ ...base, kind: 'systemone', local: false })).toBeNull();
    expect(resolvePrice({ ...base, kind: 'systemone' })).toBeNull();
  });

  test("a hint's price is the default for a hosted systemone or openai-compatible model", () => {
    const base = { model: 'm', target: undefined, catalog: null, hint: 0.042 };
    expect(resolvePrice({ ...base, kind: 'systemone', local: false })).toEqual({
      perMillion: 0.042,
    });
    expect(resolvePrice({ ...base, kind: 'openai-compatible', local: true })).toEqual({
      perMillion: 0.042,
    });
    // Local servers use the same hint prices as hosted ones.
    expect(resolvePrice({ ...base, kind: 'systemone', local: true })).toEqual({
      perMillion: 0.042,
    });
  });

  test("the step's own price comes first, and openrouter's catalog and openai's table keep their place", () => {
    expect(
      resolvePrice({ kind: 'systemone', model: 'm', target: 1, catalog: null, hint: 0.042 }),
    ).toEqual({ perMillion: 1 });
    expect(
      resolvePrice({ kind: 'openrouter', model: 'm', target: null, catalog: 2, hint: 9 }),
    ).toEqual({ perMillion: 2 });
    expect(defaultPrice({ kind: 'openai', model: 'gpt-6-luna', catalog: null, hint: 9 })).toEqual({
      perMillion: 0.1,
      cached: 0.01,
      write: 0.125,
    });
    // OpenAI models outside the built-in table may use a hint; OpenRouter keeps catalog pricing.
    expect(defaultPrice({ kind: 'openai', model: 'gpt-7', catalog: null, hint: 9 })).toEqual({
      perMillion: 9,
    });
    expect(defaultPrice({ kind: 'openai', model: 'gpt-7', catalog: null })).toBeNull();
    expect(defaultPrice({ kind: 'openrouter', model: 'm', catalog: null, hint: 9 })).toBeNull();
  });

  test('a hint without a price, or an unusable one, prices nothing', () => {
    expect(hintPrice(vendor.model_hints, 'vendor-big')).toBe(0.042);
    expect(hintPrice(vendor.model_hints, 'vendor-free-listing')).toBeNull();
    expect(hintPrice(vendor.model_hints, 'other')).toBeNull();
    expect(hintPrice(undefined, 'vendor-big')).toBeNull();
    expect(hintPrice([{ id: 'x', price_per_m_input: -1 }], 'x')).toBeNull();
  });

  test('a provider contributes its kind, its locality and the hint price', () => {
    expect(providerPricing(vendor, 'vendor-big')).toMatchObject({
      kind: 'systemone',
      local: false,
      hint: 0.042,
    });
    expect(providerPricing(byName('llamacpp'), 'server-configured')).toMatchObject({
      kind: 'systemone',
      local: true,
      hint: null,
    });
  });

  test('the charge: a hint-priced decision is priced, a hosted one without a hint is unpriced', () => {
    const usage = { input_tokens: 1000, output_tokens: 1, total_tokens: 1001 };
    expect(
      chargeFor({
        ...providerPricing(vendor, 'vendor-big'),
        model: 'vendor-big',
        target: undefined,
        catalog: null,
        usage,
        request,
      }),
    ).toMatchObject({ tokens: 1000, cost_usd: 0.000042, cost_basis: 'upstream_tokens' });
    expect(
      chargeFor({
        ...providerPricing(vendor, 'unlisted'),
        model: 'unlisted',
        target: undefined,
        catalog: null,
        usage,
        request,
      }),
    ).toMatchObject({ tokens: 1000, cost_usd: null, cost_basis: 'unpriced' });
  });
});

describe('the models endpoint with hints', () => {
  test('hints come first, the listing adds what they do not name, and hints win on price', () => {
    const merged = mergeHints(vendor.model_hints!, [
      { id: 'vendor-big', price_per_m_input: 9, description: 'listed', context: 1000 },
      { id: 'vendor-new', price_per_m_input: 0.5 },
    ]);
    expect(merged).toEqual([
      { id: 'vendor-big', price_per_m_input: 0.042, context: 262144, description: 'Big' },
      { id: 'vendor-free-listing' },
      { id: 'vendor-new', price_per_m_input: 0.5 },
    ]);
    expect(mergeHints([{ id: 'a' }], [{ id: 'a', description: 'live', context: 8 }])).toEqual([
      { id: 'a', description: 'live', context: 8 },
    ]);
    expect(mergeHints([], [{ id: 'only' }])).toEqual([{ id: 'only' }]);
  });

  test('default prices follow hints for both hosted and local servers', () => {
    const merged = mergeHints(vendor.model_hints!, [{ id: 'vendor-new', price_per_m_input: 0.5 }]);
    expect(withDefaultPrices(vendor, merged)).toEqual([
      {
        id: 'vendor-big',
        price_per_m_input: 0.042,
        context: 262144,
        description: 'Big',
        default_price_per_m_input: 0.042,
      },
      { id: 'vendor-free-listing' },
      { id: 'vendor-new', price_per_m_input: 0.5 },
    ]);
    const local = { ...vendor, base_url: 'http://host.docker.internal:11434' };
    expect(withDefaultPrices(local, [{ id: 'd1' }])[0]?.default_price_per_m_input).toBeUndefined();
    expect(withDefaultPrices(local, [{ id: 'vendor-big' }])[0]?.default_price_per_m_input).toBe(
      0.042,
    );
  });

  test('the listing URL: {base}/models, or /models beside a /v1 segment of the path', () => {
    expect(modelsUrl('http://host.docker.internal:8000/v1', '/decisions')).toBe(
      'http://host.docker.internal:8000/v1/models',
    );
    expect(modelsUrl('http://compat.test/', '/decide')).toBe('http://compat.test/models');
    expect(modelsUrl('http://host.docker.internal:8000', '/v1/decisions')).toBe(
      'http://host.docker.internal:8000/v1/models',
    );
    expect(modelsUrl('https://api.typesafe.ai', '/v1/systemone')).toBe(
      'https://api.typesafe.ai/v1/models',
    );
    expect(modelsUrl('https://api.liquid.ai', '/decisions/v1/systemone')).toBe(
      'https://api.liquid.ai/decisions/v1/models',
    );
    expect(modelsUrl('https://x.test', '/v10/decide')).toBe('https://x.test/models');
  });

  test('plans: hints are fetched with a short wait, and a systemone server without hints keeps its placeholder', () => {
    expect(modelPlan(vendor, undefined, 0)).toEqual({
      url: 'https://api.vendor.example/v1/models',
      timeout: 2000,
      hints: vendor.model_hints!,
    });
    expect(modelPlan({ ...vendor, model_hints: [] }, undefined, 0)).toEqual({
      models: [{ id: 'server-configured' }],
    });
    const compat = compatible;
    expect(modelPlan(compat, undefined, 0)).toEqual({
      url: 'http://host.docker.internal:8000/v1/models',
      timeout: 20000,
      hints: [],
    });
    expect(modelPlan({ ...compat, model_hints: [{ id: 'local-7b' }] }, undefined, 0)).toMatchObject(
      {
        timeout: 2000,
        hints: [{ id: 'local-7b' }],
      },
    );
  });
});

describe('provider drafts', () => {
  const body = {
    name: 'typesafe',
    kind: 'systemone',
    base_url: 'https://api.typesafe.ai',
    path: '/v1/systemone',
    wire: 'map',
    enabled: true,
    timeout_ms: 20000,
    limits: { max_questions: 400, max_choices: 64 },
    extra_body: {},
    key: { source: 'env', env_var: 'TYPESAFE_API_KEY' },
  };

  test('options left out get their defaults; a header name is kept in lowercase', () => {
    expect(providerDraft(body, undefined).value).toMatchObject({
      send_model: true,
      auth_header: 'authorization',
    });
    expect(
      providerDraft({ ...body, base_url: 'http://host.docker.internal:11434' }, undefined).value
        .send_model,
    ).toBe(false);
    expect(providerDraft({ ...body, auth_header: 'X-API-Key' }, undefined).value.auth_header).toBe(
      'x-api-key',
    );
    const hints = [{ id: 'jev-1.14', price_per_m_input: 0.042, context: 262144, description: 'd' }];
    expect(providerDraft({ ...body, model_hints: hints }, undefined).value.model_hints).toEqual(
      hints,
    );
  });

  test('an edit keeps the stored options unless it changes them', () => {
    const old = providerDraft({ ...body, send_model: false }, undefined).value as Provider;
    expect(providerDraft({ base_url: 'https://other.example' }, old).value.send_model).toBe(false);
    expect(providerDraft({ send_model: true }, old).value.send_model).toBe(true);
  });

  test('a bad option is refused with a 400', () => {
    for (const bad of [
      { send_model: 'yes' },
      { send_model: null },
      { auth_header: 'content-type' },
      { auth_header: 'Host' },
      { auth_header: 'x api key' },
      { auth_header: '' },
      { auth_header: null },
      { model_hints: {} },
      { model_hints: [{ price_per_m_input: 1 }] },
      { model_hints: [{ id: '' }] },
      { model_hints: [{ id: 'a', price_per_m_input: -1 }] },
      { model_hints: [{ id: 'a', context: 1.5 }] },
      { model_hints: [{ id: 'a', extra: true }] },
      { model_hints: [{ id: 'a' }, { id: 'a' }] },
    ])
      expect(() => providerDraft({ ...body, ...bad }, undefined), JSON.stringify(bad)).toThrow();
  });

  test('a read carries every option, filling in a row from before migration 3', () => {
    const old = {
      ...vendor,
      send_model: undefined,
      auth_header: undefined,
      model_hints: undefined,
    };
    expect(providerView(old, false)).toMatchObject({
      send_model: true,
      auth_header: 'authorization',
      model_hints: [],
    });
    expect(providerView(vendor, false)).toMatchObject({
      send_model: true,
      auth_header: 'x-api-key',
    });
  });
});

describe('migration 3', () => {
  const strip = (p: Provider): Provider => ({
    ...p,
    send_model: undefined,
    auth_header: undefined,
  });

  test('existing OpenRouter is sent the model and the seeded llamacpp is not; keys stay in authorization', () => {
    const migrated = [...seeded, compatible].map((p) => migrateProviderOptions(strip(p)));

    const named = (name: string) => migrated.find((p) => p.name === name)!;

    expect(named('openrouter')).toMatchObject({ send_model: true, auth_header: 'authorization' });
    expect(named('llamacpp')).toMatchObject({ send_model: false, auth_header: 'authorization' });
    expect(named('openai').send_model).toBe(true);
    expect(named('compat').send_model).toBe(true);
  });

  test('a map-wire provider other than OpenRouter keeps sending no model, and set options are kept', () => {
    expect(migrateProviderOptions(strip(vendor)).send_model).toBe(false);
    expect(migrateProviderOptions(vendor)).toBe(vendor);
    expect(migrateProviderOptions({ ...vendor, auth_header: undefined }).auth_header).toBe(
      'authorization',
    );
    expect(migrateProviderOptions({ ...vendor, auth_header: undefined }).send_model).toBe(true);
  });
});

describe('redaction of a custom auth header', () => {
  test('a field named like the header is hidden in any case, beside the usual credential names', () => {
    expect(
      redact({ 'X-Vendor-Pass': 'k', nested: [{ 'x-vendor-pass': 'k' }], ok: 'fine' }, [], true, [
        'x-vendor-pass',
      ]),
    ).toEqual({
      'X-Vendor-Pass': '[REDACTED]',
      nested: [{ 'x-vendor-pass': '[REDACTED]' }],
      ok: 'fine',
    });
    expect(redact({ 'x-vendor-pass': 'k' })).toEqual({ 'x-vendor-pass': 'k' });
  });

  test('free text hides "name: value" pairs for the header too', () => {
    expect(redactText('x-vendor-pass: abc123 rest', ['x-vendor-pass'])).toBe(
      'x-vendor-pass=[REDACTED] rest',
    );
    expect(redactText('{"x-vendor-pass": "abc"}', ['x-vendor-pass'])).toBe(
      '{"x-vendor-pass"=[REDACTED]}',
    );
    expect(redactText('api_key=abc, token: def')).toBe('api_key=[REDACTED], token=[REDACTED]');
    expect(redactText('x-vendor-pass: abc')).toBe('x-vendor-pass: abc');
  });

  test("traces and logs hide the header's field and the key across attempts", () => {
    const routes = seedRoutes(
      '2026-11-08T00:00:00.000Z',
      { mock: 'a', openai: 'b', openrouter: 'c' },
      ['r1', 'r2', 'r3'],
    );
    const settings = {
      require_client_keys: false,
      capture_payloads: true,
      default_route: 'default',
    };
    const start = initialState('default', settings, routes, seeded).state;
    const echoed = { echo: { 'x-vendor-pass': 'the-key' }, note: 'the-key leaked' };
    const failed = reduceAttempt(
      start,
      failedOutcome(
        'vendor',
        'm',
        0,
        1,
        new CallFailure('http', 'boom', 500, echoed),
        {},
        'the-key',
        'x-vendor-pass',
      ),
    );
    expect(failed.fields).toEqual(['x-vendor-pass']);
    expect(failed.upstreamResponse).toEqual({
      echo: { 'x-vendor-pass': '[REDACTED]' },
      note: '[REDACTED] leaked',
    });
    const parsed = {
      answers: [{ type: 'predicate' as const, name: 'q', probability: 0.9 }],
      usage: null,
      confidenceMethod: 'none' as const,
      billed: null,
      servedBy: null,
      resolvedModel: null,
    };
    const answered = reduceAttempt(
      failed,
      succeededOutcome('mock', 'mock-1', 1, 2, { 'x-vendor-pass': 'x' }, echoed, null, parsed, {
        tokens: 1,
        cost_usd: 0,
        cost_basis: 'upstream_cost',
        cost_includes_output: true,
      }),
    );
    const { result, log } = finalize(answered, request, settings, {
      start: 0,
      end: 2,
      created: 2,
      timestamp: 2,
      responseId: 'dec_1',
      logId: 'log_1',
    });
    expect(JSON.stringify(result.trace)).not.toContain('the-key');
    expect(result.trace.upstream_request).toEqual({ 'x-vendor-pass': '[REDACTED]' });
    expect(JSON.stringify(log)).not.toContain('the-key');
  });

  test('an excerpt hides the secrets so far plus this key, and the fields so far plus this header', () => {
    expect(hiddenValues({ secrets: ['a'], fields: ['x-one'] }, 'b', 'x-two')).toEqual({
      secrets: ['a', 'b'],
      fields: ['x-one', 'x-two'],
    });
    expect(hiddenValues({ secrets: [], fields: ['x-one'] }, null, 'x-one')).toEqual({
      secrets: [],
      fields: ['x-one'],
    });
  });
});
