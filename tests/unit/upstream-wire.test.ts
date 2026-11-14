// The upstream wires against real traffic (tests/fixtures): the SystemOne map wire as OpenRouter speaks it, and the
// openai wire as OpenAI's Decisions API speaks it. Requests must be the bodies those APIs accept; answers must read
// back into the public shape, which is OpenAI's own.
import { describe, expect, test } from 'bun:test';
import { documentedInGatewayIds, openai, openrouter } from '../fixtures/upstreams';
import { validateRequest } from '../../src/modules/gateway/libs/decisions/functions/validation';
import {
  fromUpstream,
  normalizedEntropy,
  toMapWire,
} from '../../src/modules/gateway/libs/decisions/functions/translation';
import { upstreamBody } from '../../src/modules/gateway/libs/decisions/functions/execution';
import { seedProviders } from '../../src/modules/gateway/libs/management/functions/seed';
import type { Provider } from '../../src/modules/gateway/libs/management/schemas/types';

const live = openrouter.captured_2026_11_08_live;
const documented = openrouter.documented_example_openrouter_docs;
const providers = seedProviders('2026-01-01T00:00:00.000Z', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);

const byName = (name: string): Provider => providers.find((p) => p.name === name)!;

// The decision behind the live OpenRouter capture: which team, and whether it is urgent.
const liveRequest = validateRequest({
  model: 'triage',
  input: 'I was charged twice for my subscription.',
  questions: [
    {
      name: 'team',
      type: 'choice',
      instructions: 'Which team?',
      choices: [
        { value: 'payments', description: 'Payments' },
        { value: 'bugs', description: 'Bugs' },
      ],
    },
    { name: 'urgent', type: 'predicate', instructions: 'Is it urgent?' },
  ],
});

// The decision behind OpenRouter's documented example, in the order documentedInGatewayIds names it.
const documentedRequest = validateRequest({
  input: 'Checkout fails for every customer paying by card.',
  questions: [
    {
      name: 'team',
      type: 'choice',
      instructions: 'Which team owns this ticket?',
      choices: [
        { value: 'account', description: 'Account and login' },
        { value: 'frontend', description: 'The web app' },
        { value: 'payments', description: 'Payments and billing' },
      ],
    },
    { name: 'is_bug', type: 'predicate', instructions: 'Is this a bug?' },
    {
      name: 'urgency',
      type: 'score',
      instructions: 'How urgent is this ticket?',
      levels: [
        { label: 'later', description: 'Can wait for the next release' },
        { label: 'this-week', description: 'Should be fixed this week' },
        { label: 'now', description: 'Blocking revenue right now' },
      ],
    },
  ],
});

// The live OpenAI request, as a decision for the luna route.
const openaiRequest = validateRequest({ ...openai.trace.upstream_request, model: 'luna' });

describe('the SystemOne request', () => {
  test('the live decision translates to exactly the body OpenRouter answered', () => {
    expect(
      upstreamBody(
        byName('openrouter'),
        live.request_choice_predicate.model as string,
        liveRequest,
      ),
    ).toEqual(live.request_choice_predicate);
  });

  test('score levels go as an ordered list of descriptions, as OpenRouter documents them', () => {
    const score = documentedRequest.questions[2];
    const wire = toMapWire({ input: 'x', questions: [score] });
    expect(wire.questions.q0 as unknown).toEqual(documented.request_score.urgency);
    expect(wire.questions.q0.criteria).toEqual([
      'Can wait for the next release',
      'Should be fixed this week',
      'Blocking revenue right now',
    ]);
  });

  test('every map-wire provider sends the list: OpenRouter, a hosted and a local SystemOne server, and the mock', () => {
    const hosted = { ...byName('llamacpp'), base_url: 'https://api.typesafe.ai', send_model: true };
    const local = { ...byName('llamacpp'), enabled: true };
    for (const p of [byName('openrouter'), hosted, local, byName('mock')]) {
      const body = upstreamBody(p, 'm', documentedRequest) as ReturnType<typeof toMapWire>;
      expect(body.questions.q2.criteria as unknown, p.name).toEqual(
        documented.request_score.urgency.criteria,
      );
      // A choice keeps its options keyed by id, and a noul has no criteria.
      expect(body.questions.q0.criteria, p.name).toEqual({
        o0: 'Account and login',
        o1: 'The web app',
        o2: 'Payments and billing',
      });
      expect(body.questions.q1, p.name).toEqual({ type: 'noul', instructions: 'Is this a bug?' });
    }
  });
});

