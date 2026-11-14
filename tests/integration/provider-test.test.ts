import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type { Provider } from '../../src/modules/gateway/libs/management/schemas/types';

// The provider test through the real daemon: the known-answer check, the model it picks and why, and what it records.
// Every upstream is a fake behind the injected fetch, so nothing reaches the network. The SystemOne fakes (the vendor,
// a bare server and OpenRouter) answer a choice with its first option, which is billing, unless the model is
// wrong/model, which answers technical. The OpenAI-compatible fake answers billing in OpenAI's shape.
const dir = mkdtempSync(join(tmpdir(), 'gateway-provider-test-'));
const ADMIN = 'provider-test-admin-token';
const adminHeaders = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
const INPUT = 'I was charged twice for my March invoice. Please refund the second charge.';
const CATALOG = {
  data: [
    { id: 'morph/reflex', pricing: { prompt: '-1' } },
    { id: 'zeta/cheap', pricing: { prompt: '0.00000002' } },
    { id: 'alpha/cheap', pricing: { prompt: '0.00000002' } },
    { id: 'big/model', pricing: { prompt: '0.0000009' } },
  ],
};

type Seen = { url: URL; body: Record<string, unknown> | null };
const seen: Seen[] = [];
let gateway: ReturnType<typeof createGateway>;
let server: ReturnType<typeof Bun.serve>;
const ids: Record<string, string> = {};

// A SystemOne answer to the check's one question: the first option, or the second for wrong/model.
function systemOneAnswer(model: unknown) {
  const wrong = model === 'wrong/model';
  const probabilities = wrong ? { o0: 0.3, o1: 0.62, o2: 0.08 } : { o0: 0.9, o1: 0.06, o2: 0.04 };
  return Response.json({
    answers: { q0: { choice: wrong ? 'o1' : 'o0', probabilities } },
    usage: { input_tokens: 40, output_tokens: 1 },
  });
}

function openAiAnswer() {
  return Response.json({
    answers: [
      {
        name: 'department',
        type: 'choice',
        choice: 'billing',
        probabilities: [
          { value: 'billing', probability: 0.9 },
          { value: 'technical', probability: 0.06 },
          { value: 'other', probability: 0.04 },
        ],
      },
    ],
    usage: { input_tokens: 40, output_tokens: 0, total_tokens: 40 },
  });
}

function fake(url: URL, body: Record<string, unknown> | null): Response {
  if (url.pathname.endsWith('/models')) {
    if (url.hostname === 'openrouter.ai') return Response.json(CATALOG);
    if (url.hostname === 'compat.test')
      return Response.json({ data: [{ id: 'local-7b' }, { id: 'local-70b' }] });
    return Response.json({ error: 'no listing' }, { status: 404 });
  }
  if (url.hostname === 'compat.test') return openAiAnswer();
  return systemOneAnswer(body?.model);
}

const http = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const body =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  seen.push({ url, body });
  return Promise.resolve(fake(url, body));
}) as typeof fetch;

async function api<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: adminHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as T };
}

const runTest = (id: string, body: Record<string, unknown> = {}) =>
  api(`/admin/api/providers/${id}/test`, 'POST', body);

async function read(id: string): Promise<Provider & { test_model: string | null }> {
  const all = (await api<(Provider & { test_model: string | null })[]>('/admin/api/providers'))
    .body;
  return all.find((p) => p.id === id)!;
}

function provider(name: string, kind: string, base: string, path: string, extra = {}) {
  return {
    name,
    kind,
    base_url: base,
    path,
    wire: kind === 'openai-compatible' ? 'openai' : 'map',
    enabled: true,
    timeout_ms: 5000,
    limits: { max_questions: 10, max_choices: 10 },
    extra_body: {},
    key: { source: 'none' },
    ...extra,
  };
}

async function create(body: Record<string, unknown>): Promise<string> {
  const r = await api('/admin/api/providers', 'POST', body);
  expect(r.status).toBe(200);
  return String(r.body.id);
}

beforeAll(async () => {
  gateway = createGateway({
    env: { ADMIN_TOKEN: ADMIN, DATA_DIR: join(dir, 'data'), OPENROUTER_API_KEY: 'or-key' },
    http,
  });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });
  const seeded = (await api<Provider[]>('/admin/api/providers')).body;
  ids.openrouter = seeded.find((p) => p.name === 'openrouter')!.id;
  ids.vendor = await create(
    provider('vendor', 'systemone', 'https://vendor.test', '/v1/systemone', {
      model_hints: [{ id: 'hint-a' }, { id: 'hint-b' }],
      test_model: 'vendor-pick',
    }),
  );
  ids.router = await create(
    provider('router', 'openrouter', 'https://openrouter.ai', '/api/alpha/decisions', {
      key: { source: 'env', env_var: 'OPENROUTER_API_KEY' },
    }),
  );
  ids.compat = await create(
    provider('compat', 'openai-compatible', 'http://compat.test', '/v1/decisions'),
  );
  ids.bare = await create(provider('bare', 'systemone', 'https://bare.test', '/v1/systemone'));
});

