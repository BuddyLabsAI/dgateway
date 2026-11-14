// A model's chain of steps (the API's route targets) in plain terms: which connection is tried
// first, and what runs when it fails. Pure.

import type { Provider, RouteTarget } from "../api/types";
import { connectionTitle } from "./connections";

export interface ChainStep {
  position: number;
  providerId: string;
  /** The connection's name, as logs carry it. */
  providerName: string;
  /** What the console calls the provider ("OpenAI" for the seeded "openai"). */
  title: string;
  model: string;
  timeoutMs: number | null;
  /** False when the step points at a connection that no longer exists. */
  providerKnown: boolean;
}

export function routeChain(targets: readonly RouteTarget[], providers: readonly Provider[]): ChainStep[] {
  return targets.map((target, index) => {
    const provider = providers.find((candidate) => candidate.id === target.provider_id);
    const name = provider?.name ?? (target.provider_id ? "unknown provider" : "no provider");
    return {
      position: index + 1,
      providerId: target.provider_id,
      providerName: name,
      title: provider ? connectionTitle(provider.name, provider.kind) : name,
      model: target.model,
      timeoutMs: target.timeout_ms ?? null,
      providerKnown: provider !== undefined,
    };
  });
}

/** One step as words: the provider and the upstream model. */
export function stepText(step: Pick<ChainStep, "title" | "model">): string {
  return step.model.length > 0 ? `${step.title} ${step.model}` : step.title;
}

/** "OpenAI gpt-6-luna → then OpenRouter openai/gpt-6-luna-decisions", or a warning when there are no steps. */
export function chainSentence(steps: readonly Pick<ChainStep, "title" | "model">[]): string {
  if (steps.length === 0) return "No steps yet. Apps that send this model get an error until you add one.";
  return steps.map(stepText).join(" → then ");
}

/** The label above a step on the line and in the editor. */
export function stepRole(position: number): string {
  return position <= 1 ? "Try first" : "If that fails, then";
}
