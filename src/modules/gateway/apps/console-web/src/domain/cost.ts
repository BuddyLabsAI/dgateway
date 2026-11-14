// Cost, as the API reference defines it: legible amounts (never a misleading $0.00 for a
// tiny non-zero cost), honest labels for billed, list-price, estimated and unpriced costs, and
// the price the gateway would use for a step. Pure.

import type { CostBasis, ModelHint, Provider, ProviderKind, ProviderModel } from "../api/types";
import { formatCount } from "./format";

const MISSING = "—";

/** The smallest amount shown as digits; anything smaller but above zero reads as "<$0.00000001". */
const SMALLEST = 1e-8;

/**
 * USD for people: "$0" for exactly nothing, two decimals from ten cents up ("$4.20", "$1,234.50"),
 * and two significant digits below that ("$0.035", "$0.0000042"), so a tiny cost never rounds to zero.
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  if (value < 0) return `-${formatUsd(-value)}`;
  if (value === 0) return "$0";
  if (value < SMALLEST) return "<$0.00000001";
  if (value >= 0.1) return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const decimals = Math.min(10, 1 - Math.floor(Math.log10(value)));
  const rounded = Number(value.toFixed(decimals));
  if (rounded >= 0.1) return `$${rounded.toFixed(2)}`;
  return `$${trimZeros(value.toFixed(decimals))}`;
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

export type TokenSide = "input" | "output";

/** A price in USD per million input (or output) tokens, as "$0.40 / M input" or "$1.60 / M output". */
export function formatPricePerM(price: number | null | undefined, side: TokenSide = "input"): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return MISSING;
  if (price === 0) return "Free";
  return `${formatUsd(price)} / M ${side}`;
}

/** An average cost per decision scaled to a million decisions: "$4.20 per 1M decisions". */
export function formatPerMillionDecisions(costPerDecision: number | null | undefined): string {
  if (costPerDecision === null || costPerDecision === undefined || !Number.isFinite(costPerDecision)) return MISSING;
  return `${formatUsd(costPerDecision * 1_000_000)} per 1M decisions`;
}

export type CostKind = "billed" | "priced" | "estimated" | "unpriced" | "none";

export interface CostView {
  kind: CostKind;
  /** The figure or word for a table cell: "$0.0000042", "Unpriced" or an em dash. */
  text: string;
  /** A longer explanation for a title or a detail line. */
  detail: string;
}

export interface CostFields {
  cost_usd?: number | null;
  cost_basis?: CostBasis | null;
  cost_includes_output?: boolean | null;
  tokens?: number | null;
}

/** True when the gateway says the cost covers input only: output tokens had no price, or no output count was reported. */
function outputLeftOut(fields: CostFields): boolean {
  return fields.cost_includes_output === false && fields.cost_usd !== null && fields.cost_usd !== undefined;
}

const OUTPUT_LEFT_OUT = " Output tokens are not included: no output price is known, or the upstream reported no output count.";

function tokenWords(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return "tokens unknown";
  return `${formatCount(tokens)} ${tokens === 1 ? "token" : "tokens"}`;
}

/** What one request cost, with its basis in words. A failed request costs nothing in this model. */
export function describeCost(fields: CostFields, failed = false): CostView {
  const basis = fields.cost_basis ?? null;
  if (basis === "upstream_cost") {
    return {
      kind: "billed",
      text: formatUsd(fields.cost_usd ?? null),
      detail: `Billed by provider: the amount it reported for ${tokenWords(fields.tokens)}. No price is applied.`,
    };
  }
  if (basis === "unpriced") {
    return {
      kind: "unpriced",
      text: "Unpriced",
      detail: `No price is known for this model (${tokenWords(fields.tokens)}). Set a price on the model step to track its cost.`,
    };
  }
  const partial = outputLeftOut(fields);
  if (basis === "estimated_tokens") {
    return {
      kind: "estimated",
      text: `${formatUsd(fields.cost_usd ?? null)}${partial ? " + output" : ""}`,
      detail: `Estimated from about ${tokenWords(fields.tokens)}; the upstream reported no usage.${partial ? OUTPUT_LEFT_OUT : ""}`,
    };
  }
  if (basis === "upstream_tokens") {
    return {
      kind: "priced",
      text: `${formatUsd(fields.cost_usd ?? null)}${partial ? " + output" : ""}`,
      detail: `${tokenWords(fields.tokens)}, as reported by the upstream, at list price (or the step's own price).${partial ? OUTPUT_LEFT_OUT : ""}`,
    };
  }
  if (failed) return { kind: "none", text: MISSING, detail: "Failed requests cost nothing." };
  return { kind: "none", text: MISSING, detail: "The gateway did not report a cost for this request." };
}

