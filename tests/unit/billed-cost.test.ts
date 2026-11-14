// What a provider billed and who served the answer: the upstream_cost basis, the served_by and
// upstream_model_resolved fields of a response and a log entry, stats over billed costs, and the mock upstream, which
// answers in the real SystemOne shapes so it runs through the same parser as a real provider.
import { describe, expect, test } from 'bun:test';
import { openai, openrouter } from '../fixtures/upstreams';
import { CallFailure } from '../../src/modules/gateway/libs/decisions/schemas/execution';
import { GatewayError } from '../../src/modules/gateway/libs/decisions/schemas/types';
import { validateRequest } from '../../src/modules/gateway/libs/decisions/functions/validation';
import {
  chargeFor,
  estimateTokens,
} from '../../src/modules/gateway/libs/decisions/functions/pricing';
import { fromUpstream } from '../../src/modules/gateway/libs/decisions/functions/translation';
import {
  failedOutcome,
  finalize,
  initialState,
  reduceAttempt,
  succeededOutcome,
  upstreamBody,
} from '../../src/modules/gateway/libs/decisions/functions/execution';
import { rejectionLog } from '../../src/modules/gateway/libs/decisions/functions/public';
import { callUpstream } from '../../src/modules/gateway/libs/decisions/providers/upstream';
import { mockUpstream } from '../../src/modules/gateway/libs/decisions/providers/mock';
import { readLog, type LegacyLog } from '../../src/modules/gateway/libs/management/functions/admin';
import {
  seedProviders,
  seedRoutes,
} from '../../src/modules/gateway/libs/management/functions/seed';
import { stats } from '../../src/modules/gateway/libs/management/functions/stats';
import type { Log } from '../../src/modules/gateway/libs/management/schemas/types';

