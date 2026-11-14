import { describe, expect, test } from 'bun:test';
import {
  KEY_TAIL_MIN_LENGTH,
  keyTail,
  prepareProviderKey,
  providerView,
  withRuledKeyTail,
} from '../../src/modules/gateway/libs/management/functions/admin';
import type { Provider } from '../../src/modules/gateway/libs/management/schemas/types';

const provider = (key: Provider['key']): Provider => ({
  id: 'prv_1',
  name: 'vendor',
  kind: 'openai-compatible',
  base_url: 'https://vendor.example',
  path: '/v1/decisions',
  wire: 'openai',
  enabled: true,
  timeout_ms: 1000,
  limits: { max_questions: 4, max_choices: 4 },
  extra_body: {},
  key,
  created_at: '2026-11-12T00:00:00.000Z',
  updated_at: '2026-11-12T00:00:00.000Z',
});

describe('what reads show of a stored key', () => {
  test('the last four characters of a key of at least 12, and none of a shorter one', () => {
    expect(KEY_TAIL_MIN_LENGTH).toBe(12);
    expect(keyTail('abcd')).toBeNull();
    expect(keyTail('a')).toBeNull();
    expect(keyTail('sk-abcd1234')).toBeNull();
    expect(keyTail('sk-test-9999')).toBe('9999');
    expect(keyTail('sk-or-v1-0123456789abcdef')).toBe('cdef');
  });

  test('characters are code points, so a pair is never split or counted twice', () => {
    expect(keyTail('🔑'.repeat(11))).toBeNull();
    expect(keyTail(`${'🔑'.repeat(8)}ab🔑c`)).toBe('ab🔑c');
  });

  test('a stored key plan keeps no characters of a short key', () => {
    expect(prepareProviderKey({ source: 'stored', value: 'abcd' })).toEqual({
      source: 'stored',
      value: 'abcd',
      last4: null,
    });
    expect(prepareProviderKey({ source: 'stored', value: 'sk-test-9999' })).toMatchObject({
      last4: '9999',
    });
  });

  test('a read shows the stored tail, null included, and never the ciphertext', () => {
    const view = providerView(
      provider({ source: 'stored', ciphertext: 'c1pher', last4: null }),
      false,
    );
    expect(view.key).toEqual({ source: 'stored', last4: null });
    expect(JSON.stringify(view)).not.toContain('c1pher');
  });
});

describe('the tail of a key stored before the rule', () => {
  const legacy = (last4: string) => provider({ source: 'stored', ciphertext: 'c', last4 });

  test('a short key loses its tail, and a longer one keeps it unchanged', () => {
    expect(withRuledKeyTail(legacy('abcd'), 'abcd').key).toEqual({
      source: 'stored',
      ciphertext: 'c',
      last4: null,
    });
    expect(withRuledKeyTail(legacy('5678'), 'sk-abcd5678').key).toMatchObject({ last4: null });
    const long = legacy('9999');
    expect(withRuledKeyTail(long, 'sk-test-9999')).toBe(long);
  });

  test('a key that cannot be decrypted loses its tail, and other keys are left alone', () => {
    expect(withRuledKeyTail(legacy('9999'), null).key).toMatchObject({ last4: null });
    // Under four bytes per character of the minimum, the key may have fewer than 12 characters.
    expect(withRuledKeyTail(legacy('9999'), null, 47).key).toMatchObject({ last4: null });
    expect(withRuledKeyTail(legacy('9999'), null, 11).key).toMatchObject({ last4: null });
    const env = provider({ source: 'env', env_var: 'VENDOR_KEY' });
    expect(withRuledKeyTail(env, null)).toBe(env);
    const none = provider({ source: 'none' });
    expect(withRuledKeyTail(none, null)).toBe(none);
  });

  test('a key that cannot be decrypted keeps its tail when its length in bytes proves 12 characters', () => {
    const long = legacy('9999');
    expect(withRuledKeyTail(long, null, 48)).toBe(long);
    expect(withRuledKeyTail(long, null, 73)).toBe(long);
    // A decrypted key decides by its characters, whatever the byte count says.
    expect(withRuledKeyTail(long, 'abcd', 100).key).toMatchObject({ last4: null });
  });
});
