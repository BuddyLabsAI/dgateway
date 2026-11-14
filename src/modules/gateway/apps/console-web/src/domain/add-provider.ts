// The Add provider flow: a preset, its details, the key, then a test. The steps, what stops each
// one, and how far the owner may jump ahead. The provider is created when the key step is saved, so the
// test runs on the real provider. Pure.

import type { Provider, ProviderWrite } from "../api/types";
import { validateConnection, type ConnectionDraft, type ConnectionField } from "./connection-form";
import { kindUsesHints, presetById, type ProviderPreset } from "./provider-presets";

export const ADD_PROVIDER_STEPS = [
  { id: "preset", label: "Preset" },
  { id: "details", label: "Details" },
  { id: "key", label: "Key" },
  { id: "test", label: "Test" },
] as const;

export type AddProviderStepId = (typeof ADD_PROVIDER_STEPS)[number]["id"];

export interface AddProviderState {
  presetId: string | null;
  /** The form, once a preset is chosen. */
  draft: ConnectionDraft | null;
  /** The provider's id once the key step has created it. */
  createdId: string | null;
}

export function stepIndex(id: AddProviderStepId): number {
  return ADD_PROVIDER_STEPS.findIndex((step) => step.id === id);
}

const DETAIL_FIELDS: readonly ConnectionField[] = [
  "syntheticMethods", "samplingN",
  "name",
  "baseUrl",
  "path",
  "authHeader",
  "timeoutMs",
  "maxQuestions",
  "maxChoices",
  "extraBody",
  "modelHints",
  "testModel",
];

/** The problems on the details step, by field: everything but the key, which has its own step. */
export function detailIssues(draft: ConnectionDraft, taken: readonly string[]): Partial<Record<ConnectionField, string>> {
  const { errors } = validateConnection({ ...draft, keyMode: "none" }, null);
  const issues: Partial<Record<ConnectionField, string>> = {};
  for (const field of DETAIL_FIELDS) if (errors[field]) issues[field] = errors[field];
  if (!issues.name && taken.includes(draft.name.trim())) {
    issues.name = `A provider named "${draft.name.trim()}" already exists. Pick another name.`;
  }
  return issues;
}

/** The problems on the key step: the pasted key or the variable's name. Once saved, an empty paste keeps the stored key. */
export function keyIssues(draft: ConnectionDraft, existing: Provider | null = null): Partial<Record<ConnectionField, string>> {
  const { errors } = validateConnection(draft, existing);
  const issues: Partial<Record<ConnectionField, string>> = {};
  if (errors.secret) issues.secret = errors.secret;
  if (errors.envVar) issues.envVar = errors.envVar;
  return issues;
}

/** Why the owner cannot leave a step yet, in one sentence, or null when they can. */
export function addProviderIssue(id: AddProviderStepId, state: AddProviderState, taken: readonly string[]): string | null {
  if (id === "preset") return state.presetId && presetById(state.presetId) ? null : "Choose a preset to start from.";
  if (!state.draft) return "Choose a preset to start from.";
  if (id === "details") return Object.values(detailIssues(state.draft, taken))[0] ?? null;
  if (id === "key") return state.createdId ? null : (Object.values(keyIssues(state.draft))[0] ?? "Save the key to add the provider.");
  return null;
}

/** The furthest step the owner may open: past each step whose issue is solved. */
export function furthestProviderStep(state: AddProviderState, taken: readonly string[]): number {
  for (const [index, step] of ADD_PROVIDER_STEPS.entries()) {
    if (addProviderIssue(step.id, state, taken)) return index;
  }
  return ADD_PROVIDER_STEPS.length - 1;
}

/** The provider body the key step saves. Hints are sent only to kinds that read them. */
export function providerWrite(draft: ConnectionDraft, existing: Provider | null = null): ProviderWrite | null {
  const { write } = validateConnection(draft, existing);
  if (!write) return null;
  return kindUsesHints(write.kind) ? write : { ...write, model_hints: [] };
}

/** Where the flow opens: the preset the link names goes straight to its details. */
export function openingStep(preset: ProviderPreset | undefined): AddProviderStepId {
  return preset ? "details" : "preset";
}
