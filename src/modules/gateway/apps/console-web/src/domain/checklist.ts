// The first-run checklist on Overview: connect a provider, add a model on it, send a test decision.
// Each step is decided from what the gateway reports; dismissal is the owner's choice and is
// remembered by the effect layer. Pure.

import type { Provider, Route } from "../api/types";
import { connectionStatus } from "./connections";

export type ChecklistStepId = "connect" | "model" | "test";

export interface ChecklistStep {
  id: ChecklistStepId;
  done: boolean;
}

export interface ChecklistInput {
  providers: readonly Provider[];
  routes: readonly Route[];
  /** Model names that have at least one answered request in the log. */
  answeredModels: ReadonlySet<string>;
  dismissed: boolean;
}

export interface ChecklistState {
  steps: ChecklistStep[];
  done: number;
  complete: boolean;
  /** Shown until every step is done or the owner dismisses it. */
  visible: boolean;
  /** The first step not done yet, or null when all are. */
  current: ChecklistStepId | null;
  /** The first connection that counts for step 1, for links. */
  connection: Provider | null;
  /** The first model that counts for step 2, for links. */
  model: Route | null;
}

/** Connections that count as "a provider connected": enabled, not the mock, and with the key it needs. */
export function realConnections(providers: readonly Provider[]): Provider[] {
  return providers.filter((provider) => provider.kind !== "mock" && connectionStatus(provider) === "connected");
}

/** Enabled models with at least one step on a real connection. */
export function realModels(routes: readonly Route[], providers: readonly Provider[]): Route[] {
  const ids = new Set(realConnections(providers).map((provider) => provider.id));
  return routes.filter((route) => route.enabled && route.targets.some((target) => ids.has(target.provider_id)));
}

export function checklistState(input: ChecklistInput): ChecklistState {
  const connections = realConnections(input.providers);
  const models = realModels(input.routes, input.providers);
  const connectionIds = new Set(connections.map((provider) => provider.id));
  const tested = models.some(
    (route) =>
      input.answeredModels.has(route.alias) ||
      route.targets.some(
        (target) => connectionIds.has(target.provider_id) && input.providers.find((p) => p.id === target.provider_id)?.last_test?.ok === true,
      ),
  );
  const steps: ChecklistStep[] = [
    { id: "connect", done: connections.length > 0 },
    { id: "model", done: models.length > 0 },
    { id: "test", done: tested },
  ];
  const done = steps.filter((step) => step.done).length;
  const complete = done === steps.length;
  return {
    steps,
    done,
    complete,
    visible: !complete && !input.dismissed,
    current: steps.find((step) => !step.done)?.id ?? null,
    connection: connections[0] ?? null,
    model: models[0] ?? null,
  };
}
