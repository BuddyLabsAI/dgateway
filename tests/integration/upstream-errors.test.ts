import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type {
  DecisionResponse,
  ErrorBody,
} from '../../src/modules/gateway/libs/decisions/schemas/types';
import type { Log } from '../../src/modules/gateway/libs/management/schemas/types';

// OpenRouter's HTTP errors behind the real daemon, as a fake through the injected fetch, so nothing reaches the network.
// The 404 is the one OpenRouter gave live: no endpoint may serve the model under the account's privacy settings. Its
// metadata carries a user_id, which must never show. The 400 is zod's issues sent as the message string. The tests
// check the text the attempt, the response, the log, the trace and the provider test carry, and that the status alone
// still decides whether the route moves on.
const dir = mkdtempSync(join(tmpdir(), 'gateway-upstream-error-'));
const ADMIN = 'upstream-error-admin-token';
const OPENROUTER_KEY = 'upstream-error-openrouter-key';
const adminHeaders = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
const NO_ENDPOINTS = 'perplexity/pplx-decider-flash-v1.2';
const BAD_CRITERIA = 'typesafe/jev-1.13';
const USER_ID = 'user_2Zq9xYzAbc';
const MESSAGE =
  '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons): ZDR violation (account settings): 1 endpoint excluded; configurable at https://openrouter.ai/settings/privacy';
const NOT_FOUND_BODY = {
  error: {
    message: MESSAGE.replace('reasons): ZDR', 'reasons):\nZDR'),
    code: 404,
    metadata: {
      user_id: USER_ID,
      input_endpoint_count: 1,
      ineligibility_reasons: [
        {
          reason: 'zdr-violation-by-account',
          endpoint_count: 1,
          configure_url: 'https://openrouter.ai/settings/privacy',
        },
      ],
    },
  },
};
const ISSUES = [
  {
    expected: 'array',
    code: 'invalid_type',
    path: ['questions', 'q0', 'criteria'],
    message: 'Invalid input: expected array, received object',
  },
];
const BAD_CRITERIA_BODY = { error: { message: JSON.stringify(ISSUES), code: 400 } };
const question = {
  input: 'I was charged twice for my subscription.',
  questions: [{ name: 'urgent', type: 'predicate', instructions: 'Is it urgent?' }],
};
const text404 = `upstream HTTP 404: ${MESSAGE}`;

let gateway: ReturnType<typeof createGateway>;
let server: ReturnType<typeof Bun.serve>;
const ids: Record<string, string> = {};

// OpenRouter's decision answers the two models above as it did live, and refuses any other model.
function fakeOpenRouter(headers: Headers, body: { model?: string }): Response {
  if (headers.get('authorization') !== `Bearer ${OPENROUTER_KEY}`)
    return Response.json(
      { error: { message: 'No auth credentials found', code: 401 } },
      { status: 401 },
    );
  if (body.model === NO_ENDPOINTS) return Response.json(NOT_FOUND_BODY, { status: 404 });
  if (body.model === BAD_CRITERIA) return Response.json(BAD_CRITERIA_BODY, { status: 400 });
  return Response.json(
    { error: { message: 'this fake knows two models', code: 400 } },
    { status: 400 },
  );
}

const http = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'openrouter.ai' && url.pathname === '/api/alpha/decisions') {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : {};
    return Promise.resolve(fakeOpenRouter(new Headers(init?.headers), body));
  }
  return Promise.resolve(new Response('not served', { status: 599 }));
}) as typeof fetch;

async function api<T = unknown>(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: adminHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as T };
}

async function decide(model: string) {
  const r = await fetch(`http://127.0.0.1:${server.port}/v1/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, ...question }),
  });
  return { status: r.status, body: (await r.json()) as DecisionResponse & { error?: ErrorBody } };
}

beforeAll(async () => {
  gateway = createGateway({
    env: {
      ADMIN_TOKEN: ADMIN,
      DATA_DIR: join(dir, 'data'),
      OPENROUTER_API_KEY: OPENROUTER_KEY,
    },
    http,
  });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });
  const providers = (await api<{ id: string; name: string }[]>('/admin/api/providers')).body;
  ids.openrouter = providers.find((p) => p.name === 'openrouter')!.id;
  ids.mock = providers.find((p) => p.name === 'mock')!.id;

  const route = (alias: string, model: string) =>
    api('/admin/api/routes', 'POST', {
      alias,
      description: `${alias}: OpenRouter, then the mock`,
      enabled: true,
      targets: [
        { provider_id: ids.openrouter, model },
        { provider_id: ids.mock, model: 'mock-1' },
      ],
    });

  expect((await route('outage', NO_ENDPOINTS)).status).toBe(200);
  expect((await route('refused', BAD_CRITERIA)).status).toBe(200);
});

afterAll(async () => {
  await server?.stop(true);
  gateway?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('an upstream HTTP error names its message', () => {
  test('a 404 names its message in the failed attempt, and the next target still answers', async () => {
    const r = await decide('outage');
    expect(r.status).toBe(200);
    expect(r.body.gateway.provider).toBe('mock');
    expect(r.body.gateway.attempts).toMatchObject([
      { provider: 'openrouter', ok: false, error: text404 },
      { provider: 'mock', ok: true },
    ]);
    expect(JSON.stringify(r.body)).not.toContain(USER_ID);
  });

  test('the log carries the same text, and the playground trace hides the user_id the body carried', async () => {
    const [logged] = (await api<{ items: Log[] }>('/admin/api/logs?limit=1')).body.items;
    expect(logged?.attempts[0]?.error).toBe(text404);
    expect(logged?.fallback_used).toBe(true);
    const play = await api<{
      response: DecisionResponse | null;
      error?: ErrorBody;
      trace: { attempts: { error?: string }[]; upstream_response: unknown };
    }>('/admin/api/playground', 'POST', {
      request: { model: `openrouter::${NO_ENDPOINTS}`, ...question },
    });
    expect(play.body.response).toBeNull();
    expect(play.body.error?.message).toBe(text404);
    expect(play.body.trace.attempts[0]?.error).toBe(text404);
    expect(JSON.stringify(play.body)).not.toContain(USER_ID);
  });

  test('a provider test records the same text as its last_test error', async () => {
    const tested = await api<Record<string, unknown>>(
      `/admin/api/providers/${ids.openrouter}/test`,
      'POST',
      { model: NO_ENDPOINTS },
    );
    expect(tested.body).toMatchObject({
      ok: false,
      model: NO_ENDPOINTS,
      model_reason: 'requested',
      error: text404,
    });
    const providers = (
      await api<{ id: string; last_test: { ok: boolean; error: string | null } | null }[]>(
        '/admin/api/providers',
      )
    ).body;
    expect(providers.find((p) => p.id === ids.openrouter)?.last_test).toMatchObject({
      ok: false,
      error: text404,
    });
  });

  test('a 400 with zod issues names them, and still stops the route before the next target', async () => {
    const r = await decide('refused');
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({
      type: 'upstream_error',
      message:
        'upstream HTTP 400: questions.q0.criteria: Invalid input: expected array, received object',
    });
    const [logged] = (await api<{ items: Log[] }>('/admin/api/logs?limit=1')).body.items;
    expect(logged?.attempts).toHaveLength(1);
    expect(logged?.fallback_used).toBe(false);
  });
});