/**
 * The cost line under an answer, saying where the figure came from: "$0.00000177 · 177 tokens, billed by
 * provider", "$0.0000095 · 95 tokens from the upstream, at list price", "$0.0000042 · 120 tokens, estimated".
 */
export function costLine(fields: CostFields): string {
  const line = basisLine(fields);
  return outputLeftOut(fields) ? `${line}; output cost not included` : line;
}

function basisLine(fields: CostFields): string {
  const basis = fields.cost_basis ?? null;
  if (basis === "upstream_cost") return `${formatUsd(fields.cost_usd ?? null)} · ${tokenWords(fields.tokens)}, billed by provider`;
  if (basis === "unpriced") return `Unpriced · ${tokenWords(fields.tokens)}`;
  if (basis === "estimated_tokens") return `${formatUsd(fields.cost_usd ?? null)} · ${tokenWords(fields.tokens)}, estimated`;
  if (basis === "upstream_tokens")
    return `${formatUsd(fields.cost_usd ?? null)} · ${tokenWords(fields.tokens)} from the upstream, at list price`;
  return "Cost not reported";
}

export type PriceSource = "override" | "catalog" | "builtin" | "hint" | "mock" | "none";

export interface ResolvedPrice {
  /** USD per million input tokens, or null when the request would be unpriced. */
  price: number | null;
  source: PriceSource;
}

export const PRICE_SOURCE_WORDS: Record<PriceSource, string> = {
  override: "your price",
  catalog: "the provider's catalog price",
  builtin: "the gateway's built-in OpenAI price",
  hint: "the list price saved with this provider",
  mock: "the mock's zero price",
  none: "no price known",
};

/** A provider as its prices see it: its kind, and for SystemOne its address and model hints. */
export type PricedProvider = Pick<Provider, "kind"> & Partial<Pick<Provider, "base_url" | "model_hints">>;

/** What a default price depends on: a provider, or a bare kind (read as a provider with no address and no hints). */
export type PriceSubject = ProviderKind | PricedProvider;

const NO_PRICE: ResolvedPrice = { price: null, source: "none" };

/** The subject as a provider, or null when there is none. */
export function pricedProvider(subject: PriceSubject | null | undefined): PricedProvider | null {
  if (!subject) return null;
  return typeof subject === "string" ? { kind: subject } : subject;
}

/** A model's price in a provider's hints, or null when no hint names the model or the hint has no price. */
export function hintPrice(hints: readonly ModelHint[] | undefined, model: string): number | null {
  const price = hints?.find((hint) => hint.id === model)?.price_per_m_input;
  return price !== undefined && Number.isFinite(price) && price >= 0 ? price : null;
}

function catalogDefault(catalog: readonly ProviderModel[], model: string): number | null {
  const listed = catalog.find((entry) => entry.id === model)?.default_price_per_m_input;
  return listed !== undefined && Number.isFinite(listed) ? listed : null;
}

/**
 * The price the gateway uses when a step sets none (API reference, Cost, step 2). The mock defaults to zero.
 * For openrouter and openai the default is the one the provider's models endpoint reports (default_price_per_m_input); the console keeps no table of its own.
 * A SystemOne provider and an OpenAI-compatible server use the provider's model hint for the model.
 */
