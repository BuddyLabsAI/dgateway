// Providers in the owner's terms: whether each one is ready to answer,
// what to call it, what its key situation is, and what its last test said. Pure.

import type { KeyRead, Provider, ProviderKind, ProviderLastTest, Route, WireShape } from "../api/types";
import type { StationStatus } from "./health";
import { formatMs, formatRelative } from "./format";
import { isLocalHost } from "./hosts";
import { presetForProvider } from "./provider-presets";

export type ConnectionStatus = "connected" | "needs-key" | "disabled";

export const CONNECTION_WORD: Record<ConnectionStatus, string> = { connected: "Connected", "needs-key": "Needs key", disabled: "Disabled" };

/** The station mark each provider status is drawn with. A provider without its key cannot answer. */
export const CONNECTION_MARK: Record<ConnectionStatus, StationStatus> = { connected: "ok", "needs-key": "failing", disabled: "disabled" };

export const KIND_LABEL: Record<ProviderKind, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  systemone: "SystemOne",
  "openai-compatible": "OpenAI-compatible",
  mock: "Mock",
};

export const KIND_SENTENCE: Record<ProviderKind, string> = {
  openai: "OpenAI's decisions endpoint, with your OpenAI API key.",
  openrouter: "OpenRouter's decisions endpoint, in alpha, with your OpenRouter key. It offers many SystemOne models and says who served each answer.",
  systemone: "A SystemOne decisions server: one you run (llama.cpp, Ollama) or a hosted vendor.",
  "openai-compatible": "Any server that speaks the OpenAI decisions shape, such as one you run yourself.",
  mock: "Built-in deterministic answers. Free, and needs no key: good for trying the API.",
};

/** The request format (the API's wire shape) in plain words. */
export const REQUEST_FORMAT: Record<WireShape, { label: string; sentence: string }> = {
  chat: { label: "Chat (synthetic)", sentence: "Synthetic decisions: logprobs work best, sampling is coarse, JSON is weakest. Models without logprobs need another enabled method." },
  openai: {
    label: "OpenAI decisions",
    sentence: "Sends the decision request as it is, with the upstream model set and any extra body merged in.",
  },
  map: { label: "SystemOne map", sentence: "Rewrites each question as a state and question map, then turns the answers back into decisions." },
};

/**
 * The tag a provider card shows so native and synthetic providers are told apart at a glance: "Synthetic" for the
 * chat wire (decisions made from a chat model), "Native" for a decision API, and none for the built-in mock.
 */
export function wireTag(provider: Pick<Provider, "kind" | "wire">): { text: "Synthetic" | "Native"; title: string } | null {
  if (provider.kind === "mock") return null;
  if (provider.wire === "chat") return { text: "Synthetic", title: "Synthetic decisions from a chat model, made by the gateway." };
  return { text: "Native", title: "The upstream's own decisions API." };
}

/** Kinds whose upstream refuses requests without a key. */
export function kindNeedsKey(kind: ProviderKind): boolean {
  return kind === "openai" || kind === "openrouter";
}

/** The fields that decide whether a provider needs a key. The address is optional: without it only the kind decides. */
export type KeyNeedFields = Pick<Provider, "kind" | "key"> & Partial<Pick<Provider, "base_url">>;

/** Whether this provider's upstream refuses requests without a key: OpenAI, OpenRouter, and a hosted SystemOne vendor. */
export function providerNeedsKey(provider: Pick<Provider, "kind"> & Partial<Pick<Provider, "base_url">>): boolean {
  if (kindNeedsKey(provider.kind)) return true;
  return provider.kind === "systemone" && provider.base_url !== undefined && !isLocalHost(provider.base_url);
}

/** Whether the gateway has the key this provider needs. A provider that needs none counts as having it. */
export function keyPresent(provider: KeyNeedFields): boolean {
  if (provider.key.source === "env") return provider.key.present;
  if (provider.key.source === "stored") return true;
  return !providerNeedsKey(provider);
}

export function connectionStatus(provider: Pick<Provider, "enabled"> & KeyNeedFields): ConnectionStatus {
  if (!provider.enabled) return "disabled";
  return keyPresent(provider) ? "connected" : "needs-key";
}

