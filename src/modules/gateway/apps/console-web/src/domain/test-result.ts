// A test's result in plain words, from either kind of test: a Models test (the known-answer check sent through the
// playground) or a provider test. The verdict comes first, then one line on who answered, with the model, the time
// and the cost; the answer bars, attempts and raw trace are details. Pure.

import type { Attempt, DecisionResponse, DecisionTrace, GatewayInfo, PlaygroundRun, ProviderTestResult } from "../api/types";
import { formatUsd, type CostFields } from "./cost";
import { KNOWN_ANSWER, answeredVerdict, checkAnswer, failedVerdict, type CheckAnswer, type TestVerdict } from "./known-answer";
import { answeredBy, attemptReason, joinWords, outcomeSentence } from "./outcome";

type TitleOf = (name: string) => string;

export interface TestOutcome {
  verdict: TestVerdict;
  /** "Answered by Baseten via OpenRouter · baseten/elephant-1-20261021 · 0.83 s · $0.0000044 billed by provider"; null on failure. */
  meta: string | null;
  /** True when the answer could not be priced, so a price can be set. */
  unpriced: boolean;
  response: DecisionResponse | null;
  attempts: readonly Attempt[];
  trace: DecisionTrace | null;
}

/** Milliseconds as seconds with two decimals: "0.83 s". */
export function formatSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return `${(Math.max(0, ms) / 1000).toFixed(2)} s`;
}

/**
 * What the answer cost, for the meta line: "$0.0000044 billed by provider", "$0.0000095 at list price" or
 * "unpriced", with ", output cost not included" when the gateway says the cost covers input only.
 */
export function costPhrase(fields: CostFields): string | null {
  const phrase = basisPhrase(fields);
  if (phrase !== null && fields.cost_includes_output === false && fields.cost_usd != null) return `${phrase}, output cost not included`;
  return phrase;
}

function basisPhrase(fields: CostFields): string | null {
  const amount = formatUsd(fields.cost_usd ?? null);
  switch (fields.cost_basis ?? null) {
    case "upstream_cost":
      return `${amount} billed by provider`;
    case "upstream_tokens":
      return `${amount} at list price`;
    case "estimated_tokens":
      return `${amount}, estimated`;
    case "unpriced":
      return "unpriced";
    default:
      return null;
  }
}

/** The answering side in one line: who answered (after which failures), the model it resolved, the time and the cost. */
export function answeredMeta(gateway: GatewayInfo, titleOf: TitleOf = (name) => name): string {
  const failures = gateway.attempts.filter((attempt) => !attempt.ok);
  const reasons = failures.map((attempt) => attemptReason(attempt.error, titleOf(attempt.provider)).clause);
  const after = reasons.length === 0 ? "" : ` after ${joinWords(reasons)}`;
  const who = `Answered by ${answeredBy(titleOf(gateway.provider), gateway.served_by)}${after}`;
  const model = gateway.upstream_model_resolved || gateway.upstream_model;
  return [who, model, formatSeconds(gateway.latency_ms), costPhrase(gateway)].filter((part) => part).join(" · ");
}

/**
 * Why a test failed, plainly: the gateway's own message for one failed attempt ("OPENROUTER_API_KEY is not set on
 * the gateway host"), or the outcome sentence's reasons when several attempts failed.
 */
export function failureReason(error: string | null | undefined, attempts: readonly Attempt[], titleOf: TitleOf = (name) => name): string {
  const failed = attempts.filter((attempt) => !attempt.ok);
  if (failed.length <= 1) return error?.trim() || failed[0]?.error?.trim() || "no attempt was made";
  const sentence = outcomeSentence({ status: "error", attempts, provider: "", error: error ?? null }, titleOf);
  return sentence.replace(/^Failed: /, "");
}

function outcome(verdict: TestVerdict, response: DecisionResponse | null, trace: DecisionTrace | null, titleOf: TitleOf): TestOutcome {
  return {
    verdict,
    meta: response ? answeredMeta(response.gateway, titleOf) : null,
    unpriced: response?.gateway.cost_basis === "unpriced",
    response,
    attempts: response?.gateway.attempts ?? trace?.attempts ?? [],
    trace,
  };
}

/** A Models test: the known-answer check through the playground. */
export function runOutcome(run: PlaygroundRun, titleOf: TitleOf = (name) => name): TestOutcome {
  const verdict = run.response
    ? answeredVerdict(checkAnswer(run.response))
    : failedVerdict(failureReason(run.error?.message, run.trace.attempts, titleOf));
  return outcome(verdict, run.response, run.trace, titleOf);
}

/** What a provider test answered: the gateway's own answer and probability when it reports them, else read from the decision. */
function testAnswer(result: ProviderTestResult): CheckAnswer {
  if (result.answer !== undefined && result.answer !== null) {
    return { kind: "answered", value: result.answer, probability: result.probability ?? null };
  }
  return checkAnswer(result.response);
}

/** A provider test, as the gateway reports it. */
export function providerTestOutcome(result: ProviderTestResult, titleOf: TitleOf = (name) => name): TestOutcome {
  const response = result.response ?? null;
  const verdict =
    result.ok && response
      ? answeredVerdict(testAnswer(result), result.expected ?? KNOWN_ANSWER.expected)
      : failedVerdict(failureReason(result.error, result.trace?.attempts ?? [], titleOf));
  return outcome(verdict, response, result.trace ?? null, titleOf);
}
