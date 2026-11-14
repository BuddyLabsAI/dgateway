import type { Answer, DecisionRequest, Question } from '../schemas/types';
import { CallFailure, type CallResult } from '../schemas/execution';
import type { Provider } from '../../management/schemas/types';
import {
  chatBody,
  chatAnswer,
  chatChoices,
  chatMessage,
  logprobState,
  samplingDistribution,
  distributionAnswer,
  jsonChatBody,
  compactAnswers,
  firstJsonObject,
  logprobsRefusal,
  mandatoryReasoning,
  optionCount,
  reasoningFields,
  reasoningTune,
  retriesTopLogprobs,
  sentTopLogprobs,
  RETRY_TOP_LOGPROBS,
  type ChatTune,
  type IndexedQuestion,
  type JsonTransport,
  type ReasoningStep,
} from '../functions/chat';

// What logprobsCall returns when the question advances to the next method.
const ADVANCE = Symbol('advance');

type Ask = (build: (tune: ChatTune) => Record<string, unknown>) => Promise<unknown>;

// Bound HTTP calls independently of questions: a sampling shortfall can create several calls per question.
function bounded(send: (body: unknown) => Promise<unknown>) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (body: unknown): Promise<unknown> => {
    if (active >= 8) await new Promise<void>((resolve) => queue.push(resolve));
    else active++;
    try {
      return await send(body);
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

export async function callChat(
  p: Provider,
  model: string,
  request: DecisionRequest,
  send: (body: unknown) => Promise<unknown>,
  supported: readonly string[] | null = null,
): Promise<CallResult> {
  // calls are the completions that answered; refused holds the HTTP error bodies of calls the attempt moved past
  // (a 4xx naming logprobs or response_format, a top_logprobs 400, or mandatory reasoning). A refused call is not billed and reports no usage, so it is kept for
  // the trace but left out of the usage and cost sums.
  const calls: unknown[] = [],
    refused: unknown[] = [],
    requests: Record<string, unknown>[] = [];
  const http = bounded(async (body) => {
    requests.push(body as Record<string, unknown>);
    try {
      const raw = await send(body);
      calls.push(raw);
      return raw;
    } catch (e) {
      if (e instanceof CallFailure) refused.push(e.raw ?? {});
      throw e;
    }
  });
  const answers = new Array<Answer>(request.questions.length);
  const deferred: IndexedQuestion[] = [];
  let noLogprobs = false,
    next = 0,
    // 'low' once an upstream refused reasoning off as mandatory; then 5 once a top_logprobs retry answered.
    reasoning: ReasoningStep = 'off',
    topLogprobs: number | undefined;
  const methods = p.synthetic_methods ?? ['logprobs', 'sampling', 'json'];
  const turnsReasoningOff = Object.keys(reasoningFields(p, 'off', supported)).length > 0;

  // Every chat call goes through ask: it carries the attempt's reasoning step, and when the automatic reasoning-off
  // field is refused as mandatory, the call is retried once at low effort with a larger budget.
  const ask: Ask = async (build) => {
    const step = reasoning;
    try {
      return await http(build(reasoningTune(p, step, supported)));
    } catch (e) {
      const failure = httpFailure(e);
      if (
        step !== 'off' ||
        !turnsReasoningOff ||
        !failure ||
        !mandatoryReasoning(failure.status, failure.raw)
      )
        throw e;
      reasoning = 'low';
      return await http(build(reasoningTune(p, 'low', supported)));
    }
  };

  const refusalOf = (e: unknown) => {
    const failure = httpFailure(e);
    return failure ? logprobsRefusal(failure.status, failure.raw) : 'other';
  };

  // The logprobs call for a question, or ADVANCE when the question advances to the next method. A top_logprobs refusal
  // is retried once with 5 when every option fits; a second refusal stops logprobs for the attempt.
  const logprobsCall = async (q: Question): Promise<unknown> => {
    const learned = topLogprobs;
    if (learned !== undefined && optionCount(q) > learned) return ADVANCE;

    const build = (top?: number) => (tune: ChatTune) =>
      chatBody(request.input, q, model, p.extra_body, undefined, { ...tune, topLogprobs: top });

    try {
      return await ask(build(learned));
    } catch (e) {
      const refusal = refusalOf(e);
      if (refusal === 'other') throw e;
      const sent = sentTopLogprobs(p.extra_body, learned);
      if (refusal === 'unsupported' || sent <= RETRY_TOP_LOGPROBS) {
        noLogprobs = true;
        return ADVANCE;
      }
      if (!retriesTopLogprobs(sent, q)) return ADVANCE;
    }
    try {
      const raw = await ask(build(RETRY_TOP_LOGPROBS));
      topLogprobs = RETRY_TOP_LOGPROBS;
      return raw;
    } catch (e) {
      if (refusalOf(e) === 'other') throw e;
      noLogprobs = true;
      return ADVANCE;
    }
  };

  const sample = async (q: Question): Promise<Answer | null> => {
    const n = p.sampling_n ?? 8;
    const raw = await ask((tune) => chatBody(request.input, q, model, p.extra_body, n, tune));
    const missing = Math.max(0, n - chatChoices(raw).length);
    const fill = await Promise.all(
      Array.from({ length: missing }, () =>
        ask((tune) => ({ ...chatBody(request.input, q, model, p.extra_body, 1, tune), n: 1 })),
      ),
    );
    const distribution = samplingDistribution(q, [raw, ...fill], n);
    return distribution ? distributionAnswer(q, distribution, 'sampling') : null;
  };

  const answerQuestion = async (q: Question, index: number) => {
    for (const method of methods) {
      if (method === 'json') {
        deferred.push({ index, question: q });
        return;
      }
      if (method === 'sampling') {
        const answer = await sample(q);
        if (answer) {
          answers[index] = answer;
          return;
        }
      } else if (!noLogprobs && (q.choices?.length ?? 0) <= 20) {
        // A 4xx naming logprobs (OpenAI reasoning models) or a refused top_logprobs retry advances.
        const raw = await logprobsCall(q);
        if (raw === ADVANCE) continue;
        const state = logprobState(raw, q);
        if (state === 'missing') noLogprobs = true;
        if (state === 'ok') {
          answers[index] = chatAnswer(q, raw);
          return;
        }
      }
    }
    throw new Error(
      'chat question exhausted synthetic methods (missing logprobs or insufficient valid samples)',
    );
  };

  const run = async () => {
    while (next < request.questions.length) {
      const index = next++;
      await answerQuestion(request.questions[index], index);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(8, request.questions.length) }, run));
    if (deferred.length) {
      deferred.sort((a, b) => a.index - b.index);
      const json = await jsonBatch(p, model, request.input, deferred, ask);
      json.forEach((answer, i) => {
        answers[deferred[i].index] = answer;
      });
    }
    return {
      body: { answers, calls, requests, ...(refused.length ? { refused } : {}) },
      request: requests,
    };
  } catch (e) {
    if (e instanceof CallFailure) throw e;
    throw new CallFailure(
      'invalid',
      e instanceof Error ? e.message : 'invalid chat response',
      undefined,
      [...calls, ...refused],
    );
  }
}

