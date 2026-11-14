// Station status: the one health vocabulary the console uses for providers, on Overview,
// on the Providers cards, and on every step of a model's line. Each
// status pairs a drawn mark with a word, so it never depends on colour.

import type { HealthProvider, Provider, ProviderKind, ProviderStats, Route, RouteStats } from "../api/types";
import { connectionStatus, connectionTitle, providerNeedsKey, type KeyNeedFields } from "./connections";
import { formatRatio } from "./format";

export type StationStatus = "ok" | "degraded" | "failing" | "disabled";

/** Error rates in the selected window at which a provider counts as degraded or failing. */
export const ERROR_RATE_LIMITS = { degraded: 0.1, failing: 0.5 } as const;

export const STATUS_WORD: Record<StationStatus, string> = { ok: "Healthy", degraded: "Degraded", failing: "Failing", disabled: "Disabled" };

/** How bad a status is, for sorting the worst first. */
export const STATUS_RANK: Record<StationStatus, number> = { failing: 0, degraded: 1, ok: 2, disabled: 3 };

export type KeyReadiness = "ready" | "missing" | "none" | "unknown";

export interface StationVerdict {
  status: StationStatus;
  /** One short reason, such as "Needs key" or "12% errors". */
  reason: string;
}

/** A ratio of errors to requests, or null when there were no requests. */
export function errorRate(errors: number, requests: number): number | null {
  if (!Number.isFinite(requests) || requests <= 0) return null;
  return Math.min(1, Math.max(0, errors / requests));
}

// The error rate as the reason beside a station's status, rounded down like every other rate.
const errorReason = (rate: number): string => `${formatRatio(rate)} errors`;

/**
 * The status of a provider from what the gateway reports: disabled first, then a missing key
 * (it cannot answer at all), then its error rate in the window.
 */
export function stationVerdict(input: { enabled: boolean; keyPresent: boolean; requests: number; errors: number }): StationVerdict {
  if (!input.enabled) return { status: "disabled", reason: "Disabled" };
  if (!input.keyPresent) return { status: "failing", reason: "Needs key" };
  const rate = errorRate(input.errors, input.requests);
  if (rate === null) return { status: "ok", reason: "No traffic" };
  if (rate >= ERROR_RATE_LIMITS.failing) return { status: "failing", reason: errorReason(rate) };
  if (rate >= ERROR_RATE_LIMITS.degraded) return { status: "degraded", reason: errorReason(rate) };
  return { status: "ok", reason: rate === 0 ? "No errors" : errorReason(rate) };
}

/** Readiness from the saved configuration alone, for screens that have no traffic figures. */
export function configVerdict(provider: Pick<Provider, "enabled"> & KeyNeedFields): StationVerdict {
  const status = connectionStatus(provider);
  if (status === "disabled") return { status: "disabled", reason: "Disabled" };
  if (status === "needs-key") return { status: "failing", reason: "Needs key" };
  return { status: "ok", reason: "Ready" };
}

export function keyReadiness(provider: Provider | undefined, health: HealthProvider | undefined): KeyReadiness {
  if (provider?.key.source === "none") return providerNeedsKey(provider) ? "missing" : "none";
  if (health) return health.key_present ? "ready" : "missing";
  if (provider?.key.source === "env") return provider.key.present ? "ready" : "missing";
  if (provider?.key.source === "stored") return "ready";
  return "unknown";
}

export interface ProviderHealthRow {
  name: string;
  /** What the console calls the provider. */
  title: string;
  kind: ProviderKind | null;
  providerId: string | null;
  enabled: boolean;
  status: StationStatus;
  reason: string;
  requests: number;
  errors: number;
  errorRate: number | null;
  p50: number | null;
  key: KeyReadiness;
  /** This provider's share of all requests in the window, from 0 to 1. */
  share: number;
  /** USD spent through this provider in the window, when the gateway reports it. */
  cost: number | null;
  /** Answered requests through this provider that could not be priced, when the gateway reports it. */
  unpriced?: number;
}

/**
 * One row per provider the gateway knows about, joined with its traffic in the window and its
 * saved configuration when that has loaded. Worst status first, then busiest.
 */
