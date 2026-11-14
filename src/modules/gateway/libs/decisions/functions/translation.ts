// Translation between this contract and an upstream's wire. On the openai wire the request goes as it is; on the
// SystemOne map wire (OpenRouter, hosted SystemOne vendors, local SystemOne servers and the mock) it becomes state plus
// a question map. Either way the answer is read back into OpenAI's Decisions shape, tolerantly: unknown fields are
// ignored, while the probabilities, ids and token counts must be right.
import type {
  Answer,
  ChoiceValue,
  DecisionRequest,
  DecisionResponse,
  MapWireQuestion,
  MapWireRequest,
  Question,
  TokenDetails,
  Usage,
} from '../schemas/types';
import type { Parsed } from '../schemas/execution';
import { list, object } from './validation';

type Wire = 'map' | 'openai';

export const expectedScore = (p: number[]) => p.reduce((a, v, i) => a + i * v, 0);

export function normalizedEntropy(p: number[]): number {
  const total = p.reduce((a, v) => a + v, 0);
  if (p.length < 2) return 1;
  if (total <= 0) return 0;
  const h = -p.reduce((a, v) => {
    const n = v / total;
    return a + (n > 0 ? n * Math.log(n) : 0);
  }, 0);
  return Math.max(0, Math.min(1, 1 - h / Math.log(p.length)));
}

// The map-wire id of the question at position i, and of a choice's option at position j.
const questionId = (i: number) => `q${i}`;

const optionId = (j: number) => `o${j}`;

// One question on the map wire. A choice's criteria are its option descriptions by option id; a score's are its level
// descriptions as an ordered list (index i is level i), which is what SystemOne expects; a predicate is a noul and
// has none.
function wireQuestion(q: Question): MapWireQuestion {
  const base = {
    type: q.type === 'predicate' ? 'noul' : q.type,
    instructions: q.instructions,
  } as const;
  if (q.type === 'choice')
    return {
      ...base,
      criteria: Object.fromEntries(
        q.choices!.map((c, j): [string, string] => [optionId(j), c.description]),
      ),
    };
  if (q.type === 'score') return { ...base, criteria: q.levels!.map((l) => l.description) };
  return base;
}

export function toMapWire(request: DecisionRequest): MapWireRequest {
  return {
    state: request.input,
    questions: Object.fromEntries(
      request.questions.map((q, i): [string, MapWireQuestion] => [questionId(i), wireQuestion(q)]),
    ),
  };
}

const fail = (message: string): never => {
  throw new Error(message);
};

const prob = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

// The same value of the same type: true stays distinct from "true", and 1 from "1".
const same = (a: unknown, b: unknown) => typeof a === typeof b && a === b;

// A distribution in option order: every value a probability, together summing to 1 within 0.02.
function checked(values: unknown[]): number[] {
  if (!values.every(prob) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.02)
    return fail('invalid probabilities');
  return values;
}

// Probabilities keyed by option: the map wire's option ids or level keys, or an older openai-wire server's labels.
function keyed(raw: unknown, keys: string[]): number[] {
  if (!object(raw)) return fail('missing probabilities');
  return checked(keys.map((k) => raw[k]));
}

// OpenAI's probabilities: a list of { value, probability }, where a score level's value is its index. Each option
// reads the entry whose value is its own, type and all.
function listed(entries: unknown[], values: ChoiceValue[]): number[] {
  return checked(
    values.map((v) => {
      const entry = entries.find((e) => object(e) && same(e.value, v));
      return object(entry) ? entry.probability : undefined;
    }),
  );
}

// Whether a map has an entry under every one of the keys.
const hasAll = (raw: unknown, keys: string[]) => object(raw) && keys.every((k) => k in raw);

// The keys a score's probabilities come under on the map wire: the level indexes ("0", "1", ...), as SystemOne
// answers, or the l0, l1, ... ids this gateway once sent, when every one of those is there instead.
function scoreKeys(raw: unknown, levels: number): string[] {
  const indexes = Array.from({ length: levels }, (_, i) => String(i));
  const legacy = indexes.map((i) => `l${i}`);
  return !hasAll(raw, indexes) && hasAll(raw, legacy) ? legacy : indexes;
}

