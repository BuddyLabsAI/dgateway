import { test, expect } from 'bun:test';
import {
  CHAT_SEEDS,
  chatSeedProvider,
  planChatSeeds,
  seedProviders,
} from '../../src/modules/gateway/libs/management/functions/seed';
import type { Provider } from '../../src/modules/gateway/libs/management/schemas/types';

const T = '2026-11-11T00:00:00.000Z';

const IDS = ['1', '2', '3', '4', '5', '6', '7'];

const seeded = () => seedProviders(T, IDS);

const byName = (providers: readonly Provider[], name: string) =>
  providers.find((p) => p.name === name)!;

test('new databases seed openai-chat and openrouter-chat, disabled, on the chat wire', () => {
  const providers = seeded();
  expect(providers.map((p) => p.name)).toEqual([
    'mock',
    'openai',
    'openrouter',
    'llamacpp',
    'typesafe',
    'openai-chat',
    'openrouter-chat',
  ]);
  expect(new Set(providers.map((p) => p.id)).size).toBe(IDS.length);
  const common = {
    wire: 'chat',
    enabled: false,
    timeout_ms: 20000,
    limits: { max_questions: 16, max_choices: 64 },
    extra_body: {},
    send_model: true,
    auth_header: 'authorization',
    created_at: T,
    updated_at: T,
  };
  expect(byName(providers, 'openai-chat')).toEqual({
    ...common,
    id: '6',
    name: 'openai-chat',
    kind: 'openai',
    base_url: 'https://api.openai.com/v1',
    path: '/chat/completions',
    key: { source: 'env', env_var: 'OPENAI_API_KEY' },
  } as Provider);
  expect(byName(providers, 'openrouter-chat')).toEqual({
    ...common,
    id: '7',
    name: 'openrouter-chat',
    kind: 'openrouter',
    base_url: 'https://openrouter.ai',
    path: '/api/v1/chat/completions',
    key: { source: 'env', env_var: 'OPENROUTER_API_KEY' },
  } as Provider);
  // Synthetic settings and disable_reasoning are absent, so they read as their defaults.
  for (const name of ['openai-chat', 'openrouter-chat']) {
    const p = byName(providers, name);
    for (const field of ['synthetic_methods', 'sampling_n', 'json_transport', 'disable_reasoning'])
      expect(field in p).toBe(false);
  }
});

test('the native seeds stay as they were', () => {
  const providers = seeded();
  expect(byName(providers, 'openai')).toMatchObject({
    kind: 'openai',
    base_url: 'https://api.openai.com/v1',
    path: '/decisions',
    wire: 'openai',
    enabled: true,
    limits: { max_questions: 400, max_choices: 64 },
    key: { source: 'env', env_var: 'OPENAI_API_KEY' },
  });
  expect(byName(providers, 'openrouter')).toMatchObject({
    kind: 'openrouter',
    base_url: 'https://openrouter.ai',
    path: '/api/alpha/decisions',
    wire: 'map',
    enabled: true,
    limits: { max_questions: 400, max_choices: 64 },
    key: { source: 'env', env_var: 'OPENROUTER_API_KEY' },
  });
});

test('migration 7 adds nothing to a fresh database', () => {
  expect(planChatSeeds(seeded(), T, ['x', 'y'])).toEqual({ add: [], log: [] });
});

test('migration 7 adds both to a database without them, with a startup line each', () => {
  const existing = seeded().slice(0, 5);
  const plan = planChatSeeds(existing, T, ['x', 'y']);
  expect(plan.add).toEqual([
    chatSeedProvider(CHAT_SEEDS[0], T, 'x'),
    chatSeedProvider(CHAT_SEEDS[1], T, 'y'),
  ]);
  expect(plan.log).toEqual([
    'Added the disabled provider "openai-chat": openai chat models as synthetic decisions, key from OPENAI_API_KEY.',
    'Added the disabled provider "openrouter-chat": openrouter chat models as synthetic decisions, key from OPENROUTER_API_KEY.',
  ]);
});

test('migration 7 skips a seed when a chat provider of that kind already uses its base URL', () => {
  const existing = seeded().slice(0, 5);
  const openrouter = byName(existing, 'openrouter');
  const mine: Provider = {
    ...openrouter,
    id: 'mine',
    name: 'my-router-chat',
    base_url: 'https://openrouter.ai/',
    path: '/api/v1/chat/completions',
    wire: 'chat',
  };
  const plan = planChatSeeds([...existing, mine], T, ['x', 'y']);
  expect(plan.add.map((p) => p.name)).toEqual(['openai-chat']);
  expect(plan.add[0].id).toBe('x');
});

test('migration 7 ignores native providers and chat providers of another kind or address', () => {
  const existing = seeded().slice(0, 5);
  const openai = byName(existing, 'openai');
  const others: Provider[] = [
    // The native openai seed switched to chat elsewhere would match; these do not.
    { ...openai, id: 'c1', name: 'compat', kind: 'openai-compatible', wire: 'chat' },
    { ...openai, id: 'c2', name: 'proxy', base_url: 'https://proxy.example/v1', wire: 'chat' },
  ];
  expect(planChatSeeds([...existing, ...others], T, ['x', 'y']).add.map((p) => p.name)).toEqual([
    'openai-chat',
    'openrouter-chat',
  ]);
});

test('migration 7 takes the first free <name>-N when a name is taken', () => {
  const existing = seeded().slice(0, 5);
  const mock = byName(existing, 'mock');
  const taken: Provider[] = [
    { ...mock, id: 't1', name: 'openai-chat' },
    { ...mock, id: 't2', name: 'openai-chat-2' },
    { ...mock, id: 't3', name: 'openrouter-chat' },
  ];
  const plan = planChatSeeds([...existing, ...taken], T, ['x', 'y']);
  expect(plan.add.map((p) => p.name)).toEqual(['openai-chat-3', 'openrouter-chat-2']);
  expect(plan.log[0]).toContain('"openai-chat-3"');
});
