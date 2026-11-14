import { describe, expect, test } from "bun:test";
import {
  NOT_VERIFIED,
  PRESETS,
  PRICES_AS_OF,
  cheapestConfirmedHint,
  hintDescription,
  hostOf,
  keySentence,
  kindUsesHints,
  matchesPreset,
  presetById,
  presetForProvider,
  presetModelHints,
  presetPriceLine,
  presetTestModel,
  presetVerification,
  providerVerification,
  suggestProviderName,
  usesDockerHost,
  wireFor,
} from "../../../src/modules/gateway/apps/console-web/src/domain/provider-presets";
import { defaultSendModel, isLocalHost } from "../../../src/modules/gateway/apps/console-web/src/domain/hosts";
import {
  authHeaderProblem,
  connectionDraft,
  parseModelHints,
  presetDraft,
  validateConnection,
  withBaseUrl,
} from "../../../src/modules/gateway/apps/console-web/src/domain/connection-form";
import {
  ADD_PROVIDER_STEPS,
  addProviderIssue,
  detailIssues,
  furthestProviderStep,
  keyIssues,
  openingStep,
  providerWrite,
} from "../../../src/modules/gateway/apps/console-web/src/domain/add-provider";
import {
  connectionStatus,
  keySummary,
  providerNeedsKey,
  suggestedEnvVar,
} from "../../../src/modules/gateway/apps/console-web/src/domain/connections";
import { defaultPriceSentence, effectivePrice, priceSummary } from "../../../src/modules/gateway/apps/console-web/src/domain/cost";
import { connectionPricing, stepPricing } from "../../../src/modules/gateway/apps/console-web/src/domain/pricing";
import { searchCatalog } from "../../../src/modules/gateway/apps/console-web/src/domain/catalog";
import { formatDay } from "../../../src/modules/gateway/apps/console-web/src/domain/format";
import { createMockApi } from "../../../src/modules/gateway/apps/console-web/src/api/mock/mock-api";
import { ApiError } from "../../../src/modules/gateway/apps/console-web/src/api/errors";
import type { Provider, ProviderWrite } from "../../../src/modules/gateway/apps/console-web/src/api/types";

const preset = (id: string) => {
  const found = presetById(id);
  if (!found) throw new Error(`no preset ${id}`);
  return found;
};

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "prv_x",
    name: "x",
    kind: "systemone",
    base_url: "https://api.typesafe.ai",
    path: "/v1/systemone",
    wire: "map",
    enabled: true,
    timeout_ms: 20000,
    limits: { max_questions: 400, max_choices: 64 },
    extra_body: {},
    key: { source: "stored", last4: "abcd" },
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

/** The SystemOne vendors whose presets come from public docs only. */
const VENDORS = ["typesafe", "baseten", "liquid", "perplexity", "deepinfra"];

