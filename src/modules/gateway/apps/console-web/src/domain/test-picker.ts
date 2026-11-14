// The model picker every provider test opens with: the model it starts on at each place a test starts (a Providers
// card, the Add provider test step, a step's test in the model editor) and why, in words; the provider's models as a
// list to search, in a sensible order and capped; what the test then sends; and why the model was tested. Pure.

import type { Provider, ProviderModel, ProviderTestResult, Route, TestModelReason } from "../api/types";
import { searchCatalog, type CatalogSort } from "./catalog";
import { listedTestModel, preferredTestModel, reasonPhrase, reasonSentence } from "./test-model";

/** Where a provider test starts. */
export type TestEntry =
  /** A Providers card: the gateway's choice, which may borrow the model one of the owner's models sends it. */
  | { at: "card"; routes: readonly Route[] }
  /** The Add provider test step: the gateway's choice for a provider that no model uses yet. */
  | { at: "new" }
  /** A step's test in the model editor: the step's own model; the gateway's choice while the step has none. */
  | { at: "step"; model: string; routes: readonly Route[] };

/** Why the picker starts on a model: one of the gateway's reasons, or the step's own model. */
export type PresetReason = TestModelReason | "step";

export interface TestPreset {
  model: string;
  reason: PresetReason;
  /** The model (route) whose step the gateway would borrow, when that is the reason. */
  route: string | null;
}

/** Whether the provider's model list could be used: still loading, read, or failed. */
export type CatalogStatus = "loading" | "ready" | "failed";

type PresetProvider = Pick<Provider, "id"> & Partial<Pick<Provider, "test_model" | "model_hints">>;

/** The most rows the picker draws; a longer list is narrowed by searching. */
export const PICKER_LIMIT = 100;

/**
 * The model the picker starts on. A step's test starts on that step's model. Otherwise it is the model the gateway
 * would choose: one it can name without the catalog, else the catalog's pick, which is null (the gateway chooses)
 * while the catalog loads or when it could not be read.
 */
export function testPreset(
  entry: TestEntry,
  provider: PresetProvider,
  models: readonly ProviderModel[],
  status: CatalogStatus,
): TestPreset | null {
  const stepModel = entry.at === "step" ? entry.model.trim() : "";
  if (stepModel) return { model: stepModel, reason: "step", route: null };
  const preferred = preferredTestModel(undefined, provider, entry.at === "new" ? [] : entry.routes);
  if (preferred) return preferred;
  return status === "ready" ? listedTestModel(models) : null;
}

/** Why the preset, as the end of a sentence: "the model this step uses", "the model your "luna" uses". */
export function presetPhrase(preset: TestPreset, title: string): string {
  return preset.reason === "step" ? "the model this step uses" : reasonPhrase(preset.reason, preset.route, title);
}

/** The short tag on the preset's row. */
export function presetTag(preset: TestPreset): string {
  return preset.reason === "step" ? "This step's model" : "Gateway's choice";
}

/** The model the test uses: the owner's pick, else the preset, else none (the gateway chooses). */
export function pickedModel(picked: string | null, preset: TestPreset | null): string | null {
  const own = picked?.trim() ?? "";
  return own || preset?.model || null;
}

/** Why the picked model, as the end of a sentence; null when the gateway will choose. */
export function pickReason(model: string | null, preset: TestPreset | null, title: string): string | null {
  if (model === null) return null;
  return preset && model === preset.model ? presetPhrase(preset, title) : "the model you picked";
}

/**
 * The model the test sends. The gateway's own choice is not sent, so the gateway chooses and says why; a step's
 * model and the owner's pick are.
 */
export function requestedModel(model: string | null, preset: TestPreset | null): string | undefined {
  const trimmed = model?.trim() ?? "";
  if (!trimmed) return undefined;
  if (preset && preset.reason !== "step" && trimmed === preset.model) return undefined;
  return trimmed;
}

