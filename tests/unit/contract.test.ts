import { describe, expect, test } from 'bun:test';
import { CallFailure } from '../../src/modules/gateway/libs/decisions/schemas/execution';
import { GatewayError } from '../../src/modules/gateway/libs/decisions/schemas/types';
import {
  eligibility,
  failedOutcome,
  initialState,
  reduceAttempt,
} from '../../src/modules/gateway/libs/decisions/functions/execution';
import {
  fromUpstream,
  gatewayConfidence,
} from '../../src/modules/gateway/libs/decisions/functions/translation';
import { validateRequest } from '../../src/modules/gateway/libs/decisions/functions/validation';
import {
  health,
  logPage,
  requireUnreferenced,
} from '../../src/modules/gateway/libs/management/functions/admin';
import {
  seedProviders,
  seedRoutes,
} from '../../src/modules/gateway/libs/management/functions/seed';
import { stats } from '../../src/modules/gateway/libs/management/functions/stats';
import type { Log } from '../../src/modules/gateway/libs/management/schemas/types';
import type { Route } from '../../src/modules/gateway/libs/routing/schemas/types';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');

const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function log(
  id: string,
  fallback: boolean,
  status: 'ok' | 'error' = 'ok',
  latency = 100,
  ts = minutesAgo(1),
): Log {
  return {
    id,
    ts,
    route: 'luna',
    provider: 'openai',
    upstream_model: 'gpt-6-luna',
    served_by: null,
    upstream_model_resolved: null,
    status,
    fallback_used: fallback,
    http_status: status === 'ok' ? 200 : 502,
    latency_ms: latency,
    questions: 1,
    prompt_tokens: null,
    cost_usd: null,
    cost_basis: null,
    tokens: null,
    error: status === 'ok' ? null : 'upstream HTTP 500',
    attempts: [],
  };
}

function route(id: string, alias: string, providerIds: string[]): Route {
  return {
    id,
    alias,
    description: alias,
    enabled: true,
    targets: providerIds.map((provider_id) => ({ provider_id, model: 'm' })),
    created_at: '',
    updated_at: '',
  };
}

describe('logs: fallback filter', () => {
  const all = [log('a', true), log('b', false), log('c', true, 'error'), log('d', false)];

  test('fallback=used keeps only requests that tried a later target', () => {
    expect(logPage(all, new URLSearchParams('fallback=used')).items.map((l) => l.id)).toEqual([
      'a',
      'c',
    ]);
  });

  test('fallback=none keeps only requests that answered on the first target', () => {
    expect(logPage(all, new URLSearchParams('fallback=none')).items.map((l) => l.id)).toEqual([
      'b',
      'd',
    ]);
  });

  test('combines with the other filters and with the before cursor', () => {
    expect(
      logPage(all, new URLSearchParams('fallback=used&status=error')).items.map((l) => l.id),
    ).toEqual(['c']);
    expect(
      logPage(all, new URLSearchParams('before=a&fallback=none')).items.map((l) => l.id),
    ).toEqual(['b', 'd']);
  });

  test('an unknown fallback value is refused with a 400', () => {
    expect(() => logPage(all, new URLSearchParams('fallback=sometimes'))).toThrow(
      'invalid fallback',
    );
    try {
      logPage(all, new URLSearchParams('fallback=yes'));
    } catch (caught) {
      expect((caught as GatewayError).status).toBe(400);
    }
  });
});

