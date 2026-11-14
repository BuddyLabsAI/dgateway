import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type { DecisionResponse } from '../../src/modules/gateway/libs/decisions/schemas/types';
import type { Log, Provider } from '../../src/modules/gateway/libs/management/schemas/types';
import { documentedInGatewayIds, openai, openrouter } from '../fixtures/upstreams';

// The real OpenRouter and OpenAI decision APIs, as fakes built from live traffic (tests/fixtures), behind the real
// daemon. The fake OpenRouter checks a request the way the live one did: a bearer key, a model, a state and a question
// map whose score criteria are an ordered list. It refuses keyed score criteria with the exact 400 OpenRouter gave,
// and answers in SystemOne's shapes. The fake OpenAI answers only the exact request OpenAI answered live. Every call
// goes through the injected fetch, so nothing reaches the network.
const dir = mkdtempSync(join(tmpdir(), 'gateway-wire-'));
const ADMIN = 'wire-admin-token';
const OPENROUTER_KEY = 'wire-openrouter-key';
const OPENAI_KEY = 'wire-openai-key';
const adminHeaders = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
const live = openrouter.captured_2026_11_08_live;
const documented = openrouter.documented_example_openrouter_docs;

type Json = Record<string, unknown>;
type Seen = { host: string; body: unknown };
const seen: Seen[] = [];
let gateway: ReturnType<typeof createGateway>;
let server: ReturnType<typeof Bun.serve>;
const ids: Record<string, string> = {};

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const strings = (v: unknown, min: number) =>
  Array.isArray(v) && v.length >= min && v.every((x) => typeof x === 'string');

const refused = (status: number, message: string, code = status) =>
  Response.json({ error: { message, code } }, { status });

// OpenRouter's refusal of a question's criteria, as the live API words it.
function criteriaRefusal(id: string, expected: string, received: string): Response {
  const path = ['questions', id, 'criteria'];
  const message = `Invalid input: expected ${expected}, received ${received}`;
  return refused(400, JSON.stringify([{ expected, code: 'invalid_type', path, message }]));
}

// What the live OpenRouter would refuse in one question, or null when it would take it.
function questionProblem(id: string, q: unknown): Response | null {
  if (!isObject(q) || typeof q.instructions !== 'string') return refused(400, `bad question ${id}`);
  if (q.type === 'score' && !Array.isArray(q.criteria))
    return criteriaRefusal(id, 'array', Array.isArray(q.criteria) ? 'array' : typeof q.criteria);
  if (q.type === 'score')
    return strings(q.criteria, 2) ? null : refused(400, `bad levels in ${id}`);
  if (q.type === 'choice')
    return isObject(q.criteria) && Object.keys(q.criteria).length >= 2
      ? null
      : criteriaRefusal(id, 'object', typeof q.criteria);
  if (q.type === 'noul')
    return q.criteria === undefined || isObject(q.criteria) ? null : refused(400, `bad noul ${id}`);
  return refused(400, `unknown type in ${id}`);
}

function fakeOpenRouter(headers: Headers, body: unknown): Response {
  if (headers.get('authorization') !== `Bearer ${OPENROUTER_KEY}`)
    return refused(401, 'No auth credentials found');
  if (!isObject(body) || typeof body.model !== 'string' || !isObject(body.questions))
    return refused(400, 'model, state and questions are required');
  if (typeof body.state !== 'string' && !isObject(body.state)) return refused(400, 'bad state');
  for (const [id, q] of Object.entries(body.questions)) {
    const problem = questionProblem(id, q);
    if (problem) return problem;
  }
  if (Bun.deepEquals(body, live.request_choice_predicate))
    return Response.json(live.response_choice_predicate);
  if (Bun.deepEquals(body.questions.q2, documented.request_score.urgency))
    return Response.json(documentedInGatewayIds());
  return refused(400, 'this fake knows only the captured requests');
}

function fakeOpenAI(headers: Headers, body: unknown): Response {
  if (headers.get('authorization') !== `Bearer ${OPENAI_KEY}`)
    return refused(401, 'Incorrect API key provided');
  if (!Bun.deepEquals(body, openai.trace.upstream_request))
    return refused(400, 'this fake knows only the captured request');
  return Response.json(openai.trace.upstream_response);
}

function serve(input: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const headers = new Headers(init?.headers);
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  seen.push({ host: url.hostname, body });
  if (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/models')
    return Response.json({
      data: [{ id: 'perplexity/pplx-decider-flash-v1.2', pricing: { prompt: '0.00001' } }],
    });
  if (url.hostname === 'openrouter.ai' && url.pathname === '/api/alpha/decisions')
    return fakeOpenRouter(headers, body);
  if (url.hostname === 'api.openai.com' && url.pathname === '/v1/decisions')
    return fakeOpenAI(headers, body);
  return new Response('not served', { status: 599 });
}

const http = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(serve(input, init))) as typeof fetch;

