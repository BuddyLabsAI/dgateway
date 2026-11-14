// Overview helpers: where the error runs sit on the 24-column flowsheet, and whether
// each provider is ready to take traffic, read from the health payload.

import type { HealthProvider, StatsWindow } from "../api/types";

export interface ColumnRun {
  start: number;
  end: number;
}

/** Runs of consecutive columns where the count is above zero. */
export function errorRuns(errors: readonly number[]): ColumnRun[] {
  const runs: ColumnRun[] = [];
  let start: number | null = null;
  errors.forEach((count, index) => {
    if (count > 0 && start === null) start = index;
    if (count <= 0 && start !== null) {
      runs.push({ start, end: index - 1 });
      start = null;
    }
  });
  if (start !== null) runs.push({ start, end: errors.length - 1 });
  return runs;
}

/** The run that reaches the latest column, or failing that the most recent run. */
export function latestErrorRun(errors: readonly number[]): ColumnRun | null {
  const runs = errorRuns(errors);
  if (runs.length === 0) return null;
  const last = runs[runs.length - 1];
  return last ?? null;
}

/** Keep onset labels within the sheet when the bracket begins in its right half. */
export function onsetLabelAlignRight(run: ColumnRun, columns: number): boolean {
  return run.start >= columns / 2;
}

export type Readiness = "ready" | "disabled" | "key-missing";

export interface ReadinessRow {
  name: string;
  enabled: boolean;
  readiness: Readiness;
}

export function readinessFromHealth(providers: readonly HealthProvider[]): ReadinessRow[] {
  return providers.map((provider) => {
    let readiness: Readiness = "ready";
    if (!provider.enabled) readiness = "disabled";
    else if (!provider.key_present) readiness = "key-missing";
    return { name: provider.name, enabled: provider.enabled, readiness };
  });
}

/** The gateway-level status shown in the rail. */
export type GatewayStatus = "healthy" | "attention" | "unreachable";

export function gatewayStatus(ok: boolean | null, readiness: readonly ReadinessRow[]): GatewayStatus {
  if (ok !== true) return "unreachable";
  return readiness.some((row) => row.readiness === "key-missing") ? "attention" : "healthy";
}

/** The label for a bucket's start time at the given window. */
export function bucketLabel(iso: string, window: StatsWindow): string {
  const date = new Date(iso);
  const hours = date.getHours();
  const minutes = date.getMinutes();

  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));

  if (window === "7d") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${days[date.getDay()] ?? ""} ${pad(hours)}`;
  }
  if (window === "24h") return `${pad(hours)}:00`;
  return `${pad(hours)}:${pad(minutes)}`;
}

export interface TrafficSummaryInput {
  window: StatsWindow;
  requests: number;
  errors: number;
  fallbacks: number;
  fallbacksAnswered: number;
  p50: number | null;
  p95: number | null;
  timeseries: readonly { t: string; requests: number; errors: number; fallbacks: number }[];
}

// How many requests used a fallback, in how many buckets, and how many were answered after it. A fallback
// that was not answered is one that failed.
function fallbackSentence(fallbacks: number, answered: number, buckets: number): string {
  const head = `${plural(fallbacks, "request", "requests")} used a fallback across ${plural(buckets, "bucket", "buckets")}`;
  const kept = Math.min(Math.max(0, answered), fallbacks);
  if (kept === fallbacks) return `${head}, and all of them were answered.`;
  if (kept === 0) return `${head}, and none of them was answered.`;
  return `${head}; ${plural(kept, "answered after it", "answered after it")} and ${(fallbacks - kept).toLocaleString("en-US")} failed.`;
}

const WINDOW_WORDS: Record<StatsWindow, string> = { "1h": "the last hour", "24h": "the last 24 hours", "7d": "the last 7 days" };

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** A plain sentence describing the traffic chart, read to screen readers in place of the bars. */
export function trafficSummary(input: TrafficSummaryInput): string {
  const span = WINDOW_WORDS[input.window];
  if (input.requests === 0) return `No requests in ${span}.`;
  const peak = input.timeseries.reduce<{ t: string; requests: number } | null>(
    (best, bucket) => (best === null || bucket.requests > best.requests ? bucket : best),
    null,
  );
  const failedBuckets = input.timeseries.filter((bucket) => bucket.errors > 0).length;
  const fallbackBuckets = input.timeseries.filter((bucket) => bucket.fallbacks > 0).length;
  const run = latestErrorRun(input.timeseries.map((bucket) => bucket.errors));
  const onset = run ? input.timeseries[run.start] : undefined;
  const parts = [`${plural(input.requests, "request", "requests")} in ${span}.`];
  if (peak)
    parts.push(`The busiest bucket, starting ${bucketLabel(peak.t, input.window)}, had ${plural(peak.requests, "request", "requests")}.`);
  if (input.errors === 0) parts.push("No errors.");
  else {
    parts.push(`${plural(input.errors, "error", "errors")} across ${plural(failedBuckets, "bucket", "buckets")}.`);
    if (onset) parts.push(`The latest run of errors began ${bucketLabel(onset.t, input.window)}.`);
  }
  if (input.fallbacks === 0) parts.push("No requests used a fallback.");
  else parts.push(fallbackSentence(input.fallbacks, input.fallbacksAnswered, fallbackBuckets));
  if (input.p50 !== null)
    parts.push(`Median latency ${Math.round(input.p50)} ms${input.p95 !== null ? `, p95 ${Math.round(input.p95)} ms` : ""}.`);
  return parts.join(" ");
}
