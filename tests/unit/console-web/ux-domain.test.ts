import { describe, expect, test } from "bun:test";
import { hrefFor, legacyRedirect, parseHash, SCREENS, SCREEN_LABELS } from "../../../src/modules/gateway/apps/console-web/src/domain/navigation";
import {
  connectionStatus,
  connectionTitle,
  keySummary,
  lastTestSummary,
  modelsUsing,
  replaceKeyLabel,
  sortConnections,
  suggestedEnvVar,
  titleLookup,
} from "../../../src/modules/gateway/apps/console-web/src/domain/connections";
import { chainSentence, routeChain, stepRole } from "../../../src/modules/gateway/apps/console-web/src/domain/chain";
import { findModel, modelRows, modelTally, modelVerdict } from "../../../src/modules/gateway/apps/console-web/src/domain/models";
import { checklistState, realConnections, realModels } from "../../../src/modules/gateway/apps/console-web/src/domain/checklist";
import { answeredBy, answeredByLine, attemptReason, outcomeSentence } from "../../../src/modules/gateway/apps/console-web/src/domain/outcome";
import { searchCatalog, slugify, suggestModelName, validateModelName } from "../../../src/modules/gateway/apps/console-web/src/domain/catalog";
import {
  ADD_MODEL_STEPS,
  addModelIssue,
  directTestRequest,
  emptyAddModel,
  furthestStep,
  newStep,
  pickPrimaryUpstream,
  pickUpstream,
  routeFromAddModel,
  stepFromTarget,
  targetFromStep,
  typePrice,
  validateStep,
} from "../../../src/modules/gateway/apps/console-web/src/domain/model-draft";
import { connectionDraft, validateConnection, withKind } from "../../../src/modules/gateway/apps/console-web/src/domain/connection-form";
import { mockMode } from "../../../src/modules/gateway/apps/console-web/src/app/mode";
import type { Provider, ProviderModel, Route } from "../../../src/modules/gateway/apps/console-web/src/api/types";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