export function providerHealth(
  health: readonly HealthProvider[],
  stats: readonly ProviderStats[],
  providers: readonly Provider[] = [],
): ProviderHealthRow[] {
  const total = stats.reduce((sum, row) => sum + Math.max(0, row.requests), 0);
  const names = new Set([...health.map((row) => row.name), ...stats.map((row) => row.provider)]);
  const rows = [...names].map((name): ProviderHealthRow => {
    const fromHealth = health.find((row) => row.name === name);
    const traffic = stats.find((row) => row.provider === name);
    const config = providers.find((row) => row.name === name);
    const requests = traffic?.requests ?? 0;
    const errors = traffic?.errors ?? 0;
    const enabled = fromHealth?.enabled ?? config?.enabled ?? true;
    const key = keyReadiness(config, fromHealth);
    const verdict = stationVerdict({ enabled, keyPresent: key !== "missing", requests, errors });
    return {
      name,
      title: connectionTitle(name, config?.kind ?? null),
      kind: config?.kind ?? null,
      providerId: config?.id ?? null,
      enabled,
      status: verdict.status,
      reason: verdict.reason,
      requests,
      errors,
      errorRate: errorRate(errors, requests),
      p50: traffic?.p50_ms ?? null,
      key,
      share: total > 0 ? requests / total : 0,
      cost: traffic?.cost_usd ?? (traffic ? null : 0),
      unpriced: traffic?.unpriced,
    };
  });
  return rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.requests - a.requests || a.name.localeCompare(b.name));
}

/** How many providers sit in each status, for the one-line summary above the table. */
export function statusCounts(rows: readonly { status: StationStatus }[]): Record<StationStatus, number> {
  const counts: Record<StationStatus, number> = { ok: 0, degraded: 0, failing: 0, disabled: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

export interface NetworkStation {
  position: number;
  providerId: string;
  providerName: string;
  /** What the console calls the provider. */
  title: string;
  model: string;
  status: StationStatus;
  reason: string;
  known: boolean;
  /** Number of other routes that also stop at this provider. */
  sharedWith: number;
}

export interface NetworkLine {
  id: string;
  alias: string;
  enabled: boolean;
  /** Index into the categorical line inks, stable for a route while the list order holds. */
  ink: number;
  requests: number;
  errors: number;
  errorRate: number | null;
  p50: number | null;
  /** USD spent on this model in the window, when the gateway reports it. */
  cost: number | null;
  /** Answered requests through this model that could not be priced, when the gateway reports it. */
  unpriced?: number;
  stations: NetworkStation[];
}

export const LINE_INKS = 5;

/**
 * Every route as a line of stations in fallback order. A station takes its provider's status
 * from `statusByName` (traffic-aware on Overview), falling back to its saved configuration.
 */
export function networkLines(
  routes: readonly Route[],
  providers: readonly Provider[],
  routeStats: readonly RouteStats[],
  statusByName: ReadonlyMap<string, StationVerdict> = new Map(),
): NetworkLine[] {
  const usage = new Map<string, Set<string>>();
  for (const route of routes) {
    for (const target of route.targets) {
      const users = usage.get(target.provider_id) ?? new Set<string>();
      users.add(route.id);
      usage.set(target.provider_id, users);
    }
  }
  return routes.map((route, index): NetworkLine => {
    const traffic = routeStats.find((row) => row.route === route.alias);
    const requests = traffic?.requests ?? 0;
    const errors = traffic?.errors ?? 0;
    return {
      id: route.id,
      alias: route.alias,
      enabled: route.enabled,
      ink: index % LINE_INKS,
      requests,
      errors,
      errorRate: errorRate(errors, requests),
      p50: traffic?.p50_ms ?? null,
      cost: traffic?.cost_usd ?? (traffic ? null : 0),
      unpriced: traffic?.unpriced,
      stations: route.targets.map((target, position): NetworkStation => {
        const provider = providers.find((candidate) => candidate.id === target.provider_id);
        const verdict: StationVerdict = provider
          ? (statusByName.get(provider.name) ?? configVerdict(provider))
          : { status: "failing", reason: "Provider not found" };
        return {
          position: position + 1,
          providerId: target.provider_id,
          providerName: provider?.name ?? "unknown provider",
          title: provider ? connectionTitle(provider.name, provider.kind) : "unknown provider",
          model: target.model,
          status: verdict.status,
          reason: verdict.reason,
          known: provider !== undefined,
          sharedWith: Math.max(0, (usage.get(target.provider_id)?.size ?? 1) - 1),
        };
      }),
    };
  });
}

export interface ChainStation extends NetworkStation {
  timeoutMs: number | null;
}

/** A model's steps as stations, for the editor's line, from saved configuration alone. */
export function chainStations(
  targets: readonly { provider_id: string; model: string; timeout_ms?: number }[],
  providers: readonly Provider[],
): ChainStation[] {
  return targets.map((target, index): ChainStation => {
    const provider = providers.find((candidate) => candidate.id === target.provider_id);
    const verdict: StationVerdict = provider
      ? configVerdict(provider)
      : { status: "failing", reason: target.provider_id ? "Provider not found" : "No provider chosen" };
    const fallbackName = target.provider_id ? "unknown provider" : "no provider";
    return {
      position: index + 1,
      providerId: target.provider_id,
      providerName: provider?.name ?? fallbackName,
      title: provider ? connectionTitle(provider.name, provider.kind) : fallbackName,
      model: target.model,
      status: verdict.status,
      reason: verdict.reason,
      known: provider !== undefined,
      sharedWith: 0,
      timeoutMs: target.timeout_ms ?? null,
    };
  });
}
