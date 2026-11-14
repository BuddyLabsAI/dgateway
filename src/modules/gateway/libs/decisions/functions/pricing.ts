import type { CostBasis, DecisionRequest, Usage } from '../schemas/types';
import type { Charge } from '../schemas/execution';
import type { ModelHint, Provider, ProviderKind } from '../../management/schemas/types';
import { isLocalHost } from './hosts';

// USD per million tokens for models with a built-in price, keyed by upstream model id: the input and output rates, and
// the rates for cached input (cache reads) and cache writes, where OpenAI charges them. The rates are OpenAI's
// standard, short-context text rates: input and cache rates as its model page and pricing page listed them on
// 2026-11-08, and the output rate as its pricing page (https://developers.openai.com/api/docs/pricing) listed it on
// 2026-11-11. Cache writes are at the default 30-minute lifetime, since the gateway sends no cache lifetime of its own.
// The output rate is for Chat Completions (the chat wire) only: OpenAI does not charge output tokens on its Decisions
// endpoint, whose input and cache rates are the same as these ("Output tokens are not charged.", read on 2026-11-12 at
// https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability).
// This is the one copy of the table: price resolution and the models endpoint's default prices both read it.
type OpenAiRates = { input: number; output?: number; cached?: number; write?: number };
const OPENAI_RATES = new Map<string, OpenAiRates>([
  ['gpt-6-luna', { input: 0.1, output: 0.5, cached: 0.01, write: 0.125 }],
]);

// The built-in input price of an openai-kind model, or undefined when the table has no price for it.
export const openaiBuiltInPrice = (model: string): number | undefined =>
  OPENAI_RATES.get(model)?.input;

// A price the gateway can charge with: a finite number that is not negative.
const usable = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

export type PriceInput = {
  kind: ProviderKind;
  model: string;
  // The target's own price_per_m_input, when set.
  target: number | null | undefined;
  // The model's input price in the provider's cached catalog, or null when none is cached.
  catalog: number | null;
  // Whether the provider's host is local (see isLocalHost). Local hosts do not supply a default price.
  local?: boolean;
  // The model's price in the provider's model hints, or null when they give none.
  hint?: number | null;
  // The output counterparts, in USD per million output tokens: the target's own price_per_m_output, the model's
  // completion price in the provider's cached catalog, and the model hint's price_per_m_output. Each is resolved
  // independently of the input price.
  targetOutput?: number | null;
  catalogOutput?: number | null;
  hintOutput?: number | null;
  // The provider's wire. The native wires (openai and map) call a Decisions endpoint, where OpenAI charges no output
  // tokens; the chat wire calls Chat Completions. Absent, a built-in openai model's output is charged at its table rate.
  wire?: Provider['wire'];
};
// A price per million input tokens. cached and write are the rates for cached input and for cache writes, when the
// price has them. Only the built-in openai table does, so a step's own price, and a catalog or hint price, charge
// every input token at perMillion.
export type Price = { perMillion: number; cached?: number; write?: number };

// Whether a wire calls a Decisions endpoint: the native openai and map wires do; the chat wire calls Chat Completions.
const callsDecisions = (wire: Provider['wire'] | undefined): boolean =>
  wire === 'openai' || wire === 'map';

// The output rate the gateway charges for a model when the target sets none, or null when it has none. It follows the
// input default's rules: mock defaults to zero; openrouter uses the cached catalog's completion
// price; openai uses the built-in table for a model it lists, and the model hint otherwise; systemone
// and openai-compatible use the model hint. A model in the openai table is free of output on a native wire, since
// OpenAI does not charge output tokens on its Decisions endpoint; its table output rate applies on the chat wire.
export function defaultOutputPrice(
  input: Omit<PriceInput, 'target' | 'targetOutput'>,
): number | null {
  if (input.kind === 'mock') return 0;
  if (input.kind === 'openrouter') return usable(input.catalogOutput) ? input.catalogOutput : null;
  const rates = input.kind === 'openai' ? OPENAI_RATES.get(input.model) : undefined;
  if (rates && callsDecisions(input.wire)) return 0;
  if (rates) return usable(rates.output) ? rates.output : null;
  return usable(input.hintOutput) ? input.hintOutput : null;
}

