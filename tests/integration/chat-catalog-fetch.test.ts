// A chat-wire OpenRouter decision that finds no cached catalog fetches the listing once before it decides: concurrent
// decisions share the fetch, and a failed fetch neither fails the decision nor is retried for 5 minutes.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type { DecisionResponse } from '../../src/modules/gateway/libs/decisions/schemas/types';

type Body = { messages: { content: string }[]; reasoning?: unknown };

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// A fake OpenRouter: the listing (slow, or failing) and chat completions that answer the first label with logprobs
// and report usage without a cost, so the answer is priced from the catalog.
async function setup(listing: 'ok' | 'fail') {
  const dir = mkdtempSync(join(tmpdir(), 'chat-catalog-'));
  const state = { listings: 0, bodies: [] as Body[], now: 1_000_000 };
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method === 'GET') {
        state.listings++;
        await Bun.sleep(50);
        if (listing === 'fail') return new Response('down', { status: 503 });
        return Response.json({
          data: [
            {
              id: 'thinker',
              pricing: { prompt: '0.000001', completion: '0.000002' },
              supported_parameters: ['include_reasoning', 'logprobs', 'reasoning', 'top_logprobs'],
            },
          ],
        });
      }
      const body = (await req.json()) as Body;
      state.bodies.push(body);
      const label = (JSON.parse(body.messages[2].content) as { options: { label: string }[] })
        .options[0].label;
      return Response.json({
        choices: [
          {
            message: { content: label },
            logprobs: { content: [{ top_logprobs: [{ token: label, logprob: -0.1 }] }] },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
      });
    },
  });
  const gateway = createGateway({
    env: { ADMIN_TOKEN: 'a', DATA_DIR: dir },
    clock: () => state.now,
  });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });
  cleanups.push(async () => {
    await server.stop(true);
    await upstream.stop(true);
    gateway.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const api = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await r.json()) as Record<string, unknown>;
  };

  await api('/admin/api/providers', {
    name: 'router-chat',
    kind: 'openrouter',
    wire: 'chat',
    synthetic_methods: ['logprobs'],
    enabled: true,
    base_url: `http://127.0.0.1:${upstream.port}`,
    timeout_ms: 5000,
    limits: { max_questions: 16, max_choices: 20 },
    extra_body: {},
    key: { source: 'none' },
  });

  const decide = async () =>
    (await api('/v1/decisions', {
      model: 'router-chat::thinker',
      input: 'ticket',
      questions: [{ name: 'p', type: 'predicate', instructions: 'test' }],
    })) as unknown as DecisionResponse;

  return { state, decide };
}

test('the first decision after start fetches the catalog once, then sends reasoning and prices from it', async () => {
  const { state, decide } = await setup('ok');
  const first = await decide();
  expect(state.listings).toBe(1);
  expect(state.bodies[0].reasoning).toEqual({ enabled: false });
  expect(first.answers[0].confidence_method).toBe('logprobs');
  // No billed cost in usage: the catalog's 1 USD per million input and 2 per million output price the answer.
  expect(first.gateway).toMatchObject({ cost_basis: 'upstream_tokens', cost_usd: 0.000102 });
  await decide();
  expect(state.listings).toBe(1);
  expect(state.bodies[1].reasoning).toEqual({ enabled: false });
});

test('concurrent decisions share one catalog fetch', async () => {
  const { state, decide } = await setup('ok');
  const results = await Promise.all(Array.from({ length: 6 }, decide));
  expect(state.listings).toBe(1);
  expect(results.every((r) => r.answers[0].confidence_method === 'logprobs')).toBe(true);
  expect(state.bodies).toHaveLength(6);
  expect(state.bodies.every((b) => JSON.stringify(b.reasoning) === '{"enabled":false}')).toBe(true);
});

test('a failing catalog fetch still answers, and is not retried for 5 minutes', async () => {
  const { state, decide } = await setup('fail');
  const results = await Promise.all(Array.from({ length: 3 }, decide));
  expect(state.listings).toBe(1);
  for (const result of results) {
    expect(result.answers[0].confidence_method).toBe('logprobs');
    // No catalog: no price and no reasoning field.
    expect(result.gateway.cost_basis).toBe('unpriced');
  }
  expect(state.bodies.every((b) => b.reasoning === undefined)).toBe(true);
  state.now += 4 * 60 * 1000;
  await decide();
  expect(state.listings).toBe(1);
  state.now += 60 * 1000;
  await decide();
  expect(state.listings).toBe(2);
});
