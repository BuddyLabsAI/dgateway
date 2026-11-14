// The chat wire's hardening against fake upstreams that behave like the real hosts of 2026-11-11: a model that thinks
// unless reasoning is off, a host that makes reasoning mandatory, and hosts that refuse top_logprobs 20 with an
// opaque HTTP 400.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type {
  DecisionRequest,
  DecisionResponse,
} from '../../src/modules/gateway/libs/decisions/schemas/types';

type Body = {
  messages: { content: string }[];
  logprobs?: boolean;
  top_logprobs?: number;
  max_tokens?: number;
  n?: number;
  reasoning?: { enabled?: boolean; effort?: string };
};

const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: 0.001 };
const mandatory = {
  error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400 },
};
// OpenRouter's body when Novita refuses top_logprobs 20.
const opaque = {
  error: {
    message: 'Provider returned error',
    code: 400,
    metadata: { raw: 'invalid request error', provider_name: 'Novita' },
  },
};

const labelsOf = (body: Body) =>
  (JSON.parse(body.messages[2].content) as { options: { label: string }[] }).options.map(
    (o) => o.label,
  );

// A label answer: with logprobs on a logprobs call, plain content on a sampling call (n choices).
function answer(body: Body, content: string | null = labelsOf(body)[0]): Response {
  const label = labelsOf(body)[0];
  const choices = Array.from({ length: body.logprobs ? 1 : (body.n ?? 1) }, () => ({
    message: { content },
    ...(body.logprobs && content !== null
      ? {
          logprobs: {
            content: [
              { token: label, logprob: -0.1, top_logprobs: [{ token: label, logprob: -0.1 }] },
            ],
          },
        }
      : {}),
  }));
  return Response.json({ choices, usage });
}

const json = (body: unknown, status = 400) => Response.json(body, { status });

