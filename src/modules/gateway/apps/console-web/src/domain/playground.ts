// The playground's request builder: form state in, a DecisionRequest out.
// Validation mirrors the contract so that a request the builder accepts is one the
// gateway accepts, and every issue points at the field that caused it.

import type { ChoiceValue, DecisionRequest, DecisionType, Question } from "../api/types";
import { knownAnswerRequest } from "./known-answer";

export type ValueType = "string" | "boolean" | "number";

export interface ChoiceRow {
  id: string;
  valueType: ValueType;
  /** Text as typed. For booleans it is "true" or "false"; for numbers, the digits. */
  text: string;
  description: string;
}

export interface LevelRow {
  id: string;
  label: string;
  description: string;
}

export interface QuestionDraft {
  id: string;
  name: string;
  type: DecisionType;
  instructions: string;
  choices: ChoiceRow[];
  levels: LevelRow[];
}

export interface BuilderState {
  model: string;
  input: string;
  questions: QuestionDraft[];
}

export interface BuildIssue {
  /** Dotted path to the field, for example "questions.1.choices.0.value". */
  path: string;
  message: string;
}

export type BuildResult = { ok: true; request: DecisionRequest } | { ok: false; issues: BuildIssue[] };

export const LIMITS = { questions: { min: 1, max: 400 }, choices: { min: 2, max: 64 }, levels: { min: 2, max: 10 } } as const;

let sequence = 0;

/** Stable React keys for draft rows. Unique within a session. */
export function draftId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function makeChoice(valueType: ValueType = "string", text = "", description = ""): ChoiceRow {
  return { id: draftId("choice"), valueType, text, description };
}

export function makeLevel(label = "", description = ""): LevelRow {
  return { id: draftId("level"), label, description };
}

export function makeQuestion(type: DecisionType, name = "", instructions = ""): QuestionDraft {
  return {
    id: draftId("question"),
    name,
    type,
    instructions,
    choices: type === "choice" ? [makeChoice(), makeChoice()] : [],
    levels: type === "score" ? [makeLevel(), makeLevel()] : [],
  };
}

export function emptyBuilder(): BuilderState {
  return { model: "", input: "", questions: [makeQuestion("choice")] };
}

/** Parses one choice value as its declared type. Returns the typed value or a message. */
export function parseChoiceValue(row: ChoiceRow): { ok: true; value: ChoiceValue } | { ok: false; message: string } {
  if (row.valueType === "boolean") {
    if (row.text === "true") return { ok: true, value: true };
    if (row.text === "false") return { ok: true, value: false };
    return { ok: false, message: "Choose true or false." };
  }
  if (row.valueType === "number") {
    const text = row.text.trim();
    if (text.length === 0) return { ok: false, message: "Enter a number." };
    const value = Number(text);
    if (!Number.isFinite(value)) return { ok: false, message: "Enter a finite number." };
    return { ok: true, value };
  }
  const text = row.text.trim();
  if (text.length === 0) return { ok: false, message: "Enter a value." };
  return { ok: true, value: text };
}

