// The tests' plain-words results: the known-answer check, the verdict, why a model was tested, the meta line, the
// outcome the result component (ui/test-result.tsx) prints, and the mock's provider test, which mirrors the gateway's.

import { describe, expect, test } from "bun:test";
import type {
  Attempt,
  DecisionResponse,
  GatewayInfo,
  PlaygroundRun,
  Provider,
  Route,
} from "../../../src/modules/gateway/apps/console-web/src/api/types";
import { createMockApi, WRONG_ANSWER_MODEL } from "../../../src/modules/gateway/apps/console-web/src/api/mock/mock-api";
import { ApiError } from "../../../src/modules/gateway/apps/console-web/src/api/errors";
import {
  KNOWN_ANSWER,
  answeredVerdict,
  checkAnswer,
  failedVerdict,
  knownAnswerRequest,
  verdictLine,
} from "../../../src/modules/gateway/apps/console-web/src/domain/known-answer";
import { sampleDecision } from "../../../src/modules/gateway/apps/console-web/src/domain/playground";
import {
  SERVER_CONFIGURED,
  chooseTestModel,
  listedTestModel,
  preferredTestModel,
  reasonHint,
  reasonSentence,
} from "../../../src/modules/gateway/apps/console-web/src/domain/test-model";
import {
  answeredMeta,
  costPhrase,
  failureReason,
  formatSeconds,
  providerTestOutcome,
  runOutcome,
} from "../../../src/modules/gateway/apps/console-web/src/domain/test-result";

const FIXED_NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

const noWait = async () => {};

const demo = () => createMockApi({ now: () => FIXED_NOW, delay: noWait, seed: 7 });

function answer(value: string, probability: number): DecisionResponse["answers"][number] {
  return {
    type: "choice",
    name: "department",
    choice: value,
    probabilities: KNOWN_ANSWER.question.choices.map((choice) => ({
      value: choice.value,
      probability: choice.value === value ? probability : Math.round(((1 - probability) / 2) * 100) / 100,
    })),
    confidence: 0.9,
    confidence_method: "upstream",
  };
}

function gateway(extra: Partial<GatewayInfo> = {}): GatewayInfo {
  return {
    route: null,
    provider: "openrouter",
    upstream_model: "baseten/elephant-1",
    served_by: "Baseten",
    upstream_model_resolved: "baseten/elephant-1-20261021",
    latency_ms: 830,
    attempts: [{ provider: "openrouter", model: "baseten/elephant-1", ok: true, latency_ms: 830, error: null }],
    confidence_method: "upstream",
    cost_usd: 0.0000044,
    cost_basis: "upstream_cost",
    tokens: 44,
    ...extra,
  };
}

function response(value: string, probability: number, extra: Partial<GatewayInfo> = {}): DecisionResponse {
  return {
    id: "dec_1",
    object: "decision",
    created: 1,
    model: "x",
    answers: [answer(value, probability)],
    usage: null,
    gateway: gateway(extra),
  };
}

const failedRun = (attempts: Attempt[], message: string): PlaygroundRun => ({
  response: null,
  error: { message, type: "upstream_error" },
  trace: { attempts, upstream_request: null, upstream_response: null },
});

const titles = (name: string) => ({ openrouter: "OpenRouter", openai: "OpenAI", mock: "Mock" })[name] ?? name;