/**
 * Why the model was tested, after the test: "Tested with mock-1, the model this step uses." for a step's model the
 * test sent, else the gateway's reason ("Tested with x, the model you picked." for a pick). Null when the gateway
 * did not say.
 */
export function testedReason(
  result: Pick<ProviderTestResult, "model" | "model_reason" | "model_route">,
  sent: string | undefined,
  preset: TestPreset | null,
  title: string,
): string | null {
  if (sent !== undefined && preset?.reason === "step" && sent === preset.model && result.model === sent) {
    return `Tested with ${sent}, ${presetPhrase(preset, title)}.`;
  }
  const reason = result.model_reason ?? (sent !== undefined ? "requested" : null);
  return reason ? reasonSentence(result.model, reason, result.model_route, title) : null;
}

/** One row of the picker: a listed model, a model the provider does not list (the preset or a pick), or the search as typed. */
export interface PickerRow {
  id: string;
  /** The catalog's entry; null for a model the provider does not list. */
  model: ProviderModel | null;
  /** The model the picker started on. */
  preset: boolean;
  /** The search text, offered to test exactly as typed. */
  typed: boolean;
}

export interface PickerList {
  rows: PickerRow[];
  /** How many models match the search, before the cap. */
  matched: number;
  /** True when more models match than are drawn. */
  capped: boolean;
}

/** The order of a provider's models: its own when it suggests models (its hints come first), else by id. */
export function pickerSort(provider: Partial<Pick<Provider, "model_hints">>): CatalogSort {
  return (provider.model_hints?.length ?? 0) > 0 ? "listed" : "name";
}

/** The ids given, without blanks and repeats, in order. */
function distinct(ids: readonly (string | null | undefined)[]): string[] {
  return ids.filter((id, index): id is string => !!id && ids.indexOf(id) === index);
}

/**
 * The picker's rows. With no search: the preset first, then a pick the provider does not list, then the catalog in
 * `sort` order. With a search: the matches, best first (the preset and an unlisted pick are searched too), then the
 * search itself as typed when no row has exactly that id. At most `limit` models are drawn.
 */
export function pickerList(
  models: readonly ProviderModel[],
  query: string,
  options: { preset?: string | null; picked?: string | null; sort?: CatalogSort; limit?: number } = {},
): PickerList {
  const { preset = null, picked = null, sort = "name", limit = PICKER_LIMIT } = options;
  const listed = new Map(models.map((model) => [model.id, model]));
  const unlisted = distinct([preset, picked]).filter((id) => !listed.has(id));
  const needle = query.trim();
  let ordered: ProviderModel[];
  if (needle) {
    ordered = searchCatalog([...unlisted.map((id) => ({ id })), ...models], needle, sort);
  } else {
    const head = distinct([preset, ...unlisted]);
    const rest = searchCatalog(models, "", sort).filter((model) => !head.includes(model.id));
    ordered = [...head.map((id) => listed.get(id) ?? { id }), ...rest];
  }
  const rows: PickerRow[] = ordered.slice(0, limit).map((model) => ({
    id: model.id,
    model: listed.get(model.id) ?? null,
    preset: model.id === preset,
    typed: false,
  }));
  if (needle && !rows.some((row) => row.id === needle)) rows.push({ id: needle, model: null, preset: false, typed: true });
  return { rows, matched: ordered.filter((model) => listed.has(model.id)).length, capped: ordered.length > limit };
}

/** The price to show for a model: the catalog's price, else the price the gateway charges by default. */
export function pickerPrice(model: ProviderModel | null): number | null {
  return model?.price_per_m_input ?? model?.default_price_per_m_input ?? null;
}

/** The line under the list: how many models are shown or match. Null when the provider lists none. */
export function pickerCount(list: PickerList, total: number, query: string): string | null {
  if (total === 0) return null;
  const models = total === 1 ? "1 model" : `${total} models`;
  if (query.trim()) return `${list.matched} of ${models} match.`;
  if (list.capped) return `The first ${list.rows.filter((row) => row.model !== null).length} of ${models}. Search to find the others.`;
  return `${models} listed.`;
}