const live = openrouter.captured_2026_11_08_live;
const providers = seedProviders('2026-01-01T00:00:00.000Z', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
const routes = seedRoutes(
  '2026-01-01T00:00:00.000Z',
  Object.fromEntries(providers.map((p) => [p.name, p.id])),
  ['r1', 'r2', 'r3'],
);
const settings = { require_client_keys: false, capture_payloads: true, default_route: 'default' };
const values = {
  start: 0,
  end: 20,
  created: 1000,
  timestamp: 1000,
  responseId: 'dec_1',
  logId: 'log_1',
};

const request = validateRequest({
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
});

const mixed = validateRequest({
  input: 'Checkout fails for every customer.',
  questions: [
    {
      name: 'team',
      type: 'choice',
      instructions: 'Which team?',
      choices: [
        { value: 'web', description: 'The web app' },
        { value: true, description: 'Payments' },
      ],
    },
    { name: 'bug', type: 'predicate', instructions: 'Is it a bug?' },
    {
      name: 'urgency',
      type: 'score',
      instructions: 'How urgent?',
      levels: [{ description: 'Later' }, { description: 'This week' }, { description: 'Now' }],
    },
  ],
});

describe('the cost a provider billed', () => {
  const parsed = fromUpstream(live.response_choice_predicate, request, 'map');
  const base = {
    kind: 'openrouter' as const,
    model: 'perplexity/pplx-decider-flash-v1.2',
    request,
  };

  test('is the charge, with the input tokens, whatever the catalog or a step price says', () => {
    const billed = {
      tokens: 177,
      cost_usd: 1.77e-6,
      cost_basis: 'upstream_cost' as const,
      cost_includes_output: true,
    };
    for (const prices of [
      { target: null, catalog: null },
      { target: null, catalog: 0.01 },
      { target: 2, catalog: 0.01 },
    ])
      expect(chargeFor({ ...base, ...prices, usage: parsed.usage, billed: parsed.billed })).toEqual(
        billed,
      );
  });

  test('beats a zero mock default too, and a billed 0 stays 0 with its basis', () => {
    expect(
      chargeFor({
        kind: 'mock',
        model: 'mock-1',
        target: null,
        catalog: null,
        usage: null,
        billed: 0,
        request,
      }),
    ).toMatchObject({ tokens: estimateTokens(request), cost_usd: 0, cost_basis: 'upstream_cost' });
  });

  test('without a billed cost the price applies as before; OpenAI is priced on its input tokens', () => {
    const upstream = openai.trace.upstream_response;
    const answered = fromUpstream(
      upstream,
      validateRequest({ ...openai.trace.upstream_request, model: 'luna' }),
      'openai',
    );
    // 394 input tokens at the built-in $0.10 per million. Cached tokens get no discount here.
    expect(
      chargeFor({
        kind: 'openai',
        model: 'gpt-6-luna',
        target: null,
        catalog: null,
        usage: answered.usage,
        billed: answered.billed,
        request,
      }),
    ).toMatchObject({ tokens: 394, cost_usd: 0.0000394, cost_basis: 'upstream_tokens' });
    expect(
      chargeFor({ ...base, target: null, catalog: null, usage: parsed.usage, billed: null }),
    ).toMatchObject({ tokens: 177, cost_usd: null, cost_basis: 'unpriced' });
  });

  test('a cost that is not a usable number is not a billed cost', () => {
    for (const billed of [Number.NaN, -1, undefined])
      expect(
        chargeFor({ ...base, target: 1, catalog: null, usage: parsed.usage, billed }).cost_basis,
      ).toBe('upstream_tokens');
  });
});

describe('who served the answer', () => {
  const start = () => initialState('default', settings, routes, providers).state;

  test('is in the response and its log entry, beside the billed cost', () => {
    const parsed = fromUpstream(live.response_choice_predicate, request, 'map');
    const charge = chargeFor({
      ...{ kind: 'openrouter' as const, model: 'm', target: null, catalog: null },
      usage: parsed.usage,
      billed: parsed.billed,
      request,
    });
    const state = reduceAttempt(
      start(),
      succeededOutcome(
        'openrouter',
        'perplexity/pplx-decider-flash-v1.2',
        0,
        20,
        {},
        live.response_choice_predicate,
        null,
        parsed,
        charge,
      ),
    );
    const { result, log } = finalize(state, request, settings, values);
    expect(result.response?.gateway).toMatchObject({
      provider: 'openrouter',
      upstream_model: 'perplexity/pplx-decider-flash-v1.2',
      served_by: 'Perplexity',
      upstream_model_resolved: 'perplexity/pplx-decider-flash-v1.2-20261016',
      cost_usd: 1.77e-6,
      cost_basis: 'upstream_cost',
      tokens: 177,
    });
    expect(result.response?.usage).toEqual({
      input_tokens: 177,
      output_tokens: 2,
      total_tokens: 179,
    });
    expect(log).toMatchObject({
      served_by: 'Perplexity',
      upstream_model_resolved: 'perplexity/pplx-decider-flash-v1.2-20261016',
      prompt_tokens: 177,
      cost_basis: 'upstream_cost',
    });
  });

  test('is null when the upstream does not say, when the request fails, and on old log rows', () => {
    const quiet = fromUpstream(
      { answers: { q0: { choice: 'o0', probabilities: { o0: 1, o1: 0 } }, q1: { noul: 0.2 } } },
      request,
      'map',
    );
    const state = reduceAttempt(
      start(),
      succeededOutcome('p', 'm', 0, 1, {}, {}, null, quiet, {
        tokens: 1,
        cost_usd: null,
        cost_basis: 'unpriced',
        cost_includes_output: false,
      }),
    );
    expect(finalize(state, request, settings, values).result.response?.gateway).toMatchObject({
      served_by: null,
      upstream_model_resolved: null,
    });
    const failed = finalize(
      reduceAttempt(start(), failedOutcome('p', 'm', 0, 1, new CallFailure('http', 'boom', 500))),
      request,
      settings,
      values,
    );
    expect(failed.log).toMatchObject({ served_by: null, upstream_model_resolved: null });
    const rejected = rejectionLog(
      0,
      new GatewayError(401, 'authentication_error', 'no'),
      null,
      settings,
      'x',
      1,
      1,
    );
    expect(rejected).toMatchObject({ served_by: null, upstream_model_resolved: null });
    const legacy = { ...rejected } as LegacyLog;
    delete legacy.served_by;
    delete legacy.upstream_model_resolved;
    expect(readLog(legacy)).toMatchObject({ served_by: null, upstream_model_resolved: null });
  });
});

describe('stats over billed costs', () => {
  const NOW = Date.parse('2026-11-08T12:00:00.000Z');

  function entry(id: string, fields: Partial<Log>): Log {
    return {
      ...rejectionLog(
        0,
        new GatewayError(400, 'invalid_request_error', 'x'),
        null,
        settings,
        id,
        NOW - 60_000,
        NOW - 60_000,
      ),
      status: 'ok',
      http_status: 200,
      provider: 'openrouter',
      route: 'elephant',
      error: null,
      ...fields,
    };
  }

  test('add billed amounts to the sums, and never count them as unpriced', () => {
    const summary = stats(
      [
        entry('billed', { cost_usd: 1.77e-6, cost_basis: 'upstream_cost', tokens: 177 }),
        entry('billed-zero', {
          provider: 'mock',
          route: 'default',
          cost_usd: 0,
          cost_basis: 'upstream_cost',
          tokens: 3,
        }),
        entry('priced', { cost_usd: 0.000042, cost_basis: 'upstream_tokens', tokens: 1000 }),
        entry('unpriced', { cost_usd: null, cost_basis: 'unpriced', tokens: 10 }),
      ],
      '1h',
      NOW,
    );
    expect(summary.cost_usd).toBe(0.00004377);
    expect(summary.unpriced).toBe(1);
    const byProvider: Record<string, unknown>[] = summary.by_provider;
    expect(byProvider.find((p) => p.provider === 'mock')).toMatchObject({
      cost_usd: 0,
      unpriced: 0,
    });
    expect(byProvider.find((p) => p.provider === 'openrouter')).toMatchObject({
      cost_usd: 0.00004377,
      unpriced: 1,
    });
  });
});

describe('the mock upstream', () => {
  const mock = providers.find((p) => p.name === 'mock')!;

  test('answers in the real SystemOne shapes, and the parser reads them like a real provider', async () => {
    const call = await callUpstream(mock, 'mock-1', mixed, null, 1000);
    expect(call.request).toEqual(upstreamBody(mock, 'mock-1', mixed));
    const body = call.body as {
      model: string;
      provider: string;
      id: string;
      answers: Record<string, Record<string, unknown>>;
      usage: Record<string, unknown>;
    };
    expect(body).toMatchObject({ model: 'mock-1', provider: 'Mock' });
    expect(body.id).toStartWith('gen-mock-');
    expect(Object.keys(body.answers.q0)).toEqual(['type', 'choice', 'probabilities', 'confidence']);
    expect(body.answers.q0.choice).toBeOneOf(['o0', 'o1']);
    expect(Object.keys(body.answers.q1)).toEqual(['type', 'noul']);
    expect(Object.keys(body.answers.q2)).toEqual([
      'type',
      'score',
      'probabilities',
      'legend',
      'confidence',
    ]);
    expect(Object.keys(body.answers.q2.probabilities as object)).toEqual(['0', '1', '2']);
    expect(body.answers.q2.legend).toEqual({ '0': 'Later', '1': 'This week', '2': 'Now' });
    // The input tokens it reports are the gateway's own estimate of the text it was sent.
    expect(body.usage).toEqual({ input_tokens: estimateTokens(mixed), output_tokens: 3, cost: 0 });
    const parsed = fromUpstream(body, mixed, 'map');
    expect(parsed.answers.map((a) => a.type)).toEqual(['choice', 'predicate', 'score']);
    expect(parsed.answers[0].confidence_method).toBe('upstream');
    expect(parsed.answers[2].score).toBeCloseTo(body.answers.q2.score as number, 10);
    expect(parsed).toMatchObject({ billed: 0, servedBy: 'Mock', resolvedModel: 'mock-1' });
  });

  test('is deterministic for the same input', async () => {
    const first = await callUpstream(mock, 'mock-1', mixed, null, 1000);
    const second = await callUpstream(mock, 'mock-1', mixed, null, 1000);
    expect(second.body).toEqual(first.body);
  });

  test('refuses score criteria sent as a keyed map with HTTP 400, as OpenRouter does', () => {
    const keyed = {
      state: 'x',
      questions: {
        q0: { type: 'score', instructions: 'How urgent?', criteria: { l0: 'Later', l1: 'Now' } },
      },
    };
    let caught: unknown;
    try {
      mockUpstream(keyed, 'mock-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CallFailure);
    expect(caught).toMatchObject({ kind: 'http', status: 400 });
    expect(JSON.stringify((caught as CallFailure).raw)).toContain(
      'expected array, received object',
    );
    expect(() =>
      mockUpstream({ state: 'x', questions: { q0: { type: 'maybe', instructions: 'x' } } }, 'm'),
    ).toThrow('upstream HTTP 400');
  });
});
