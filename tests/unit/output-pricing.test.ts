import { describe, expect, test } from 'bun:test';
import {
  chargeFor,
  defaultOutputPrice,
  defaultPriceInput,
  outputPrice,
  providerPricing,
} from '../../src/modules/gateway/libs/decisions/functions/pricing';
import {
  catalogPrice,
  mapModels,
  mergeHints,
  withDefaultPrices,
} from '../../src/modules/gateway/libs/management/functions/admin';
import type { DecisionRequest } from '../../src/modules/gateway/libs/decisions/schemas/types';

const request: DecisionRequest = {
  input: 'input',
  questions: [{ name: 'p', type: 'predicate', instructions: 'true?' }],
};
// 1000 input and 200 output tokens, 100 of them reasoning tokens that OpenAI counts inside output_tokens.
const base = {
  kind: 'openai' as const,
  model: 'gpt-6-luna',
  target: null,
  catalog: null,
  request,
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1200,
    output_tokens_details: { reasoning_tokens: 100 },
  },
};
const compat = { ...base, kind: 'openai-compatible' as const, model: 'other' };

describe('output price resolution', () => {
  test('the target price wins, then the default by kind, as for input', () => {
    expect(outputPrice({ ...base, targetOutput: 3, hintOutput: 4 })).toBe(3);
    expect(outputPrice({ ...base, targetOutput: null })).toBe(0.5);
    // The built-in table wins over a hint for a model it lists, as the input price does.
    expect(outputPrice({ ...base, hintOutput: 4 })).toBe(0.5);
    expect(outputPrice({ ...base, model: 'gpt-unknown', hintOutput: 4 })).toBe(4);
    expect(outputPrice({ ...base, model: 'gpt-unknown' })).toBeNull();
    expect(outputPrice({ ...compat, hintOutput: 4 })).toBe(4);
    expect(outputPrice(compat)).toBeNull();
    expect(outputPrice({ ...base, kind: 'openrouter', catalogOutput: 3, hintOutput: 9 })).toBe(3);
    expect(outputPrice({ ...base, kind: 'openrouter', catalogOutput: null })).toBeNull();
  });

  test('mock defaults to zero, local and hosted systemone use hints', () => {
    expect(defaultOutputPrice({ kind: 'mock', model: 'mock-1', catalog: null })).toBe(0);
    const local = { kind: 'systemone' as const, model: 'd1', catalog: null, hintOutput: 7 };
    expect(defaultOutputPrice({ ...local, local: true })).toBe(7);
    expect(defaultOutputPrice({ ...local, local: true, hintOutput: null })).toBeNull();
    expect(defaultOutputPrice({ ...local, local: false })).toBe(7);
    expect(defaultOutputPrice({ ...local, local: false, hintOutput: -1 })).toBeNull();
  });

  test('a provider contributes its hint output price', () => {
    const provider = {
      kind: 'openai-compatible' as const,
      base_url: 'https://example.com',
      wire: 'openai' as const,
      model_hints: [{ id: 'm', price_per_m_input: 2, price_per_m_output: 3 }],
    };
    expect(providerPricing(provider, 'm')).toMatchObject({ hint: 2, hintOutput: 3 });
    expect(providerPricing(provider, 'x')).toMatchObject({ hint: null, hintOutput: null });
  });
});