/**
 * What to call a provider on screen. The seeded providers are named after their kind
 * ("openai"), so they read as the brand ("OpenAI"); a name the owner chose is kept as typed.
 */
export function connectionTitle(name: string, kind?: ProviderKind | null): string {
  if (kind && name === kind) return KIND_LABEL[kind];
  const known = (Object.keys(KIND_LABEL) as ProviderKind[]).find((candidate) => candidate === name);
  return known ? KIND_LABEL[known] : name;
}

/** A lookup from a provider name (as logs and attempts carry it) to its title. */
export function titleLookup(providers: readonly Pick<Provider, "name" | "kind">[]): (name: string) => string {
  const kinds = new Map(providers.map((provider) => [provider.name, provider.kind]));
  return (name) => connectionTitle(name, kinds.get(name) ?? null);
}

/** One line on where the key comes from and whether the gateway has it. */
export function keySummary(provider: KeyNeedFields): string {
  const key: KeyRead = provider.key;
  if (key.source === "env") return key.present ? `${key.env_var} is set on the gateway host` : `${key.env_var} is not set on the gateway host`;
  if (key.source === "stored") return key.last4 === null ? "Stored key" : `Stored key ending …${key.last4}`;
  return providerNeedsKey(provider) ? "No key yet" : "No key needed";
}

/** The label of the field that replaces a stored key, with the key's last four characters when the gateway shows them. */
export function replaceKeyLabel(last4: string | null): string {
  return last4 === null ? "Replace the stored key" : `Replace the stored key (ends …${last4})`;
}

export interface LastTestView {
  /** How the test went, for its tone: ok, degraded (answered, not as expected) or failing; null before the first test. */
  status: StationStatus | null;
  /** The mark before the sentence, as on a test's verdict: ✓, ⚠ or ✗. */
  mark: "✓" | "⚠" | "✗" | null;
  text: string;
}

/**
 * The last recorded test, as a mark and a sentence: "✓ answered as expected · 2 min ago", "⚠ answered, but not as
 * expected · …", "✗ failed: <reason> · …". A test recorded before the gateway said whether it matched reads as
 * "✓ answered in 412 ms · …".
 */
export function lastTestSummary(lastTest: ProviderLastTest | null | undefined, now: number): LastTestView {
  if (!lastTest) return { status: null, mark: null, text: "Not tested yet" };
  const when = formatRelative(Date.parse(lastTest.at), now);
  if (!lastTest.ok) return { status: "failing", mark: "✗", text: `failed: ${lastTest.error ?? "no reason given"} · ${when}` };
  if (lastTest.matched === true) return { status: "ok", mark: "✓", text: `answered as expected · ${when}` };
  if (lastTest.matched === false) return { status: "degraded", mark: "⚠", text: `answered, but not as expected · ${when}` };
  return { status: "ok", mark: "✓", text: `answered in ${formatMs(lastTest.latency_ms)} · ${when}` };
}

/** Models (routes) with a step on this provider, in list order. */
export function modelsUsing(providerId: string, routes: readonly Route[]): Route[] {
  return routes.filter((route) => route.targets.some((target) => target.provider_id === providerId));
}

/** The environment variable a provider's key usually lives in, for the env-var option: its preset's, when one matches. */
export function suggestedEnvVar(provider: Pick<Provider, "kind" | "name" | "key"> & Partial<Pick<Provider, "base_url" | "path">>): string {
  if (provider.key.source === "env") return provider.key.env_var;
  if (provider.kind === "openai") return "OPENAI_API_KEY";
  if (provider.kind === "openrouter") return "OPENROUTER_API_KEY";
  const preset =
    provider.base_url !== undefined && provider.path !== undefined
      ? presetForProvider({ kind: provider.kind, base_url: provider.base_url, path: provider.path })
      : undefined;
  if (preset?.envVar) return preset.envVar;
  return `${provider.name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}_API_KEY`;
}

/** Providers in the order the owner wants to scan them: ready first, then those needing a key, then disabled. */
export function sortConnections<T extends Pick<Provider, "enabled" | "name"> & KeyNeedFields>(providers: readonly T[]): T[] {
  const rank: Record<ConnectionStatus, number> = { connected: 0, "needs-key": 1, disabled: 2 };
  return [...providers].sort((a, b) => rank[connectionStatus(a)] - rank[connectionStatus(b)]);
}