export function defaultPrice(subject: PriceSubject | null | undefined, model: string, catalog: readonly ProviderModel[] = []): ResolvedPrice {
  const provider = pricedProvider(subject);
  if (!provider) return NO_PRICE;
  if (provider.kind === "mock") return { price: 0, source: "mock" };
  if (provider.kind === "openrouter" || provider.kind === "openai") {
    const listed = catalogDefault(catalog, model);
    if (listed === null) {
      const hint = provider.kind === "openai" ? hintPrice(provider.model_hints, model) : null;
      return hint === null ? NO_PRICE : { price: hint, source: "hint" };
    }
    return { price: listed, source: provider.kind === "openrouter" ? "catalog" : "builtin" };
  }
  if (provider.kind === "systemone" || provider.kind === "openai-compatible") {
    const hinted = hintPrice(provider.model_hints, model) ?? catalogDefault(catalog, model);
    return hinted === null ? NO_PRICE : { price: hinted, source: "hint" };
  }
  return NO_PRICE;
}

/** The price a step resolves to: its own, else the default for its provider. */
export function effectivePrice(
  override: number | null | undefined,
  subject: PriceSubject | null | undefined,
  model: string,
  catalog: readonly ProviderModel[] = [],
): ResolvedPrice {
  if (override !== null && override !== undefined && Number.isFinite(override)) return { price: override, source: "override" };
  return defaultPrice(subject, model, catalog);
}

/** A model's output price in a provider's hints, or null when no hint names the model or the hint has no output price. */
export function hintOutputPrice(hints: readonly ModelHint[] | undefined, model: string): number | null {
  const price = hints?.find((hint) => hint.id === model)?.price_per_m_output;
  return price !== undefined && Number.isFinite(price) && price >= 0 ? price : null;
}

function catalogOutputDefault(catalog: readonly ProviderModel[], model: string): number | null {
  const listed = catalog.find((entry) => entry.id === model)?.default_price_per_m_output;
  return listed !== undefined && Number.isFinite(listed) ? listed : null;
}

/**
 * The output price the gateway uses when a step sets none (API reference, Cost, Output price), by the input
 * default's rules: zero for the mock; for openrouter and openai the default the models
 * endpoint reports (default_price_per_m_output), and an OpenAI model outside the built-in table uses its hint; a
 * SystemOne provider and an OpenAI-compatible server use the hint's price_per_m_output.
 */
export function defaultOutputPrice(subject: PriceSubject | null | undefined, model: string, catalog: readonly ProviderModel[] = []): ResolvedPrice {
  const provider = pricedProvider(subject);
  if (!provider) return NO_PRICE;
  if (provider.kind === "mock") return { price: 0, source: "mock" };
  if (provider.kind === "openrouter" || provider.kind === "openai") {
    const listed = catalogOutputDefault(catalog, model);
    if (listed !== null) return { price: listed, source: provider.kind === "openrouter" ? "catalog" : "builtin" };
    const hint = provider.kind === "openai" ? hintOutputPrice(provider.model_hints, model) : null;
    return hint === null ? NO_PRICE : { price: hint, source: "hint" };
  }
  if (provider.kind === "systemone" || provider.kind === "openai-compatible") {
    const hinted = hintOutputPrice(provider.model_hints, model) ?? catalogOutputDefault(catalog, model);
    return hinted === null ? NO_PRICE : { price: hinted, source: "hint" };
  }
  return NO_PRICE;
}

/** The output price a step resolves to: its own, else the default for its provider. */
export function effectiveOutputPrice(
  override: number | null | undefined,
  subject: PriceSubject | null | undefined,
  model: string,
  catalog: readonly ProviderModel[] = [],
): ResolvedPrice {
  if (override !== null && override !== undefined && Number.isFinite(override)) return { price: override, source: "override" };
  return defaultOutputPrice(subject, model, catalog);
}

/** The hint under an empty output price field: what the gateway uses instead. */
export function defaultOutputPriceSentence(resolved: ResolvedPrice): string {
  if (resolved.price === null)
    return "No output price is known for this model, so its costs cover input tokens only and are marked that way. Enter one to include output tokens.";
  return `Empty uses ${PRICE_SOURCE_WORDS[resolved.source]}: ${formatPricePerM(resolved.price, "output")}.`;
}

/** The cost of `tokens` at a price per million, rounded to 8 decimals as the gateway does. */
export function costAt(tokens: number | null | undefined, pricePerM: number | null | undefined): number | null {
  if (tokens === null || tokens === undefined || pricePerM === null || pricePerM === undefined) return null;
  if (!Number.isFinite(tokens) || !Number.isFinite(pricePerM)) return null;
  return Math.round((tokens / 1_000_000) * pricePerM * 1e8) / 1e8;
}

