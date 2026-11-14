// The model picker every provider test opens with (domain/test-picker.ts): the model it starts on at each place a
// test starts, why in words, the list it searches and orders, what the test sends, and why the model was tested. The
// mock's failing model list (?nocatalog=1), so the picker's error state can be shown.

import { describe, expect, test } from "bun:test";
import type { Provider, ProviderModel, Route } from "../../../src/modules/gateway/apps/console-web/src/api/types";
import { createMockApi } from "../../../src/modules/gateway/apps/console-web/src/api/mock/mock-api";
import { ApiError } from "../../../src/modules/gateway/apps/console-web/src/api/errors";
import {
  PICKER_LIMIT,
  pickReason,
  pickedModel,
  pickerCount,
  pickerList,
  pickerPrice,
  pickerSort,
  presetPhrase,
  presetTag,
  requestedModel,
  testPreset,
  testedReason,
  type TestPreset,
} from "../../../src/modules/gateway/apps/console-web/src/domain/test-picker";

const FIXED_NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

const noWait = async () => {};

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

const catalog: ProviderModel[] = [
  { id: "zeta/large", description: "Large model", price_per_m_input: 0.9, context: 128000 },
  { id: "alpha/small", description: "Small and cheap", price_per_m_input: 0.05, context: 32000 },
  { id: "mid/judge", description: "A judge", price_per_m_input: 0.2 },
  { id: "luna-decisions", price_per_m_input: 0.4, context: 64000 },
];

const ids = (list: ReturnType<typeof pickerList>) => list.rows.map((row) => (row.typed ? `typed:${row.id}` : row.id));

describe("the model a provider test starts on, per entry point", () => {
  const routes = [route("luna", true, "prv_or", "luna-decisions")];

  test("a Providers card starts on the gateway's choice, which may borrow a model's step", () => {
    expect(testPreset({ at: "card", routes }, provider(), catalog, "ready")).toEqual({
      model: "luna-decisions",
      reason: "used_by_route",
      route: "luna",
    });
    expect(testPreset({ at: "card", routes: [] }, provider({ test_model: "saved" }), catalog, "ready")).toEqual({
      model: "saved",
      reason: "provider_default",
      route: null,
    });
    expect(testPreset({ at: "card", routes: [] }, provider(), catalog, "ready")).toEqual({
      model: "alpha/small",
      reason: "cheapest",
      route: null,
    });
  });

  test("the gateway's choice from the catalog waits for the catalog, and is the gateway's to make when it fails", () => {
    expect(testPreset({ at: "card", routes: [] }, provider(), [], "loading")).toBeNull();
    expect(testPreset({ at: "card", routes: [] }, provider(), [], "failed")).toBeNull();
    // A choice that needs no catalog is known at once, also when the list fails.
    expect(testPreset({ at: "card", routes }, provider(), [], "failed")?.model).toBe("luna-decisions");
    expect(testPreset({ at: "card", routes: [] }, provider(), [], "ready")).toEqual({
      model: "server-configured",
      reason: "server_configured",
      route: null,
    });
  });

  test("the Add provider test step starts on the gateway's choice for a provider no model uses: its first hint", () => {
    const fresh = provider({ model_hints: [{ id: "jev-1.14" }, { id: "jev-2" }] });
    expect(testPreset({ at: "new" }, fresh, [], "loading")).toEqual({ model: "jev-1.14", reason: "hint", route: null });
    expect(testPreset({ at: "new" }, provider(), catalog, "ready")?.reason).toBe("cheapest");
  });

  test("a step's test starts on that step's model, and on the gateway's choice while the step has none", () => {
    expect(testPreset({ at: "step", model: " alpha/small ", routes }, provider(), catalog, "ready")).toEqual({
      model: "alpha/small",
      reason: "step",
      route: null,
    });
    // The step's model is known before the catalog loads, and whether the provider lists it or not.
    expect(testPreset({ at: "step", model: "not-listed", routes }, provider(), [], "loading")?.model).toBe("not-listed");
    expect(testPreset({ at: "step", model: "  ", routes }, provider(), catalog, "ready")?.reason).toBe("used_by_route");
  });

  test("says why in words, with a short tag for the row", () => {
    const step: TestPreset = { model: "m", reason: "step", route: null };
    const borrowed: TestPreset = { model: "m", reason: "used_by_route", route: "luna" };
    expect(presetPhrase(step, "OpenRouter")).toBe("the model this step uses");
    expect(presetPhrase(borrowed, "OpenRouter")).toBe('the model your "luna" uses');
    expect(presetPhrase({ model: "m", reason: "cheapest", route: null }, "OpenRouter")).toBe("the cheapest model in OpenRouter's catalog");
    expect(presetTag(step)).toBe("This step's model");
    expect(presetTag(borrowed)).toBe("Gateway's choice");
  });
});

