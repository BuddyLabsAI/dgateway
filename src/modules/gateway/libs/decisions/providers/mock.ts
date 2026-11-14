// The mock upstream: a SystemOne server that answers the map-wire body it is sent, deterministically from a hash of
// the state, in the shapes a real one uses (as OpenRouter answered on 2026-11-08): a noul's probability under noul,
// a choice's option and probabilities by option id, a score's probabilities and legend by level index with its
// expected score, a confidence for each choice and score, usage with input and output tokens and a cost of 0, and
// the model and provider at the top level. So the mock exercises the same parser as a real provider. Like OpenRouter,
// it refuses a body it cannot read with HTTP 400, a score whose criteria are not an ordered list included. The one
// exception to the hash is the known-answer check that provider tests send: the mock answers it with the expected
// option, as a model that read the ticket would, so a test of the mock passes.
import { createHash } from 'node:crypto';
import { CallFailure } from '../schemas/execution';
import { knownAnswerOption } from '../functions/known-answer';
import { list, object } from '../functions/validation';

// Who the mock says it is, in the upstream's provider field.
export const MOCK_PROVIDER = 'Mock';

// Refuses a body as OpenRouter does: HTTP 400 with the problem in error.message.
function refuse(problem: string, path: string[]): never {
  const message = JSON.stringify([{ code: 'invalid_type', path, message: problem }]);
  throw new CallFailure('http', 'upstream HTTP 400', 400, { error: { message, code: 400 } });
}

// The probabilities of n options, from the hash bytes from position i on.
function weights(hash: Buffer, i: number, n: number): number[] {
  const raw = Array.from({ length: n }, (_, j) => 1 + hash[(i + j) % hash.length]);
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / total);
}

// The mock's confidence: how far the most likely option leads the next one.
function margin(p: number[]): number {
  const [first = 0, second = 0] = [...p].sort((a, b) => b - a);
  return first - second;
}

const strings = (v: unknown): v is string[] => list(v) && v.every((x) => typeof x === 'string');

const keyedStrings = (v: unknown): v is Record<string, string> =>
  object(v) && Object.values(v).every((x) => typeof x === 'string');

// The probability the mock gives the expected option of the known-answer check. The other options share the rest.
const KNOWN_ANSWER_PROBABILITY = 0.96;

// The option probabilities of a choice: from the hash, or, for the known-answer check (expected is its option id),
// the expected option at KNOWN_ANSWER_PROBABILITY and the rest split evenly.
function choiceWeights(ids: string[], hash: Buffer, i: number, expected: string | null): number[] {
  if (expected === null || !ids.includes(expected)) return weights(hash, i, ids.length);
  const rest = (1 - KNOWN_ANSWER_PROBABILITY) / (ids.length - 1);
  return ids.map((id) => (id === expected ? KNOWN_ANSWER_PROBABILITY : rest));
}

function choice(
  criteria: unknown,
  hash: Buffer,
  i: number,
  path: string[],
  expected: string | null,
) {
  if (!keyedStrings(criteria) || Object.keys(criteria).length < 2)
    return refuse('Invalid input: expected a map of option descriptions', [...path, 'criteria']);
  const ids = Object.keys(criteria);
  const p = choiceWeights(ids, hash, i, expected);
  return {
    type: 'choice',
    choice: ids[p.indexOf(Math.max(...p))],
    probabilities: Object.fromEntries(ids.map((id, j) => [id, p[j]])),
    confidence: margin(p),
  };
}

function score(criteria: unknown, hash: Buffer, i: number, path: string[]) {
  if (!strings(criteria) || criteria.length < 2)
    return refuse(
      `Invalid input: expected array, received ${list(criteria) ? 'array' : typeof criteria}`,
      [...path, 'criteria'],
    );
  const p = weights(hash, i, criteria.length);
  return {
    type: 'score',
    score: p.reduce((a, v, j) => a + j * v, 0),
    probabilities: Object.fromEntries(p.map((v, j) => [String(j), v])),
    legend: Object.fromEntries(criteria.map((text, j) => [String(j), text])),
    confidence: margin(p),
  };
}

function answer(state: string, question: unknown, hash: Buffer, i: number, path: string[]) {
  if (!object(question) || typeof question.instructions !== 'string')
    return refuse('Invalid input: expected a question with instructions', path);
  if (question.type === 'noul') return { type: 'noul', noul: hash[i % hash.length] / 255 };
  if (question.type === 'choice')
    return choice(question.criteria, hash, i, path, knownAnswerOption(state, question));
  if (question.type === 'score') return score(question.criteria, hash, i, path);
  return refuse('Invalid input: expected choice, noul or score', [...path, 'type']);
}

// The texts of one question: its instructions and its criteria, listed or keyed.
function questionTexts(q: unknown): string[] {
  if (!object(q)) return [];
  const criteria = list(q.criteria)
    ? q.criteria
    : object(q.criteria)
      ? Object.values(q.criteria)
      : [];
  return [String(q.instructions), ...criteria.map(String)];
}

// The input tokens the mock reports: the text it was sent, in characters (code points) at four per token, the rule
// the gateway estimates by.
function inputTokens(state: string, questions: unknown[]): number {
  const texts = [state, ...questions.flatMap(questionTexts)];
  return Math.ceil(texts.reduce((sum, text) => sum + [...text].length, 0) / 4);
}

export function mockUpstream(body: unknown, model: string) {
  if (!object(body) || typeof body.state !== 'string' || !object(body.questions))
    return refuse('Invalid input: expected state and a map of questions', []);
  const state = body.state;
  const hash = createHash('sha256').update(state).digest();
  const entries = Object.entries(body.questions);
  const answers = Object.fromEntries(
    entries.map(([id, q], i) => [id, answer(state, q, hash, i, ['questions', id])]),
  );
  return {
    id: `gen-mock-${hash.subarray(0, 8).toString('hex')}`,
    model,
    provider: MOCK_PROVIDER,
    answers,
    usage: {
      input_tokens: inputTokens(state, Object.values(body.questions)),
      output_tokens: entries.length,
      cost: 0,
    },
  };
}
