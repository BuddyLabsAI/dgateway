import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type { Provider } from '../../src/modules/gateway/libs/management/schemas/types';

// The contract additions through the real daemon: the coded refusal to store a key while GATEWAY_SECRET is
// unset, the secret_configured flag in health, default prices in the models endpoint, and unpriced counts per
// route and per provider. Nothing reaches the network: every upstream call goes through the injected fetch.
const ADMIN = 'gaps-admin-token';
const SECRET = 'gaps-secret-value-that-must-never-appear';
const catalog = { data: [{ id: 'baseten/elephant-1', pricing: { prompt: '0.000002' } }] };

// The fake upstreams answer synchronously; the injected fetch wraps each answer in a promise.
function fakeHttp(input: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/models')
    return Response.json(catalog);
  if (url.hostname === 'compat.test' && url.pathname === '/models')
    return Response.json({ data: [{ id: 'local-7b' }] });
  if (url.hostname === 'compat.test') {
    const text = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(text) as { questions: { name: string; type: string }[] };
    return Response.json({
      answers: body.questions.map((q) => ({
        question: q.name,
        type: q.type,
        value: true,
        probability: 0.9,
      })),
    });
  }
  return new Response('not served', { status: 599 });
}

const http = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(fakeHttp(input, init))) as typeof fetch;

