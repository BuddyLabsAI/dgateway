// The "Add provider" presets as pure data, in the one list the picker shows, with the rules that turn a
// preset into a provider body and say whether it has been verified. The SystemOne vendors' values (TypeSafe,
// Baseten, Liquid, Perplexity, DeepInfra) come from each vendor's public docs as read on 2026-11-08 (the docs
// link of each preset). Nobody has run them against the vendor with a real key yet, so those presets are
// `verified: false` and read "Not verified yet" until a provider made from one passes a test. Pure.

import type { ModelHint, Provider, ProviderKind, ProviderLastTest, WireShape } from "../api/types";
import { formatDay } from "./format";

/** The day the list prices and model ids below were read from the vendors' docs. */
export const PRICES_AS_OF = "2026-11-08";

export interface PresetHint {
  /** The id the vendor's API expects in the request's model field. */
  id: string;
  /** What the model is, in a few words. */
  label: string;
  /** USD per million input tokens, as of PRICES_AS_OF. */
  price?: number;
  context?: number;
  /** The id is not in the vendor's own docs (the catalog id was kept), so check it before relying on it. */
  idUnverified?: boolean;
  /** The price is not in the vendor's own docs (it is the OpenRouter catalog's figure). */
  priceUnverified?: boolean;
}

/** Whether the upstream needs a key: always, only if the server was started with one, or never. */
export type KeyNeed = "required" | "optional" | "none";

export interface ProviderPreset {
  id: string;
  /** The name on the card. */
  title: string;
  /** One line: when to pick it. */
  pick: string;
  kind: ProviderKind;
  wire?: WireShape;
  /** Empty when the owner supplies it (the custom presets). */
  baseUrl: string;
  path: string;
  /**
   * Map wire: whether the body names the model. "auto" follows the base URL as the gateway does (off for a
   * local host, on otherwise). The openai wire always sends the model, so its presets say true.
   */
  sendModel: boolean | "auto";
  authHeader: string;
  key: KeyNeed;
  /** The environment variable the key usually lives in. Empty when the owner names one, or none is needed. */
  envVar: string;
  docs: string;
  /** Models to suggest, with list prices. Empty when the provider lists its own (OpenRouter, vLLM). */
  hints: readonly PresetHint[];
  /**
   * The model a test uses when none of the owner's models sends this provider one: a cheap model known to serve
   * decisions. For a vendor it is the cheapest hint whose id and price its docs confirm; a preset without one has none.
   */
  testModel?: string;
  /** False when the values come only from public docs and have not been run against the service. */
  verified: boolean;
  /** Something to know before relying on the preset, from the vendor's docs. */
  note?: string;
  /** Lower limits than the gateway's defaults, when the vendor documents them. */
  limits?: { max_questions: number; max_choices: number };
}

/** What every chat-wire preset says before the owner relies on it. */
const SYNTHETIC_NOTE =
  "Synthetic probabilities are not a calibrated chance of being correct. Logprobs work best, sampling is coarse, and JSON is the model's own stated estimate. A model without logprobs needs sampling or JSON. Configure the order under Advanced.";

