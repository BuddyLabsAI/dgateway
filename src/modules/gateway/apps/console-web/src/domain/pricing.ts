// Whether a model's (or a connection's) requests can be priced. Configuration gives the hint, and the
// gateway's own unpriced counts decide once there is traffic: a model whose steps have no known price
// would otherwise read as "$0". This tells "free" and "unpriced" apart. Pure.

import type { Provider, ProviderModel, Route, RouteTarget } from "../api/types";
import { defaultPrice, pricedProvider, type PricedProvider, type PriceSubject } from "./cost";

/**
 * "catalog" means the price depends on the provider's catalog, which is not loaded here (OpenRouter
 * always, OpenAI until its models have loaded).
 */
export type StepPricing = "priced" | "free" | "unpriced" | "catalog";

/**
 * A step's pricing from its configuration. The catalog (a connection's models, by id) is needed for
 * an OpenAI step's default; until it has loaded, that step reads as "catalog". The mock defaults to zero;
 * a SystemOne provider or an OpenAI-compatible server is priced by its provider's model hints, and unpriced without one for the model.
 */
export function stepPricing(
  target: Pick<RouteTarget, "model" | "price_per_m_input">,
  subject: PriceSubject | null | undefined,
  catalog?: readonly ProviderModel[],
): StepPricing {
  const override = target.price_per_m_input;
  if (override !== null && override !== undefined && Number.isFinite(override)) return override === 0 ? "free" : "priced";
  const provider = pricedProvider(subject);
  if (!provider) return "unpriced";
  if (provider.kind === "openai") {
    if (catalog === undefined) return "catalog";
    return defaultPrice(provider, target.model, catalog).price !== null ? "priced" : "unpriced";
  }
  if (provider.kind === "openrouter") return "catalog";
  const resolved = defaultPrice(provider, target.model, catalog ?? []);
  if (resolved.price === null) return "unpriced";
  return resolved.price === 0 ? "free" : "priced";
}

export type GroupPricing = "free" | "priced" | "unpriced" | "partly-unpriced";

export interface PricingView {
  pricing: GroupPricing;
  /** The first step (1-based) with no known price, for "Set a price" links. */
  unpricedStep: number | null;
}

function combine(states: readonly StepPricing[]): GroupPricing {
  const paying = states.filter((state) => state !== "free");
  if (paying.length === 0) return states.length === 0 ? "priced" : "free";
  const unpriced = paying.filter((state) => state === "unpriced").length;
  if (unpriced === 0) return "priced";
  return unpriced === paying.length ? "unpriced" : "partly-unpriced";
}

/**
 * A model's pricing over its steps: free when every step is free, unpriced when every paying step lacks a
 * price. `catalogs` maps a connection id to its model catalog, for the providers whose catalog has loaded.
 */
export function modelPricing(
  route: Pick<Route, "targets">,
  providers: readonly Provider[],
  catalogs: ReadonlyMap<string, readonly ProviderModel[]> = new Map(),
): PricingView {
  const states = route.targets.map((target) => {
    const provider = providers.find((candidate) => candidate.id === target.provider_id);
    return stepPricing(target, provider, catalogs.get(target.provider_id));
  });
  const index = states.indexOf("unpriced");
  return { pricing: combine(states), unpricedStep: index >= 0 ? index + 1 : null };
}

/** A connection's pricing over every model step that uses it. With no steps, the provider itself decides. */
export function connectionPricing(
  provider: Pick<Provider, "id"> & PricedProvider,
  routes: readonly Route[],
  catalog?: readonly ProviderModel[],
): GroupPricing {
  const states = routes.flatMap((route) =>
    route.targets.filter((target) => target.provider_id === provider.id).map((target) => stepPricing(target, provider, catalog)),
  );
  if (states.length > 0) return combine(states);
  // With no steps, a model the provider's hints price stands for it.
  const hinted = provider.model_hints?.find((hint) => hint.price_per_m_input !== undefined);
  return combine([stepPricing({ model: hinted?.id ?? "" }, provider, catalog)]);
}

/** The traffic a model or a connection had in the window, as the stats report it. */
export interface PricedTraffic {
  requests: number;
  errors: number;
  /** Answered requests that could not be priced. Absent on a gateway that does not report it. */
  unpriced?: number;
}

/**
 * The pricing label once traffic is known. The gateway's unpriced count decides "unpriced" and
 * "partly-unpriced", and a model with traffic that was all priced reads as priced whatever its steps
 * say. Without traffic, or on a gateway that reports no count, the configuration's hint stands.
 */
export function pricingWithTraffic(config: GroupPricing, traffic: PricedTraffic | undefined): GroupPricing {
  if (!traffic || traffic.unpriced === undefined) return config;
  const answered = traffic.requests - traffic.errors;
  if (answered <= 0) return config;
  if (traffic.unpriced === 0) return config === "free" ? "free" : "priced";
  return traffic.unpriced >= answered ? "unpriced" : "partly-unpriced";
}
