import { describe, expect, test } from "bun:test";
import { newStep, stepFromTarget, targetFromStep, validateStep } from "../../../src/modules/gateway/apps/console-web/src/domain/model-draft";
import { parseModelHints } from "../../../src/modules/gateway/apps/console-web/src/domain/connection-form";
import {
  costLine,
  defaultOutputPrice,
  defaultOutputPriceSentence,
  describeCost,
  effectiveOutputPrice,
  formatPricePerM,
  outputPriceSummary,
  parsePrice,
} from "../../../src/modules/gateway/apps/console-web/src/domain/cost";
import { costPhrase } from "../../../src/modules/gateway/apps/console-web/src/domain/test-result";

describe("editing output prices", () => {
  test("an output price survives route edits, and invalid prices are refused", () => {
    const step = stepFromTarget({ provider_id: "p", model: "m", price_per_m_input: 2, price_per_m_output: 3 });
    expect(step.outputPrice).toBe("3");
    expect(targetFromStep(step)).toMatchObject({ price_per_m_input: 2, price_per_m_output: 3 });
    expect(targetFromStep({ ...step, outputPrice: "" })).not.toHaveProperty("price_per_m_output");
    expect(validateStep({ ...newStep("p", "m"), outputPrice: "-2" }).outputPrice).toContain("output tokens");
    expect(validateStep({ ...newStep("p", "m"), outputPrice: "0.5" }).outputPrice).toBeUndefined();
    const refused = parsePrice("x", "output");
    expect(refused.ok ? null : refused.message).toContain("million output tokens");
  });

  test("model hints take price_per_m_output, not the old spelling", () => {
    expect(parseModelHints('[{"id":"m","price_per_m_output":3}]').ok).toBe(true);
    expect(parseModelHints('[{"id":"m","price_per_m_output":-3}]').ok).toBe(false);
    expect(parseModelHints('[{"id":"m","price_output":3}]').ok).toBe(false);
  });
});

describe("showing output prices", () => {
  test("prices name their side", () => {
    expect(formatPricePerM(1.6, "output")).toBe("$1.60 / M output");
    expect(formatPricePerM(0.4)).toBe("$0.40 / M input");
  });

  test("the default output price follows the gateway's rules", () => {
    expect(defaultOutputPrice("mock", "mock-1")).toEqual({ price: 0, source: "mock" });
    expect(defaultOutputPrice({ kind: "systemone", base_url: "http://localhost:8080" }, "d1")).toEqual({ price: null, source: "none" });
    const catalog = [{ id: "gpt-6-luna", default_price_per_m_input: 0.1, default_price_per_m_output: 0.5 }];
    expect(defaultOutputPrice("openai", "gpt-6-luna", catalog)).toEqual({ price: 0.5, source: "builtin" });
    expect(defaultOutputPrice("openrouter", "x", [{ id: "x", default_price_per_m_output: 3 }])).toEqual({ price: 3, source: "catalog" });
    const hinted = { kind: "openai-compatible" as const, model_hints: [{ id: "m", price_per_m_output: 4 }] };
    expect(defaultOutputPrice(hinted, "m")).toEqual({ price: 4, source: "hint" });
    expect(defaultOutputPrice(hinted, "other")).toEqual({ price: null, source: "none" });
    expect(effectiveOutputPrice(2, hinted, "m")).toEqual({ price: 2, source: "override" });
  });

  test("the empty field says what applies instead", () => {
    expect(defaultOutputPriceSentence({ price: null, source: "none" })).toContain("cover input tokens only");
    expect(defaultOutputPriceSentence({ price: 0.5, source: "builtin" })).toContain("$0.50 / M output");
    expect(outputPriceSummary(null, "openai", "gpt-6-luna", [{ id: "gpt-6-luna", default_price_per_m_output: 0.5 }])).toBe(
      "$0.50 / M output, built in",
    );
    expect(outputPriceSummary(null, "openai", "gpt-6-luna")).toBe("checking the output price…");
    expect(outputPriceSummary(null, "mock", "mock-1", [])).toBe("output free");
    expect(outputPriceSummary(null, "openai-compatible", "m", [])).toBe("no output price");
    expect(outputPriceSummary(1.6, "openai-compatible", "m", [])).toBe("$1.60 / M output");
  });
});

describe("costs that leave out output", () => {
  test("cost views disclose it, and complete costs read as before", () => {
    const cost = { cost_basis: "upstream_tokens" as const, cost_usd: 0.002, cost_includes_output: false, tokens: 1000 };
    expect(costLine(cost)).toBe("$0.002 · 1,000 tokens from the upstream, at list price; output cost not included");
    expect(costPhrase(cost)).toBe("$0.002 at list price, output cost not included");
    expect(describeCost(cost)).toMatchObject({ text: "$0.002 + output" });
    expect(describeCost(cost).detail).toContain("Output tokens are not included");
    const estimated = { ...cost, cost_basis: "estimated_tokens" as const };
    expect(describeCost(estimated).text).toBe("$0.002 + output");
    const complete = { ...cost, cost_includes_output: true };
    expect(costLine(complete)).toBe("$0.002 · 1,000 tokens from the upstream, at list price");
    expect(describeCost(complete).text).toBe("$0.002");
    // An unpriced cost has no figure to qualify.
    expect(costLine({ cost_basis: "unpriced", cost_usd: null, cost_includes_output: false, tokens: 5 })).toBe("Unpriced · 5 tokens");
  });
});
