// In-memory implementation of the console API. It serves synthetic fixtures, keeps
// every edit in memory, and mirrors the server's validation and error shapes closely
// enough that the screens behave the same against either implementation.

import { mockSyntheticMethod, mockSyntheticAnswer } from "../../domain/synthetic";
import { chatPath } from "../../domain/connection-form";
import type { ConsoleApi } from "../console-api";
import { ApiError } from "../errors";
import type {
  Answer,
  Attempt,
  ChoiceAnswer,
  ClientKey,
  CreatedClientKey,
  DecisionRequest,
  DecisionResponse,
  GatewayConfidenceMethod,
  Health,
  LogEntry,
  LogPage,
  LogQuery,
  PlaygroundRun,
  Provider,
  ProviderKind,
  ProviderModel,
  ProviderPatch,
  ProviderTestResult,
  ProviderWrite,
  Question,
  Route,
  RouteTarget,
  RouteWrite,
  Settings,
  Stats,
  StatsBucket,
  StatsWindow,
  KeyRead,
  KeyWrite,
  ProviderStats,
  RouteStats,
  Usage,
} from "../types";
import {
  DAY,
  FRESH_ENV_VARS,
  HOUR,
  MINUTE,
  MOCK_ENV_VARS,
  estimateTokens,
  generateLogs,
  hashString,
  mockBilled,
  mockCost,
  mockSelf,
  modelsFor,
  seedClients,
  seedFreshProviders,
  seedFreshRoutes,
  seedFreshSettings,
  seedProviders,
  seedRoutes,
  seedSettings,
  seededRandom,
  VLLM_MODEL,
} from "./fixtures";
import { defaultSendModel } from "../../domain/hosts";
import { KNOWN_ANSWER, checkAnswer, isExpected, knownAnswerRequest } from "../../domain/known-answer";
import { chooseTestModel } from "../../domain/test-model";

export interface MockOptions {
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  seed?: number;
  /** "demo" serves a busy week with a missing OpenRouter key; "fresh" serves a first run. */
  scenario?: "demo" | "fresh";
  /** False refuses stored keys with the gateway's GATEWAY_SECRET error. */
  storesKeys?: boolean;
  /** False fails every provider's model list, as when the gateway cannot be reached, so the pickers show their error state. */
  listsModels?: boolean;
}

const PROVIDER_KINDS: readonly ProviderKind[] = ["openai", "openrouter", "systemone", "openai-compatible", "mock"];
const NAME_PATTERN = /^[a-z0-9-]+$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_PATTERN = /^[A-Za-z0-9-]+$/;
const HINT_FIELDS = ["id", "price_per_m_input", "context", "description"];
const MOCK_KIND: ProviderKind = "mock";

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request_error", message);
}

function at<T>(items: readonly T[], index: number): T | undefined {
  return items[index];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the gateway shows of a stored key, as its rule says: the last four characters of a key of at least 12, else none. */
function storedKeyTail(value: string): string | null {
  const characters = [...value];
  return characters.length >= 12 ? characters.slice(-4).join("") : null;
}

function validUrl(text: string): boolean {
  if (text.startsWith("builtin://")) return true;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Normalised probabilities over `count` options, deterministic for `seed`. */
function distribution(seed: number, count: number): number[] {
  const rand = seededRandom(seed);
  const raw = Array.from({ length: count }, () => Math.pow(rand() + 0.12, 2));
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
}

function normalizedEntropyConfidence(probabilities: readonly number[]): number {
  const k = probabilities.length;
  if (k < 2) return 1;
  const entropy = -probabilities.reduce((sum, p) => (p > 0 ? sum + p * Math.log(p) : sum), 0);
  return Math.min(1, Math.max(0, 1 - entropy / Math.log(k)));
}

function argmax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) {
    if ((at(values, i) ?? 0) > (at(values, best) ?? 0)) best = i;
  }
  return best;
}

function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1] ?? null;
}

function validateQuestions(questions: unknown): asserts questions is Question[] {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 400) {
    throw invalid("questions must contain between 1 and 400 entries.");
  }
  const names = new Set<string>();
  questions.forEach((question: unknown, index) => {
    if (!isRecord(question)) throw invalid(`questions[${index}] must be an object.`);
    const name = typeof question.name === "string" ? question.name.trim() : "";
    if (name.length === 0) throw invalid(`questions[${index}].name must not be empty.`);
    if (names.has(name)) throw invalid(`question name "${name}" is used more than once.`);
    names.add(name);
    if (typeof question.instructions !== "string" || question.instructions.trim().length === 0) {
      throw invalid(`question "${name}" needs instructions.`);
    }
    if (question.type === "choice") {
      const choices = question.choices;
      if (!Array.isArray(choices) || choices.length < 2 || choices.length > 64) {
        throw invalid(`choice question "${name}" needs between 2 and 64 choices.`);
      }
      const seen = new Set<string>();
      for (const choice of choices as unknown[]) {
        if (!isRecord(choice)) throw invalid(`choice question "${name}" has an invalid choice.`);
        const value = choice.value;
        if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") {
          throw invalid(`choice question "${name}" has a value that is not a string, boolean or number.`);
        }
        const key = String(value);
        if (seen.has(key)) throw invalid(`choice question "${name}" repeats the value ${key}.`);
        seen.add(key);
      }
    } else if (question.type === "score") {
      const levels = question.levels;
      if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10) {
        throw invalid(`score question "${name}" needs between 2 and 10 levels.`);
      }
      const labels = new Set<string>();
      for (const level of levels as unknown[]) {
        if (!isRecord(level)) throw invalid(`score question "${name}" has an invalid level.`);
        if (typeof level.label === "string") {
          if (labels.has(level.label)) throw invalid(`score question "${name}" repeats the label "${level.label}".`);
          labels.add(level.label);
        }
      }
    } else if (question.type !== "predicate") {
      throw invalid(`question "${name}" has an unknown type.`);
    }
  });
}