function issue(issues: BuildIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

/** Turns the builder state into a DecisionRequest, or lists every issue found. */
export function buildDecisionRequest(state: BuilderState): BuildResult {
  const issues: BuildIssue[] = [];
  const input = state.input.trim();
  if (input.length === 0) issue(issues, "input", "Enter the input text the decision is about.");

  const questionCount = state.questions.length;
  if (questionCount < LIMITS.questions.min) issue(issues, "questions", "Add at least one question.");
  if (questionCount > LIMITS.questions.max) {
    issue(issues, "questions", `Use at most ${LIMITS.questions.max} questions.`);
  }

  const names = new Map<string, number>();
  state.questions.forEach((draft, index) => {
    const name = draft.name.trim();
    if (name.length === 0) {
      issue(issues, `questions.${index}.name`, "Give the question a name.");
    } else if (names.has(name)) {
      issue(issues, `questions.${index}.name`, `The name "${name}" is already used by question ${(names.get(name) ?? 0) + 1}.`);
    } else {
      names.set(name, index);
    }
    if (draft.instructions.trim().length === 0) {
      issue(issues, `questions.${index}.instructions`, "Write the instructions the model answers from.");
    }
  });

  const questions: Question[] = state.questions.map((draft, index) => {
    const question: Question = { name: draft.name.trim(), type: draft.type, instructions: draft.instructions.trim() };

    if (draft.type === "choice") {
      if (draft.choices.length < LIMITS.choices.min || draft.choices.length > LIMITS.choices.max) {
        issue(issues, `questions.${index}.choices`, `Use between ${LIMITS.choices.min} and ${LIMITS.choices.max} choices.`);
      }
      const seen = new Map<string, number>();
      const choices = draft.choices.map((row, rowIndex) => {
        const parsed = parseChoiceValue(row);
        const description = row.description.trim();
        if (description.length === 0) {
          issue(issues, `questions.${index}.choices.${rowIndex}.description`, "Describe what this choice means.");
        }
        if (!parsed.ok) {
          issue(issues, `questions.${index}.choices.${rowIndex}.value`, parsed.message);
          return { value: "", description };
        }
        const key = String(parsed.value);
        if (seen.has(key)) {
          issue(
            issues,
            `questions.${index}.choices.${rowIndex}.value`,
            `The value ${key} is already used by choice ${(seen.get(key) ?? 0) + 1}. Values must be unique as text.`,
          );
        } else {
          seen.set(key, rowIndex);
        }
        return { value: parsed.value, description };
      });
      question.choices = choices;
    }

    if (draft.type === "score") {
      if (draft.levels.length < LIMITS.levels.min || draft.levels.length > LIMITS.levels.max) {
        issue(issues, `questions.${index}.levels`, `Use between ${LIMITS.levels.min} and ${LIMITS.levels.max} levels.`);
      }
      const labels = new Map<string, number>();
      const levels = draft.levels.map((row, rowIndex) => {
        const description = row.description.trim();
        const label = row.label.trim();
        if (description.length === 0) {
          issue(issues, `questions.${index}.levels.${rowIndex}.description`, "Describe what this level means.");
        }
        if (label.length > 0) {
          if (labels.has(label)) {
            issue(
              issues,
              `questions.${index}.levels.${rowIndex}.label`,
              `The label "${label}" is already used by level ${(labels.get(label) ?? 0) + 1}. Labels must be unique.`,
            );
          } else {
            labels.set(label, rowIndex);
          }
          return { description, label };
        }
        return { description };
      });
      question.levels = levels;
    }

    return question;
  });

  if (issues.length > 0) return { ok: false, issues };

  const model = state.model.trim();
  const request: DecisionRequest = model.length > 0 ? { model, input, questions } : { input, questions };
  return { ok: true, request };
}

/**
 * The small decision the console offers as an example (Copy curl, the first-run "Try the mock now"): the
 * known-answer check that the tests send (src/domain/known-answer.ts), one choice question about a short
 * ticket. It teaches the shape of a result (a value, its probabilities and a confidence) and costs a
 * fraction of a cent on a priced model.
 */
export function sampleDecision(model?: string): DecisionRequest {
  return knownAnswerRequest(model);
}

/** Quotes a string for POSIX shells, so it survives copy and paste unchanged. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** The equivalent curl command for POST /v1/decisions. */
export function equivalentCurl(request: DecisionRequest, origin: string, requireClientKeys: boolean): string {
  const lines = [`curl ${origin}/v1/decisions \\`, "  -H 'Content-Type: application/json' \\"];
  if (requireClientKeys) lines.push('  -H "Authorization: Bearer $DG_CLIENT_KEY" \\');
  lines.push(`  -d ${shellQuote(JSON.stringify(request, null, 2))}`);
  return lines.join("\n");
}

export interface Preset {
  id: string;
  title: string;
  summary: string;
  build: () => BuilderState;
}

function presetTicket(): BuilderState {
  const department = makeQuestion("choice", "department", "Which team should own this ticket?");
  department.choices = [
    makeChoice("string", "billing", "Charges, invoices, refunds or payment methods."),
    makeChoice("string", "technical", "Bugs, outages, errors or anything that needs engineering."),
    makeChoice("string", "account", "Access, ownership, email changes or workspace settings."),
    makeChoice("string", "other", "Anything that fits none of the above."),
  ];
  const urgent = makeQuestion("predicate", "is_urgent", "Does the customer need a response within one business day?");
  const severity = makeQuestion("score", "severity", "How much harm does this issue cause the customer right now?");
  severity.levels = [
    makeLevel("minor", "Inconvenient, with a workaround."),
    makeLevel("moderate", "Blocks part of the work or costs money."),
    makeLevel("severe", "Blocks the whole account or moves money in error."),
  ];
  return {
    model: "luna",
    input: "I was charged twice for my March invoice and the second charge still shows on my card. Please reverse it today.",
    questions: [department, urgent, severity],
  };
}

function presetDeploy(): BuilderState {
  const kind = makeQuestion("choice", "kind", "What kind of problem is this?");
  kind.choices = [
    makeChoice("string", "incident", "Customers are affected now."),
    makeChoice("string", "regression", "Started after a recent change."),
    makeChoice("string", "noise", "Within normal variation."),
  ];
  const rollback = makeQuestion("predicate", "needs_rollback", "Should the last deploy be rolled back now?");
  const impact = makeQuestion("score", "impact", "How broad is the impact?");
  impact.levels = [
    makeLevel("limited", "One feature or a small share of requests."),
    makeLevel("broad", "Most of one service."),
    makeLevel("platform", "Several services or all customers."),
  ];
  return {
    model: "elephant",
    input: "Checkout error rate rose from 0.4% to 6% right after the 14:00 deploy; p95 latency doubled.",
    questions: [kind, rollback, impact],
  };
}

function presetTyped(): BuilderState {
  const paid = makeQuestion("choice", "paid_in_full", "Is invoice 4411 paid in full?");
  paid.choices = [
    makeChoice("boolean", "true", "The ledger shows the full amount received."),
    makeChoice("boolean", "false", "Any balance is still open."),
  ];
  const tier = makeQuestion("choice", "tier", "Which support tier should handle the follow-up?");
  tier.choices = [
    makeChoice("number", "1", "Urgent, same day."),
    makeChoice("number", "2", "Normal, within two days."),
    makeChoice("number", "3", "Low, when convenient."),
  ];
  const human = makeQuestion("predicate", "needs_human", "Does a person need to review this?");
  return {
    model: "",
    input: "Customer asks whether invoice 4411 was paid. The ledger shows a partial payment of 40 of 120.",
    questions: [paid, tier, human],
  };
}

export function presets(): Preset[] {
  return [
    { id: "charged-twice", title: "Charged twice", summary: "A support ticket: department, urgency and severity.", build: presetTicket },
    { id: "deploy-alert", title: "Deploy alert", summary: "Triage a regression after a deploy, with a score on impact.", build: presetDeploy },
    {
      id: "typed-values",
      title: "Typed values",
      summary: "Boolean and number choices, so you can see values keep their types.",
      build: presetTyped,
    },
  ];
}