describe('chat wire hardening', () => {
  let behave: (body: Body) => Response = (body) => answer(body);

  let captured: Body[] = [];
  let listings = 0;
  const dir = mkdtempSync(join(tmpdir(), 'chat-hardening-'));
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      // OpenRouter's models listing, in its real shape: each entry carries supported_parameters.
      if (req.method === 'GET') {
        listings++;
        return Response.json({
          data: [
            {
              id: 'thinker',
              pricing: { prompt: '0.0000001', completion: '0.0000002' },
              supported_parameters: ['include_reasoning', 'logprobs', 'reasoning', 'top_logprobs'],
            },
            {
              id: 'plain',
              pricing: { prompt: '0.0000001', completion: '0.0000002' },
              supported_parameters: ['logprobs', 'max_tokens', 'top_logprobs'],
            },
          ],
        });
      }
      const body = (await req.json()) as Body;
      captured.push(body);
      return behave(body);
    },
  });
  const gateway = createGateway({ env: { ADMIN_TOKEN: 'a', DATA_DIR: dir } });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });
  let id = '';

  const api = async (path: string, body: unknown, method = 'POST') => {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  const predicate = (name = 'p') => ({ name, type: 'predicate' as const, instructions: 'test' });

  const choice = (count: number) => ({
    name: 'c',
    type: 'choice' as const,
    instructions: 'pick',
    choices: Array.from({ length: count }, (_, i) => ({ value: i, description: String(i) })),
  });

  const decide = async (
    questions: DecisionRequest['questions'] = [predicate()],
    settings: Record<string, unknown> = {},
  ) => {
    expect(
      (
        await api(
          `/admin/api/providers/${id}`,
          {
            synthetic_methods: ['logprobs', 'sampling'],
            sampling_n: 4,
            extra_body: {},
            ...settings,
          },
          'PATCH',
        )
      ).status,
    ).toBe(200);
    captured = [];
    return (await api('/v1/decisions', { model: 'hard', input: 'ticket', questions }))
      .body as unknown as DecisionResponse & { error?: { message: string } };
  };

  beforeAll(async () => {
    const created = await api('/admin/api/providers', {
      name: 'router-chat',
      kind: 'openrouter',
      wire: 'chat',
      enabled: true,
      base_url: `http://127.0.0.1:${upstream.port}`,
      timeout_ms: 5000,
      extra_body: {},
      key: { source: 'none' },
    });
    expect(created.status).toBe(200);
    expect(created.body.disable_reasoning).toBeUndefined();
    id = created.body.id as string;
    const mock = gateway.store.providers().find((p) => p.kind === 'mock')!;
    await api('/admin/api/routes', {
      alias: 'hard',
      description: '',
      enabled: true,
      targets: [
        { provider_id: id, model: 'thinker' },
        { provider_id: mock.id, model: 'mock-1' },
      ],
    });
  });

  afterAll(async () => {
    await server.stop(true);
    await upstream.stop(true);
    gateway.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('disable_reasoning must be a boolean', async () => {
    for (const value of ['yes', 1, null])
      expect(
        (await api(`/admin/api/providers/${id}`, { disable_reasoning: value }, 'PATCH')).status,
      ).toBe(400);
  });

  test('reasoning goes only to a model whose cached catalog entry lists it', async () => {
    behave = (body) => answer(body);
    // Not cached yet: the first decision fetches the listing once, then sends reasoning to the reasoning model.
    expect(listings).toBe(0);
    await decide();
    expect(listings).toBe(1);
    expect(captured[0].reasoning).toEqual({ enabled: false });
    const listed = await fetch(`http://127.0.0.1:${server.port}/admin/api/providers/${id}/models`, {
      headers: { authorization: 'Bearer a' },
    });
    const models = ((await listed.json()) as { models: Record<string, unknown>[] }).models;
    // The models endpoint keeps its shape: supported_parameters stay in the cache only.
    expect(models.map((m) => m.id)).toEqual(['thinker', 'plain']);
    expect(models.every((m) => m.supported_parameters === undefined)).toBe(true);
    // Both read the same cache: neither the models endpoint nor later decisions fetch again.
    await decide();
    expect(listings).toBe(1);
    expect(captured[0].reasoning).toEqual({ enabled: false });
    // A model without reasoning (as Llama 4 Maverick and Mistral Small 3.2 are listed) gets no field, even pinned
    // with require_parameters.
    captured = [];
    const plain = (
      await api('/v1/decisions', {
        model: 'router-chat::plain',
        input: 'ticket',
        questions: [predicate()],
      })
    ).body as unknown as DecisionResponse;
    expect(plain.answers[0].confidence_method).toBe('logprobs');
    expect(captured).toHaveLength(1);
    expect(captured[0].reasoning).toBeUndefined();
    // A model the catalog does not list gets none either.
    captured = [];
    await api('/v1/decisions', {
      model: 'router-chat::unlisted',
      input: 'ticket',
      questions: [predicate()],
    });
    expect(captured[0].reasoning).toBeUndefined();
  });

  test('a thinking model answers once the gateway turns reasoning off by default on OpenRouter', async () => {
    // Thinking on: the one output token goes to reasoning and content is null.
    behave = (body) => answer(body, body.reasoning?.enabled === false ? 'Yes' : null);
    const result = await decide();
    expect(result.gateway).toMatchObject({ provider: 'router-chat', synthetic: true });
    expect(result.answers[0].confidence_method).toBe('logprobs');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ reasoning: { enabled: false }, max_tokens: 1 });
    // Turned off by the owner, the model thinks again and the question falls through to the mock.
    const off = await decide([predicate()], { disable_reasoning: false });
    expect(off.gateway.provider).toBe('mock');
    expect(captured.every((b) => b.reasoning === undefined)).toBe(true);
    // An owner-set extra_body.reasoning wins over the automatic value.
    const owned = await decide([predicate()], {
      disable_reasoning: true,
      extra_body: { reasoning: { effort: 'high' } },
    });
    expect(owned.gateway.provider).toBe('mock');
    expect(captured.every((b) => b.reasoning?.effort === 'high')).toBe(true);
  });

  test('a mandatory-reasoning refusal is retried with effort low and a larger budget', async () => {
    // As Venice and Fireworks answer: reasoning off is refused; at low effort the label follows the reasoning, which
    // needs the larger budget.
    behave = (body) => {
      if (body.reasoning?.enabled === false) return json(mandatory);
      if (body.reasoning?.effort !== 'low' || (body.max_tokens ?? 0) < 1000)
        return answer(body, null);
      return answer(body, `\n\n${labelsOf(body)[0]}`);
    };
    const result = await decide();
    expect(result.gateway.provider).toBe('router-chat');
    expect(result.answers[0].confidence_method).toBe('logprobs');
    expect(captured.map((b) => b.reasoning)).toEqual([{ enabled: false }, { effort: 'low' }]);
    expect(captured[1].max_tokens).toBe(2049);
    // Only the answered call is billed.
    expect(result.usage).toMatchObject({ input_tokens: 10, output_tokens: 1 });
    expect(result.gateway.cost_usd).toBeCloseTo(0.001);

    // Later calls of the attempt send low effort directly: no logprobs here, so sampling follows the retry.
    behave = (body) => {
      if (body.reasoning?.enabled === false) return json(mandatory);
      if (body.logprobs)
        return Response.json({ choices: [{ message: { content: 'Yes' } }], usage });
      return answer(body);
    };
    const sampled = await decide();
    expect(sampled.answers[0].confidence_method).toBe('sampling');
    expect(captured).toHaveLength(3);
    expect(captured[2]).toMatchObject({ reasoning: { effort: 'low' }, max_tokens: 2056, n: 4 });
    // Two calls answered (the retry and the sampling call): every answered call counts.
    expect(sampled.usage).toMatchObject({ input_tokens: 20 });
  });

  test('an opaque 400 on top_logprobs 20 is retried with 5, and later calls send 5 directly', async () => {
    behave = (body) =>
      body.logprobs && (body.top_logprobs ?? 0) > 5 ? json(opaque) : answer(body);
    // Nine questions: eight run at once and are refused, the ninth starts after a retry with 5 answered.
    const questions = Array.from({ length: 9 }, (_, i) => predicate(`p${i}`));
    const result = await decide(questions);
    expect(result.gateway.provider).toBe('router-chat');
    expect(result.answers.every((a) => a.confidence_method === 'logprobs')).toBe(true);
    expect(captured.filter((b) => b.top_logprobs === 20)).toHaveLength(8);
    expect(captured.filter((b) => b.top_logprobs === 5)).toHaveLength(9);
    // The refused calls are not billed.
    expect(result.usage).toMatchObject({ input_tokens: 90 });
  });

  test('an opaque 400 twice moves the question on to sampling', async () => {
    behave = (body) => (body.logprobs ? json(opaque) : answer(body));
    const result = await decide();
    expect(result.gateway.provider).toBe('router-chat');
    expect(result.answers[0].confidence_method).toBe('sampling');
    expect(captured.map((b) => b.top_logprobs)).toEqual([20, 5, undefined]);
    expect(result.usage).toMatchObject({ input_tokens: 10 });
  });

  test('a 7-option choice cannot retry with 5 and moves on to sampling', async () => {
    behave = (body) =>
      body.logprobs && (body.top_logprobs ?? 0) > 5 ? json(opaque) : answer(body);
    const result = await decide([choice(7)]);
    expect(result.answers[0].confidence_method).toBe('sampling');
    expect(captured.map((b) => b.top_logprobs)).toEqual([20, undefined]);
  });

  test('a 400 about something else, a 422 and a sampling 400 keep their route behavior', async () => {
    // A failed decision has no gateway block, so the playground trace shows which targets were tried.
    const attempts = async (
      questions: DecisionRequest['questions'] = [predicate()],
      settings: Record<string, unknown> = {},
    ) => {
      await decide(questions, settings);
      captured = [];
      const play = await api('/admin/api/playground', {
        request: { model: 'hard', input: 'ticket', questions },
      });
      return play.body as {
        error?: { message: string };
        trace: { attempts: { provider: string; ok: boolean; error?: string }[] };
      };
    };

    // A 400 naming the model stops the route: no fallback.
    behave = (body) =>
      body.logprobs
        ? json({ error: { message: 'thinker is not a valid model ID' } })
        : answer(body);
    const named = await attempts();
    expect(named.trace.attempts).toHaveLength(1);
    expect(named.error?.message).toContain('not a valid model ID');
    expect(captured).toHaveLength(1);
    // A 422, even opaque, stops the route too.
    behave = (body) => (body.logprobs ? json(opaque, 422) : answer(body));
    const unprocessable = await attempts();
    expect(unprocessable.trace.attempts).toHaveLength(1);
    expect(captured).toHaveLength(1);
    // A 429 on a logprobs call falls back to the next target.
    behave = (body) => (body.logprobs ? json(opaque, 429) : answer(body));
    const limited = await attempts();
    expect(limited.trace.attempts.map((a) => a.provider)).toEqual(['router-chat', 'mock']);
    // A sampling call's opaque 400 is not a logprobs refusal: it stops the route as before.
    behave = () => json(opaque);
    const sampling = await attempts([predicate()], { synthetic_methods: ['sampling'] });
    expect(sampling.trace.attempts).toHaveLength(1);
    expect(sampling.error?.message).toContain('upstream HTTP 400');
  });

  test('the playground trace shows logprob tokens', async () => {
    behave = (body) => answer(body);
    await decide();
    const play = await api('/admin/api/playground', {
      request: { model: 'hard', input: 'ticket', questions: [predicate()] },
    });
    const text = JSON.stringify((play.body as { trace: unknown }).trace);
    expect(text).toContain('"token":"Yes"');
    expect(text).not.toContain('[REDACTED]');
  });
});
