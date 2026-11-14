import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';

// HTTP behaviour of the documented contract decisions. Each test uses the real
// daemon on a random port with a fake upstream that either fails with 500 or refuses every question.
const dir = mkdtempSync(join(tmpdir(), 'gateway-contract-'));
const ADMIN = 'contract-admin-token';
const adminHeaders = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
let gateway: ReturnType<typeof createGateway>;
let server: ReturnType<typeof Bun.serve>;
let upstream: ReturnType<typeof Bun.serve>;
let upstreamMode: 'fail' | 'refuse' = 'fail';

type Answered = { status: number; body: Record<string, unknown> };

async function fakeUpstream(req: Request): Promise<Response> {
  await req.json();
  if (upstreamMode === 'refuse')
    return Response.json({
      answers: [{ question: 'p', type: 'predicate', refusal: 'cannot judge' }],
    });
  return Response.json({ error: 'boom' }, { status: 500 });
}

async function admin(path: string, method = 'GET', body?: unknown): Promise<Answered> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: adminHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function decide(model: string, authorization?: string): Promise<Answered> {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/decisions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
    },
    body: JSON.stringify({
      model,
      input: 'contract check',
      questions: [{ name: 'p', type: 'predicate', instructions: 'Is this a test?' }],
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let fakeId: string, disabledId: string;
const routeIds: Record<string, string> = {};

beforeAll(async () => {
  upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: fakeUpstream });
  gateway = createGateway({
    env: { ADMIN_TOKEN: ADMIN, DATA_DIR: join(dir, 'data') },
  });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });

  const provider = (name: string, enabled: boolean) => ({
    name,
    kind: 'openai-compatible',
    base_url: `http://127.0.0.1:${upstream.port}`,
    path: '/decisions',
    wire: 'openai',
    enabled,
    timeout_ms: 2000,
    limits: { max_questions: 10, max_choices: 10 },
    extra_body: {},
    key: { source: 'none' },
  });

  fakeId = String((await admin('/admin/api/providers', 'POST', provider('fake', true))).body.id);
  disabledId = String(
    (await admin('/admin/api/providers', 'POST', provider('disabled-one', false))).body.id,
  );
  const providers = (await admin('/admin/api/providers')).body as unknown as {
    id: string;
    name: string;
  }[];
  const mock = providers.find((p) => p.name === 'mock')!;

  const createRoute = async (alias: string, targets: { provider_id: string; model: string }[]) => {
    const created = await admin('/admin/api/routes', 'POST', {
      alias,
      description: alias,
      enabled: true,
      targets,
    });
    routeIds[alias] = String(created.body.id);
  };

  await createRoute('failing', [{ provider_id: fakeId, model: 'm' }]);
  await createRoute('refusing', [{ provider_id: fakeId, model: 'm' }]);
  await createRoute('fallback-to-mock', [
    { provider_id: fakeId, model: 'm' },
    { provider_id: mock.id, model: 'mock-1' },
  ]);
  await createRoute('skipping', [
    { provider_id: disabledId, model: 'm' },
    { provider_id: mock.id, model: 'mock-1' },
  ]);
  await createRoute('shared-a', [{ provider_id: disabledId, model: 'm' }]);
  await createRoute('shared-b', [{ provider_id: disabledId, model: 'm' }]);
});