const lastBody = (host: string) => seen.filter((s) => s.host === host).at(-1)?.body;

async function api<T = unknown>(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: adminHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as T };
}

async function decide(body: unknown) {
  const r = await fetch(`http://127.0.0.1:${server.port}/v1/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as DecisionResponse };
}

// The decision behind the live OpenRouter capture.
const liveDecision = {
  input: 'I was charged twice for my subscription.',
  questions: [
    {
      name: 'team',
      type: 'choice',
      instructions: 'Which team?',
      choices: [
        { value: 'payments', description: 'Payments' },
        { value: 'bugs', description: 'Bugs' },
      ],
    },
    { name: 'urgent', type: 'predicate', instructions: 'Is it urgent?' },
  ],
};

// The decision behind OpenRouter's documented example, in the order documentedInGatewayIds names it.
const documentedDecision = {
  input: 'Checkout fails for every customer paying by card.',
  questions: [
    {
      name: 'team',
      type: 'choice',
      instructions: 'Which team owns this ticket?',
      choices: [
        { value: 'account', description: 'Account and login' },
        { value: 'frontend', description: 'The web app' },
        { value: 'payments', description: 'Payments and billing' },
      ],
    },
    { name: 'is_bug', type: 'predicate', instructions: 'Is this a bug?' },
    {
      name: 'urgency',
      type: 'score',
      instructions: documented.request_score.urgency.instructions,
      levels: (documented.request_score.urgency.criteria as string[]).map((description, i) => ({
        label: ['later', 'this-week', 'now'][i],
        description,
      })),
    },
  ],
};

beforeAll(async () => {
  gateway = createGateway({
    env: {
      ADMIN_TOKEN: ADMIN,
      DATA_DIR: join(dir, 'data'),
      OPENROUTER_API_KEY: OPENROUTER_KEY,
      OPENAI_API_KEY: OPENAI_KEY,
    },
    http,
  });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });
  const seeded = (await api<Provider[]>('/admin/api/providers')).body;
  ids.openrouter = seeded.find((p) => p.name === 'openrouter')!.id;
  await api('/admin/api/settings', 'PATCH', { capture_payloads: true });
});

afterAll(async () => {
  await server?.stop(true);
  gateway?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('OpenRouter, as it answered live', () => {
  test('the fake refuses what the gateway used to send, keyed score criteria, with the live 400', async () => {
    const keyed = {
      model: 'perplexity/pplx-decider-flash-v1.2',
      state: 'x',
      questions: {
        q0: { type: 'score', instructions: 'How urgent?', criteria: { l0: 'a', l1: 'b' } },
      },
    };
    const r = fakeOpenRouter(new Headers({ authorization: `Bearer ${OPENROUTER_KEY}` }), keyed);
    expect(r.status).toBe(live.score_with_keyed_criteria_rejected.status);
    expect(await r.json()).toEqual({ error: live.score_with_keyed_criteria_rejected.error });
  });

  test('the live decision: the body OpenRouter took, its answer in OpenAI shape, billed and served by Perplexity', async () => {
    const r = await decide({
      model: 'openrouter::perplexity/pplx-decider-flash-v1.2',
      ...liveDecision,
    });
    expect(r.status).toBe(200);
    expect(lastBody('openrouter.ai')).toEqual(live.request_choice_predicate);
    expect(r.body.answers).toEqual([
      {
        type: 'choice',
        name: 'team',
        choice: 'payments',
        probabilities: [
          { value: 'payments', probability: 0.8708197184652482 },
          { value: 'bugs', probability: 0.1291802815347518 },
        ],
        confidence: 0.7416394369304964,
        confidence_method: 'upstream',
      },
      { type: 'predicate', name: 'urgent', probability: 0.44030027324867504 },
    ]);
    expect(r.body.usage).toEqual({ input_tokens: 177, output_tokens: 2, total_tokens: 179 });
    expect(r.body.gateway).toMatchObject({
      provider: 'openrouter',
      upstream_model: 'perplexity/pplx-decider-flash-v1.2',
      served_by: 'Perplexity',
      upstream_model_resolved: 'perplexity/pplx-decider-flash-v1.2-20261016',
      cost_usd: 1.77e-6,
      cost_basis: 'upstream_cost',
      tokens: 177,
    });
    const logged = (await api<{ items: Log[] }>('/admin/api/logs?limit=1')).body.items[0];
    expect(logged).toMatchObject({
      status: 'ok',
      served_by: 'Perplexity',
      upstream_model_resolved: 'perplexity/pplx-decider-flash-v1.2-20261016',
      prompt_tokens: 177,
      cost_usd: 1.77e-6,
      cost_basis: 'upstream_cost',
      tokens: 177,
    });
  });

  test("a score goes as an ordered list, which OpenRouter takes, and the gateway's score agrees with its own", async () => {
    const r = await decide({ model: 'openrouter::typesafe/jev-1.13', ...documentedDecision });
    expect(r.status).toBe(200);
    const sent = lastBody('openrouter.ai') as { questions: Record<string, Json> };
    expect(sent.questions.q2).toEqual(documented.request_score.urgency);
    const [team, bug, urgency] = r.body.answers;
    expect(team).toMatchObject({ choice: 'payments', confidence: 0.75 });
    expect(bug).toEqual({ type: 'predicate', name: 'is_bug', probability: 0.96 });
    expect(urgency.probabilities).toEqual([
      { value: 0, label: 'later', probability: 0 },
      { value: 1, label: 'this-week', probability: 0.01 },
      { value: 2, label: 'now', probability: 0.99 },
    ]);
    expect(urgency.score).toBeCloseTo(documented.response.answers.urgency.score as number, 10);
    expect(r.body.gateway).toMatchObject({
      served_by: 'TypeSafe',
      upstream_model_resolved: 'typesafe/jev-1.13-20260917',
      cost_usd: 0.000019992,
      cost_basis: 'upstream_cost',
      tokens: 476,
    });
  });

  test('a billed cost wins over the catalog price and the step price', async () => {
    expect((await api(`/admin/api/providers/${ids.openrouter}/models`)).status).toBe(200);
    const route = await api('/admin/api/routes', 'POST', {
      alias: 'decider',
      description: 'Perplexity Decider Flash via OpenRouter',
      enabled: true,
      targets: [
        {
          provider_id: ids.openrouter,
          model: 'perplexity/pplx-decider-flash-v1.2',
          price_per_m_input: 5,
        },
      ],
    });
    expect(route.status).toBe(200);
    const r = await decide({ model: 'decider', ...liveDecision });
    expect(r.body.gateway).toMatchObject({ cost_usd: 1.77e-6, cost_basis: 'upstream_cost' });
  });

  test('the playground trace shows the ordered criteria sent and the raw answer with its cost', async () => {
    const play = await api<{
      response: DecisionResponse | null;
      trace: { upstream_request: { questions: Record<string, Json> }; upstream_response: Json };
    }>('/admin/api/playground', 'POST', {
      request: { model: 'openrouter::typesafe/jev-1.13', ...documentedDecision },
    });
    expect(play.body.response?.gateway.served_by).toBe('TypeSafe');
    expect(play.body.trace.upstream_request.questions.q2.criteria).toEqual(
      documented.request_score.urgency.criteria,
    );
    expect(play.body.trace.upstream_response).toMatchObject({
      provider: 'TypeSafe',
      usage: { cost: 0.000019992 },
    });
  });
});

describe('OpenAI, as it answered live', () => {
  test("the request OpenAI answered goes out unchanged, and its answer comes back in OpenAI's own shape", async () => {
    const r = await decide({ ...openai.trace.upstream_request, model: 'openai::gpt-6-luna' });
    expect(r.status).toBe(200);
    expect(lastBody('api.openai.com')).toEqual(openai.trace.upstream_request);
    const upstream = openai.trace.upstream_response;
    // The same answers, field for field, with the gateway's confidence_method beside each confidence.
    expect(r.body.answers as unknown).toEqual(
      upstream.answers.map((answer) =>
        'confidence' in answer ? { ...answer, confidence_method: 'upstream' } : answer,
      ),
    );
    expect(r.body.usage as unknown).toEqual(upstream.usage);
    // OpenAI reports no cost, so its 394 input tokens are priced at the built-in $0.10 per million.
    expect(r.body.gateway).toMatchObject({
      provider: 'openai',
      served_by: null,
      upstream_model_resolved: 'gpt-6-luna',
      cost_usd: 0.0000394,
      cost_basis: 'upstream_tokens',
      tokens: 394,
    });
  });
});

describe('stats over billed costs', () => {
  test('the window sums every logged cost, billed ones included, and nothing went unpriced', async () => {
    const logs = (await api<{ items: Log[] }>('/admin/api/logs?limit=1000')).body.items;
    const stats = (await api<{ cost_usd: number; unpriced: number }>('/admin/api/stats?window=1h'))
      .body;
    expect(logs.filter((l) => l.cost_basis === 'upstream_cost').length).toBe(4);
    expect(stats.cost_usd).toBeCloseTo(
      logs.reduce((sum, l) => sum + (l.cost_usd ?? 0), 0),
      8,
    );
    expect(stats.unpriced).toBe(0);
  });
});