describe('reading a SystemOne answer', () => {
  test('the live answer: a choice by option id and a noul, with usage, cost and who served it', () => {
    const parsed = fromUpstream(live.response_choice_predicate, liveRequest, 'map');
    expect(parsed.answers).toEqual([
      {
        type: 'choice',
        name: 'team',
        choice: 'payments',
        probabilities: [
          { value: 'payments', probability: 0.8708197184652482 },
          { value: 'bugs', probability: 0.1291802815347518 },
        ],
        confidence: 0.7416394369304964,
        confidence_method: 'upstream',
      },
      { type: 'predicate', name: 'urgent', probability: 0.44030027324867504 },
    ]);
    expect(parsed.usage).toEqual({ input_tokens: 177, output_tokens: 2, total_tokens: 179 });
    expect(parsed.billed).toBe(1.77e-6);
    expect(parsed.servedBy).toBe('Perplexity');
    expect(parsed.resolvedModel).toBe('perplexity/pplx-decider-flash-v1.2-20261016');
    expect(parsed.confidenceMethod).toBe('upstream');
  });

  test('the documented example: a score by level index, whose score the gateway works out to the upstream one', () => {
    const upstream = documentedInGatewayIds();
    const parsed = fromUpstream(upstream, documentedRequest, 'map');
    const [team, bug, urgency] = parsed.answers;
    expect(team).toMatchObject({ choice: 'payments', confidence: 0.75 });
    expect(team.probabilities).toEqual([
      { value: 'account', probability: 0 },
      { value: 'frontend', probability: 0.16 },
      { value: 'payments', probability: 0.84 },
    ]);
    expect(bug).toEqual({ type: 'predicate', name: 'is_bug', probability: 0.96 });
    expect(urgency.probabilities).toEqual([
      { value: 0, label: 'later', probability: 0 },
      { value: 1, label: 'this-week', probability: 0.01 },
      { value: 2, label: 'now', probability: 0.99 },
    ]);
    expect(urgency).toMatchObject({
      type: 'score',
      confidence: 0.99,
      confidence_method: 'upstream',
    });
    // Worked out from the distribution, and it agrees with the score OpenRouter sent.
    expect(urgency.score).toBeCloseTo((upstream.answers.q2 as { score: number }).score, 10);
    expect(parsed.usage).toEqual({ input_tokens: 476, output_tokens: 70, total_tokens: 546 });
    expect(parsed.billed).toBe(0.000019992);
    expect(parsed).toMatchObject({
      servedBy: 'TypeSafe',
      resolvedModel: 'typesafe/jev-1.13-20260917',
    });
  });

  test('a score without labels lists its levels by index alone', () => {
    const plain = validateRequest({
      input: 'x',
      questions: [
        {
          name: 's',
          type: 'score',
          instructions: 'x',
          levels: [{ description: 'a' }, { description: 'b' }],
        },
      ],
    });
    const parsed = fromUpstream(
      { answers: { q0: { type: 'score', score: 0.25, probabilities: { '0': 0.75, '1': 0.25 } } } },
      plain,
      'map',
    );
    expect(parsed.answers[0]).toEqual({
      type: 'score',
      name: 's',
      score: 0.25,
      probabilities: [
        { value: 0, probability: 0.75 },
        { value: 1, probability: 0.25 },
      ],
      confidence: normalizedEntropy([0.75, 0.25]),
      confidence_method: 'normalized-entropy',
    });
  });

  test('older map-wire shapes still read: probability for a predicate, l-keyed scores, prompt_tokens usage', () => {
    const parsed = fromUpstream(
      {
        answers: {
          q0: { choice: 'o2', probabilities: { o0: 0.1, o1: 0.1, o2: 0.8 } },
          q1: { probability: 0.3 },
          q2: { choice: 'l1', probabilities: { l0: 0.2, l1: 0.5, l2: 0.3 } },
        },
        usage: { prompt_tokens: 40, total_tokens: 45 },
      },
      documentedRequest,
      'map',
    );
    expect(parsed.answers.map((a) => a.choice ?? a.probability ?? a.score)).toEqual([
      'payments',
      0.3,
      1.1,
    ]);
    expect(parsed.usage).toEqual({ input_tokens: 40, output_tokens: 5, total_tokens: 45 });
    expect(parsed).toMatchObject({ billed: null, servedBy: null, resolvedModel: null });
  });

  test('strict about what matters: probabilities, ids and token counts', () => {
    const answers = documentedInGatewayIds().answers;
    const bad: [string, Record<string, unknown>, string][] = [
      ['a noul out of range', { ...answers, q1: { noul: 1.5 } }, 'invalid predicate probability'],
      [
        'an unknown option id',
        { ...answers, q0: { ...answers.q0, choice: 'payments' } },
        'invalid choice id',
      ],
      [
        'probabilities that do not add up',
        { ...answers, q2: { ...answers.q2, probabilities: { '0': 0.5, '1': 0.5, '2': 0.5 } } },
        'invalid probabilities',
      ],
      [
        'a score keyed by label',
        { ...answers, q2: { ...answers.q2, probabilities: { later: 0, 'this-week': 0, now: 1 } } },
        'invalid probabilities',
      ],
      [
        'a confidence out of range',
        { ...answers, q0: { ...answers.q0, confidence: 2 } },
        'invalid confidence',
      ],
    ];
    for (const [what, shape, message] of bad)
      expect(() => fromUpstream({ answers: shape }, documentedRequest, 'map'), what).toThrow(
        message,
      );
    for (const usage of [
      { input_tokens: -1, output_tokens: 2 },
      { input_tokens: 2.5 },
      { cost: 0.1 },
      'lots',
    ])
      expect(
        () => fromUpstream({ answers, usage }, documentedRequest, 'map'),
        JSON.stringify(usage),
      ).toThrow('invalid usage');
  });

  test('tolerant of the rest: unknown fields, a null confidence, a cost that is not a number', () => {
    const answers = documentedInGatewayIds().answers;
    const parsed = fromUpstream(
      {
        answers: { ...answers, q0: { ...answers.q0, confidence: null, note: 'extra' } },
        usage: { input_tokens: 10, output_tokens: 1, cost: '0.5', is_byok: true },
        provider: '',
        model: 42,
        id: 'gen-1',
      },
      documentedRequest,
      'map',
    );
    expect(parsed.answers[0].confidence_method).toBe('normalized-entropy');
    expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 1, total_tokens: 11 });
    expect(parsed).toMatchObject({ billed: null, servedBy: null, resolvedModel: null });
  });
});