function provider(id: string, name: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name,
    kind: "openai",
    base_url: "https://example.test",
    path: "/decisions",
    wire: "openai",
    enabled: true,
    timeout_ms: 20000,
    limits: { max_questions: 400, max_choices: 64 },
    extra_body: {},
    key: { source: "env", env_var: "OPENAI_API_KEY", present: true },
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function route(id: string, alias: string, targets: Route["targets"], enabled = true): Route {
  return { id, alias, description: "", enabled, targets, created_at: "", updated_at: "" };
}

const mock = provider("prv_mock", "mock", { kind: "mock", key: { source: "none" } });
const openai = provider("prv_openai", "openai");
const openaiMissing = provider("prv_openai", "openai", { key: { source: "env", env_var: "OPENAI_API_KEY", present: false } });
const openrouter = provider("prv_or", "openrouter", { kind: "openrouter", key: { source: "env", env_var: "OPENROUTER_API_KEY", present: false } });
const local = provider("prv_local", "local-llm", { kind: "openai-compatible", key: { source: "none" }, enabled: false });

describe("navigation", () => {
  test("seven screens in task order, with the console's own words", () => {
    expect([...SCREENS]).toEqual(["overview", "models", "providers", "try", "requests", "keys", "settings"]);
    expect(SCREENS.map((screen) => SCREEN_LABELS[screen])).toEqual(["Overview", "Models", "Providers", "Try it", "Requests", "Keys", "Settings"]);
  });

  test("a hash names a screen, an optional parameter and a query; anything unknown opens Overview", () => {
    expect(parseHash("#/models/rte_1")).toMatchObject({ screen: "models", param: "rte_1" });
    expect(parseHash("#/models/new?connection=prv_1").query.get("connection")).toBe("prv_1");
    expect(parseHash("#/try?model=luna").query.get("model")).toBe("luna");
    expect(parseHash("#/nowhere").screen).toBe("overview");
    expect(parseHash("").screen).toBe("overview");
  });

  test("old links redirect to the screens that replaced them, keeping the rest of the path and the query", () => {
    expect(legacyRedirect("#/routes")).toBe("#/models");
    expect(legacyRedirect("#/routes/rte_luna")).toBe("#/models/rte_luna");
    expect(legacyRedirect("#/connections")).toBe("#/providers");
    expect(legacyRedirect("#/connections/prv_1?from=old&tag=a%2Fb")).toBe("#/providers/prv_1?from=old&tag=a%2Fb");
    expect(legacyRedirect("#/connections/prv%2F1/deeper?tag=one&tag=two&next=a?b")).toBe(
      "#/providers/prv%2F1/deeper?tag=one&tag=two&next=a?b",
    );
    expect(legacyRedirect("#/providers")).toBeNull();
    expect(legacyRedirect("#/providers/prv_1?from=old")).toBeNull();
    expect(legacyRedirect("#/playground?model=luna")).toBe("#/try?model=luna");
    expect(legacyRedirect("#/logs")).toBe("#/requests");
    expect(legacyRedirect("#/models")).toBeNull();
    expect(legacyRedirect("")).toBeNull();
    expect(parseHash("#/connections/prv_1?from=old")).toMatchObject({ screen: "providers", param: "prv_1" });
    expect(parseHash("#/connections/prv_1?from=old").query.get("from")).toBe("old");
    expect(parseHash("#/providers/prv_1")).toMatchObject({ screen: "providers", param: "prv_1" });
  });

  test("links leave out empty query values and encode parameters", () => {
    expect(hrefFor("models", "new", { connection: "prv_1", upstream: undefined })).toBe("#/models/new?connection=prv_1");
    expect(hrefFor("try", null, { model: "" })).toBe("#/try");
    expect(hrefFor("models", "a/b")).toBe("#/models/a%2Fb");
  });
});

describe("connections", () => {
  test("connected, needs a key, or disabled; a kind that needs no key is connected without one", () => {
    expect(connectionStatus(openai)).toBe("connected");
    expect(connectionStatus(openaiMissing)).toBe("needs-key");
    expect(connectionStatus({ ...openai, key: { source: "none" } })).toBe("needs-key");
    expect(connectionStatus({ ...openai, key: { source: "stored", last4: "a1b2" } })).toBe("connected");
    expect(connectionStatus({ ...local, enabled: true })).toBe("connected");
    expect(connectionStatus(local)).toBe("disabled");
    expect(connectionStatus(mock)).toBe("connected");
  });

  test("the field that replaces a stored key names its last four characters only when the gateway shows them", () => {
    expect(replaceKeyLabel("a1b2")).toBe("Replace the stored key (ends …a1b2)");
    expect(replaceKeyLabel(null)).toBe("Replace the stored key");
  });

  test("seeded names read as their brand; names the owner chose are kept", () => {
    expect(connectionTitle("openai", "openai")).toBe("OpenAI");
    expect(connectionTitle("openrouter", null)).toBe("OpenRouter");
    expect(connectionTitle("openrouter-backup", "openrouter")).toBe("openrouter-backup");
    const titleOf = titleLookup([openai, local]);
    expect(titleOf("openai")).toBe("OpenAI");
    expect(titleOf("local-llm")).toBe("local-llm");
    expect(titleOf("mock")).toBe("Mock");
  });

  test("the key and the last test in one line each", () => {
    expect(keySummary(openai)).toBe("OPENAI_API_KEY is set on the gateway host");
    expect(keySummary(openaiMissing)).toBe("OPENAI_API_KEY is not set on the gateway host");
    expect(keySummary({ ...openai, key: { source: "stored", last4: "a1b2" } })).toBe("Stored key ending …a1b2");
    // The gateway shows none of a key under 12 characters.
    expect(keySummary({ ...openai, key: { source: "stored", last4: null } })).toBe("Stored key");
    expect(keySummary(mock)).toBe("No key needed");
    expect(keySummary({ ...openai, key: { source: "none" } })).toBe("No key yet");
    expect(lastTestSummary(null, NOW)).toEqual({ status: null, mark: null, text: "Not tested yet" });
    const at = new Date(NOW - 2 * 60_000).toISOString();
    const passed = { ok: true, at, latency_ms: 312, model: "m", error: null, model_reason: "used_by_route" as const };
    expect(lastTestSummary({ ...passed, matched: true }, NOW)).toEqual({ status: "ok", mark: "✓", text: "answered as expected · 2 min ago" });
    expect(lastTestSummary({ ...passed, matched: false }, NOW)).toEqual({
      status: "degraded",
      mark: "⚠",
      text: "answered, but not as expected · 2 min ago",
    });
    // A test recorded before the gateway said whether it matched.
    const older = new Date(NOW - 3 * 3_600_000).toISOString();
    expect(lastTestSummary({ ok: true, at: older, latency_ms: 312, model: "m", error: null }, NOW)).toEqual({
      status: "ok",
      mark: "✓",
      text: "answered in 312 ms · 3 h ago",
    });
    expect(
      lastTestSummary({ ok: false, at: older, latency_ms: 3, model: "m", error: "OPENAI_API_KEY is not set", matched: false }, NOW),
    ).toEqual({
      status: "failing",
      mark: "✗",
      text: "failed: OPENAI_API_KEY is not set · 3 h ago",
    });
  });

  test("helpers for the key flow and the cards", () => {
    expect(suggestedEnvVar(openrouter)).toBe("OPENROUTER_API_KEY");
    expect(suggestedEnvVar({ ...local, key: { source: "none" } })).toBe("LOCAL_LLM_API_KEY");
    const routes = [route("r1", "luna", [{ provider_id: "prv_openai", model: "gpt-6-luna" }]), route("r2", "x", [{ provider_id: "prv_mock", model: "m" }])];
    expect(modelsUsing("prv_openai", routes).map((r) => r.alias)).toEqual(["luna"]);
    expect(sortConnections([local, openrouter, openai]).map((p) => p.name)).toEqual(["openai", "openrouter", "local-llm"]);
  });
});

describe("a model's chain and status", () => {
  const providers = [mock, openai, openrouter, local];
  const luna = route("r_luna", "luna", [
    { provider_id: "prv_openai", model: "gpt-6-luna" },
    { provider_id: "prv_or", model: "openai/gpt-6-luna-decisions" },
  ]);

  test("the chain as a sentence, by connection title, and each step's role", () => {
    expect(chainSentence(routeChain(luna.targets, providers))).toBe("OpenAI gpt-6-luna → then OpenRouter openai/gpt-6-luna-decisions");
    expect(chainSentence([])).toContain("No steps yet");
    expect(stepRole(1)).toBe("Try first");
    expect(stepRole(2)).toBe("If that fails, then");
  });

  test("ready, partly ready, can't answer, or off, from the steps' connections", () => {
    expect(modelVerdict(route("a", "a", [{ provider_id: "prv_openai", model: "m" }]), providers)).toMatchObject({ state: "ready", word: "Ready" });
    expect(modelVerdict(luna, providers)).toMatchObject({ state: "partial", status: "degraded", word: "Fallback needs a key" });
    expect(modelVerdict(route("b", "b", [{ provider_id: "prv_or", model: "m" }, { provider_id: "prv_openai", model: "m" }]), providers)).toMatchObject({
      word: "First step needs a key",
    });
    const broken = modelVerdict(route("c", "c", [{ provider_id: "prv_or", model: "m" }, { provider_id: "prv_local", model: "m" }]), providers);
    expect(broken).toMatchObject({ state: "broken", status: "failing", word: "Can't answer" });
    expect(broken.reason).toBe("Every step is skipped: OpenRouter needs a key, local-llm is disabled.");
    expect(modelVerdict(route("d", "d", []), providers)).toMatchObject({ state: "broken", word: "No steps" });
    expect(modelVerdict(route("e", "e", [{ provider_id: "prv_gone", model: "m" }]), providers).state).toBe("broken");
    expect(modelVerdict({ ...luna, enabled: false }, providers)).toMatchObject({ state: "off", status: "disabled" });
  });

  test("the tally and the rows the Models page shows", () => {
    const routes = [luna, route("r_def", "default", [{ provider_id: "prv_mock", model: "mock-1" }]), route("r_off", "off", [], false)];
    expect(modelTally(routes, providers)).toEqual({ ready: 1, attention: 1, off: 1 });
    const rows = modelRows(routes, providers, [{ route: "luna", requests: 200, errors: 2, p50_ms: 300, cost_usd: 0.0123 }]);
    expect(rows[0]).toMatchObject({ name: "luna", ink: 0, requests: 200, errorRate: 0.01, p50: 300, cost: 0.0123 });
    expect(rows[1]).toMatchObject({ requests: 0, cost: 0, pricing: { pricing: "free", unpricedStep: null } });
    expect(findModel(routes, "luna")?.id).toBe("r_luna");
    expect(findModel(routes, "r_def")?.alias).toBe("default");
  });
});

describe("the first-run checklist", () => {
  const seeded = [
    route("r_def", "default", [{ provider_id: "prv_mock", model: "mock-1" }]),
    route("r_luna", "luna", [{ provider_id: "prv_openai", model: "gpt-6-luna" }]),
  ];

  test("a first run has nothing done and points at connecting a provider; the mock does not count", () => {
    const state = checklistState({ providers: [mock, openaiMissing, openrouter], routes: seeded, answeredModels: new Set(["default"]), dismissed: false });
    expect(state.steps.map((step) => step.done)).toEqual([false, false, false]);
    expect(state).toMatchObject({ visible: true, current: "connect", connection: null, model: null });
    expect(realConnections([mock, openaiMissing])).toEqual([]);
  });

  test("a key on a seeded provider completes the first two steps at once, because a seeded model already uses it", () => {
    const state = checklistState({ providers: [mock, openai], routes: seeded, answeredModels: new Set(), dismissed: false });
    expect(state.steps.map((step) => step.done)).toEqual([true, true, false]);
    expect(state.current).toBe("test");
    expect(state.connection?.id).toBe("prv_openai");
    expect(state.model?.alias).toBe("luna");
  });

  test("an answered request on that model, or a passing test of its connection, finishes it and hides the list", () => {
    expect(checklistState({ providers: [mock, openai], routes: seeded, answeredModels: new Set(["luna"]), dismissed: false })).toMatchObject({
      complete: true,
      visible: false,
      current: null,
    });
    const tested = { ...openai, last_test: { ok: true, at: "", latency_ms: 300, model: "gpt-6-luna", error: null } };
    expect(checklistState({ providers: [mock, tested], routes: seeded, answeredModels: new Set(), dismissed: false }).complete).toBe(true);
    const failed = { ...openai, last_test: { ok: false, at: "", latency_ms: 3, model: "m", error: "x" } };
    expect(checklistState({ providers: [mock, failed], routes: seeded, answeredModels: new Set(), dismissed: false }).complete).toBe(false);
  });

  test("a disabled model does not count, and dismissing hides the list without completing it", () => {
    const disabled = [route("r_luna", "luna", [{ provider_id: "prv_openai", model: "m" }], false)];
    expect(realModels(disabled, [openai])).toEqual([]);
    const state = checklistState({ providers: [openai], routes: disabled, answeredModels: new Set(), dismissed: true });
    expect(state).toMatchObject({ complete: false, visible: false, current: "model" });
  });
});

describe("outcome sentences", () => {
  const titleOf = titleLookup([mock, openai, openrouter]);

  test("answered first time, and answered after a fallback, with the reason in words", () => {
    expect(outcomeSentence({ status: "ok", provider: "openai", error: null, attempts: [{ provider: "openai", model: "m", ok: true, latency_ms: 300 }] }, titleOf)).toBe(
      "Answered by OpenAI",
    );
    expect(
      outcomeSentence(
        {
          status: "ok",
          provider: "mock",
          error: null,
          attempts: [
            { provider: "openrouter", model: "m", ok: false, latency_ms: 3, error: "OPENROUTER_API_KEY is not set on the gateway host" },
            { provider: "mock", model: "mock-1", ok: true, latency_ms: 20 },
          ],
        },
        titleOf,
      ),
    ).toBe("Answered by Mock after OpenRouter's key was missing");
    expect(
      outcomeSentence(
        {
          status: "ok",
          provider: "mock",
          error: null,
          attempts: [
            { provider: "openai", model: "m", ok: false, latency_ms: 8000, error: "timeout" },
            { provider: "openrouter", model: "m", ok: false, latency_ms: 2, error: "provider disabled" },
            { provider: "mock", model: "mock-1", ok: true, latency_ms: 20 },
          ],
        },
        titleOf,
      ),
    ).toBe("Answered by Mock after OpenAI timed out and OpenRouter was disabled");
  });

  test("failures list every attempt's reason, or the error when nothing was tried", () => {
    expect(
      outcomeSentence(
        {
          status: "error",
          provider: "openrouter",
          error: "No usable provider",
          attempts: [
            { provider: "openai", model: "m", ok: false, latency_ms: 3, error: "OPENAI_API_KEY is not set on the gateway host" },
            { provider: "openrouter", model: "m", ok: false, latency_ms: 3, error: "OPENROUTER_API_KEY is not set" },
          ],
        },
        titleOf,
      ),
    ).toBe("Failed: OpenAI key not set, OpenRouter key not set");
    expect(outcomeSentence({ status: "error", provider: "", error: 'No enabled route named "x".', attempts: [] }, titleOf)).toBe(
      'Failed: No enabled route named "x".',
    );
  });

  test("an upstream that names who served it is named, with the model it resolved", () => {
    const routed = {
      status: "ok" as const,
      provider: "openrouter",
      error: null,
      attempts: [{ provider: "openrouter", model: "perplexity/pplx-decider-flash-v1.2", ok: true, latency_ms: 400 }],
      served_by: "Perplexity",
      upstream_model_resolved: "perplexity/pplx-decider-flash-v1.2-20261016",
    };
    expect(outcomeSentence(routed, titleOf)).toBe("Answered by Perplexity via OpenRouter · perplexity/pplx-decider-flash-v1.2-20261016");
    expect(
      outcomeSentence(
        {
          ...routed,
          attempts: [{ provider: "openai", model: "gpt-6-luna", ok: false, latency_ms: 8000, error: "timeout" }, ...routed.attempts],
        },
        titleOf,
      ),
    ).toBe("Answered by Perplexity via OpenRouter after OpenAI timed out · perplexity/pplx-decider-flash-v1.2-20261016");
    // The mock names itself: said once, with its model.
    expect(
      outcomeSentence(
        {
          status: "ok",
          provider: "mock",
          error: null,
          attempts: [{ provider: "mock", model: "mock-1", ok: true, latency_ms: 20 }],
          served_by: "Mock",
          upstream_model_resolved: "mock-1",
        },
        titleOf,
      ),
    ).toBe("Answered by Mock · mock-1");
    // Without served_by, or from a gateway that predates it, the sentence is as before, even with a resolved model.
    expect(outcomeSentence({ ...routed, served_by: null }, titleOf)).toBe("Answered by OpenRouter");
    expect(outcomeSentence({ ...routed, served_by: undefined, upstream_model_resolved: undefined }, titleOf)).toBe("Answered by OpenRouter");
    // A failure says nothing about who served.
    expect(outcomeSentence({ ...routed, status: "error", error: "boom", attempts: [] }, titleOf)).toBe("Failed: boom");
  });

  test("the answering side as one line, for details", () => {
    expect(answeredBy("OpenRouter", "Baseten")).toBe("Baseten via OpenRouter");
    expect(answeredBy("Mock", "mock")).toBe("Mock");
    expect(answeredBy("OpenRouter", "  ")).toBe("OpenRouter");
    expect(
      answeredByLine(
        {
          provider: "openrouter",
          upstream_model: "baseten/elephant-1",
          served_by: "Baseten",
          upstream_model_resolved: "baseten/elephant-1-20261016",
        },
        titleOf,
      ),
    ).toBe("Baseten via OpenRouter · baseten/elephant-1-20261016");
    expect(
      answeredByLine({ provider: "openai", upstream_model: "gpt-6-luna", served_by: null, upstream_model_resolved: "gpt-6-luna" }, titleOf),
    ).toBe("OpenAI · gpt-6-luna");
    expect(answeredByLine({ provider: "openrouter", upstream_model: "x/y", served_by: "X" }, titleOf)).toBe("X via OpenRouter");
  });

  test("each known gateway error has words; anything else is quoted as it came", () => {
    expect(attemptReason("upstream returned 503", "OpenAI").short).toBe("OpenAI returned 503");
    expect(attemptReason("provider not found", "X").clause).toBe("X no longer existed");
    expect(attemptReason("provider limits exceeded", "X").short).toBe("over X's limits");
    expect(attemptReason("stored key cannot be decrypted (check GATEWAY_SECRET)", "X").short).toBe("X key unreadable");
    expect(attemptReason("schema mismatch", "X")).toEqual({ clause: "X failed (schema mismatch)", short: "X: schema mismatch" });
    expect(attemptReason(null, "X").short).toBe("X failed");
  });

  test("an upstream HTTP error keeps the upstream's message whole, and reads no words in it", () => {
    const message =
      "0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons): ZDR violation (account settings): 1 endpoint excluded; configurable at https://openrouter.ai/settings/privacy";
    const text = `upstream HTTP 404: ${message}`;
    expect(attemptReason(text, "OpenRouter")).toEqual({
      clause: `OpenRouter returned 404 (${message})`,
      short: `OpenRouter returned 404: ${message}`,
    });
    expect(attemptReason("upstream HTTP 404", "OpenRouter")).toEqual({
      clause: "OpenRouter returned 404",
      short: "OpenRouter returned 404",
    });
    // Words the gateway's own errors use, inside the upstream's message, do not change the reason.
    expect(
      attemptReason("upstream HTTP 502: Provider returned 503, the request timed out, and no key is set", "OpenAI").short,
    ).toBe("OpenAI returned 502: Provider returned 503, the request timed out, and no key is set");
    expect(
      outcomeSentence(
        { status: "error", provider: "openrouter", error: text, attempts: [{ provider: "openrouter", model: "m", ok: false, latency_ms: 3, error: text }] },
        titleOf,
      ),
    ).toBe(`Failed: OpenRouter returned 404: ${message}`);
    expect(
      outcomeSentence(
        {
          status: "ok",
          provider: "mock",
          error: null,
          attempts: [
            { provider: "openrouter", model: "m", ok: false, latency_ms: 3, error: text },
            { provider: "mock", model: "mock-1", ok: true, latency_ms: 4 },
          ],
        },
        titleOf,
      ),
    ).toBe(`Answered by Mock after OpenRouter returned 404 (${message})`);
  });
});

describe("the upstream catalog", () => {
  const catalog: ProviderModel[] = [
    { id: "openai/gpt-6-luna-decisions", description: "Luna", price_per_m_input: 0.4, context: 128000 },
    { id: "baseten/elephant-1", price_per_m_input: 0.9, context: 64000 },
    { id: "acme/harbor-decide-7b", description: "Small decision model", price_per_m_input: 0.05, context: 32000 },
    { id: "acme/mystery" },
  ];

  test("search ranks exact and prefix matches first, then parts, then descriptions", () => {
    expect(searchCatalog(catalog, "elephant").map((m) => m.id)).toEqual(["baseten/elephant-1"]);
    expect(searchCatalog(catalog, "acme").map((m) => m.id)).toEqual(["acme/harbor-decide-7b", "acme/mystery"]);
    expect(searchCatalog(catalog, "decision").map((m) => m.id)).toEqual(["openai/gpt-6-luna-decisions", "acme/harbor-decide-7b"]);
    expect(searchCatalog(catalog, "zzz")).toEqual([]);
  });

  test("orders by name, cheapest first, or longest context first, unknowns last", () => {
    expect(searchCatalog(catalog, "", "name").map((m) => m.id)[0]).toBe("acme/harbor-decide-7b");
    expect(searchCatalog(catalog, "", "price").map((m) => m.id)).toEqual([
      "acme/harbor-decide-7b",
      "openai/gpt-6-luna-decisions",
      "baseten/elephant-1",
      "acme/mystery",
    ]);
    expect(searchCatalog(catalog, "", "context").map((m) => m.id)[0]).toBe("openai/gpt-6-luna-decisions");
    expect(searchCatalog(catalog, "", "context").map((m) => m.id)[3]).toBe("acme/mystery");
  });

  test("a pick suggests a unique slug of its id, and names are validated live", () => {
    expect(slugify("openai/gpt-6-luna-decisions")).toBe("gpt-6-luna-decisions");
    expect(slugify("Vendor/Model_V2.1")).toBe("model-v2-1");
    expect(suggestModelName("baseten/elephant-1", ["elephant-1"])).toBe("elephant-1-2");
    expect(suggestModelName("baseten/elephant-1", [])).toBe("elephant-1");
    expect(validateModelName("", [])).toContain("Give the model a name");
    expect(validateModelName("Luna", [])).toContain("lowercase");
    expect(validateModelName("luna", ["luna"])).toContain("already exists");
    expect(validateModelName("luna", ["luna"], "luna")).toBeNull();
    expect(validateModelName("triage-fast", ["luna"])).toBeNull();
  });
});

describe("model step drafts and the Add model flow", () => {
  test("a step validates its connection, model, price and timeout, and becomes a target", () => {
    expect(validateStep(newStep())).toMatchObject({ provider: "Choose a provider." });
    const issues = validateStep({ ...newStep("p", "m"), price: "-2", timeoutMs: "50" });
    expect(issues.price).toContain("zero or more");
    expect(issues.timeout).toContain("100 to 600000");
    expect(targetFromStep({ ...newStep("p", " m "), price: "0.4", timeoutMs: "8000" })).toEqual({
      provider_id: "p",
      model: "m",
      timeout_ms: 8000,
      price_per_m_input: 0.4,
    });
    expect(targetFromStep(newStep("p", "m"))).toEqual({ provider_id: "p", model: "m" });
    expect(stepFromTarget({ provider_id: "p", model: "m", price_per_m_input: 0.035, timeout_ms: 9000 })).toMatchObject({ price: "0.035", timeoutMs: "9000" });
  });

  test("a catalog pick fills the price, follows later picks, and never overwrites a typed price", () => {
    const picked = pickUpstream(newStep("p"), "a", 0.4);
    expect(picked).toMatchObject({ model: "a", price: "0.4", priceFromCatalog: true });
    expect(pickUpstream(picked, "b", 0.9)).toMatchObject({ model: "b", price: "0.9" });
    expect(pickUpstream(picked, "c", undefined)).toMatchObject({ price: "", priceFromCatalog: false });
    const typed = typePrice(picked, "0.3");
    expect(pickUpstream(typed, "b", 0.9)).toMatchObject({ model: "b", price: "0.3", priceFromCatalog: false });
  });

  test("each flow step blocks the next until it is finished, and the name follows the pick until edited", () => {
    let draft = emptyAddModel();
    expect(ADD_MODEL_STEPS[0].label).toBe("Choose a provider");
    expect(addModelIssue("connection", draft, [])).toBe("Choose a provider.");
    expect(furthestStep(draft, [])).toBe(0);
    draft = emptyAddModel("prv_or");
    expect(furthestStep(draft, [])).toBe(1);
    draft = pickPrimaryUpstream(draft, "baseten/elephant-1", 0.9, ["elephant-1"]);
    expect(draft.name).toBe("elephant-1-2");
    expect(draft.steps[0]?.price).toBe("0.9");
    expect(furthestStep(draft, ["elephant-1"])).toBe(5);
    const renamed = pickPrimaryUpstream({ ...draft, name: "mine", nameEdited: true }, "acme/harbor-decide-7b", 0.05, []);
    expect(renamed.name).toBe("mine");
    const withBadFallback = { ...draft, steps: [...draft.steps, newStep("prv_mock")] };
    expect(addModelIssue("fallback", withBadFallback, [])).toContain("Fallback 1:");
    expect(furthestStep(withBadFallback, ["elephant-1"])).toBe(3);
  });

  test("the route body carries every step in order with its catalog price, and unsaved steps are tested directly", () => {
    const draft = pickPrimaryUpstream(emptyAddModel("prv_or"), "baseten/elephant-1", 0.9, []);
    const body = routeFromAddModel({ ...draft, steps: [...draft.steps, newStep("prv_mock", "mock-1")], description: " Elephant " });
    expect(body).toEqual({
      alias: "elephant-1",
      description: "Elephant",
      enabled: true,
      targets: [
        { provider_id: "prv_or", model: "baseten/elephant-1", price_per_m_input: 0.9 },
        { provider_id: "prv_mock", model: "mock-1" },
      ],
    });
    expect(directTestRequest(newStep("prv_or", "baseten/elephant-1"), [openrouter])?.model).toBe("openrouter::baseten/elephant-1");
    expect(directTestRequest(newStep("prv_or", ""), [openrouter])).toBeNull();
  });
});

describe("the provider form", () => {
  test("a new connection starts as an OpenAI-compatible server with no key", () => {
    const draft = connectionDraft(null);
    expect(draft).toMatchObject({ kind: "openai-compatible", wire: "openai", keyMode: "none", path: "/decisions" });
    expect(withKind(draft, "openrouter")).toMatchObject({ kind: "openrouter", wire: "map", keyMode: "env", envVar: "OPENROUTER_API_KEY" });
  });

  test("validation ties each problem to its field and builds the body when there are none", () => {
    const bad = validateConnection({ ...connectionDraft(null), name: "Local LLM", baseUrl: "nope", extraBody: "[1]" }, null);
    expect(bad.write).toBeNull();
    expect(Object.keys(bad.errors).sort()).toEqual(["baseUrl", "extraBody", "name"]);
    const good = validateConnection({ ...connectionDraft(null), name: "local-llm" }, null);
    expect(good.write).toMatchObject({ name: "local-llm", kind: "openai-compatible", key: { source: "none" } });
    const stored = { ...openai, key: { source: "stored" as const, last4: "a1b2" } };
    expect(validateConnection({ ...connectionDraft(stored), secret: "" }, stored).write).not.toBeNull();
    expect(validateConnection({ ...connectionDraft(null), name: "x", keyMode: "stored" }, null).errors.secret).toBeDefined();
  });
});

describe("mock mode", () => {
  test("?mock=1 serves the demo, ?mock=fresh a first run, nosecret refuses stored keys and nocatalog fails the model lists", () => {
    expect(mockMode("?mock=1", undefined)).toEqual({ scenario: "demo", storesKeys: true, listsModels: true });
    expect(mockMode("?mock=fresh", undefined)).toEqual({ scenario: "fresh", storesKeys: true, listsModels: true });
    expect(mockMode("?mock=fresh&nosecret=1", undefined)).toEqual({ scenario: "fresh", storesKeys: false, listsModels: true });
    expect(mockMode("?mock=1&nocatalog=1", undefined)).toEqual({ scenario: "demo", storesKeys: true, listsModels: false });
    expect(mockMode("", "1")).toEqual({ scenario: "demo", storesKeys: true, listsModels: true });
    expect(mockMode("", undefined)).toBeNull();
  });
});
