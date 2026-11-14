import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';

test('output prices flow through route, response, logs and statistics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'output-pricing-'));
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      Response.json({
        choices: [
          {
            message: { content: 'Yes' },
            logprobs: { content: [{ top_logprobs: [{ token: 'Yes', logprob: 0 }] }] },
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
      }),
  });
  const gateway = createGateway({ env: { ADMIN_TOKEN: 'a', DATA_DIR: dir } });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });

  const api = async (path: string, body?: unknown, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        id: string;
        gateway: { cost_usd: number; cost_includes_output: boolean };
        items: { cost_includes_output: boolean }[];
        output_unpriced: number;
        by_route: { route: string; output_unpriced: number }[];
        by_provider: { provider: string; output_unpriced: number }[];
      },
    };
  };

  try {
    const provider = await api('/admin/api/providers', {
      name: 'out-test',
      kind: 'openai-compatible',
      wire: 'chat',
      enabled: true,
      base_url: `http://127.0.0.1:${upstream.port}`,
      timeout_ms: 5000,
      extra_body: {},
      key: { source: 'none' },
      model_hints: [{ id: 'm', price_per_m_input: 2, price_per_m_output: 3 }],
    });
    expect(provider.status).toBe(200);
    const route = await api('/admin/api/routes', {
      alias: 'out-test',
      description: '',
      enabled: true,
      targets: [{ provider_id: provider.body.id, model: 'm', price_per_m_output: 4 }],
    });
    expect(route.status).toBe(200);
    const read = (await api('/admin/api/routes', undefined, 'GET')).body as unknown as {
      id: string;
      targets: { price_per_m_output?: number | null }[];
    }[];
    expect(read.find((r) => r.id === route.body.id)?.targets[0]?.price_per_m_output).toBe(4);
    for (const bad of [-1, 'free']) {
      const refused = await api('/admin/api/routes', {
        alias: 'out-bad',
        description: '',
        enabled: true,
        targets: [{ provider_id: provider.body.id, model: 'm', price_per_m_output: bad }],
      });
      expect(refused.status).toBe(400);
      const hint = await api(
        `/admin/api/providers/${provider.body.id}`,
        { model_hints: [{ id: 'm', price_per_m_output: bad }] },
        'PATCH',
      );
      expect(hint.status).toBe(400);
    }
    // The old spelling is not a hint field.
    expect(
      (
        await api(
          `/admin/api/providers/${provider.body.id}`,
          { model_hints: [{ id: 'm', price_output: 3 }] },
          'PATCH',
        )
      ).status,
    ).toBe(400);
    const listed = await api(`/admin/api/providers/${provider.body.id}/models`, undefined, 'GET');
    expect((listed.body as unknown as { models: unknown[] }).models[0]).toMatchObject({
      id: 'm',
      price_per_m_output: 3,
      default_price_per_m_output: 3,
    });

    const decide = () =>
      api('/v1/decisions', {
        model: 'out-test',
        input: 'input',
        questions: [{ name: 'p', type: 'predicate', instructions: 'true?' }],
      });

    // 1000 input tokens at the hint's 2 and 100 output tokens at the step's 4, per million.
    expect((await decide()).body.gateway).toMatchObject({
      cost_usd: 0.0024,
      cost_includes_output: true,
    });
    await api(
      `/admin/api/routes/${route.body.id}`,
      { targets: [{ provider_id: provider.body.id, model: 'm' }] },
      'PATCH',
    );
    // Without a step price, the hint's output price of 3 applies.
    expect((await decide()).body.gateway).toMatchObject({
      cost_usd: 0.0023,
      cost_includes_output: true,
    });
    await api(
      `/admin/api/providers/${provider.body.id}`,
      { model_hints: [{ id: 'm', price_per_m_input: 2 }] },
      'PATCH',
    );
    await api(
      `/admin/api/routes/${route.body.id}`,
      { targets: [{ provider_id: provider.body.id, model: 'm' }] },
      'PATCH',
    );
    expect((await decide()).body.gateway).toMatchObject({
      cost_usd: 0.002,
      cost_includes_output: false,
    });
    const logs = await api('/admin/api/logs?route=out-test', undefined, 'GET');
    expect(logs.body.items.map((l) => l.cost_includes_output)).toEqual([false, true, true]);
    const stats = await api('/admin/api/stats?window=1h', undefined, 'GET');
    expect(stats.body.output_unpriced).toBe(1);
    expect(
      stats.body.by_route.find((r: { route: string }) => r.route === 'out-test')?.output_unpriced,
    ).toBe(1);
    expect(stats.body.by_provider.find((p) => p.provider === 'out-test')?.output_unpriced).toBe(1);
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// OpenAI does not charge output tokens on its Decisions endpoint ("Output tokens are not charged.",
// https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability); Chat Completions charges them.
test('native OpenAI Decisions output is free, while the chat wire and a route output price charge it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'output-pricing-native-'));
  // A fake OpenAI: its Decisions endpoint and Chat Completions both report 1000 input and 200 output tokens, and its
  // listing names gpt-6-luna.
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/v1/models') return Response.json({ data: [{ id: 'gpt-6-luna' }] });
      if (path === '/v1/decisions') {
        const body = (await req.json()) as { questions: { name: string; type: string }[] };
        return Response.json({
          answers: body.questions.map((q) => ({
            question: q.name,
            type: q.type,
            value: true,
            probability: 0.9,
          })),
          usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
        });
      }
      return Response.json({
        choices: [
          {
            message: { content: 'Yes' },
            logprobs: { content: [{ top_logprobs: [{ token: 'Yes', logprob: 0 }] }] },
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
      });
    },
  });
  const gateway = createGateway({ env: { ADMIN_TOKEN: 'a', DATA_DIR: dir } });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });

  const api = async <T>(path: string, body?: unknown, method = 'POST'): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };

  type Gateway = {
    gateway: { cost_usd: number; cost_basis: string; cost_includes_output: boolean };
  };
  type Listing = { models: Record<string, unknown>[] };

  try {
    const shared = {
      kind: 'openai',
      enabled: true,
      base_url: `http://127.0.0.1:${upstream.port}`,
      timeout_ms: 5000,
      extra_body: {},
      key: { source: 'none' },
    };
    const native = await api<{ id: string }>('/admin/api/providers', {
      ...shared,
      name: 'luna-native',
      wire: 'openai',
      path: '/v1/decisions',
      limits: { max_questions: 16, max_choices: 64 },
    });
    const chat = await api<{ id: string }>('/admin/api/providers', {
      ...shared,
      name: 'luna-chat',
      wire: 'chat',
      synthetic_methods: ['logprobs'],
    });
    const routes: [string, Record<string, unknown>][] = [
      ['luna-native', { provider_id: native.id, model: 'gpt-6-luna' }],
      [
        'luna-native-priced',
        { provider_id: native.id, model: 'gpt-6-luna', price_per_m_output: 3 },
      ],
      ['luna-chat', { provider_id: chat.id, model: 'gpt-6-luna' }],
    ];
    for (const [alias, target] of routes)
      await api('/admin/api/routes', { alias, description: '', enabled: true, targets: [target] });

    const decide = async (model: string) =>
      (
        await api<Gateway>('/v1/decisions', {
          model,
          input: 'input',
          questions: [{ name: 'p', type: 'predicate', instructions: 'true?' }],
        })
      ).gateway;

    // 1000 input tokens at $0.10 per million, and the 200 output tokens free.
    expect(await decide('luna-native')).toMatchObject({
      cost_usd: 0.0001,
      cost_basis: 'upstream_tokens',
      cost_includes_output: true,
    });
    // A route output price still applies: 200 output tokens at $3 per million.
    expect(await decide('luna-native-priced')).toMatchObject({
      cost_usd: 0.0007,
      cost_includes_output: true,
    });
    // Chat Completions keeps OpenAI's output rate: 200 output tokens at $0.50 per million.
    expect(await decide('luna-chat')).toMatchObject({
      cost_usd: 0.0002,
      cost_basis: 'upstream_tokens',
      cost_includes_output: true,
    });

    const listing = (id: string) =>
      api<Listing>(`/admin/api/providers/${id}/models`, undefined, 'GET');

    expect((await listing(native.id)).models).toEqual([
      { id: 'gpt-6-luna', default_price_per_m_input: 0.1, default_price_per_m_output: 0 },
    ]);
    expect((await listing(chat.id)).models).toEqual([
      { id: 'gpt-6-luna', default_price_per_m_input: 0.1, default_price_per_m_output: 0.5 },
    ]);
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
