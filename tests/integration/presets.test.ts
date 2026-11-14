import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type { DecisionResponse } from '../../src/modules/gateway/libs/decisions/schemas/types';
import type { Log } from '../../src/modules/gateway/libs/management/schemas/types';

// Hosted SystemOne vendors through the real daemon. The fake vendor at systemone.vendor.test answers only when the
// body names a model it serves and the key arrives raw in x-api-key; pass.vendor.test wants it in x-vendor-pass and
// echoes a field of that name. localhost:9 is a local SystemOne server. Every call goes through the injected fetch,
// so nothing reaches the network.
const dir = mkdtempSync(join(tmpdir(), 'gateway-presets-'));
const ADMIN = 'presets-admin-token';
const KEY = 'vendor-secret-key-0042';
const adminHeaders = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
const HINTS = [
  { id: 'vendor-big', price_per_m_input: 0.042, context: 262144, description: 'The big one' },
  { id: 'vendor-small' },
];
const KEY_HEADER: Record<string, string> = {
  'systemone.vendor.test': 'x-api-key',
  'pass.vendor.test': 'x-vendor-pass',
};

type Seen = { url: URL; headers: Headers; body: Record<string, unknown> | null };
const seen: Seen[] = [];
let listing: 'ok' | 'fail' | 'hang' = 'ok';
let gateway: ReturnType<typeof createGateway>;
let server: ReturnType<typeof Bun.serve>;
const ids: Record<string, string> = {};

// A listing that never answers, unless the caller gives up on it.
function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

function vendorListing(signal: AbortSignal | null | undefined): Promise<Response> | Response {
  if (listing === 'fail') return Response.json({ error: 'no listing' }, { status: 500 });
  if (listing === 'hang') return hang(signal);
  return Response.json({
    data: [{ id: 'vendor-big', pricing: { prompt: '0.000009' } }, { id: 'vendor-new' }],
  });
}

// The vendor's answer to each map-wire question: a choice's first option, most of the probability on it, or a noul's
// probability.
function vendorAnswers(questions: unknown): Record<string, unknown> {
  const entries = Object.entries(
    (questions ?? {}) as Record<string, { type?: string; criteria?: Record<string, string> }>,
  );
  return Object.fromEntries(
    entries.map(([id, q]): [string, unknown] => {
      if (q.type !== 'choice') return [id, { probability: 0.8 }];
      const options = Object.keys(q.criteria ?? {});
      const rest = 0.1 / (options.length - 1);
      const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.9 : rest]));
      return [id, { choice: options[0], probabilities }];
    }),
  );
}

function vendorDecision(url: URL, headers: Headers, body: Record<string, unknown>): Response {
  if (headers.get(KEY_HEADER[url.hostname] ?? 'x-api-key') !== KEY || headers.has('authorization'))
    return Response.json({ error: 'missing or wrong key' }, { status: 401 });
  if (typeof body.model !== 'string')
    return Response.json({ error: 'model is required' }, { status: 400 });
  if (body.model === 'vendor-garbled')
    return new Response('proxy error, x-vendor-pass: leaked-token-77 was refused');
  if (body.model !== 'vendor-big' && body.model !== 'vendor-small')
    return Response.json({ error: 'unknown model' }, { status: 404 });
  return Response.json({
    answers: vendorAnswers(body.questions),
    usage: { prompt_tokens: 1000, total_tokens: 1000 },
    echo: { 'x-vendor-pass': 'derived-session-token', note: `called with ${KEY}` },
  });
}

const http = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const headers = new Headers(init?.headers);
  const body =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  seen.push({ url, headers, body });
  if (url.hostname === 'localhost')
    return Response.json({ answers: { q0: { probability: 0.6 } }, usage: null });
  if (!(url.hostname in KEY_HEADER)) return new Response('not served', { status: 599 });
  if (url.pathname === '/v1/models') return vendorListing(init?.signal);
  return vendorDecision(url, headers, body ?? {});
}) as typeof fetch;

async function api<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: adminHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text) as T, text };
}

async function decide(model: string) {
  const r = await fetch(`http://127.0.0.1:${server.port}/v1/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: 'classify this',
      questions: [{ name: 'p', type: 'predicate', instructions: 'Is it?' }],
    }),
  });
  return {
    status: r.status,
    body: (await r.json()) as DecisionResponse & { error?: { message: string } },
  };
}

function provider(name: string, host: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    kind: 'systemone',
    base_url: `https://${host}`,
    path: '/v1/systemone',
    wire: 'map',
    enabled: true,
    timeout_ms: 5000,
    limits: { max_questions: 10, max_choices: 10 },
    extra_body: {},
    key: { source: 'stored', value: KEY },
    ...extra,
  };
}

