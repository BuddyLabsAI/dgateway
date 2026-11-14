// Synthetic fixture data for mock mode (?mock=1, or `bun run dev`; ?mock=fresh for a first run).
// Nothing here is real traffic, real keys, real prices or real customers. Values are generated from
// a seeded generator so the same clock and seed always produce the same week of logs.

import type { ClientKey, CostBasis, LogEntry, ModelHint, Provider, ProviderKind, ProviderModel, Route, Settings, Attempt } from "../types";
import { costAt, defaultPrice, hintPrice, pricedProvider, type PricedProvider, type PriceSubject } from "../../domain/cost";
import { kindUsesHints, presetById, presetModelHints } from "../../domain/provider-presets";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Deterministic PRNG (mulberry32). Returns numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string, as an unsigned 32-bit integer. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Environment variables the mock pretends are set on the gateway host in the demo. */
export const MOCK_ENV_VARS: ReadonlySet<string> = new Set(["OPENAI_API_KEY", "LOCAL_TEST_KEY"]);

/** A first run sets none: the owner has not supplied any key yet. */
export const FRESH_ENV_VARS: ReadonlySet<string> = new Set();

export const PROVIDER_IDS = {
  mock: "prv_mock",
  openai: "prv_openai",
  openrouter: "prv_openrouter",
  llamacpp: "prv_llamacpp",
  vllm: "prv_vllm",
  typesafe: "prv_typesafe",
  openaiChat: "prv_openai_chat",
  openrouterChat: "prv_openrouter_chat",
} as const;

export const ROUTE_IDS = { default: "rte_default", luna: "rte_luna", elephant: "rte_elephant", triage: "rte_triage" } as const;

/** The model the demo's vLLM server serves (synthetic). It lists no price, so its decisions are unpriced. */
export const VLLM_MODEL = "harbor-decide-7b-q4";

/** The TypeSafe preset's hints, as the Add provider flow saves them. */
const TYPESAFE_HINTS: ModelHint[] = (() => {
  const preset = presetById("typesafe");
  return preset ? presetModelHints(preset) : [];
})();