afterAll(async () => {
  await server?.stop(true);
  gateway?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a provider test model', () => {
  test('is saved on create, read back, changed and cleared, and anything else is refused', async () => {
    expect((await read(ids.vendor)).test_model).toBe('vendor-pick');
    expect((await read(ids.compat)).test_model).toBeNull();
    const refused = await api<{ error: { message: string } }>('/admin/api/providers', 'POST', {
      ...provider('bad', 'systemone', 'https://bad.test', '/v1/systemone'),
      test_model: '',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('test_model');
    const patched = await api(`/admin/api/providers/${ids.bare}`, 'PATCH', { test_model: 'x' });
    expect(patched.body.test_model).toBe('x');
    const cleared = await api(`/admin/api/providers/${ids.bare}`, 'PATCH', { test_model: null });
    expect(cleared.body.test_model).toBeNull();
  });
});

describe('the provider test', () => {
  test("sends the known-answer check to the provider's test model, and says it matched", async () => {
    const r = await runTest(ids.vendor);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      model: 'vendor-pick',
      model_reason: 'provider_default',
      model_route: null,
      expected: 'billing',
      answer: 'billing',
      probability: 0.9,
      matched: true,
      response: { model: 'vendor::vendor-pick', gateway: { provider: 'vendor' } },
      trace: { attempts: [{ provider: 'vendor', model: 'vendor-pick', ok: true }] },
    });
    const sent = seen[seen.length - 1];
    expect(sent.url.href).toBe('https://vendor.test/v1/systemone');
    expect(sent.body).toEqual({
      state: INPUT,
      questions: {
        q0: {
          type: 'choice',
          instructions: 'Which team should handle this ticket?',
          criteria: {
            o0: 'Charges, invoices and refunds.',
            o1: 'Bugs, errors and outages.',
            o2: 'Anything else.',
          },
        },
      },
      model: 'vendor-pick',
    });
  });

  test('reads no model listing when the test model is known', () => {
    expect(
      seen.some((s) => s.url.hostname === 'vendor.test' && s.url.pathname.endsWith('/models')),
    ).toBe(false);
  });

  test('without a test model it uses the first hint', async () => {
    await api(`/admin/api/providers/${ids.vendor}`, 'PATCH', { test_model: null });
    expect((await runTest(ids.vendor)).body).toMatchObject({
      model: 'hint-a',
      model_reason: 'hint',
      matched: true,
    });
  });

  test('a model the caller asks for wins; another answer is reported, unmatched', async () => {
    expect((await runTest(ids.vendor, { model: 'wrong/model' })).body).toMatchObject({
      ok: true,
      model: 'wrong/model',
      model_reason: 'requested',
      model_route: null,
      answer: 'technical',
      probability: 0.62,
      matched: false,
    });
  });

  test('last_test keeps why the model was tested and whether it matched', async () => {
    expect((await read(ids.vendor)).last_test).toMatchObject({
      ok: true,
      model: 'wrong/model',
      model_reason: 'requested',
      matched: false,
      error: null,
    });
  });

  test('a model a route sends the provider comes before its own settings', async () => {
    const made = await api('/admin/api/routes', 'POST', {
      alias: 'vendor-route',
      description: 'vendor',
      enabled: true,
      targets: [{ provider_id: ids.vendor, model: 'routed-model' }],
    });
    expect(made.status).toBe(200);
    expect((await runTest(ids.vendor)).body).toMatchObject({
      model: 'routed-model',
      model_reason: 'used_by_route',
      model_route: 'vendor-route',
    });
  });

  test('the seeded OpenRouter is tested with the model the seeded luna sends it', async () => {
    expect((await runTest(ids.openrouter)).body).toMatchObject({
      ok: true,
      model: 'openai/gpt-6-luna-decisions',
      model_reason: 'used_by_route',
      model_route: 'luna',
      matched: true,
    });
  });

  test('with nothing else to go on, the cheapest priced catalog model, ties broken by id', async () => {
    expect((await runTest(ids.router)).body).toMatchObject({
      ok: true,
      model: 'alpha/cheap',
      model_reason: 'cheapest',
      matched: true,
    });
    expect((await read(ids.router)).last_test).toMatchObject({
      model: 'alpha/cheap',
      model_reason: 'cheapest',
      matched: true,
    });
  });

  test('then the first listed model, when none is priced', async () => {
    expect((await runTest(ids.compat)).body).toMatchObject({
      ok: true,
      model: 'local-7b',
      model_reason: 'first_listed',
      answer: 'billing',
      matched: true,
    });
  });

  test('then the server-configured placeholder', async () => {
    expect((await runTest(ids.bare)).body).toMatchObject({
      ok: true,
      model: 'server-configured',
      model_reason: 'server_configured',
      matched: true,
    });
  });

  test('a test refused before it runs records nothing', async () => {
    const before = (await read(ids.bare)).last_test;
    expect((await runTest(ids.bare, { model: '' })).status).toBe(400);
    expect((await read(ids.bare)).last_test).toEqual(before);
  });
});
