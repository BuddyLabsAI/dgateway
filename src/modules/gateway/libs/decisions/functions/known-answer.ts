// The known-answer check: one short support ticket and one choice question whose answer is not in doubt. A provider
// test sends it, and so does the console's model test, so a test says more than "it answered": it says whether the
// model got an easy question right. The console keeps the same definition in its own copy (src/domain/known-answer.ts),
// and a test checks that the two agree.
import type { ChoiceValue, DecisionRequest, DecisionResponse, Question } from '../schemas/types';
import { object } from './validation';

export type KnownAnswer = {
  input: string;
  question: Question & { type: 'choice'; choices: { value: string; description: string }[] };
  expected: string;
};

export const KNOWN_ANSWER: KnownAnswer = {
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
};

// The check as a decision request for a model: a route alias, or provider::model.
export function knownAnswerRequest(model: string): DecisionRequest {
  const { question } = KNOWN_ANSWER;
  return {
    model,
    input: KNOWN_ANSWER.input,
    questions: [{ ...question, choices: question.choices.map((choice) => ({ ...choice })) }],
  };
}

// What a decision answered to the check: the chosen value and its probability, and whether it is the expected
// answer. A failed decision, a refusal or a missing answer gives no answer and no match.
export type KnownAnswerVerdict = {
  answer: ChoiceValue | null;
  probability: number | null;
  matched: boolean;
};

export function knownAnswerVerdict(response: DecisionResponse | null): KnownAnswerVerdict {
  const answer = response?.answers.find((a) => a.name === KNOWN_ANSWER.question.name);
  if (answer?.choice === undefined) return { answer: null, probability: null, matched: false };
  const chosen = answer.probabilities?.find((entry) => entry.value === answer.choice);
  return {
    answer: answer.choice,
    probability: chosen?.probability ?? null,
    matched: answer.choice === KNOWN_ANSWER.expected,
  };
}

// The option id the check expects, when a map-wire question (choice criteria keyed by option id) is the check's
// question asked about the check's input; null for any other state or question. The mock answers the check with it.
export function knownAnswerOption(state: unknown, question: unknown): string | null {
  const { question: known } = KNOWN_ANSWER;
  if (state !== KNOWN_ANSWER.input || !object(question) || !object(question.criteria)) return null;
  const criteria = Object.entries(question.criteria);
  const same =
    question.type === 'choice' &&
    question.instructions === known.instructions &&
    criteria.length === known.choices.length &&
    criteria.every(([, text], i) => text === known.choices[i].description);
  const expected = known.choices.find((choice) => choice.value === KNOWN_ANSWER.expected);
  return same ? (criteria.find(([, text]) => text === expected?.description)?.[0] ?? null) : null;
}
