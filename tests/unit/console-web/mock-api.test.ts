import { describe, expect, test } from "bun:test";
import { createMockApi } from "../../../src/modules/gateway/apps/console-web/src/api/mock/mock-api";
import { ApiError } from "../../../src/modules/gateway/apps/console-web/src/api/errors";
import { buildDecisionRequest, presets } from "../../../src/modules/gateway/apps/console-web/src/domain/playground";
import { createConsoleApi } from "../../../src/modules/gateway/apps/console-web/src/api/create-api";

const FIXED_NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

const noWait = async () => {};

function mock() {
  return createMockApi({ now: () => FIXED_NOW, delay: noWait, seed: 7 });
}

describe("console api selection", () => {
  test("mock mode resolves the in-memory API through its lazy import", async () => {
    const api = await createConsoleApi({ mock: true, getToken: () => null, onUnauthorized: () => {} });
    const routes = await api.listRoutes();
    expect(routes.map((route) => route.alias)).toContain("default");
  });
});

describe("mock api: fixtures and pagination", () => {
  test("logs come newest first and pages with the before cursor", async () => {
    const api = mock();
    const first = await api.listLogs({ limit: 50 });
    expect(first.items).toHaveLength(50);
    const times = first.items.map((item) => Date.parse(item.ts));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(first.next_before).toBe(first.items[49]?.id ?? null);
    const second = await api.listLogs({ limit: 50, before: first.next_before ?? undefined });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(Date.parse(second.items[0]?.ts ?? "")).toBeLessThanOrEqual(Date.parse(first.items[49]?.ts ?? ""));
  });

  test("the scenario shows a missing OpenRouter key with errors on the elephant route", async () => {
    const api = mock();
    const health = await api.health();
    expect(health.providers.find((p) => p.name === "openrouter")?.key_present).toBe(false);
    const errors = await api.listLogs({ limit: 200, route: "elephant", status: "error" });
    expect(errors.items.length).toBeGreaterThan(0);
    expect(errors.items.every((item) => item.error?.includes("OPENROUTER_API_KEY") || item.status === "error")).toBe(true);
  });

  test("stats bucket the window into exactly 24 columns", async () => {
    const api = mock();
    for (const window of ["1h", "24h", "7d"] as const) {
      const stats = await api.stats(window);
      expect(stats.timeseries).toHaveLength(24);
      const total = stats.timeseries.reduce((sum, bucket) => sum + bucket.requests, 0);
      expect(total).toBe(stats.requests);
    }
  });

  test("each stats bucket has its own p95 and fallback count, and the buckets add up to the window", async () => {
    const api = mock();
    for (const window of ["1h", "24h", "7d"] as const) {
      const stats = await api.stats(window);
      for (const bucket of stats.timeseries) {
        if (bucket.requests === 0) {
          expect(bucket.p95_ms).toBeNull();
          expect(bucket.fallbacks).toBe(0);
        } else {
          expect(bucket.p95_ms).not.toBeNull();
          expect(bucket.p95_ms ?? 0).toBeGreaterThanOrEqual(bucket.p50_ms ?? Number.POSITIVE_INFINITY);
        }
      }
      const fallbacks = stats.timeseries.reduce((sum, bucket) => sum + bucket.fallbacks, 0);
      expect(fallbacks).toBe(stats.fallbacks);
      const answered = stats.timeseries.reduce((sum, bucket) => sum + bucket.fallbacks_answered, 0);
      expect(answered).toBe(stats.fallbacks_answered);
      expect(stats.timeseries.every((bucket) => bucket.fallbacks_answered <= bucket.fallbacks)).toBe(true);
    }
    // The fixture day has fallbacks spread across several buckets, so the chart has some to draw.
    const day = await api.stats("24h");
    expect(day.fallbacks).toBeGreaterThan(0);
    expect(day.timeseries.filter((bucket) => bucket.fallbacks > 0).length).toBeGreaterThanOrEqual(3);
  });
});