describe("what the test uses and sends", () => {
  const gateway: TestPreset = { model: "luna-decisions", reason: "used_by_route", route: "luna" };
  const step: TestPreset = { model: "alpha/small", reason: "step", route: null };

  test("the owner's pick wins over the preset; with neither the gateway chooses", () => {
    expect(pickedModel(null, gateway)).toBe("luna-decisions");
    expect(pickedModel(" mine ", gateway)).toBe("mine");
    expect(pickedModel("", gateway)).toBe("luna-decisions");
    expect(pickedModel(null, null)).toBeNull();
    expect(pickReason("luna-decisions", gateway, "OpenRouter")).toBe('the model your "luna" uses');
    expect(pickReason("alpha/small", step, "OpenRouter")).toBe("the model this step uses");
    expect(pickReason("other", gateway, "OpenRouter")).toBe("the model you picked");
    expect(pickReason(null, null, "OpenRouter")).toBeNull();
  });

  test("the gateway's own choice is not sent, so it chooses and says why; a step's model and a pick are", () => {
    expect(requestedModel("luna-decisions", gateway)).toBeUndefined();
    expect(requestedModel("other", gateway)).toBe("other");
    expect(requestedModel("alpha/small", step)).toBe("alpha/small");
    expect(requestedModel("mid/judge", step)).toBe("mid/judge");
    expect(requestedModel(null, null)).toBeUndefined();
    expect(requestedModel("  ", gateway)).toBeUndefined();
  });

  test("why the model was tested, after the test", () => {
    const tested = { model: "alpha/small", model_reason: "requested" as const, model_route: null };
    expect(testedReason(tested, "alpha/small", step, "OpenRouter")).toBe("Tested with alpha/small, the model this step uses.");
    expect(testedReason({ ...tested, model: "mid/judge" }, "mid/judge", step, "OpenRouter")).toBe(
      "Tested with mid/judge, the model you picked.",
    );
    expect(testedReason({ model: "luna-decisions", model_reason: "used_by_route", model_route: "luna" }, undefined, gateway, "OpenRouter")).toBe(
      'Tested with luna-decisions, the model your "luna" uses.',
    );
    // A gateway that does not say why: a pick is still the owner's; otherwise nothing is claimed.
    expect(testedReason({ model: "x" }, "x", gateway, "OpenRouter")).toBe("Tested with x, the model you picked.");
    expect(testedReason({ model: "x" }, undefined, gateway, "OpenRouter")).toBeNull();
  });
});

