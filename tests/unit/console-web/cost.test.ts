import { describe, expect, test } from "bun:test";
import {
  costAt,
  costLine,
  defaultPrice,
  defaultPriceSentence,
  describeCost,
  effectivePrice,
  formatPerMillionDecisions,
  formatPricePerM,
  formatUsd,
  parsePrice,
  priceSummary,
  priceText,
  windowCost,
} from "../../../src/modules/gateway/apps/console-web/src/domain/cost";
import { connectionPricing, modelPricing, stepPricing } from "../../../src/modules/gateway/apps/console-web/src/domain/pricing";
import type { Provider, Route } from "../../../src/modules/gateway/apps/console-web/src/api/types";

// An OpenAI connection's models, as GET /admin/api/providers/:id/models lists them with their defaults.
const openaiCatalog = [{ id: "gpt-6-luna", default_price_per_m_input: 0.1 }];

function provider(id: string, kind: Provider["kind"]): Provider {
  return {
    id,
    name: id,
    kind,
    base_url: "https://example.test",
    path: "/decisions",
    wire: "openai",
    enabled: true,
    timeout_ms: 20000,
    limits: { max_questions: 400, max_choices: 64 },
    extra_body: {},
    key: { source: "stored", last4: "abcd" },
    created_at: "",
    updated_at: "",
  };
}

function route(targets: Route["targets"]): Route {
  return { id: "r", alias: "r", description: "", enabled: true, targets, created_at: "", updated_at: "" };
}

describe("formatting dollars", () => {
  test("tiny non-zero costs keep two significant digits and never read as $0.00", () => {
    expect(formatUsd(0.0000042)).toBe("$0.0000042");
    expect(formatUsd(0.000123)).toBe("$0.00012");
    expect(formatUsd(0.00002)).toBe("$0.00002");
    expect(formatUsd(0.035)).toBe("$0.035");
    expect(formatUsd(0.00000001)).toBe("$0.00000001");
    expect(formatUsd(0.000000001)).toBe("<$0.00000001");
  });

  test("zero is plain, cents from ten cents up, grouping for large sums, a dash for missing", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0999)).toBe("$0.10");
    expect(formatUsd(0.42)).toBe("$0.42");
    expect(formatUsd(4.2)).toBe("$4.20");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
  });

  test("prices per million input tokens and per million decisions", () => {
    expect(formatPricePerM(0.4)).toBe("$0.40 / M input");
    expect(formatPricePerM(0.035)).toBe("$0.035 / M input");
    expect(formatPricePerM(0)).toBe("Free");
    expect(formatPricePerM(undefined)).toBe("—");
    expect(formatPerMillionDecisions(0.0000042)).toBe("$4.20 per 1M decisions");
    expect(formatPerMillionDecisions(null)).toBe("—");
  });
});

describe("what a request cost, in words", () => {
  test("each basis is labelled: billed, priced, estimated, unpriced", () => {
    const billed = describeCost({ cost_usd: 0.00000177, cost_basis: "upstream_cost", tokens: 177 });
    expect(billed).toMatchObject({ kind: "billed", text: "$0.0000018" });
    expect(billed.detail).toContain("Billed by provider");
    expect(billed.detail).toContain("177 tokens");
    // A provider that billed nothing shows the amount it billed, not "Free".
    expect(describeCost({ cost_usd: 0, cost_basis: "upstream_cost", tokens: 3 })).toMatchObject({ kind: "billed", text: "$0" });
    const priced = describeCost({ cost_usd: 0.0000042, cost_basis: "upstream_tokens", tokens: 120 });
    expect(priced).toMatchObject({ kind: "priced", text: "$0.0000042" });
    expect(priced.detail).toContain("list price");
    const estimated = describeCost({ cost_usd: 0.0000042, cost_basis: "estimated_tokens", tokens: 120 });
    expect(estimated.kind).toBe("estimated");
    expect(estimated.detail).toContain("Estimated from about 120 tokens");
    // Historical zero-cost entries normalized by the server still display as unpriced.
    expect(describeCost({ cost_usd: 0, cost_basis: "unpriced", tokens: 40 })).toMatchObject({ kind: "unpriced", text: "Unpriced" });
    const unpriced = describeCost({ cost_usd: null, cost_basis: "unpriced", tokens: 95 });
    expect(unpriced).toMatchObject({ kind: "unpriced", text: "Unpriced" });
    expect(unpriced.detail).toContain("Set a price on the model step");
  });

  test("a failed request costs nothing, and a gateway without cost fields is not shown as zero", () => {
    expect(describeCost({ cost_usd: null, cost_basis: null, tokens: null }, true)).toMatchObject({ kind: "none", text: "—" });
    expect(describeCost({}, true).detail).toBe("Failed requests cost nothing.");
    expect(describeCost({}).detail).toContain("did not report a cost");
  });

  test("the cost line under an answer says where the figure came from", () => {
    expect(costLine({ cost_usd: 0.00000177, cost_basis: "upstream_cost", tokens: 177 })).toBe("$0.0000018 · 177 tokens, billed by provider");
    expect(costLine({ cost_usd: 0.0000042, cost_basis: "estimated_tokens", tokens: 120 })).toBe("$0.0000042 · 120 tokens, estimated");
    expect(costLine({ cost_usd: 0.0000095, cost_basis: "upstream_tokens", tokens: 95 })).toBe(
      "$0.0000095 · 95 tokens from the upstream, at list price",
    );
    expect(costLine({ cost_usd: 0, cost_basis: "upstream_tokens", tokens: 1 })).toBe("$0 · 1 token from the upstream, at list price");
    expect(costLine({ cost_usd: null, cost_basis: "unpriced", tokens: 80 })).toBe("Unpriced · 80 tokens");
    expect(costLine({})).toBe("Cost not reported");
  });
});