describe("OpenAI's real Decisions shape", () => {
  test('the request the gateway builds is the one OpenAI answered', () => {
    expect(upstreamBody(byName('openai'), 'gpt-6-luna', openaiRequest)).toEqual(
      openai.trace.upstream_request,
    );
  });

  test("the live answer reads back as it came, plus each answer's confidence method", () => {
    const upstream = openai.trace.upstream_response;
    const parsed = fromUpstream(upstream, openaiRequest, 'openai');
    expect(parsed.answers as unknown).toEqual(
      upstream.answers.map((answer) =>
        'confidence' in answer ? { ...answer, confidence_method: 'upstream' } : answer,
      ),
    );
    expect(parsed.usage as unknown).toEqual(upstream.usage);
    expect(parsed).toMatchObject({ billed: null, servedBy: null, resolvedModel: 'gpt-6-luna' });
  });

  test('typed values stay typed: the boolean option true is not the string "true"', () => {
    const upstream = openai.trace.upstream_response;
    const [team] = upstream.answers as { probabilities: { value: unknown }[] }[];
    const answers = [
      {
        ...upstream.answers[0],
        probabilities: team.probabilities.map((p) =>
          p.value === true ? { ...p, value: 'true' } : p,
        ),
      },
      ...upstream.answers.slice(1),
    ];
    expect(() => fromUpstream({ ...upstream, answers }, openaiRequest, 'openai')).toThrow(
      'invalid probabilities',
    );
    const typed = fromUpstream(upstream, openaiRequest, 'openai').answers[0];
    expect(typed.probabilities?.map((p) => p.value)).toEqual(['billing', 'technical', true]);
  });

  test('an older openai-compatible server still reads: question, value and keyed probabilities', () => {
    const parsed = fromUpstream(
      {
        answers: [
          {
            question: 'team',
            type: 'choice',
            value: true,
            probabilities: { billing: 0.2, technical: 0.1, true: 0.7 },
            confidence: 0.6,
          },
          { question: 'urgent', type: 'predicate', value: true, probability: 0.8 },
          {
            question: 'severity',
            type: 'score',
            value: 2,
            score: 1.25,
            probabilities: { minor: 0.25, major: 0.25, critical: 0.5 },
          },
        ],
        usage: { prompt_tokens: 12, total_tokens: 12 },
      },
      openaiRequest,
      'openai',
    );
    expect(parsed.answers.map((a) => [a.name, a.choice ?? a.probability ?? a.score])).toEqual([
      ['team', true],
      ['urgent', 0.8],
      ['severity', 1.25],
    ]);
    expect(parsed.answers[2].probabilities?.map((p) => p.label)).toEqual([
      'minor',
      'major',
      'critical',
    ]);
    expect(parsed.usage).toEqual({ input_tokens: 12, output_tokens: 0, total_tokens: 12 });
  });

  test('an answer for another question, or of another type, is refused', () => {
    const upstream = openai.trace.upstream_response;
    const renamed = [{ ...upstream.answers[0], name: 'department' }, ...upstream.answers.slice(1)];
    const retyped = [
      upstream.answers[0],
      { ...upstream.answers[1], type: 'score' },
      upstream.answers[2],
    ];
    for (const answers of [renamed, retyped])
      expect(() => fromUpstream({ answers }, openaiRequest, 'openai')).toThrow(
        'answer identity mismatch',
      );
  });
});