// The keys an older openai-wire server (this gateway's own earlier answers) uses: choice values as strings; level
// labels when every level has one, else level indexes.
function legacyKeys(q: Question): string[] {
  if (q.type === 'choice') return q.choices!.map((c) => String(c.value));
  return q.levels!.every((l) => l.label !== undefined)
    ? q.levels!.map((l) => l.label!)
    : q.levels!.map((_, i) => String(i));
}

// A choice's or a score's distribution, in option order.
function distributionOf(q: Question, raw: Record<string, unknown>, wire: Wire): number[] {
  if (wire === 'openai' && list(raw.probabilities)) {
    const values =
      q.type === 'choice' ? q.choices!.map((c) => c.value) : q.levels!.map((_, i) => i);
    return listed(raw.probabilities, values);
  }
  if (wire === 'openai') return keyed(raw.probabilities, legacyKeys(q));
  if (q.type === 'choice')
    return keyed(
      raw.probabilities,
      q.choices!.map((_, j) => optionId(j)),
    );
  return keyed(raw.probabilities, scoreKeys(raw.probabilities, q.levels!.length));
}

// The position of a choice's answer: on the map wire the option id the upstream chose; on the openai wire the value
// it returned as choice (as value, from an older server), type and all.
function chosenIndex(q: Question, raw: Record<string, unknown>, wire: Wire): number {
  const returned = raw.choice !== undefined ? raw.choice : raw.value;
  const index =
    wire === 'map'
      ? q.choices!.findIndex((_, j) => optionId(j) === raw.choice)
      : q.choices!.findIndex((c) => same(c.value, returned));
  if (index < 0) return fail(wire === 'map' ? 'invalid choice id' : 'invalid choice value');
  return index;
}

function refusal(q: Question, text: unknown): Answer {
  if (typeof text !== 'string' || !text) return fail('invalid refusal');
  return { type: q.type, name: q.name, refusal: text };
}

// A predicate's probability of true. SystemOne answers it under noul; OpenAI and older map-wire peers under
// probability.
function predicate(q: Question, raw: Record<string, unknown>, wire: Wire): Answer {
  const probability = wire === 'map' && raw.noul !== undefined ? raw.noul : raw.probability;
  if (!prob(probability)) return fail('invalid predicate probability');
  return { type: 'predicate', name: q.name, probability };
}

type Confidence = Pick<Answer, 'confidence' | 'confidence_method'>;

function choiceAnswer(q: Question, values: number[], index: number, c: Confidence): Answer {
  return {
    type: 'choice',
    name: q.name,
    choice: q.choices![index].value,
    probabilities: q.choices!.map((option, i) => ({ value: option.value, probability: values[i] })),
    ...c,
  };
}

// A score is the expected zero-based level index, worked out here from the distribution; an upstream's own score is
// not read.
function scoreAnswer(q: Question, values: number[], c: Confidence): Answer {
  return {
    type: 'score',
    name: q.name,
    score: expectedScore(values),
    probabilities: q.levels!.map((level, i) => ({
      value: i,
      ...(level.label === undefined ? {} : { label: level.label }),
      probability: values[i],
    })),
    ...c,
  };
}

// A choice or a score. The confidence is the upstream's when it sends one, else the normalized entropy of the
// distribution.
function ranked(q: Question, raw: Record<string, unknown>, wire: Wire): Answer {
  const values = distributionOf(q, raw, wire);
  const upstream = raw.confidence !== undefined && raw.confidence !== null;
  const confidence = upstream ? raw.confidence : normalizedEntropy(values);
  if (!prob(confidence)) return fail('invalid confidence');
  const c: Confidence = {
    confidence,
    confidence_method: upstream ? 'upstream' : 'normalized-entropy',
  };
  if (q.type === 'score') return scoreAnswer(q, values, c);
  return choiceAnswer(q, values, chosenIndex(q, raw, wire), c);
}

// The question an openai-wire answer names: name, as OpenAI answers, or question, as older servers do.
const answerName = (raw: Record<string, unknown>): unknown =>
  raw.name !== undefined ? raw.name : raw.question;