// The output rate of one attempt: the target's own price_per_m_output, else the default for the provider, else null.
export function outputPrice(input: PriceInput): number | null {
  if (usable(input.targetOutput)) return input.targetOutput;
  return defaultOutputPrice(input);
}

const priced = (perMillion: number): Price => ({ perMillion });

// The price the gateway charges for a model when the target sets none, or null when it has none. mock defaults
// to zero; openrouter uses its cached catalog and openai the built-in table; systemone and openai-compatible use
// the provider's model hint for the model, whether local or hosted.
export function defaultPrice(input: Omit<PriceInput, 'target'>): Price | null {
  if (input.kind === 'mock') return priced(0);
  if (input.kind === 'openrouter') return usable(input.catalog) ? priced(input.catalog) : null;
  if (input.kind === 'openai') {
    const rates = OPENAI_RATES.get(input.model);
    return rates && usable(rates.input)
      ? { perMillion: rates.input, cached: rates.cached, write: rates.write }
      : usable(input.hint)
        ? priced(input.hint)
        : null;
  }
  return usable(input.hint) ? priced(input.hint) : null;
}

// The price of one attempt, or null when it is unpriced. In order: the target's own price, then the default for
// the provider (defaultPrice), then nothing. A target's own price is flat: it has no cache rates.
export function resolvePrice(input: PriceInput): Price | null {
  if (usable(input.target)) return priced(input.target);
  return defaultPrice(input);
}

// A model's input price in a provider's hints, or null when no hint names the model or the hint has no price.
export function hintPrice(hints: readonly ModelHint[] | undefined, model: string): number | null {
  const price = hints?.find((hint) => hint.id === model)?.price_per_m_input;
  return usable(price) ? price : null;
}

// A model's output price in a provider's hints, or null when no hint names the model or the hint has no output price.
export function hintOutputPrice(
  hints: readonly ModelHint[] | undefined,
  model: string,
): number | null {
  const price = hints?.find((hint) => hint.id === model)?.price_per_m_output;
  return usable(price) ? price : null;
}

// What a provider contributes to the price of one of its models: its kind and wire, whether its host is local, and the
// model's hint prices.
export function providerPricing(
  p: Pick<Provider, 'kind' | 'base_url' | 'model_hints' | 'wire'>,
  model: string,
): Pick<PriceInput, 'kind' | 'local' | 'hint' | 'hintOutput' | 'wire'> {
  return {
    kind: p.kind,
    wire: p.wire,
    local: isLocalHost(p.base_url),
    hint: hintPrice(p.model_hints, model),
    hintOutput: hintOutputPrice(p.model_hints, model),
  };
}

// Everything a model's default prices on a provider depend on: what the provider contributes (providerPricing), and
// the model's input and output prices in the provider's cached catalog, each null when not cached. A decision and the
// models endpoint both resolve their defaults from it, so the endpoint's default prices are the ones a decision is
// charged when its route target sets none.
export function defaultPriceInput(
  p: Pick<Provider, 'kind' | 'base_url' | 'model_hints' | 'wire'>,
  model: string,
  catalog: { input: number | null; output: number | null },
): Omit<PriceInput, 'target' | 'targetOutput'> {
  return {
    ...providerPricing(p, model),
    model,
    catalog: catalog.input,
    catalogOutput: catalog.output,
  };
}

// Rounds a USD amount to 8 decimals. Costs the gateway works out are stored at this precision, and so are sums of
// costs. A cost the upstream billed is kept as it was reported.
export const round8 = (x: number): number => Math.round(x * 1e8) / 1e8;

// The cost of some tokens at a price per million input tokens, rounded to 8 decimals.
export const costUsd = (tokens: number, perMillion: number): number =>
  round8((tokens / 1_000_000) * perMillion);