export const PRESETS: readonly ProviderPreset[] = [
  {
    id: "synthetic-chat", title: "Any OpenAI-compatible chat model (synthetic)",
    pick: "Synthetic decisions from a chat model: logprobs first, sampling next, compact JSON last.",
    kind: "openai-compatible", wire: "chat", baseUrl: "", path: "/v1/chat/completions", sendModel: true,
    authHeader: "authorization", key: "optional", envVar: "", docs: "", hints: [], verified: false,
    limits: { max_questions: 16, max_choices: 64 },
    note: SYNTHETIC_NOTE,
  },
  {
    id: "openai",
    title: "OpenAI",
    pick: "OpenAI's own decisions API, with your OpenAI key: the generally available option.",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    path: "/decisions",
    sendModel: true,
    authHeader: "authorization",
    key: "required",
    envVar: "OPENAI_API_KEY",
    docs: "https://developers.openai.com/api/docs/guides/decisions",
    hints: [{ id: "gpt-6-luna", label: "GPT-6 Luna, the only decision model OpenAI serves", price: 0.1, context: 1050000 }],
    testModel: "gpt-6-luna",
    verified: true,
  },
  {
    // An explicit provider of its own beside the native OpenAI one: it never changes or shares that provider.
    id: "openai-chat",
    title: "OpenAI (chat-endpoint)",
    pick: "Serves OpenAI's chat models as synthetic decisions, with your OpenAI key. A separate provider from the native one.",
    kind: "openai",
    wire: "chat",
    baseUrl: "https://api.openai.com/v1",
    path: "/chat/completions",
    sendModel: true,
    authHeader: "authorization",
    key: "required",
    envVar: "OPENAI_API_KEY",
    docs: "",
    hints: [],
    verified: false,
    limits: { max_questions: 16, max_choices: 64 },
    note: SYNTHETIC_NOTE,
  },
  {
    id: "openrouter",
    title: "OpenRouter",
    pick: "Many decision models behind one key, with failover between hosts. Its API is in alpha.",
    kind: "openrouter",
    baseUrl: "https://openrouter.ai",
    path: "/api/alpha/decisions",
    sendModel: true,
    authHeader: "authorization",
    key: "required",
    envVar: "OPENROUTER_API_KEY",
    docs: "https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request",
    hints: [],
    testModel: "perplexity/pplx-decider-flash-v1.2",
    verified: true,
  },
  {
    // An explicit provider of its own beside the native OpenRouter one: it never changes or shares that provider.
    id: "openrouter-chat",
    title: "OpenRouter (chat-endpoint)",
    pick: "Serves OpenRouter's chat models as synthetic decisions, with your OpenRouter key. A separate provider from the native one.",
    kind: "openrouter",
    wire: "chat",
    baseUrl: "https://openrouter.ai",
    path: "/api/v1/chat/completions",
    sendModel: true,
    authHeader: "authorization",
    key: "required",
    envVar: "OPENROUTER_API_KEY",
    docs: "",
    hints: [],
    verified: false,
    limits: { max_questions: 16, max_choices: 64 },
    note: SYNTHETIC_NOTE,
  },
  {
    id: "ollama",
    title: "Ollama (local)",
    pick: "Private decisions from a model you pull with Ollama on this machine.",
    kind: "systemone",
    baseUrl: "http://host.docker.internal:11434",
    path: "/v1/systemone",
    sendModel: true,
    authHeader: "authorization",
    key: "none",
    envVar: "",
    docs: "https://registry.ollama.com/library/d1",
    hints: [{ id: "d1", label: "d1, after ollama pull d1; runs locally" }],
    testModel: "d1",
    verified: true,
  },
  {
    id: "vllm",
    title: "vLLM (local)",
    pick: "A GPU server you run with vLLM, speaking the OpenAI decisions shape. It lists its own models.",
    kind: "openai-compatible",
    baseUrl: "http://host.docker.internal:8000",
    path: "/v1/decisions",
    sendModel: true,
    authHeader: "authorization",
    key: "optional",
    envVar: "VLLM_API_KEY",
    docs: "https://docs.vllm.ai/en/latest/models/structured_decisions_models/",
    hints: [],
    verified: true,
    note: "vLLM also serves /v1/systemone. To use that instead, pick Custom SystemOne with this base URL.",
  },
  {
    id: "typesafe",
    title: "TypeSafe",
    pick: "Jev, the first SystemOne model, from the company that defined the API.",
    kind: "systemone",
    baseUrl: "https://api.typesafe.ai",
    path: "/v1/systemone",
    sendModel: true,
    authHeader: "authorization",
    key: "required",
    envVar: "TYPESAFE_API_KEY",
    docs: "https://api.typesafe.ai/redoc",
    hints: [
      { id: "jev-1.14", label: "Jev 1.14", price: 0.042, context: 262144, idUnverified: true, priceUnverified: true },
      { id: "jev-1.13", label: "Jev 1.13", price: 0.042, context: 262144, idUnverified: true, priceUnverified: true },
    ],
    verified: false,
    note: "TypeSafe's API reference shows only the aliases jev-latest and jev-preview; GET /v1/models lists the current names.",
  },
  {
    id: "baseten",
    title: "Baseten",
    pick: "Joey, Elephant and Mammoth on Baseten's Model APIs, from cheap and fast to most accurate.",
    kind: "systemone",
    baseUrl: "https://inference.baseten.co",
    path: "/v1/systemone",
    sendModel: true,
    authHeader: "authorization",
    key: "required",
    envVar: "BASETEN_API_KEY",
    docs: "https://docs.baseten.co/inference/model-apis/decision-models",
    hints: [
      { id: "decision-models/baseten-joey-2b-latest", label: "joey-1, 2B", price: 0.01, context: 16384, priceUnverified: true },
      { id: "decision-models/baseten-elephant-9b-latest", label: "elephant-1, 9B", price: 0.035, context: 16384, priceUnverified: true },
      { id: "decision-models/baseten-mammoth-27b-latest", label: "mammoth-1, 27B", price: 0.1, context: 16384, priceUnverified: true },
    ],
    verified: false,
    note: "Baseten's own model ids are the decision-models/… slugs from its docs, not OpenRouter's baseten/… ids.",
  },
  {
    id: "liquid",
    title: "Liquid",
    pick: "Liquid's d1 models: d1.1 for everyday decisions, d1-ultra for harder ones.",
    kind: "systemone",
    baseUrl: "https://api.liquid.ai",
    path: "/decisions/v1/systemone",
    sendModel: true,
    authHeader: "authorization",
    key: "required",
    envVar: "LIQUID_API_KEY",
    docs: "https://docs.liquid.ai/api/guides/decisions",
    hints: [
      { id: "d1-ultra", label: "d1-ultra, for harder decisions", price: 0.042, context: 32768 },
      { id: "d1.1", label: "d1.1, the default decision model", price: 0.02, context: 65536, priceUnverified: true },
    ],
    testModel: "d1-ultra",
    verified: false,
  },
  {
    id: "perplexity",
    title: "Perplexity",
    pick: "Decider models from Perplexity, with optional web grounding for claims that need fresh facts.",
    kind: "systemone",
    baseUrl: "https://api.perplexity.ai",
    path: "/v1/decisions",
    sendModel: true,
    authHeader: "authorization",
    key: "required",
    envVar: "PERPLEXITY_API_KEY",
    docs: "https://docs.perplexity.ai/docs/decisions/quickstart",
    hints: [
      { id: "pplx-decider-flash-v1.2", label: "Decider Flash v1.2, 4B; best with one question per request", price: 0.01, context: 262144 },
      { id: "pplx-decider-v1.2", label: "Decider v1.2, 27B", price: 0.02, context: 262144 },
    ],
    testModel: "pplx-decider-flash-v1.2",
    verified: false,
    limits: { max_questions: 100, max_choices: 64 },
  },
  {
    id: "deepinfra",
    title: "DeepInfra",
    pick: "Nace's Drex models and Cloudflare's Clef Flash, served by DeepInfra.",
    kind: "systemone",
    baseUrl: "https://api.deepinfra.com",
    path: "/v1/systemone",
    sendModel: true,
    authHeader: "authorization",
    key: "required",
    envVar: "DEEPINFRA_TOKEN",
    docs: "https://deepinfra.com/nace-ai/drex-v2.0",
    hints: [
      { id: "nace-ai/drex-v2.0", label: "Drex v2.0", price: 0.06, context: 131072 },
      { id: "nace-ai/drex-v1.5", label: "Drex v1.5", price: 0.04, context: 131072 },
      { id: "cloudflare/clef-flash", label: "Clef Flash, 9B", price: 0.038, context: 24576, idUnverified: true, priceUnverified: true },
    ],
    testModel: "nace-ai/drex-v1.5",
    verified: false,
    note: "DeepInfra's docs write Clef as Cloudflare/clef, so Clef Flash may need Cloudflare/clef-flash.",
  },
  {
    id: "custom-openai",
    title: "Custom OpenAI-compatible",
    pick: "Any server that speaks the OpenAI decisions shape, at an address you give.",
    kind: "openai-compatible",
    baseUrl: "",
    path: "/v1/decisions",
    sendModel: true,
    authHeader: "authorization",
    key: "optional",
    envVar: "",
    docs: "https://developers.openai.com/api/docs/guides/decisions",
    hints: [],
    verified: true,
  },
  {
    id: "custom-systemone",
    title: "Custom SystemOne",
    pick: "Any server that speaks SystemOne (state and a questions map), hosted or on your network.",
    kind: "systemone",
    baseUrl: "",
    path: "/v1/systemone",
    sendModel: "auto",
    authHeader: "authorization",
    key: "optional",
    envVar: "",
    docs: "https://api.typesafe.ai/redoc",
    hints: [],
    verified: true,
  },
];

