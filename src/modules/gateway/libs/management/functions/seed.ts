import type { Provider, ProviderKey, ProviderKind } from '../schemas/types';
import type { Route } from '../../routing/schemas/types';
import { AUTHORIZATION, defaultSendModel } from '../../decisions/functions/wire';

export function seedProviders(t: string, newIds: string[]): Provider[] {
  const defaults: [
    string,
    ProviderKind,
    string,
    string,
    Provider['wire'],
    boolean,
    ProviderKey,
    number,
    number,
  ][] = [
    ['mock', 'mock', '', '', 'openai', true, { source: 'none' }, 400, 64],
    [
      'openai',
      'openai',
      'https://api.openai.com/v1',
      '/decisions',
      'openai',
      true,
      { source: 'env', env_var: 'OPENAI_API_KEY' },
      400,
      64,
    ],
    [
      'openrouter',
      'openrouter',
      'https://openrouter.ai',
      '/api/alpha/decisions',
      'map',
      true,
      { source: 'env', env_var: 'OPENROUTER_API_KEY' },
      400,
      64,
    ],
    [
      'llamacpp',
      'systemone',
      'http://host.docker.internal:8080',
      '/v1/systemone',
      'map',
      false,
      { source: 'none' },
      16,
      16,
    ],
  ];
  const result: Provider[] = [];
  let i = 0;
  for (const [
    name,
    kind,
    base_url,
    path,
    wire,
    enabled,
    key,
    max_questions,
    max_choices,
  ] of defaults) {
    const p: Provider = {
      id: newIds[i++],
      name,
      kind,
      base_url,
      path,
      wire,
      enabled,
      timeout_ms: 20000,
      limits: { max_questions, max_choices },
      extra_body: {},
      key,
      // OpenRouter is told the model; the local llama.cpp server is not, since it serves the one it loaded.
      send_model: defaultSendModel(kind, base_url),
      auth_header: AUTHORIZATION,
      created_at: t,
      updated_at: t,
    };
    result.push(p);
  }
  result.push(typeSafeProvider(t, newIds[i++]));
  for (const seed of CHAT_SEEDS) result.push(chatSeedProvider(seed, t, newIds[i++]));
  return result;
}

export function seedRoutes(t: string, ids: Record<string, string>, newIds: string[]): Route[] {
  const result: Route[] = [];
  let i = 0;
  for (const [alias, description, targets] of [
    ['default', 'Deterministic mock', [{ provider_id: ids.mock, model: 'mock-1' }]],
    [
      'luna',
      'OpenAI Luna with OpenRouter fallback',
      [
        { provider_id: ids.openai, model: 'gpt-6-luna' },
        { provider_id: ids.openrouter, model: 'openai/gpt-6-luna-decisions' },
      ],
    ],
    [
      'elephant',
      'Baseten Elephant via OpenRouter',
      [{ provider_id: ids.openrouter, model: 'baseten/elephant-1' }],
    ],
  ] as [string, string, Route['targets']][]) {
    result.push({
      id: newIds[i++],
      alias,
      description,
      enabled: true,
      targets,
      created_at: t,
      updated_at: t,
    });
  }
  return result;
}

export function migrateOpenRouterPath(provider: Provider): Provider {
  if (
    provider.kind !== 'openrouter' ||
    provider.base_url !== 'https://openrouter.ai' ||
    provider.path !== '/api/v1/alpha/decisions'
  )
    return provider;
  return { ...provider, path: '/api/alpha/decisions' };
}

// Migration 3 gives every stored provider the options added with presets, keeping how it calls its upstream today:
// on the map wire only OpenRouter named the model (so the seeded llamacpp is sent none), the openai wire always
// does, and every key went in the authorization header. An option a provider already has is kept.
export function migrateProviderOptions(provider: Provider): Provider {
  if (provider.send_model !== undefined && provider.auth_header !== undefined) return provider;
  return {
    ...provider,
    send_model:
      provider.send_model ?? (provider.kind === 'openrouter' || provider.wire === 'openai'),
    auth_header: provider.auth_header ?? AUTHORIZATION,
  };
}

// The endpoint earlier databases were seeded with and new ones are not: an OpenAI-compatible server on the Docker
// host. Migration 5 checks these fields and the seed batch evidence below, never its stored name.
export const RETIRED_SEED_SIGNATURE = {
  kind: 'openai-compatible',
  base_url: 'http://host.docker.internal:8000/v1',
  path: '/decisions',
} as const;

// What migration 5 does: the provider to delete, the changed routes to write, and the startup line.
export type RetirePlan = { remove: string | null; routes: Route[]; log: string | null };