// OpenAI does not charge output tokens on its Decisions endpoint ("Output tokens are not charged.",
// https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability); Chat Completions keeps the model's
// output rate.
describe('native OpenAI Decisions output', () => {
  test('a built-in model is free of output on a native wire, and keeps its table rate on the chat wire', () => {
    expect(defaultOutputPrice({ ...base, wire: 'openai' })).toBe(0);
    expect(defaultOutputPrice({ ...base, wire: 'map' })).toBe(0);
    expect(defaultOutputPrice({ ...base, wire: 'chat' })).toBe(0.5);
    // A route's own output price still wins on a native wire.
    expect(outputPrice({ ...base, wire: 'openai', targetOutput: 3 })).toBe(3);
    // A model outside the table keeps its hint's output price, whatever the wire.
    expect(outputPrice({ ...base, wire: 'openai', model: 'gpt-unknown', hintOutput: 4 })).toBe(4);
  });

  test('a native call is charged for input only, and its cost says it covers output', () => {
    // 1000 input tokens at $0.10 per million; the 200 output tokens are free.
    expect(chargeFor({ ...base, wire: 'openai' })).toMatchObject({
      cost_usd: 0.0001,
      cost_basis: 'upstream_tokens',
      cost_includes_output: true,
    });
    // Without usage the output count is unknown, but free output is covered all the same.
    expect(chargeFor({ ...base, wire: 'openai', usage: null })).toMatchObject({
      cost_basis: 'estimated_tokens',
      cost_includes_output: true,
    });
    // A route output price applies: 200 output tokens at $3 per million.
    expect(chargeFor({ ...base, wire: 'openai', targetOutput: 3 })).toMatchObject({
      cost_usd: 0.0007,
      cost_includes_output: true,
    });
    // The chat wire keeps output pricing: 200 output tokens at $0.50 per million.
    expect(chargeFor({ ...base, wire: 'chat' })).toMatchObject({
      cost_usd: 0.0002,
      cost_includes_output: true,
    });
  });

  test('other vendors on a native wire keep their output price', () => {
    // OpenRouter's Decisions endpoint is priced from its catalog's completion price, on the map wire as on chat.
    const router = { ...base, kind: 'openrouter' as const, model: 'acme/m', catalogOutput: 0.4 };
    expect(defaultOutputPrice({ ...router, wire: 'map' })).toBe(0.4);
    expect(defaultOutputPrice({ ...router, wire: 'openai' })).toBe(0.4);
    expect(chargeFor({ ...router, wire: 'map', catalog: 0.1 })).toMatchObject({
      cost_usd: 0.00018,
      cost_includes_output: true,
    });
    // A hosted SystemOne vendor and an OpenAI-compatible server keep their hint's output price.
    const hinted = { ...base, model: 'm', hintOutput: 2 };
    expect(defaultOutputPrice({ ...hinted, kind: 'systemone', wire: 'map' })).toBe(2);
    expect(defaultOutputPrice({ ...hinted, kind: 'openai-compatible', wire: 'openai' })).toBe(2);
    // An unpriced OpenRouter output on a native wire leaves output out of the cost, and says so.
    expect(chargeFor({ ...router, wire: 'map', catalog: 0.1, catalogOutput: null })).toMatchObject({
      cost_usd: 0.0001,
      cost_includes_output: false,
    });
  });

  test('the provider wire reaches the price a decision and the models endpoint resolve', () => {
    const native = {
      kind: 'openai' as const,
      base_url: 'https://api.openai.com',
      wire: 'openai' as const,
    };
    const uncached = { input: null, output: null };
    expect(providerPricing(native, 'gpt-6-luna')).toMatchObject({ wire: 'openai' });
    expect(defaultOutputPrice(defaultPriceInput(native, 'gpt-6-luna', uncached))).toBe(0);
    const chat = { ...native, wire: 'chat' as const };
    expect(defaultOutputPrice(defaultPriceInput(chat, 'gpt-6-luna', uncached))).toBe(0.5);
    expect(withDefaultPrices(native, [{ id: 'gpt-6-luna' }])).toEqual([
      { id: 'gpt-6-luna', default_price_per_m_input: 0.1, default_price_per_m_output: 0 },
    ]);
    expect(withDefaultPrices(chat, [{ id: 'gpt-6-luna' }])).toEqual([
      { id: 'gpt-6-luna', default_price_per_m_input: 0.1, default_price_per_m_output: 0.5 },
    ]);
  });
});

describe('the charge with output', () => {
  test('input and output parts add up, reasoning tokens included, rounded once', () => {
    // 1000 input at 0.10 and 200 output at 0.50 per million.
    expect(chargeFor(base)).toMatchObject({
      cost_usd: 0.0002,
      cost_basis: 'upstream_tokens',
      cost_includes_output: true,
      tokens: 1000,
    });
    expect(chargeFor({ ...base, target: 2, targetOutput: 3 })).toMatchObject({
      cost_usd: 0.0026,
      cost_includes_output: true,
    });
    // A target input price leaves the output default in place: 1000 at 2 plus 200 at 0.50.
    expect(chargeFor({ ...base, target: 2 })).toMatchObject({ cost_usd: 0.0021 });
    expect(chargeFor({ ...compat, target: 2, hintOutput: 4 })).toMatchObject({
      cost_usd: 0.0028,
    });
  });

  test('a billed cost wins and covers output', () => {
    expect(chargeFor({ ...base, billed: 0.77, targetOutput: 10 })).toMatchObject({
      cost_usd: 0.77,
      cost_includes_output: true,
      cost_basis: 'upstream_cost',
    });
  });

  test('zero output keeps the input-only cost exactly', () => {
    const usage = { input_tokens: 1000, output_tokens: 0, total_tokens: 1000 };
    expect(chargeFor({ ...base, usage })).toMatchObject({
      cost_usd: 0.0001,
      cost_includes_output: true,
    });
    expect(chargeFor({ ...compat, target: 2, usage })).toMatchObject({
      cost_usd: 0.002,
      cost_includes_output: true,
    });
  });

  test('output without a rate is flagged, and so is an unknown output count', () => {
    expect(chargeFor({ ...compat, target: 2 })).toMatchObject({
      cost_usd: 0.002,
      cost_basis: 'upstream_tokens',
      cost_includes_output: false,
    });
    expect(chargeFor({ ...compat, target: 2, usage: null })).toMatchObject({
      cost_basis: 'estimated_tokens',
      cost_includes_output: false,
    });
    expect(chargeFor({ ...base, usage: null })).toMatchObject({ cost_includes_output: false });
    expect(chargeFor({ ...compat, target: 2, targetOutput: 0 })).toMatchObject({
      cost_usd: 0.002,
      cost_includes_output: true,
    });
  });

  test('a zero mock rate uses token pricing, and an unknown output count is covered at a rate of 0', () => {
    const mock = { ...base, kind: 'mock' as const, model: 'mock-1' };
    expect(chargeFor(mock)).toMatchObject({
      cost_usd: 0,
      cost_basis: 'upstream_tokens',
      cost_includes_output: true,
    });
    expect(chargeFor({ ...mock, usage: null })).toMatchObject({
      cost_basis: 'estimated_tokens',
      cost_includes_output: true,
    });
    // A local server with only an output price still has no input price.
    const local = { ...base, kind: 'systemone' as const, local: true, targetOutput: 1 };
    expect(chargeFor(local)).toMatchObject({
      cost_usd: null,
      cost_basis: 'unpriced',
      cost_includes_output: true,
    });
  });

  test('an unpriced input leaves the cost null even with an output rate', () => {
    expect(chargeFor({ ...compat, targetOutput: 3 })).toMatchObject({
      cost_usd: null,
      cost_basis: 'unpriced',
      cost_includes_output: true,
    });
    expect(chargeFor(compat)).toMatchObject({ cost_usd: null, cost_includes_output: false });
  });
});

