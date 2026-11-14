// The known-answer check, as the gateway defines it (the API reference, Providers): one short ticket and one
// choice question whose answer is not in doubt. The Models test and the provider test both send it, so a result can
// say whether the model got an easy question right, not only whether it answered. This is the console's own copy of
// the gateway's definition; a test checks that the two agree. Pure.

import type { ChoiceValue, DecisionRequest, DecisionResponse } from "../api/types";

export interface KnownAnswer {
  input: string;
  question: {
    name: string;
    type: "choice";
    instructions: string;
    choices: { value: string; description: string }[];
  };
  expected: string;
}

export const KNOWN_ANSWER: KnownAnswer = {
  input: "I was charged twice for my March invoice. Please refund the second charge.",
  question: {
    name: "department",
    type: "choice",
    instructions: "Which team should handle this ticket?",
    choices: [
      { value: "billing", description: "Charges, invoices and refunds." },
      { value: "technical", description: "Bugs, errors and outages." },
      { value: "other", description: "Anything else." },
    ],
  },
  expected: "billing",
};

/** The check as a decision request, for a model name, a provider::model, or the default model when none is given. */
export function knownAnswerRequest(model?: string): DecisionRequest {
  const { question } = KNOWN_ANSWER;
  const request: DecisionRequest = {
    input: KNOWN_ANSWER.input,
    questions: [{ ...question, choices: question.choices.map((choice) => ({ ...choice })) }],
  };
  return model ? { model, ...request } : request;
}

/** What a decision said to the check: the chosen value and its probability, a refusal, or no answer at all. */
export type CheckAnswer =
  { kind: "answered"; value: ChoiceValue; probability: number | null } | { kind: "refused"; text: string } | { kind: "missing" };

export function checkAnswer(response: DecisionResponse | null | undefined): CheckAnswer {
  const answer = response?.answers.find((candidate) => candidate.name === KNOWN_ANSWER.question.name);
  if (!answer) return { kind: "missing" };
  if ("refusal" in answer) return { kind: "refused", text: answer.refusal };
  if (answer.type !== "choice") return { kind: "missing" };
  const chosen = answer.probabilities.find((entry) => entry.value === answer.choice);
  return { kind: "answered", value: answer.choice, probability: chosen?.probability ?? null };
}

/** Whether an answer is the expected one. */
export function isExpected(answer: CheckAnswer, expected: string = KNOWN_ANSWER.expected): boolean {
  return answer.kind === "answered" && answer.value === expected;
}

export type VerdictTone = "ok" | "warn" | "error";

/** A test's outcome in one line: its mark, and the sentence after it. */
export interface TestVerdict {
  tone: VerdictTone;
  mark: "✓" | "⚠" | "✗";
  text: string;
}

const MARKS: Record<VerdictTone, TestVerdict["mark"]> = { ok: "✓", warn: "⚠", error: "✗" };

/** The verdict as one string: "✓ Works: …". */
export function verdictLine(verdict: TestVerdict): string {
  return `${verdict.mark} ${verdict.text}`;
}

/** A value as the sentence quotes it: a string in quotes, any other value as it is. */
export function quoted(value: ChoiceValue): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

/** "(62% sure)", or nothing when the probability is unknown. */
function sure(probability: number | null): string {
  if (probability === null || !Number.isFinite(probability)) return "";
  return ` (${Math.round(Math.min(1, Math.max(0, probability)) * 100)}% sure)`;
}

/**
 * The verdict on a decision that answered: it works when the answer is the expected one, and otherwise it answered,
 * but not as expected, with what it said instead.
 */
export function answeredVerdict(answer: CheckAnswer, expectedValue: string = KNOWN_ANSWER.expected): TestVerdict {
  const expected = quoted(expectedValue);
  if (answer.kind === "answered" && isExpected(answer, expectedValue)) {
    return { tone: "ok", mark: MARKS.ok, text: `Works: it answered ${quoted(answer.value)}${sure(answer.probability)}, the expected answer.` };
  }
  const said =
    answer.kind === "answered"
      ? `${quoted(answer.value)}${sure(answer.probability)}`
      : answer.kind === "refused"
        ? `it refused (${answer.text.trim() || "no reason given"})`
        : "no answer to the question";
  return { tone: "warn", mark: MARKS.warn, text: `It answered, but not as expected: ${said}; expected ${expected}.` };
}

/** The verdict on a test that failed, with the plain reason. */
export function failedVerdict(reason: string): TestVerdict {
  return { tone: "error", mark: MARKS.error, text: `Failed: ${reason.trim() || "no reason given"}` };
}
