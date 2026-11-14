import { test, expect } from 'bun:test';
import {
  chatBody,
  compactSchema,
  compactAnswers,
  firstJsonObject,
  jsonChatBody,
  samplingDistribution,
  logprobState,
  chatLabels,
  labelKey,
  fromChat,
} from '../../src/modules/gateway/libs/decisions/functions/chat';
import type { Question } from '../../src/modules/gateway/libs/decisions/schemas/types';

const q: Question = {
  name: 'team',
  type: 'choice',
  instructions: 'pick',
  choices: [
    { value: true, description: 'yes' },
    { value: 'no', description: 'no' },
  ],
};
const questions = [
  { index: 0, question: q },
  { index: 2, question: { name: 'p', type: 'predicate', instructions: 'test' } as Question },
];

const samples = (...content: string[]) => ({
  choices: content.map((text) => ({ message: { content: text } })),
});

test('sampling parses letter and numbered labels and counts raw frequencies with the half-valid rule', () => {
  expect(samplingDistribution(q, [samples(' A ', 'b', '?', '?')], 4)).toEqual([0.5, 0.5]);
  expect(samplingDistribution(q, [samples('A', '?', '?', '?')], 4)).toBeNull();
  const thirty = {
    ...q,
    choices: Array.from({ length: 30 }, (_, i) => ({ value: i, description: `${i}` })),
  };
  expect(chatLabels(thirty, true)).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 1)));
  expect(samplingDistribution(thirty, [samples('30', ' 30 ')], 2)?.[29]).toBe(1);
  expect(
    samplingDistribution(q, [samples('A'), samples('B'), samples('B'), samples('B')], 4),
  ).toEqual([0.25, 0.75]);
});

test('compact JSON schema uses question ids and exact ordered percentage arrays', () => {
  expect(compactSchema(questions)).toMatchObject({
    required: ['q0', 'q2'],
    additionalProperties: false,
    properties: {
      q0: { type: 'array', minItems: 2, maxItems: 2 },
      q2: { type: 'integer', minimum: 0, maximum: 100 },
    },
  });
  const body = jsonChatBody('input', questions, 'model', 'json_schema');
  expect(body).toMatchObject({
    response_format: { type: 'json_schema', json_schema: { strict: true } },
  });
  expect(body.tools).toBeUndefined();
  expect(jsonChatBody('input', questions, 'model', 'prompt').response_format).toBeUndefined();
});

test('compact JSON renormalizes integer estimates and parses the first object in prompt text', () => {
  const result = compactAnswers(
    firstJsonObject('Here is JSON: {"q0":[60,20],"q2":75} trailing'),
    questions,
  );
  expect(result[0]).toMatchObject({
    choice: true,
    confidence_method: 'json',
    probabilities: [
      { value: true, probability: 0.75 },
      { value: 'no', probability: 0.25 },
    ],
  });
  expect(result[1]).toMatchObject({ probability: 0.75, confidence_method: 'json' });
  const quoted = JSON.stringify({ x: 'brace } and " quote' });
  expect(firstJsonObject(`prefix ${quoted} suffix`)).toBe(quoted);
});

test('compact JSON rejects missing keys, wrong lengths, non-integers, negatives, zero mass and invalid JSON', () => {
  for (const text of [
    'oops',
    '{}',
    '{"q0":[80],"q2":75}',
    '{"q0":[80.1,20],"q2":75}',
    '{"q0":[-1,100],"q2":75}',
    '{"q0":[0,0],"q2":75}',
    '{"q0":[80,"20"],"q2":75}',
    '{"q0":[80,20],"q2":101}',
  ])
    expect(() => compactAnswers(text, questions)).toThrow();
});

test('unmatched first-token logprobs advances without claiming the model has no logprobs', () => {
  expect(
    logprobState(
      {
        choices: [
          {
            message: { content: '?' },
            logprobs: { content: [{ top_logprobs: [{ token: '?', logprob: 0 }] }] },
          },
        ],
      },
      q,
    ),
  ).toBe('unmatched');
});