describe("mock api: validation and conflicts mirror the contract", () => {
  test("deleting a provider that a route targets is a 409 that names the route", async () => {
    const api = mock();
    const providers = await api.listProviders();
    const openrouter = providers.find((p) => p.name === "openrouter");
    const error = (await api.deleteProvider(openrouter?.id ?? "").catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.type).toBe("invalid_request_error");
    expect(error.code).toBe("provider_in_use");
    expect(error.message).toContain('"luna"');
    expect(error.message).toContain('"elephant"');
    expect(error.routes?.map((route) => route.alias)).toEqual(["luna", "elephant"]);
  });

  test("the fallback filter keeps used or unused rows, as the gateway does", async () => {
    const api = mock();
    const used = await api.listLogs({ limit: 200, fallback: "used" });
    const unused = await api.listLogs({ limit: 200, fallback: "none" });
    expect(used.items.length).toBeGreaterThan(0);
    expect(used.items.every((item) => item.fallback_used)).toBe(true);
    expect(unused.items.length).toBeGreaterThan(0);
    expect(unused.items.every((item) => !item.fallback_used)).toBe(true);
  });

  test("a response whose answers carry no confidence reports confidence_method none", async () => {
    const api = mock();
    const run = await api.runPlayground({ model: "default", input: "hello", questions: [{ name: "q", type: "predicate", instructions: "?" }] });
    expect(run.response?.gateway.confidence_method).toBe("none");
  });

  test("an empty stats window reports null latency rather than zero", async () => {
    const DAY_MS = 86_400_000;
    // The fixture logs are written at creation time; moving the clock on leaves the window empty.
    let clock = FIXED_NOW;
    const api = createMockApi({ now: () => clock, delay: noWait, seed: 7 });
    clock = FIXED_NOW + 30 * DAY_MS;
    const stats = await api.stats("24h");
    expect(stats.requests).toBe(0);
    expect(stats.p50_ms).toBeNull();
    expect(stats.p95_ms).toBeNull();
    expect(stats.timeseries.every((bucket) => bucket.p50_ms === null)).toBe(true);
  });

  test("a provider name must be unique and in the allowed alphabet", async () => {
    const api = mock();
    const base = {
      name: "openai",
      kind: "openai" as const,
      base_url: "https://example.invalid",
      path: "/decisions",
      wire: "openai" as const,
      enabled: true,
      timeout_ms: 1000,
      limits: { max_questions: 400, max_choices: 64 },
      extra_body: {},
      key: { source: "none" as const },
    };
    const duplicate = await api.createProvider(base).catch((caught: unknown) => caught);
    expect(duplicate).toMatchObject({ status: 400 });
    const badName = await api.createProvider({ ...base, name: "Bad Name" }).catch((caught: unknown) => caught);
    expect(badName).toMatchObject({ status: 400 });
    const created = await api.createProvider({ ...base, name: "fresh-one", key: { source: "stored", value: "sk-abcd12345" } });
    expect(created.key).toEqual({ source: "stored", last4: "2345" });
    // As the gateway does, the mock shows none of a key under 12 characters.
    const short = await api.createProvider({ ...base, name: "short-one", key: { source: "stored", value: "sk-abcd1234" } });
    expect(short.key).toEqual({ source: "stored", last4: null });
  });

  test("a playground request with duplicate score labels is refused with a 400", async () => {
    const api = mock();
    const refused = await api
      .runPlayground({
        input: "x",
        questions: [
          {
            name: "severity",
            type: "score",
            instructions: "How bad?",
            levels: [
              { label: "high", description: "a" },
              { label: "high", description: "b" },
            ],
          },
        ],
      })
      .catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ status: 400 });
  });
});

describe("mock api: playground answers", () => {
  test("typed choice values come back typed, and each answer carries its own method", async () => {
    const api = mock();
    const preset = presets().find((p) => p.id === "typed-values");
    if (!preset) throw new Error("preset missing");
    const built = buildDecisionRequest(preset.build());
    if (!built.ok) throw new Error("preset should be valid");
    const run = await api.runPlayground({ ...built.request, model: "default" });
    expect(run.error).toBeUndefined();
    const paid = run.response?.answers.find((a) => a.name === "paid_in_full");
    expect(paid && "choice" in paid && typeof paid.choice).toBe("boolean");
    expect(paid && "choice" in paid && paid.probabilities.map((entry) => typeof entry.value)).toEqual(["boolean", "boolean"]);
    const tier = run.response?.answers.find((a) => a.name === "tier");
    expect(tier && "choice" in tier && typeof tier.choice).toBe("number");
    for (const answer of run.response?.answers ?? []) {
      if ("confidence_method" in answer && answer.confidence_method) {
        expect(["upstream", "normalized-entropy"]).toContain(answer.confidence_method);
      }
    }
    const gatewayMethod = run.response?.gateway.confidence_method ?? "missing";
    expect(["upstream", "normalized-entropy", "mixed"]).toContain(gatewayMethod);
  });

  test("a timed-out primary tries the fallback, which fails here for the missing key, and both attempts are kept", async () => {
    const api = mock();
    const run = await api.runPlayground({
      model: "luna",
      input: "Please help [timeout] now.",
      questions: [{ name: "is_urgent", type: "predicate", instructions: "Urgent?" }],
    });
    expect(run.response).toBeNull();
    expect(run.error?.type).toBe("upstream_error");
    expect(run.trace.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ["openai", false],
      ["openrouter", false],
    ]);
    expect(run.trace.attempts[1]?.error).toBe("OPENROUTER_API_KEY is not set on the gateway host");
  });

  test("a timed-out primary that falls back to a working target returns an answer with both attempts", async () => {
    const api = mock();
    const providers = await api.listProviders();
    const mockProvider = providers.find((p) => p.name === "mock");
    const openai = providers.find((p) => p.name === "openai");
    await api.createRoute({
      alias: "fallback-check",
      description: "Test route",
      enabled: true,
      targets: [
        { provider_id: openai?.id ?? "", model: "gpt-6-luna" },
        { provider_id: mockProvider?.id ?? "", model: "mock-1" },
      ],
    });
    const run = await api.runPlayground({
      model: "fallback-check",
      input: "Please help [timeout] now.",
      questions: [{ name: "is_urgent", type: "predicate", instructions: "Urgent?" }],
    });
    expect(run.response?.gateway.provider).toBe("mock");
    expect(run.response?.gateway.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ["openai", false],
      ["mock", true],
    ]);
    const logged = await api.listLogs({ limit: 1 });
    expect(logged.items[0]?.fallback_used).toBe(true);
  });

  test("an unknown model returns an error object rather than an answer", async () => {
    const api = mock();
    const run = await api.runPlayground({ model: "nope", input: "x", questions: [{ name: "q", type: "predicate", instructions: "?" }] });
    expect(run.response).toBeNull();
    expect(run.error?.type).toBe("not_found_error");
  });

  test("playground runs are written to the log, as the gateway does", async () => {
    const api = mock();
    await api.runPlayground({ model: "default", input: "hello", questions: [{ name: "q", type: "predicate", instructions: "?" }] });
    const latest = await api.listLogs({ limit: 1 });
    expect(latest.items[0]?.route).toBe("default");
    expect(latest.items[0]?.provider).toBe("mock");
  });
});