export function seedProviders(nowIso: string, nowMs: number = Date.parse(nowIso)): Provider[] {
  const base = { created_at: nowIso, updated_at: nowIso };

  const ago = (ms: number): string => new Date(nowMs - ms).toISOString();

  return [
    {
      ...base,
      id: PROVIDER_IDS.mock,
      name: "mock",
      kind: "mock",
      base_url: "builtin://mock",
      path: "/decisions",
      wire: "openai",
      enabled: true,
      timeout_ms: 5000,
      limits: { max_questions: 400, max_choices: 64 },
      extra_body: {},
      key: { source: "none" },
      send_model: true,
      auth_header: "authorization",
      model_hints: [],
      test_model: null,
      last_test: { ok: true, at: ago(26 * HOUR), latency_ms: 24, model: "mock-1", error: null, model_reason: "used_by_route", matched: true },
    },
    {
      ...base,
      id: PROVIDER_IDS.openai,
      name: "openai",
      kind: "openai",
      base_url: "https://api.openai.com/v1",
      path: "/decisions",
      wire: "openai",
      enabled: true,
      timeout_ms: 20000,
      limits: { max_questions: 400, max_choices: 64 },
      extra_body: {},
      key: { source: "env", env_var: "OPENAI_API_KEY", present: true },
      send_model: true,
      auth_header: "authorization",
      model_hints: [],
      test_model: null,
      last_test: {
        ok: true,
        at: ago(3 * HOUR + 12 * MINUTE),
        latency_ms: 412,
        model: "gpt-6-luna",
        error: null,
        model_reason: "used_by_route",
        matched: true,
      },
    },
    {
      ...base,
      id: PROVIDER_IDS.openrouter,
      name: "openrouter",
      kind: "openrouter",
      base_url: "https://openrouter.ai",
      path: "/api/alpha/decisions",
      wire: "map",
      enabled: true,
      timeout_ms: 20000,
      limits: { max_questions: 400, max_choices: 64 },
      extra_body: { provider: { require_parameters: true } },
      // Scenario: the key was removed from the host two hours ago.
      key: { source: "env", env_var: "OPENROUTER_API_KEY", present: false },
      send_model: true,
      auth_header: "authorization",
      model_hints: [],
      test_model: null,
      last_test: {
        ok: false,
        at: ago(MINUTE * 95),
        latency_ms: 3,
        model: "openai/gpt-6-luna-decisions",
        error: "OPENROUTER_API_KEY is not set on the gateway host",
        model_reason: "used_by_route",
        matched: false,
      },
    },
    {
      ...base,
      id: PROVIDER_IDS.llamacpp,
      name: "llamacpp",
      kind: "systemone",
      base_url: "http://host.docker.internal:8080",
      path: "/v1/systemone",
      wire: "map",
      enabled: false,
      timeout_ms: 30000,
      limits: { max_questions: 16, max_choices: 16 },
      extra_body: {},
      key: { source: "none" },
      // A local llama.cpp server serves the one model it loaded, so it is sent none.
      send_model: false,
      auth_header: "authorization",
      model_hints: [],
      test_model: null,
      last_test: null,
    },
    {
      ...base,
      id: PROVIDER_IDS.vllm,
      name: "vllm",
      kind: "openai-compatible",
      base_url: "http://host.docker.internal:8000",
      path: "/v1/decisions",
      wire: "openai",
      // Scenario: a vLLM server the owner runs, added from the vLLM preset. It needs no key and lists its own model
      // without a price, so its decisions are unpriced. Its small model gets the known-answer check wrong.
      enabled: true,
      timeout_ms: 30000,
      limits: { max_questions: 400, max_choices: 64 },
      extra_body: {},
      key: { source: "none" },
      send_model: true,
      auth_header: "authorization",
      model_hints: [],
      test_model: null,
      last_test: { ok: true, at: ago(2 * DAY), latency_ms: 188, model: VLLM_MODEL, error: null, model_reason: "used_by_route", matched: false },
    },
    {
      ...base,
      id: PROVIDER_IDS.typesafe,
      name: "typesafe",
      kind: "systemone",
      base_url: "https://api.typesafe.ai",
      path: "/v1/systemone",
      wire: "map",
      // Scenario: added from the TypeSafe preset with a pasted key a moment ago, and not tested yet.
      enabled: true,
      timeout_ms: 20000,
      limits: { max_questions: 400, max_choices: 64 },
      extra_body: {},
      key: { source: "stored", last4: "9f2c" },
      send_model: true,
      auth_header: "authorization",
      model_hints: TYPESAFE_HINTS,
      // The TypeSafe preset confirms no hint, so it recommends no test model.
      test_model: null,
      last_test: null,
    },
  ];
}

/**
 * A first run, as the gateway seeds it: the seeded connections and models only, no key set on the
 * host, the local server disabled, nothing tested, no traffic.
 */
export function seedFreshProviders(nowIso: string): Provider[] {
  const native = seedProviders(nowIso)
    .filter((provider) => provider.id !== PROVIDER_IDS.vllm)
    .map((provider) => ({
      ...provider,
      enabled: provider.kind === "systemone" || provider.kind === "openai-compatible" ? false : provider.enabled,
      key: provider.id === PROVIDER_IDS.typesafe ? { source: "env" as const, env_var: "TYPESAFE_API_KEY", present: false } : provider.key.source === "env" ? { ...provider.key, present: false } : provider.key,
      last_test: null,
    }));
  return [...native, ...seedChatProviders(nowIso)];
}

/**
 * The explicit chat-wire providers a new database seeds beside the native OpenAI and OpenRouter ones: disabled, no
 * route, their own env key settings (the same variables), and synthetic settings left at their defaults.
 */
