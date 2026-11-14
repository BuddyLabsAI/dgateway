// Chat-wire fixtures cover several hosted and open-weight models across logprobs, sampling and JSON transports.
// The gateway's pure readers extract answers, usage and billed costs from the example completions.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  chatLabels,
  compactAnswers,
  firstJsonObject,
  fromChat,
  labelDistribution,
  labelKey,
  logprobState,
  samplingDistribution,
  logprobsRefusal,
  mandatoryReasoning,
} from '../../src/modules/gateway/libs/decisions/functions/chat';
import type {
  Answer,
  DecisionRequest,
  Question,
  Usage,
} from '../../src/modules/gateway/libs/decisions/schemas/types';

type Completion = {
  choices: {
    message: { content: string | null };
    logprobs?: { content: { top_logprobs: unknown[] }[] };
  }[];
};
type Case = {
  calls: Completion[];
  requests?: { reasoning?: unknown; top_logprobs?: number; max_tokens?: number }[];
  refused?: unknown[];
  response: {
    answers: Answer[];
    usage: NonNullable<Usage>;
    gateway: {
      served_by: string | null;
      upstream_model_resolved: string | null;
      cost_usd: number | null;
      cost_basis: string;
      confidence_method: string;
    };
  };
};
type Capture = {
  request: Omit<DecisionRequest, 'model'>;
  cases: Record<string, Case>;
  failures?: Record<string, { model: string; error: string; note: string }>;
};

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as Capture;

const capture = read('chat-real.json');
const open = read('chat-real-open.json');
// Both captures ask the same three questions.
const request = capture.request as DecisionRequest;
const questions = request.questions;
const cases = [...Object.entries(capture.cases), ...Object.entries(open.cases)];

// The question a label answers. These captures' label sets do not overlap: A..C, Yes/No and 0..2.
const questionOf = (text: string | null): Question | undefined =>
  text === null
    ? undefined
    : questions.find((q) => chatLabels(q).some((label) => labelKey(label) === labelKey(text)));

const distribution = (a: Answer): number[] =>
  a.type === 'predicate'
    ? [a.probability!, 1 - a.probability!]
    : a.probabilities!.map((p) => p.probability);

const answerFor = (c: Case, q: Question): Answer =>
  c.response.answers.find((a) => a.name === q.name)!;

test('the captures cover every method on both providers and on the open-weight models', () => {
  expect(open.request).toEqual(capture.request);
  for (const [c, count] of [
    [capture, 18],
    [open, 47],
  ] as const) {
    expect(Object.keys(c.cases).length).toBe(count);
    const methods = new Set(
      Object.values(c.cases).map((x) => x.response.gateway.confidence_method),
    );
    expect([...methods].sort()).toEqual(['json', 'logprobs', 'sampling']);
  }
});

test('every recorded failure names its model, error and what happened', () => {
  const failures = Object.values(open.failures ?? {});
  expect(failures.length).toBeGreaterThan(0);
  for (const f of failures) {
    expect(f.model).toStartWith('openrouter::');
    expect(f.error.length).toBeGreaterThan(0);
    expect(f.note.length).toBeGreaterThan(0);
  }
});

test('a thinking model answers the label after its reasoning, and its logprobs cover only the label', () => {
  const c = open.cases['openrouter-qwen3.8-27b-thinking-logprobs'];
  for (const call of c.calls) {
    const content = call.choices[0].message.content!;
    expect(content).toStartWith('\n\n');
    expect(call.choices[0].logprobs!.content).toHaveLength(1);
    expect(logprobState(call, questionOf(content)!)).toBe('ok');
  }
  expect(c.response.usage.output_tokens).toBeGreaterThan(c.calls.length);
});