// The tokens estimated from the text the gateway sends upstream: the input, and each question's instructions
// and option or level descriptions. Text is counted in characters (code points), at four per token.
export function estimateTokens(request: DecisionRequest): number {
  const texts = request.questions.flatMap((q) => [
    q.instructions,
    ...[...(q.choices ?? []), ...(q.levels ?? [])].map((option) => option.description),
  ]);
  const characters = [request.input, ...texts].reduce((sum, text) => sum + [...text].length, 0);
  return Math.ceil(characters / 4);
}

// The input tokens a usage reports as read from the cache (cached_tokens) and as written to it (cache_write_tokens).
// OpenAI counts both inside input_tokens, so the uncached count is what is left after them.
type CacheCounts = { cached: number; written: number };
const NO_CACHE: CacheCounts = { cached: 0, written: 0 };

const wholeCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

// The cache counts of a usage. Each is a whole number of at least 0, and an absent one counts as 0. Details that are
// malformed, or whose counts add up to more than input_tokens, are ignored: no input token then counts as cached or
// written, so every one is charged at the input rate.
function cacheCounts(usage: Usage): CacheCounts {
  if (!usage) return NO_CACHE;
  const details: unknown = usage.input_tokens_details;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return NO_CACHE;
  const record = details as Record<string, unknown>;
  const cached = record.cached_tokens === undefined ? 0 : record.cached_tokens;
  const written = record.cache_write_tokens === undefined ? 0 : record.cache_write_tokens;
  if (!wholeCount(cached) || !wholeCount(written)) return NO_CACHE;
  if (cached + written > usage.input_tokens) return NO_CACHE;
  return { cached, written };
}

// The cost of an attempt's input tokens, rounded to 8 decimals. A price with cache rates charges the cached reads and
// the writes at those rates, and every other input token at the input rate. A price without them charges every input
// token at its rate, as costUsd does.
function inputCost(tokens: number, price: Price, counts: CacheCounts): number {
  if (price.cached === undefined && price.write === undefined)
    return (tokens / 1_000_000) * price.perMillion;
  const ordinary = tokens - counts.cached - counts.written;
  return (
    (ordinary / 1_000_000) * price.perMillion +
    (counts.cached / 1_000_000) * (price.cached ?? price.perMillion) +
    (counts.written / 1_000_000) * (price.write ?? price.perMillion)
  );
}

// The charge for an attempt that answered. The token count is the upstream's input tokens when it sent
// usage, and the estimate otherwise. A cost the upstream billed is the charge, whatever any price says (basis
// upstream_cost), and it covers output. Otherwise the tokens are priced: the input part at the input price (a price
// with cache rates charges cached and written input tokens at those rates, see inputCost), plus the upstream's output
// tokens at the output rate, rounded once. An attempt without an input price has no cost. cost_includes_output is
// false when output tokens were reported but no output rate applies, or when the output count is unknown and the
// rate is not 0: the cost then covers input only.
export function chargeFor(
  input: PriceInput & {
    usage: Usage;
    request: DecisionRequest;
    billed?: number | null;
    estimatedTokens?: number;
  },
): Charge {
  const upstream = input.usage?.input_tokens ?? null;
  const tokens = upstream ?? input.estimatedTokens ?? estimateTokens(input.request);
  if (usable(input.billed))
    return {
      tokens,
      cost_usd: input.billed,
      cost_basis: 'upstream_cost',
      cost_includes_output: true,
    };
  const rate = outputPrice(input);
  const output = input.usage ? input.usage.output_tokens : null;
  const includes = rate === 0 || (output !== null && (output === 0 || rate !== null));
  const price = resolvePrice(input);
  if (!price)
    return { tokens, cost_usd: null, cost_basis: 'unpriced', cost_includes_output: includes };
  const outputCost = output !== null && rate !== null ? (output / 1_000_000) * rate : 0;
  const basis: CostBasis = upstream === null ? 'estimated_tokens' : 'upstream_tokens';
  const cost = round8(inputCost(tokens, price, cacheCounts(input.usage)) + outputCost);
  return { tokens, cost_usd: cost, cost_basis: basis, cost_includes_output: includes };
}
