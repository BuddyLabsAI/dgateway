import { describe, expect, test } from 'bun:test';
import {
  chargeFor,
  costUsd,
  estimateTokens,
  resolvePrice,
  round8,
} from '../../src/modules/gateway/libs/decisions/functions/pricing';
import { validateRequest } from '../../src/modules/gateway/libs/decisions/functions/validation';
import type {
  DecisionResponse,
  DecisionRequest,
} from '../../src/modules/gateway/libs/decisions/schemas/types';
import type { DecisionResult } from '../../src/modules/gateway/libs/decisions/schemas/execution';
import { stats } from '../../src/modules/gateway/libs/management/functions/stats';
import {
  catalogPrice,
  lastTestRecord,
  mapModels,
  providerView,
  readLog,
  routeDraft,
  type LegacyLog,
} from '../../src/modules/gateway/libs/management/functions/admin';
import {
  seedProviders,
  seedRoutes,
} from '../../src/modules/gateway/libs/management/functions/seed';
import type { Log, Provider } from '../../src/modules/gateway/libs/management/schemas/types';
import type { Route } from '../../src/modules/gateway/libs/routing/schemas/types';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');

const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function entry(id: string, minutes: number, fields: Partial<Log>): Log {
  return {
    id,
    ts: at(minutes),
    route: 'luna',
    provider: 'openai',
    upstream_model: 'gpt-6-luna',
    served_by: null,
    upstream_model_resolved: null,
    status: 'ok',
    fallback_used: false,
    http_status: 200,
    latency_ms: 100,
    questions: 1,
    prompt_tokens: null,
    cost_usd: null,
    cost_basis: null,
    tokens: null,
    error: null,
    attempts: [],
    ...fields,
  };
}

// Eight estimated tokens: 'hello' (5) plus 'test' (4) plus 'pick' (4) plus 'yes' and 'no' (5) and 'score' (5)
// and 'low' and 'high' (7) is 30 characters. Names and choice values are not counted.
const sample: DecisionRequest = validateRequest({
  input: 'hello',
  questions: [
    { name: 'a_long_question_name', type: 'predicate', instructions: 'test' },
    {
      name: 'c',
      type: 'choice',
      instructions: 'pick',
      choices: [
        { value: 'a-long-value-that-is-not-counted', description: 'yes' },
        { value: false, description: 'no' },
      ],
    },
    {
      name: 's',
      type: 'score',
      instructions: 'score',
      levels: [{ description: 'low' }, { label: 'hi', description: 'high' }],
    },
  ],
});

describe('price resolution order: target, then kind default, then unpriced', () => {
  test('a target price overrides the kind default, and 0 counts as a price', () => {
    expect(resolvePrice({ kind: 'mock', model: 'mock-1', target: 0.5, catalog: null })).toEqual({
      perMillion: 0.5,
    });
    expect(
      resolvePrice({ kind: 'openai-compatible', model: 'm', target: 0, catalog: null }),
    ).toEqual({ perMillion: 0 });
  });

  test('without a target price, the kind default applies', () => {
    expect(resolvePrice({ kind: 'mock', model: 'mock-1', target: null, catalog: null })).toEqual({
      perMillion: 0,
    });
    expect(
      resolvePrice({
        kind: 'systemone',
        model: 'server-configured',
        target: undefined,
        catalog: null,
        local: true,
      }),
    ).toBeNull();
    expect(
      resolvePrice({ kind: 'openai', model: 'gpt-6-luna', target: undefined, catalog: null }),
    ).toEqual({ perMillion: 0.1, cached: 0.01, write: 0.125 });
    expect(
      resolvePrice({ kind: 'openrouter', model: 'baseten/elephant-1', target: null, catalog: 2 }),
    ).toEqual({ perMillion: 2 });
  });

  test('a target price beats the catalog, and a null target falls through to it', () => {
    expect(
      resolvePrice({ kind: 'openrouter', model: 'm', target: 1, catalog: 2 })?.perMillion,
    ).toBe(1);
    expect(
      resolvePrice({ kind: 'openrouter', model: 'm', target: null, catalog: 2 })?.perMillion,
    ).toBe(2);
  });

  test('openrouter with a cold catalog is unpriced, not an error', () => {
    expect(
      resolvePrice({
        kind: 'openrouter',
        model: 'baseten/elephant-1',
        target: undefined,
        catalog: null,
      }),
    ).toBeNull();
  });

  test('the built-in openai table covers only its own models', () => {
    expect(
      resolvePrice({ kind: 'openai', model: 'gpt-7', target: undefined, catalog: null }),
    ).toBeNull();
    expect(
      resolvePrice({ kind: 'openai', model: 'constructor', target: undefined, catalog: null }),
    ).toBeNull();
  });

  test('openai-compatible has no default, and the catalog is only read for openrouter', () => {
    expect(
      resolvePrice({ kind: 'openai-compatible', model: 'm', target: undefined, catalog: 5 }),
    ).toBeNull();
  });

  test('an unusable price is ignored, so it cannot produce a negative or non-finite cost', () => {
    expect(
      resolvePrice({ kind: 'openrouter', model: 'm', target: Number.NaN, catalog: -1 }),
    ).toBeNull();
    expect(
      resolvePrice({ kind: 'mock', model: 'm', target: Number.POSITIVE_INFINITY, catalog: null }),
    ).toEqual({ perMillion: 0 });
  });
});