test('with no reasoning settings, the gateway sent reasoning only to reasoning models and recovered on GLM', () => {
  const auto = (model: string) => open.cases[`openrouter-${model}-auto-default`];

  // Llama 4 Maverick and Mistral Small 3.2 list no reasoning parameter: nothing sent, and pinned hosts still answered.
  for (const model of ['llama-4-maverick', 'mistral-small-3.2']) {
    const c = auto(model);
    expect(c.requests!.every((r) => r.reasoning === undefined)).toBe(true);
    expect(c.response.gateway.confidence_method).toBe('logprobs');
  }
  // Qwen 3.8 27B thinks by default: reasoning off was sent and every label came back with logprobs.
  const qwen = auto('qwen3.8-27b');
  expect(qwen.requests!.every((r) => JSON.stringify(r.reasoning) === '{"enabled":false}')).toBe(
    true,
  );
  expect(qwen.response.gateway.confidence_method).toBe('logprobs');
  // GLM 5.3 Flash on Fireworks: reasoning off refused as mandatory, retried at low effort with 2048 more tokens,
  // then top_logprobs 20 refused with an opaque 400 and retried with 5.
  const glm = auto('glm-5.3-flash');
  expect(glm.requests!.map((r) => [r.reasoning, r.top_logprobs, r.max_tokens])).toEqual([
    ...Array.from({ length: 3 }, () => [{ enabled: false }, 20, 1]),
    ...Array.from({ length: 3 }, () => [{ effort: 'low' }, 20, 2049]),
    ...Array.from({ length: 3 }, () => [{ effort: 'low' }, 5, 2049]),
  ]);
  expect(glm.refused!.slice(0, 3).every((body) => mandatoryReasoning(400, body))).toBe(true);
  expect(glm.refused!.slice(3).every((body) => logprobsRefusal(400, body) === 'top_logprobs')).toBe(
    true,
  );
  expect(glm.calls).toHaveLength(3);
  expect(glm.response.gateway.confidence_method).toBe('logprobs');
});

describe.each(cases)('%s', (label, c) => {
  test('usage, billed cost and upstream names read from the real calls match the answer', () => {
    const parsed = fromChat({ answers: c.response.answers, calls: c.calls, requests: [] }, request);
    const { input_tokens, output_tokens, total_tokens } = c.response.usage;
    expect(parsed.usage).toMatchObject({ input_tokens, output_tokens, total_tokens });
    expect(parsed.usage?.output_tokens_details?.reasoning_tokens ?? 0).toBe(
      c.response.usage.output_tokens_details?.reasoning_tokens ?? 0,
    );
    if (c.response.gateway.cost_basis === 'upstream_cost')
      expect(parsed.billed).toBe(c.response.gateway.cost_usd);
    else expect(parsed.billed).toBeNull();
    expect(parsed.servedBy).toBe(c.response.gateway.served_by);
    expect(parsed.resolvedModel).toBe(c.response.gateway.upstream_model_resolved);
  });

  test('every answer is a distribution', () => {
    for (const answer of c.response.answers) {
      const p = distribution(answer);
      expect(p.reduce((sum, x) => sum + x, 0)).toBeCloseTo(1, 9);
      expect(p.every((x) => x >= 0 && x <= 1)).toBe(true);
    }
  });

  if (c.response.gateway.confidence_method === 'logprobs')
    test('first-token logprobs give back each answer', () => {
      for (const call of c.calls) {
        const q = questionOf(call.choices[0].message.content)!;
        expect(logprobState(call, q)).toBe('ok');
        const p = labelDistribution(
          chatLabels(q),
          call.choices[0].logprobs!.content[0].top_logprobs,
        );
        distribution(answerFor(c, q)).forEach((x, i) => expect(p[i]).toBeCloseTo(x, 6));
      }
    });

  if (label.endsWith('-sampling'))
    test('sample frequencies give back each answer', () => {
      for (const q of questions) {
        const raws = c.calls.filter((call) => questionOf(call.choices[0].message.content) === q);
        expect(samplingDistribution(q, raws, 4)).toEqual(distribution(answerFor(c, q)));
      }
    });

  if (label.includes('-json-'))
    test('the one JSON completion gives back every answer', () => {
      const content = c.calls[0].choices[0].message.content!;
      const text = label.endsWith('-json-prompt') ? firstJsonObject(content) : content;
      const indexed = questions.map((question, index) => ({ index, question }));
      expect(compactAnswers(text, indexed)).toEqual(c.response.answers);
    });
});
