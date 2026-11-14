import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/modules/gateway/libs/management/providers/store';

test('new databases seed TypeSafe without a route; deletion survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'typesafe-new-'));
  try {
    const first = new Store(dir, { TYPESAFE_API_KEY: 'test-only' });
    const p = first.providers().find((p) => p.name === 'typesafe')!;
    expect(p.enabled).toBe(false);
    expect(first.key(p)).toBe('test-only');
    expect(first.routes().some((r) => r.targets.some((t) => t.provider_id === p.id))).toBe(false);
    first.deleteProvider(p.id);
    first.close();
    const reopened = new Store(dir, {});
    expect(reopened.providers().some((p) => p.name === 'typesafe')).toBe(false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const existing of [false, true]) {
  test(`migration 6 adds TypeSafe once; existing URL=${existing}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'typesafe-migrate-'));
    try {
      const first = new Store(dir, {});
      const p = first.providers().find((p) => p.name === 'typesafe')!;
      first.deleteProvider(p.id);
      if (existing)
        first.putProvider({ ...p, name: 'custom-jev', base_url: `${p.base_url}/`, enabled: true });
      first.db.query('DELETE FROM migrations WHERE version=6').run();
      first.close();
      const migrated = new Store(dir, {});
      const matches = migrated
        .providers()
        .filter((p) => p.base_url.startsWith('https://api.typesafe.ai'));
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe(existing ? 'custom-jev' : 'typesafe');
      expect(matches[0].enabled).toBe(existing);
      migrated.deleteProvider(matches[0].id);
      migrated.close();
      const reopened = new Store(dir, {});
      expect(
        reopened.providers().some((p) => p.base_url.startsWith('https://api.typesafe.ai')),
      ).toBe(false);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