describe("the picker's list", () => {
  test("with no search, the preset comes first, then the catalog in its order: by id, or the provider's own", () => {
    expect(ids(pickerList(catalog, "", { preset: "mid/judge" }))).toEqual(["mid/judge", "alpha/small", "luna-decisions", "zeta/large"]);
    expect(ids(pickerList(catalog, "", { preset: "mid/judge", sort: "listed" }))).toEqual([
      "mid/judge",
      "zeta/large",
      "alpha/small",
      "luna-decisions",
    ]);
    const list = pickerList(catalog, "", { preset: "mid/judge" });
    expect(list.rows[0]).toEqual({ id: "mid/judge", model: catalog[2]!, preset: true, typed: false });
    expect(list.rows.filter((row) => row.preset)).toHaveLength(1);
    expect(list.matched).toBe(4);
  });

  test("a preset or a pick the provider does not list still has a row, at the top, with no catalog entry", () => {
    const list = pickerList(catalog, "", { preset: "routed/unlisted", picked: "typed/own" });
    expect(ids(list).slice(0, 3)).toEqual(["routed/unlisted", "typed/own", "alpha/small"]);
    expect(list.rows[0]).toEqual({ id: "routed/unlisted", model: null, preset: true, typed: false });
    expect(list.rows[1]?.model).toBeNull();
    // A listed pick stays where the order puts it, marked by the component.
    expect(ids(pickerList(catalog, "", { preset: "mid/judge", picked: "zeta/large" }))).toEqual([
      "mid/judge",
      "alpha/small",
      "luna-decisions",
      "zeta/large",
    ]);
    // With no catalog (loading, failed or empty) the preset is the only row.
    expect(ids(pickerList([], "", { preset: "routed/unlisted" }))).toEqual(["routed/unlisted"]);
    expect(pickerList([], "", {}).rows).toEqual([]);
  });

  test("a search ranks the matches, best first, and searches the preset too", () => {
    expect(ids(pickerList(catalog, "small", { preset: "mid/judge" }))).toEqual(["alpha/small", "typed:small"]);
    // Exact before prefix before a word in the id before a description match; the preset is not pinned while searching.
    const many: ProviderModel[] = [
      { id: "x/judge-pro", description: "" },
      { id: "judge" },
      { id: "acme/a", description: "a judge model" },
      { id: "judgement-2" },
    ];
    expect(ids(pickerList(many, "judge", { preset: "acme/a" }))).toEqual(["judge", "judgement-2", "x/judge-pro", "acme/a"]);
    expect(ids(pickerList(catalog, "unlisted", { preset: "routed/unlisted" }))).toEqual(["routed/unlisted", "typed:unlisted"]);
    expect(pickerList(catalog, "unlisted", { preset: "routed/unlisted" }).matched).toBe(0);
  });

  test("the search can be used as typed, unless a row has exactly that id", () => {
    const typed = pickerList(catalog, " my/own-model ", {});
    expect(typed.rows).toEqual([{ id: "my/own-model", model: null, preset: false, typed: true }]);
    expect(typed.matched).toBe(0);
    expect(ids(pickerList(catalog, "mid/judge", {}))).toEqual(["mid/judge"]);
    // Also when the list did not load: free typing still works.
    expect(ids(pickerList([], "local-7b", { preset: "routed" }))).toEqual(["typed:local-7b"]);
  });

  test("a long catalog is capped, and says how many there are", () => {
    const long: ProviderModel[] = Array.from({ length: PICKER_LIMIT + 20 }, (_, index) => ({ id: `m/${String(index).padStart(3, "0")}` }));
    const list = pickerList(long, "", { preset: "m/110" });
    expect(list.rows).toHaveLength(PICKER_LIMIT);
    expect(list.rows[0]?.id).toBe("m/110");
    expect(list.capped).toBe(true);
    expect(pickerCount(list, long.length, "")).toBe("The first 100 of 120 models. Search to find the others.");
    expect(pickerCount(pickerList(long, "m/11", {}), long.length, "m/11")).toBe("10 of 120 models match.");
    expect(pickerCount(pickerList(catalog, "", {}), catalog.length, "")).toBe("4 models listed.");
    expect(pickerCount(pickerList([{ id: "one" }], "", {}), 1, "")).toBe("1 model listed.");
    expect(pickerCount(pickerList([], "", {}), 0, "")).toBeNull();
  });

  test("orders by the provider's own list when it suggests models, and shows a price per million input tokens", () => {
    expect(pickerSort({ model_hints: [{ id: "a" }] })).toBe("listed");
    expect(pickerSort({ model_hints: [] })).toBe("name");
    expect(pickerSort({})).toBe("name");
    expect(pickerPrice({ id: "a", price_per_m_input: 0.4, default_price_per_m_input: 0.4 })).toBe(0.4);
    expect(pickerPrice({ id: "gpt-6-luna", default_price_per_m_input: 0.1 })).toBe(0.1);
    expect(pickerPrice({ id: "free", price_per_m_input: 0 })).toBe(0);
    expect(pickerPrice({ id: "unpriced" })).toBeNull();
    expect(pickerPrice(null)).toBeNull();
  });
});

describe("the mock's failing model list", () => {
  test("?nocatalog=1 fails every model list, and a test still runs with a model typed in", async () => {
    const api = createMockApi({ now: () => FIXED_NOW, delay: noWait, seed: 7, listsModels: false });
    const providers = await api.listProviders();
    const openai = providers.find((candidate) => candidate.name === "openai");
    expect(openai).toBeDefined();
    const failure = await api.listProviderModels(openai!.id).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(502);
    const tested = await api.testProvider(openai!.id, "gpt-6-luna");
    expect(tested.ok).toBe(true);
    expect(tested.model_reason).toBe("requested");
  });

  test("by default the model lists load", async () => {
    const api = createMockApi({ now: () => FIXED_NOW, delay: noWait, seed: 7 });
    const providers = await api.listProviders();
    const openrouter = providers.find((candidate) => candidate.name === "openrouter");
    expect((await api.listProviderModels(openrouter!.id)).length).toBeGreaterThan(5);
  });
});