describe("the known-answer check", () => {
  test("is the gateway's ticket, question and expected answer, and the sample decision is the same request", () => {
    expect(KNOWN_ANSWER.input).toBe("I was charged twice for my March invoice. Please refund the second charge.");
    expect(KNOWN_ANSWER.question.instructions).toBe("Which team should handle this ticket?");
    expect(KNOWN_ANSWER.question.choices.map((choice) => choice.value)).toEqual(["billing", "technical", "other"]);
    expect(KNOWN_ANSWER.expected).toBe("billing");
    expect(knownAnswerRequest("luna")).toEqual({ model: "luna", input: KNOWN_ANSWER.input, questions: [KNOWN_ANSWER.question] });
    expect(knownAnswerRequest()).not.toHaveProperty("model");
    expect(sampleDecision("luna")).toEqual(knownAnswerRequest("luna"));
  });

  test("reads the answer to its question: answered, refused, or missing", () => {
    expect(checkAnswer(response("technical", 0.62))).toEqual({ kind: "answered", value: "technical", probability: 0.62 });
    const refused = { ...response("billing", 1), answers: [{ type: "choice" as const, name: "department", refusal: "No." }] };
    expect(checkAnswer(refused)).toEqual({ kind: "refused", text: "No." });
    expect(checkAnswer(null)).toEqual({ kind: "missing" });
  });
});

describe("the verdict", () => {
  test("works when it gave the expected answer", () => {
    expect(verdictLine(answeredVerdict(checkAnswer(response("billing", 0.999))))).toBe(
      '✓ Works: it answered "billing" (100% sure), the expected answer.',
    );
  });

  test("answered, but not as expected, says what it answered and what was expected", () => {
    expect(verdictLine(answeredVerdict(checkAnswer(response("technical", 0.62))))).toBe(
      '⚠ It answered, but not as expected: "technical" (62% sure); expected "billing".',
    );
    expect(verdictLine(answeredVerdict({ kind: "refused", text: "I cannot say." }))).toBe(
      '⚠ It answered, but not as expected: it refused (I cannot say.); expected "billing".',
    );
    expect(answeredVerdict({ kind: "answered", value: "billing", probability: null }).text).toBe(
      'Works: it answered "billing", the expected answer.',
    );
  });

  test("failed gives the plain reason", () => {
    expect(verdictLine(failedVerdict("OPENROUTER_API_KEY is not set on the gateway host"))).toBe(
      "✗ Failed: OPENROUTER_API_KEY is not set on the gateway host",
    );
  });
});

describe("the model a provider test uses, as the console shows it", () => {
  const provider = (extra: Partial<Provider> = {}) => ({ id: "prv_or", test_model: null, model_hints: [], ...extra });

  const route = (alias: string, enabled: boolean, providerId: string, model: string): Route => ({
    id: `rte_${alias}`,
    alias,
    description: "",
    enabled,
    targets: [{ provider_id: providerId, model }],
    created_at: "",
    updated_at: "",
  });

  const catalog = [{ id: "morph/reflex" }, { id: "zeta", price_per_m_input: 0.02 }, { id: "alpha", price_per_m_input: 0.02 }];

  test("follows the gateway's order, each reason in turn", () => {
    const everything = provider({ test_model: "saved", model_hints: [{ id: "hinted" }] });
    const routes = [route("off", false, "prv_or", "disabled-one"), route("luna", true, "prv_or", "routed")];
    expect(chooseTestModel("asked", everything, routes, catalog)).toEqual({ model: "asked", reason: "requested", route: null });
    expect(chooseTestModel(undefined, everything, routes, catalog)).toEqual({ model: "routed", reason: "used_by_route", route: "luna" });
    expect(chooseTestModel(undefined, everything, [routes[0]!], catalog)).toEqual({
      model: "disabled-one",
      reason: "used_by_route",
      route: "off",
    });
    expect(chooseTestModel(undefined, everything, [], catalog)).toEqual({ model: "saved", reason: "provider_default", route: null });
    expect(chooseTestModel(undefined, provider({ model_hints: [{ id: "hinted" }] }), [], catalog).reason).toBe("hint");
    expect(chooseTestModel(undefined, provider(), [], catalog)).toEqual({ model: "alpha", reason: "cheapest", route: null });
    expect(listedTestModel([{ id: "local-7b" }])).toEqual({ model: "local-7b", reason: "first_listed", route: null });
    expect(listedTestModel([{ id: SERVER_CONFIGURED }])).toEqual({ model: SERVER_CONFIGURED, reason: "server_configured", route: null });
    expect(preferredTestModel(undefined, provider(), [])).toBeNull();
  });

  test("says why in words", () => {
    expect(reasonSentence("perplexity/pplx-decider-flash-v1.2", "used_by_route", "pplx-decider-flash-v1-2", "OpenRouter")).toBe(
      'Tested with perplexity/pplx-decider-flash-v1.2, the model your "pplx-decider-flash-v1-2" uses.',
    );
    expect(reasonSentence("alpha/cheap", "cheapest", null, "OpenRouter")).toBe(
      "Tested with alpha/cheap, the cheapest model in OpenRouter's catalog.",
    );
    expect(reasonSentence("x", "requested", null, "OpenRouter")).toBe("Tested with x, the model you picked.");
    expect(reasonSentence("perplexity/pplx-decider-flash-v1.2", "provider_default", null, "OpenRouter")).toBe(
      "Tested with perplexity/pplx-decider-flash-v1.2, the test model set for OpenRouter.",
    );
    expect(reasonSentence("jev-1.14", "hint", null, "typesafe")).toBe("Tested with jev-1.14, the first model suggested for typesafe.");
    expect(reasonSentence("local-7b", "first_listed", null, "vllm")).toBe("Tested with local-7b, the first model vllm lists.");
    expect(reasonSentence(SERVER_CONFIGURED, "server_configured", null, "llamacpp")).toBe(
      "Tested with server-configured, a placeholder: the server answers with the model it serves.",
    );
    expect(reasonHint("used_by_route", "luna", "OpenAI")).toBe('The model your "luna" uses.');
  });
});

