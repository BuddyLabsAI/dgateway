import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type {
  DecisionRequest,
  DecisionResponse,
} from '../../src/modules/gateway/libs/decisions/schemas/types';

test('chat ordered methods: sampling fill-up, large choices, batched JSON, mixed methods and schema-to-prompt transport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-methods-'));
  let mode = 'sample',
    calls = 0,
    jsonCalls = 0;
  const captured: Record<string, unknown>[] = [];
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method === 'GET') return Response.json({ data: [{ id: 'chat-catalog-model' }] });
      const body = (await req.json()) as {
        messages: { content: string }[];
        logprobs?: boolean;
        n?: number;
        response_format?: unknown;
      };
      captured.push(body);
      calls++;
      const prompt = JSON.parse(body.messages[2].content) as {
        instructions?: string;
        options?: { label: string }[];
        questions?: { id: string; type: string; choices?: unknown[]; levels?: unknown[] }[];
      };
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.001 };
      if (prompt.questions) {
        jsonCalls++;
        if (mode === 'schema-refused' && body.response_format)
          return Response.json(
            { error: { message: 'response_format json_schema unsupported' } },
            { status: 400 },
          );
        if (mode === 'schema-text' && body.response_format)
          return Response.json({
            choices: [{ message: { content: 'no structured output' } }],
            usage,
          });
        if (mode === 'refusal')
          return Response.json({ choices: [{ message: { content: null, refusal: 'No' } }], usage });
        const content = JSON.stringify(
          Object.fromEntries(
            prompt.questions.map((q) => [
              q.id,
              mode === 'bad-json'
                ? [0]
                : q.type === 'predicate'
                  ? 75
                  : (q.choices ?? q.levels)!.map((_, i) => (i === 0 ? 80 : 20)),
            ]),
          ),
        );
        return Response.json({
          choices: [
            { message: { content: !body.response_format ? `Here: ${content} done` : content } },
          ],
          usage,
        });
      }
      const label = prompt.options![0].label;
      // As OpenAI's reasoning models answer a logprobs request (captured 2026-11-11).
      if (mode === 'logprobs-400' && body.logprobs)
        return Response.json(
          {
            error: {
              message: "Unsupported parameter: 'logprobs' is not supported with this model.",
              type: 'invalid_request_error',
              param: 'logprobs',
              code: 'unsupported_parameter',
            },
          },
          { status: 400 },
        );
      if (body.logprobs)
        return Response.json({
          choices: [
            {
              message:
                mode === 'log-refusal'
                  ? { content: null, refusal: 'No' }
                  : { content: mode === 'non-label' || mode === 'log-filter' ? '?' : label },
              ...(mode === 'log-filter' ? { finish_reason: 'content_filter' } : {}),
              ...(mode === 'non-label' ||
              mode === 'log-refusal' ||
              mode === 'log-filter' ||
              (mode === 'mixed' && prompt.instructions === 'log works')
                ? { logprobs: { content: [{ top_logprobs: [{ token: label, logprob: 0 }] }] } }
                : {}),
            },
          ],
          usage,
        });
      return Response.json({
        choices: [
          {
            message: {
              content: ['json', 'schema-refused', 'schema-text', 'bad-json', 'refusal'].includes(
                mode,
              )
                ? '?'
                : label,
            },
          },
        ],
        usage,
      });
    },
  });
  const gateway = createGateway({ env: { ADMIN_TOKEN: 'a', DATA_DIR: dir } });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });

  const api = async (path: string, body: unknown, method = 'POST') => {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  const q = {
    name: 'c',
    type: 'choice' as const,
    instructions: 'pick',
    choices: [
      { value: 'a', description: 'A' },
      { value: 'b', description: 'B' },
    ],
  };
  try {
    const created = await api('/admin/api/providers', {
      name: 'chat-auto',
      kind: 'openai-compatible',
      wire: 'chat',
      enabled: true,
      base_url: `http://127.0.0.1:${upstream.port}`,
      timeout_ms: 5000,
      extra_body: {},
      key: { source: 'none' },
    });
    expect(created.status).toBe(200);
    expect(created.body.limits).toEqual({ max_questions: 16, max_choices: 64 });
    const id = created.body.id as string;
    const mock = gateway.store.providers().find((p) => p.kind === 'mock')!;
    await api('/admin/api/routes', {
      alias: 'auto',
      description: '',
      enabled: true,
      targets: [
        { provider_id: id, model: 'm' },
        { provider_id: mock.id, model: 'mock-1' },
      ],
    });

    const decide = async (questions = [q] as DecisionRequest['questions']) =>
      (await api('/v1/decisions', { model: 'auto', input: 'input', questions }))
        .body as unknown as DecisionResponse;

    const result = await decide();
    expect(result.answers[0].confidence_method).toBe('sampling');
    expect(result.answers[0].probabilities?.[0].probability).toBe(1);
    expect(calls).toBe(9); // One missing-logprobs response plus eight samples (upstream ignores n).
    expect(result.usage).toMatchObject({ input_tokens: 90, output_tokens: 18, total_tokens: 108 });
    expect(result.gateway.cost_usd).toBeCloseTo(0.009);
    expect(captured.filter((b) => b.n === 1)).toHaveLength(7);
    const thirty = {
      ...q,
      choices: Array.from({ length: 30 }, (_, i) => ({ value: i, description: String(i) })),
    };
    calls = 0;
    expect((await decide([thirty])).answers[0].confidence_method).toBe('sampling');
    expect(calls).toBe(8);
    expect(captured.at(-1)?.logprobs).toBeUndefined();
    mode = 'non-label';
    calls = 0;
    expect((await decide()).answers[0].confidence_method).toBe('sampling');
    expect(calls).toBe(9);
    // A 4xx naming logprobs is missing logprobs: the question advances, and the refused call adds no usage.
    mode = 'logprobs-400';
    calls = 0;
    const refused = await decide();
    expect(refused.gateway).toMatchObject({ provider: 'chat-auto', synthetic: true });
    expect(refused.answers[0].confidence_method).toBe('sampling');
    expect(calls).toBe(9);
    expect(refused.usage).toMatchObject({ input_tokens: 80, output_tokens: 16, total_tokens: 96 });
    expect(refused.gateway.cost_usd).toBeCloseTo(0.008);
    for (mode of ['log-refusal', 'log-filter']) {
      calls = 0;
      expect((await decide()).gateway.provider).toBe('mock');
      expect(calls).toBe(1);
    }
    mode = 'json';
    jsonCalls = 0;
    const json = await decide([q, { name: 'p', type: 'predicate', instructions: 'test' }]);
    expect(jsonCalls).toBe(1);
    expect(json.answers.map((a) => a.confidence_method)).toEqual(['json', 'json']);
    expect(json.answers[1].probability).toBe(0.75);
    mode = 'mixed';
    expect(
      (
        await decide([
          { ...q, instructions: 'log works' },
          { name: 'p', type: 'predicate', instructions: 'sample this' },
        ])
      ).gateway.confidence_method,
    ).toBe('mixed');
    expect(
      (
        await api(
          `/admin/api/providers/${id}`,
          { synthetic_methods: ['json'], json_transport: 'json_schema', kind: 'openai' },
          'PATCH',
        )
      ).status,
    ).toBe(200);
    const listed = await fetch(`http://127.0.0.1:${server.port}/admin/api/providers/${id}/models`, {
      headers: { authorization: 'Bearer a' },
    });
    expect(await listed.json()).toEqual({ models: [{ id: 'chat-catalog-model' }] });
    mode = 'json';
    calls = 0;
    expect((await decide()).answers[0].confidence_method).toBe('json');
    expect(calls).toBe(1);
    expect(captured.at(-1)?.response_format).toBeDefined();
    await api(`/admin/api/providers/${id}`, { json_transport: 'auto' }, 'PATCH');
    calls = 0;
    expect((await decide()).answers[0].confidence_method).toBe('json');
    expect(calls).toBe(1);
    expect(captured.at(-1)?.response_format).toBeDefined();
    for (mode of ['schema-refused', 'schema-text']) {
      calls = 0;
      const retried = await decide();
      expect(retried.answers[0].confidence_method).toBe('json');
      expect(calls).toBe(2);
      expect(captured.at(-1)?.response_format).toBeUndefined();
      // A refused json_schema call is not billed: only answered calls count (one when refused, two otherwise).
      expect(retried.usage?.input_tokens).toBe(mode === 'schema-refused' ? 10 : 20);
    }
    for (mode of ['bad-json', 'refusal'])
      expect((await decide()).gateway).toMatchObject({ provider: 'mock', synthetic: false });
    expect(
      (await api(`/admin/api/providers/${id}`, { synthetic_methods: ['logprobs'] }, 'PATCH'))
        .status,
    ).toBe(400);
    await api(
      `/admin/api/providers/${id}`,
      { synthetic_methods: ['logprobs'], limits: { max_questions: 16, max_choices: 20 } },
      'PATCH',
    );
    expect((await decide([thirty])).gateway.provider).toBe('mock');
    expect((await decide()).gateway.provider).toBe('mock');
    mode = 'non-label';
    expect((await decide()).gateway.provider).toBe('mock');
    for (const settings of [
      { synthetic_methods: [] },
      { synthetic_methods: ['json', 'json'] },
      { synthetic_methods: ['verbalized'] },
      { sampling_n: 1 },
      { sampling_n: 33 },
      { json_transport: 'tool' },
    ])
      expect((await api(`/admin/api/providers/${id}`, settings, 'PATCH')).status).toBe(400);
    await api(`/admin/api/providers/${id}`, { wire: 'openai' }, 'PATCH');
    const switched = await api(`/admin/api/providers/${id}`, { wire: 'chat' }, 'PATCH');
    expect(switched.body.path).toBe('/v1/chat/completions');
    const openrouter = await api('/admin/api/providers', {
      name: 'chat-router',
      kind: 'openrouter',
      wire: 'chat',
      enabled: false,
      base_url: 'https://example.invalid',
      timeout_ms: 100,
      extra_body: {},
      key: { source: 'none' },
    });
    expect(openrouter.body.path).toBe('/api/v1/chat/completions');
    const openai = await api('/admin/api/providers', {
      name: 'chat-openai',
      kind: 'openai',
      wire: 'chat',
      enabled: false,
      base_url: 'https://example.invalid/v1',
      timeout_ms: 100,
      extra_body: {},
      key: { source: 'none' },
    });
    expect(openai.body.path).toBe('/chat/completions');
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
