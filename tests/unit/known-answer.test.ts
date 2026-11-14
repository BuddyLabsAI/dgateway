import { describe, expect, test } from 'bun:test';
import {
  KNOWN_ANSWER,
  knownAnswerOption,
  knownAnswerRequest,
  knownAnswerVerdict,
} from '../../src/modules/gateway/libs/decisions/functions/known-answer';
import { validateRequest } from '../../src/modules/gateway/libs/decisions/functions/validation';
import {
  fromUpstream,
  toMapWire,
} from '../../src/modules/gateway/libs/decisions/functions/translation';
import { mockUpstream } from '../../src/modules/gateway/libs/decisions/providers/mock';
import type {
  Answer,
  DecisionResponse,
} from '../../src/modules/gateway/libs/decisions/schemas/types';
import { KNOWN_ANSWER as CONSOLE_KNOWN_ANSWER } from '../../src/modules/gateway/apps/console-web/src/domain/known-answer';

const answered = (answers: Answer[]) => ({ answers }) as unknown as DecisionResponse;

const choice = (value: string, probability: number): Answer => ({
  type: 'choice',
  name: 'department',
  choice: value,
  probabilities: KNOWN_ANSWER.question.choices.map((c) => ({
    value: c.value,
    probability: c.value === value ? probability : (1 - probability) / 2,
  })),
});

describe('the known-answer check', () => {
  test('is one ticket and one choice question whose expected answer is billing', () => {
    expect(KNOWN_ANSWER).toEqual({
      input: 'I was charged twice for my March invoice. Please refund the second charge.',
      question: {
        name: 'department',
        type: 'choice',
        instructions: 'Which team should handle this ticket?',
        choices: [
          { value: 'billing', description: 'Charges, invoices and refunds.' },
          { value: 'technical', description: 'Bugs, errors and outages.' },
          { value: 'other', description: 'Anything else.' },
        ],
      },
      expected: 'billing',
    });
  });

  test('is the same definition the console sends', () => {
    expect(CONSOLE_KNOWN_ANSWER).toEqual(KNOWN_ANSWER);
  });

  test('builds a valid request for a model, as a copy', () => {
    const request = knownAnswerRequest('openrouter::baseten/elephant-1');
    expect(validateRequest(request)).toBe(request);
    expect(request).toEqual({
      model: 'openrouter::baseten/elephant-1',
      input: KNOWN_ANSWER.input,
      questions: [KNOWN_ANSWER.question],
    });
    request.questions[0].choices![0].description = 'changed';
    expect(KNOWN_ANSWER.question.choices[0].description).toBe('Charges, invoices and refunds.');
  });
});

describe('the verdict on an answer', () => {
  test('matches when the model chose billing, with its probability', () => {
    expect(knownAnswerVerdict(answered([choice('billing', 0.97)]))).toEqual({
      answer: 'billing',
      probability: 0.97,
      matched: true,
    });
  });

  test('does not match another answer, and keeps what was answered', () => {
    expect(knownAnswerVerdict(answered([choice('technical', 0.62)]))).toEqual({
      answer: 'technical',
      probability: 0.62,
      matched: false,
    });
  });

  test('has no answer and no match when the decision failed', () => {
    expect(knownAnswerVerdict(null)).toEqual({ answer: null, probability: null, matched: false });
  });

  test('has no answer and no match for a refusal', () => {
    const refused: Answer = { type: 'choice', name: 'department', refusal: 'I cannot say.' };
    expect(knownAnswerVerdict(answered([refused]))).toEqual({
      answer: null,
      probability: null,
      matched: false,
    });
  });
});

describe('the mock and the known-answer check', () => {
  const wire = toMapWire(knownAnswerRequest('mock::mock-1'));

  test('the check is recognised on the map wire, and its expected option is named', () => {
    expect(knownAnswerOption(wire.state, wire.questions.q0)).toBe('o0');
    expect(knownAnswerOption('another ticket', wire.questions.q0)).toBeNull();
    const asked = { ...wire.questions.q0, instructions: 'Which team?' };
    expect(knownAnswerOption(wire.state, asked)).toBeNull();
    const reworded = { ...wire.questions.q0, criteria: { o0: 'Money.', o1: 'Bugs.', o2: 'Else.' } };
    expect(knownAnswerOption(wire.state, reworded)).toBeNull();
    expect(knownAnswerOption(wire.state, { type: 'noul', instructions: 'x' })).toBeNull();
  });

  test('the mock answers the check with billing, as a model that read the ticket would', () => {
    const request = knownAnswerRequest('mock::mock-1');
    const parsed = fromUpstream(mockUpstream(toMapWire(request), 'mock-1'), request, 'map');
    expect(parsed.answers[0]).toMatchObject({ type: 'choice', choice: 'billing' });
    expect(knownAnswerVerdict(answered(parsed.answers))).toEqual({
      answer: 'billing',
      probability: 0.96,
      matched: true,
    });
  });

  test('any other ticket is still answered from the hash', () => {
    const other = { ...toMapWire(knownAnswerRequest('mock::mock-1')), state: 'A different ticket' };
    const body = mockUpstream(other, 'mock-1') as unknown as {
      answers: { q0: { probabilities: object } };
    };
    expect(Object.values(body.answers.q0.probabilities)).not.toContain(0.96);
  });
});