async function route(alias: string, providerId: string, model: string) {
  const r = await api('/admin/api/routes', 'POST', {
    alias,
    description: alias,
    enabled: true,
    targets: [{ provider_id: providerId, model }],
  });
  expect(r.status).toBe(200);
}

const lastSeen = () => seen[seen.length - 1];

beforeAll(async () => {
  gateway = createGateway({
    env: { ADMIN_TOKEN: ADMIN, GATEWAY_SECRET: 'presets-secret', DATA_DIR: join(dir, 'data') },
    http,
  });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });
  const created = await api('/admin/api/providers', 'POST', {
    ...provider('vendor', 'systemone.vendor.test'),
    auth_header: 'X-API-Key',
    model_hints: HINTS,
  });
  expect(created.status).toBe(200);
  ids.vendor = String(created.body.id);
  await route('vendor-big', ids.vendor, 'vendor-big');
  await route('vendor-small', ids.vendor, 'vendor-small');
});

afterAll(async () => {
  await server?.stop(true);
  gateway?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a hosted SystemOne vendor', () => {
  test('is created with send_model on by default, its header in lowercase, and its hints', async () => {
    const read = (await api<Record<string, unknown>[]>('/admin/api/providers')).body.find(
      (p) => p.id === ids.vendor,
    )!;
    expect(read).toMatchObject({ send_model: true, auth_header: 'x-api-key', model_hints: HINTS });
    expect(JSON.stringify(read)).not.toContain(KEY);
  });

  test('is sent the model and its raw key in x-api-key, and its hint prices the decision', async () => {
    const r = await decide('vendor-big');
    expect(r.status).toBe(200);
    const call = lastSeen();
    expect(call.url.pathname).toBe('/v1/systemone');
    expect(call.body).toMatchObject({ model: 'vendor-big', state: 'classify this' });
    expect(call.headers.get('x-api-key')).toBe(KEY);
    expect(call.headers.has('authorization')).toBe(false);
    // 1,000 upstream tokens at the hint's $0.042 per million input tokens.
    expect(r.body.gateway).toMatchObject({
      cost_usd: 0.000042,
      cost_basis: 'upstream_tokens',
      tokens: 1000,
    });
  });

  test('is unpriced for a model whose hint has no price', async () => {
    const r = await decide('vendor-small');
    expect(r.status).toBe(200);
    expect(r.body.gateway).toMatchObject({ cost_usd: null, cost_basis: 'unpriced', tokens: 1000 });
  });

  test('refuses the request when send_model is turned off, since it needs the model', async () => {
    expect(
      (await api(`/admin/api/providers/${ids.vendor}`, 'PATCH', { send_model: false })).status,
    ).toBe(200);
    try {
      const r = await decide('vendor-big');
      expect(r.status).toBe(502);
      expect(lastSeen().body).not.toHaveProperty('model');
      expect(r.body.error?.message).toBe('upstream HTTP 400');
    } finally {
      await api(`/admin/api/providers/${ids.vendor}`, 'PATCH', { send_model: true });
    }
  });

  test('the provider test uses the model the first route sends it, and records the result', async () => {
    const tested = await api<{ ok: boolean; model: string }>(
      `/admin/api/providers/${ids.vendor}/test`,
      'POST',
      {},
    );
    expect(tested.body).toMatchObject({
      ok: true,
      model: 'vendor-big',
      model_reason: 'used_by_route',
      model_route: 'vendor-big',
      expected: 'billing',
      answer: 'billing',
      probability: 0.9,
      matched: true,
    });
    expect(lastSeen().body).toMatchObject({
      model: 'vendor-big',
      state: 'I was charged twice for my March invoice. Please refund the second charge.',
    });
    const read = (await api<Record<string, unknown>[]>('/admin/api/providers')).body.find(
      (p) => p.id === ids.vendor,
    )!;
    expect(read.last_test).toMatchObject({
      ok: true,
      model: 'vendor-big',
      model_reason: 'used_by_route',
      matched: true,
      error: null,
    });
  });
});

describe('the models endpoint for a provider with hints', () => {
  const models = async () =>
    (
      await api<{
        models: {
          id: string;
          price_per_m_input?: number;
          default_price_per_m_input?: number;
          context?: number;
          description?: string;
        }[];
      }>(`/admin/api/providers/${ids.vendor}/models`)
    ).body.models;

  test('merges the hints with GET /v1/models: hints first, hints win on price, defaults from hints', async () => {
    listing = 'ok';
    expect(await models()).toEqual([
      {
        id: 'vendor-big',
        price_per_m_input: 0.042,
        default_price_per_m_input: 0.042,
        context: 262144,
        description: 'The big one',
      },
      { id: 'vendor-small' },
      { id: 'vendor-new' },
    ]);
    const call = lastSeen();
    expect(call.url.href).toBe('https://systemone.vendor.test/v1/models');
    expect(call.headers.get('x-api-key')).toBe(KEY);
  });

  test('answers with the hints alone when the listing fails, or before a slow one finishes', async () => {
    const hintsOnly = [
      {
        id: 'vendor-big',
        price_per_m_input: 0.042,
        default_price_per_m_input: 0.042,
        context: 262144,
        description: 'The big one',
      },
      { id: 'vendor-small' },
    ];
    try {
      listing = 'fail';
      expect(await models()).toEqual(hintsOnly);
      listing = 'hang';
      const started = Date.now();
      expect(await models()).toEqual(hintsOnly);
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      listing = 'ok';
    }
  });
});

