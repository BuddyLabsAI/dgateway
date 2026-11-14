import { test, expect } from 'bun:test';
import {
  seedProviders,
  typeSafeProvider,
  typeSafeSeedName,
} from '../../src/modules/gateway/libs/management/functions/seed';

test('TypeSafe seed is disabled and matches Jev console preset hints', () => {
  const p = typeSafeProvider('now', 'p');
  expect(p).toMatchObject({
    name: 'typesafe',
    kind: 'systemone',
    base_url: 'https://api.typesafe.ai',
    path: '/v1/systemone',
    wire: 'map',
    send_model: true,
    enabled: false,
    key: { source: 'env', env_var: 'TYPESAFE_API_KEY' },
  });
  expect(p.model_hints?.map((hint) => [hint.id, hint.price_per_m_input, hint.context])).toEqual([
    ['jev-1.14', 0.042, 262144],
    ['jev-1.13', 0.042, 262144],
  ]);
  expect(seedProviders('now', ['1', '2', '3', '4', '5', '6', '7'])[4]).toEqual({ ...p, id: '5' });
});

test('TypeSafe migration preserves matching URLs and chooses an unused name', () => {
  const p = typeSafeProvider('now', 'p');
  expect(
    typeSafeSeedName([{ ...p, name: 'mine', base_url: 'https://api.typesafe.ai/' }]),
  ).toBeNull();
  expect(typeSafeSeedName([{ ...p, base_url: 'https://other.test' }])).toBe('typesafe-2');
});
