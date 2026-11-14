// The upstream model catalog (GET /providers/:id/models) as a picker: search, a sensible order,
// and the model name a pick suggests. Pure.

import type { ProviderModel } from "../api/types";

/** "listed" keeps the endpoint's order, which puts a provider's suggested models (its hints) first. */
export type CatalogSort = "listed" | "name" | "price" | "context";

export const MODEL_NAME_PATTERN = /^[a-z0-9-]+$/;

/** How well an entry matches a query: lower is better, null for no match. */
function matchRank(model: ProviderModel, needle: string): number | null {
  if (needle.length === 0) return 0;
  const id = model.id.toLowerCase();
  const tail = id.slice(id.lastIndexOf("/") + 1);
  if (id === needle || tail === needle) return 0;
  if (id.startsWith(needle) || tail.startsWith(needle)) return 1;
  if (id.split(/[/._-]/).some((part) => part.startsWith(needle))) return 2;
  if (id.includes(needle)) return 3;
  if ((model.description ?? "").toLowerCase().includes(needle)) return 4;
  return null;
}

function compareBy(sort: CatalogSort): (a: ProviderModel, b: ProviderModel) => number {
  if (sort === "listed") return () => 0;
  if (sort === "price") {
    return (a, b) => (a.price_per_m_input ?? Infinity) - (b.price_per_m_input ?? Infinity) || a.id.localeCompare(b.id);
  }
  if (sort === "context") {
    return (a, b) => (b.context ?? -Infinity) - (a.context ?? -Infinity) || a.id.localeCompare(b.id);
  }
  return (a, b) => a.id.localeCompare(b.id);
}

/**
 * The entries matching `query` (id, its last path part, or description), best matches first and
 * then in the chosen order: by id (which groups each vendor), cheapest first, or longest context
 * first. Entries without a price or context go last in those orders.
 */
export function searchCatalog(models: readonly ProviderModel[], query: string, sort: CatalogSort = "name"): ProviderModel[] {
  const needle = query.trim().toLowerCase();
  const order = compareBy(sort);
  return models
    .map((model) => ({ model, rank: matchRank(model, needle) }))
    .filter((entry): entry is { model: ProviderModel; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || order(a.model, b.model))
    .map((entry) => entry.model);
}

/** A model name from an upstream id: its last path part, lowercased, with anything else made a hyphen. */
export function slugify(upstream: string): string {
  const tail = upstream.trim().slice(upstream.trim().lastIndexOf("/") + 1);
  return tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The suggested name for a pick, made unique against the names already taken. */
export function suggestModelName(upstream: string, taken: readonly string[]): string {
  const base = slugify(upstream) || "model";
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${taken.length + 1}`;
}

/** Why a model name cannot be used, or null when it can. `current` is the model's own saved name. */
export function validateModelName(name: string, taken: readonly string[], current: string | null = null): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Give the model a name. Apps send it in the model field.";
  if (!MODEL_NAME_PATTERN.test(trimmed)) return "Use lowercase letters, digits and hyphens, such as luna or triage-fast.";
  if (trimmed !== current && taken.includes(trimmed)) return `A model named "${trimmed}" already exists. Pick another name.`;
  return null;
}