describe('token estimation', () => {
  test('counts the input, the instructions and the option or level descriptions, and nothing else', () => {
    expect(estimateTokens(sample)).toBe(8);
  });

  test('counts characters rather than UTF-16 units, and rounds up', () => {
    const emoji = validateRequest({
      input: '😀😀😀😀😀',
      questions: [{ name: 'p', type: 'predicate', instructions: 'x' }],
    });
    expect(estimateTokens(emoji)).toBe(2);
    const four = validateRequest({
      input: 'abcd',
      questions: [{ name: 'p', type: 'predicate', instructions: 'efgh' }],
    });
    expect(estimateTokens(four)).toBe(2);
    const five = validateRequest({
      input: 'abcd',
      questions: [{ name: 'p', type: 'predicate', instructions: 'e' }],
    });
    expect(estimateTokens(five)).toBe(2);
    const exact = validateRequest({
      input: 'abc',
      questions: [{ name: 'p', type: 'predicate', instructions: 'd' }],
    });
    expect(estimateTokens(exact)).toBe(1);
  });
});

describe('cost rounding', () => {
  test('a cost is tokens over a million times the price', () => {
    expect(costUsd(120, 0.035)).toBe(0.0000042);
    expect(costUsd(1_000_000, 0.1)).toBe(0.1);
    expect(costUsd(0, 5)).toBe(0);
  });

  test('costs and sums are rounded to 8 decimals', () => {
    expect(round8(0.123456789)).toBe(0.12345679);
    expect(round8(0.1 + 0.2)).toBe(0.3);
    expect(costUsd(3, 0.1)).toBe(0.0000003);
  });
});

describe('the charge for an answered attempt', () => {
  test('upstream usage gives the upstream token count and the upstream basis', () => {
    expect(
      chargeFor({
        kind: 'openai-compatible',
        model: 'm',
        target: 2,
        catalog: null,
        usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
        request: sample,
      }),
    ).toMatchObject({ tokens: 9, cost_usd: 0.000018, cost_basis: 'upstream_tokens' });
  });

  test('without usage, the estimate is charged with the estimated basis', () => {
    expect(
      chargeFor({
        kind: 'openai-compatible',
        model: 'm',
        target: 4,
        catalog: null,
        usage: null,
        request: sample,
      }),
    ).toMatchObject({ tokens: 8, cost_usd: 0.000032, cost_basis: 'estimated_tokens' });
  });

  test('the mock zero rate uses the estimated or upstream token basis without a bill', () => {
    expect(
      chargeFor({
        kind: 'mock',
        model: 'mock-1',
        target: undefined,
        catalog: null,
        usage: null,
        request: sample,
      }),
    ).toMatchObject({ tokens: 8, cost_usd: 0, cost_basis: 'estimated_tokens' });
    expect(
      chargeFor({
        kind: 'mock',
        model: 'mock-1',
        target: undefined,
        catalog: null,
        usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
        request: sample,
      }),
    ).toMatchObject({ tokens: 9, cost_usd: 0, cost_basis: 'upstream_tokens' });
  });

  test('an unpriced attempt has no cost but keeps its token count', () => {
    expect(
      chargeFor({
        kind: 'openai-compatible',
        model: 'm',
        target: undefined,
        catalog: null,
        usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
        request: sample,
      }),
    ).toMatchObject({ tokens: 9, cost_usd: null, cost_basis: 'unpriced' });
  });
});

