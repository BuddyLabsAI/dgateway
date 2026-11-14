import type { Log } from '../schemas/types';
import { round8 } from '../../decisions/functions/pricing';

// The latency percentile of the samples, or null when there are none. An empty window or bucket has
// no latency, and reporting zero would read as a measurement.
const percentile = (xs: number[], p: number): number | null =>
  xs.length ? xs.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * p) - 1)] : null;

const latencies = (items: Log[]) => items.map((l) => l.latency_ms);

// The cost of the requests that have one: the amount the upstream billed (basis upstream_cost) or the price the
// gateway worked out. Unpriced and failed requests have no cost, so they add nothing, and the sum is 0 (never
// null) when there are none.
const costs = (items: Log[]) => round8(items.reduce((sum, l) => sum + (l.cost_usd ?? 0), 0));

// Answered requests whose price was unknown, so no cost could be computed for them.
const unpriced = (items: Log[]) =>
  items.filter((l) => l.status === 'ok' && l.cost_basis === 'unpriced').length;

const outputUnpriced = (items: Log[]) =>
  items.filter((l) => l.status === 'ok' && l.cost_includes_output === false).length;

// A fallback is a request that recorded more than one attempt, so it moved on to a later target. It
// counts whether or not it was answered.
const fallbacks = (items: Log[]) => items.filter((l) => l.fallback_used).length;

// The fallbacks that were answered: requests that moved on to a later target and then got a response.
const fallbacksAnswered = (items: Log[]) =>
  items.filter((l) => l.fallback_used && l.status === 'ok').length;

export function stats(logs: Log[], window: '1h' | '24h' | '7d', now: number) {
  const duration = window === '1h' ? 3600000 : window === '7d' ? 604800000 : 86400000;
  const start = now - duration;
  const selected = logs.filter((l) => {
    const n = Date.parse(l.ts);
    return n >= start && n <= now;
  });

  const summarize = (items: Log[]) => ({
    requests: items.length,
    errors: items.filter((l) => l.status === 'error').length,
    p50_ms: percentile(latencies(items), 0.5),
    cost_usd: costs(items),
  });

  // A timeseries bucket adds its own p95 and fallback counts to the same summary.
  const bucket = (items: Log[]) => ({
    ...summarize(items),
    p95_ms: percentile(latencies(items), 0.95),
    fallbacks: fallbacks(items),
    fallbacks_answered: fallbacksAnswered(items),
  });

  // Each provider or route in the window, with its own unpriced count, so a label can say which of them went unpriced.
  const group = (field: 'provider' | 'route') => {
    const keys = [...new Set(selected.map((l) => l[field]).filter((x): x is string => x !== null))];
    return keys.map((k) => {
      const items = selected.filter((l) => l[field] === k);
      return {
        [field]: k,
        ...summarize(items),
        unpriced: unpriced(items),
        output_unpriced: outputUnpriced(items),
      };
    });
  };

  return {
    window,
    ...summarize(selected),
    p95_ms: percentile(latencies(selected), 0.95),
    fallbacks: fallbacks(selected),
    fallbacks_answered: fallbacksAnswered(selected),
    unpriced: unpriced(selected),
    output_unpriced: outputUnpriced(selected),
    by_provider: group('provider'),
    by_route: group('route'),
    timeseries: Array.from({ length: 24 }, (_, i) => {
      const a = start + (i * duration) / 24,
        b = start + ((i + 1) * duration) / 24;
      return {
        t: new Date(a).toISOString(),
        ...bucket(
          selected.filter((l) => {
            const n = Date.parse(l.ts);
            return n >= a && (i === 23 ? n <= b : n < b);
          }),
        ),
      };
    }),
  };
}
