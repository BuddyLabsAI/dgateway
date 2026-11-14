import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type { DecisionResponse } from '../../src/modules/gateway/libs/decisions/schemas/types';
import type { Log, Provider } from '../../src/modules/gateway/libs/management/schemas/types';
import type { Route } from '../../src/modules/gateway/libs/routing/schemas/types';

// Cost tracking through the real daemon. The fake upstream reads the provider's path: /no-usage answers
// without token usage, /fail returns 500, /models has no catalog, /cached answers with OpenAI's usage shape (see
// CACHED_USAGE), and any other path answers with 9 tokens of usage. None of them reports a cost, so the gateway
// prices their tokens; the mock reports a billed cost of 0.
// OpenRouter is a fixed host, so its catalog and decisions come from the injected fetch. Nothing reaches the
// network.
const dir = mkdtempSync(join(tmpdir(), 'gateway-cost-'));
const ADMIN = 'cost-admin-token';
const adminHeaders = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
const env = {
  ADMIN_TOKEN: ADMIN,
  DATA_DIR: join(dir, 'data'),
  OPENROUTER_API_KEY: 'cost-openrouter-key',
};
// Input 'classify' (8 characters) and instructions 'test' (4) make 12 characters: 3 estimated tokens.
const request = {
  input: 'classify',
  questions: [{ name: 'p', type: 'predicate', instructions: 'test' }],
};
const ESTIMATED_TOKENS = 3;
const USAGE_TOKENS = 9;
// OpenAI's usage shape for a request with cache activity: 1,000 input tokens, of which 600 were cache reads and 100
// cache writes, so 300 are ordinary input.
const CACHED_USAGE = {
  input_tokens: 1000,
  output_tokens: 1,
  total_tokens: 1001,
  input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
};
const catalog = { data: [{ id: 'baseten/elephant-1', pricing: { prompt: '0.000002' } }] };

let gateway: ReturnType<typeof createGateway>;
let server: ReturnType<typeof Bun.serve>;
let upstream: ReturnType<typeof Bun.serve>;
let catalogFetches = 0;
const ids: Record<string, string> = {};
type LogPage = { items: Log[]; next_before: string | null };
type StatsView = {
  cost_usd: number;
  unpriced: number;
  by_provider: { provider: string; cost_usd: number }[];
  by_route: { route: string; cost_usd: number }[];
  timeseries: { cost_usd: number }[];
};

const sumCosts = (items: { cost_usd: number }[]) => items.reduce((a, x) => a + x.cost_usd, 0);

async function api<T = unknown>(path: string, method = 'GET', body?: unknown, auth = true) {
  const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: auth ? adminHeaders : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as T };
}

async function decide(model: string): Promise<DecisionResponse> {
  const r = await fetch(`http://127.0.0.1:${server.port}/v1/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, ...request }),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as DecisionResponse;
}

async function fakeUpstream(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === '/fail') return Response.json({ error: 'boom' }, { status: 500 });
  if (path === '/models') return Response.json({ error: 'no catalog' }, { status: 404 });
  const body = (await req.json()) as { state?: string; questions: unknown };
  const usage =
    path === '/no-usage'
      ? {}
      : path === '/cached'
        ? { usage: CACHED_USAGE }
        : { usage: { prompt_tokens: USAGE_TOKENS, total_tokens: USAGE_TOKENS } };
  if (body.state !== undefined)
    return Response.json({ answers: { q0: { probability: 0.9 } }, ...usage });
  const questions = body.questions as { name: string; type: string }[];
  return Response.json({
    answers: questions.map((q) => ({
      question: q.name,
      type: q.type,
      value: true,
      probability: 0.9,
    })),
    ...usage,
  });
}

// Serves OpenRouter's catalog and decisions from the fake, and sends every other request out as usual.
const http = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== 'openrouter.ai') return fetch(input, init);
  if (url.pathname === '/api/v1/models') {
    catalogFetches++;
    return Promise.resolve(Response.json(catalog));
  }
  return fakeUpstream(new Request(`http://fake${url.pathname}`, init));
}) as typeof fetch;