describe("the result in plain words", () => {
  test("one meta line: who answered, the model, the time and the cost", () => {
    expect(answeredMeta(gateway(), titles)).toBe(
      "Answered by Baseten via OpenRouter · baseten/elephant-1-20261021 · 0.83 s · $0.0000044 billed by provider",
    );
    const fellBack = gateway({
      provider: "mock",
      upstream_model: "mock-1",
      served_by: "Mock",
      upstream_model_resolved: "mock-1",
      cost_usd: 0,
      attempts: [
        { provider: "openai", model: "gpt-6-luna", ok: false, latency_ms: 3, error: "OPENAI_API_KEY is not set on the gateway host" },
        { provider: "mock", model: "mock-1", ok: true, latency_ms: 20, error: null },
      ],
    });
    expect(answeredMeta(fellBack, titles)).toBe("Answered by Mock after OpenAI's key was missing · mock-1 · 0.83 s · $0 billed by provider");
    expect(costPhrase({ cost_usd: 0.0000095, cost_basis: "upstream_tokens" })).toBe("$0.0000095 at list price");
    expect(costPhrase({ cost_usd: 0.0000042, cost_basis: "estimated_tokens" })).toBe("$0.0000042, estimated");
    expect(costPhrase({ cost_usd: 0, cost_basis: "unpriced" })).toBe("unpriced");
    expect(costPhrase({ cost_usd: null, cost_basis: "unpriced" })).toBe("unpriced");
    expect(costPhrase({})).toBeNull();
    expect(formatSeconds(412)).toBe("0.41 s");
  });

  test("a failure's reason: the gateway's message for one attempt, the outcome sentence for several", () => {
    const missing: Attempt = {
      provider: "openrouter",
      model: "m",
      ok: false,
      latency_ms: 3,
      error: "OPENROUTER_API_KEY is not set on the gateway host",
    };
    expect(failureReason("OPENROUTER_API_KEY is not set on the gateway host", [missing], titles)).toBe(
      "OPENROUTER_API_KEY is not set on the gateway host",
    );
    const timeout: Attempt = { provider: "openai", model: "gpt-6-luna", ok: false, latency_ms: 8000, error: "timeout" };
    expect(failureReason("OPENROUTER_API_KEY is not set on the gateway host", [timeout, missing], titles)).toBe(
      "OpenAI timed out, OpenRouter key not set",
    );
    expect(failureReason("Route or provider not found", [], titles)).toBe("Route or provider not found");
  });

  test("a Models test reads its verdict from the decision", () => {
    const run: PlaygroundRun = { response: response("billing", 0.97), trace: { attempts: [], upstream_request: {}, upstream_response: {} } };
    expect(verdictLine(runOutcome(run, titles).verdict)).toBe('✓ Works: it answered "billing" (97% sure), the expected answer.');
    const missing: Attempt = {
      provider: "openrouter",
      model: "m",
      ok: false,
      latency_ms: 3,
      error: "OPENROUTER_API_KEY is not set on the gateway host",
    };
    const failed = runOutcome(failedRun([missing], "OPENROUTER_API_KEY is not set on the gateway host"), titles);
    expect(verdictLine(failed.verdict)).toBe("✗ Failed: OPENROUTER_API_KEY is not set on the gateway host");
    expect(failed.meta).toBeNull();
    expect(failed.attempts).toEqual([missing]);
  });

  test("a provider test uses the gateway's answer, or reads it from the decision on an older gateway", () => {
    const base = { ok: true, latency_ms: 830, model: "baseten/elephant-1" };
    expect(
      verdictLine(
        providerTestOutcome({
          ...base,
          expected: "billing",
          answer: "technical",
          probability: 0.62,
          matched: false,
          response: response("technical", 0.62),
        }).verdict,
      ),
    ).toBe('⚠ It answered, but not as expected: "technical" (62% sure); expected "billing".');
    expect(verdictLine(providerTestOutcome({ ...base, response: response("billing", 0.97) }).verdict)).toBe(
      '✓ Works: it answered "billing" (97% sure), the expected answer.',
    );
    expect(verdictLine(providerTestOutcome({ ok: false, latency_ms: 3, model: "m", error: "provider disabled" }).verdict)).toBe(
      "✗ Failed: provider disabled",
    );
  });

  test("a provider test's failure shows the upstream's message whole", () => {
    const text =
      "upstream HTTP 404: 0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. ZDR violation (account settings): 1 endpoint excluded; configurable at https://openrouter.ai/settings/privacy";
    expect(verdictLine(providerTestOutcome({ ok: false, latency_ms: 3, model: "m", error: text }).verdict)).toBe(`✗ Failed: ${text}`);
  });
});