export function seedChatProviders(nowIso: string): Provider[] {
  const common = {
    created_at: nowIso,
    updated_at: nowIso,
    wire: "chat" as const,
    enabled: false,
    timeout_ms: 20000,
    limits: { max_questions: 16, max_choices: 64 },
    extra_body: {},
    send_model: true,
    auth_header: "authorization",
    model_hints: [],
    test_model: null,
    last_test: null,
  };
  return [
    {
      ...common,
      id: PROVIDER_IDS.openaiChat,
      name: "openai-chat",
      kind: "openai",
      base_url: "https://api.openai.com/v1",
      path: "/chat/completions",
      key: { source: "env", env_var: "OPENAI_API_KEY", present: false },
    },
    {
      ...common,
      id: PROVIDER_IDS.openrouterChat,
      name: "openrouter-chat",
      kind: "openrouter",
      base_url: "https://openrouter.ai",
      path: "/api/v1/chat/completions",
      key: { source: "env", env_var: "OPENROUTER_API_KEY", present: false },
    },
  ];
}

export function seedRoutes(nowIso: string): Route[] {
  const base = { created_at: nowIso, updated_at: nowIso };
  return [
    {
      ...base,
      id: ROUTE_IDS.default,
      alias: "default",
      description: "Built-in mock answers for trying the API",
      enabled: true,
      targets: [{ provider_id: PROVIDER_IDS.mock, model: "mock-1" }],
    },
    {
      ...base,
      id: ROUTE_IDS.luna,
      alias: "luna",
      description: "GPT-6 Luna, with OpenRouter as the fallback",
      enabled: true,
      targets: [
        { provider_id: PROVIDER_IDS.openai, model: "gpt-6-luna", timeout_ms: 8000 },
        { provider_id: PROVIDER_IDS.openrouter, model: "openai/gpt-6-luna-decisions" },
      ],
    },
    {
      ...base,
      id: ROUTE_IDS.elephant,
      alias: "elephant",
      description: "Baseten Elephant via OpenRouter",
      enabled: true,
      targets: [{ provider_id: PROVIDER_IDS.openrouter, model: "baseten/elephant-1", timeout_ms: 15000 }],
    },
    {
      ...base,
      id: ROUTE_IDS.triage,
      alias: "triage",
      description: "A vLLM server on this machine first, with the mock as a free fallback",
      enabled: true,
      targets: [
        { provider_id: PROVIDER_IDS.vllm, model: VLLM_MODEL },
        { provider_id: PROVIDER_IDS.mock, model: "mock-1" },
      ],
    },
  ];
}

/** A first run's models: the three the gateway seeds, none added by the owner. */
export function seedFreshRoutes(nowIso: string): Route[] {
  return seedRoutes(nowIso).filter((route) => route.id !== ROUTE_IDS.triage);
}

export function seedClients(nowMs: number): ClientKey[] {
  return [
    {
      id: "key_ops_laptop",
      name: "Ops laptop",
      key_last4: "7f3a",
      created_at: new Date(nowMs - 41 * DAY).toISOString(),
      last_used_at: new Date(nowMs - 2 * HOUR).toISOString(),
    },
    {
      id: "key_support_bot",
      name: "Support triage bot",
      key_last4: "c901",
      created_at: new Date(nowMs - 9 * DAY).toISOString(),
      last_used_at: new Date(nowMs - 14 * MINUTE).toISOString(),
    },
  ];
}

export function seedSettings(): Settings {
  return { require_client_keys: false, capture_payloads: true, default_route: "default" };
}

/** The gateway's own defaults on a first run. */
export function seedFreshSettings(): Settings {
  return { require_client_keys: false, capture_payloads: false, default_route: "default" };
}