function validateDecisionRequest(request: unknown): DecisionRequest {
  if (!isRecord(request)) throw invalid("request must be an object.");
  if (typeof request.input !== "string" || request.input.trim().length === 0) {
    throw invalid("input must be a non-empty string.");
  }
  if (request.model !== undefined && typeof request.model !== "string") {
    throw invalid("model must be a string when it is present.");
  }
  validateQuestions(request.questions);
  return request as unknown as DecisionRequest;
}

function answerForChoice(question: Question, input: string): ChoiceAnswer {
  const choices = question.choices ?? [];
  const seed = hashString(`${input}|${question.name}`);
  const probabilities = distribution(seed, choices.length);
  const best = at(choices, argmax(probabilities));
  const upstreamConfidence = seed % 3 === 0;
  const method = upstreamConfidence ? "upstream" : "normalized-entropy";
  const confidence = upstreamConfidence ? round2(0.55 + (seed % 40) / 100) : round2(normalizedEntropyConfidence(probabilities));
  return {
    type: "choice",
    name: question.name,
    choice: best?.value ?? "",
    probabilities: choices.map((choice, i) => ({ value: choice.value, probability: round2(at(probabilities, i) ?? 0) })),
    confidence,
    confidence_method: method,
  };
}

function answerForScore(question: Question, input: string): Extract<Answer, { type: "score" }> {
  const levels = question.levels ?? [];
  const seed = hashString(`${input}|${question.name}`);
  const probabilities = distribution(seed, levels.length);
  const expected = probabilities.reduce((sum, p, i) => sum + i * p, 0);
  const upstreamConfidence = seed % 4 === 1;
  const method = upstreamConfidence ? "upstream" : "normalized-entropy";
  return {
    type: "score",
    name: question.name,
    score: round2(expected),
    probabilities: levels.map((level, i) => ({
      value: i,
      ...(typeof level.label === "string" && level.label.length > 0 ? { label: level.label } : {}),
      probability: round2(at(probabilities, i) ?? 0),
    })),
    confidence: upstreamConfidence ? round2(0.6 + (seed % 30) / 100) : round2(normalizedEntropyConfidence(probabilities)),
    confidence_method: method,
  };
}

function answerForPredicate(question: Question, input: string): Extract<Answer, { type: "predicate" }> {
  const seed = hashString(`${input}|${question.name}`);
  return { type: "predicate", name: question.name, probability: round2(0.12 + 0.76 * ((seed % 1000) / 1000)) };
}

/**
 * The model that answers the known-answer check wrongly in mock mode, so that result can be seen: the demo vLLM
 * server's small local model. Every other model gives the expected answer.
 */
export const WRONG_ANSWER_MODEL = VLLM_MODEL;

/** Whether a question is the known-answer check's, asked about its ticket. */
function isKnownAnswerCheck(question: Question, input: string): boolean {
  const known = KNOWN_ANSWER.question;
  const sameQuestion = question.type === "choice" && question.name === known.name && question.instructions === known.instructions;
  return input === KNOWN_ANSWER.input && sameQuestion;
}

/**
 * The known-answer check, answered as a model that read the ticket would: billing, very likely. The built-in mock
 * gives it 0.96 as the gateway's mock does, other models 0.93 to 0.99; WRONG_ANSWER_MODEL picks technical at 0.62.
 */
function knownAnswerChoice(question: Question, provider: Provider, model: string): ChoiceAnswer {
  const wrong = model === WRONG_ANSWER_MODEL;
  const top = wrong ? 0.62 : provider.kind === MOCK_KIND ? 0.96 : round2(0.93 + (hashString(model) % 7) / 100);
  const second = round2(wrong ? 0.31 : provider.kind === MOCK_KIND ? 0.02 : ((1 - top) * 2) / 3);
  const odds: Record<string, number> = wrong
    ? { technical: top, billing: second, other: round2(1 - top - second) }
    : { billing: top, technical: second, other: round2(1 - top - second) };
  return {
    type: "choice",
    name: question.name,
    choice: wrong ? "technical" : KNOWN_ANSWER.expected,
    probabilities: (question.choices ?? []).map((choice) => ({ value: choice.value, probability: odds[String(choice.value)] ?? 0 })),
    confidence: round2(top - second),
    confidence_method: "upstream",
  };
}

function buildAnswers(questions: Question[], input: string, answering: { provider: Provider; model: string }): Answer[] {
  return questions.map((question) => {
    if (isKnownAnswerCheck(question, input)) return knownAnswerChoice(question, answering.provider, answering.model);
    if (question.type === "choice") return answerForChoice(question, input);
    if (question.type === "score") return answerForScore(question, input);
    return answerForPredicate(question, input);
  });
}

function gatewayConfidenceMethod(answers: Answer[]): GatewayConfidenceMethod {
  const methods = new Set<string>();
  for (const answer of answers) {
    if ("confidence_method" in answer && answer.confidence_method) methods.add(answer.confidence_method);
  }
  if (methods.size === 0) return "none";
  if (methods.size === 1) return [...methods][0] as GatewayConfidenceMethod;
  return "mixed";
}

