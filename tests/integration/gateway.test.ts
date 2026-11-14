import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type {
  DecisionResponse,
  ErrorBody,
} from '../../src/modules/gateway/libs/decisions/schemas/types';
import type { Log } from '../../src/modules/gateway/libs/management/schemas/types';
import type { Route } from '../../src/modules/gateway/libs/routing/schemas/types';
import { normalizedEntropy } from '../../src/modules/gateway/libs/decisions/functions/translation';
const dir = mkdtempSync(join(tmpdir(), 'gateway-test-')),
  consoleDir = join(dir, 'console');
const env = {
  ADMIN_TOKEN: 'admin-token',
  GATEWAY_SECRET: 'encryption-password',
  DATA_DIR: join(dir, 'data'),
  CONSOLE_DIR: consoleDir,
};
let gateway: ReturnType<typeof createGateway>,
  server: ReturnType<typeof Bun.serve>,
  upstream: ReturnType<typeof Bun.serve>;
// The body the fake upstream received: the map wire (state, questions) or the openai wire (model, input).
type CapturedRequest = {
  model: string;
  input: string;
  state: string;
  questions: Record<string, { criteria: Record<string, string> | string[] }>;
};
let mode = 'ok',
  captured: CapturedRequest;
// Shapes of the admin API responses that these tests read.
type ProviderView = { id: string; name: string; key: unknown };
type ClientCreated = { id: string; key: string };
type ClientView = { id: string; last_used_at: string | null };
type LogPage = { items: (Log & { request: { input: string } })[]; next_before: string | null };
type StatsView = {
  requests: number;
  errors: number;
  fallbacks: number;
  fallbacks_answered: number;
  timeseries: unknown[];
};
type StatsBucketView = {
  requests: number;
  p50_ms: number | null;
  p95_ms: number | null;
  fallbacks: number;
  fallbacks_answered: number;
};
type PlaygroundView = {
  response: DecisionResponse | null;
  trace: {
    upstream_request: { api_key: string };
    upstream_response: { api_key: string };
  };
};
const secret = 'ultra-private-provider-key-xyz';
const request = {
  model: 'custom',
  input: 'classify',
  questions: [
    {
      name: 'c',
      type: 'choice',
      instructions: 'pick',
      choices: [
        { value: true, description: 'yes' },
        { value: 'no', description: 'no' },
      ],
    },
    { name: 'p', type: 'predicate', instructions: 'test' },
    {
      name: 's',
      type: 'score',
      instructions: 'score',
      levels: [{ description: 'low' }, { description: 'high' }],
    },
  ],
};
let providerId: string, routeId: string;
const adminHeaders = { authorization: 'Bearer admin-token', 'content-type': 'application/json' };

async function api<T = unknown>(path: string, method = 'GET', body?: unknown, auth = true) {
  const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: auth ? adminHeaders : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as T };
}