describe("the presets", () => {
  test("one list, without groups, in the order the picker shows it", () => {
    expect(PRESETS.map((p) => p.title)).toEqual([
      "Any OpenAI-compatible chat model (synthetic)",
      "OpenAI",
      "OpenAI (chat-endpoint)",
      "OpenRouter",
      "OpenRouter (chat-endpoint)",
      "Ollama (local)",
      "vLLM (local)",
      "TypeSafe",
      "Baseten",
      "Liquid",
      "Perplexity",
      "DeepInfra",
      "Custom OpenAI-compatible",
      "Custom SystemOne",
    ]);
    expect(PRESETS.every((p) => !("group" in p))).toBe(true);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  test("each preset carries its kind, address, path, send_model, header and key variable from the research", () => {
    const row = (id: string) => {
      const p = preset(id);
      return [p.kind, p.baseUrl, p.path, p.sendModel, p.authHeader, p.envVar];
    };

    expect(row("openai")).toEqual(["openai", "https://api.openai.com/v1", "/decisions", true, "authorization", "OPENAI_API_KEY"]);
    expect(row("openrouter")).toEqual([
      "openrouter",
      "https://openrouter.ai",
      "/api/alpha/decisions",
      true,
      "authorization",
      "OPENROUTER_API_KEY",
    ]);
    expect(row("ollama")).toEqual(["systemone", "http://host.docker.internal:11434", "/v1/systemone", true, "authorization", ""]);
    expect(row("vllm")).toEqual([
      "openai-compatible",
      "http://host.docker.internal:8000",
      "/v1/decisions",
      true,
      "authorization",
      "VLLM_API_KEY",
    ]);
    expect(row("custom-openai")).toEqual(["openai-compatible", "", "/v1/decisions", true, "authorization", ""]);
    expect(row("custom-systemone")).toEqual(["systemone", "", "/v1/systemone", "auto", "authorization", ""]);
    expect(row("typesafe")).toEqual(["systemone", "https://api.typesafe.ai", "/v1/systemone", true, "authorization", "TYPESAFE_API_KEY"]);
    expect(row("baseten")).toEqual(["systemone", "https://inference.baseten.co", "/v1/systemone", true, "authorization", "BASETEN_API_KEY"]);
    expect(row("liquid")).toEqual(["systemone", "https://api.liquid.ai", "/decisions/v1/systemone", true, "authorization", "LIQUID_API_KEY"]);
    expect(row("perplexity")).toEqual(["systemone", "https://api.perplexity.ai", "/v1/decisions", true, "authorization", "PERPLEXITY_API_KEY"]);
    expect(row("deepinfra")).toEqual(["systemone", "https://api.deepinfra.com", "/v1/systemone", true, "authorization", "DEEPINFRA_TOKEN"]);
    expect([preset("ollama").key, preset("vllm").key, preset("typesafe").key]).toEqual(["none", "optional", "required"]);
  });

  test("each vendor preset is unverified and has a docs link, a key and priced hints; every other preset is verified", () => {
    for (const id of VENDORS) {
      const p = preset(id);
      expect(p.verified, p.id).toBe(false);
      expect(p.docs.startsWith("https://"), p.id).toBe(true);
      expect(p.key, p.id).toBe("required");
      expect(p.hints.length, p.id).toBeGreaterThan(0);
      expect(p.hints.every((hint) => hint.price !== undefined), p.id).toBe(true);
    }
    expect(PRESETS.filter((p) => !p.verified).map((p) => p.id)).toEqual(["synthetic-chat", "openai-chat", "openrouter-chat", ...VENDORS]);
  });

  test("Perplexity's preset no longer warns about score questions: the gateway sends score levels as the list it expects", () => {
    expect(preset("perplexity").note).toBeUndefined();
    expect(PRESETS.some((p) => /score/i.test(p.note ?? ""))).toBe(false);
  });

  test("hint ids and prices, with what the vendors' docs could not confirm marked", () => {
    const hints = (id: string) => preset(id).hints.map((hint) => [hint.id, hint.price, !!hint.idUnverified, !!hint.priceUnverified]);

    expect(hints("openai")).toEqual([["gpt-6-luna", 0.1, false, false]]);
    expect(hints("ollama")).toEqual([["d1", undefined, false, false]]);
    expect(hints("typesafe")).toEqual([
      ["jev-1.14", 0.042, true, true],
      ["jev-1.13", 0.042, true, true],
    ]);
    // Baseten's own ids are its decision-models slugs, not OpenRouter's baseten/… ids.
    expect(hints("baseten")).toEqual([
      ["decision-models/baseten-joey-2b-latest", 0.01, false, true],
      ["decision-models/baseten-elephant-9b-latest", 0.035, false, true],
      ["decision-models/baseten-mammoth-27b-latest", 0.1, false, true],
    ]);
    expect(hints("liquid")).toEqual([
      ["d1-ultra", 0.042, false, false],
      ["d1.1", 0.02, false, true],
    ]);
    expect(hints("perplexity")).toEqual([
      ["pplx-decider-flash-v1.2", 0.01, false, false],
      ["pplx-decider-v1.2", 0.02, false, false],
    ]);
    expect(hints("deepinfra")).toEqual([
      ["nace-ai/drex-v2.0", 0.06, false, false],
      ["nace-ai/drex-v1.5", 0.04, false, false],
      ["cloudflare/clef-flash", 0.038, true, true],
    ]);
    expect(preset("openrouter").hints).toEqual([]);
    expect(preset("vllm").hints).toEqual([]);
  });

  test("hints carry the date of their prices and what is unverified into the gateway", () => {
    expect(PRICES_AS_OF).toBe("2026-11-08");
    expect(hintDescription({ id: "a", label: "A", price: 1 })).toBe("A · list price as of 2026-11-08");
    expect(hintDescription({ id: "a", label: "A", price: 1, priceUnverified: true, idUnverified: true })).toBe(
      "A · list price as of 2026-11-08, unverified · id unverified",
    );
    expect(hintDescription({ id: "a", label: "A" })).toBe("A");
    expect(presetModelHints(preset("ollama"))).toEqual([{ id: "d1", description: "d1, after ollama pull d1; runs locally" }]);
    const [first] = presetModelHints(preset("liquid"));
    expect(first).toEqual({
      id: "d1-ultra",
      price_per_m_input: 0.042,
      context: 32768,
      description: "d1-ultra, for harder decisions · list price as of 2026-11-08",
    });
    // OpenAI may also carry hints; its built-in price still wins.
    expect(presetModelHints(preset("openai"))).toMatchObject([{ id: "gpt-6-luna" }]);
    expect([kindUsesHints("systemone"), kindUsesHints("openai-compatible"), kindUsesHints("openai"), kindUsesHints("openrouter")]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  test("presets recommend a test model: OpenRouter, OpenAI, Ollama, and each vendor's cheapest confirmed hint", () => {
    const recommended = Object.fromEntries(PRESETS.filter((entry) => entry.testModel).map((entry) => [entry.id, entry.testModel]));
    expect(recommended).toEqual({
      openai: "gpt-6-luna",
      openrouter: "perplexity/pplx-decider-flash-v1.2",
      ollama: "d1",
      liquid: "d1-ultra",
      perplexity: "pplx-decider-flash-v1.2",
      deepinfra: "nace-ai/drex-v1.5",
    });
    // A vendor's test model is its cheapest hint whose id and price its docs confirm; TypeSafe and Baseten confirm none.
    for (const id of ["typesafe", "baseten", "liquid", "perplexity", "deepinfra"]) {
      expect(preset(id).testModel).toBe(cheapestConfirmedHint(preset(id))?.id);
    }
    // A provider made from a preset is saved with its test model.
    expect(presetDraft(preset("openrouter"), []).testModel).toBe("perplexity/pplx-decider-flash-v1.2");
    expect(validateConnection({ ...presetDraft(preset("openrouter"), []), secret: "sk-1" }, null).write?.test_model).toBe(
      "perplexity/pplx-decider-flash-v1.2",
    );
    expect(validateConnection({ ...presetDraft(preset("vllm"), []) }, null).write?.test_model).toBeNull();
  });

  test("small rules: names, test models, key sentences, card lines, addresses and formats", () => {
    expect(suggestProviderName(preset("typesafe"), ["openai"])).toBe("typesafe");
    expect(suggestProviderName(preset("typesafe"), ["typesafe", "typesafe-2"])).toBe("typesafe-3");
    expect(presetTestModel(preset("perplexity"))).toBe("pplx-decider-flash-v1.2");
    expect(presetTestModel(preset("vllm"))).toBeNull();
    expect(presetTestModel(undefined)).toBeNull();
    expect(keySentence(preset("baseten"))).toContain("Baseten refuses requests without your API key");
    expect(keySentence(preset("vllm"))).toContain("Only needed if the server was started with a key");
    expect(presetPriceLine(preset("baseten"))).toBe("3 models · from $0.01 / M input");
    expect(presetPriceLine(preset("openai"))).toBe("gpt-6-luna · $0.10 / M input");
    expect(presetPriceLine(preset("ollama"))).toBe("d1 · unpriced");
    expect(presetPriceLine(preset("openrouter"))).toBe("Live catalog, with prices");
    expect(presetPriceLine(preset("vllm"))).toBe("Lists its own models");
    expect(hostOf("https://api.liquid.ai")).toBe("api.liquid.ai");
    expect(hostOf("")).toBe("your address");
    expect(usesDockerHost("http://host.docker.internal:11434")).toBe(true);
    expect(usesDockerHost("https://api.typesafe.ai")).toBe(false);
    expect(usesDockerHost("")).toBe(false);
    expect([wireFor("systemone"), wireFor("openrouter"), wireFor("openai"), wireFor("openai-compatible")]).toEqual([
      "map",
      "map",
      "openai",
      "openai",
    ]);
  });
});

describe("verification", () => {
  const passed = { ok: true, at: new Date(2026, 10, 8, 12).toISOString(), latency_ms: 300, model: "jev-1.14", error: null };
  const failed = { ...passed, ok: false, error: "upstream HTTP 401" };

  test("a provider is verified on the day its last test passed, and not before", () => {
    expect(providerVerification(passed)).toEqual({ verified: true, text: "Verified 8 Nov 2026" });
    expect(providerVerification(null)).toEqual({ verified: false, text: NOT_VERIFIED });
    expect(providerVerification(failed)).toEqual({ verified: false, text: "Not verified yet: run Test with your key" });
    expect(formatDay(Number.NaN)).toBe("—");
  });

  test("a vendor preset reads not verified until a provider made from it passes; verified presets say nothing until then", () => {
    const typesafe = preset("typesafe");
    expect(presetVerification(typesafe, [])).toEqual({ verified: false, text: NOT_VERIFIED });
    expect(presetVerification(typesafe, [provider({ last_test: failed })])).toEqual({ verified: false, text: NOT_VERIFIED });
    expect(presetVerification(typesafe, [provider({ last_test: passed })])).toEqual({ verified: true, text: "Verified 8 Nov 2026" });
    // Another vendor's success says nothing about this one.
    expect(presetVerification(typesafe, [provider({ base_url: "https://api.liquid.ai", last_test: passed })])?.verified).toBe(false);
    const openai = preset("openai");
    expect(presetVerification(openai, [])).toBeNull();
    const seeded = provider({ kind: "openai", base_url: "https://api.openai.com/v1/", path: "/decisions", wire: "openai", last_test: passed });
    expect(presetVerification(openai, [seeded])?.text).toBe("Verified 8 Nov 2026");
  });

  test("a provider matches the preset it was made from; custom presets match nothing", () => {
    expect(matchesPreset(preset("typesafe"), provider())).toBe(true);
    expect(matchesPreset(preset("typesafe"), provider({ path: "/v2/systemone" }))).toBe(false);
    expect(matchesPreset(preset("typesafe"), provider({ kind: "openai-compatible" }))).toBe(false);
    expect(presetForProvider(provider())?.id).toBe("typesafe");
    expect(presetForProvider(provider({ base_url: "https://nowhere.example" }))).toBeUndefined();
    expect(matchesPreset(preset("custom-systemone"), provider({ base_url: "", path: "/v1/systemone" }))).toBe(false);
  });
});

describe("local hosts in the console", () => {
  test("the same rule as the gateway", () => {
    for (const url of [
      "http://localhost:8080",
      "http://127.0.0.1",
      "http://[::1]:1",
      "http://host.docker.internal:11434",
      "http://box.local",
      "http://10.1.2.3",
      "http://172.20.0.1",
      "http://192.168.0.9",
    ])
      expect(isLocalHost(url), url).toBe(true);
    for (const url of ["https://api.typesafe.ai", "http://172.32.0.1", "http://8.8.8.8", "nope", "", null, undefined])
      expect(isLocalHost(url), String(url)).toBe(false);
    expect(defaultSendModel("systemone", "http://host.docker.internal:8080")).toBe(false);
    expect(defaultSendModel("systemone", "https://api.typesafe.ai")).toBe(true);
    expect(defaultSendModel("openrouter", "http://localhost")).toBe(true);
  });
});

describe("the provider form with presets", () => {
  test("a vendor's draft: a free name, a pasted key, the model sent, and its hints", () => {
    const draft = presetDraft(preset("typesafe"), ["typesafe"]);
    expect(draft).toMatchObject({
      name: "typesafe-2",
      kind: "systemone",
      baseUrl: "https://api.typesafe.ai",
      path: "/v1/systemone",
      wire: "map",
      keyMode: "stored",
      envVar: "TYPESAFE_API_KEY",
      sendModel: true,
      authHeader: "authorization",
    });
    expect(parseModelHints(draft.modelHints)).toEqual({ ok: true, value: presetModelHints(preset("typesafe")) });
    expect(presetDraft(preset("perplexity"), []).maxQuestions).toBe("100");
  });

  test("local and custom presets: no key, and send_model following the address until the owner sets it", () => {
    expect(presetDraft(preset("ollama"), [])).toMatchObject({ keyMode: "none", sendModel: true, wire: "map" });
    expect(presetDraft(preset("vllm"), [])).toMatchObject({ keyMode: "none", wire: "openai", modelHints: "[]" });
    const custom = presetDraft(preset("custom-systemone"), []);
    expect(custom.baseUrl).toBe("");
    expect(withBaseUrl(custom, "http://host.docker.internal:9000", false).sendModel).toBe(false);
    expect(withBaseUrl(custom, "https://decide.example.com", false).sendModel).toBe(true);
    expect(withBaseUrl({ ...custom, sendModel: true }, "http://localhost:9000", true).sendModel).toBe(true);
  });

  test("model hints: a JSON list of known fields with unique ids", () => {
    expect(parseModelHints("")).toEqual({ ok: true, value: [] });
    expect(parseModelHints('[{"id":"a","price_per_m_input":0.5,"context":8,"description":"d"}]').ok).toBe(true);
    for (const bad of [
      "{",
      "{}",
      '[{"price_per_m_input":1}]',
      '[{"id":""}]',
      '[{"id":"a","price_per_m_input":-1}]',
      '[{"id":"a","context":1.5}]',
      '[{"id":"a","x":1}]',
      '[{"id":"a"},{"id":"a"}]',
    ])
      expect(parseModelHints(bad).ok, bad).toBe(false);
  });

  test("the key header: letters, digits and hyphens, not one the gateway sets itself", () => {
    expect(authHeaderProblem("authorization")).toBeNull();
    expect(authHeaderProblem("X-API-Key")).toBeNull();
    expect(authHeaderProblem("x api key")).toContain("letters, digits and hyphens");
    expect(authHeaderProblem("Content-Type")).toContain("sets this header itself");
    expect(authHeaderProblem("host")).toContain("sets this header itself");
  });

  test("the body carries send_model, the header in lowercase and the hints", () => {
    const draft = { ...presetDraft(preset("typesafe"), []), secret: "sk-test-1", authHeader: "X-API-Key" };
    expect(validateConnection(draft, null).write).toMatchObject({
      send_model: true,
      auth_header: "x-api-key",
      key: { source: "stored", value: "sk-test-1" },
      model_hints: presetModelHints(preset("typesafe")),
    });
    const saved = provider({ send_model: false, auth_header: "x-api-key", model_hints: [{ id: "m" }] });
    expect(connectionDraft(saved)).toMatchObject({
      sendModel: false,
      authHeader: "x-api-key",
      modelHints: JSON.stringify([{ id: "m" }], null, 2),
    });
    expect(connectionDraft({ ...saved, send_model: undefined, auth_header: undefined, model_hints: undefined })).toMatchObject({
      sendModel: true,
      authHeader: "authorization",
      modelHints: "[]",
    });
  });
});

describe("the Add provider flow", () => {
  const typesafe = preset("typesafe");

  test("four steps: preset, details, key, test; a preset in the link opens its details", () => {
    expect(ADD_PROVIDER_STEPS.map((step) => step.label)).toEqual(["Preset", "Details", "Key", "Test"]);
    expect(openingStep(typesafe)).toBe("details");
    expect(openingStep(undefined)).toBe("preset");
  });

  test("each step says what stops it, and the furthest step follows", () => {
    const empty = { presetId: null, draft: null, createdId: null };
    expect(addProviderIssue("preset", empty, [])).toBe("Choose a preset to start from.");
    expect(furthestProviderStep(empty, [])).toBe(0);
    const chosen = { presetId: "typesafe", draft: presetDraft(typesafe, []), createdId: null };
    expect(addProviderIssue("details", chosen, [])).toBeNull();
    expect(addProviderIssue("key", chosen, [])).toContain("Paste the key");
    expect(furthestProviderStep(chosen, [])).toBe(2);
    expect(furthestProviderStep({ ...chosen, createdId: "prv_1" }, [])).toBe(3);
    expect(addProviderIssue("details", chosen, ["typesafe"])).toContain('A provider named "typesafe" already exists');
    const custom = { presetId: "custom-openai", draft: presetDraft(preset("custom-openai"), []), createdId: null };
    expect(detailIssues(custom.draft, []).baseUrl).toContain("full http or https address");
  });

  test("the key step: a paste or a variable name, and a saved stored key may be kept", () => {
    const draft = presetDraft(typesafe, []);
    expect(keyIssues(draft).secret).toBeDefined();
    expect(keyIssues({ ...draft, secret: "sk-1" })).toEqual({});
    expect(keyIssues({ ...draft, keyMode: "env", envVar: "bad name" }).envVar).toBeDefined();
    expect(keyIssues({ ...draft, keyMode: "env", envVar: "TYPESAFE_API_KEY" })).toEqual({});
    expect(keyIssues(draft, provider())).toEqual({});
  });

  test("the saved body: hints only for kinds that read them", () => {
    expect(providerWrite({ ...presetDraft(typesafe, []), secret: "sk-1" })?.model_hints).toHaveLength(2);
    const openai = { ...presetDraft(preset("openai"), []), secret: "sk-1", modelHints: '[{"id":"gpt-6-luna"}]' };
    expect(providerWrite(openai)?.model_hints).toEqual([{ id: "gpt-6-luna" }]);
    expect(providerWrite(presetDraft(typesafe, []))).toBeNull();
  });
});

describe("hosted SystemOne vendors in the console's rules", () => {
  const hinted = provider({ model_hints: [{ id: "jev-1.14", price_per_m_input: 0.042 }, { id: "jev-x" }] });

  test("a hosted vendor needs a key; a local server does not", () => {
    expect(providerNeedsKey(hinted)).toBe(true);
    expect(providerNeedsKey({ ...hinted, base_url: "http://host.docker.internal:11434" })).toBe(false);
    expect(connectionStatus({ ...hinted, key: { source: "none" } })).toBe("needs-key");
    expect(keySummary({ ...hinted, key: { source: "none" } })).toBe("No key yet");
    expect(keySummary({ ...hinted, base_url: "http://localhost:11434", key: { source: "none" } })).toBe("No key needed");
    expect(suggestedEnvVar({ ...hinted, key: { source: "none" } })).toBe("TYPESAFE_API_KEY");
  });

  test("prices: a hint prices its model, the rest are unpriced, and a local server uses its hint", () => {
    expect(stepPricing({ model: "jev-1.14" }, hinted)).toBe("priced");
    expect(stepPricing({ model: "jev-x" }, hinted)).toBe("unpriced");
    expect(stepPricing({ model: "jev-1.14" }, { ...hinted, base_url: "http://host.docker.internal:11434" })).toBe("priced");
    expect(stepPricing({ model: "d1" }, { ...hinted, base_url: "http://host.docker.internal:11434" })).toBe("unpriced");
    const zero = { kind: "systemone" as const, base_url: "https://x.example", model_hints: [{ id: "d1", price_per_m_input: 0 }] };
    expect(stepPricing({ model: "d1" }, zero)).toBe("free");
    expect(connectionPricing(hinted, [])).toBe("priced");
    expect(connectionPricing({ ...hinted, model_hints: [] }, [])).toBe("unpriced");
    expect(effectivePrice(null, hinted, "jev-1.14")).toEqual({ price: 0.042, source: "hint" });
    expect(priceSummary(null, hinted, "jev-1.14")).toBe("$0.042 / M input, list price");
    expect(priceSummary(null, hinted, "jev-x")).toBe("unpriced");
    expect(defaultPriceSentence({ price: 0.042, source: "hint" })).toBe("Empty uses the list price saved with this provider: $0.042 / M input.");
  });

  test("the catalog's suggested order keeps the endpoint's order, which lists hints first", () => {
    const models = [{ id: "jev-1.14" }, { id: "jev-1.13" }, { id: "alpha" }];
    expect(searchCatalog(models, "", "listed").map((m) => m.id)).toEqual(["jev-1.14", "jev-1.13", "alpha"]);
    expect(searchCatalog(models, "", "name").map((m) => m.id)).toEqual(["alpha", "jev-1.13", "jev-1.14"]);
  });
});

describe("the mock mirrors the gateway's provider options", () => {
  const noWait = () => Promise.resolve();

  const NOW = Date.UTC(2026, 10, 8, 12);

  const mock = (storesKeys = true) => createMockApi({ now: () => NOW, delay: noWait, seed: 7, storesKeys });

  const typesafeWrite = (overrides: Partial<ProviderWrite> = {}): ProviderWrite => ({
    ...(validateConnection({ ...presetDraft(preset("typesafe"), ["typesafe"]), secret: "sk-test-9f2c" }, null).write as ProviderWrite),
    ...overrides,
  });

  test("the demo has an unverified TypeSafe provider and a first run has the disabled env-key seed", async () => {
    const demo = await mock().listProviders();
    const typesafe = demo.find((p) => p.name === "typesafe");
    expect(typesafe).toMatchObject({ kind: "systemone", send_model: true, auth_header: "authorization", last_test: null });
    expect(providerVerification(typesafe?.last_test).verified).toBe(false);
    const fresh = await createMockApi({ now: () => NOW, delay: noWait, scenario: "fresh" }).listProviders();
    expect(fresh.find((p) => p.name === "typesafe")).toMatchObject({ enabled: false, key: { source: "env", env_var: "TYPESAFE_API_KEY", present: false } });
  });

  test("a created provider gets the gateway's defaults, and bad options are refused", async () => {
    const api = mock();
    const created = await api.createProvider(typesafeWrite({ send_model: undefined, auth_header: "X-Api-Key" }));
    expect(created).toMatchObject({ send_model: true, auth_header: "x-api-key", last_test: null });
    const local = await api.createProvider({
      ...typesafeWrite(),
      name: "ollama",
      base_url: "http://host.docker.internal:11434",
      send_model: undefined,
    });
    expect(local.send_model).toBe(false);
    for (const bad of [{ auth_header: "content-type" }, { auth_header: "x y" }, { model_hints: [{ id: "a" }, { id: "a" }] }]) {
      const refused = await api.createProvider(typesafeWrite({ name: "refused", ...bad })).catch((error: unknown) => error);
      expect(refused, JSON.stringify(bad)).toBeInstanceOf(ApiError);
    }
  });

  test("the models endpoint lists the hints with their prices, and the test uses the first", async () => {
    const api = mock();
    const created = await api.createProvider(typesafeWrite());
    const models = await api.listProviderModels(created.id);
    expect(models.map((m) => [m.id, m.price_per_m_input, m.default_price_per_m_input])).toEqual([
      ["jev-1.14", 0.042, 0.042],
      ["jev-1.13", 0.042, 0.042],
    ]);
    const tested = await api.testProvider(created.id);
    expect(tested).toMatchObject({ ok: true, model: "jev-1.14" });
    const after = (await api.listProviders()).find((p) => p.id === created.id);
    expect(providerVerification(after?.last_test)).toEqual({ verified: true, text: `Verified ${formatDay(NOW)}` });
  });

  test("a decision through a hinted vendor is priced at the hint, and its wire body names the model", async () => {
    const api = mock();
    const created = await api.createProvider(typesafeWrite());
    const run = await api.runPlayground({
      model: `${created.name}::jev-1.14`,
      input: "Is this a duplicate charge?",
      questions: [{ name: "dup", type: "predicate", instructions: "Duplicate?" }],
    });
    expect(run.response?.gateway.cost_basis).toBe("upstream_tokens");
    expect(run.response?.gateway.cost_usd).toBeGreaterThan(0);
    expect(run.trace.upstream_request).toMatchObject({ model: "jev-1.14", state: "Is this a duplicate charge?" });
    const unpriced = await api.runPlayground({
      model: `${created.name}::jev-9`,
      input: "x",
      questions: [{ name: "q", type: "predicate", instructions: "?" }],
    });
    expect(unpriced.response?.gateway.cost_basis).toBe("unpriced");
  });
});