/** The gateway's check of a provider's model hints: a list of known fields, unique non-empty ids, sane numbers. */
function validHints(hints: unknown): boolean {
  if (!Array.isArray(hints) || hints.length > 200) return false;
  const ids = new Set<string>();
  for (const hint of hints as unknown[]) {
    if (!isRecord(hint) || Object.keys(hint).some((key) => !HINT_FIELDS.includes(key))) return false;
    if (typeof hint.id !== "string" || hint.id.trim().length === 0 || ids.has(hint.id)) return false;
    const price = hint.price_per_m_input;
    if (price !== undefined && (typeof price !== "number" || !Number.isFinite(price) || price < 0)) return false;
    const context = hint.context;
    if (context !== undefined && (typeof context !== "number" || !Number.isInteger(context) || context <= 0)) return false;
    if (hint.description !== undefined && typeof hint.description !== "string") return false;
    ids.add(hint.id);
  }
  return true;
}

/** The gateway's check of a provider's test model: absent or null for none, or a model id of at most 200 characters. */
function validTestModel(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

/** Whether a provider answers on the SystemOne map wire. The built-in mock always does, whatever its setting, as in the gateway. */
function speaksMap(provider: Provider): boolean {
  return provider.kind === MOCK_KIND || provider.wire === "map";
}

/** The wire body a provider would receive, for the trace view (API reference, Upstream wires). */
function upstreamRequestBody(provider: Provider, upstreamModel: string, request: DecisionRequest): unknown {
  if (provider.wire === "chat" && provider.kind !== MOCK_KIND) return request.questions.map((question) => ({ model: upstreamModel, messages: [{ role: "system", content: "Answer using the requested format." }, { role: "user", content: JSON.stringify({ input: request.input }) }, { role: "user", content: JSON.stringify(question) }], synthetic_method: mockSyntheticMethod(provider, question, request.input), ...provider.extra_body }));
  if (!speaksMap(provider)) {
    return { model: upstreamModel, input: request.input, questions: request.questions, ...provider.extra_body };
  }
  const questions: Record<string, unknown> = {};
  request.questions.forEach((question, index) => {
    const entry: Record<string, unknown> = { type: question.type === "predicate" ? "noul" : question.type, instructions: question.instructions };
    if (question.type === "choice") {
      entry.criteria = Object.fromEntries((question.choices ?? []).map((choice, i) => [`o${i}`, choice.description]));
    }
    if (question.type === "score") entry.criteria = (question.levels ?? []).map((level) => level.description);
    questions[`q${index}`] = entry;
  });
  // The gateway sends the built-in mock the state and questions alone.
  if (provider.kind === MOCK_KIND) return { state: request.input, questions };
  const named = provider.send_model ?? defaultSendModel(provider.kind, provider.base_url);
  return { state: request.input, questions, ...(named ? { model: upstreamModel } : {}), ...provider.extra_body };
}

/** One answer as a SystemOne server sends it: a choice by option id, a noul, or a score by level index with a legend. */
function systemOneAnswer(answer: Answer, question: Question | undefined): unknown {
  if ("refusal" in answer) return { refusal: answer.refusal };
  if (answer.type === "predicate") return { type: "noul", noul: answer.probability };
  if (answer.type === "choice") {
    const chosen = answer.probabilities.findIndex((entry) => entry.value === answer.choice);
    return {
      type: "choice",
      choice: `o${Math.max(0, chosen)}`,
      probabilities: Object.fromEntries(answer.probabilities.map((entry, i) => [`o${i}`, entry.probability])),
      confidence: answer.confidence,
    };
  }
  return {
    type: "score",
    score: answer.score,
    probabilities: Object.fromEntries(answer.probabilities.map((entry) => [String(entry.value), entry.probability])),
    legend: Object.fromEntries((question?.levels ?? []).map((level, i) => [String(i), level.description])),
    confidence: answer.confidence,
  };
}

/** The raw body the upstream answered with, for the trace view: OpenAI's own shape, or SystemOne's. */
function upstreamResponseBody(provider: Provider, model: string, request: DecisionRequest, response: DecisionResponse): unknown {
  const self = mockSelf(provider.kind, model);
  const usage = response.usage;
  if (!speaksMap(provider)) {
    // OpenAI's answers carry no confidence_method; that is the gateway's addition.
    const answers = response.answers.map((answer) => Object.fromEntries(Object.entries(answer).filter(([key]) => key !== "confidence_method")));
    return { ...(self.resolvedModel ? { model: self.resolvedModel } : {}), answers, ...(usage ? { usage } : {}) };
  }
  return {
    ...(self.resolvedModel ? { model: self.resolvedModel } : {}),
    answers: Object.fromEntries(response.answers.map((answer, index) => [`q${index}`, systemOneAnswer(answer, request.questions[index])])),
    ...(usage
      ? {
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            ...(response.gateway.cost_basis === "upstream_cost" ? { cost: response.gateway.cost_usd } : {}),
          },
        }
      : {}),
    ...(self.servedBy ? { provider: self.servedBy } : {}),
  };
}

/**
 * The usage an upstream reports, in OpenAI's shape: the built-in mock counts the gateway's own estimate of
 * the input, OpenAI adds its token details, and every other upstream counts a little more per question.
 */
