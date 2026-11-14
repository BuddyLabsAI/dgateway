// Pure formatters. Each one returns an em dash for a missing value rather than
// inventing a zero, because a missing measurement and a zero are different facts.

const MISSING = "—";
const countFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return countFormat.format(value);
}

/** Milliseconds as "312 ms" below one second, "1.24 s" above. */
export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
}

/** A count as a share of a total, formatted as formatRatio does. A zero or missing total gives an em dash. */
export function formatRate(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return MISSING;
  return formatRatio(numerator / denominator);
}

/** A probability in [0, 1] as a whole percentage, for bar labels. */
export function formatProbability(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

/** A confidence in [0, 1] with two decimals, as the API reports it. */
export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return value.toFixed(2);
}

/** Time elapsed since `then`, relative to `now`, in short words. */
export function formatRelative(then: number, now: number): string {
  if (!Number.isFinite(then)) return MISSING;
  const diff = now - then;
  const magnitude = Math.abs(diff);
  if (magnitude < 5_000) return "just now";
  const text =
    magnitude < 60_000
      ? `${Math.round(magnitude / 1000)} s`
      : magnitude < 3_600_000
        ? `${Math.round(magnitude / 60_000)} min`
        : magnitude < 86_400_000
          ? `${Math.round(magnitude / 3_600_000)} h`
          : `${Math.round(magnitude / 86_400_000)} d`;
  return diff < 0 ? `in ${text}` : `${text} ago`;
}

/** Uptime in seconds as "3 d 4 h", "4 h 12 min", "12 min" or "45 s". */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${total} s`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Local clock time as "14:05". */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Local date and clock time as "07 Nov 14:05", for tables and tooltips. */
export function formatStamp(ms: number): string {
  const date = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${pad(date.getDate())} ${months[date.getMonth()] ?? ""} ${formatClock(ms)}`;
}

/** A local calendar day as "8 Nov 2026", or an em dash for a time that does not parse. */
export function formatDay(ms: number): string {
  if (!Number.isFinite(ms)) return MISSING;
  const date = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getDate()} ${months[date.getMonth()] ?? ""} ${date.getFullYear()}`;
}

/** Token counts. Null means the upstream reported none. */
export function formatTokens(value: number | null | undefined): string {
  return formatCount(value);
}

/** Price per million input tokens, in USD, as the gateway reports it. */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return value < 0.1 ? value.toFixed(3) : value.toFixed(2);
}

/** Context window in tokens as "128k", or "512k" and so on. */
export function formatContext(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

/** Last four characters of a secret, prefixed with an ellipsis. */
export function formatLast4(last4: string): string {
  return `…${last4}`;
}

/** Compact counts for chart axes: "950", "1.2k", "12k", "1.5M". */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  const magnitude = Math.abs(value);
  if (magnitude < 1000) return String(Math.round(value));
  if (magnitude < 1_000_000) {
    const thousands = value / 1000;
    return `${Math.abs(thousands) < 10 ? Math.round(thousands * 10) / 10 : Math.round(thousands)}k`;
  }
  const millions = value / 1_000_000;
  return `${Math.abs(millions) < 10 ? Math.round(millions * 10) / 10 : Math.round(millions)}M`;
}

/**
 * A rate in [0, 1] as a percentage, rounded down: one decimal below 10% and a whole number from 10% up.
 * Rounding down keeps a figure from crossing a threshold it sits under, so 9.96% reads "9.9%" and
 * 49.96% reads "49%". A rate above zero but under 0.1% reads "<0.1%", so it is never shown as zero.
 * An em dash for null.
 */
export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return percentText(Math.min(100, Math.max(0, value * 100)));
}

function percentText(percent: number): string {
  if (percent === 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  // The epsilon absorbs binary error: 0.29 * 100 is 28.999..., which would otherwise floor to 28.9.
  return `${percent < 10 ? Math.floor(percent * 10 + 1e-9) / 10 : Math.floor(percent + 1e-9)}%`;
}
