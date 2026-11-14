// Drafts of a model's steps, shared by the Add model flow and the model editor: form text in, a
// route body out, with every issue pointing at its field. The Add model flow's step order and what
// each step needs before the next one opens are here too. Pure.

import type { DecisionRequest, Provider, Route, RouteTarget, RouteWrite } from "../api/types";
import { suggestModelName, validateModelName } from "./catalog";
import { parsePrice, priceText } from "./cost";
import { knownAnswerRequest } from "./known-answer";

export interface StepDraft {
  rowId: string;
  providerId: string;
  model: string;
  /** USD per million input tokens, as typed. Empty uses the default price. */
  price: string;
  /** USD per million output tokens, as typed. Empty (or absent) uses the provider's default output price. */
  outputPrice?: string;
  /** True while `price` holds the catalog's price rather than one the owner typed. */
  priceFromCatalog: boolean;
  /** Milliseconds as typed. Empty uses the provider's timeout. */
  timeoutMs: string;
}

export interface StepIssues {
  provider?: string;
  model?: string;
  price?: string;
  outputPrice?: string;
  timeout?: string;
}

let sequence = 0;

export function newStep(providerId = "", model = "", price = "", timeoutMs = ""): StepDraft {
  sequence += 1;
  return { rowId: `step-${sequence}`, providerId, model, price, priceFromCatalog: false, timeoutMs };
}

export function stepFromTarget(target: RouteTarget): StepDraft {
  const step = newStep(
    target.provider_id,
    target.model,
    priceText(target.price_per_m_input),
    target.timeout_ms === undefined ? "" : String(target.timeout_ms),
  );
  return { ...step, outputPrice: priceText(target.price_per_m_output) };
}

export function validateStep(step: StepDraft): StepIssues {
  const issues: StepIssues = {};
  if (step.providerId.length === 0) issues.provider = "Choose a provider.";
  if (step.model.trim().length === 0) issues.model = "Pick an upstream model, or type the id this provider expects.";
  const price = parsePrice(step.price);
  if (!price.ok) issues.price = price.message;
  const output = parsePrice(step.outputPrice ?? "", "output");
  if (!output.ok) issues.outputPrice = output.message;
  const timeout = step.timeoutMs.trim();
  if (timeout.length > 0) {
    const value = Number(timeout);
    if (!Number.isInteger(value) || value < 100 || value > 600000) issues.timeout = "Use a whole number from 100 to 600000, or leave it empty.";
  }
  return issues;
}

export function hasIssues(issues: StepIssues): boolean {
  return Object.keys(issues).length > 0;
}

/** A step as the route body carries it. Call only once `validateStep` finds nothing. */
export function targetFromStep(step: StepDraft): RouteTarget {
  const target: RouteTarget = { provider_id: step.providerId, model: step.model.trim() };
  const timeout = step.timeoutMs.trim();
  if (timeout.length > 0) target.timeout_ms = Number(timeout);
  const price = parsePrice(step.price);
  if (price.ok && price.value !== null) target.price_per_m_input = price.value;
  const output = parsePrice(step.outputPrice ?? "", "output");
  if (output.ok && output.value !== null) target.price_per_m_output = output.value;
  return target;
}

/**
 * A pick from the catalog: the upstream id, and its catalog price when the price field is empty or
 * still holds an earlier catalog price. A price the owner typed is kept.
 */
export function pickUpstream(step: StepDraft, model: string, catalogPrice: number | undefined): StepDraft {
  const next: StepDraft = { ...step, model };
  if (step.price.trim().length === 0 || step.priceFromCatalog) {
    next.price = catalogPrice === undefined ? "" : priceText(catalogPrice);
    next.priceFromCatalog = catalogPrice !== undefined;
  }
  return next;
}

/** The price field as typed by the owner, which stops it following the catalog. */
export function typePrice(step: StepDraft, price: string): StepDraft {
  return { ...step, price, priceFromCatalog: false };
}

// ---------- The Add model flow ----------

export const ADD_MODEL_STEPS = [
  { id: "connection", label: "Choose a provider" },
  { id: "upstream", label: "Upstream model" },
  { id: "name", label: "Name" },
  { id: "fallback", label: "Fallback" },
  { id: "test", label: "Test" },
  { id: "save", label: "Save" },
] as const;

export type AddModelStepId = (typeof ADD_MODEL_STEPS)[number]["id"];

export interface AddModelDraft {
  /** The first step, then any fallbacks, in the order they are tried. */
  steps: StepDraft[];
  name: string;
  /** True once the owner edits the name, so a later pick no longer renames the model. */
  nameEdited: boolean;
  description: string;
}

export function emptyAddModel(providerId = ""): AddModelDraft {
  return { steps: [newStep(providerId)], name: "", nameEdited: false, description: "" };
}

export function stepIndexOf(id: AddModelStepId): number {
  return ADD_MODEL_STEPS.findIndex((step) => step.id === id);
}

/** What keeps a flow step from being finished, or null when it is. */
export function addModelIssue(id: AddModelStepId, draft: AddModelDraft, taken: readonly string[]): string | null {
  const [primary, ...fallbacks] = draft.steps;
  if (id === "connection") return primary && primary.providerId ? null : "Choose a provider.";
  if (id === "upstream") {
    if (!primary) return "Choose a provider.";
    const issues = validateStep(primary);
    return issues.model ?? issues.price ?? issues.outputPrice ?? null;
  }
  if (id === "name") return validateModelName(draft.name, taken);
  if (id === "fallback") {
    for (const [index, step] of fallbacks.entries()) {
      const issues = validateStep(step);
      const first = issues.provider ?? issues.model ?? issues.price ?? issues.outputPrice;
      if (first) return `Fallback ${index + 1}: ${first}`;
    }
    return null;
  }
  return null;
}

/** The furthest flow step the owner can open: every step before it is finished. */
export function furthestStep(draft: AddModelDraft, taken: readonly string[]): number {
  const blocked = ADD_MODEL_STEPS.findIndex((step) => addModelIssue(step.id, draft, taken) !== null);
  return blocked === -1 ? ADD_MODEL_STEPS.length - 1 : blocked;
}

/** Picks the first step's upstream model; the name follows it until the owner edits the name. */
export function pickPrimaryUpstream(
  draft: AddModelDraft,
  model: string,
  catalogPrice: number | undefined,
  taken: readonly string[],
): AddModelDraft {
  const [primary, ...rest] = draft.steps;
  if (!primary) return draft;
  const next = { ...draft, steps: [pickUpstream(primary, model, catalogPrice), ...rest] };
  if (!draft.nameEdited) next.name = model.trim() ? suggestModelName(model, taken) : "";
  return next;
}

export function routeFromAddModel(draft: AddModelDraft): RouteWrite {
  return { alias: draft.name.trim(), description: draft.description.trim(), enabled: true, targets: draft.steps.map(targetFromStep) };
}

/**
 * The test for an unsaved step: the known-answer check sent to "provider::model", which bypasses
 * models, because the model does not exist until it is saved.
 */
export function directTestRequest(step: Pick<StepDraft, "providerId" | "model">, providers: readonly Provider[]): DecisionRequest | null {
  const provider = providers.find((candidate) => candidate.id === step.providerId);
  if (!provider || step.model.trim().length === 0) return null;
  return knownAnswerRequest(`${provider.name}::${step.model.trim()}`);
}

/** Model names in use, for uniqueness checks. */
export function takenNames(routes: readonly Pick<Route, "alias">[]): string[] {
  return routes.map((route) => route.alias);
}
