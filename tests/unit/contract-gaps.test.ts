import { describe, expect, test } from 'bun:test';
import {
  chargeFor,
  defaultPriceInput,
  openaiBuiltInPrice,
  resolvePrice,
} from '../../src/modules/gateway/libs/decisions/functions/pricing';
import {
  SECRET_MISSING_CODE,
  catalogPrice,
  health,
  mapModels,
  mergeHints,
  secretMissingError,
  withDefaultPrices,
} from '../../src/modules/gateway/libs/management/functions/admin';
import { stats } from '../../src/modules/gateway/libs/management/functions/stats';
import type {
  Log,
  Provider,
  ProviderKind,
} from '../../src/modules/gateway/libs/management/schemas/types';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');

// A logged request with only the fields the stats read set. Answered requests default to a priced basis.
function log(
  route: string,
  provider: string,
  status: 'ok' | 'error',
  cost_basis: Log['cost_basis'] = 'upstream_tokens',
): Log {
  const answered = status === 'ok';
  return {
    id: `log_${Math.random()}`,
    ts: new Date(NOW - 60_000).toISOString(),
    route,
    provider,
    upstream_model: 'm',
    served_by: null,
    upstream_model_resolved: null,
    status,
    fallback_used: false,
    http_status: answered ? 200 : 502,
    latency_ms: 100,
    questions: 1,
    prompt_tokens: null,
    cost_usd: answered && cost_basis !== 'unpriced' ? 0.000001 : null,
    cost_basis: answered ? cost_basis : null,
    tokens: answered ? 10 : null,
    error: answered ? null : 'boom',
    attempts: [],
  };
}

// A provider as its default prices see it: a hosted address, no hints and the native wire unless extra says otherwise.
const provider = (
  kind: ProviderKind,
  extra: Partial<Pick<Provider, 'base_url' | 'model_hints' | 'wire'>> = {},
) => ({ kind, base_url: 'https://upstream.example', wire: 'openai' as const, ...extra });

const LOCAL = 'http://localhost:8080';

describe('the built-in OpenAI price is one table', () => {
  test('price resolution and the models defaults read the same price', () => {
    expect(openaiBuiltInPrice('gpt-6-luna')).toBe(0.1);
    expect(openaiBuiltInPrice('gpt-unknown')).toBeUndefined();
    expect(
      resolvePrice({ kind: 'openai', model: 'gpt-6-luna', target: null, catalog: null }),
    ).toEqual({
      perMillion: 0.1,
      cached: 0.01,
      write: 0.125,
    });
    const [model] = withDefaultPrices(provider('openai'), [{ id: 'gpt-6-luna' }]);
    expect(model?.default_price_per_m_input).toBe(0.1);
  });

  test('an openai model outside the table has no default and no built-in price', () => {
    expect(withDefaultPrices(provider('openai'), [{ id: 'gpt-unknown' }])).toEqual([
      { id: 'gpt-unknown' },
    ]);
    expect(
      resolvePrice({ kind: 'openai', model: 'gpt-unknown', target: null, catalog: null }),
    ).toBeNull();
  });
});

describe('default prices per provider kind', () => {
  test('mock defaults to 0 while a local systemone server has no default', () => {
    // Output defaults to 0 as well (see Cost, output pricing).
    const zero = { default_price_per_m_input: 0, default_price_per_m_output: 0 };
    expect(withDefaultPrices(provider('mock'), [{ id: 'mock-1' }])).toEqual([
      { id: 'mock-1', ...zero },
    ]);
    const local = provider('systemone', { base_url: LOCAL, wire: 'map' });
    expect(withDefaultPrices(local, [{ id: 'server-configured' }])).toEqual([
      { id: 'server-configured' },
    ]);
  });

  test('a hosted systemone server has no default unless a model hint prices the model', () => {
    const hosted = provider('systemone', { wire: 'map' });
    expect(withDefaultPrices(hosted, [{ id: 'jev-1.14' }])).toEqual([{ id: 'jev-1.14' }]);
    const model_hints = [{ id: 'jev-1.14', price_per_m_input: 0.042 }];
    expect(withDefaultPrices({ ...hosted, model_hints }, [{ id: 'jev-1.14' }])).toEqual([
      { id: 'jev-1.14', default_price_per_m_input: 0.042 },
    ]);
    // A local server uses the hint prices too.
    expect(
      withDefaultPrices(
        provider('systemone', {
          base_url: LOCAL,
          wire: 'map',
          model_hints: [{ id: 'd1', price_per_m_input: 5, price_per_m_output: 7 }],
        }),
        [{ id: 'd1' }],
      ),
    ).toEqual([{ id: 'd1', default_price_per_m_input: 5, default_price_per_m_output: 7 }]);
  });

  test('openai-compatible has no default, so its models carry none', () => {
    const models = [{ id: 'local-7b', price_per_m_input: 0.5 }];
    expect(withDefaultPrices(provider('openai-compatible'), models)).toEqual(models);
  });

  test('openrouter sets the default equal to the catalog price, and carries none for an unpriced model', () => {
    const listed = mapModels({
      data: [
        { id: 'baseten/elephant-1', pricing: { prompt: '0.000002' } },
        { id: 'acme/free-text' },
      ],
    });
    const catalog = { expires: 0, models: listed };
    const [priced, unpriced] = withDefaultPrices(provider('openrouter'), listed, catalog);
    expect(priced?.price_per_m_input).toBeGreaterThan(0);
    expect(priced?.default_price_per_m_input).toBe(priced?.price_per_m_input);
    expect(unpriced).toEqual({ id: 'acme/free-text' });
  });

  test('openrouter defaults come from the cached catalog a decision reads, never from a hint in the listing', () => {
    const catalog = {
      expires: 0,
      models: [{ id: 'cheap', price_per_m_input: 0.1, price_per_m_output: 0.4 }],
    };
    const model_hints = [
      { id: 'cheap', price_per_m_input: 0.5, price_per_m_output: 2 },
      { id: 'hint-only', price_per_m_input: 0.7 },
    ];
    const router = provider('openrouter', { wire: 'chat', model_hints });
    // A first listing merges the hints, whose prices win in price_per_m_input and price_per_m_output.
    const first = withDefaultPrices(router, mergeHints(model_hints, catalog.models), catalog);
    expect(first).toEqual([
      {
        id: 'cheap',
        price_per_m_input: 0.5,
        price_per_m_output: 2,
        default_price_per_m_input: 0.1,
        default_price_per_m_output: 0.4,
      },
      // Not in the catalog, so a decision leaves it unpriced, and the listing has no default for it.
      { id: 'hint-only', price_per_m_input: 0.7 },
    ]);
    // A listing served from the cache reports the same defaults.
    expect(withDefaultPrices(router, catalog.models, catalog)[0]).toMatchObject({
      default_price_per_m_input: 0.1,
      default_price_per_m_output: 0.4,
    });
    // They are the prices a decision on the provider is charged: a million tokens each way.
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 };
    const request = {
      input: 'x',
      questions: [{ name: 'p', type: 'predicate' as const, instructions: 'p?' }],
    };
    expect(
      chargeFor({
        ...defaultPriceInput(router, 'cheap', catalogPrice(catalog, 'cheap')),
        target: null,
        usage,
        request,
      }).cost_usd,
    ).toBe(0.5);
  });
});