const OPENROUTER_MODELS: ProviderModel[] = [
  { id: "openai/gpt-6-luna-decisions", description: "Luna decisions, synthetic catalogue entry", price_per_m_input: 0.4, context: 128000 },
  { id: "baseten/elephant-1", description: "Elephant 1, synthetic catalogue entry", price_per_m_input: 0.9, context: 64000 },
  { id: "acme/harbor-decide-7b", description: "Small decision model, synthetic", price_per_m_input: 0.05, context: 32000 },
  { id: "acme/harbor-decide-70b", description: "Large decision model, synthetic", price_per_m_input: 0.6, context: 64000 },
  { id: "northwind/triage-mini", description: "Triage model, synthetic", price_per_m_input: 0.12, context: 16000 },
  { id: "northwind/triage-pro", description: "Triage model with longer context, synthetic", price_per_m_input: 1.1, context: 200000 },
  { id: "kestrel/route-classify-v2", description: "Classification-focused, synthetic", price_per_m_input: 0.2, context: 32000 },
  { id: "kestrel/route-classify-v3", price_per_m_input: 0.25, context: 32000 },
  { id: "lumen/judge-small", description: "Judge model, synthetic", price_per_m_input: 0.08, context: 8000 },
  { id: "lumen/judge-large", description: "Judge model, synthetic", price_per_m_input: 0.75, context: 128000 },
  { id: "quarry/decide-base", price_per_m_input: 0.3, context: 16000 },
  { id: "quarry/decide-long", description: "Long-context variant, synthetic", price_per_m_input: 0.55, context: 512000 },
];

/** What an upstream lists for its kind, before the gateway adds hints and default prices. */
function upstreamListing(kind: ProviderKind, hinted: boolean): ProviderModel[] {
  switch (kind) {
    case "openrouter":
      return OPENROUTER_MODELS;
    case "openai":
      return [{ id: "gpt-6-luna", description: "Luna decision model", context: 128000 }];
    case "systemone":
      // The gateway asks a hinted SystemOne server for its listing; the mock's servers list nothing.
      return hinted ? [] : [{ id: "server-configured", description: "Whatever the SystemOne server is serving" }];
    case "mock":
      return [{ id: "mock-1", description: "Deterministic mock answers" }];
    case "openai-compatible":
      return [{ id: VLLM_MODEL, description: "Whatever the vLLM server is serving, synthetic", context: 8000 }];
  }
}

/** The default price the gateway reports for a listed model, by its rule (API reference, Cost, step 2). */
function listedDefault(provider: PricedProvider, model: ProviderModel): number | undefined {
  if (provider.kind === "mock") return 0;
  if (provider.kind === "openrouter") return model.price_per_m_input;
  if (provider.kind === "openai") return model.id === "gpt-6-luna" ? 0.1 : undefined;
  return hintPrice(provider.model_hints, model.id) ?? undefined;
}

/**
 * The models a provider's catalog lists, as GET /admin/api/providers/:id/models does: for a SystemOne or
 * OpenAI-compatible provider its hints first (each field a hint sets wins), then the listing; each model
 * with the default price the gateway reports for it (default_price_per_m_input). The mock mirrors the backend.
 */
export function modelsFor(provider: PricedProvider): ProviderModel[] {
  const hints = kindUsesHints(provider.kind) ? (provider.model_hints ?? []) : [];
  const listed = upstreamListing(provider.kind, hints.length > 0);
  const merged: ProviderModel[] = [
    ...hints.map((hint) => ({ ...listed.find((model) => model.id === hint.id), ...hint })),
    ...listed.filter((model) => !hints.some((hint) => hint.id === model.id)),
  ];
  return merged.map((model) => {
    const price = listedDefault(provider, model);
    return price === undefined ? model : { ...model, default_price_per_m_input: price };
  });
}

/** The catalog of a provider of this kind with no address and no hints. */
export function modelsForKind(kind: ProviderKind): ProviderModel[] {
  return modelsFor({ kind });
}