describe('the cached-input discount on the built-in openai price', () => {
  // A gpt-6-luna answer with 1,000 input tokens (or the count given) and the given input token details.
  const gpt = (details: unknown, input = 1000) =>
    chargeFor({
      kind: 'openai',
      model: 'gpt-6-luna',
      target: undefined,
      catalog: null,
      usage: {
        input_tokens: input,
        output_tokens: 0,
        total_tokens: input,
        input_tokens_details: details as Record<string, number>,
      },
      request: sample,
    });

  test('with no cached or written tokens, every input token is charged at the input rate', () => {
    // The live Decisions usage: 394 input tokens, none cached or written.
    expect(
      chargeFor({
        kind: 'openai',
        model: 'gpt-6-luna',
        target: undefined,
        catalog: null,
        usage: {
          input_tokens: 394,
          output_tokens: 0,
          total_tokens: 394,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        request: sample,
      }),
    ).toMatchObject({ tokens: 394, cost_usd: 0.0000394, cost_basis: 'upstream_tokens' });
    expect(gpt(undefined)).toMatchObject({
      tokens: 1000,
      cost_usd: 0.0001,
      cost_basis: 'upstream_tokens',
    });
  });

  test('cached reads and cache writes take their own rates, and the rest of the input the input rate', () => {
    // 300 ordinary tokens at 0.10, 600 cached at 0.01 and 100 written at 0.125, all per million.
    expect(gpt({ cached_tokens: 600, cache_write_tokens: 100 })).toMatchObject({
      tokens: 1000,
      cost_usd: 0.0000485,
      cost_basis: 'upstream_tokens',
    });
  });

  test('a fully cached input costs a tenth of the input rate, and a fully written one 1.25 times it', () => {
    expect(gpt({ cached_tokens: 1000, cache_write_tokens: 0 }).cost_usd).toBe(0.00001);
    expect(gpt({ cached_tokens: 0, cache_write_tokens: 1000 }).cost_usd).toBe(0.000125);
  });

  test('counts that add up to exactly the input tokens are valid', () => {
    // 700 cached at 0.01 and 300 written at 0.125, per million, with no ordinary input left.
    expect(gpt({ cached_tokens: 700, cache_write_tokens: 300 }).cost_usd).toBe(0.0000445);
  });

  test('an estimate has no details, so it is charged at the input rate', () => {
    expect(
      chargeFor({
        kind: 'openai',
        model: 'gpt-6-luna',
        target: undefined,
        catalog: null,
        usage: null,
        request: sample,
      }),
    ).toMatchObject({ tokens: 8, cost_usd: 0.0000008, cost_basis: 'estimated_tokens' });
  });

  test("a step's own price is a flat rate on every input token, cached or not", () => {
    expect(
      chargeFor({
        kind: 'openai',
        model: 'gpt-6-luna',
        target: 0.5,
        catalog: null,
        usage: {
          input_tokens: 1000,
          output_tokens: 0,
          total_tokens: 1000,
          input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
        },
        request: sample,
      }),
    ).toMatchObject({ tokens: 1000, cost_usd: 0.0005, cost_basis: 'upstream_tokens' });
  });

  test('a price with no known cache rate ignores the cached counts', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 1,
      total_tokens: 1001,
      input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
    };
    // An openrouter catalog price and an openai-compatible hint price have no cache rates.
    expect(
      chargeFor({
        kind: 'openrouter',
        model: 'm',
        target: null,
        catalog: 2,
        usage,
        request: sample,
      }),
    ).toMatchObject({ tokens: 1000, cost_usd: 0.002, cost_basis: 'upstream_tokens' });
    expect(
      chargeFor({
        kind: 'openai-compatible',
        model: 'm',
        target: undefined,
        catalog: null,
        hint: 3,
        usage,
        request: sample,
      }),
    ).toMatchObject({ tokens: 1000, cost_usd: 0.003, cost_basis: 'upstream_tokens' });
  });

  test('malformed details are ignored, and every input token is charged at the input rate', () => {
    const malformed: unknown[] = [
      { cached_tokens: -1 },
      { cached_tokens: 2.5 },
      { cached_tokens: Number.NaN },
      { cached_tokens: '600' },
      { cached_tokens: 600, cache_write_tokens: null },
      { cached_tokens: 600, cache_write_tokens: -5 },
      { cached_tokens: 900, cache_write_tokens: 200 },
      null,
      'cached',
      [600],
    ];
    for (const details of malformed)
      expect(gpt(details)).toMatchObject({
        tokens: 1000,
        cost_usd: 0.0001,
        cost_basis: 'upstream_tokens',
      });
  });
});