function providerBody(name: string, kind: string, path: string, wire: 'openai' | 'map') {
  return {
    name,
    kind,
    base_url: `http://127.0.0.1:${upstream.port}`,
    path,
    wire,
    enabled: true,
    timeout_ms: 2000,
    limits: { max_questions: 10, max_choices: 10 },
    extra_body: {},
    key: { source: 'none' },
  };
}

async function providerView(id: string): Promise<Provider> {
  const all = (await api<Provider[]>('/admin/api/providers')).body;
  return all.find((p) => p.id === id)!;
}

beforeAll(async () => {
  upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: fakeUpstream });
  gateway = createGateway({ env, http });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });
  const seeded = (await api<Provider[]>('/admin/api/providers')).body;
  ids.mock = seeded.find((p) => p.name === 'mock')!.id;
  ids.openrouter = seeded.find((p) => p.name === 'openrouter')!.id;
  // A local SystemOne server has no default price unless a step or hint prices it.
  const made: [string, string, string, 'openai' | 'map'][] = [
    ['usage', 'openai-compatible', '/usage', 'openai'],
    ['plain', 'openai-compatible', '/no-usage', 'map'],
    ['table', 'openai', '/usage', 'openai'],
    ['flaky', 'openai-compatible', '/fail', 'openai'],
    ['local', 'systemone', '/no-usage', 'map'],
    ['cached', 'openai', '/cached', 'openai'],
  ];
  for (const [name, kind, path, wire] of made) {
    const r = await api<{ id: string }>(
      '/admin/api/providers',
      'POST',
      providerBody(name, kind, path, wire),
    );
    expect(r.status).toBe(200);
    ids[name] = r.body.id;
  }
  const routes: [string, { provider_id: string; model: string; price_per_m_input?: number }[]][] = [
    ['priced-openai', [{ provider_id: ids.usage, model: 'remote', price_per_m_input: 2 }]],
    ['estimated-map', [{ provider_id: ids.plain, model: 'remote', price_per_m_input: 4 }]],
    ['unpriced', [{ provider_id: ids.usage, model: 'remote' }]],
    ['openai-table', [{ provider_id: ids.table, model: 'gpt-6-luna' }]],
    ['openai-cached', [{ provider_id: ids.cached, model: 'gpt-6-luna' }]],
    ['mock-priced', [{ provider_id: ids.mock, model: 'mock-1', price_per_m_input: 0.5 }]],
    ['local-unpriced', [{ provider_id: ids.local, model: 'd1' }]],
    ['local-priced', [{ provider_id: ids.local, model: 'd1', price_per_m_input: 0.5 }]],
  ];
  for (const [alias, targets] of routes) {
    const r = await api<Route>('/admin/api/routes', 'POST', {
      alias,
      description: alias,
      enabled: true,
      targets,
    });
    expect(r.status).toBe(200);
  }
});

