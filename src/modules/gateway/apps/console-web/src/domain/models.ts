// Models (the API's routes) in the owner's terms: each one's status, derived from the providers
// its steps use, and the figures a row on the Models page shows. Pure.

import type { Provider, ProviderModel, Route, RouteStats } from "../api/types";
import { routeChain, chainSentence, type ChainStep } from "./chain";
import { connectionStatus, connectionTitle, type ConnectionStatus } from "./connections";
import { errorRate, type StationStatus } from "./health";
import { modelPricing, pricingWithTraffic, type PricingView } from "./pricing";

export type ModelState = "ready" | "partial" | "broken" | "off";

export const MODEL_STATE_MARK: Record<ModelState, StationStatus> = { ready: "ok", partial: "degraded", broken: "failing", off: "disabled" };

export interface ModelVerdict {
  state: ModelState;
  status: StationStatus;
  /** A short phrase for a chip: "Ready", "Fallback needs a key", "Can't answer". */
  word: string;
  /** One sentence on why. */
  reason: string;
}

type StepState = ConnectionStatus | "missing";

function stepState(target: { provider_id: string }, providers: readonly Provider[]): { state: StepState; title: string } {
  const provider = providers.find((candidate) => candidate.id === target.provider_id);
  if (!provider) return { state: "missing", title: "a removed provider" };
  return { state: connectionStatus(provider), title: connectionTitle(provider.name, provider.kind) };
}

const STATE_WORD: Record<StepState, string> = { connected: "ready", "needs-key": "needs a key", disabled: "disabled", missing: "missing" };

function problem(state: StepState, title: string): string {
  if (state === "needs-key") return `${title} needs a key`;
  if (state === "disabled") return `${title} is disabled`;
  return `a step points at ${title}`;
}

/**
 * A model's status from its steps' connections: off when the model is disabled; can't answer when
 * no step can; partly ready when some step is skipped (no key, disabled, or gone); ready otherwise.
 */
export function modelVerdict(route: Pick<Route, "enabled" | "targets">, providers: readonly Provider[]): ModelVerdict {
  if (!route.enabled) return { state: "off", status: "disabled", word: "Disabled", reason: "Apps that send this model get an error." };
  if (route.targets.length === 0) return { state: "broken", status: "failing", word: "No steps", reason: "Add a step so the model can answer." };
  const steps = route.targets.map((target) => stepState(target, providers));
  const usable = steps.map((step) => step.state === "connected");
  const firstBad = steps.findIndex((step) => step.state !== "connected");
  if (!usable.some(Boolean)) {
    return {
      state: "broken",
      status: "failing",
      word: "Can't answer",
      reason: `Every step is skipped: ${steps.map((step) => problem(step.state, step.title)).join(", ")}.`,
    };
  }
  if (firstBad === -1) return { state: "ready", status: "ok", word: "Ready", reason: "Every step's provider is ready." };
  const bad = steps[firstBad];
  const reason = bad ? `${capitalise(problem(bad.state, bad.title))}, so that step is skipped.` : "A step is skipped.";
  const which = firstBad === 0 ? "First step" : firstBad === 1 ? "Fallback" : `Step ${firstBad + 1}`;
  return { state: "partial", status: "degraded", word: `${which} ${STATE_WORD[bad?.state ?? "missing"]}`, reason };
}

function capitalise(text: string): string {
  return text.length > 0 ? `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}` : text;
}

export interface ModelTally {
  ready: number;
  attention: number;
  off: number;
}

/** Counts for "N models ready · M need attention". */
export function modelTally(routes: readonly Route[], providers: readonly Provider[]): ModelTally {
  const tally: ModelTally = { ready: 0, attention: 0, off: 0 };
  for (const route of routes) {
    const { state } = modelVerdict(route, providers);
    if (state === "ready") tally.ready += 1;
    else if (state === "off") tally.off += 1;
    else tally.attention += 1;
  }
  return tally;
}

export interface ModelRow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  ink: number;
  steps: ChainStep[];
  sentence: string;
  verdict: ModelVerdict;
  /** Whether its requests can be priced, so "$0" is never shown for unpriced or free traffic. */
  pricing: PricingView;
  requests: number;
  errors: number;
  errorRate: number | null;
  p50: number | null;
  /** USD in the window; null when the gateway reports no cost. */
  cost: number | null;
}

export const MODEL_INKS = 5;

/**
 * One row per model, in list order, joined with its traffic in the window. Its pricing label comes from the
 * traffic's unpriced count once there is traffic; `catalogs` (by connection id) reads OpenAI defaults.
 */
export function modelRows(
  routes: readonly Route[],
  providers: readonly Provider[],
  stats: readonly RouteStats[] = [],
  catalogs: ReadonlyMap<string, readonly ProviderModel[]> = new Map(),
): ModelRow[] {
  return routes.map((route, index) => {
    const steps = routeChain(route.targets, providers);
    const traffic = stats.find((row) => row.route === route.alias);
    const requests = traffic?.requests ?? 0;
    const errors = traffic?.errors ?? 0;
    const configured = modelPricing(route, providers, catalogs);
    return {
      id: route.id,
      name: route.alias,
      description: route.description,
      enabled: route.enabled,
      ink: index % MODEL_INKS,
      steps,
      sentence: chainSentence(steps),
      verdict: modelVerdict(route, providers),
      pricing: { pricing: pricingWithTraffic(configured.pricing, traffic), unpricedStep: configured.unpricedStep },
      requests,
      errors,
      errorRate: errorRate(errors, requests),
      p50: traffic?.p50_ms ?? null,
      cost: traffic ? (traffic.cost_usd ?? null) : 0,
    };
  });
}

/** A model by id or by name, as links carry either. */
export function findModel(routes: readonly Route[], idOrName: string): Route | undefined {
  return routes.find((route) => route.id === idOrName) ?? routes.find((route) => route.alias === idOrName);
}
