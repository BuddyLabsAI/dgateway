// The mock serves the API reference fields, so every cost screen works before the backend lands.

import { describe, expect, test } from "bun:test";
import { createMockApi } from "../../../src/modules/gateway/apps/console-web/src/api/mock/mock-api";
import { estimateTokens, mockBilled, mockCost, mockSelf } from "../../../src/modules/gateway/apps/console-web/src/api/mock/fixtures";
import { ApiError } from "../../../src/modules/gateway/apps/console-web/src/api/errors";
import { sampleDecision } from "../../../src/modules/gateway/apps/console-web/src/domain/playground";
import { checklistState } from "../../../src/modules/gateway/apps/console-web/src/domain/checklist";

const FIXED_NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

const noWait = async () => {};

function demo() {
  return createMockApi({ now: () => FIXED_NOW, delay: noWait, seed: 7 });
}

function fresh(storesKeys = true) {
  return createMockApi({ now: () => FIXED_NOW, delay: noWait, seed: 7, scenario: "fresh", storesKeys });
}

describe("mock cost model", () => {
  test("prices resolve as the contract says: step price, then kind default, else unpriced", () => {
    expect(mockCost("openai", "gpt-6-luna", null, 100, 50)).toEqual({ cost_usd: 0.00001, cost_basis: "upstream_tokens", tokens: 100 });
    expect(mockCost("openai", "gpt-6-luna", null, null, 50)).toEqual({ cost_usd: 0.000005, cost_basis: "estimated_tokens", tokens: 50 });
    expect(mockCost("mock", "mock-1", null, null, 40)).toEqual({ cost_usd: 0, cost_basis: "upstream_cost", tokens: 40 });
    expect(mockCost("openai-compatible", "x", null, 80, 40)).toEqual({ cost_usd: null, cost_basis: "unpriced", tokens: 80 });
    expect(mockCost("openai-compatible", "x", 0.035, 120, 40)).toEqual({ cost_usd: 0.0000042, cost_basis: "upstream_tokens", tokens: 120 });
    expect(mockCost("openrouter", "baseten/elephant-1", null, 100, 40).cost_basis).toBe("upstream_tokens");
  });

  test("a cost the upstream billed wins over every price, as the gateway's upstream_cost basis does", () => {
    expect(mockCost("openrouter", "baseten/elephant-1", 5, 100, 40, 0.00009)).toEqual({
      cost_usd: 0.00009,
      cost_basis: "upstream_cost",
      tokens: 100,
    });
    expect(mockCost("mock", "mock-1", null, 40, 40, 0)).toEqual({ cost_usd: 0, cost_basis: "upstream_cost", tokens: 40 });
    // OpenRouter bills its catalog price, the mock bills 0, and the others bill nothing the gateway can read.
    expect(mockBilled("openrouter", "baseten/elephant-1", 100)).toBe(0.00009);
    expect(mockBilled("mock", "mock-1", 100)).toBe(0);
    expect(mockBilled("openai", "gpt-6-luna", 100)).toBeNull();
    expect(mockBilled({ kind: "systemone", base_url: "https://api.typesafe.ai" }, "jev-1.14", 100)).toBeNull();
  });

  test("who served an answer, as each kind of upstream says it", () => {
    expect(mockSelf("openrouter", "baseten/elephant-1")).toEqual({
      servedBy: "Baseten",
      resolvedModel: "baseten/elephant-1-20261016",
      bills: true,
    });
    expect(mockSelf("openrouter", "acme/harbor-decide-7b").servedBy).toBe("Acme");
    expect(mockSelf("mock", "mock-1")).toEqual({ servedBy: "Mock", resolvedModel: "mock-1", bills: true });
    expect(mockSelf("openai", "gpt-6-luna")).toEqual({ servedBy: null, resolvedModel: "gpt-6-luna", bills: false });
    expect(mockSelf("openai-compatible", "x")).toEqual({ servedBy: null, resolvedModel: null, bills: false });
  });

  test("the estimate is ceil(characters / 4) over the input, instructions and option descriptions", () => {
    expect(estimateTokens({ input: "abcd", questions: [{ instructions: "ab", choices: [{ description: "a" }] }] })).toBe(2);
  });
});

