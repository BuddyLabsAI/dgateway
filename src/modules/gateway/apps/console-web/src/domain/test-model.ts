// Which model a provider test uses, and why, in words. The order mirrors the gateway's (the API reference,
// Providers): the model you pick, the model one of your models sends this provider, the provider's test model, its
// first suggested model, the cheapest priced model it lists, the first it lists, and last the server-configured
// placeholder. The console works it out only to show the default before a test runs; the gateway decides. Pure.

import type { Provider, ProviderModel, Route, TestModelReason } from "../api/types";

/** The model id the gateway sends when it knows no model: the server answers with the one it serves. */
export const SERVER_CONFIGURED = "server-configured";

export interface TestModelChoice {
  model: string;
  reason: TestModelReason;
  /** The model (route) whose step was borrowed, when that is the reason. */
  route: string | null;
}

type ChoiceProvider = Pick<Provider, "id"> & Partial<Pick<Provider, "test_model" | "model_hints">>;

function choice(model: string, reason: TestModelReason, route: string | null = null): TestModelChoice {
  return { model, reason, route };
}

/** The first enabled model (route) with a step on the provider, else the first such model, and that step's upstream model. */
function routeUsing(providerId: string, routes: readonly Route[]): { alias: string; model: string } | null {
  const using = routes.filter((route) => route.targets.some((target) => target.provider_id === providerId));
  const route = using.find((candidate) => candidate.enabled) ?? using[0];
  const target = route?.targets.find((candidate) => candidate.provider_id === providerId);
  return route && target ? { alias: route.alias, model: target.model } : null;
}

/** The test model that needs no catalog: the one asked for, a model's step, the provider's test model, or its first hint. */
export function preferredTestModel(requested: string | undefined, provider: ChoiceProvider, routes: readonly Route[]): TestModelChoice | null {
  if (requested !== undefined) return choice(requested, "requested");
  const routed = routeUsing(provider.id, routes);
  if (routed) return choice(routed.model, "used_by_route", routed.alias);
  if (provider.test_model) return choice(provider.test_model, "provider_default");
  const hint = provider.model_hints?.[0];
  return hint ? choice(hint.id, "hint") : null;
}

/** The test model from the provider's catalog: the cheapest priced model (ties by id), the first listed, or the placeholder. */
export function listedTestModel(models: readonly ProviderModel[]): TestModelChoice {
  const listed = models.filter((model) => model.id !== SERVER_CONFIGURED);
  const [cheapest] = listed
    .filter((model) => model.price_per_m_input !== undefined)
    .sort((a, b) => (a.price_per_m_input ?? 0) - (b.price_per_m_input ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (cheapest) return choice(cheapest.id, "cheapest");
  const [first] = listed;
  return first ? choice(first.id, "first_listed") : choice(SERVER_CONFIGURED, "server_configured");
}

/** The model a provider test uses, in the gateway's order. */
export function chooseTestModel(
  requested: string | undefined,
  provider: ChoiceProvider,
  routes: readonly Route[],
  models: readonly ProviderModel[],
): TestModelChoice {
  return preferredTestModel(requested, provider, routes) ?? listedTestModel(models);
}

/**
 * Why a model was tested, as the end of a sentence: "the model your "luna" uses", "the cheapest model in OpenRouter's
 * catalog". `title` is the provider as the console names it.
 */
export function reasonPhrase(reason: TestModelReason, route: string | null | undefined, title: string): string {
  switch (reason) {
    case "requested":
      return "the model you picked";
    case "used_by_route":
      return route ? `the model your "${route}" uses` : "the model one of your models uses";
    case "provider_default":
      return `the test model set for ${title}`;
    case "hint":
      return `the first model suggested for ${title}`;
    case "cheapest":
      return `the cheapest model in ${title}'s catalog`;
    case "first_listed":
      return `the first model ${title} lists`;
    case "server_configured":
      return "a placeholder: the server answers with the model it serves";
  }
}

/** "Tested with perplexity/pplx-decider-flash-v1.2, the model your "pplx-decider-flash-v1-2" uses." */
export function reasonSentence(model: string, reason: TestModelReason, route: string | null | undefined, title: string): string {
  return `Tested with ${model}, ${reasonPhrase(reason, route, title)}.`;
}

/** The reason as a hint of its own, under the model picker: "The model your "luna" uses." */
export function reasonHint(reason: TestModelReason, route: string | null | undefined, title: string): string {
  const phrase = reasonPhrase(reason, route, title);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`;
}