function mockUsage(provider: Provider, request: DecisionRequest): Usage {
  const output = speaksMap(provider) ? request.questions.length : 0;
  const input = provider.kind === MOCK_KIND ? estimateTokens(request) : 60 + request.questions.length * 35;
  const details =
    provider.kind === "openai"
      ? { input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
      : {};
  return { input_tokens: input, output_tokens: output, total_tokens: input + output, ...details };
}

export function createMockApi(options: MockOptions = {}): ConsoleApi {
  const now = options.now ?? (() => Date.now());
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const seed = options.seed ?? 20260;
  const fresh = options.scenario === "fresh";
  const storesKeys = options.storesKeys ?? true;
  const listsModels = options.listsModels ?? true;
  const envVars = fresh ? FRESH_ENV_VARS : MOCK_ENV_VARS;
  const startedAt = now();
  const keyMissingSince = startedAt - 2 * HOUR - 10 * MINUTE;
  const startedIso = new Date(startedAt).toISOString();

  const state: { providers: Provider[]; routes: Route[]; clients: ClientKey[]; settings: Settings; logs: LogEntry[] } = fresh
    ? { providers: seedFreshProviders(startedIso), routes: seedFreshRoutes(startedIso), clients: [], settings: seedFreshSettings(), logs: [] }
    : {
        providers: seedProviders(startedIso, startedAt),
        routes: seedRoutes(startedIso),
        clients: seedClients(startedAt),
        settings: seedSettings(),
        logs: generateLogs(startedAt, seed, keyMissingSince),
      };

  let counter = 1000;

  const nextId = (prefix: string): string => {
    counter += 1;
    return `${prefix}_${counter.toString(36)}`;
  };

  const decisionId = (): string => `dec_${Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;

  const pause = (min: number, max: number): Promise<void> => delay(min + Math.round(Math.random() * (max - min)));

  const iso = (ms: number): string => new Date(ms).toISOString();

  const providerById = (id: string): Provider | undefined => state.providers.find((p) => p.id === id);

  const providerByName = (name: string): Provider | undefined => state.providers.find((p) => p.name === name);

  const routeByAlias = (alias: string): Route | undefined => state.routes.find((r) => r.alias === alias);

  function notFound(kind: string, id: string): ApiError {
    return new ApiError(404, "not_found_error", `No ${kind} with id ${id}.`);
  }

  function keyFromWrite(key: KeyWrite): KeyRead {
    if (key.source === "env") {
      return { source: "env", env_var: key.env_var, present: envVars.has(key.env_var) };
    }
    if (key.source === "stored") {
      return { source: "stored", last4: storedKeyTail(key.value) };
    }
    return { source: "none" };
  }

  function validateProviderFields(body: Partial<ProviderWrite>, current?: Provider): void {
    if (body.name !== undefined && (!NAME_PATTERN.test(body.name) || body.name.length === 0)) {
      throw invalid("Provider names use lowercase letters, digits and hyphens only.");
    }
    if (body.name !== undefined && body.name !== current?.name && providerByName(body.name)) {
      throw invalid(`A provider named "${body.name}" already exists.`);
    }
    const methods = body.synthetic_methods ?? current?.synthetic_methods;
    if (methods && (!methods.length || new Set(methods).size !== methods.length || methods.some((m) => !["logprobs", "sampling", "json"].includes(m)))) throw invalid("Invalid synthetic_methods.");
    if (body.sampling_n !== undefined && (!Number.isInteger(body.sampling_n) || body.sampling_n < 2 || body.sampling_n > 32)) throw invalid("sampling_n must be 2 to 32.");
    if (body.json_transport !== undefined && !["auto", "json_schema", "prompt"].includes(body.json_transport)) throw invalid("Invalid json_transport.");
    if (body.disable_reasoning !== undefined && typeof body.disable_reasoning !== "boolean") throw invalid("disable_reasoning must be true or false.");
    if ((body.wire ?? current?.wire) === "chat" && methods?.length === 1 && methods[0] === "logprobs" && ((body.limits ?? current?.limits)?.max_choices ?? 0) > 20) throw invalid("Logprobs supports at most 20 choices.");
    if (body.wire !== undefined && !["openai", "map", "chat"].includes(body.wire)) throw invalid("Invalid wire.");
    if (body.kind !== undefined && !PROVIDER_KINDS.includes(body.kind)) throw invalid("Unknown provider kind.");
    if (body.base_url !== undefined && !validUrl(body.base_url)) throw invalid("Base URL must be an http or https URL.");
    if (body.path !== undefined && !body.path.startsWith("/")) throw invalid("Path must start with /.");
    if (body.timeout_ms !== undefined && (body.timeout_ms < 100 || body.timeout_ms > 600000)) {
      throw invalid("Timeout must be between 100 and 600000 ms.");
    }
    if (body.limits !== undefined) {
      if (body.limits.max_questions < 1 || body.limits.max_questions > 400) throw invalid("max_questions must be 1 to 400.");
      if (body.limits.max_choices < 2 || body.limits.max_choices > 64) throw invalid("max_choices must be 2 to 64.");
    }
    if (body.extra_body !== undefined && !isRecord(body.extra_body)) throw invalid("extra_body must be a JSON object.");
    if (body.key?.source === "env" && !ENV_PATTERN.test(body.key.env_var)) {
      throw invalid("The environment variable name is not valid.");
    }
    if (body.key?.source === "stored" && body.key.value.length === 0) {
      throw invalid("A stored key needs a value.");
    }
    if (body.send_model !== undefined && typeof body.send_model !== "boolean") throw invalid("send_model must be true or false");
    if (
      body.auth_header !== undefined &&
      (!HEADER_PATTERN.test(body.auth_header) || ["content-type", "host"].includes(body.auth_header.toLowerCase()))
    ) {
      throw invalid('auth_header must be "authorization" or a header name of letters, digits and hyphens, other than content-type and host');
    }
    if (body.model_hints !== undefined && !validHints(body.model_hints)) {
      throw invalid("model_hints must be a list of { id, price_per_m_input?, context?, description? } with unique ids");
    }
    if (!validTestModel(body.test_model)) {
      throw invalid("test_model must be a model id of at most 200 characters, or null for none");
    }
    if (body.key?.source === "stored" && !storesKeys) {
      // The gateway's own refusal when GATEWAY_SECRET is unset (store.ts encrypt()), with its code.
      throw new ApiError(400, "invalid_request_error", "GATEWAY_SECRET must be set to store provider keys", "gateway_secret_missing");
    }
  }

  function validateTargets(targets: readonly RouteTarget[]): void {
    if (targets.length === 0) throw invalid("A route needs at least one target.");
    for (const target of targets) {
      if (!providerById(target.provider_id)) throw invalid("A target points at a provider that does not exist.");
      const price = target.price_per_m_input;
      if (price !== undefined && price !== null && (typeof price !== "number" || !Number.isFinite(price) || price < 0)) {
        throw invalid("price_per_m_input must be a number of zero or more, or null.");
      }
    }
  }

  function providerUsage(providerId: string): Route[] {
    return state.routes.filter((route) => route.targets.some((target) => target.provider_id === providerId));
  }

  interface ResolvedTarget {
    provider: Provider;
    model: string;
    timeoutMs?: number;
    price?: number | null;
  }

  function resolveTargets(model: string | undefined): { alias: string | null; targets: ResolvedTarget[] } | { error: string } {
    const requested = model ?? state.settings.default_route;
    if (requested.includes("::")) {
      const [providerName = "", upstream = ""] = requested.split("::", 2);
      const provider = providerByName(providerName);
      if (!provider) return { error: `No provider named "${providerName}".` };
      return { alias: null, targets: [{ provider, model: upstream }] };
    }
    const route = routeByAlias(requested);
    if (!route || !route.enabled) return { error: `No enabled route named "${requested}". Use a route alias or provider::model.` };
    const targets: ResolvedTarget[] = [];
    for (const target of route.targets) {
      const provider = providerById(target.provider_id);
      if (provider) {
        const entry: ResolvedTarget = { provider, model: target.model, price: target.price_per_m_input ?? null };
        if (target.timeout_ms !== undefined) entry.timeoutMs = target.timeout_ms;
        targets.push(entry);
      }
    }
    return { alias: route.alias, targets };
  }

  function logFromRun(
    alias: string | null,
    request: DecisionRequest,
    attempts: Attempt[],
    winner: { provider: Provider; model: string } | null,
    latency: number,
    error: string | null,
    response: DecisionResponse | null,
  ): LogEntry {
    const gateway = response?.gateway;
    const last = attempts[attempts.length - 1];
    const entry: LogEntry = {
      id: nextId("log"),
      ts: iso(now()),
      route: alias,
      provider: winner?.provider.name ?? last?.provider ?? "unknown",
      upstream_model: winner?.model ?? last?.model ?? "",
      served_by: gateway?.served_by ?? null,
      upstream_model_resolved: gateway?.upstream_model_resolved ?? null,
      status: response ? "ok" : "error",
      fallback_used: attempts.length > 1,
      http_status: response ? 200 : error?.includes("timeout") ? 504 : 502,
      latency_ms: latency,
      questions: request.questions.length,
      prompt_tokens: response?.usage?.input_tokens ?? null,
      error,
      attempts,
      cost_usd: gateway?.cost_usd ?? null,
      cost_basis: gateway?.cost_basis ?? null,
      tokens: gateway?.tokens ?? null,
    };
    if (state.settings.capture_payloads) {
      entry.request = request;
      if (response) entry.response = response;
    }
    return entry;
  }

  function computeStats(window: StatsWindow): Stats {
    const span = window === "1h" ? HOUR : window === "24h" ? DAY : 7 * DAY;
    const start = now() - span;
    const inWindow = state.logs.filter((log) => Date.parse(log.ts) >= start);
    const latencies = inWindow.map((log) => log.latency_ms).sort((a, b) => a - b);

    const costOf = (logs: readonly LogEntry[]): number => round8(logs.reduce((sum, log) => sum + (log.cost_usd ?? 0), 0));

    const groupStats = <K extends string>(
      keyOf: (log: LogEntry) => K,
    ): { key: K; requests: number; errors: number; p50_ms: number | null; cost_usd: number; unpriced: number }[] => {
      const groups = new Map<K, number[]>();
      const errors = new Map<K, number>();
      const costs = new Map<K, number>();
      const unpriced = new Map<K, number>();
      for (const log of inWindow) {
        const key = keyOf(log);
        groups.set(key, [...(groups.get(key) ?? []), log.latency_ms]);
        if (log.status === "error") errors.set(key, (errors.get(key) ?? 0) + 1);
        if (log.status === "ok" && log.cost_basis === "unpriced") unpriced.set(key, (unpriced.get(key) ?? 0) + 1);
        costs.set(key, (costs.get(key) ?? 0) + (log.cost_usd ?? 0));
      }
      return [...groups.entries()]
        .map(([key, values]) => ({
          key,
          requests: values.length,
          errors: errors.get(key) ?? 0,
          p50_ms: percentile(
            [...values].sort((a, b) => a - b),
            0.5,
          ),
          cost_usd: round8(costs.get(key) ?? 0),
          unpriced: unpriced.get(key) ?? 0,
        }))
        .sort((a, b) => b.requests - a.requests);
    };

    const bucketSpan = span / 24;
    const timeseries: StatsBucket[] = Array.from({ length: 24 }, (_, i) => {
      const bucketStart = start + i * bucketSpan;
      const bucketEnd = bucketStart + bucketSpan;
      const inBucket = inWindow.filter((log) => {
        const ts = Date.parse(log.ts);
        return ts >= bucketStart && ts < bucketEnd;
      });
      const values = inBucket.map((log) => log.latency_ms).sort((a, b) => a - b);
      return {
        t: iso(bucketStart),
        requests: inBucket.length,
        errors: inBucket.filter((log) => log.status === "error").length,
        p50_ms: percentile(values, 0.5),
        p95_ms: percentile(values, 0.95),
        fallbacks: inBucket.filter((log) => log.fallback_used).length,
        fallbacks_answered: inBucket.filter((log) => log.fallback_used && log.status === "ok").length,
        cost_usd: costOf(inBucket),
      };
    });

    return {
      window,
      requests: inWindow.length,
      errors: inWindow.filter((log) => log.status === "error").length,
      p50_ms: percentile(latencies, 0.5),
      p95_ms: percentile(latencies, 0.95),
      fallbacks: inWindow.filter((log) => log.fallback_used).length,
      fallbacks_answered: inWindow.filter((log) => log.fallback_used && log.status === "ok").length,
      cost_usd: costOf(inWindow),
      unpriced: inWindow.filter((log) => log.status === "ok" && log.cost_basis === "unpriced").length,
      by_provider: groupStats((log) => log.provider).map<ProviderStats>((g) => ({
        provider: g.key,
        requests: g.requests,
        errors: g.errors,
        p50_ms: g.p50_ms,
        cost_usd: g.cost_usd,
        unpriced: g.unpriced,
      })),
      by_route: groupStats((log) => log.route ?? "(direct)").map<RouteStats>((g) => ({
        route: g.key,
        requests: g.requests,
        errors: g.errors,
        p50_ms: g.p50_ms,
        cost_usd: g.cost_usd,
        unpriced: g.unpriced,
      })),
      timeseries,
    };
  }

  function recordTest(id: string, result: ProviderTestResult): ProviderTestResult {
    const lastTest = {
      ok: result.ok,
      at: iso(now()),
      latency_ms: result.latency_ms,
      model: result.model,
      error: result.error ?? null,
      model_reason: result.model_reason ?? null,
      matched: result.matched ?? null,
    };
    state.providers = state.providers.map((provider) => (provider.id === id ? { ...provider, last_test: lastTest } : provider));
    return result;
  }

  /**
   * One decision through the routing path, as the gateway runs it: each target in order until one answers, logged.
   * A failure's message is the last attempt's, as the gateway reports it.
   */
  function execute(request: DecisionRequest): PlaygroundRun {
    const resolved = resolveTargets(request.model);
    if ("error" in resolved) {
      const attempts: Attempt[] = [];
      state.logs = [logFromRun(null, request, attempts, null, 2, resolved.error, null), ...state.logs];
      return {
        response: null,
        error: { message: resolved.error, type: "not_found_error" },
        trace: { attempts, upstream_request: null, upstream_response: null },
      };
    }

    const attempts: Attempt[] = [];
    let winner: { provider: Provider; model: string; latency: number; price: number | null } | null = null;
    let winnerWire: unknown = null;
    for (const target of resolved.targets) {
      const { provider } = target;
      const forceTimeout = request.input.includes("[timeout]") && attempts.length === 0;
      if (!provider.enabled) {
        attempts.push({ provider: provider.name, model: target.model, ok: false, latency_ms: 2, error: "provider disabled" });
        continue;
      }
      if (provider.key.source === "env" && !provider.key.present) {
        attempts.push({
          provider: provider.name,
          model: target.model,
          ok: false,
          latency_ms: 3,
          error: `${provider.key.env_var} is not set on the gateway host`,
        });
        continue;
      }
      if (forceTimeout) {
        const timeout = target.timeoutMs ?? provider.timeout_ms;
        attempts.push({ provider: provider.name, model: target.model, ok: false, latency_ms: timeout, error: "timeout" });
        continue;
      }
      if (request.questions.length > provider.limits.max_questions || request.questions.some((q) => Math.max(q.choices?.length ?? 0, q.levels?.length ?? 0) > provider.limits.max_choices) || (provider.wire === "chat" && request.questions.some((q) => !mockSyntheticMethod(provider, q, request.input)))) {
        attempts.push({ provider: provider.name, model: target.model, ok: false, latency_ms: 2, error: "provider limits or synthetic methods exceeded" }); continue;
      }
      const latency = 140 + Math.round(seededRandom(hashString(`${request.input}${provider.id}`))() * 380);
      attempts.push({ provider: provider.name, model: target.model, ok: true, latency_ms: latency, error: null });
      winner = { provider, model: target.model, latency, price: target.price ?? null };
      winnerWire = upstreamRequestBody(provider, target.model, request);
      break;
    }

    const totalLatency = attempts.reduce((sum, attempt) => sum + attempt.latency_ms, 0);
    if (!winner) {
      const last = attempts[attempts.length - 1];
      const message = last?.error ?? "Every target failed. See the attempts.";
      const type = last?.error === "timeout" ? "timeout_error" : "upstream_error";
      state.logs = [logFromRun(resolved.alias, request, attempts, null, totalLatency, message, null), ...state.logs];
      return { response: null, error: { message, type }, trace: { attempts, upstream_request: null, upstream_response: null } };
    }

    const nativeAnswers = buildAnswers(request.questions, request.input, winner);
    const answers = winner.provider.wire === "chat" && winner.provider.kind !== MOCK_KIND ? nativeAnswers.map((answer, i) => mockSyntheticAnswer(answer, mockSyntheticMethod(winner.provider, request.questions[i]!, request.input) ?? "json", winner.provider.sampling_n ?? 8)) : nativeAnswers;
    const usage = mockUsage(winner.provider, request);
    const billed = mockBilled(winner.provider, winner.model, usage.input_tokens);
    const cost = mockCost(winner.provider, winner.model, winner.price, usage.input_tokens, estimateTokens(request), billed);
    const self = mockSelf(winner.provider.kind, winner.model);
    const response: DecisionResponse = {
      id: decisionId(),
      object: "decision",
      created: Math.floor(now() / 1000),
      model: request.model ?? state.settings.default_route,
      answers,
      usage,
      gateway: {
        synthetic: winner.provider.wire === "chat" && winner.provider.kind !== MOCK_KIND,
        route: resolved.alias,
        provider: winner.provider.name,
        upstream_model: winner.model,
        served_by: self.servedBy,
        upstream_model_resolved: self.resolvedModel,
        latency_ms: totalLatency,
        attempts,
        confidence_method: gatewayConfidenceMethod(answers),
        cost_usd: cost.cost_usd,
        cost_basis: cost.cost_basis,
        tokens: cost.tokens,
      },
    };
    state.logs = [
      logFromRun(resolved.alias, request, attempts, { provider: winner.provider, model: winner.model }, totalLatency, null, response),
      ...state.logs,
    ];
    return {
      response,
      trace: {
        attempts,
        upstream_request: winnerWire,
        upstream_response: upstreamResponseBody(winner.provider, winner.model, request, response),
      },
    };
  }

  const api: ConsoleApi = {
    async checkToken(token) {
      await pause(180, 320);
      if (token.trim().length === 0) throw new ApiError(401, "authentication_error", "Missing admin token.");
      return api.health();
    },

    async health(): Promise<Health> {
      await pause(120, 260);
      return {
        ok: true,
        version: "0.1.0",
        uptime_s: Math.floor((now() - startedAt) / 1000) + 3 * 86_400 + 4 * 3_600 + 12 * 60,
        // The mock's secret is set unless it refuses stored keys (?nosecret=1), as a gateway without GATEWAY_SECRET does.
        secret_configured: storesKeys,
        providers: state.providers.map((p) => ({
          name: p.name,
          enabled: p.enabled,
          key_present: p.key.source === "env" ? p.key.present : true,
        })),
      };
    },

    async stats(window) {
      await pause(200, 420);
      return computeStats(window);
    },

    async listProviders() {
      await pause(120, 260);
      return structuredClone(state.providers);
    },

    async createProvider(body) {
      await pause(220, 380);
      validateProviderFields(body);
      const timestamp = iso(now());
      const provider: Provider = {
        id: nextId("prv"),
        name: body.name,
        kind: body.kind,
        base_url: body.base_url,
        path: body.path,
        wire: body.wire,
        synthetic_methods: body.synthetic_methods, sampling_n: body.sampling_n, json_transport: body.json_transport,
        ...(body.disable_reasoning === undefined ? {} : { disable_reasoning: body.disable_reasoning }),
        enabled: body.enabled,
        timeout_ms: body.timeout_ms,
        limits: body.limits,
        extra_body: body.extra_body,
        key: keyFromWrite(body.key),
        // The gateway's defaults for options left out: send_model by kind and host, Bearer in authorization.
        send_model: body.send_model ?? defaultSendModel(body.kind, body.base_url),
        auth_header: (body.auth_header ?? "authorization").toLowerCase(),
        model_hints: body.model_hints ?? [],
        test_model: body.test_model ?? null,
        last_test: null,
        created_at: timestamp,
        updated_at: timestamp,
      };
      state.providers = [...state.providers, provider];
      return structuredClone(provider);
    },

    async updateProvider(id, patch: ProviderPatch) {
      await pause(220, 380);
      const current = providerById(id);
      if (!current) throw notFound("provider", id);
      validateProviderFields(patch, current);
      if (patch.wire === "chat" && current.wire !== "chat" && patch.path === undefined) patch = { ...patch, path: chatPath(patch.kind ?? current.kind, patch.base_url ?? current.base_url) };
      const { key, auth_header, ...rest } = patch;
      const updated: Provider = {
        ...current,
        ...(rest as Partial<Provider>),
        ...(auth_header === undefined ? {} : { auth_header: auth_header.toLowerCase() }),
        key: key ? keyFromWrite(key) : current.key,
        updated_at: iso(now()),
      };
      state.providers = state.providers.map((p) => (p.id === id ? updated : p));
      return structuredClone(updated);
    },

    async deleteProvider(id) {
      await pause(200, 340);
      const current = providerById(id);
      if (!current) throw notFound("provider", id);
      const users = providerUsage(id);
      if (users.length > 0) {
        const aliases = users.map((route) => `"${route.alias}"`).join(", ");
        throw new ApiError(
          409,
          "invalid_request_error",
          `Provider is still a target of route ${aliases}. Remove it from those routes first.`,
          "provider_in_use",
          users.map((route) => ({ id: route.id, alias: route.alias })),
        );
      }
      state.providers = state.providers.filter((p) => p.id !== id);
    },

    async testProvider(id, model): Promise<ProviderTestResult> {
      await pause(900, 1400);
      const provider = providerById(id);
      if (!provider) throw notFound("provider", id);
      if (model !== undefined && model.trim().length === 0) throw invalid("invalid model");
      // The gateway's order: the model asked for, a model's step, the test model, the first hint, then the catalog.
      const choice = chooseTestModel(model, provider, state.routes, modelsFor(provider));
      const run = execute(knownAnswerRequest(`${provider.name}::${choice.model}`));
      const answer = checkAnswer(run.response);
      return recordTest(id, {
        ok: run.response !== null,
        latency_ms: run.response?.gateway.latency_ms ?? run.trace.attempts.reduce((sum, attempt) => sum + attempt.latency_ms, 0),
        model: choice.model,
        model_reason: choice.reason,
        model_route: choice.route,
        expected: KNOWN_ANSWER.expected,
        answer: answer.kind === "answered" ? answer.value : null,
        probability: answer.kind === "answered" ? answer.probability : null,
        matched: isExpected(answer),
        ...(run.error ? { error: run.error.message } : {}),
        ...(run.response ? { response: run.response } : {}),
        trace: run.trace,
      });
    },

    async listProviderModels(id): Promise<ProviderModel[]> {
      await pause(260, 480);
      const provider = providerById(id);
      if (!provider) throw notFound("provider", id);
      if (!listsModels) {
        throw new ApiError(502, "upstream_error", "The gateway could not read the provider's model list. Try again in a moment.");
      }
      return structuredClone(modelsFor(provider));
    },

    async listRoutes() {
      await pause(120, 260);
      return structuredClone(state.routes);
    },

    async createRoute(body: RouteWrite) {
      await pause(220, 380);
      if (!NAME_PATTERN.test(body.alias)) throw invalid("Aliases use lowercase letters, digits and hyphens only.");
      if (routeByAlias(body.alias)) throw invalid(`A route named "${body.alias}" already exists.`);
      validateTargets(body.targets);
      const timestamp = iso(now());
      const route: Route = { id: nextId("rte"), ...body, created_at: timestamp, updated_at: timestamp };
      state.routes = [...state.routes, route];
      return structuredClone(route);
    },

    async updateRoute(id, patch) {
      await pause(220, 380);
      const current = state.routes.find((r) => r.id === id);
      if (!current) throw notFound("route", id);
      if (patch.alias !== undefined && !NAME_PATTERN.test(patch.alias)) {
        throw invalid("Aliases use lowercase letters, digits and hyphens only.");
      }
      if (patch.alias !== undefined && patch.alias !== current.alias && routeByAlias(patch.alias)) {
        throw invalid(`A route named "${patch.alias}" already exists.`);
      }
      if (patch.targets !== undefined) validateTargets(patch.targets);
      const updated: Route = { ...current, ...patch, updated_at: iso(now()) };
      state.routes = state.routes.map((r) => (r.id === id ? updated : r));
      return structuredClone(updated);
    },

    async deleteRoute(id) {
      await pause(200, 340);
      if (!state.routes.some((r) => r.id === id)) throw notFound("route", id);
      state.routes = state.routes.filter((r) => r.id !== id);
    },

    async listLogs(query: LogQuery): Promise<LogPage> {
      await pause(220, 420);
      const limit = Math.min(200, Math.max(1, query.limit ?? 50));
      let startIndex = 0;
      if (query.before) {
        const found = state.logs.findIndex((log) => log.id === query.before);
        if (found < 0) throw invalid("The before cursor does not match any log entry.");
        startIndex = found + 1;
      }

      const matches = (log: LogEntry): boolean =>
        (!query.route || log.route === query.route) &&
        (!query.provider || log.provider === query.provider) &&
        (!query.status || log.status === query.status) &&
        (!query.fallback || log.fallback_used === (query.fallback === "used"));

      const items: LogEntry[] = [];
      let index = startIndex;
      for (; index < state.logs.length && items.length < limit; index += 1) {
        const log = state.logs[index];
        if (log && matches(log)) items.push(log);
      }
      const hasMore = state.logs.slice(index).some(matches);
      const last = items[items.length - 1];
      return { items: structuredClone(items), next_before: hasMore && last ? last.id : null };
    },

    async getSettings() {
      await pause(120, 240);
      return { ...state.settings };
    },

    async updateSettings(patch) {
      await pause(200, 340);
      if (patch.default_route !== undefined && patch.default_route.trim().length === 0) {
        throw invalid("The default route cannot be empty.");
      }
      state.settings = { ...state.settings, ...patch };
      return { ...state.settings };
    },

    async listClients() {
      await pause(120, 240);
      return structuredClone(state.clients);
    },

    async createClient(name: string): Promise<CreatedClientKey> {
      await pause(260, 420);
      const trimmed = name.trim();
      if (trimmed.length === 0) throw invalid("Give the client a name.");
      const secret = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
      const key = `dgk_${secret}`;
      const created: ClientKey = { id: nextId("key"), name: trimmed, key_last4: key.slice(-4), created_at: iso(now()), last_used_at: null };
      state.clients = [...state.clients, created];
      return { id: created.id, name: created.name, key, key_last4: created.key_last4, created_at: created.created_at };
    },

    async deleteClient(id) {
      await pause(200, 340);
      if (!state.clients.some((c) => c.id === id)) throw notFound("client key", id);
      state.clients = state.clients.filter((c) => c.id !== id);
    },

    async runPlayground(raw): Promise<PlaygroundRun> {
      await pause(700, 1100);
      return execute(validateDecisionRequest(raw));
    },
  };

  return api;
}

export type MockApi = ReturnType<typeof createMockApi>;