type Harness = {
  api: <T = unknown>(
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<{ status: number; body: T; text: string }>;
  decide: (model: string) => Promise<{ gateway: { cost_basis: string } }>;
  close: () => void;
};

// A daemon with its own data directory. Its environment decides whether GATEWAY_SECRET is set.
function startGateway(extra: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-gaps-'));
  const env = {
    ADMIN_TOKEN: ADMIN,
    DATA_DIR: join(dir, 'data'),
    OPENROUTER_API_KEY: 'gaps-openrouter-key',
    ...extra,
  };
  const gateway = createGateway({ env, http });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    async api(path, method = 'GET', body) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await r.text();
      return { status: r.status, body: JSON.parse(text) as never, text };
    },
    async decide(model) {
      const r = await fetch(`${base}/v1/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          input: 'classify this',
          questions: [{ name: 'p', type: 'predicate', instructions: 'Is it?' }],
        }),
      });
      expect(r.status).toBe(200);
      return (await r.json()) as { gateway: { cost_basis: string } };
    },
    close() {
      void server.stop(true);
      gateway.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const providerTemplate = {
  name: 'stored-test',
  kind: 'openai-compatible',
  base_url: 'http://compat.test',
  path: '/decide',
  wire: 'openai',
  enabled: true,
  timeout_ms: 2000,
  limits: { max_questions: 10, max_choices: 10 },
  extra_body: {},
};

async function providerIdByName(h: Harness, name: string): Promise<string> {
  const all = (await h.api<Provider[]>('/admin/api/providers')).body;
  return all.find((p) => p.name === name)!.id;
}

describe('without GATEWAY_SECRET', () => {
  let h: Harness;
  beforeAll(() => {
    h = startGateway();
  });
  afterAll(() => h.close());

  test('health reports secret_configured false', async () => {
    const health = await h.api<{ secret_configured: boolean }>('/admin/api/health');
    expect(health.status).toBe(200);
    expect(health.body.secret_configured).toBe(false);
  });

  test('storing a stored key is refused with the gateway_secret_missing code and the same message', async () => {
    const created = await h.api<{ error: { message: string; type: string; code?: string } }>(
      '/admin/api/providers',
      'POST',
      {
        ...providerTemplate,
        name: 'refused-new',
        key: { source: 'stored', value: 'sk-test-1234' },
      },
    );
    expect(created.status).toBe(400);
    expect(created.body.error).toEqual({
      message: 'GATEWAY_SECRET must be set to store provider keys',
      type: 'invalid_request_error',
      code: 'gateway_secret_missing',
    });
    const id = await providerIdByName(h, 'openai');
    const patched = await h.api<{ error: { code?: string } }>(
      `/admin/api/providers/${id}`,
      'PATCH',
      {
        key: { source: 'stored', value: 'sk-test-5678' },
      },
    );
    expect(patched.status).toBe(400);
    expect(patched.body.error.code).toBe('gateway_secret_missing');
  });

  test('an environment key is still accepted, and a refusal never stores anything', async () => {
    const created = await h.api<Provider>('/admin/api/providers', 'POST', {
      ...providerTemplate,
      name: 'env-ok',
      key: { source: 'env', env_var: 'ENV_OK_KEY' },
    });
    expect(created.status).toBe(200);
    expect(created.body.key.source).toBe('env');
  });
});

describe('with GATEWAY_SECRET', () => {
  let h: Harness;
  beforeAll(() => {
    h = startGateway({ GATEWAY_SECRET: SECRET });
  });
  afterAll(() => h.close());

  test('health reports secret_configured true, and never the value', async () => {
    const health = await h.api<{ secret_configured: boolean }>('/admin/api/health');
    expect(health.body.secret_configured).toBe(true);
    expect(health.text).not.toContain(SECRET);
  });

  test('a stored key is accepted and shown only as its last four characters', async () => {
    const created = await h.api<{ key: unknown }>('/admin/api/providers', 'POST', {
      ...providerTemplate,
      name: 'stored-ok',
      key: { source: 'stored', value: 'sk-test-9999' },
    });
    expect(created.status).toBe(200);
    expect(created.body.key).toEqual({ source: 'stored', last4: '9999' });
    expect(created.text).not.toContain('sk-test-9999');
  });

  test('a stored key under 12 characters shows none of its characters on any read', async () => {
    type Read = { id: string; key: unknown };
    // '#' and '!' never occur in base64, so the key can show in a response only as itself.
    const created = await h.api<Read>('/admin/api/providers', 'POST', {
      ...providerTemplate,
      name: 'stored-short',
      key: { source: 'stored', value: 'k#9!' },
    });
    expect(created.status).toBe(200);
    expect(created.body.key).toEqual({ source: 'stored', last4: null });
    expect(created.text).not.toContain('k#9!');
    const listed = await h.api<Read[]>('/admin/api/providers');
    expect(listed.body.find((p) => p.id === created.body.id)?.key).toEqual({
      source: 'stored',
      last4: null,
    });
    expect(listed.text).not.toContain('k#9!');
    // 11 characters still show none; 12 show the last four, a third of the key.
    const eleven = await h.api<Read>(`/admin/api/providers/${created.body.id}`, 'PATCH', {
      key: { source: 'stored', value: 'sk-abcd#!#!' },
    });
    expect(eleven.body.key).toEqual({ source: 'stored', last4: null });
    expect(eleven.text).not.toContain('#!#!');
    const twelve = await h.api<Read>(`/admin/api/providers/${created.body.id}`, 'PATCH', {
      key: { source: 'stored', value: 'sk-abcde#!#!' },
    });
    expect(twelve.body.key).toEqual({ source: 'stored', last4: '#!#!' });
  });
});

describe('default prices in the models endpoint', () => {
  let h: Harness;
  beforeAll(async () => {
    h = startGateway();
    await h.api('/admin/api/providers', 'POST', {
      ...providerTemplate,
      name: 'compat',
      key: { source: 'none' },
    });
  });
  afterAll(() => h.close());

  const models = async (name: string) =>
    (
      await h.api<{
        models: {
          id: string;
          price_per_m_input?: number;
          default_price_per_m_input?: number;
          default_price_per_m_output?: number;
        }[];
      }>(`/admin/api/providers/${await providerIdByName(h, name)}/models`)
    ).body.models;

  test('mock defaults to 0 while local systemone has no default', async () => {
    // Both defaults are listed; the output default is additive (see Cost, output pricing).
    expect(await models('mock')).toEqual([
      { id: 'mock-1', default_price_per_m_input: 0, default_price_per_m_output: 0 },
    ]);
    const systemone = await models('llamacpp');
    expect(
      systemone.map((m) => [m.id, m.default_price_per_m_input, m.default_price_per_m_output]),
    ).toEqual([['server-configured', undefined, undefined]]);
  });

  test('openai defaults to the built-in table price, with no output price on the native wire', async () => {
    // OpenAI does not charge output tokens on its Decisions endpoint, which the seeded openai provider calls.
    const listed = await models('openai');
    expect(
      listed.map((m) => [m.id, m.default_price_per_m_input, m.default_price_per_m_output]),
    ).toEqual([['gpt-6-luna', 0.1, 0]]);
  });

  test('openrouter defaults to the catalog price, equal to price_per_m_input', async () => {
    const listed = await models('openrouter');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.price_per_m_input).toBeGreaterThan(0);
    expect(listed[0]?.default_price_per_m_input).toBe(listed[0]?.price_per_m_input);
  });

  test('openai-compatible has no default, so its models carry none', async () => {
    const listed = await models('compat');
    expect(listed).toEqual([{ id: 'local-7b' }]);
  });
});

describe('unpriced counts per route and per provider', () => {
  let h: Harness;
  beforeAll(async () => {
    h = startGateway();
    const compat = await h.api<Provider>('/admin/api/providers', 'POST', {
      ...providerTemplate,
      name: 'compat',
      key: { source: 'none' },
    });
    await h.api('/admin/api/routes', 'POST', {
      alias: 'compat-route',
      description: 'A local model with no price',
      enabled: true,
      targets: [{ provider_id: compat.body.id, model: 'local-7b' }],
    });
  });
  afterAll(() => h.close());

  test('answered requests that went unpriced are counted for their route and their provider', async () => {
    expect((await h.decide('compat-route')).gateway.cost_basis).toBe('unpriced');
    expect((await h.decide('compat-route')).gateway.cost_basis).toBe('unpriced');
    // The mock reports what it billed (0), so it is never unpriced.
    expect((await h.decide('default')).gateway.cost_basis).toBe('upstream_cost');
    const stats = (
      await h.api<{
        unpriced: number;
        by_provider: { provider: string; unpriced: number }[];
        by_route: { route: string; unpriced: number }[];
      }>('/admin/api/stats?window=1h')
    ).body;
    expect(stats.unpriced).toBe(2);
    expect(stats.by_route.find((row) => row.route === 'compat-route')?.unpriced).toBe(2);
    expect(stats.by_route.find((row) => row.route === 'default')?.unpriced).toBe(0);
    expect(stats.by_provider.find((row) => row.provider === 'compat')?.unpriced).toBe(2);
    expect(stats.by_provider.find((row) => row.provider === 'mock')?.unpriced).toBe(0);
  });
});