export function presetById(id: string | null | undefined): ProviderPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/** The request format a kind speaks: the OpenAI shape, or the SystemOne map. */
export function wireFor(kind: ProviderKind): WireShape {
  return kind === "systemone" || kind === "openrouter" ? "map" : "openai";
}

/** Whether a kind reads model hints at all (the models endpoint and hint prices). */
export function kindUsesHints(kind: ProviderKind): boolean {
  return kind === "systemone" || kind === "openai-compatible" || kind === "openai";
}

/** A hint's description as the gateway stores it: what the model is, the price date, and what is unverified. */
export function hintDescription(hint: PresetHint): string {
  const parts = [hint.label];
  // A model without a price has no figure to display.
  if (hint.price !== undefined && hint.price > 0) {
    parts.push(hint.priceUnverified ? `list price as of ${PRICES_AS_OF}, unverified` : `list price as of ${PRICES_AS_OF}`);
  }
  if (hint.idUnverified) parts.push("id unverified");
  return parts.join(" · ");
}

/** The model hints a preset gives its provider. Kinds that do not read hints get none. */
export function presetModelHints(preset: Pick<ProviderPreset, "kind" | "hints">): ModelHint[] {
  if (!kindUsesHints(preset.kind)) return [];
  return preset.hints.map((hint) => ({
    id: hint.id,
    ...(hint.price === undefined ? {} : { price_per_m_input: hint.price }),
    ...(hint.context === undefined ? {} : { context: hint.context }),
    description: hintDescription(hint),
  }));
}