describe("what the result component prints", () => {
  test("an unpriced answer offers a price, and the details keep the attempts and the trace", () => {
    const trace = {
      attempts: [{ provider: "vllm", model: "m", ok: true, latency_ms: 200, error: null }],
      upstream_request: {},
      upstream_response: {},
    };
    const unexpected = runOutcome({ response: response("technical", 0.62, { cost_basis: "unpriced", cost_usd: null }), trace }, titles);
    expect(verdictLine(unexpected.verdict)).toBe('⚠ It answered, but not as expected: "technical" (62% sure); expected "billing".');
    expect(unexpected.verdict.tone).toBe("warn");
    expect(unexpected.unpriced).toBe(true);
    expect(unexpected.meta).toBe("Answered by Baseten via OpenRouter · baseten/elephant-1-20261021 · 0.83 s · unpriced");
    expect(unexpected.trace).toBe(trace);
    expect(unexpected.attempts).toEqual(gateway().attempts);
    const failed = runOutcome(failedRun([], "Route or provider not found"), titles);
    expect(verdictLine(failed.verdict)).toBe("✗ Failed: Route or provider not found");
    expect(failed.verdict.tone).toBe("error");
  });
});

describe("the mock's provider test mirrors the gateway's", () => {
  test("it picks the model a model of yours sends the provider, and says it matched", async () => {
    const api = demo();
    const result = await api.testProvider("prv_openai");
    expect(result).toMatchObject({
      ok: true,
      model: "gpt-6-luna",
      model_reason: "used_by_route",
      model_route: "luna",
      expected: "billing",
      answer: "billing",
      matched: true,
    });
    expect(result.response?.gateway.provider).toBe("openai");
    const last = (await api.listProviders()).find((provider) => provider.id === "prv_openai")?.last_test;
    expect(last).toMatchObject({
      ok: true,
      model: "gpt-6-luna",
      model_reason: "used_by_route",
      matched: true,
      at: new Date(FIXED_NOW).toISOString(),
    });
  });

  test("one model gets the known-answer check wrong, so that result can be seen", async () => {
    const api = demo();
    expect(WRONG_ANSWER_MODEL).toBe("harbor-decide-7b-q4");
    expect(await api.testProvider("prv_vllm")).toMatchObject({
      ok: true,
      model: WRONG_ANSWER_MODEL,
      model_reason: "used_by_route",
      model_route: "triage",
      answer: "technical",
      probability: 0.62,
      matched: false,
    });
    const run = await api.runPlayground(knownAnswerRequest("triage"));
    expect(verdictLine(runOutcome(run).verdict)).toBe('⚠ It answered, but not as expected: "technical" (62% sure); expected "billing".');
  });

  test("a missing key fails with the gateway's plain reason, and is recorded unmatched", async () => {
    const api = demo();
    const result = await api.testProvider("prv_openrouter");
    expect(result).toMatchObject({ ok: false, error: "OPENROUTER_API_KEY is not set on the gateway host", matched: false, answer: null });
    expect(verdictLine(providerTestOutcome(result).verdict)).toBe("✗ Failed: OPENROUTER_API_KEY is not set on the gateway host");
    const run = await api.runPlayground(knownAnswerRequest("elephant"));
    expect(verdictLine(runOutcome(run).verdict)).toBe("✗ Failed: OPENROUTER_API_KEY is not set on the gateway host");
  });

  test("a hinted provider without a route or test model uses its first hint; a pick is a request", async () => {
    const api = demo();
    expect(await api.testProvider("prv_typesafe")).toMatchObject({ model: "jev-1.14", model_reason: "hint", matched: true });
    expect(await api.testProvider("prv_typesafe", "jev-1.13")).toMatchObject({
      model: "jev-1.13",
      model_reason: "requested",
      model_route: null,
    });
    const refused = await api.testProvider("prv_typesafe", " ").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
  });

  test("a provider keeps its test model, a test uses it, and null clears it", async () => {
    const api = demo();
    const created = await api.createProvider({
      name: "router",
      kind: "openrouter",
      base_url: "https://openrouter.ai",
      path: "/api/alpha/decisions",
      wire: "map",
      enabled: true,
      timeout_ms: 20000,
      limits: { max_questions: 400, max_choices: 64 },
      extra_body: {},
      key: { source: "env", env_var: "OPENAI_API_KEY" },
      model_hints: [],
      test_model: "perplexity/pplx-decider-flash-v1.2",
    });
    expect(created.test_model).toBe("perplexity/pplx-decider-flash-v1.2");
    expect(await api.testProvider(created.id)).toMatchObject({ model: "perplexity/pplx-decider-flash-v1.2", model_reason: "provider_default" });
    const cleared = await api.updateProvider(created.id, { test_model: null });
    expect(cleared.test_model).toBeNull();
    expect(await api.testProvider(created.id)).toMatchObject({ model_reason: "cheapest" });
    const refused = await api.updateProvider(created.id, { test_model: "" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
  });

  test("the built-in mock answers the check as the gateway's mock does", async () => {
    const result = await demo().testProvider("prv_mock");
    expect(result).toMatchObject({
      model: "mock-1",
      model_reason: "used_by_route",
      model_route: "default",
      answer: "billing",
      probability: 0.96,
    });
  });
});
