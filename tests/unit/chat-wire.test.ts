import { expect, test } from 'bun:test';
import {
  chatBody,
  chatAnswer,
  labelDistribution,
  sumChatUsage,
  estimateChatTokens,
} from '../../src/modules/gateway/libs/decisions/functions/chat';
import type { Question } from '../../src/modules/gateway/libs/decisions/schemas/types';

const choice: Question = {
  name: 'team',
  type: 'choice',
  instructions: 'Pick a team',
  choices: [
    { value: true, description: 'Billing' },
    { value: 'technical', description: 'Technical' },
  ],
};

const response = (entries: { token: string; logprob: number }[], content = 'A') => ({
  choices: [{ message: { content }, logprobs: { content: [{ top_logprobs: entries }] } }],
});

test('chat prompt labels keep input and descriptions and always send model', () => {
  const body = chatBody('ticket', choice, 'model');
  expect(body).toMatchObject({ model: 'model', logprobs: true, top_logprobs: 20, max_tokens: 1 });
  expect(JSON.stringify(body.messages)).toContain('Billing');
  expect(JSON.stringify(body.messages)).toContain('ticket');
  // The label request asks for plain text, since real models otherwise echo the prompt's JSON shape.
  const ask = JSON.parse(String((body.messages as { content: string }[])[2].content)) as {
    reply: string;
  };
  expect(ask.reply).toContain('as plain text, for example A');
  expect(ask.reply).toContain('No JSON, quotes, punctuation');
  const override = chatBody('ticket', choice, 'model', {
    max_completion_tokens: 1,
    top_logprobs: 10,
    model: 'wrong',
  });
  expect(override.max_tokens).toBeUndefined();
  expect(override).toMatchObject({ max_completion_tokens: 1, top_logprobs: 10, model: 'model' });
  expect(estimateChatTokens([body, body])).toBeGreaterThan(estimateChatTokens([body]));
});

test('chat labels trim and case-fold, sum duplicate tokens, renormalize and keep missing labels zero', () => {
  const distribution = labelDistribution(
    ['A', 'B', 'C'],
    [
      { token: ' a', logprob: Math.log(0.2) },
      { token: 'A ', logprob: Math.log(0.1) },
      { token: 'b', logprob: Math.log(0.3) },
      { token: 'other', logprob: Math.log(0.4) },
    ],
  );
  expect(distribution[0]).toBeCloseTo(0.5);
  expect(distribution[1]).toBeCloseTo(0.5);
  expect(distribution[2]).toBe(0);
  expect(() => labelDistribution(['A', 'B'], [{ token: 'Apple', logprob: -1 }])).toThrow(
    'no matching labels',
  );
  expect(() => labelDistribution(['A', 'B'], null)).toThrow('top_logprobs');
});

test('chat answers choose maximum probability and use expected score and P(Yes)', () => {
  const answer = chatAnswer(
    choice,
    response([
      { token: 'A', logprob: Math.log(0.2) },
      { token: 'B', logprob: Math.log(0.8) },
    ]),
  );
  expect(answer).toMatchObject({ choice: 'technical', confidence_method: 'logprobs' });
  expect(answer.probabilities?.map((p) => p.value)).toEqual([true, 'technical']);
  expect(
    chatAnswer(
      { name: 'p', type: 'predicate', instructions: 'true?' },
      response(
        [
          { token: ' Yes', logprob: Math.log(0.7) },
          { token: 'No', logprob: Math.log(0.3) },
        ],
        'Yes',
      ),
    ).probability,
  ).toBeCloseTo(0.7);
  expect(
    chatAnswer(
      {
        name: 's',
        type: 'score',
        instructions: 'rate',
        levels: [{ description: 'low', label: 'low' }, { description: 'high' }],
      },
      response(
        [
          { token: '0', logprob: Math.log(0.2) },
          { token: '1', logprob: Math.log(0.8) },
        ],
        '1',
      ),
    ).score,
  ).toBeCloseTo(0.8);
});

test('chat refuses missing logprobs, refusals and non-label content', () => {
  expect(() => chatAnswer(choice, { choices: [{ message: { content: 'A' } }] })).toThrow(
    'top_logprobs',
  );
  expect(() =>
    chatAnswer(choice, { choices: [{ message: { content: null, refusal: 'No' } }] }),
  ).toThrow('refused');
  expect(() => chatAnswer(choice, response([{ token: 'A', logprob: 0 }], 'I cannot help'))).toThrow(
    'did not return a label',
  );
});

test('chat usage sums counts and cache details; incomplete usage stays unknown', () => {
  const usage = {
    input_tokens: 10,
    output_tokens: 1,
    total_tokens: 11,
    input_tokens_details: { cached_tokens: 4 },
  };
  expect(sumChatUsage([usage, usage])).toEqual({
    input_tokens: 20,
    output_tokens: 2,
    total_tokens: 22,
    input_tokens_details: { cached_tokens: 8 },
  });
  expect(sumChatUsage([usage, null])).toBeNull();
});

test('chat questions share a fixed prefix containing the input before question-specific content', () => {
  const first = chatBody('shared long input', choice, 'm').messages as {
    role: string;
    content: string;
  }[];
  const second = chatBody(
    'shared long input',
    { name: 'p', type: 'predicate', instructions: 'another question' },
    'm',
  ).messages as { role: string; content: string }[];
  expect(first.slice(0, 2)).toEqual(second.slice(0, 2));
  expect(first[1].content).toContain('shared long input');
  expect(first[2]).not.toEqual(second[2]);
});
