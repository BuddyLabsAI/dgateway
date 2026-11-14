import { describe, expect, test } from 'bun:test';
import {
  chooseTestModel,
  listedTestModel,
  preferredTestModel,
  providerDraft,
  providerView,
  SERVER_CONFIGURED,
  type ModelInfo,
} from '../../src/modules/gateway/libs/management/functions/admin';
import {
  retireSeededProvider,
  seedProviders,
} from '../../src/modules/gateway/libs/management/functions/seed';
import type { Provider } from '../../src/modules/gateway/libs/management/schemas/types';
import type { Route } from '../../src/modules/gateway/libs/routing/schemas/types';

const T = '2026-11-08T00:00:00.000Z';

const [mock, , openrouter] = seedProviders(T, [
  'p-mock',
  'p-openai',
  'p-or',
  'p-llama',
  'p-typesafe',
  'p-openai-chat',
  'p-openrouter-chat',
]);

const provider = (extra: Partial<Provider> = {}): Provider => ({ ...openrouter, ...extra });

function route(alias: string, enabled: boolean, targets: [string, string][]): Route {
  return {
    id: `r-${alias}`,
    alias,
    description: alias,
    enabled,
    targets: targets.map(([provider_id, model]) => ({ provider_id, model })),
    created_at: T,
    updated_at: T,
  };
}

const catalog: ModelInfo[] = [
  { id: 'morph/reflex' },
  { id: 'zeta/small', price_per_m_input: 0.02 },
  { id: 'alpha/small', price_per_m_input: 0.02 },
  { id: 'big/model', price_per_m_input: 0.9 },
];

const hints = [{ id: 'hint-first' }, { id: 'hint-second', price_per_m_input: 0 }];

describe('the model a provider test uses', () => {
  test('a model the caller passes wins over everything else', () => {
    const p = provider({ test_model: 'saved', model_hints: hints });
    const routes = [route('luna', true, [['p-or', 'routed']])];
    expect(chooseTestModel('asked/for', p, routes, catalog)).toEqual({
      model: 'asked/for',
      reason: 'requested',
      route: null,
    });
  });

  test('next, the model a route sends this provider, from the first enabled route', () => {
    const p = provider({ test_model: 'saved', model_hints: hints });
    const routes = [
      route('other', true, [['p-openai', 'gpt-6-luna']]),
      route('off', false, [['p-or', 'from-disabled']]),
      route('luna', true, [
        ['p-openai', 'gpt-6-luna'],
        ['p-or', 'openai/gpt-6-luna-decisions'],
      ]),
      route('later', true, [['p-or', 'from-later']]),
    ];
    expect(chooseTestModel(undefined, p, routes, catalog)).toEqual({
      model: 'openai/gpt-6-luna-decisions',
      reason: 'used_by_route',
      route: 'luna',
    });
  });

  test('a disabled route still counts when no enabled route uses the provider', () => {
    const routes = [route('off', false, [['p-or', 'from-disabled']])];
    expect(chooseTestModel(undefined, provider(), routes, catalog)).toEqual({
      model: 'from-disabled',
      reason: 'used_by_route',
      route: 'off',
    });
  });

  test("then the provider's own test model, such as its preset's", () => {
    const p = provider({ test_model: 'perplexity/pplx-decider-flash-v1.2', model_hints: hints });
    const routes = [route('other', true, [['p-openai', 'gpt-6-luna']])];
    expect(chooseTestModel(undefined, p, routes, catalog)).toEqual({
      model: 'perplexity/pplx-decider-flash-v1.2',
      reason: 'provider_default',
      route: null,
    });
  });

  test('then its first model hint', () => {
    expect(chooseTestModel(undefined, provider({ model_hints: hints }), [], catalog)).toEqual({
      model: 'hint-first',
      reason: 'hint',
      route: null,
    });
    expect(chooseTestModel(undefined, provider({ test_model: null }), [], []).reason).toBe(
      'server_configured',
    );
  });

  test('then the cheapest priced model it lists, ties broken by id', () => {
    expect(chooseTestModel(undefined, provider(), [], catalog)).toEqual({
      model: 'alpha/small',
      reason: 'cheapest',
      route: null,
    });
    expect(
      listedTestModel([
        { id: 'paid', price_per_m_input: 1 },
        { id: 'free', price_per_m_input: 0 },
      ]),
    ).toEqual({ model: 'free', reason: 'cheapest', route: null });
  });

  test('then the first model it lists, when none is priced', () => {
    expect(listedTestModel([{ id: 'local-7b' }, { id: 'local-70b' }])).toEqual({
      model: 'local-7b',
      reason: 'first_listed',
      route: null,
    });
  });

  test('last, the server-configured placeholder, which is never a listed model of its own', () => {
    const placeholder = {
      model: SERVER_CONFIGURED,
      reason: 'server_configured' as const,
      route: null,
    };
    expect(listedTestModel([])).toEqual(placeholder);
    expect(listedTestModel([{ id: SERVER_CONFIGURED }])).toEqual(placeholder);
    expect(listedTestModel([{ id: SERVER_CONFIGURED }, { id: 'real' }]).model).toBe('real');
  });

  test('without a request, a route, a test model or hints, the listing decides', () => {
    expect(preferredTestModel(undefined, provider(), [])).toBeNull();
  });
});