afterAll(async () => {
  await server?.stop(true);
  await upstream?.stop(true);
  gateway?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('cost of a decision', () => {
  test('the mock bills 0, reported as its own cost: basis upstream_cost, with its input tokens', async () => {
    const b = await decide('default');
    expect(b.gateway).toMatchObject({
      cost_usd: 0,
      cost_basis: 'upstream_cost',
      tokens: ESTIMATED_TOKENS,
      served_by: 'Mock',
      upstream_model_resolved: 'mock-1',
    });
    // One output token per question.
    expect(b.usage).toEqual({ input_tokens: ESTIMATED_TOKENS, output_tokens: 1, total_tokens: 4 });
    const logged = (await api<LogPage>('/admin/api/logs?limit=1')).body.items[0];
    expect(logged).toMatchObject({
      cost_usd: 0,
      cost_basis: 'upstream_cost',
      tokens: ESTIMATED_TOKENS,
      prompt_tokens: ESTIMATED_TOKENS,
      served_by: 'Mock',
      upstream_model_resolved: 'mock-1',
    });
  });

  test('upstream usage with a target price: basis upstream_tokens', async () => {
    const b = await decide('priced-openai');
    expect(b.usage).toEqual({
      input_tokens: USAGE_TOKENS,
      output_tokens: 0,
      total_tokens: USAGE_TOKENS,
    });
    // 9 tokens at $2 per million input tokens.
    expect(b.gateway).toMatchObject({
      cost_usd: 0.000018,
      cost_basis: 'upstream_tokens',
      tokens: USAGE_TOKENS,
    });
  });

  test('no upstream usage: the estimate is priced with basis estimated_tokens', async () => {
    const b = await decide('estimated-map');
    expect(b.usage).toBeNull();
    // 3 estimated tokens at $4 per million input tokens.
    expect(b.gateway).toMatchObject({
      cost_usd: 0.000012,
      cost_basis: 'estimated_tokens',
      tokens: ESTIMATED_TOKENS,
    });
  });

  test('an unpriced openai-compatible target has no cost and keeps its token count', async () => {
    const b = await decide('unpriced');
    expect(b.gateway).toMatchObject({
      cost_usd: null,
      cost_basis: 'unpriced',
      tokens: USAGE_TOKENS,
    });
  });

  test('the built-in OpenAI price applies to gpt-6-luna without a target price', async () => {
    const b = await decide('openai-table');
    // 9 tokens at $0.10 per million input tokens.
    expect(b.gateway).toMatchObject({
      cost_usd: 0.0000009,
      cost_basis: 'upstream_tokens',
      tokens: USAGE_TOKENS,
    });
  });

  test('a local SystemOne server is unpriced unless a target prices it', async () => {
    const local = await decide('local-unpriced');
    expect(local.gateway).toMatchObject({
      cost_usd: null,
      cost_basis: 'unpriced',
      cost_includes_output: false,
      tokens: ESTIMATED_TOKENS,
    });
    const b = await decide('local-priced');
    // 3 estimated tokens at $0.50 per million input tokens.
    expect(b.gateway).toMatchObject({
      cost_usd: 0.0000015,
      cost_basis: 'estimated_tokens',
      tokens: ESTIMATED_TOKENS,
    });
  });

  test('a billed cost beats a target price: the mock still bills 0', async () => {
    const b = await decide('mock-priced');
    expect(b.gateway).toMatchObject({
      cost_usd: 0,
      cost_basis: 'upstream_cost',
      tokens: ESTIMATED_TOKENS,
    });
  });

  test('a cold OpenRouter catalog is unpriced, and a decision never fetches it', async () => {
    const before = catalogFetches;
    const cold = await decide('elephant');
    expect(cold.gateway).toMatchObject({ cost_usd: null, cost_basis: 'unpriced' });
    expect(catalogFetches).toBe(before);
    const listed = await api<{ models: { id: string; price_per_m_input?: number }[] }>(
      `/admin/api/providers/${ids.openrouter}/models`,
    );
    expect(listed.body.models.find((m) => m.id === 'baseten/elephant-1')?.price_per_m_input).toBe(
      2,
    );
    const warm = await decide('elephant');
    // 9 tokens at $2 per million input tokens, from the catalog cached by the models endpoint.
    expect(warm.gateway).toMatchObject({
      cost_usd: 0.000018,
      cost_basis: 'upstream_tokens',
      tokens: USAGE_TOKENS,
    });
    expect(catalogFetches).toBe(before + 1);
  });

  test('a failed request carries no cost', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'priced-openai', input: '', questions: [] }),
    });
    expect(r.status).toBe(400);
    const logged = (await api<LogPage>('/admin/api/logs?status=error&limit=1')).body.items[0];
    expect(logged).toMatchObject({ cost_usd: null, cost_basis: null, tokens: null });
  });

  test('the playground returns the same cost fields', async () => {
    const play = await api<{ response: DecisionResponse | null }>('/admin/api/playground', 'POST', {
      request: { model: 'priced-openai', ...request },
    });
    expect(play.body.response?.gateway).toMatchObject({
      cost_usd: 0.000018,
      cost_basis: 'upstream_tokens',
    });
  });
});