describe("the price a step resolves to (API reference)", () => {
  const catalog = [{ id: "baseten/elephant-1", price_per_m_input: 0.9, default_price_per_m_input: 0.9 }, { id: "unlisted" }];

  test("defaults by connection kind: mock zero, catalog, built-in table, or none", () => {
    expect(defaultPrice("mock", "mock-1")).toEqual({ price: 0, source: "mock" });
    // Local and hosted SystemOne providers are priced by hints, or stay unpriced.
    expect(defaultPrice({ kind: "systemone", base_url: "http://host.docker.internal:8080" }, "x")).toEqual({ price: null, source: "none" });
    expect(defaultPrice({ kind: "systemone", base_url: "https://api.typesafe.ai" }, "x")).toEqual({ price: null, source: "none" });
    expect(defaultPrice("systemone", "x")).toEqual({ price: null, source: "none" });
    const hinted = {
      kind: "systemone" as const,
      base_url: "https://api.typesafe.ai",
      model_hints: [{ id: "jev-1.14", price_per_m_input: 0.042 }],
    };
    expect(defaultPrice(hinted, "jev-1.14")).toEqual({ price: 0.042, source: "hint" });
    expect(defaultPrice(hinted, "jev-9")).toEqual({ price: null, source: "none" });
    expect(defaultPrice({ ...hinted, base_url: "http://localhost:11434" }, "jev-1.14")).toEqual({ price: 0.042, source: "hint" });
    expect(defaultPrice({ kind: "openai-compatible", model_hints: [{ id: "m", price_per_m_input: 0.5 }] }, "m")).toEqual({
      price: 0.5,
      source: "hint",
    });
    expect(defaultPrice("openrouter", "baseten/elephant-1", catalog)).toEqual({ price: 0.9, source: "catalog" });
    expect(defaultPrice("openrouter", "unlisted", catalog)).toEqual({ price: null, source: "none" });
    expect(defaultPrice("openai", "gpt-6-luna", openaiCatalog)).toEqual({ price: 0.1, source: "builtin" });
    expect(defaultPrice("openai", "gpt-unknown", openaiCatalog)).toEqual({ price: null, source: "none" });
    // The console has no table of its own: without the provider's catalog, an OpenAI default is not known.
    expect(defaultPrice("openai", "gpt-6-luna")).toEqual({ price: null, source: "none" });
    // The default is the endpoint's default_price_per_m_input, not a catalog's plain price.
    expect(defaultPrice("openrouter", "baseten/elephant-1", [{ id: "baseten/elephant-1", price_per_m_input: 0.9 }])).toEqual({
      price: null,
      source: "none",
    });
    expect(defaultPrice("openai-compatible", "anything")).toEqual({ price: null, source: "none" });
  });

  test("a step's own price wins, zero included", () => {
    expect(effectivePrice(0.035, "openrouter", "baseten/elephant-1", catalog)).toEqual({ price: 0.035, source: "override" });
    expect(effectivePrice(0, "openai", "gpt-6-luna")).toEqual({ price: 0, source: "override" });
    expect(effectivePrice(null, "openai", "gpt-6-luna", openaiCatalog)).toEqual({ price: 0.1, source: "builtin" });
  });

  test("cost at a price is rounded to 8 decimals, as the gateway does", () => {
    expect(costAt(120, 0.035)).toBe(0.0000042);
    expect(costAt(1, 0.1)).toBe(0.0000001);
    expect(costAt(null, 0.1)).toBeNull();
    expect(costAt(100, null)).toBeNull();
  });

  test("price fields: empty means default, numbers zero or more, a leading $ is accepted", () => {
    expect(parsePrice("")).toEqual({ ok: true, value: null });
    expect(parsePrice(" $0.4 ")).toEqual({ ok: true, value: 0.4 });
    expect(parsePrice("0")).toEqual({ ok: true, value: 0 });
    expect(parsePrice("-1").ok).toBe(false);
    expect(parsePrice("cheap").ok).toBe(false);
    expect(priceText(0.4)).toBe("0.4");
    expect(priceText(0.035)).toBe("0.035");
    expect(priceText(null)).toBe("");
  });

  test("hints and summaries say what an empty price means", () => {
    expect(defaultPriceSentence({ price: 0.9, source: "catalog" })).toBe("Empty uses the provider's catalog price: $0.90 / M input.");
    expect(defaultPriceSentence({ price: 0, source: "mock" })).toContain("mock's zero price");
    expect(defaultPriceSentence({ price: null, source: "none" })).toContain("unpriced");
    expect(priceSummary(0.4, "openrouter", "x")).toBe("$0.40 / M input");
    expect(priceSummary(null, "mock", "mock-1")).toBe("Free");
    expect(priceSummary(null, "openai", "gpt-6-luna", openaiCatalog)).toBe("$0.10 / M input, built in");
    expect(priceSummary(null, "openrouter", "baseten/elephant-1", catalog)).toBe("$0.90 / M input, from the catalog");
    expect(priceSummary(null, "openrouter", "x", [])).toBe("catalog price");
    // Until the provider's catalog has loaded, a price that depends on it is not yet known.
    expect(priceSummary(null, "openai", "gpt-6-luna")).toBe("checking the price…");
    expect(priceSummary(null, "openrouter", "x")).toBe("checking the price…");
    expect(priceSummary(null, "openai-compatible", "x")).toBe("unpriced");
  });

  test("a window's cost with its unpriced count and a per-decision average", () => {
    expect(windowCost(0.0042, 3, 1000)).toEqual({ text: "$0.0042", unpriced: 3, perMillion: "$4.20 per 1M decisions" });
    expect(windowCost(0, 0, 0)).toEqual({ text: "$0", unpriced: 0, perMillion: null });
    expect(windowCost(undefined, undefined, 10).text).toBeNull();
  });
});