describe('stats sums', () => {
  const logs = [
    entry('a', 5, {
      provider: 'openai',
      route: 'luna',
      cost_usd: 0.1,
      cost_basis: 'upstream_tokens',
    }),
    entry('b', 5, {
      provider: 'openai',
      route: 'elephant',
      cost_usd: 0.2,
      cost_basis: 'estimated_tokens',
    }),
    entry('c', 40, {
      provider: 'mock',
      route: 'default',
      cost_usd: 0,
      cost_basis: 'upstream_cost',
    }),
    entry('d', 10, {
      provider: 'openrouter',
      route: 'elephant',
      cost_usd: null,
      cost_basis: 'unpriced',
    }),
    entry('e', 15, {
      provider: 'openrouter',
      route: 'elephant',
      status: 'error',
      http_status: 502,
      error: 'upstream HTTP 500',
    }),
  ];

  test('window, bucket, provider and route sums add up the priced requests', () => {
    const summary = stats(logs, '1h', NOW);
    expect(summary.cost_usd).toBe(0.3);
    expect(summary.unpriced).toBe(1);
    expect(summary.timeseries.reduce((sum, b) => sum + b.cost_usd, 0)).toBe(0.3);
    expect(summary.timeseries[22]?.cost_usd).toBe(0.3);
    expect(summary.timeseries.filter((b) => b.requests === 0).every((b) => b.cost_usd === 0)).toBe(
      true,
    );
    // The group entries name their key dynamically, so the type does not show it. Read them as records.
    const byProvider: Record<string, unknown>[] = summary.by_provider;
    const byRoute: Record<string, unknown>[] = summary.by_route;
    expect(byProvider.find((p) => p.provider === 'openai')?.cost_usd).toBe(0.3);
    expect(byProvider.find((p) => p.provider === 'openrouter')?.cost_usd).toBe(0);
    expect(byProvider.find((p) => p.provider === 'mock')?.cost_usd).toBe(0);
    expect(byRoute.find((r) => r.route === 'luna')?.cost_usd).toBe(0.1);
    expect(byRoute.find((r) => r.route === 'elephant')?.cost_usd).toBe(0.2);
    expect(byRoute.find((r) => r.route === 'default')?.cost_usd).toBe(0);
  });

  test('an unpriced answer is counted as unpriced, and a failed request is not', () => {
    const summary = stats(
      [
        entry('answered-unpriced', 5, { cost_basis: 'unpriced' }),
        entry('failed', 5, { status: 'error', cost_basis: null }),
      ],
      '1h',
      NOW,
    );
    expect(summary.unpriced).toBe(1);
    expect(summary.errors).toBe(1);
  });

  test('sums are 0, never null, when nothing is priced', () => {
    const none = stats([entry('x', 5, { status: 'error' })], '1h', NOW);
    expect(none.cost_usd).toBe(0);
    expect(none.by_provider[0]?.cost_usd).toBe(0);
    expect(none.timeseries.every((b) => b.cost_usd === 0)).toBe(true);
    const empty = stats([], '24h', NOW);
    expect(empty.cost_usd).toBe(0);
    expect(empty.unpriced).toBe(0);
  });

  test('logs written before cost tracking read as null and add nothing', () => {
    const legacy: LegacyLog = {
      id: 'old',
      ts: at(5),
      route: 'luna',
      provider: 'openai',
      upstream_model: 'gpt-6-luna',
      status: 'ok',
      fallback_used: false,
      http_status: 200,
      latency_ms: 100,
      questions: 1,
      prompt_tokens: 9,
      error: null,
      attempts: [],
    };
    const read = readLog(legacy);
    expect(read).toMatchObject({
      cost_usd: null,
      cost_basis: null,
      tokens: null,
      prompt_tokens: 9,
      served_by: null,
      upstream_model_resolved: null,
    });
    const summary = stats([read], '1h', NOW);
    expect(summary.cost_usd).toBe(0);
    expect(summary.unpriced).toBe(0);
  });
});

