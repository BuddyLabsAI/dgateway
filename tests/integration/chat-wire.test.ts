import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type {
  DecisionResponse,
  DecisionRequest,
} from '../../src/modules/gateway/libs/decisions/schemas/types';
import type { Provider } from '../../src/modules/gateway/libs/management/schemas/types';

test('chat wire translates all question types, sums usage/cost, tests providers and falls back on missing logprobs/refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-wire-'));
  let mode = 'ok',
    active = 0,
    peak = 0;
  const captured: Record<string, unknown>[] = [];
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method === 'GET') return Response.json({ data: [{ id: 'chat-model' }] });
      const body = (await req.json()) as { model: string; messages: { content: string }[] };
      captured.push(body);
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(mode === 'slow' ? 80 : 5);
      active--;
      const question = JSON.parse(body.messages[2].content) as { options: { label: string }[] };
      const labels = question.options.map((o) => o.label);
      return Response.json({
        model: 'chat-model-resolved',
        choices: [
          {
            message: {
              content: mode === 'refusal' ? null : labels[0],
              ...(mode === 'refusal' ? { refusal: 'No' } : {}),
            },
            ...(mode === 'missing'
              ? {}
              : {
                  logprobs: {
                    content: [
                      {
                        top_logprobs: labels.map((token, i) => ({
                          token: ` ${token}`,
                          logprob: Math.log(i === 0 ? 0.8 : 0.2 / (labels.length - 1)),
                        })),
                      },
                    ],
                  },
                }),
          },
        ],
        ...(mode === 'no-usage'
          ? {}
          : {
              usage: {
                prompt_tokens: 10,
                completion_tokens: 1,
                total_tokens: 11,
                prompt_tokens_details: { cached_tokens: 4 },
                ...(mode === 'priced' ? {} : { cost: 0.001 }),
              },
            }),
      });
    },
  });
  const gateway = createGateway({ env: { ADMIN_TOKEN: 'admin', DATA_DIR: dir } });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });

  const api = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
    const result = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: result.status, body: (await result.json()) as Record<string, unknown> };
  };

  try {
    const created = await api('/admin/api/providers', {
      name: 'chat',
      kind: 'openai-compatible',
      wire: 'chat',
      synthetic_methods: ['logprobs'],
      base_url: `http://127.0.0.1:${upstream.port}`,
      enabled: true,
      timeout_ms: 1000,
      key: { source: 'none' },
      extra_body: {},
      send_model: false,
    });
    expect(created.status).toBe(200);
    const provider = created.body as unknown as Provider;
    expect(provider.path).toBe('/v1/chat/completions');
    expect(provider.limits).toEqual({ max_questions: 16, max_choices: 20 });
    expect(
      (
        await api(
          `/admin/api/providers/${provider.id}`,
          { limits: { max_questions: 16, max_choices: 21 } },
          'PATCH',
        )
      ).status,
    ).toBe(400);
    expect((await api(`/admin/api/providers/${provider.id}/models`)).body).toEqual({
      models: [{ id: 'chat-model' }],
    });
    const mock = gateway.store.providers().find((p) => p.kind === 'mock')!;
    await api('/admin/api/routes', {
      alias: 'chat-test',
      enabled: true,
      description: '',
      targets: [
        { provider_id: provider.id, model: 'chat-model', price_per_m_input: 2 },
        { provider_id: mock.id, model: 'mock-1' },
      ],
    });
    const request: DecisionRequest = {
      model: 'chat-test',
      input: 'ticket',
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
          instructions: 'rate',
          levels: [{ description: 'low', label: 'low' }, { description: 'high' }],
        },
      ],
    };

    const decide = async (value = request) =>
      (await api('/v1/decisions', value)).body as unknown as DecisionResponse;

    const result = await decide();
    expect(result.gateway).toMatchObject({
      synthetic: true,
      confidence_method: 'logprobs',
      tokens: 30,
      cost_basis: 'upstream_cost',
      cost_usd: 0.003,
      upstream_model_resolved: 'chat-model-resolved',
    });
    expect(result.answers[0]).toMatchObject({ choice: true, confidence_method: 'logprobs' });
    expect(result.answers[1].probability).toBeCloseTo(0.8);
    expect(result.answers[2].score).toBeCloseTo(0.2);
    expect(result.usage).toEqual({
      input_tokens: 30,
      output_tokens: 3,
      total_tokens: 33,
      input_tokens_details: { cached_tokens: 12 },
    });
    expect(result.gateway.attempts).toHaveLength(1);
    expect(peak).toBe(3);
    expect(captured[0]).toMatchObject({
      model: 'chat-model',
      logprobs: true,
      top_logprobs: 20,
      max_tokens: 1,
    });
    expect(
      (await api(`/admin/api/providers/${provider.id}/test`, { model: 'chat-model' })).body,
    ).toMatchObject({ ok: true, matched: true, answer: 'billing' });
    mode = 'priced';
    expect((await decide()).gateway).toMatchObject({
      cost_basis: 'upstream_tokens',
      cost_usd: 0.00006,
    });
    mode = 'no-usage';
    expect((await decide()).gateway.cost_basis).toBe('estimated_tokens');
    for (mode of ['missing', 'refusal']) {
      const fallback = await decide();
      expect(fallback.gateway).toMatchObject({ provider: 'mock', synthetic: false });
      expect(fallback.gateway.attempts).toHaveLength(2);
      expect(fallback.gateway.attempts[0].error).toContain(
        mode === 'missing' ? 'logprobs' : 'refused',
      );
    }
    mode = 'ok';
    peak = 0;
    await decide({
      ...request,
      questions: Array.from({ length: 16 }, (_, i) => ({ ...request.questions[1], name: `p${i}` })),
    });
    expect(peak).toBe(8);
    mode = 'slow';
    await api(`/admin/api/providers/${provider.id}`, { timeout_ms: 20 }, 'PATCH');
    expect((await decide()).gateway.attempts[0].error).toBe('timeout');
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