describe("telling free and unpriced apart for a model or a connection", () => {
  const providers = [provider("mock", "mock"), provider("local", "openai-compatible"), provider("oai", "openai"), provider("or", "openrouter")];

  test("each step's pricing from its own price or its connection kind", () => {
    expect(stepPricing({ model: "mock-1" }, "mock")).toBe("free");
    expect(stepPricing({ model: "x" }, "openai-compatible")).toBe("unpriced");
    expect(stepPricing({ model: "x", price_per_m_input: 0.2 }, "openai-compatible")).toBe("priced");
    expect(stepPricing({ model: "x", price_per_m_input: 0 }, "openai-compatible")).toBe("free");
    expect(stepPricing({ model: "gpt-6-luna" }, "openai", openaiCatalog)).toBe("priced");
    expect(stepPricing({ model: "gpt-x" }, "openai", openaiCatalog)).toBe("unpriced");
    // An OpenAI step reads as "catalog" until its connection's catalog has loaded.
    expect(stepPricing({ model: "gpt-6-luna" }, "openai")).toBe("catalog");
    expect(stepPricing({ model: "a/b" }, "openrouter")).toBe("catalog");
  });

  test("a model is free, unpriced, partly unpriced or priced, and points at its first unpriced step", () => {
    expect(modelPricing(route([{ provider_id: "mock", model: "mock-1" }]), providers)).toEqual({ pricing: "free", unpricedStep: null });
    expect(
      modelPricing(
        route([
          { provider_id: "local", model: "x" },
          { provider_id: "mock", model: "mock-1" },
        ]),
        providers,
      ),
    ).toEqual({ pricing: "unpriced", unpricedStep: 1 });
    expect(
      modelPricing(
        route([
          { provider_id: "oai", model: "gpt-6-luna" },
          { provider_id: "local", model: "x" },
        ]),
        providers,
      ),
    ).toEqual({ pricing: "partly-unpriced", unpricedStep: 2 });
    expect(modelPricing(route([{ provider_id: "or", model: "a/b" }]), providers).pricing).toBe("priced");
    const loaded = new Map([["oai", openaiCatalog]]);
    expect(modelPricing(route([{ provider_id: "oai", model: "gpt-6-luna" }]), providers, loaded).pricing).toBe("priced");
    expect(modelPricing(route([{ provider_id: "oai", model: "gpt-x" }]), providers, loaded)).toEqual({ pricing: "unpriced", unpricedStep: 1 });
  });

  test("a connection's pricing over the steps that use it, or its kind when none do", () => {
    const routes = [route([{ provider_id: "local", model: "x" }])];
    expect(connectionPricing({ id: "local", kind: "openai-compatible" }, routes)).toBe("unpriced");
    expect(connectionPricing({ id: "mock", kind: "mock" }, routes)).toBe("free");
    expect(connectionPricing({ id: "local", kind: "openai-compatible" }, [route([{ provider_id: "local", model: "x", price_per_m_input: 0.3 }])])).toBe(
      "priced",
    );
  });
});