describe('a provider test model', () => {
  const body = {
    name: 'router',
    kind: 'openrouter',
    base_url: 'https://openrouter.ai',
    path: '/api/alpha/decisions',
    wire: 'map',
    enabled: true,
    timeout_ms: 20000,
    limits: { max_questions: 400, max_choices: 64 },
    extra_body: {},
    key: { source: 'none' },
  };

  test('is optional, a model id or null, and reads as null when unset', () => {
    expect(providerDraft(body, undefined).value.test_model).toBeUndefined();
    expect(providerDraft({ ...body, test_model: 'perplexity/x' }, undefined).value.test_model).toBe(
      'perplexity/x',
    );
    expect(providerDraft({ test_model: null }, provider()).value.test_model).toBeNull();
    expect(providerView(provider(), false).test_model).toBeNull();
    expect(providerView(provider({ test_model: 'd1' }), false).test_model).toBe('d1');
  });

  test('anything else is refused', () => {
    for (const bad of ['', '   ', 42, false, 'x'.repeat(201)])
      expect(() => providerDraft({ ...body, test_model: bad }, undefined)).toThrow(
        'test_model must be a model id',
      );
  });
});

describe('migration 5: move the retired seed provider to Mock', () => {
  const seeded: Provider = {
    ...openrouter,
    id: 'p-old',
    name: 'old-seed',
    kind: 'openai-compatible',
    base_url: 'http://host.docker.internal:8000/v1',
    path: '/decisions',
    wire: 'openai',
    key: { source: 'none' },
    enabled: false,
  };

  test('removes the matching provider when no route targets it', () => {
    expect(
      retireSeededProvider([mock, openrouter, seeded], [route('luna', true, [['p-or', 'x']])]),
    ).toEqual({
      remove: 'p-old',
      routes: [],
      log: 'Removed the retired provider "old-seed": no route used it.',
    });
  });

  test('moves enabled and disabled routes, preserving step order and timeouts, with no input mutation', () => {
    const routes = [
      route('triage', false, [
        ['p-or', 'before'],
        ['p-old', 'm'],
        ['p-openai', 'after'],
      ]),
      route('unrelated', true, [['p-or', 'unchanged']]),
      route('fast', true, [['p-old', 'n']]),
    ];
    routes[0].targets[1] = { ...routes[0].targets[1], timeout_ms: 3210, price_per_m_input: 7 };
    routes[2].targets[0].price_per_m_input = null;
    const providers = [mock, seeded, openrouter];
    const before = structuredClone({ providers, routes });
    expect(retireSeededProvider(providers, routes)).toEqual({
      remove: 'p-old',
      routes: [
        {
          ...routes[0],
          targets: [
            routes[0].targets[0],
            { provider_id: mock.id, model: 'mock-1', timeout_ms: 3210 },
            routes[0].targets[2],
          ],
        },
        { ...routes[2], targets: [{ provider_id: mock.id, model: 'mock-1' }] },
      ],
      log: 'Moved route "triage", "fast" from the retired provider "old-seed" to Mock and removed it.',
    });
    expect({ providers, routes }).toEqual(before);
  });

  test('converts a renamed provider and logs its stored name', () => {
    expect(retireSeededProvider([mock, { ...seeded, name: 'renamed-seed' }], [])).toEqual({
      remove: 'p-old',
      routes: [],
      log: 'Removed the retired provider "renamed-seed": no route used it.',
    });
  });

  test('uses the first provider of kind mock, regardless of its name', () => {
    const firstMock = { ...mock, id: 'first-mock', name: 'renamed-mock' };
    const used = route('triage', true, [['p-old', 'm']]);
    const plan = retireSeededProvider(
      [{ ...openrouter, name: 'mock' }, firstMock, mock, seeded],
      [used],
    );
    expect(plan.routes).toEqual([
      { ...used, targets: [{ provider_id: firstMock.id, model: 'mock-1' }] },
    ]);
  });

  test('keeps the retired provider and routes when all mocks are disabled, without mutation', () => {
    const providers = [{ ...mock, enabled: false }, seeded];
    const routes = [route('triage', true, [['p-old', 'm']])];
    const before = structuredClone({ providers, routes });
    expect(retireSeededProvider(providers, routes)).toEqual({
      remove: null,
      routes: [],
      log: 'Kept the retired provider "old-seed": the mock provider is turned off, so its routes were not moved.',
    });
    expect({ providers, routes }).toEqual(before);
  });

  test('skips a disabled mock and uses the first enabled mock, even if created later', () => {
    const enabled = { ...mock, id: 'enabled-mock', created_at: '2026-11-09T00:00:00.000Z' };
    const used = route('triage', true, [['p-old', 'm']]);
    expect(
      retireSeededProvider([{ ...mock, enabled: false }, enabled, seeded], [used]).routes,
    ).toEqual([{ ...used, targets: [{ provider_id: enabled.id, model: 'mock-1' }] }]);
  });

  test('drops retired steps around an existing mock step, preserving the remaining steps', () => {
    const used = route('triage', true, [
      ['p-old', 'before'],
      ['p-or', 'first'],
      ['p-mock', 'existing'],
      ['p-old', 'after'],
      ['p-openai', 'last'],
    ]);
    used.targets[2] = { ...used.targets[2], timeout_ms: 4500, price_per_m_input: 0.2 };
    expect(retireSeededProvider([mock, seeded], [used]).routes).toEqual([
      { ...used, targets: [used.targets[1], used.targets[2], used.targets[4]] },
    ]);
  });

  test.each([true, false])(
    'does not duplicate an existing mock step whose provider enabled is %s',
    (enabled) => {
      const otherMock = { ...mock, id: 'other-mock', name: 'other-mock', enabled };
      const used = route('triage', true, [
        ['p-old', 'm'],
        [otherMock.id, 'existing'],
      ]);
      expect(retireSeededProvider([mock, otherMock, seeded], [used]).routes).toEqual([
        { ...used, targets: [used.targets[1]] },
      ]);
    },
  );

  test('moves repeated retired steps to one mock step at the first retired position', () => {
    const used = route('triage', true, [
      ['p-or', 'before'],
      ['p-old', 'first'],
      ['p-openai', 'between'],
      ['p-old', 'last'],
    ]);
    expect(retireSeededProvider([mock, seeded], [used]).routes).toEqual([
      {
        ...used,
        targets: [used.targets[0], { provider_id: mock.id, model: 'mock-1' }, used.targets[2]],
      },
    ]);
  });

  test('leaves ordinary user providers alone, without logging, when seed evidence differs', () => {
    for (const changed of [
      { base_url: 'http://gpu.lan:8000/v1' },
      { path: '/v1/decisions' },
      { kind: 'systemone' as const },
      { created_at: '2026-11-09T00:00:00.000Z' },
      { wire: 'map' as const },
      { key: { source: 'env' as const, env_var: 'CUSTOM_KEY' } },
      { key: { source: 'stored' as const, ciphertext: 'cipher', last4: '1234' } },
    ])
      expect(
        retireSeededProvider(
          [mock, { ...seeded, ...changed }],
          [route('used', true, [['p-old', 'm']])],
        ),
      ).toEqual({
        remove: null,
        routes: [],
        log: null,
      });
  });

  test('a signature alone is insufficient when no other provider shares the seed timestamp', () => {
    const used = route('triage', true, [['p-old', 'm']]);
    for (const providers of [
      [seeded],
      [seeded, { ...mock, created_at: '2026-11-09T00:00:00.000Z' }],
    ])
      expect(retireSeededProvider(providers, [used])).toEqual({
        remove: null,
        routes: [],
        log: null,
      });
  });

  test('a shared timestamp must also be the earliest stored timestamp', () => {
    expect(
      retireSeededProvider(
        [mock, seeded, { ...openrouter, created_at: '2026-11-07T00:00:00.000Z' }],
        [],
      ),
    ).toEqual({ remove: null, routes: [], log: null });
  });

  test('keeps a matching provider without a mock provider, even when unused, and logs why', () => {
    for (const routes of [[], [route('used', true, [['p-old', 'm']])]])
      expect(retireSeededProvider([seeded, openrouter], routes)).toEqual({
        remove: null,
        routes: [],
        log: 'Kept the retired provider "old-seed": there is no mock provider to move its routes to.',
      });
  });

  test('leaves nothing to do and logs nothing when there is no matching provider', () => {
    expect(retireSeededProvider([mock, openrouter], [])).toEqual({
      remove: null,
      routes: [],
      log: null,
    });
    expect(retireSeededProvider([], [])).toEqual({ remove: null, routes: [], log: null });
  });

  test('new databases no longer seed it', () => {
    expect(retireSeededProvider(seedProviders(T, ['a', 'b', 'c', 'd', 'e', 'f', 'g']), [])).toEqual(
      {
        remove: null,
        routes: [],
        log: null,
      },
    );
  });
});