/** The name a new provider from this preset suggests: the preset's id, made unique against the names taken. */
export function suggestProviderName(preset: Pick<ProviderPreset, "id">, taken: readonly string[]): string {
  if (!taken.includes(preset.id)) return preset.id;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${preset.id}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${preset.id}-${taken.length + 1}`;
}

/** A hint the vendor's docs confirm: neither its id nor its price is marked unverified. */
export function confirmedHint(hint: PresetHint): boolean {
  return !hint.idUnverified && !hint.priceUnverified && hint.price !== undefined;
}

/** The cheapest confirmed hint of a preset, the rule a vendor preset's test model follows; undefined when none is confirmed. */
export function cheapestConfirmedHint(preset: Pick<ProviderPreset, "hints">): PresetHint | undefined {
  return preset.hints.filter(confirmedHint).sort((a, b) => (a.price ?? 0) - (b.price ?? 0) || a.id.localeCompare(b.id))[0];
}

/** The test model a provider made from this preset is saved with, or null when the preset recommends none. */
export function presetTestModel(preset: Pick<ProviderPreset, "testModel"> | undefined): string | null {
  return preset?.testModel ?? null;
}

/** The sentence on the key step: what the preset needs. */
export function keySentence(preset: Pick<ProviderPreset, "key" | "title">): string {
  if (preset.key === "required") return `${preset.title} refuses requests without your API key.`;
  if (preset.key === "optional") return "Only needed if the server was started with a key. Most local servers have none.";
  return "Needs no key.";
}

export const NOT_VERIFIED = "Not verified yet: run Test with your key";

export interface Verification {
  verified: boolean;
  /** "Verified 8 Nov 2026", or the not-verified sentence. */
  text: string;
}

/** A provider's verification: verified on the day its last test passed, and not verified until then. */
export function providerVerification(lastTest: ProviderLastTest | null | undefined): Verification {
  if (lastTest?.ok) return { verified: true, text: `Verified ${formatDay(Date.parse(lastTest.at))}` };
  return { verified: false, text: NOT_VERIFIED };
}

const normalUrl = (url: string): string => url.trim().replace(/\/+$/, "").toLowerCase();

/** Whether a provider was set up from this preset: same kind, address and path. Custom presets match nothing. */
export function matchesPreset(
  preset: Pick<ProviderPreset, "kind" | "baseUrl" | "path">,
  provider: Pick<Provider, "kind" | "base_url" | "path">,
): boolean {
  if (!preset.baseUrl) return false;
  return preset.kind === provider.kind && normalUrl(preset.baseUrl) === normalUrl(provider.base_url) && preset.path === provider.path;
}

/** The preset a provider was set up from, when one matches. */
export function presetForProvider(provider: Pick<Provider, "kind" | "base_url" | "path">): ProviderPreset | undefined {
  return PRESETS.find((preset) => matchesPreset(preset, provider));
}

/**
 * What a preset's card says about verification: "Verified <date>" once a provider made from it has passed
 * a test (the latest such day), "Not verified yet" for a preset that is not verified, and nothing for the
 * other presets until then.
 */
export function presetVerification(
  preset: Pick<ProviderPreset, "kind" | "baseUrl" | "path" | "verified">,
  providers: readonly Pick<Provider, "kind" | "base_url" | "path" | "last_test">[],
): Verification | null {
  const passed = providers
    .filter((provider) => matchesPreset(preset, provider) && provider.last_test?.ok)
    .map((provider) => provider.last_test as ProviderLastTest)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (passed[0]) return providerVerification(passed[0]);
  return preset.verified ? null : { verified: false, text: NOT_VERIFIED };
}

/**
 * The models line on a preset card: the one model and its price, how many models from what price, or where
 * the models come from when the preset suggests none.
 */
export function presetPriceLine(preset: Pick<ProviderPreset, "hints" | "kind">): string {
  if (preset.kind === "openrouter") return "Live catalog, with prices";
  const priced = preset.hints.filter((hint) => hint.price !== undefined);
  const only = preset.hints.length === 1 ? preset.hints[0] : undefined;
  if (priced.length === 0) return only ? `${only.id} · unpriced` : preset.hints.length > 0 ? `${preset.hints.length} suggested models` : "Lists its own models";
  const cheapest = Math.min(...priced.map((hint) => hint.price ?? Infinity));
  const from = cheapest === 0 ? "$0 / M input" : `$${trimPrice(cheapest)} / M input`;
  if (only) return `${only.id} · ${from}`;
  return `${preset.hints.length} models · from ${from}`;
}

/** A base URL without its scheme, for a card; "your address" when the owner supplies it. */
export function hostOf(baseUrl: string): string {
  return baseUrl ? baseUrl.replace(/^https?:[/][/]/, "") : "your address";
}

function trimPrice(price: number): string {
  return price >= 0.1 ? price.toFixed(2) : String(Number(price.toPrecision(2)));
}

/** True for a preset whose base URL points at the Docker host, which needs the host.docker.internal explanation. */
export function usesDockerHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "host.docker.internal";
  } catch {
    return false;
  }
}