export type PriceParse = { ok: true; value: number | null } | { ok: false; message: string };

/** A price field as typed: empty means "use the default"; otherwise a number of dollars, zero or more. */
export function parsePrice(text: string, side: TokenSide = "input"): PriceParse {
  const trimmed = text.trim().replace(/^\$/, "");
  if (trimmed.length === 0) return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0)
    return { ok: false, message: `Enter a price of zero or more, in USD per million ${side} tokens, or leave it empty.` };
  return { ok: true, value };
}

/** A price for a text field, without a currency sign or trailing zeros. */
export function priceText(price: number | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return "";
  return trimZeros(price.toFixed(8));
}

export interface WindowCost {
  /** "$0.041", or "$0" when nothing priced ran. Null when the gateway reports no cost at all. */
  text: string | null;
  /** Answered requests the gateway could not price. */
  unpriced: number;
  /** "$4.20 per 1M decisions" over the priced requests, when there were any. */
  perMillion: string | null;
}

/**
 * The cost of a window, with how many answered requests went unpriced. `priced` is the number of
 * answered requests that carried a price (zero costs included), used for the per-decision average.
 */
export function windowCost(cost: number | null | undefined, unpriced: number | null | undefined, priced: number): WindowCost {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return { text: null, unpriced: unpriced ?? 0, perMillion: null };
  return {
    text: formatUsd(cost),
    unpriced: Math.max(0, unpriced ?? 0),
    perMillion: priced > 0 && cost > 0 ? formatPerMillionDecisions(cost / priced) : null,
  };
}

/** The hint under an empty price field: what the gateway uses instead. */
export function defaultPriceSentence(resolved: ResolvedPrice): string {
  if (resolved.price === null) return "No price is known for this model, so its requests show as unpriced. Enter one to track cost.";
  return `Empty uses ${PRICE_SOURCE_WORDS[resolved.source]}: ${formatPricePerM(resolved.price)}.`;
}

const SUMMARY_SOURCE: Partial<Record<PriceSource, string>> = { catalog: "from the catalog", builtin: "built in", hint: "list price" };

/**
 * A step's price in a summary: "$0.40 / M input", "Free", "$0.90 / M input, from the catalog", "$0.10 / M input,
 * built in", "$0.042 / M input, list price", "catalog price" or "unpriced". A default that depends on the
 * provider's catalog reads as "checking the price…" while that catalog is not loaded (catalog undefined).
 */
export function priceSummary(
  override: number | null,
  subject: PriceSubject | null | undefined,
  model: string,
  catalog?: readonly ProviderModel[],
): string {
  if (override !== null) return formatPricePerM(override);
  const kind = pricedProvider(subject)?.kind;
  if (catalog === undefined && (kind === "openai" || kind === "openrouter")) return "checking the price…";
  const resolved = defaultPrice(subject, model, catalog ?? []);
  if (resolved.price === 0) return "Free";
  if (resolved.price !== null) return `${formatPricePerM(resolved.price)}, ${SUMMARY_SOURCE[resolved.source] ?? "default"}`;
  return kind === "openrouter" ? "catalog price" : "unpriced";
}

/**
 * A step's output price in a summary: "$1.60 / M output", "output free", "$0.50 / M output, built in", or
 * "no output price". A default that depends on the provider's catalog reads as "checking the output price…"
 * while that catalog is not loaded (catalog undefined).
 */
export function outputPriceSummary(
  override: number | null,
  subject: PriceSubject | null | undefined,
  model: string,
  catalog?: readonly ProviderModel[],
): string {
  if (override !== null) return formatPricePerM(override, "output");
  const kind = pricedProvider(subject)?.kind;
  if (catalog === undefined && (kind === "openai" || kind === "openrouter")) return "checking the output price…";
  const resolved = defaultOutputPrice(subject, model, catalog ?? []);
  if (resolved.price === 0) return "output free";
  if (resolved.price !== null) return `${formatPricePerM(resolved.price, "output")}, ${SUMMARY_SOURCE[resolved.source] ?? "default"}`;
  return "no output price";
}