describe('a local SystemOne server', () => {
  test('is unpriced and is sent no model unless it asks for one', async () => {
    const created = await api('/admin/api/providers', 'POST', {
      ...provider('ollama-box', 'unused'),
      base_url: 'http://localhost:9',
      key: { source: 'none' },
      model_hints: [{ id: 'd1' }],
    });
    expect(created.body).toMatchObject({ send_model: false, auth_header: 'authorization' });
    await route('local-d1', String(created.body.id), 'd1');
    const r = await decide('local-d1');
    expect(r.status).toBe(200);
    expect(lastSeen().body).not.toHaveProperty('model');
    expect(lastSeen().headers.has('authorization')).toBe(false);
    expect(r.body.gateway).toMatchObject({ cost_usd: null, cost_basis: 'unpriced' });
    await api(`/admin/api/providers/${String(created.body.id)}`, 'PATCH', { send_model: true });
    await decide('local-d1');
    expect(lastSeen().body).toMatchObject({ model: 'd1' });
  });
});

describe('redaction of a custom auth header', () => {
  test('the header field and the key stay out of traces and logs', async () => {
    const created = await api('/admin/api/providers', 'POST', {
      ...provider('pass-vendor', 'pass.vendor.test'),
      auth_header: 'x-vendor-pass',
    });
    expect(created.status).toBe(200);
    await route('pass-big', String(created.body.id), 'vendor-big');
    await route('pass-garbled', String(created.body.id), 'vendor-garbled');
    await api('/admin/api/settings', 'PATCH', { capture_payloads: true });
    try {
      const play = await api<{
        response: DecisionResponse | null;
        trace: { upstream_response: { echo: Record<string, string> } };
      }>('/admin/api/playground', 'POST', {
        request: {
          model: 'pass-big',
          input: 'classify this',
          questions: [{ name: 'p', type: 'predicate', instructions: 'Is it?' }],
        },
      });
      expect(lastSeen().headers.get('x-vendor-pass')).toBe(KEY);
      expect(play.body.response?.gateway.provider).toBe('pass-vendor');
      expect(play.body.trace.upstream_response.echo['x-vendor-pass']).toBe('[REDACTED]');
      expect(play.body.trace.upstream_response.echo.note).toBe('called with [REDACTED]');
      expect(play.text).not.toContain(KEY);
      const garbled = await decide('pass-garbled');
      expect(garbled.status).toBe(502);
      expect(JSON.stringify(garbled.body)).not.toContain('leaked-token-77');
      const garbledPlay = await api('/admin/api/playground', 'POST', {
        request: {
          model: 'pass-garbled',
          input: 'classify this',
          questions: [{ name: 'p', type: 'predicate', instructions: 'Is it?' }],
        },
      });
      expect(garbledPlay.text).toContain('x-vendor-pass=[REDACTED]');
      expect(garbledPlay.text).not.toContain('leaked-token-77');
      const logs = await api<{ items: Log[] }>('/admin/api/logs?limit=5');
      expect(logs.text).not.toContain(KEY);
      expect(logs.text).not.toContain('leaked-token-77');
      expect(logs.body.items[0]?.attempts[0]?.error).toContain('x-vendor-pass=[REDACTED]');
    } finally {
      await api('/admin/api/settings', 'PATCH', { capture_payloads: false });
    }
  });
});

describe('provider option validation', () => {
  test('a reserved or malformed header, bad hints, or a non-boolean send_model is a 400', async () => {
    for (const bad of [
      { auth_header: 'content-type' },
      { auth_header: 'Host' },
      { auth_header: 'x api key' },
      { send_model: 'yes' },
      { model_hints: [{ id: 'a' }, { id: 'a' }] },
      { model_hints: [{ id: 'a', price_per_m_input: -0.5 }] },
    ]) {
      const r = await api<{ error: { type: string } }>('/admin/api/providers', 'POST', {
        ...provider('refused', 'systemone.vendor.test'),
        ...bad,
      });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.type).toBe('invalid_request_error');
    }
  });
});