const PROVIDER_BY_NAME: Readonly<Record<string, PricedProvider>> = {
  mock: { kind: "mock" },
  openai: { kind: "openai" },
  openrouter: { kind: "openrouter" },
  llamacpp: { kind: "systemone", base_url: "http://host.docker.internal:8080" },
  vllm: { kind: "openai-compatible", base_url: "http://host.docker.internal:8000" },
};

export interface MockCost {
  cost_usd: number | null;
  cost_basis: CostBasis;
  tokens: number;
}

/**
 * The cost of an answered attempt, resolved as API reference says: what the upstream billed, when it
 * reports that (basis upstream_cost, whatever any price says); else the step's own price, else the
 * provider's default (zero for mock, catalog, the built-in OpenAI table, or a hint), else unpriced. Upstream
 * tokens win over the estimate.
 */
export function mockCost(
  subject: PriceSubject,
  model: string,
  override: number | null | undefined,
  upstreamTokens: number | null,
  estimatedTokens: number,
  billed: number | null = null,
): MockCost {
  const provider = pricedProvider(subject) ?? { kind: "openai-compatible" };
  const tokens = upstreamTokens ?? estimatedTokens;
  if (provider.kind === "mock" && billed === null) billed = 0;
  if (billed !== null && Number.isFinite(billed) && billed >= 0) return { cost_usd: billed, cost_basis: "upstream_cost", tokens };
  const resolved =
    override !== null && override !== undefined
      ? { price: override, source: "override" as const }
      : defaultPrice(provider, model, modelsFor(provider));
  if (resolved.price === null) return { cost_usd: null, cost_basis: "unpriced", tokens };
  return { cost_usd: costAt(tokens, resolved.price), cost_basis: upstreamTokens !== null ? "upstream_tokens" : "estimated_tokens", tokens };
}

/** Vendor names as OpenRouter reports them, by the prefix of a model id. Others read as the prefix, capitalised. */
const VENDOR_NAMES: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  baseten: "Baseten",
  perplexity: "Perplexity",
  typesafe: "TypeSafe",
  liquid: "Liquid",
  deepinfra: "DeepInfra",
};

/** The day the mock's OpenRouter dates the model ids it resolves, as OpenRouter does ("…-20261016"). */
const RESOLVED_ON = "20261016";

export interface MockSelf {
  /** Who the upstream says served the answer. */
  servedBy: string | null;
  /** The model id the upstream says it resolved. */
  resolvedModel: string | null;
  /** Whether the upstream reports what it billed. */
  bills: boolean;
}

/**
 * What an upstream of this kind says about itself, as the real ones do (API reference, Upstream wires):
 * OpenRouter names the vendor that served the model and a dated model id, and reports what it billed; the
 * built-in mock names itself and bills 0; OpenAI names its model; the others say nothing.
 */
export function mockSelf(kind: ProviderKind, model: string): MockSelf {
  if (kind === "openrouter") {
    const prefix = model.includes("/") ? (model.split("/")[0] ?? "") : "";
    const vendor = VENDOR_NAMES[prefix] ?? (prefix ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : null);
    return { servedBy: vendor, resolvedModel: `${model}-${RESOLVED_ON}`, bills: true };
  }
  if (kind === "mock") return { servedBy: "Mock", resolvedModel: model, bills: true };
  if (kind === "openai") return { servedBy: null, resolvedModel: model, bills: false };
  return { servedBy: null, resolvedModel: null, bills: false };
}

/**
 * What the upstream billed for `tokens` input tokens, when it bills: OpenRouter its catalog price for the
 * model (0 when the catalog has none), the mock 0. Null for an upstream that reports no cost.
 */
export function mockBilled(subject: PriceSubject, model: string, tokens: number): number | null {
  const provider = pricedProvider(subject) ?? { kind: "openai-compatible" };
  if (!mockSelf(provider.kind, model).bills) return null;
  if (provider.kind === "mock") return 0;
  const listed = modelsFor(provider).find((entry) => entry.id === model)?.price_per_m_input ?? 0;
  return costAt(tokens, listed) ?? 0;
}