describe('provider in use (409)', () => {
  const routes: Route[] = [
    route('rte_1', 'luna', ['prv_openai', 'prv_openrouter']),
    route('rte_2', 'elephant', ['prv_openrouter']),
    route('rte_3', 'default', ['prv_mock']),
  ];

  test('deleting a provider that routes target names every blocking route, by id and alias', () => {
    let caught: unknown;
    try {
      requireUnreferenced('prv_openrouter', routes);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    const error = caught as GatewayError;
    expect(error.status).toBe(409);
    expect(error.body()).toEqual({
      message:
        'Provider is still a target of route "luna", "elephant". Remove it from those routes first.',
      type: 'invalid_request_error',
      code: 'provider_in_use',
      routes: [
        { id: 'rte_1', alias: 'luna' },
        { id: 'rte_2', alias: 'elephant' },
      ],
    });
  });

  test('an unreferenced provider can be deleted, and other errors carry no routes field', () => {
    expect(() => requireUnreferenced('prv_unused', routes)).not.toThrow();
    expect(new GatewayError(400, 'invalid_request_error', 'x').body()).not.toHaveProperty('routes');
  });
});

describe('confidence method of a response', () => {
  test('is none when no answer carries a confidence', () => {
    expect(gatewayConfidence(new Set())).toBe('none');
    const predicateOnly = validateRequest({
      input: 'x',
      questions: [{ name: 'p', type: 'predicate', instructions: 'is it?' }],
    });
    const parsed = fromUpstream({ answers: { q0: { probability: 0.9 } } }, predicateOnly, 'map');
    expect(parsed.confidenceMethod).toBe('none');
    expect(parsed.answers[0]?.confidence_method).toBeUndefined();
  });

  test('is none when every answer is a refusal', () => {
    const request = validateRequest({
      input: 'x',
      questions: [
        {
          name: 'c',
          type: 'choice',
          instructions: 'pick',
          choices: [
            { value: 'a', description: 'a' },
            { value: 'b', description: 'b' },
          ],
        },
        { name: 'p', type: 'predicate', instructions: 'is it?' },
      ],
    });
    const parsed = fromUpstream(
      {
        answers: [
          { question: 'c', type: 'choice', refusal: 'no' },
          { question: 'p', type: 'predicate', refusal: 'no' },
        ],
      },
      request,
      'openai',
    );
    expect(parsed.answers.every((answer) => 'refusal' in answer)).toBe(true);
    expect(parsed.confidenceMethod).toBe('none');
  });

  test('still reports upstream, normalized-entropy and mixed when answers carry confidence', () => {
    expect(gatewayConfidence(new Set(['upstream']))).toBe('upstream');
    expect(gatewayConfidence(new Set(['normalized-entropy']))).toBe('normalized-entropy');
    expect(gatewayConfidence(new Set(['upstream', 'normalized-entropy']))).toBe('mixed');
  });
});

describe('latency statistics', () => {
  test('an empty window has no latency: p50 and p95 are null, and so is every bucket', () => {
    const summary = stats([], '1h', NOW);
    expect(summary.requests).toBe(0);
    expect(summary.p50_ms).toBeNull();
    expect(summary.p95_ms).toBeNull();
    expect(summary.by_provider).toEqual([]);
    expect(summary.timeseries).toHaveLength(24);
    expect(
      summary.timeseries.every((bucket) => bucket.requests === 0 && bucket.p50_ms === null),
    ).toBe(true);
  });

  test('a window with requests reports nearest-rank percentiles, and empty buckets stay null', () => {
    const summary = stats(
      [
        log('a', false, 'ok', 100),
        log('b', false, 'ok', 300),
        log('c', false, 'error', 200, minutesAgo(30)),
      ],
      '1h',
      NOW,
    );
    expect(summary.requests).toBe(3);
    expect(summary.p50_ms).toBe(200);
    expect(summary.p95_ms).toBe(300);
    expect(
      summary.timeseries.filter((bucket) => bucket.requests > 0).every((b) => b.p50_ms !== null),
    ).toBe(true);
    expect(
      summary.timeseries.filter((bucket) => bucket.requests === 0).every((b) => b.p50_ms === null),
    ).toBe(true);
  });

  test('an empty bucket has no p95 and no fallbacks, and so does an empty window', () => {
    const summary = stats([], '24h', NOW);
    expect(summary.p95_ms).toBeNull();
    expect(summary.fallbacks).toBe(0);
    expect(summary.fallbacks_answered).toBe(0);
    expect(summary.timeseries).toHaveLength(24);
    expect(
      summary.timeseries.every(
        (b) => b.p95_ms === null && b.fallbacks === 0 && b.fallbacks_answered === 0,
      ),
    ).toBe(true);
  });

  test('a bucket reports the nearest-rank p95 of its own latencies and counts every fallback in it', () => {
    const tenAnswers = Array.from({ length: 10 }, (_, i) =>
      log(`r${i}`, i < 3, 'ok', (i + 1) * 100),
    );
    // Lands in the same final bucket as the ten above, and used a fallback before it failed.
    const failedFallback = log('boom', true, 'error', 50, minutesAgo(2));
    const summary = stats([...tenAnswers, failedFallback], '1h', NOW);
    expect(summary.timeseries[23]).toEqual({
      t: new Date(NOW - 3600000 + (23 * 3600000) / 24).toISOString(),
      requests: 11,
      errors: 1,
      p50_ms: 500,
      p95_ms: 1000,
      fallbacks: 4,
      fallbacks_answered: 3,
      cost_usd: 0,
    });
    expect(summary.fallbacks).toBe(4);
    expect(summary.fallbacks_answered).toBe(3);
  });

  test('a single-request bucket has its own latency as p50 and p95, and buckets add up to the window', () => {
    const summary = stats(
      [log('solo', false, 'ok', 77, minutesAgo(30)), log('late', true, 'ok', 900, minutesAgo(5))],
      '1h',
      NOW,
    );
    expect(summary.timeseries[12]).toMatchObject({
      requests: 1,
      p50_ms: 77,
      p95_ms: 77,
      fallbacks: 0,
      fallbacks_answered: 0,
    });
    expect(summary.timeseries[22]).toMatchObject({
      requests: 1,
      p50_ms: 900,
      p95_ms: 900,
      fallbacks: 1,
      fallbacks_answered: 1,
    });
    expect(summary.timeseries.reduce((sum, b) => sum + b.fallbacks, 0)).toBe(summary.fallbacks);
    expect(summary.timeseries.reduce((sum, b) => sum + b.fallbacks_answered, 0)).toBe(
      summary.fallbacks_answered,
    );
    expect(summary.fallbacks).toBe(1);
    expect(summary.fallbacks_answered).toBe(1);
  });

  test('answered fallbacks are the fallbacks that got a response, so a failed fallback is never one of them', () => {
    const summary = stats(
      [
        log('answered', true, 'ok', 300, minutesAgo(10)),
        log('failed', true, 'error', 900, minutesAgo(10)),
        log('direct', false, 'ok', 200, minutesAgo(10)),
        log('direct-error', false, 'error', 100, minutesAgo(10)),
      ],
      '1h',
      NOW,
    );
    expect(summary.fallbacks).toBe(2);
    expect(summary.fallbacks_answered).toBe(1);
    expect(summary.timeseries.every((b) => b.fallbacks_answered <= b.fallbacks)).toBe(true);
  });
});

describe('provider readiness and disabled targets', () => {
  test('a provider that needs no key is ready; an env key counts only when its variable is set', () => {
    const report = health(
      [
        { name: 'mock', enabled: true, key: { source: 'none' } },
        { name: 'openrouter', enabled: true, key: { source: 'env', present: false } },
        { name: 'openai', enabled: true, key: { source: 'stored' } },
      ],
      0,
      5000,
      true,
    );
    expect(report.providers.map((p) => p.key_present)).toEqual([true, false, true]);
  });

  test('a disabled provider is refused before any call, and the attempt says so', () => {
    const providers = seedProviders('2026-01-01T00:00:00.000Z', [
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
    const ids = Object.fromEntries(providers.map((p) => [p.name, p.id]));
    const routes = seedRoutes('2026-01-01T00:00:00.000Z', ids, ['r1', 'r2', 'r3']);
    const settings = {
      require_client_keys: false,
      capture_payloads: false,
      default_route: 'default',
    };
    const request = validateRequest({
      input: 'hi',
      questions: [{ name: 'q', type: 'predicate', instructions: 'test' }],
    });
    const disabled = providers.find((p) => p.name === 'llamacpp');
    expect(eligibility(disabled, request)).toEqual({ ok: false, message: 'provider disabled' });
    const start = initialState('default', settings, routes, providers).state;
    const next = reduceAttempt(
      start,
      failedOutcome(
        'llamacpp',
        'server-configured',
        0,
        2,
        new CallFailure('limit', 'provider disabled'),
      ),
    );
    expect(next.attempts).toEqual([
      {
        provider: 'llamacpp',
        model: 'server-configured',
        ok: false,
        latency_ms: 2,
        error: 'provider disabled',
      },
    ]);
    expect(next.stop).toBe(false);
  });
});
