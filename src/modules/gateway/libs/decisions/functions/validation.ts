import { GatewayError, type DecisionRequest, type Question } from '../schemas/types';

function invalid(message: string): never {
  throw new GatewayError(400, 'invalid_request_error', message);
}

export const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const list = (v: unknown): v is unknown[] => Array.isArray(v);

const QUESTION_TYPES = ['choice', 'predicate', 'score'];

function fields(v: Record<string, unknown>, allowed: string[], where: string) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) invalid(`Unknown ${where} field: ${k}`);
}

export function validateRequest(v: unknown): DecisionRequest {
  if (!object(v)) return invalid('Request must be an object');
  fields(v, ['model', 'input', 'questions'], 'request');
  if (v.model !== undefined && (typeof v.model !== 'string' || !v.model.trim()))
    invalid('model must be a non-empty string');
  if (typeof v.input !== 'string' || !v.input.length) invalid('input must be a non-empty string');
  if (!list(v.questions) || v.questions.length < 1 || v.questions.length > 400)
    invalid('questions must contain 1 to 400 items');
  const names = new Set<string>();
  for (const q of v.questions) {
    if (!object(q)) invalid('question must be an object');
    fields(q, ['name', 'type', 'instructions', 'choices', 'levels'], 'question');
    if (typeof q.name !== 'string' || !q.name.length || names.has(q.name))
      invalid('question names must be unique non-empty strings');
    names.add(q.name);
    if (typeof q.instructions !== 'string' || !q.instructions.length)
      invalid('instructions must be a non-empty string');
    if (typeof q.type !== 'string' || !QUESTION_TYPES.includes(q.type))
      invalid('unknown question type');
    if (q.type === 'predicate' && ('choices' in q || 'levels' in q))
      invalid('predicate cannot have choices or levels');
    if (q.type === 'choice') validateChoice(q);
    if (q.type === 'score') validateScore(q);
  }
  return v as DecisionRequest;
}

function validateChoice(x: Record<string, unknown>) {
  if ('levels' in x || !list(x.choices) || x.choices.length < 2 || x.choices.length > 64)
    invalid('choice requires 2 to 64 choices and no levels');
  const values = new Set<string>();
  for (const c of x.choices) {
    if (!object(c)) invalid('choice must be an object');
    fields(c, ['value', 'description'], 'choice');
    if (
      !['string', 'boolean', 'number'].includes(typeof c.value) ||
      (typeof c.value === 'number' && !Number.isFinite(c.value)) ||
      typeof c.description !== 'string'
    )
      invalid('invalid choice');
    const key = String(c.value);
    if (values.has(key)) invalid('choice values must have unique string representations');
    values.add(key);
  }
}

function validateScore(x: Record<string, unknown>) {
  if ('choices' in x || !list(x.levels) || x.levels.length < 2 || x.levels.length > 10)
    invalid('score requires 2 to 10 levels and no choices');
  const labels = new Set<string>();
  for (const l of x.levels) {
    if (!object(l)) invalid('level must be an object');
    fields(l, ['description', 'label'], 'level');
    if (typeof l.description !== 'string' || (l.label !== undefined && typeof l.label !== 'string'))
      invalid('invalid level');
    if (l.label !== undefined) {
      if (labels.has(l.label)) invalid('score level labels must be unique');
      labels.add(l.label);
    }
  }
}

export function maxOptions(q: Question): number {
  return q.type === 'choice' ? q.choices!.length : q.type === 'score' ? q.levels!.length : 0;
}