describe('catalog and listing output prices', () => {
  test('OpenRouter completion prices are read per million and price the output', () => {
    const models = mapModels({
      data: [
        { id: 'm', pricing: { prompt: '0.000002', completion: '0.000003' } },
        { id: 'varies', pricing: { prompt: '0.000001', completion: '-1' } },
        // Claude Haiku 5.5's real catalog prices, which convert to 0.09999999999999999 without rounding.
        { id: 'haiku', pricing: { prompt: '0.0000001', completion: '0.0000005' } },
      ],
    });
    expect(models).toEqual([
      { id: 'm', price_per_m_input: 2, price_per_m_output: 3 },
      { id: 'varies', price_per_m_input: 1 },
      { id: 'haiku', price_per_m_input: 0.1, price_per_m_output: 0.5 },
    ]);
    const catalog = catalogPrice({ expires: 0, models }, 'm');
    expect(catalog).toEqual({ input: 2, output: 3 });
    expect(catalogPrice({ expires: 0, models }, 'varies')).toEqual({ input: 1, output: null });
    expect(
      chargeFor({
        ...base,
        kind: 'openrouter',
        model: 'm',
        catalog: catalog.input,
        catalogOutput: catalog.output,
      }),
    ).toMatchObject({ cost_usd: 0.0026, cost_includes_output: true });
  });

  test('the models listing reports output defaults and hint output prices', () => {
    const hints = [{ id: 'm', price_per_m_input: 2, price_per_m_output: 3 }];
    const merged = mergeHints(hints, [{ id: 'm', context: 8 }, { id: 'n' }]);
    expect(merged).toEqual([
      { id: 'm', price_per_m_input: 2, price_per_m_output: 3, context: 8 },
      { id: 'n' },
    ]);
    const compatible = {
      kind: 'openai-compatible' as const,
      base_url: 'https://example.com',
      wire: 'openai' as const,
      model_hints: hints,
    };
    expect(withDefaultPrices(compatible, merged)).toEqual([
      {
        id: 'm',
        price_per_m_input: 2,
        price_per_m_output: 3,
        context: 8,
        default_price_per_m_input: 2,
        default_price_per_m_output: 3,
      },
      { id: 'n' },
    ]);
    const listed = [{ id: 'm', price_per_m_input: 2, price_per_m_output: 3 }];
    const openrouter = { ...compatible, kind: 'openrouter' as const, wire: 'map' as const };
    expect(withDefaultPrices(openrouter, listed, { expires: 0, models: listed })).toEqual([
      {
        id: 'm',
        price_per_m_input: 2,
        price_per_m_output: 3,
        default_price_per_m_input: 2,
        default_price_per_m_output: 3,
      },
    ]);
  });
});

test('local SystemOne output coverage follows the known count and rate, without a default price', () => {
  const local = { ...base, kind: 'systemone' as const, local: true };
  expect(chargeFor(local)).toMatchObject({
    cost_usd: null,
    cost_basis: 'unpriced',
    cost_includes_output: false,
  });
  expect(chargeFor({ ...local, usage: null })).toMatchObject({
    cost_usd: null,
    cost_basis: 'unpriced',
    cost_includes_output: false,
  });
  expect(
    chargeFor({ ...local, usage: { input_tokens: 1000, output_tokens: 0, total_tokens: 1000 } }),
  ).toMatchObject({ cost_usd: null, cost_basis: 'unpriced', cost_includes_output: true });
  expect(chargeFor({ ...local, targetOutput: 0, usage: null })).toMatchObject({
    cost_usd: null,
    cost_basis: 'unpriced',
    cost_includes_output: true,
  });
  expect(chargeFor({ ...local, hint: 2, hintOutput: 3 })).toMatchObject({
    cost_usd: 0.0026,
    cost_basis: 'upstream_tokens',
    cost_includes_output: true,
  });
  expect(chargeFor({ ...local, hint: 2, hintOutput: 3, billed: 0 })).toMatchObject({
    cost_usd: 0,
    cost_basis: 'upstream_cost',
    cost_includes_output: true,
  });
});