function result(q: Question, raw: unknown, wire: Wire): Answer {
  if (!object(raw)) return fail(`missing answer ${q.name}`);
  if (raw.refusal !== undefined) return refusal(q, raw.refusal);
  if (wire === 'openai' && (answerName(raw) !== q.name || raw.type !== q.type))
    return fail('answer identity mismatch');
  if (q.type === 'predicate') return predicate(q, raw, wire);
  return ranked(q, raw, wire);
}

// Token details as OpenAI reports them (cached_tokens, reasoning_tokens, ...), kept when every value is a count.
function details(raw: unknown): TokenDetails | undefined {
  return object(raw) && Object.values(raw).every(count) ? (raw as TokenDetails) : undefined;
}

// Token counts in OpenAI's shape. OpenAI reports input_tokens, output_tokens, total_tokens and their details;
// SystemOne reports input_tokens and output_tokens; older peers report prompt_tokens and total_tokens. Each count must
// be a whole number of at least 0.
function tokenUsage(raw: Record<string, unknown>): NonNullable<Usage> {
  if (raw.input_tokens === undefined) {
    const prompt = raw.prompt_tokens,
      all = raw.total_tokens;
    if (!count(prompt) || !count(all)) return fail('invalid usage');
    return { input_tokens: prompt, output_tokens: Math.max(0, all - prompt), total_tokens: all };
  }
  const input = raw.input_tokens,
    output = raw.output_tokens ?? 0;
  if (!count(input) || !count(output)) return fail('invalid usage');
  const total = raw.total_tokens ?? input + output;
  if (!count(total)) return fail('invalid usage');
  const inputDetails = details(raw.input_tokens_details),
    outputDetails = details(raw.output_tokens_details);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    ...(inputDetails ? { input_tokens_details: inputDetails } : {}),
    ...(outputDetails ? { output_tokens_details: outputDetails } : {}),
  };
}

// The upstream's usage in OpenAI's shape, and the cost it billed. A cost counts only when it is a number of at least
// 0, as SystemOne (OpenRouter) reports it; OpenAI reports none.
export function readUsage(raw: unknown): { usage: Usage; billed: number | null } {
  if (raw === undefined || raw === null) return { usage: null, billed: null };
  if (!object(raw)) return fail('invalid usage');
  const billed =
    typeof raw.cost === 'number' && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : null;
  return { usage: tokenUsage(raw), billed };
}

// A name the upstream gives itself or its model at the top level of its answer, or null when it gives none.
const named = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export function fromUpstream(raw: unknown, request: DecisionRequest, wire: Wire): Parsed {
  if (!object(raw) || !raw.answers) return fail('missing answers');
  const source = raw.answers;
  if (wire === 'map' && !object(source)) return fail('answers must be a map');
  if (wire === 'openai' && (!list(source) || source.length !== request.questions.length))
    return fail('answers must be an array matching questions');

  // The map wire keys answers by question id (q0, q1, ...); the openai wire uses array position.
  const itemAt = (i: number): unknown =>
    wire === 'map' ? (source as Record<string, unknown>)[questionId(i)] : (source as unknown[])[i];

  const answers = request.questions.map((q, i) => result(q, itemAt(i), wire));
  const methods = new Set(
    answers.flatMap((a) => (a.confidence_method ? [a.confidence_method] : [])),
  );
  const { usage, billed } = readUsage(raw.usage);
  return {
    answers,
    usage,
    confidenceMethod: gatewayConfidence(methods),
    billed,
    servedBy: named(raw.provider),
    resolvedModel: named(raw.model),
  };
}

// The response-level confidence method: the one method that every answer with a confidence uses, "mixed"
// when they differ, and "none" when no answer carries a confidence (predicate-only, or all refusals).
export function gatewayConfidence(
  methods: ReadonlySet<'upstream' | 'normalized-entropy' | 'logprobs' | 'sampling' | 'json'>,
): DecisionResponse['gateway']['confidence_method'] {
  if (methods.size === 0) return 'none';
  if (methods.size > 1) return 'mixed';
  return [...methods][0];
}