describe('last test shaping', () => {
  const billing = {
    type: 'choice' as const,
    name: 'department',
    choice: 'billing',
    probabilities: [
      { value: 'billing', probability: 0.97 },
      { value: 'technical', probability: 0.02 },
      { value: 'other', probability: 0.01 },
    ],
  };
  const success = {
    response: { answers: [billing] } as unknown as DecisionResponse,
    status: 200,
    trace: { attempts: [], upstream_request: null, upstream_response: null },
  } satisfies DecisionResult;
  const failure = {
    response: null,
    error: { message: 'upstream HTTP 500', type: 'upstream_error' },
    status: 502,
    trace: { attempts: [], upstream_request: null, upstream_response: null },
  } satisfies DecisionResult;
  const routed = {
    model: 'baseten/elephant-1',
    reason: 'used_by_route' as const,
    route: 'elephant',
  };
  const placeholder = { model: 'mock-1', reason: 'first_listed' as const, route: null };

  test('a success records ok with no error, why the model was tested, and whether it matched', () => {
    expect(lastTestRecord(success, routed, 1000, 1312)).toEqual({
      ok: true,
      at: new Date(1000).toISOString(),
      latency_ms: 312,
      model: 'baseten/elephant-1',
      model_reason: 'used_by_route',
      matched: true,
      error: null,
    });
  });

  test('a failure is recorded too, with its message, and never matches', () => {
    expect(lastTestRecord(failure, placeholder, 1000, 1100)).toEqual({
      ok: false,
      at: new Date(1000).toISOString(),
      latency_ms: 100,
      model: 'mock-1',
      model_reason: 'first_listed',
      matched: false,
      error: 'upstream HTTP 500',
    });
  });

  test('latency is never negative', () => {
    expect(lastTestRecord(success, placeholder, 2000, 1000).latency_ms).toBe(0);
  });

  test('a provider read carries last_test, null until the provider has been tested', () => {
    const [provider] = seedProviders('2026-01-01T00:00:00.000Z', [
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
    expect(providerView(provider, false).last_test).toBeNull();
    const tested: Provider = {
      ...provider,
      last_test: lastTestRecord(failure, placeholder, 1000, 1100),
    };
    expect(providerView(tested, false).last_test?.error).toBe('upstream HTTP 500');
  });

  test('a last test recorded before model_reason and matched existed reads them as null', () => {
    const [provider] = seedProviders('2026-01-01T00:00:00.000Z', [
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
    const old = {
      ok: true,
      at: new Date(1000).toISOString(),
      latency_ms: 5,
      model: 'm',
      error: null,
    };
    expect(providerView({ ...provider, last_test: old }, false).last_test).toEqual({
      ...old,
      model_reason: null,
      matched: null,
    });
  });
});

describe('route target prices', () => {
  const providers = seedProviders('2026-01-01T00:00:00.000Z', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const ids = Object.fromEntries(providers.map((p) => [p.name, p.id]));
  const routes: Route[] = seedRoutes('2026-01-01T00:00:00.000Z', ids, ['r1', 'r2', 'r3']);

  const withPrice = (price: unknown) =>
    routeDraft(
      {
        targets: [
          { provider_id: ids.openrouter, model: 'baseten/elephant-1', price_per_m_input: price },
        ],
      },
      routes[2],
      providers,
      routes,
    );

  test('a price may be absent, null, 0 or any number of at least 0', () => {
    expect(
      routeDraft(
        { targets: [{ provider_id: ids.openrouter, model: 'm' }] },
        routes[2],
        providers,
        routes,
      ).targets,
    ).toEqual([{ provider_id: ids.openrouter, model: 'm' }]);
    expect(withPrice(null).targets).toEqual([
      { provider_id: ids.openrouter, model: 'baseten/elephant-1', price_per_m_input: null },
    ]);
    expect(withPrice(0).targets).toEqual([
      { provider_id: ids.openrouter, model: 'baseten/elephant-1', price_per_m_input: 0 },
    ]);
    expect(withPrice(0.035).targets).toEqual([
      { provider_id: ids.openrouter, model: 'baseten/elephant-1', price_per_m_input: 0.035 },
    ]);
  });

  test('a negative, non-numeric or non-finite price is refused', () => {
    for (const bad of [-0.01, '0.5', Number.NaN, Number.POSITIVE_INFINITY, true])
      expect(() => withPrice(bad)).toThrow('price_per_m_input must be a number');
  });
});

describe('catalog prices and model listings', () => {
  test('a model price comes from the cached catalog, and is absent without one', () => {
    const entry = { expires: 10, models: [{ id: 'baseten/elephant-1', price_per_m_input: 2 }] };
    expect(catalogPrice(entry, 'baseten/elephant-1').input).toBe(2);
    expect(catalogPrice(entry, 'other').input).toBeNull();
    expect(
      catalogPrice({ expires: 10, models: [{ id: 'free-model' }] }, 'free-model').input,
    ).toBeNull();
    expect(catalogPrice(undefined, 'baseten/elephant-1').input).toBeNull();
  });

  test('catalog prices that are missing, blank, negative or null give no price', () => {
    const listed = mapModels({
      data: [
        { id: 'varies', pricing: { prompt: '-1' } },
        { id: 'null-price', pricing: { prompt: null } },
        { id: 'blank-price', pricing: { prompt: '  ' } },
        { id: 'no-pricing' },
        { id: 'free', pricing: { prompt: '0' } },
      ],
    });
    expect(listed.map((m) => [m.id, m.price_per_m_input])).toEqual([
      ['varies', undefined],
      ['null-price', undefined],
      ['blank-price', undefined],
      ['no-pricing', undefined],
      ['free', 0],
    ]);
  });
});

test('legacy free log rows are read-only history and count as unpriced', () => {
  const legacy = Object.freeze({
    ...entry('legacy', 5, {
      provider: 'llamacpp',
      route: 'local',
      cost_usd: 0,
      cost_includes_output: true,
      tokens: 9,
    }),
    cost_basis: 'free' as const,
  });
  const read = readLog(legacy);
  expect(read).toMatchObject({
    cost_basis: 'unpriced',
    cost_usd: 0,
    cost_includes_output: true,
    tokens: 9,
  });
  expect(legacy.cost_basis).toBe('free');
  const summary = stats([read], '1h', NOW);
  expect(summary).toMatchObject({ cost_usd: 0, unpriced: 1, output_unpriced: 0 });
  expect(summary.by_provider).toMatchObject([{ provider: 'llamacpp', cost_usd: 0, unpriced: 1 }]);
  expect(summary.by_route).toMatchObject([{ route: 'local', cost_usd: 0, unpriced: 1 }]);
});