// Move the retired seed's route targets to the first enabled mock in stored order, then remove it.
// The old seed used one timestamp for the batch, wire openai and no key. Require the earliest stored
// timestamp and another provider from that batch; an address alone must never identify a user's provider.
export function retireSeededProvider(
  providers: readonly Provider[],
  routes: readonly Route[],
): RetirePlan {
  const seedTime = providers.reduce<string | undefined>(
    (earliest, x) => (earliest === undefined || x.created_at < earliest ? x.created_at : earliest),
    undefined,
  );
  const p = providers.find(
    (x) =>
      x.kind === RETIRED_SEED_SIGNATURE.kind &&
      x.base_url === RETIRED_SEED_SIGNATURE.base_url &&
      x.path === RETIRED_SEED_SIGNATURE.path &&
      x.wire === 'openai' &&
      x.key.source === 'none' &&
      x.created_at === seedTime &&
      providers.some((other) => other.id !== x.id && other.created_at === seedTime),
  );
  if (!p) return { remove: null, routes: [], log: null };
  const mocks = providers.filter((x) => x.kind === 'mock');
  const mock = mocks.find((x) => x.enabled);
  if (!mock)
    return {
      remove: null,
      routes: [],
      log:
        mocks.length === 0
          ? `Kept the retired provider "${p.name}": there is no mock provider to move its routes to.`
          : `Kept the retired provider "${p.name}": the mock provider is turned off, so its routes were not moved.`,
    };
  const mockIds = new Set(mocks.map((x) => x.id));
  const using = routes.filter((r) => r.targets.some((t) => t.provider_id === p.id));
  const updated = using.map((route) => {
    // Any existing mock step, even a disabled one, is the owner's choice: keep it without a duplicate.
    let hasMock = route.targets.some((t) => mockIds.has(t.provider_id));
    const targets = route.targets.flatMap((target) => {
      if (target.provider_id !== p.id) return [target];
      if (hasMock) return [];
      hasMock = true;
      const moved = { ...target, provider_id: mock.id, model: 'mock-1' };
      // The override priced the retired provider's model; Mock uses its own price.
      delete moved.price_per_m_input;
      return [moved];
    });
    return { ...route, targets };
  });
  const aliases = using.map((r) => `"${r.alias}"`).join(', ');
  return {
    remove: p.id,
    routes: updated,
    log:
      using.length > 0
        ? `Moved route ${aliases} from the retired provider "${p.name}" to Mock and removed it.`
        : `Removed the retired provider "${p.name}": no route used it.`,
  };
}

// Also used by migration 6, so existing and new databases receive the same disabled provider.
export function typeSafeProvider(t: string, id: string, name = 'typesafe'): Provider {
  return {
    id,
    name,
    kind: 'systemone',
    base_url: 'https://api.typesafe.ai',
    path: '/v1/systemone',
    wire: 'map',
    enabled: false,
    timeout_ms: 20000,
    limits: { max_questions: 400, max_choices: 64 },
    extra_body: {},
    key: { source: 'env', env_var: 'TYPESAFE_API_KEY' },
    send_model: true,
    auth_header: AUTHORIZATION,
    model_hints: [
      { id: 'jev-1.14', description: 'Jev 1.14', price_per_m_input: 0.042, context: 262144 },
      { id: 'jev-1.13', description: 'Jev 1.13', price_per_m_input: 0.042, context: 262144 },
    ],
    created_at: t,
    updated_at: t,
  };
}

export function typeSafeSeedName(providers: readonly Provider[]): string | null {
  if (providers.some((p) => p.base_url.replace(/\/+$/, '') === 'https://api.typesafe.ai'))
    return null;
  const names = new Set(providers.map((p) => p.name));
  let name = 'typesafe',
    suffix = 2;
  while (names.has(name)) name = `typesafe-${suffix++}`;
  return name;
}

// The explicit chat-wire providers seeded beside the native openai and openrouter ones. Each one is its own provider
// with its own env key setting: nothing links it to the native provider of the same vendor. Synthetic settings
// (synthetic_methods, sampling_n, json_transport) and disable_reasoning are left out, so they read as their defaults.
export type ChatSeed = {
  name: string;
  kind: Extract<ProviderKind, 'openai' | 'openrouter'>;
  base_url: string;
  path: string;
  env_var: string;
};

export const CHAT_SEEDS: readonly ChatSeed[] = [
  {
    name: 'openai-chat',
    kind: 'openai',
    base_url: 'https://api.openai.com/v1',
    path: '/chat/completions',
    env_var: 'OPENAI_API_KEY',
  },
  {
    name: 'openrouter-chat',
    kind: 'openrouter',
    base_url: 'https://openrouter.ai',
    path: '/api/v1/chat/completions',
    env_var: 'OPENROUTER_API_KEY',
  },
];

// Also used by migration 7, so existing and new databases receive the same disabled provider.
export function chatSeedProvider(
  seed: ChatSeed,
  t: string,
  id: string,
  name = seed.name,
): Provider {
  return {
    id,
    name,
    kind: seed.kind,
    base_url: seed.base_url,
    path: seed.path,
    wire: 'chat',
    enabled: false,
    timeout_ms: 20000,
    // The chat wire's create defaults.
    limits: { max_questions: 16, max_choices: 64 },
    extra_body: {},
    key: { source: 'env', env_var: seed.env_var },
    send_model: true,
    auth_header: AUTHORIZATION,
    created_at: t,
    updated_at: t,
  };
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

// What migration 7 does: the providers to add, and one startup line for each.
export type ChatSeedPlan = { add: Provider[]; log: string[] };

// Add each chat seed unless a provider of the same kind on wire chat at the same base URL (trailing slash ignored)
// already exists. A taken name moves to the first free <name>-2, <name>-3, …
export function planChatSeeds(
  providers: readonly Provider[],
  t: string,
  newIds: readonly string[],
): ChatSeedPlan {
  const names = new Set(providers.map((p) => p.name));
  const add: Provider[] = [];
  const log: string[] = [];
  for (const seed of CHAT_SEEDS) {
    if (
      providers.some(
        (p) => p.kind === seed.kind && p.wire === 'chat' && sameUrl(p.base_url, seed.base_url),
      )
    )
      continue;
    let name = seed.name,
      suffix = 2;
    while (names.has(name)) name = `${seed.name}-${suffix++}`;
    names.add(name);
    add.push(chatSeedProvider(seed, t, newIds[add.length], name));
    log.push(
      `Added the disabled provider "${name}": ${seed.kind} chat models as synthetic decisions, key from ${seed.env_var}.`,
    );
  }
  return { add, log };
}
