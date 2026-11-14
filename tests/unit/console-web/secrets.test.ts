import { describe, expect, test } from "bun:test";
import { createMockApi } from "../../../src/modules/gateway/apps/console-web/src/api/mock/mock-api";
import { modelsFor } from "../../../src/modules/gateway/apps/console-web/src/api/mock/fixtures";
import { ApiError, errorFromResponse } from "../../../src/modules/gateway/apps/console-web/src/api/errors";
import { isSecretMissing, pasteAdvice, SECRET_MISSING_CODE } from "../../../src/modules/gateway/apps/console-web/src/domain/secrets";
import type { Provider } from "../../../src/modules/gateway/apps/console-web/src/api/types";

const FIXED_NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

const noWait = async () => {};

function mock(storesKeys = true) {
  return createMockApi({ now: () => FIXED_NOW, delay: noWait, seed: 7, storesKeys });
}

describe("the missing-secret refusal is recognised by its code", () => {
  test("the code, and only the code, marks the refusal", () => {
    expect(SECRET_MISSING_CODE).toBe("gateway_secret_missing");
    expect(isSecretMissing("gateway_secret_missing")).toBe(true);
    expect(isSecretMissing(undefined)).toBe(false);
    expect(isSecretMissing(null)).toBe(false);
    expect(isSecretMissing("invalid_request_error")).toBe(false);
  });

  test("the message alone no longer marks it: a refusal without the code is an ordinary error", () => {
    const error = errorFromResponse(400, {
      error: { message: "GATEWAY_SECRET must be set to store provider keys", type: "invalid_request_error" },
    });
    expect(error.message).toContain("GATEWAY_SECRET");
    expect(isSecretMissing(error.code)).toBe(false);
  });

  test("a gateway 400 with the code reads back as the refusal", () => {
    const error = errorFromResponse(400, {
      error: {
        message: "GATEWAY_SECRET must be set to store provider keys",
        type: "invalid_request_error",
        code: "gateway_secret_missing",
      },
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.message).toBe("GATEWAY_SECRET must be set to store provider keys");
    expect(isSecretMissing(error.code)).toBe(true);
  });
});

describe("the paste advice follows the health report's secret_configured", () => {
  test("an unset secret warns before the paste and opens the environment-variable route first", () => {
    const advice = pasteAdvice(false);
    expect(advice.envFirst).toBe(true);
    expect(advice.warning?.title).toBe("This gateway can't store keys yet");
    expect(advice.warning?.body).toContain("GATEWAY_SECRET");
  });

  test("a set secret needs no warning, and the paste route opens as usual", () => {
    expect(pasteAdvice(true)).toEqual({ warning: null, envFirst: false });
  });

  test("an unknown state (a gateway that predates the field, or health not loaded) warns nothing", () => {
    expect(pasteAdvice(undefined)).toEqual({ warning: null, envFirst: false });
    expect(pasteAdvice(null)).toEqual({ warning: null, envFirst: false });
  });
});

describe("the mock mirrors the gateway's secret and default-price contract", () => {
  test("health reports the secret as configured unless the mock refuses stored keys", async () => {
    expect((await mock().health()).secret_configured).toBe(true);
    expect((await mock(false).health()).secret_configured).toBe(false);
  });

  test("a stored key is refused with the code when the secret is unset, and an env key is not", async () => {
    const api = mock(false);
    const openai = (await api.listProviders()).find((provider: Provider) => provider.name === "openai");
    if (!openai) throw new Error("the seeded openai connection is missing");
    const refused = await api.updateProvider(openai.id, { key: { source: "stored", value: "sk-test-1234" } }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(400);
    expect((refused as ApiError).code).toBe("gateway_secret_missing");
    const env = await api.updateProvider(openai.id, { key: { source: "env", env_var: "OPENAI_API_KEY" } });
    expect(env.key.source).toBe("env");
  });

  test("each kind lists its default price for each model, as the models endpoint does", () => {

    const provider = (kind: Provider["kind"]) => ({ kind }) as Provider;

    expect(modelsFor(provider("mock"))).toEqual([{ id: "mock-1", description: "Deterministic mock answers", default_price_per_m_input: 0 }]);
    // Local and hosted SystemOne servers without hints list their placeholders with no default.
    expect(modelsFor({ kind: "systemone", base_url: "http://host.docker.internal:8080" }).map((m) => m.default_price_per_m_input)).toEqual([undefined]);
    expect(modelsFor({ kind: "systemone", base_url: "https://api.typesafe.ai" }).map((m) => m.default_price_per_m_input)).toEqual([undefined]);
    // With hints, the hints are the list, priced by their own figures.
    expect(
      modelsFor({
        kind: "systemone",
        base_url: "https://api.typesafe.ai",
        model_hints: [{ id: "jev-1.14", price_per_m_input: 0.042 }, { id: "jev-x" }],
      }),
    ).toEqual([{ id: "jev-1.14", price_per_m_input: 0.042, default_price_per_m_input: 0.042 }, { id: "jev-x" }]);
    expect(modelsFor(provider("openai")).map((m) => [m.id, m.default_price_per_m_input])).toEqual([["gpt-6-luna", 0.1]]);
    for (const model of modelsFor(provider("openrouter"))) {
      expect(model.default_price_per_m_input).toBe(model.price_per_m_input);
    }
    expect(modelsFor(provider("openai-compatible")).every((m) => m.default_price_per_m_input === undefined)).toBe(true);
  });

  test("grouped stats carry an unpriced count per provider and per route that adds up to the window", async () => {
    const stats = await mock().stats("24h");
    const byRoute = stats.by_route.reduce((sum, row) => sum + (row.unpriced ?? 0), 0);
    const byProvider = stats.by_provider.reduce((sum, row) => sum + (row.unpriced ?? 0), 0);
    expect(stats.unpriced).toBeGreaterThan(0);
    expect(byRoute).toBe(stats.unpriced ?? 0);
    expect(byProvider).toBe(stats.unpriced ?? 0);
    // The vLLM route answers without a price, so its requests are unpriced; the mock bills zero and never is.
    expect(stats.by_route.find((row) => row.route === "triage")?.unpriced).toBeGreaterThan(0);
    expect(stats.by_provider.find((row) => row.provider === "mock")?.unpriced).toBe(0);
  });
});