describe('health reports whether the secret is configured, never its value', () => {
  test('secret_configured follows the flag it is given', () => {
    const providers = [{ name: 'mock', enabled: true, key: { source: 'none' as const } }];
    expect(health(providers, 0, 1000, true).secret_configured).toBe(true);
    expect(health(providers, 0, 1000, false).secret_configured).toBe(false);
  });
});

describe('the missing-secret refusal carries a code', () => {
  test('a 400 with the gateway_secret_missing code and the same message', () => {
    let thrown: unknown;
    try {
      throw secretMissingError();
    } catch (error) {
      thrown = error;
    }
    expect(SECRET_MISSING_CODE).toBe('gateway_secret_missing');
    expect(thrown).toMatchObject({
      status: 400,
      type: 'invalid_request_error',
      message: 'GATEWAY_SECRET must be set to store provider keys',
    });
    expect((thrown as { body(): unknown }).body()).toEqual({
      message: 'GATEWAY_SECRET must be set to store provider keys',
      type: 'invalid_request_error',
      code: 'gateway_secret_missing',
    });
  });
});

describe('unpriced counts per route and per provider', () => {
  test('each group counts its own answered requests that went unpriced', () => {
    const logs = [
      log('elephant', 'openrouter', 'ok', 'unpriced'),
      log('elephant', 'openrouter', 'ok', 'unpriced'),
      log('elephant', 'openrouter', 'ok', 'upstream_tokens'),
      log('elephant', 'openrouter', 'error'),
      log('luna', 'openai', 'ok', 'unpriced'),
      log('default', 'mock', 'ok', 'upstream_cost'),
    ];
    const summary = stats(logs, '24h', NOW);

    // The grouped rows carry their key under "route" or "provider", which the static type does not name.
    const byRoute = summary.by_route as Record<string, unknown>[];
    const byProvider = summary.by_provider as Record<string, unknown>[];

    const route = (name: string) => byRoute.find((row) => row.route === name);

    const provider = (name: string) => byProvider.find((row) => row.provider === name);

    expect(route('elephant')?.unpriced).toBe(2);
    expect(route('luna')?.unpriced).toBe(1);
    expect(route('default')?.unpriced).toBe(0);
    expect(provider('openrouter')?.unpriced).toBe(2);
    expect(provider('openai')?.unpriced).toBe(1);
    expect(provider('mock')?.unpriced).toBe(0);
  });

  test('the groups add up to the window count, and the timeseries carries no unpriced field', () => {
    const logs = [
      log('a', 'x', 'ok', 'unpriced'),
      log('b', 'y', 'ok', 'unpriced'),
      log('b', 'y', 'ok'),
    ];
    const summary = stats(logs, '1h', NOW);
    const byRoute = summary.by_route.reduce((sum, row) => sum + row.unpriced, 0);
    expect(summary.unpriced).toBe(2);
    expect(byRoute).toBe(summary.unpriced);
    expect(summary.timeseries.every((bucket) => !('unpriced' in bucket))).toBe(true);
  });

  test('a group with no traffic in the window is not listed, so it has no count', () => {
    const old = {
      ...log('old', 'x', 'ok', 'unpriced'),
      ts: new Date(NOW - 2 * 3_600_000).toISOString(),
    };
    const summary = stats([old], '1h', NOW);
    expect(summary.by_route).toEqual([]);
    expect(summary.unpriced).toBe(0);
  });
});
