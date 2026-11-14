// Log helpers: the filters the Logs screen offers, the query the API takes for them, and the
// summary line above the table. The fallback filter is applied by the gateway, across the whole log.

import type { LogEntry, LogQuery } from "../api/types";

export type FallbackFilter = "any" | "used" | "none";
export type ResultFilter = "all" | "ok" | "error";

export interface LogFilters {
  route: string;
  provider: string;
  result: ResultFilter;
  fallback: FallbackFilter;
}

/** The query for these filters. An unset choice is left out, so the gateway applies no filter for it. */
export function logQuery(filters: LogFilters): Pick<LogQuery, "route" | "provider" | "status" | "fallback"> {
  return {
    route: filters.route || undefined,
    provider: filters.provider || undefined,
    status: filters.result === "all" ? undefined : filters.result,
    fallback: filters.fallback === "any" ? undefined : filters.fallback,
  };
}

export function summariseLoaded(items: readonly LogEntry[]): string {
  const errors = items.filter((item) => item.status === "error").length;
  const fallbacks = items.filter((item) => item.fallback_used).length;
  const rows = items.length === 1 ? "1 request" : `${items.length} requests`;
  return `${rows} loaded · ${errors} failed · ${fallbacks} used fallback`;
}

/** The latency that fills a whole bar in the log table: the slowest loaded request, at least 1 ms. */
export function latencyScaleMax(items: readonly Pick<LogEntry, "latency_ms">[]): number {
  return Math.max(1, ...items.map((item) => (Number.isFinite(item.latency_ms) ? item.latency_ms : 0)));
}

/**
 * A latency's bar length as a fraction of the scale. A square-root curve keeps fast requests
 * visible beside one slow outlier; a non-zero latency never draws as an empty bar.
 */
export function latencyFraction(latencyMs: number, scaleMax: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0 || scaleMax <= 0) return 0;
  return Math.min(1, Math.max(0.02, Math.sqrt(latencyMs / scaleMax)));
}