function httpFailure(e: unknown): { status?: number; raw: unknown } | null {
  return e instanceof CallFailure && e.kind === 'http' ? { status: e.status, raw: e.raw } : null;
}

// An HTTP 4xx whose body names a request parameter the model does not support.
function unsupportedParameter(e: unknown, parameter: RegExp): boolean {
  return (
    e instanceof CallFailure &&
    e.kind === 'http' &&
    (e.status ?? 0) >= 400 &&
    (e.status ?? 0) < 500 &&
    parameter.test(JSON.stringify(e.raw))
  );
}

async function jsonBatch(
  p: Provider,
  model: string,
  input: string,
  questions: IndexedQuestion[],
  ask: Ask,
): Promise<Answer[]> {
  const transports: JsonTransport[] =
    p.json_transport === undefined || p.json_transport === 'auto'
      ? ['json_schema', 'prompt']
      : [p.json_transport];
  for (const transport of transports) {
    let raw: unknown;
    try {
      raw = await ask((tune) =>
        jsonChatBody(input, questions, model, transport, p.extra_body, tune),
      );
    } catch (e) {
      if (
        transports.length > 1 &&
        transport === 'json_schema' &&
        unsupportedParameter(e, /response_format|json_schema/i)
      )
        continue;
      throw e;
    }
    const message = chatMessage(raw);
    let text: string;
    try {
      if (typeof message.content !== 'string') throw new Error('chat JSON content missing');
      text = transport === 'prompt' ? firstJsonObject(message.content) : message.content;
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('chat JSON content is not an object');
    } catch (e) {
      if (transports.length > 1 && transport === 'json_schema') continue;
      throw e;
    }
    return compactAnswers(text, questions);
  }
  throw new Error('chat JSON transports exhausted');
}