/** ceil(characters / 4) over the text sent upstream: the input, and every question's instructions and options. */
export function estimateTokens(request: {
  input: string;
  questions: readonly { instructions: string; choices?: readonly { description: string }[]; levels?: readonly { description: string }[] }[];
}): number {
  let characters = request.input.length;
  for (const question of request.questions) {
    characters += question.instructions.length;
    for (const choice of question.choices ?? []) characters += choice.description.length;
    for (const level of question.levels ?? []) characters += level.description.length;
  }
  return Math.ceil(characters / 4);
}

/** The options of the captured sample question. */
const DEPARTMENTS = ["billing", "technical", "other"] as const;

const SAMPLE_INPUTS = [
  "I was charged twice for my March invoice and the second charge still shows on my card. Please reverse it today.",
  "Customer asks whether invoice 4411 was paid; the ledger shows a partial payment of 40 of 120.",
  "Checkout error rate rose from 0.4% to 6% right after the 14:00 deploy; p95 latency doubled.",
  "The export job has been stuck at 80% for an hour and the customer's board pack is due tomorrow.",
  "Can I change the billing email on my account? I think the old one is an ex-colleague's address.",
  "App crashes on launch after the last update. Works fine on the previous version.",
  "Requesting a refund for an annual plan cancelled after 5 days of use.",
  "How do I add a second admin to my workspace before the audit on Friday?",
];

const UPSTREAM_OK_LATENCY = { openai: [260, 700], openrouter: [500, 1300], mock: [15, 50], vllm: [90, 260] } as const;

interface Outcome {
  provider: string;
  model: string;
  ok: boolean;
  status: number;
  latency: number;
  error: string | null;
  fallback: boolean;
  attempts: Attempt[];
}

function sampleLatency(rand: () => number, range: readonly [number, number]): number {
  const [low, high] = range;
  return Math.round(low + (high - low) * rand() * rand());
}