test('non-label generated content advances despite label logprobs, while explicit refusals fail', () => {
  const raw = {
    choices: [
      {
        message: { content: '?' },
        logprobs: { content: [{ top_logprobs: [{ token: 'A', logprob: -0.2 }] }] },
      },
    ],
  };
  expect(logprobState(raw, q)).toBe('unmatched');
  expect(() =>
    logprobState(
      { choices: [{ ...raw.choices[0], message: { content: null, refusal: 'No' } }] },
      q,
    ),
  ).toThrow('refused');
  expect(() =>
    logprobState({ choices: [{ ...raw.choices[0], finish_reason: 'content_filter' }] }, q),
  ).toThrow('refused');
});

test('labels as text tolerate a trailing period and matching quotes, and nothing else', () => {
  expect(['Yes.', ' "yes" ', '`YES`', "'Yes.'", 'Yes'].map(labelKey)).toEqual(
    Array<string>(5).fill('yes'),
  );
  expect(['Yes!', '"Yes', 'Yes..', 'Yes, it does', '{"output":"Yes"}'].map(labelKey)).not.toContain(
    'yes',
  );
  const predicate = { name: 'p', type: 'predicate' as const, instructions: 'true?' };

  const samples = (texts: string[]) => ({
    choices: texts.map((content) => ({ message: { content } })),
  });

  // Real llama samples on OpenRouter: three of four carried a period.
  expect(samplingDistribution(predicate, [samples(['Yes.', 'Yes', 'Yes.', 'No.'])], 4)).toEqual([
    0.75, 0.25,
  ]);
  expect(samplingDistribution(predicate, [samples(['Yes!', 'Yes!', 'Yes!', 'No'])], 4)).toBeNull();
});

test('summed billed costs drop floating-point noise, and a refused call is not among the calls', () => {
  const predicate = { name: 'p', type: 'predicate' as const, instructions: 'true?' };
  // Real OpenRouter costs of twelve llama sampling calls on 2026-11-11, whose float sum is 3.5440000000000006e-05.
  const costs = [
    2.82e-6, 3.1e-6, 2.94e-6, 2.82e-6, 2.82e-6, 3.1e-6, 3.1e-6, 3.1e-6, 2.94e-6, 2.94e-6, 2.82e-6,
    2.94e-6,
  ];
  expect(costs.reduce((sum, cost) => sum + cost, 0)).not.toBe(3.544e-5);
  const parsed = fromChat(
    {
      answers: [{ type: 'predicate', name: 'p', probability: 1, confidence_method: 'sampling' }],
      calls: costs.map((cost) => ({
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost },
        provider: 'DeepInfra',
      })),
      requests: [],
      refused: [{ error: { message: "'logprobs' is not supported", param: 'logprobs' } }],
    },
    { input: 'x', questions: [predicate] },
  );
  expect(parsed.billed).toBe(3.544e-5);
  expect(parsed.usage).toMatchObject({ input_tokens: 120, output_tokens: 12, total_tokens: 132 });
  expect(parsed.servedBy).toBe('DeepInfra');
});

test('extra_body logprobs options reach only logprobs calls, so top_logprobs 5 does not break sampling or JSON', () => {
  // Fireworks and Novita through OpenRouter refuse top_logprobs 20 with an opaque HTTP 400 (2026-11-11); a sampling
  // call that carried top_logprobs without logprobs was refused the same way.
  const extra = { top_logprobs: 5, provider: { only: ['Fireworks'] } };
  expect(chatBody('input', q, 'model', extra)).toMatchObject({ logprobs: true, top_logprobs: 5 });
  const sampled = chatBody('input', q, 'model', extra, 4);
  expect(sampled).toMatchObject({ n: 4, provider: { only: ['Fireworks'] } });
  expect('top_logprobs' in sampled || 'logprobs' in sampled).toBe(false);
  const json = jsonChatBody('input', questions, 'model', 'prompt', { ...extra, logprobs: true });
  expect(json).toMatchObject({ provider: { only: ['Fireworks'] } });
  expect('top_logprobs' in json || 'logprobs' in json).toBe(false);
  expect(chatBody('input', q, 'model', {}).top_logprobs).toBe(20);
});
