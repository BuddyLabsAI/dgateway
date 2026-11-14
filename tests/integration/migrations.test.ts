import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/modules/gateway/libs/management/providers/store';
import type { Provider } from '../../src/modules/gateway/libs/management/schemas/types';
import type { Route } from '../../src/modules/gateway/libs/routing/schemas/types';

test('migration updates the old OpenRouter default once and preserves custom providers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-'));
  try {
    const first = new Store(dir, {});
    const original = first.providers().find((p) => p.name === 'openrouter')!;
    expect(original.path).toBe('/api/alpha/decisions');
    const old = { ...original, path: '/api/v1/alpha/decisions' };
    first.putProvider(old);
    first.putProvider({ ...old, id: 'custom-id', name: 'custom', path: '/my-endpoint' });
    first.putProvider({
      ...old,
      id: 'mirror-id',
      name: 'mirror',
      base_url: 'https://mirror.example',
    });
    first.db.query('DELETE FROM migrations WHERE version=2').run();
    first.close();
    const migrated = new Store(dir, {});
    const items = migrated.providers();
    expect(items.find((p) => p.id === old.id)).toEqual({ ...old, path: '/api/alpha/decisions' });
    expect(items.find((p) => p.id === 'custom-id')?.path).toBe('/my-endpoint');
    expect(items.find((p) => p.id === 'mirror-id')?.path).toBe('/api/v1/alpha/decisions');
    migrated.putProvider(old);
    migrated.close();
    const reopened = new Store(dir, {});
    expect(reopened.providers().find((p) => p.id === old.id)?.path).toBe('/api/v1/alpha/decisions');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 3 sets send_model and auth_header on existing providers, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-3-'));
  try {
    const first = new Store(dir, {});
    const llamacpp = first.providers().find((p) => p.name === 'llamacpp')!;
    // A database from before migration 3: no provider has the new options, and one hosted SystemOne vendor exists.
    for (const p of [
      ...first.providers(),
      { ...llamacpp, id: 'hosted-id', name: 'hosted', base_url: 'https://vendor.example' },
    ])
      first.putProvider({ ...p, send_model: undefined, auth_header: undefined });
    first.db.query('DELETE FROM migrations WHERE version=3').run();
    first.close();
    const migrated = new Store(dir, {});

    const named = (name: string) => migrated.providers().find((p) => p.name === name)!;

    expect(named('openrouter').send_model).toBe(true);
    expect(named('llamacpp').send_model).toBe(false);
    // Only OpenRouter named the model on the map wire before, so the hosted vendor keeps its old body.
    expect(named('hosted').send_model).toBe(false);
    expect(named('openai').send_model).toBe(true);
    expect(migrated.providers().every((p) => p.auth_header === 'authorization')).toBe(true);
    migrated.putProvider({ ...named('openrouter'), send_model: false });
    migrated.close();
    const reopened = new Store(dir, {});
    expect(reopened.providers().find((p) => p.name === 'openrouter')?.send_model).toBe(false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a new database seeds the options: OpenRouter sends the model, llamacpp does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-seed-options-'));
  try {
    const store = new Store(dir, {});

    const named = (name: string) => store.providers().find((p) => p.name === name)!;

    expect(named('openrouter')).toMatchObject({ send_model: true, auth_header: 'authorization' });
    expect(named('llamacpp')).toMatchObject({ send_model: false, auth_header: 'authorization' });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A database awaiting migration 5, with the retired endpoint and optionally a recorded migration 4.
function withRetiredSeed(
  dir: string,
  changes: Partial<Provider> = {},
  prepare: (store: Store, retired: Provider, mock: Provider) => void = () => undefined,
) {
  const first = new Store(dir, {}, () => undefined);
  try {
    const mock = first.providers().find((p) => p.kind === 'mock')!;
    const retired: Provider = {
      // The old seed shared the batch timestamp and key source with Mock, and used the openai wire.
      ...mock,
      id: 'prv_old',
      name: 'old-seed',
      kind: 'openai-compatible',
      base_url: 'http://host.docker.internal:8000/v1',
      path: '/decisions',
      wire: 'openai',
      enabled: false,
      limits: { max_questions: 16, max_choices: 16 },
      ...changes,
    };
    first.putProvider(retired);
    first.db.query('DELETE FROM migrations WHERE version IN (4,5)').run();
    prepare(first, retired, mock);
    return { retired, mock };
  } finally {
    first.close();
  }
}

function migrationRoute(alias: string, targets: Route['targets'], enabled = true): Route {
  return {
    id: `rte_${alias}`,
    alias,
    description: `${alias} route`,
    enabled,
    targets,
    created_at: '2026-11-08T00:00:00.000Z',
    updated_at: '2026-11-08T00:00:00.000Z',
  };
}

test('a new database seeds the current providers and records migrations 4 and 5 without logging', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-seed-5-'));
  try {
    const lines: string[] = [];
    const store = new Store(dir, {}, (line) => lines.push(line));
    expect(store.providers().map((p) => p.name)).toEqual([
      'mock',
      'openai',
      'openrouter',
      'llamacpp',
      'typesafe',
      'openai-chat',
      'openrouter-chat',
    ]);
    expect(store.db.query('SELECT version FROM migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
    ]);
    expect(lines).toEqual([]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 5 changes nothing and logs nothing without a matching provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-5-absent-'));
  try {
    const first = new Store(dir, {}, () => undefined);
    const before = { providers: first.providers(), routes: first.routes() };
    first.db.query('DELETE FROM migrations WHERE version=5').run();
    first.close();
    const lines: string[] = [];
    const migrated = new Store(dir, {}, (line) => lines.push(line));
    expect({ providers: migrated.providers(), routes: migrated.routes() }).toEqual(before);
    expect(lines).toEqual([]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 5 removes the matching unused provider and logs its stored name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-5-unused-'));
  try {
    const { retired } = withRetiredSeed(dir);
    const lines: string[] = [];
    const migrated = new Store(dir, {}, (line) => lines.push(line));
    expect(migrated.providers().some((p) => p.id === retired.id)).toBe(false);
    expect(lines).toEqual(['Removed the retired provider "old-seed": no route used it.']);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 5 moves routes from a renamed provider to the first stored mock, preserving route fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-5-routes-'));
  try {
    const routes: Route[] = [];
    const { retired, mock } = withRetiredSeed(dir, { name: 'renamed-seed' }, (store, old, mock) => {
      store.putProvider({ ...mock, name: 'renamed-mock' });
      store.putProvider({ ...mock, id: 'prv_other_mock', name: 'other-mock' });
      const openai = store.providers().find((p) => p.kind === 'openai')!;
      const openrouter = store.providers().find((p) => p.kind === 'openrouter')!;
      routes.push(
        migrationRoute(
          'triage',
          [
            { provider_id: openrouter.id, model: 'before' },
            { provider_id: old.id, model: 'old-model', timeout_ms: 3210, price_per_m_input: 7 },
            { provider_id: openai.id, model: 'after' },
          ],
          false,
        ),
        migrationRoute('fast', [
          { provider_id: old.id, model: 'other-model', price_per_m_input: null },
        ]),
      );
      routes.forEach((route) => store.putRoute(route));
    });
    const lines: string[] = [];
    const migrated = new Store(dir, {}, (line) => lines.push(line));
    expect(migrated.providers().some((p) => p.id === retired.id)).toBe(false);
    expect(migrated.routes().filter((r) => routes.some((old) => old.id === r.id))).toEqual([
      {
        ...routes[0],
        targets: [
          routes[0].targets[0],
          { provider_id: mock.id, model: 'mock-1', timeout_ms: 3210 },
          routes[0].targets[2],
        ],
      },
      { ...routes[1], targets: [{ provider_id: mock.id, model: 'mock-1' }] },
    ]);
    expect(lines).toEqual([
      'Moved route "triage", "fast" from the retired provider "renamed-seed" to Mock and removed it.',
    ]);
    const after = { providers: migrated.providers(), routes: migrated.routes() };
    migrated.close();
    const again: string[] = [];
    const reopened = new Store(dir, {}, (line) => again.push(line));
    expect({ providers: reopened.providers(), routes: reopened.routes() }).toEqual(after);
    expect(again).toEqual([]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([true, false])(
  'migration 5 keeps an existing mock step whose provider enabled is %s without duplicates',
  (enabled) => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-5-duplicate-'));
    try {
      let before: Route;
      const { retired } = withRetiredSeed(dir, {}, (store, old, mock) => {
        store.putProvider({ ...mock, enabled });
        store.putProvider({ ...mock, id: 'enabled-mock', name: 'enabled-mock' });
        const openai = store.providers().find((p) => p.kind === 'openai')!;
        before = migrationRoute('triage', [
          { provider_id: old.id, model: 'before' },
          { provider_id: openai.id, model: 'middle' },
          { provider_id: mock.id, model: 'existing', timeout_ms: 4500, price_per_m_input: 0.2 },
          { provider_id: old.id, model: 'after' },
        ]);
        store.putRoute(before);
      });
      const lines: string[] = [];
      const migrated = new Store(dir, {}, (line) => lines.push(line));
      expect(migrated.routes().find((r) => r.alias === 'triage')).toEqual({
        ...before!,
        targets: [before!.targets[1], before!.targets[2]],
      });
      expect(migrated.providers().some((p) => p.id === retired.id)).toBe(false);
      expect(lines).toEqual([
        'Moved route "triage" from the retired provider "old-seed" to Mock and removed it.',
      ]);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

for (const [field, changes] of [
  ['kind', { kind: 'systemone' }],
  ['URL', { base_url: 'http://gpu.lan:8000/v1' }],
  ['path', { path: '/custom/decisions' }],
  ['wire', { wire: 'map' }],
  ['key', { key: { source: 'env', env_var: 'CUSTOM_KEY' } }],
] as const)
  test(`migration 5 leaves a provider with a changed ${field} and its routes untouched, without logging`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-5-changed-'));
    try {
      const used = migrationRoute('triage', [{ provider_id: 'prv_old', model: 'unchanged' }]);
      const { retired } = withRetiredSeed(dir, changes, (store) => store.putRoute(used));
      const lines: string[] = [];
      const migrated = new Store(dir, {}, (line) => lines.push(line));
      expect(migrated.providers().find((p) => p.id === retired.id)).toEqual(retired);
      expect(migrated.routes().find((r) => r.id === used.id)).toEqual(used);
      expect(lines).toEqual([]);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

for (const destination of ['absent', 'disabled'])
  for (const used of [false, true])
    test(`migration 5 keeps the ${used ? 'routed' : 'unused'} provider with mock ${destination} and logs once`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-5-no-mock-'));
      try {
        const route = migrationRoute('triage', [{ provider_id: 'prv_old', model: 'unchanged' }]);
        const { retired } = withRetiredSeed(dir, {}, (store, _old, mock) => {
          if (destination === 'absent') store.deleteProvider(mock.id);
          else store.putProvider({ ...mock, enabled: false });
          if (used) store.putRoute(route);
        });
        const lines: string[] = [];
        const migrated = new Store(dir, {}, (line) => lines.push(line));
        expect(migrated.providers().find((p) => p.id === retired.id)).toEqual(retired);
        if (used) expect(migrated.routes().find((r) => r.id === route.id)).toEqual(route);
        expect(lines).toEqual([
          destination === 'absent'
            ? 'Kept the retired provider "old-seed": there is no mock provider to move its routes to.'
            : 'Kept the retired provider "old-seed": the mock provider is turned off, so its routes were not moved.',
        ]);
        const after = { providers: migrated.providers(), routes: migrated.routes() };
        migrated.close();
        const again: string[] = [];
        const reopened = new Store(dir, {}, (line) => again.push(line));
        expect({ providers: reopened.providers(), routes: reopened.routes() }).toEqual(after);
        expect(again).toEqual([]);
        reopened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

test('migration 5 moves routes to the first enabled mock after a disabled mock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-5-enabled-mock-'));
  try {
    const used = migrationRoute('triage', [{ provider_id: 'prv_old', model: 'old-model' }]);
    const { retired } = withRetiredSeed(dir, {}, (store, _old, mock) => {
      store.putProvider({ ...mock, enabled: false });
      const later = new Date(Date.parse(mock.created_at) + 1000).toISOString();
      store.putProvider({ ...mock, id: 'enabled-mock', name: 'enabled-mock', created_at: later });
      store.putProvider({ ...mock, id: 'another-mock', name: 'another-mock', created_at: later });
      store.putRoute(used);
    });
    const lines: string[] = [];
    const migrated = new Store(dir, {}, (line) => lines.push(line));
    expect(migrated.providers().some((p) => p.id === retired.id)).toBe(false);
    expect(migrated.routes().find((r) => r.id === used.id)).toEqual({
      ...used,
      targets: [{ provider_id: 'enabled-mock', model: 'mock-1' }],
    });
    expect(lines).toEqual([
      'Moved route "triage" from the retired provider "old-seed" to Mock and removed it.',
    ]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 5 leaves a user provider created later at the same address untouched and silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-5-user-provider-'));
  try {
    const used = migrationRoute('triage', [{ provider_id: 'prv_old', model: 'user-model' }]);
    let userProvider: Provider;
    withRetiredSeed(dir, {}, (store, old, mock) => {
      userProvider = {
        ...old,
        created_at: new Date(Date.parse(mock.created_at) + 1000).toISOString(),
      };
      store.putProvider(userProvider);
      store.putRoute(used);
    });
    const lines: string[] = [];
    const migrated = new Store(dir, {}, (line) => lines.push(line));
    expect(migrated.providers().find((p) => p.id === userProvider!.id)).toEqual(userProvider!);
    expect(migrated.routes().find((r) => r.id === used.id)).toEqual(used);
    expect(lines).toEqual([]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 5 leaves a lone provider with the signature untouched when the seed batch is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-5-lone-provider-'));
  try {
    const used = migrationRoute('triage', [{ provider_id: 'prv_old', model: 'user-model' }]);
    const { retired } = withRetiredSeed(dir, {}, (store, old) => {
      for (const provider of store.providers())
        if (provider.id !== old.id) store.deleteProvider(provider.id);
      store.putRoute(used);
    });
    const lines: string[] = [];
    const migrated = new Store(dir, {}, (line) => lines.push(line));
    expect(migrated.providers()).toEqual([retired]);
    expect(migrated.routes().find((r) => r.id === used.id)).toEqual(used);
    expect(lines).toEqual([]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 5 converts a kept provider even when migration 4 was already recorded, and runs once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-5-after-4-'));
  try {
    const used = migrationRoute('triage', [{ provider_id: 'prv_old', model: 'old-model' }]);
    const { retired, mock } = withRetiredSeed(dir, { name: 'renamed-seed' }, (store) => {
      store.putRoute(used);
      store.db.query('INSERT INTO migrations(version) VALUES(4)').run();
    });
    const lines: string[] = [];
    const migrated = new Store(dir, {}, (line) => lines.push(line));
    expect(migrated.providers().some((p) => p.id === retired.id)).toBe(false);
    expect(migrated.routes().find((r) => r.id === used.id)).toEqual({
      ...used,
      targets: [{ provider_id: mock.id, model: 'mock-1' }],
    });
    expect(
      migrated.db
        .query('SELECT version FROM migrations WHERE version IN (4,5) ORDER BY version')
        .all(),
    ).toEqual([{ version: 4 }, { version: 5 }]);
    expect(lines).toEqual([
      'Moved route "triage" from the retired provider "renamed-seed" to Mock and removed it.',
    ]);
    // Recreating the endpoint after migration 5 must not run the conversion again.
    migrated.putProvider(retired);
    migrated.putRoute(used);
    migrated.close();
    const again: string[] = [];
    const reopened = new Store(dir, {}, (line) => again.push(line));
    expect(reopened.providers().find((p) => p.id === retired.id)).toEqual(retired);
    expect(reopened.routes().find((r) => r.id === used.id)).toEqual(used);
    expect(again).toEqual([]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 8 clears the stored tail of a key under 12 characters, and of one it cannot decrypt, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-migration-8-'));
  const env = { GATEWAY_SECRET: 'migration-8-secret' };
  try {
    const first = new Store(dir, env);
    const mock = first.providers().find((p) => p.name === 'mock')!;

    // Rows as the gateway wrote them before the rule: last4 is the last four characters whatever the length.
    const stored = (name: string, value: string, ciphertext = first.encrypt(value)): Provider => ({
      ...mock,
      id: `${name}-id`,
      name,
      key: { source: 'stored', ciphertext, last4: value.slice(-4) },
    });

    // '#' and '!' never occur in base64, so the short key can show in a row only as itself.
    first.putProvider(stored('short', 'k#9!'));
    first.putProvider(stored('long', 'sk-test-9999'));
    // A ciphertext no secret opens: the key's length is unknown.
    first.putProvider(stored('lost', 'sk-test-7777', Buffer.alloc(60).toString('base64')));
    // One no secret opens whose 64 encrypted bytes prove a key of at least 12 characters: its tail is kept.
    first.putProvider(
      stored('lost-long', 'x'.repeat(60) + 'abcd', Buffer.alloc(108).toString('base64')),
    );
    // An env-sourced key is never touched.
    const envKey: Provider = {
      ...mock,
      id: 'env-id',
      name: 'env',
      key: { source: 'env', env_var: 'VENDOR_KEY' },
    };
    first.putProvider(envKey);
    first.db.query('DELETE FROM migrations WHERE version=8').run();
    first.close();

    const migrated = new Store(dir, env);

    const named = (name: string) => migrated.providers().find((p) => p.name === name)!;

    expect(named('short').key).toMatchObject({ source: 'stored', last4: null });
    expect(migrated.publicProvider(named('short')).key).toEqual({ source: 'stored', last4: null });
    const row = migrated.db.query('SELECT data FROM providers WHERE name=?').get('short') as {
      data: string;
    };
    expect(row.data).not.toContain('k#9!');
    expect(migrated.key(named('short'))).toBe('k#9!');
    expect(migrated.publicProvider(named('long')).key).toEqual({ source: 'stored', last4: '9999' });
    expect(migrated.publicProvider(named('lost')).key).toEqual({ source: 'stored', last4: null });
    expect(migrated.publicProvider(named('lost-long')).key).toEqual({
      source: 'stored',
      last4: 'abcd',
    });
    expect(named('env')).toEqual(envKey);
    expect(named('mock').key).toEqual(mock.key);
    // Once: the migration does not run again, so a row written later in the old shape is not rewritten.
    migrated.putProvider(stored('short', 'k#9!'));
    migrated.close();
    const reopened = new Store(dir, env);
    expect(reopened.providers().find((p) => p.name === 'short')?.key).toMatchObject({
      last4: 'k#9!',
    });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