/** Builds one day-plus of synthetic request logs, newest first. */
export function generateLogs(nowMs: number, seed: number, keyMissingSinceMs: number): LogEntry[] {
  const rand = seededRandom(seed);
  const count = 1400;
  const entries: { tsMs: number; route: string | null; provider: string; model: string; questions: number; input: string; outcome: Outcome }[] =
    [];

  for (let i = 0; i < count; i += 1) {
    const recent = rand() < 0.42;
    const ageMs = recent ? rand() * DAY : DAY + rand() * 6 * DAY;
    const tsMs = nowMs - Math.round(ageMs / 1000) * 1000;
    const pick = rand();
    const input = SAMPLE_INPUTS[Math.floor(rand() * SAMPLE_INPUTS.length)] ?? SAMPLE_INPUTS[0]!;
    const questions = 1 + Math.floor(rand() * 4);
    const keyMissing = tsMs >= keyMissingSinceMs;

    let route: string | null;
    let provider: string;
    let model: string;
    let outcome: Outcome;

    if (pick < 0.55) {
      route = "luna";
      // A failing primary answers with a fast upstream error, so the fallback is what makes the
      // request slow, as it is in practice. A timeout here would put every bucket's p95 at the timeout.
      // While the OpenRouter key is missing, the primary is failing too, so some fallbacks fail as well.
      const primaryFails = rand() < (keyMissing ? 0.2 : 0.035);
      const primaryLatency = primaryFails ? sampleLatency(rand, [150, 450]) : sampleLatency(rand, UPSTREAM_OK_LATENCY.openai);
      const primaryAttempt: Attempt = {
        provider: "openai",
        model: "gpt-6-luna",
        ok: !primaryFails,
        latency_ms: primaryLatency,
        error: primaryFails ? "upstream returned 503" : null,
      };
      if (!primaryFails) {
        provider = "openai";
        model = "gpt-6-luna";
        outcome = { provider, model, ok: true, status: 200, latency: primaryLatency, error: null, fallback: false, attempts: [primaryAttempt] };
      } else {
        const fallbackLatency = keyMissing ? 4 : sampleLatency(rand, UPSTREAM_OK_LATENCY.openrouter);
        const fallbackAttempt: Attempt = {
          provider: "openrouter",
          model: "openai/gpt-6-luna-decisions",
          ok: !keyMissing,
          latency_ms: fallbackLatency,
          error: keyMissing ? "OPENROUTER_API_KEY is not set" : null,
        };
        provider = "openrouter";
        model = "openai/gpt-6-luna-decisions";
        outcome = {
          provider,
          model,
          ok: !keyMissing,
          status: keyMissing ? 502 : 200,
          latency: primaryLatency + fallbackLatency,
          error: keyMissing ? "No usable provider: OPENROUTER_API_KEY is not set" : null,
          fallback: true,
          attempts: [primaryAttempt, fallbackAttempt],
        };
      }
    } else if (pick < 0.85) {
      route = "elephant";
      provider = "openrouter";
      model = "baseten/elephant-1";
      if (keyMissing) {
        outcome = {
          provider,
          model,
          ok: false,
          status: 502,
          latency: 4,
          error: "No usable provider: OPENROUTER_API_KEY is not set",
          fallback: false,
          attempts: [{ provider, model, ok: false, latency_ms: 4, error: "OPENROUTER_API_KEY is not set" }],
        };
      } else if (rand() < 0.004) {
        outcome = {
          provider,
          model,
          ok: false,
          status: 504,
          latency: 15000,
          error: "timeout",
          fallback: false,
          attempts: [{ provider, model, ok: false, latency_ms: 15000, error: "timeout" }],
        };
      } else {
        const latency = sampleLatency(rand, UPSTREAM_OK_LATENCY.openrouter);
        outcome = {
          provider,
          model,
          ok: true,
          status: 200,
          latency,
          error: null,
          fallback: false,
          attempts: [{ provider, model, ok: true, latency_ms: latency, error: null }],
        };
      }
    } else if (pick < 0.97) {
      route = "default";
      provider = "mock";
      model = "mock-1";
      const latency = sampleLatency(rand, UPSTREAM_OK_LATENCY.mock);
      outcome = {
        provider,
        model,
        ok: true,
        status: 200,
        latency,
        error: null,
        fallback: false,
        attempts: [{ provider, model, ok: true, latency_ms: latency, error: null }],
      };
    } else {
      route = null;
      provider = "openai";
      model = "gpt-6-luna";
      const failed = rand() < 0.03;
      const latency = failed ? 20000 : sampleLatency(rand, UPSTREAM_OK_LATENCY.openai);
      outcome = {
        provider,
        model,
        ok: !failed,
        status: failed ? 502 : 200,
        latency,
        error: failed ? "upstream returned 502" : null,
        fallback: false,
        attempts: [{ provider, model, ok: !failed, latency_ms: latency, error: failed ? "upstream returned 502" : null }],
      };
    }

    entries.push({ tsMs, route, provider: outcome.provider, model: outcome.model, questions, input, outcome });
  }

  // The vLLM model's traffic comes from its own generator, so the rest of the day is unchanged.
  const vllmRand = seededRandom(seed ^ 0x5eed);
  for (let i = 0; i < 160; i += 1) {
    const recent = vllmRand() < 0.45;
    const ageMs = recent ? vllmRand() * DAY : DAY + vllmRand() * 6 * DAY;
    const tsMs = nowMs - Math.round(ageMs / 1000) * 1000;
    const input = SAMPLE_INPUTS[Math.floor(vllmRand() * SAMPLE_INPUTS.length)] ?? SAMPLE_INPUTS[0]!;
    const questions = 1 + Math.floor(vllmRand() * 3);
    const vllmFails = vllmRand() < 0.06;
    const vllmLatency = vllmFails ? sampleLatency(vllmRand, [40, 120]) : sampleLatency(vllmRand, UPSTREAM_OK_LATENCY.vllm);
    const vllmAttempt: Attempt = {
      provider: "vllm",
      model: VLLM_MODEL,
      ok: !vllmFails,
      latency_ms: vllmLatency,
      error: vllmFails ? "upstream returned 500" : null,
    };
    let outcome: Outcome;
    if (!vllmFails) {
      outcome = {
        provider: "vllm",
        model: VLLM_MODEL,
        ok: true,
        status: 200,
        latency: vllmLatency,
        error: null,
        fallback: false,
        attempts: [vllmAttempt],
      };
    } else {
      const mockLatency = sampleLatency(vllmRand, UPSTREAM_OK_LATENCY.mock);
      outcome = {
        provider: "mock",
        model: "mock-1",
        ok: true,
        status: 200,
        latency: vllmLatency + mockLatency,
        error: null,
        fallback: true,
        attempts: [vllmAttempt, { provider: "mock", model: "mock-1", ok: true, latency_ms: mockLatency, error: null }],
      };
    }
    entries.push({ tsMs, route: "triage", provider: outcome.provider, model: outcome.model, questions, input, outcome });
  }

  entries.sort((a, b) => b.tsMs - a.tsMs);
  return entries.map((entry, index) => {
    const { outcome } = entry;
    const subject = PROVIDER_BY_NAME[outcome.provider] ?? "openai-compatible";
    const kind = pricedProvider(subject)?.kind ?? "openai-compatible";
    const estimated = Math.ceil((entry.input.length + entry.questions * 140) / 4);
    // The built-in mock reports the gateway's estimate as its input tokens; the others their own count.
    const counted = kind === "mock" ? estimated : 60 + entry.questions * 35 + (hashString(entry.input) % 120);
    const promptTokens = outcome.ok ? counted : null;
    const self = outcome.ok ? mockSelf(kind, outcome.model) : null;
    const cost = outcome.ok
      ? mockCost(subject, outcome.model, null, promptTokens, estimated, mockBilled(subject, outcome.model, counted))
      : null;
    const log: LogEntry = {
      id: `log_${String(entries.length - index).padStart(6, "0")}`,
      ts: new Date(entry.tsMs).toISOString(),
      route: entry.route,
      provider: outcome.provider,
      upstream_model: outcome.model,
      served_by: self?.servedBy ?? null,
      upstream_model_resolved: self?.resolvedModel ?? null,
      status: outcome.ok ? "ok" : "error",
      fallback_used: outcome.fallback,
      http_status: outcome.status,
      latency_ms: outcome.latency,
      questions: entry.questions,
      prompt_tokens: promptTokens,
      error: outcome.error,
      attempts: outcome.attempts,
      cost_usd: cost?.cost_usd ?? null,
      cost_basis: cost?.cost_basis ?? null,
      tokens: cost?.tokens ?? null,
      request: {
        model: entry.route ?? `${entry.provider}::${entry.model}`,
        input: entry.input,
        questions: [
          {
            name: "department",
            type: "choice",
            instructions: "Which team owns this ticket?",
            choices: DEPARTMENTS.map((value) => ({ value, description: value })),
          },
        ],
      },
    };
    if (outcome.ok) {
      // The captured answer, in OpenAI's Decisions shape as the gateway returns it.
      log.response = {
        answers: [
          {
            type: "choice",
            name: "department",
            choice: "billing",
            probabilities: [
              { value: "billing", probability: 0.86 },
              { value: "technical", probability: 0.1 },
              { value: "other", probability: 0.04 },
            ],
            confidence: 0.76,
            confidence_method: "upstream",
          },
        ],
      };
    }
    return log;
  });
}
