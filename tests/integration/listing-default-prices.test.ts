// The models endpoint's default prices for a hinted chat-wire OpenRouter provider are the prices a decision is charged:
// they come from the cached catalog a decision reads, on the first listing (which fetches the catalog) and on a cached
// listing alike, never from a hint's price merged into the listing.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';

type Body = { messages: { content: string }[] };
type Listed = {
  id: string;
  price_per_m_input?: number;
  price_per_m_output?: number;
  default_price_per_m_input?: number;
  default_price_per_m_output?: number;
};
type Answered = {
  gateway: { cost_usd: number; cost_basis: string; cost_includes_output: boolean };
};

test('a hinted OpenRouter chat listing reports the catalog defaults a decision is charged, first and cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'listing-prices-'));
  const state = { listings: 0 };
  // A fake OpenRouter: the catalog prices cheap at $0.10 per million input and $0.40 per million output, and chat
  // completions answer the first label with 1000 input and 10 output tokens of usage, without a cost.
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method === 'GET') {
        state.listings++;
        return Response.json({
          data: [{ id: 'cheap', pricing: { prompt: '0.0000001', completion: '0.0000004' } }],
        });
      }
      const body = (await req.json()) as Body;
      const label = (JSON.parse(body.messages[2].content) as { options: { label: string }[] })
        .options[0].label;
      return Response.json({
        choices: [
          {
            message: { content: label },
            logprobs: { content: [{ top_logprobs: [{ token: label, logprob: -0.1 }] }] },
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
      });
    },
  });
  const gateway = createGateway({ env: { ADMIN_TOKEN: 'a', DATA_DIR: dir } });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });

  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(r.status).toBe(200);
    return (await r.json()) as T;
  };

  try {
    const provider = await api<{ id: string }>('/admin/api/providers', {
      name: 'router-hinted',
      kind: 'openrouter',
      wire: 'chat',
      synthetic_methods: ['logprobs'],
      enabled: true,
      base_url: `http://127.0.0.1:${upstream.port}`,
      timeout_ms: 5000,
      limits: { max_questions: 16, max_choices: 20 },
      extra_body: {},
      key: { source: 'none' },
      // Hint prices that differ from the catalog's. OpenRouter decisions are priced from the catalog alone.
      model_hints: [
        { id: 'cheap', price_per_m_input: 0.5, price_per_m_output: 2 },
        { id: 'hint-only', price_per_m_input: 0.7 },
      ],
    });

    const models = async () =>
      (await api<{ models: Listed[] }>(`/admin/api/providers/${provider.id}/models`)).models;

    // The first listing fetches the catalog and merges the hints, whose prices win in price_per_m_input and
    // price_per_m_output; the defaults are the catalog's.
    const first = await models();
    expect(state.listings).toBe(1);
    expect(first).toEqual([
      {
        id: 'cheap',
        price_per_m_input: 0.5,
        price_per_m_output: 2,
        default_price_per_m_input: 0.1,
        default_price_per_m_output: 0.4,
      },
      // Not in the catalog, so a decision would leave it unpriced: no default.
      { id: 'hint-only', price_per_m_input: 0.7 },
    ]);
    // A listing from the cache agrees.
    const cached = await models();
    expect(state.listings).toBe(1);
    expect(cached.find((m) => m.id === 'cheap')).toMatchObject({
      default_price_per_m_input: 0.1,
      default_price_per_m_output: 0.4,
    });

    // A decision is charged the listed defaults: 1000 input tokens at 0.10 and 10 output tokens at 0.40, per million.
    const answered = await api<Answered>('/v1/decisions', {
      model: 'router-hinted::cheap',
      input: 'ticket',
      questions: [{ name: 'p', type: 'predicate', instructions: 'test' }],
    });
    expect(state.listings).toBe(1);
    const listed = first[0];
    expect(answered.gateway).toMatchObject({
      cost_basis: 'upstream_tokens',
      cost_includes_output: true,
      cost_usd:
        (1000 * listed.default_price_per_m_input! + 10 * listed.default_price_per_m_output!) /
        1_000_000,
    });
    expect(answered.gateway.cost_usd).toBe(0.000104);
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