describe('provider test status', () => {
  test('a successful test is recorded as last_test; the mock gives the known answer', async () => {
    const tested = await api<Record<string, unknown>>(
      `/admin/api/providers/${ids.mock}/test`,
      'POST',
      {},
    );
    // The seeded default route is the first one with a step on the mock.
    expect(tested.body).toMatchObject({
      ok: true,
      model: 'mock-1',
      model_reason: 'used_by_route',
      model_route: 'default',
      expected: 'billing',
      answer: 'billing',
      probability: 0.96,
      matched: true,
    });
    const last = (await providerView(ids.mock)).last_test!;
    expect(last).toMatchObject({
      ok: true,
      model: 'mock-1',
      model_reason: 'used_by_route',
      matched: true,
      error: null,
    });
    expect(new Date(last.at).toISOString()).toBe(last.at);
    expect(last.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('a failed test is recorded as last_test too, with its error', async () => {
    const tested = await api<Record<string, unknown>>(
      `/admin/api/providers/${ids.flaky}/test`,
      'POST',
      {},
    );
    // Nothing names a model for this server, and its listing fails, so the placeholder is tested.
    expect(tested.body).toMatchObject({
      ok: false,
      error: 'upstream HTTP 500',
      model: 'server-configured',
      model_reason: 'server_configured',
      model_route: null,
      answer: null,
      probability: null,
      matched: false,
    });
    expect(tested.body).not.toHaveProperty('response');
    expect((await providerView(ids.flaky)).last_test).toMatchObject({
      ok: false,
      model: 'server-configured',
      model_reason: 'server_configured',
      matched: false,
      error: 'upstream HTTP 500',
    });
  });

  test('a new provider reads last_test as null, and an edit keeps the last test', async () => {
    const created = await api<{ last_test: unknown }>(
      '/admin/api/providers',
      'POST',
      providerBody('fresh', 'openai-compatible', '/usage', 'openai'),
    );
    expect(created.body.last_test).toBeNull();
    const edited = await api<{ last_test: unknown }>(`/admin/api/providers/${ids.flaky}`, 'PATCH', {
      enabled: false,
    });
    expect(edited.body.last_test).toMatchObject({ ok: false, error: 'upstream HTTP 500' });
  });
});

describe('route target prices', () => {
  test('a price survives create, update and read, and is validated', async () => {
    const made = await api<Route>('/admin/api/routes', 'POST', {
      alias: 'priced-check',
      description: 'price',
      enabled: true,
      targets: [{ provider_id: ids.usage, model: 'remote', price_per_m_input: 1.25 }],
    });
    expect(made.status).toBe(200);
    expect(made.body.targets[0]?.price_per_m_input).toBe(1.25);
    const read = (await api<Route[]>('/admin/api/routes')).body.find((r) => r.id === made.body.id);
    expect(read?.targets[0]?.price_per_m_input).toBe(1.25);
    const cleared = await api<Route>(`/admin/api/routes/${made.body.id}`, 'PATCH', {
      targets: [{ provider_id: ids.usage, model: 'remote', price_per_m_input: null }],
    });
    expect(cleared.body.targets[0]?.price_per_m_input).toBeNull();
    for (const bad of [-1, 'free']) {
      const refused = await api('/admin/api/routes', 'POST', {
        alias: 'bad-price',
        description: 'bad',
        enabled: true,
        targets: [{ provider_id: ids.usage, model: 'remote', price_per_m_input: bad }],
      });
      expect(refused.status).toBe(400);
    }
  });
});

describe('stats agree with the logs', () => {
  test('window, provider, route and bucket costs add up, and unpriced counts answered requests only', async () => {
    const logs = (await api<LogPage>('/admin/api/logs?limit=1000')).body.items;
    const stats = (await api<StatsView>('/admin/api/stats?window=1h')).body;
    const total = logs.reduce((sum, l) => sum + (l.cost_usd ?? 0), 0);
    expect(stats.cost_usd).toBeCloseTo(total, 8);
    // Three decisions at 9 tokens and $2 per million (priced-openai, the warm catalog, the playground), then the
    // estimate, the OpenAI table and the priced local server. The mock's billed costs are 0.
    expect(stats.cost_usd).toBeCloseTo(0.000018 * 3 + 0.000012 + 0.0000009 + 0.0000015, 8);
    // The unpriced target, local server and cold catalog answered without a price.
    expect(stats.unpriced).toBe(3);
    expect(stats.unpriced).toBe(
      logs.filter((l) => l.status === 'ok' && l.cost_basis === 'unpriced').length,
    );
    expect(sumCosts(stats.by_provider)).toBeCloseTo(stats.cost_usd, 8);
    expect(sumCosts(stats.by_route)).toBeCloseTo(stats.cost_usd, 8);
    expect(sumCosts(stats.timeseries)).toBeCloseTo(stats.cost_usd, 8);
    expect(stats.timeseries).toHaveLength(24);
  });
});

// Kept after the stats test, whose exact total counts every decision above.
describe('cached input in the cost of a decision', () => {
  test('cache reads and writes are charged at the built-in cache rates, and the log keeps the same cost', async () => {
    const b = await decide('openai-cached');
    expect(b.usage).toEqual(CACHED_USAGE);
    // 300 ordinary input tokens at $0.10, 600 cached at $0.01 and 100 written at $0.125, per million. The one output
    // token is free: OpenAI does not charge output tokens on its Decisions endpoint, so the cost covers it at 0.
    expect(b.gateway).toMatchObject({
      cost_usd: 0.0000485,
      cost_includes_output: true,
      cost_basis: 'upstream_tokens',
      tokens: CACHED_USAGE.input_tokens,
    });
    const logged = (await api<LogPage>('/admin/api/logs?limit=1')).body.items[0];
    expect(logged).toMatchObject({
      cost_usd: 0.0000485,
      cost_includes_output: true,
      cost_basis: 'upstream_tokens',
      tokens: CACHED_USAGE.input_tokens,
    });
  });
});

test('legacy free rows load through logs and stats without rewriting history', async () => {
  const before = (await api<StatsView>('/admin/api/stats?window=1h')).body;
  const legacy = {
    ...gateway.store.allLogs()[0],
    id: 'legacy-local-cost',
    ts: new Date().toISOString(),
    route: 'local-unpriced',
    provider: 'local',
    cost_basis: 'free',
    cost_usd: 0,
    cost_includes_output: true,
  };
  const stored = JSON.stringify(legacy);
  gateway.store.db
    .query('INSERT INTO logs(id,ts,data) VALUES(?,?,?)')
    .run(legacy.id, legacy.ts, stored);
  const logs = (await api<LogPage>('/admin/api/logs?limit=1000')).body.items;
  expect(logs.find((row) => row.id === legacy.id)).toMatchObject({
    cost_basis: 'unpriced',
    cost_usd: 0,
    cost_includes_output: true,
  });
  const after = (await api<StatsView>('/admin/api/stats?window=1h')).body;
  expect(after.unpriced).toBe(before.unpriced + 1);
  expect(after.cost_usd).toBe(before.cost_usd);
  expect(gateway.store.db.query('SELECT data FROM logs WHERE id=?').get(legacy.id)).toEqual({
    data: stored,
  });
});
