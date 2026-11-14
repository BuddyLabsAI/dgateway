import { describe, expect, test } from 'bun:test';
import { validateRequest } from '../../src/modules/gateway/libs/decisions/functions/validation';
import {
  toMapWire,
  fromUpstream,
  normalizedEntropy,
  expectedScore,
} from '../../src/modules/gateway/libs/decisions/functions/translation';
import {
  resolveRoute,
  shouldFallback,
} from '../../src/modules/gateway/libs/routing/functions/routing';
import type { Route } from '../../src/modules/gateway/libs/routing/schemas/types';
import { redact } from '../../src/modules/gateway/libs/management/functions/redact';
const request = validateRequest({
  input: 'hello',
  questions: [
    {
      name: 'yes',
      type: 'choice',
      instructions: 'choose',
      choices: [
        { value: true, description: 'yes' },
        { value: 42, description: 'no' },
      ],
    },
    { name: 'p', type: 'predicate', instructions: 'test' },
    {
      name: 's',
      type: 'score',
      instructions: 'score',
      levels: [
        { label: 'low', description: 'l' },
        { label: 'mid', description: 'm' },
        { label: 'high', description: 'h' },
      ],
    },
  ],
});
describe('decision translation', () => {
  test('preserves ids, order and typed values, and derives scores', () => {
    const wire = toMapWire(request);
    expect(wire.questions.q0.criteria).toEqual({ o0: 'yes', o1: 'no' });
    expect(wire.questions.q1.type).toBe('noul');
    expect(wire.questions.q1).not.toHaveProperty('criteria');
    // A score's levels go as an ordered list: index i is level i.
    expect(wire.questions.q2.criteria).toEqual(['l', 'm', 'h']);
    const x = fromUpstream(
      {
        answers: {
          q0: { type: 'choice', choice: 'o0', probabilities: { o0: 0.8, o1: 0.2 } },
          q1: { type: 'noul', noul: 0.5 },
          q2: { type: 'score', score: 1.6, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } },
        },
      },
      request,
      'map',
    );
    expect(x.answers.map((a) => a.name)).toEqual(['yes', 'p', 's']);
    expect(x.answers[0].choice).toBe(true);
    expect(x.answers[0].probabilities).toEqual([
      { value: true, probability: 0.8 },
      { value: 42, probability: 0.2 },
    ]);
    expect(x.answers[0].confidence_method).toBe('normalized-entropy');
    expect(x.answers[1]).toEqual({ type: 'predicate', name: 'p', probability: 0.5 });
    expect(x.answers[2].score).toBeCloseTo(1.6);
    expect(x.answers[2].probabilities).toEqual([
      { value: 0, label: 'low', probability: 0.1 },
      { value: 1, label: 'mid', probability: 0.2 },
      { value: 2, label: 'high', probability: 0.7 },
    ]);
    // OpenAI's shape carries no value beside choice, probability and score.
    expect(x.answers.every((a) => !('value' in a))).toBe(true);
    const different = validateRequest({
      input: 'x',
      questions: [
        {
          name: 'x',
          type: 'choice',
          instructions: 'x',
          choices: [
            { value: 'true', description: 'a' },
            { value: false, description: 'b' },
          ],
        },
      ],
    });
    expect(
      fromUpstream(
        { answers: { q0: { choice: 'o0', probabilities: { o0: 0.5, o1: 0.5 } } } },
        different,
        'map',
      ).answers[0].choice,
    ).toBe('true');
  });
  test('entropy and expectations', () => {
    expect(normalizedEntropy([0.8, 0.1, 0.1])).toBeCloseTo(0.4183, 4);
    expect(expectedScore([0.1, 0.2, 0.7])).toBeCloseTo(1.6);
  });
  test('rejects malformed upstream', () => {
    expect(() => fromUpstream({ answers: {} }, request, 'map')).toThrow();
  });
});
describe('validation', () => {
  test('rejects duplicate names, collisions, wrong fields and unknowns', () => {
    const q = { name: 'q', type: 'predicate', instructions: 'go' };
    for (const bad of [
      { input: 'x', questions: [q, q] },
      {
        input: 'x',
        questions: [
          {
            name: 'a',
            type: 'choice',
            instructions: 'x',
            choices: [
              { value: true, description: 'a' },
              { value: 'true', description: 'b' },
            ],
          },
        ],
      },
      { input: 'x', questions: [{ ...q, choices: [] }] },
      { input: 'x', questions: [{ ...q, extra: 1 }] },
      { input: 'x', questions: [q], extra: 1 },
      {
        input: 'x',
        questions: [
          {
            name: 's',
            type: 'score',
            instructions: 'x',
            levels: [
              { description: 'a', label: 'same' },
              { description: 'b', label: 'same' },
            ],
          },
        ],
      },
    ])
      expect(() => validateRequest(bad)).toThrow();
  });
});
test('route resolution and fallback', () => {
  const routes: Route[] = [
      {
        id: 'rte_a',
        alias: 'a',
        description: 'route a',
        enabled: true,
        targets: [{ provider_id: '1', model: 'm' }],
        created_at: '',
        updated_at: '',
      },
    ],
    providers = [{ id: '1', name: 'p' }];
  expect(resolveRoute(undefined, 'a', routes, providers)?.route).toBe('a');
  expect(resolveRoute('p::x', null, routes, providers)?.targets[0]?.model).toBe('x');
  expect(resolveRoute('no', null, routes, providers)).toBeNull();
  expect(shouldFallback('http', 500)).toBe(true);
  expect(shouldFallback('http', 429)).toBe(true);
  expect(shouldFallback('http', 400)).toBe(false);
  expect(shouldFallback('http', 422)).toBe(false);
  for (const status of [401, 403, 404, 408, 429, 500])
    expect(shouldFallback('http', status)).toBe(true);
  expect(shouldFallback('timeout')).toBe(true);
});
test('redacts nested sensitive keys and secrets', () => {
  expect(
    redact({ headers: { Authorization: 'Bearer abc' }, api_key: 'abc', input: 'abc good' }, [
      'abc',
    ]),
  ).toEqual({
    headers: { Authorization: '[REDACTED]' },
    api_key: '[REDACTED]',
    input: '[REDACTED] good',
  });
});

test('mixed confidence reports per-answer methods', () => {
  const x = fromUpstream(
    {
      answers: {
        q0: { choice: 'o0', probabilities: { o0: 0.8, o1: 0.2 }, confidence: 0.7 },
        q1: { probability: 0.2 },
        q2: { probabilities: { l0: 0.1, l1: 0.2, l2: 0.7 } },
      },
    },
    request,
    'map',
  );
  expect(x.confidenceMethod).toBe('mixed');
  expect(x.answers[0].confidence_method).toBe('upstream');
  expect(x.answers[1].confidence_method).toBeUndefined();
  expect(x.answers[2].confidence_method).toBe('normalized-entropy');
});
test('redaction preserves token counts', () => {
  expect(redact({ prompt_tokens: 12, total_tokens: 20, access_token: 'abc' })).toEqual({
    prompt_tokens: 12,
    total_tokens: 20,
    access_token: '[REDACTED]',
  });
});

test('non-empty whitespace is valid and expected score is the stated weighted sum', () => {
  expect(
    validateRequest({
      input: ' ',
      questions: [{ name: ' ', type: 'predicate', instructions: ' ' }],
    }).input,
  ).toBe(' ');
  expect(expectedScore([0.2, 0.79])).toBe(0.79);
});