afterAll(async () => {
  await server?.stop(true);
  await upstream?.stop(true);
  gateway?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('contract decisions over HTTP', () => {
  test('stats for an empty window report null latency, not zero', async () => {
    const stats = await admin('/admin/api/stats?window=1h');
    expect(stats.status).toBe(200);
    expect(stats.body.requests).toBe(0);
    expect(stats.body.p50_ms).toBeNull();
    expect(stats.body.p95_ms).toBeNull();
    expect(stats.body.fallbacks).toBe(0);
    expect(stats.body.fallbacks_answered).toBe(0);
    const buckets = stats.body.timeseries as {
      p50_ms: number | null;
      p95_ms: number | null;
      fallbacks: number;
      fallbacks_answered: number;
    }[];
    expect(buckets).toHaveLength(24);
    expect(buckets.every((bucket) => bucket.p50_ms === null)).toBe(true);
    expect(
      buckets.every(
        (bucket) =>
          bucket.p95_ms === null && bucket.fallbacks === 0 && bucket.fallbacks_answered === 0,
      ),
    ).toBe(true);
  });

  test('health reports a provider that needs no key as ready, and an unset env key as missing', async () => {
    const health = await admin('/admin/api/health');
    const providers = health.body.providers as { name: string; key_present: boolean }[];
    expect(providers.find((p) => p.name === 'mock')?.key_present).toBe(true);
    expect(providers.find((p) => p.name === 'openrouter')?.key_present).toBe(false);
  });

  test('a response with no answer confidence reports confidence_method none', async () => {
    const mock = await decide('default');
    expect(mock.status).toBe(200);
    expect((mock.body.gateway as { confidence_method: string }).confidence_method).toBe('none');
    upstreamMode = 'refuse';
    const refused = await decide('refusing');
    upstreamMode = 'fail';
    expect(refused.status).toBe(200);
    expect((refused.body.answers as { refusal?: string }[])[0]?.refusal).toBe('cannot judge');
    expect((refused.body.gateway as { confidence_method: string }).confidence_method).toBe('none');
  });

  test('a disabled provider in a route is skipped with a provider disabled attempt', async () => {
    const skipped = await decide('skipping');
    expect(skipped.status).toBe(200);
    const gateway = skipped.body.gateway as {
      provider: string;
      attempts: { provider: string; ok: boolean; error?: string }[];
    };
    expect(gateway.provider).toBe('mock');
    expect(gateway.attempts[0]).toMatchObject({
      provider: 'disabled-one',
      ok: false,
      error: 'provider disabled',
    });
    expect(gateway.attempts).toHaveLength(2);
  });

  test('the logs fallback parameter filters on fallback_used on the server', async () => {
    expect((await decide('default')).status).toBe(200);
    expect((await decide('fallback-to-mock')).status).toBe(200);
    const used = await admin('/admin/api/logs?fallback=used&limit=200');
    const none = await admin('/admin/api/logs?fallback=none&limit=200');
    const usedItems = used.body.items as { fallback_used: boolean; route: string }[];
    const noneItems = none.body.items as { fallback_used: boolean }[];
    expect(usedItems.length).toBeGreaterThan(0);
    expect(usedItems.every((item) => item.fallback_used === true)).toBe(true);
    expect(usedItems.some((item) => item.route === 'fallback-to-mock')).toBe(true);
    expect(noneItems.every((item) => item.fallback_used === false)).toBe(true);
    expect((await admin('/admin/api/logs?fallback=maybe')).status).toBe(400);
  });

  test('deleting a provider that a route targets is a 409 that names the routes', async () => {
    const refused = await admin(`/admin/api/providers/${disabledId}`, 'DELETE');
    expect(refused.status).toBe(409);
    const error = refused.body.error as {
      type: string;
      code: string;
      routes: { id: string; alias: string }[];
    };
    expect(error.type).toBe('invalid_request_error');
    expect(error.code).toBe('provider_in_use');
    expect(error.routes).toContainEqual({ id: routeIds['skipping'], alias: 'skipping' });
    expect(error.routes).toContainEqual({ id: routeIds['shared-a'], alias: 'shared-a' });
    expect(error.routes).toContainEqual({ id: routeIds['shared-b'], alias: 'shared-b' });
    for (const alias of ['skipping', 'shared-a', 'shared-b']) {
      const removed = await admin(`/admin/api/routes/${routeIds[alias]}`, 'DELETE');
      expect(removed.body).toEqual({ ok: true });
    }
    expect((await admin(`/admin/api/providers/${disabledId}`, 'DELETE')).body).toEqual({
      ok: true,
    });
  });

  test('the playground returns HTTP 200 with a null response and an error when the decision fails', async () => {
    const run = await fetch(`http://127.0.0.1:${server.port}/admin/api/playground`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        request: {
          model: 'failing',
          input: 'contract check',
          questions: [{ name: 'p', type: 'predicate', instructions: 'Is this a test?' }],
        },
      }),
    });
    const body = (await run.json()) as {
      response: unknown;
      error: { type: string; message: string };
      trace: { attempts: { ok: boolean }[] };
    };
    expect(run.status).toBe(200);
    expect(body.response).toBeNull();
    expect(body.error.type).toBe('upstream_error');
    expect(body.trace.attempts).toHaveLength(1);
    expect(body.trace.attempts[0]?.ok).toBe(false);
  });

  test('playground authentication and validation still answer 401 and 400', async () => {
    const unauthenticated = await fetch(`http://127.0.0.1:${server.port}/admin/api/playground`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: {} }),
    });
    expect(unauthenticated.status).toBe(401);
    expect((await admin('/admin/api/playground', 'POST', { request: {} })).status).toBe(400);
  });

  test('/v1/models requires a client key when require_client_keys is on, like /v1/decisions', async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/v1/models`)).status).toBe(200);
    await admin('/admin/api/settings', 'PATCH', { require_client_keys: true });
    try {
      const anonymous = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      expect(anonymous.status).toBe(401);
      expect(((await anonymous.json()) as { error: { type: string } }).error.type).toBe(
        'authentication_error',
      );
      const client = await admin('/admin/api/clients', 'POST', { name: 'contract' });
      const keyed = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
        headers: { authorization: `Bearer ${String(client.body.key)}` },
      });
      expect(keyed.status).toBe(200);
      const list = (await keyed.json()) as { object: string; data: { id: string }[] };
      expect(list.object).toBe('list');
      expect(list.data.map((model) => model.id)).toContain('default');
    } finally {
      await admin('/admin/api/settings', 'PATCH', { require_client_keys: false });
    }
  });

  test('routes answer with a list, a route, and { ok: true } on delete', async () => {
    const list = await fetch(`http://127.0.0.1:${server.port}/admin/api/routes`, {
      headers: adminHeaders,
    });
    expect(Array.isArray(await list.json())).toBe(true);
    const created = await admin('/admin/api/routes', 'POST', {
      alias: 'shape-check',
      description: 'shape',
      enabled: true,
      targets: [{ provider_id: fakeId, model: 'm' }],
    });
    expect(created.body).toMatchObject({ alias: 'shape-check' });
    expect(String(created.body.id).startsWith('rte_')).toBe(true);
    expect(
      (await admin(`/admin/api/routes/${String(created.body.id)}`, 'PATCH', { enabled: false }))
        .body,
    ).toMatchObject({ alias: 'shape-check', enabled: false });
    expect((await admin(`/admin/api/routes/${String(created.body.id)}`, 'DELETE')).body).toEqual({
      ok: true,
    });
  });
});