describe("mock api: cost fields", () => {
  test("answered logs carry a cost and a basis; failed ones carry null", async () => {
    const page = await demo().listLogs({ limit: 200 });
    const ok = page.items.filter((item) => item.status === "ok");
    const failed = page.items.filter((item) => item.status === "error");
    expect(ok.length).toBeGreaterThan(0);
    expect(failed.length).toBeGreaterThan(0);
    expect(ok.every((item) => item.cost_basis !== null && item.tokens !== null)).toBe(true);
    expect(failed.every((item) => item.cost_usd === null && item.cost_basis === null)).toBe(true);
    // OpenAI is priced from its tokens, OpenRouter and the mock report what they billed, the local server is unpriced.
    expect(new Set(ok.map((item) => item.cost_basis))).toEqual(new Set(["upstream_tokens", "upstream_cost", "unpriced"]));
  });

  test("answered logs say who served them where the upstream does: OpenRouter's vendor, the mock itself", async () => {
    const page = await demo().listLogs({ limit: 200 });
    const ok = page.items.filter((item) => item.status === "ok");
    const routed = ok.filter((item) => item.provider === "openrouter");
    expect(routed.length).toBeGreaterThan(0);
    for (const item of routed) {
      expect(item.cost_basis).toBe("upstream_cost");
      expect(item.served_by).toBe(item.upstream_model.startsWith("baseten/") ? "Baseten" : "OpenAI");
      expect(item.upstream_model_resolved).toBe(`${item.upstream_model}-20261016`);
    }
    expect(ok.filter((item) => item.provider === "mock").every((item) => item.served_by === "Mock" && item.cost_usd === 0)).toBe(true);
    expect(page.items.filter((item) => item.status === "error").every((item) => item.served_by === null)).toBe(true);
  });

  test("stats sum cost over the window, per bucket, per model and per connection, and count unpriced answers", async () => {
    const stats = await demo().stats("24h");
    const buckets = stats.timeseries.reduce((sum, bucket) => sum + (bucket.cost_usd ?? 0), 0);
    const byRoute = stats.by_route.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
    const byProvider = stats.by_provider.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
    expect(stats.cost_usd).toBeGreaterThan(0);
    expect(buckets).toBeCloseTo(stats.cost_usd ?? 0, 7);
    expect(byRoute).toBeCloseTo(stats.cost_usd ?? 0, 7);
    expect(byProvider).toBeCloseTo(stats.cost_usd ?? 0, 7);
    expect(stats.unpriced).toBeGreaterThan(0);
    expect(stats.by_route.find((row) => row.route === "triage")?.cost_usd).toBe(0);
  });

  test("an empty window reports zero cost, never null", async () => {
    const stats = await fresh().stats("1h");
    expect(stats.cost_usd).toBe(0);
    expect(stats.unpriced).toBe(0);
    expect(stats.timeseries.every((bucket) => bucket.cost_usd === 0)).toBe(true);
  });

  test("a playground answer carries the gateway cost block, using the step's own price", async () => {
    const api = demo();
    const routes = await api.listRoutes();
    const luna = routes.find((route) => route.alias === "luna");
    if (!luna) throw new Error("no luna");
    const priced = luna.targets.map((target, index) => (index === 0 ? { ...target, price_per_m_input: 1 } : target));
    const saved = await api.updateRoute(luna.id, { targets: priced });
    expect(saved.targets[0]?.price_per_m_input).toBe(1);
    const run = await api.runPlayground(sampleDecision("luna"));
    const gateway = run.response?.gateway;
    expect(gateway?.cost_basis).toBe("upstream_tokens");
    expect(gateway?.tokens).toBe(95);
    expect(gateway?.cost_usd).toBe(0.000095);
    const logged = await api.listLogs({ limit: 1 });
    expect(logged.items[0]).toMatchObject({ cost_usd: 0.000095, cost_basis: "upstream_tokens", tokens: 95 });
  });

  test("a direct mock call is billed 0 by the mock itself, with its input tokens, and says it served it", async () => {
    const request = sampleDecision("mock::mock-1");
    const run = await demo().runPlayground(request);
    expect(run.response?.gateway).toMatchObject({
      cost_usd: 0,
      cost_basis: "upstream_cost",
      tokens: estimateTokens(request),
      served_by: "Mock",
      upstream_model_resolved: "mock-1",
    });
    expect(run.response?.usage).toEqual({ input_tokens: estimateTokens(request), output_tokens: 1, total_tokens: estimateTokens(request) + 1 });
  });

  test("a step price must be zero or more, or null", async () => {
    const api = demo();
    const routes = await api.listRoutes();
    const target = routes[0]?.targets[0];
    if (!routes[0] || !target) throw new Error("no route");
    const refused = await api.updateRoute(routes[0].id, { targets: [{ ...target, price_per_m_input: -1 }] }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    const cleared = await api.updateRoute(routes[0].id, { targets: [{ ...target, price_per_m_input: null }] });
    expect(cleared.targets[0]?.price_per_m_input).toBeNull();
  });

  test("a provider test is recorded as last_test, success or failure", async () => {
    const api = demo();
    const before = await api.listProviders();
    expect(before.find((p) => p.name === "llamacpp")?.last_test).toBeNull();
    await api.testProvider("prv_openrouter");
    await api.testProvider("prv_openai");
    const after = await api.listProviders();
    const failed = after.find((p) => p.name === "openrouter")?.last_test;
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toContain("OPENROUTER_API_KEY");
    expect(after.find((p) => p.name === "openai")?.last_test).toMatchObject({ ok: true, at: new Date(FIXED_NOW).toISOString(), error: null });
  });
});

describe("mock api: the fresh first run", () => {
  test("no keys, the seeded models only, no traffic, no client keys, and the checklist at step one", async () => {
    const api = fresh();
    const [providers, routes, logs, clients, settings] = await Promise.all([
      api.listProviders(),
      api.listRoutes(),
      api.listLogs({ limit: 10 }),
      api.listClients(),
      api.getSettings(),
    ]);
    expect(routes.map((route) => route.alias)).toEqual(["default", "luna", "elephant"]);
    expect(providers.filter((p) => p.key.source === "env").every((p) => p.key.source === "env" && !p.key.present)).toBe(true);
    expect(providers.every((p) => p.last_test === null)).toBe(true);
    expect(logs.items).toEqual([]);
    expect(clients).toEqual([]);
    expect(settings.capture_payloads).toBe(false);
    const state = checklistState({ providers, routes, answeredModels: new Set(), dismissed: false });
    expect(state).toMatchObject({ visible: true, current: "connect", done: 0 });
  });

  test("pasting a key connects the provider, and the seeded model that uses it completes step two", async () => {
    const api = fresh();
    const updated = await api.updateProvider("prv_openai", { key: { source: "stored", value: "sk-test-a1b2" } });
    expect(updated.key).toEqual({ source: "stored", last4: "a1b2" });
    const state = checklistState({ providers: await api.listProviders(), routes: await api.listRoutes(), answeredModels: new Set(), dismissed: false });
    expect(state.steps.map((step) => step.done)).toEqual([true, true, false]);
    const run = await api.runPlayground(sampleDecision("luna"));
    expect(run.response?.gateway.provider).toBe("openai");
  });

  test("without GATEWAY_SECRET a stored key is refused with the gateway's message; the env-var option still works", async () => {
    const api = fresh(false);
    const refusal = await api.updateProvider("prv_openai", { key: { source: "stored", value: "sk-test" } }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiError);
    expect((refusal as ApiError).status).toBe(400);
    expect((refusal as ApiError).message).toBe("GATEWAY_SECRET must be set to store provider keys");
    const env = await api.updateProvider("prv_openai", { key: { source: "env", env_var: "OPENAI_API_KEY" } });
    expect(env.key).toEqual({ source: "env", env_var: "OPENAI_API_KEY", present: false });
  });
});