const postDecision = (body: unknown = request, authorization?: string) =>
  fetch(`http://127.0.0.1:${server.port}/v1/decisions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
    },
    body: JSON.stringify(body),
  });

async function fakeUpstream(req: Request) {
  captured = (await req.json()) as CapturedRequest;
  if (mode === 'timeout') {
    await Bun.sleep(120);
    return Response.json({});
  }
  if (['500', '429', '400', '401', '403', '404', '422'].includes(mode))
    return Response.json({ error: 'failure' }, { status: Number(mode) });
  if (mode === 'invalid') return Response.json({ broken: true });
  // An older openai-compatible server, which answers in this gateway's earlier public shape.
  if (mode === 'openai')
    return Response.json({
      answers: [
        {
          question: 'c',
          type: 'choice',
          value: true,
          probabilities: { true: 0.8, no: 0.2 },
          confidence: 0.9,
        },
        { question: 'p', type: 'predicate', value: false, probability: 0.5 },
        {
          question: 's',
          type: 'score',
          value: 0,
          score: 0,
          probabilities: { '0': 0.2, '1': 0.8 },
          confidence: 0.4,
        },
      ],
      usage: { prompt_tokens: 9, total_tokens: 9 },
    });
  // A SystemOne server, in the shapes OpenRouter answers with.
  return Response.json({
    model: 'remote-2026',
    provider: 'Fake Vendor',
    answers: {
      q0: { type: 'choice', choice: 'o0', probabilities: { o0: 0.8, o1: 0.2 }, confidence: 0.6 },
      q1: { type: 'noul', noul: 0.5 },
      q2: {
        type: 'score',
        score: 0.8,
        probabilities: { '0': 0.2, '1': 0.8 },
        legend: { '0': 'low', '1': 'high' },
      },
    },
    usage: { input_tokens: 30, output_tokens: 3 },
    api_key: secret,
  });
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: fakeUpstream,
  });
  gateway = createGateway({ env });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });
  const p = await api<{ id: string }>('/admin/api/providers', 'POST', {
    name: 'fake',
    kind: 'systemone',
    base_url: `http://127.0.0.1:${upstream.port}`,
    path: '/decisions',
    wire: 'map',
    enabled: true,
    timeout_ms: 30,
    limits: { max_questions: 10, max_choices: 10 },
    extra_body: { api_key: 'should-hide' },
    key: { source: 'stored', value: secret },
  });
  expect(p.status).toBe(200);
  providerId = p.body.id;
  const mock = (await api<ProviderView[]>('/admin/api/providers')).body.find(
    (x) => x.name === 'mock',
  )!;
  const route = await api<Route>('/admin/api/routes', 'POST', {
    alias: 'custom',
    description: 'test',
    enabled: true,
    targets: [
      { provider_id: providerId, model: 'remote' },
      { provider_id: mock.id, model: 'mock-1' },
    ],
  });
  routeId = route.body.id;
});
afterAll(async () => {
  await server?.stop(true);
  await upstream?.stop(true);
  gateway?.close();
  rmSync(dir, { recursive: true, force: true });
});
describe('gateway integration', () => {
  test('map translation and trace redaction', async () => {
    mode = 'ok';
    const r = await postDecision();
    const b = (await r.json()) as DecisionResponse;
    expect(r.status).toBe(200);
    expect(captured.state).toBe('classify');
    expect(captured.questions.q0.criteria).toEqual({ o0: 'yes', o1: 'no' });
    expect(captured.questions.q2.criteria).toEqual(['low', 'high']);
    expect(b.answers).toEqual([
      {
        type: 'choice',
        name: 'c',
        choice: true,
        probabilities: [
          { value: true, probability: 0.8 },
          { value: 'no', probability: 0.2 },
        ],
        confidence: 0.6,
        confidence_method: 'upstream',
      },
      { type: 'predicate', name: 'p', probability: 0.5 },
      {
        type: 'score',
        name: 's',
        score: 0.8,
        probabilities: [
          { value: 0, probability: 0.2 },
          { value: 1, probability: 0.8 },
        ],
        confidence: normalizedEntropy([0.2, 0.8]),
        confidence_method: 'normalized-entropy',
      },
    ]);
    expect(b.usage).toEqual({ input_tokens: 30, output_tokens: 3, total_tokens: 33 });
    expect(b.gateway).toMatchObject({
      served_by: 'Fake Vendor',
      upstream_model_resolved: 'remote-2026',
    });
    const play = await api<PlaygroundView>('/admin/api/playground', 'POST', { request });
    expect(play.body.trace.upstream_request.api_key).toBe('[REDACTED]');
    expect(play.body.trace.upstream_response.api_key).toBe('[REDACTED]');
    expect(JSON.stringify(play.body)).not.toContain(secret);
  });
  test('fallback on 500, 429, timeout and invalid bodies; no fallback on 400', async () => {
    for (const m of ['500', '429', '401', '403', '404', 'timeout', 'invalid']) {
      mode = m;
      const r = await postDecision();
      const b = (await r.json()) as DecisionResponse;
      expect(r.status).toBe(200);
      expect(b.gateway.provider).toBe('mock');
      expect(b.gateway.attempts).toHaveLength(2);
      expect(b.gateway.attempts[0].ok).toBe(false);
    }
    mode = '400';
    const r = await postDecision();
    const b = (await r.json()) as { error: ErrorBody };
    expect(r.status).toBe(502);
    expect(b.error.type).toBe('upstream_error');
    const logs = await api<LogPage>('/admin/api/logs?limit=1');
    expect(logs.body.items[0].attempts).toHaveLength(1);
  });
  test('422 validation failure stops without fallback', async () => {
    mode = '422';
    const r = await postDecision();
    expect(r.status).toBe(502);
    const logs = await api<LogPage>('/admin/api/logs?limit=1');
    expect(logs.body.items[0].attempts).toHaveLength(1);
  });
  test('missing env key and undecryptable stored key skip upstream and fall through', async () => {
    let calls = 0;
    const original = gateway.deps.call;
    gateway.deps.call = (...args) => {
      calls++;
      return original(...args);
    };
    await api(`/admin/api/providers/${providerId}`, 'PATCH', {
      key: { source: 'env', env_var: 'MISSING_GATEWAY_TEST_KEY' },
    });
    const missing = await postDecision();
    const first = (await missing.json()) as DecisionResponse;
    expect(first.gateway.provider).toBe('mock');
    expect(first.gateway.attempts[0].error).toBe(
      'MISSING_GATEWAY_TEST_KEY is not set on the gateway host',
    );
    expect(first.gateway.attempts).toHaveLength(2);
    expect(calls).toBe(1);
    await api(`/admin/api/providers/${providerId}`, 'PATCH', {
      key: { source: 'stored', value: secret },
    });
    env.GATEWAY_SECRET = 'incorrect-secret';
    const unreadable = await postDecision();
    const second = (await unreadable.json()) as DecisionResponse;
    expect(second.gateway.provider).toBe('mock');
    expect(second.gateway.attempts[0].error).toBe(
      'stored key cannot be decrypted (check GATEWAY_SECRET)',
    );
    expect(second.gateway.attempts).toHaveLength(2);
    expect(calls).toBe(2);
    env.GATEWAY_SECRET = 'encryption-password';
    gateway.deps.call = original;
  });
  test('provider limit skips to fallback', async () => {
    mode = 'ok';
    await api(`/admin/api/providers/${providerId}`, 'PATCH', {
      limits: { max_questions: 1, max_choices: 10 },
    });
    const r = await postDecision();
    const b = (await r.json()) as DecisionResponse;
    expect(b.gateway.provider).toBe('mock');
    expect(b.gateway.attempts[0].error).toContain('limits');
    await api(`/admin/api/providers/${providerId}`, 'PATCH', {
      limits: { max_questions: 10, max_choices: 10 },
    });
  });
  test('openai wire body and score calculation', async () => {
    mode = 'openai';
    await api(`/admin/api/providers/${providerId}`, 'PATCH', { wire: 'openai' });
    const r = await postDecision();
    const b = (await r.json()) as DecisionResponse;
    expect(captured.model).toBe('remote');
    expect(captured.input).toBe('classify');
    // The older shape (question, value, keyed probabilities) is read into OpenAI's.
    expect(b.answers.map((a) => a.name)).toEqual(['c', 'p', 's']);
    expect(b.answers[0]).toMatchObject({ choice: true, confidence: 0.9 });
    expect(b.answers[1]).toEqual({ type: 'predicate', name: 'p', probability: 0.5 });
    expect(b.answers[2].score).toBeCloseTo(0.8);
    expect(b.answers[2].probabilities).toEqual([
      { value: 0, probability: 0.2 },
      { value: 1, probability: 0.8 },
    ]);
    expect(b.gateway.confidence_method).toBe('upstream');
    expect(b.usage).toEqual({ input_tokens: 9, output_tokens: 0, total_tokens: 9 });
    expect(b.answers[0].confidence_method).toBe('upstream');
    expect(b.gateway).toMatchObject({ served_by: null, upstream_model_resolved: null });
    await api(`/admin/api/providers/${providerId}`, 'PATCH', { wire: 'map' });
  });
  test('admin authentication and encrypted keys', async () => {
    expect((await api('/admin/api/providers', 'GET', undefined, false)).status).toBe(401);
    const p = (await api<ProviderView[]>('/admin/api/providers')).body.find(
      (x) => x.id === providerId,
    )!;
    expect(p.key).toEqual({ source: 'stored', last4: secret.slice(-4) });
    const bytes = Buffer.concat(
      ['gateway.db', 'gateway.db-wal'].map((n) => {
        try {
          return readFileSync(join(env.DATA_DIR, n));
        } catch {
          return Buffer.alloc(0);
        }
      }),
    );
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
    const noSecret = createGateway({ env: { ADMIN_TOKEN: 'x', DATA_DIR: join(dir, 'nosecret') } });
    expect(() =>
      noSecret.admin.saveProvider({
        name: 'new',
        kind: 'mock',
        base_url: '',
        path: '',
        wire: 'map',
        enabled: true,
        timeout_ms: 100,
        limits: { max_questions: 1, max_choices: 2 },
        extra_body: {},
        key: { source: 'stored', value: 'secret' },
      }),
    ).toThrow('GATEWAY_SECRET');
    noSecret.close();
  });
  test('client key enforcement, logging, stats and payload capture', async () => {
    const client = await api<ClientCreated>('/admin/api/clients', 'POST', { name: 'test' });
    expect(client.body.key.startsWith('dgk_')).toBe(true);
    await api('/admin/api/settings', 'PATCH', {
      require_client_keys: true,
      capture_payloads: true,
    });
    expect((await postDecision()).status).toBe(401);
    mode = 'ok';
    expect((await postDecision(request, client.body.key)).status).toBe(200);
    const clients = await api<ClientView[]>('/admin/api/clients');
    expect(clients.body[0].last_used_at).toBeTruthy();
    expect(JSON.stringify(clients.body)).not.toContain(client.body.key);
    const logs = await api<LogPage>('/admin/api/logs?limit=2');
    expect(logs.body.items).toHaveLength(2);
    expect(logs.body.items[0].request.input).toBe('classify');
    expect(logs.body.next_before).toBeTruthy();
    const s = await api<StatsView>('/admin/api/stats?window=1h');
    expect(s.body.timeseries).toHaveLength(24);
    expect(s.body.requests).toBeGreaterThan(0);
    expect(s.body.errors).toBeGreaterThan(0);
    const buckets = s.body.timeseries as StatsBucketView[];
    expect(
      buckets.every((b) => (b.requests > 0 ? typeof b.p95_ms === 'number' : b.p95_ms === null)),
    ).toBe(true);
    expect(buckets.every((b) => Number.isInteger(b.fallbacks))).toBe(true);
    expect(buckets.every((b) => Number.isInteger(b.fallbacks_answered))).toBe(true);
    // Every request in this run is inside the hour, so the window's counts are the logged ones.
    const used = await api<LogPage>('/admin/api/logs?fallback=used&limit=1000');
    expect(used.body.next_before).toBeNull();
    expect(s.body.fallbacks).toBeGreaterThan(0);
    expect(s.body.fallbacks).toBe(used.body.items.length);
    expect(buckets.reduce((sum, b) => sum + b.fallbacks, 0)).toBe(s.body.fallbacks);
    const answered = await api<LogPage>('/admin/api/logs?fallback=used&status=ok&limit=1000');
    expect(answered.body.next_before).toBeNull();
    expect(s.body.fallbacks_answered).toBeGreaterThan(0);
    expect(s.body.fallbacks_answered).toBe(answered.body.items.length);
    expect(s.body.fallbacks_answered).toBeLessThanOrEqual(s.body.fallbacks);
    expect(buckets.reduce((sum, b) => sum + b.fallbacks_answered, 0)).toBe(
      s.body.fallbacks_answered,
    );
    expect(buckets.every((b) => b.fallbacks_answered <= b.fallbacks)).toBe(true);
    await api('/admin/api/settings', 'PATCH', {
      require_client_keys: false,
      capture_payloads: false,
    });
  });
  test('route delete conflicts and console SPA fallback', async () => {
    expect((await api(`/admin/api/providers/${providerId}`, 'DELETE')).status).toBe(409);
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toContain('not built');
    mkdirSync(consoleDir);
    writeFileSync(join(consoleDir, 'index.html'), '<html>console app</html>');
    writeFileSync(join(consoleDir, 'site.js'), 'test script');
    expect(await (await fetch(`http://127.0.0.1:${server.port}/settings`)).text()).toContain(
      'console app',
    );
    expect(await (await fetch(`http://127.0.0.1:${server.port}/site.js`)).text()).toBe(
      'test script',
    );
    expect((await api(`/admin/api/routes/${routeId}`, 'DELETE')).status).toBe(200);
  });
});
