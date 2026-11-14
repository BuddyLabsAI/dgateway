import { describe, expect, test } from "bun:test";
import {
  bandEdgePath,
  bandFillPath,
  bandLayout,
  bandRuns,
  bucketAt,
  latencyAxisMax,
  latencyBand,
  linePath,
  morphScales,
  niceCeil,
  niceTicks,
  scaleLinear,
  stackBoxes,
  stackBuckets,
  stepBucket,
  trafficLayers,
} from "../../../src/modules/gateway/apps/console-web/src/domain/chart";
import { trafficSummary } from "../../../src/modules/gateway/apps/console-web/src/domain/overview";
import { formatCompact, formatRatio } from "../../../src/modules/gateway/apps/console-web/src/domain/format";
import { latencyFraction, latencyScaleMax } from "../../../src/modules/gateway/apps/console-web/src/domain/logs";
import type { StatsBucket } from "../../../src/modules/gateway/apps/console-web/src/api/types";

function bucket(t: string, requests: number, errors: number, p50: number | null, fallbacks = 0, fallbacksAnswered = 0): StatsBucket {
  return { t, requests, errors, p50_ms: p50, p95_ms: p50 === null ? null : p50 * 2, fallbacks, fallbacks_answered: fallbacksAnswered };
}

// Ten pixels per bucket, starting at zero, for the band tests.
const slot = (index: number) => ({ left: index * 10, right: index * 10 + 10 });

describe("scales and ticks", () => {
  test("a linear scale maps the domain onto the range, inverted for SVG's y axis", () => {
    const y = scaleLinear([0, 40], [200, 20]);
    expect(y(0)).toBe(200);
    expect(y(40)).toBe(20);
    expect(y(20)).toBe(110);
  });

  test("a zero-width domain maps everything to the range start instead of dividing by zero", () => {
    expect(scaleLinear([5, 5], [0, 100])(5)).toBe(0);
  });

  test("nice ceilings land on 1, 2, 2.5 or 5 times a power of ten", () => {
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(0.3)).toBe(0.5);
    expect(niceCeil(230)).toBe(250);
    expect(niceCeil(1200)).toBe(2000);
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
  });

  test("ticks start at zero, step evenly and cover the maximum", () => {
    expect(niceTicks(38, 4)).toEqual({ max: 40, step: 10, values: [0, 10, 20, 30, 40] });
    expect(niceTicks(1120, 3).max).toBe(1500);
    expect(niceTicks(1120, 3).values).toEqual([0, 500, 1000, 1500]);
    const tiny = niceTicks(0, 4);
    expect(tiny.values[0]).toBe(0);
    expect(tiny.max).toBeGreaterThan(0);
  });
});

describe("bucket stacking", () => {
  test("layers stack bottom up, each segment starting where the one below ends", () => {
    const stacks = stackBuckets(
      [
        { key: "ok", values: [8, 0, 5] },
        { key: "error", values: [2, 3, 0] },
      ],
      3,
    );
    expect(stacks[0]).toEqual([
      { key: "ok", value: 8, y0: 0, y1: 8 },
      { key: "error", value: 2, y0: 8, y1: 10 },
    ]);
    expect(stacks[1]?.[1]).toEqual({ key: "error", value: 3, y0: 0, y1: 3 });
    expect(stacks[2]?.[1]).toEqual({ key: "error", value: 0, y0: 5, y1: 5 });
  });

  test("missing, negative and non-finite values count as zero", () => {
    const stacks = stackBuckets(
      [
        { key: "ok", values: [-4, Number.NaN] },
        { key: "error", values: [2] },
      ],
      2,
    );
    expect(stacks[0]?.map((segment) => [segment.y0, segment.y1])).toEqual([
      [0, 0],
      [0, 2],
    ]);
    expect(stacks[1]?.map((segment) => segment.value)).toEqual([0, 0]);
  });

  test("traffic splits answered from failed, never below zero and never above the total", () => {
    const layers = trafficLayers([bucket("a", 10, 2, 300), bucket("b", 3, 5, 200), bucket("c", 0, 0, null)]);
    expect(layers.ok).toEqual([8, 0, 0]);
    expect(layers.error).toEqual([2, 3, 0]);
    expect(layers.total).toEqual([10, 3, 0]);
  });

  test("answered requests that came after a fallback are split out of the answered part, never added to it", () => {
    const buckets = [
      // 8 answered, and of 5 fallbacks 3 were answered and 2 failed.
      bucket("a", 10, 2, 300, 5, 3),
      // 4 answered, and the 6 errors were all fallbacks that failed, so none of the answers came after one.
      bucket("b", 10, 6, 300, 6, 0),
      // No errors, so all 4 fallbacks were answered.
      bucket("c", 10, 0, 300, 4, 4),
      // One of the 10 fallbacks was answered, and that is the only answered request.
      bucket("d", 10, 9, 300, 10, 1),
      // A count that claims more answers than the bucket has is kept within the answered count.
      bucket("f", 10, 8, 300, 5, 5),
      bucket("e", 0, 0, null, 0, 0),
    ];
    const layers = trafficLayers(buckets);
    expect(layers.fallback).toEqual([3, 0, 4, 1, 2, 0]);
    expect(layers.direct).toEqual([5, 4, 6, 0, 0, 0]);
    expect(layers.ok).toEqual([8, 4, 10, 1, 2, 0]);
    expect(layers.error).toEqual([2, 6, 0, 9, 8, 0]);
    const stacks = stackBuckets(
      [
        { key: "answered", values: layers.direct },
        { key: "fallback", values: layers.fallback },
        { key: "error", values: layers.error },
      ],
      buckets.length,
    );
    // The stacked heights are the request totals, so the fallback segment sits inside the answered part.
    expect(stacks.map((segments) => segments.reduce((sum, segment) => sum + segment.value, 0))).toEqual(layers.total);
    expect(layers.total).toEqual([10, 10, 10, 10, 10, 0]);
    expect(stacks[0]?.map((segment) => [segment.key, segment.y0, segment.y1])).toEqual([
      ["answered", 0, 5],
      ["fallback", 5, 8],
      ["error", 8, 10],
    ]);
    expect(stacks[1]?.map((segment) => [segment.key, segment.value])).toEqual([
      ["answered", 4],
      ["fallback", 0],
      ["error", 6],
    ]);
  });

  test("a fallback is set off from the answered segment below and the error segment above by the gap", () => {
    const y = scaleLinear([0, 10], [100, 0]); // 10px per request
    const [segments] = stackBuckets(
      [
        { key: "answered", values: [5] },
        { key: "fallback", values: [3] },
        { key: "error", values: [2] },
      ],
      1,
    );
    expect(stackBoxes(segments ?? [], y, 2, 2)).toEqual([
      { key: "answered", top: 52, bottom: 100 },
      { key: "fallback", top: 20, bottom: 50 },
      { key: "error", top: 0, bottom: 18 },
    ]);
  });

  test("a fallback too short to see keeps a minimum height, growing downwards", () => {
    const y = scaleLinear([0, 100], [100, 50]); // half a pixel per request
    const [segments] = stackBuckets(
      [
        { key: "answered", values: [40] },
        { key: "fallback", values: [1] },
        { key: "error", values: [0] },
      ],
      1,
    );
    expect(stackBoxes(segments ?? [], y, 2, 2)).toEqual([
      { key: "answered", top: 83.5, bottom: 100 },
      { key: "fallback", top: 79.5, bottom: 81.5 },
    ]);
  });

  test("without a fallback the segments keep their own edges, and empty segments are dropped", () => {
    const y = scaleLinear([0, 10], [100, 0]);
    const [segments] = stackBuckets(
      [
        { key: "answered", values: [4] },
        { key: "fallback", values: [0] },
        { key: "error", values: [3] },
      ],
      1,
    );
    expect(stackBoxes(segments ?? [], y, 2, 2)).toEqual([
      { key: "answered", top: 60, bottom: 100 },
      { key: "error", top: 30, bottom: 60 },
    ]);
    const [onAxis] = stackBuckets(
      [
        { key: "answered", values: [0] },
        { key: "fallback", values: [3] },
        { key: "error", values: [1] },
      ],
      1,
    );
    // Nothing is answered below the fallback, so it sits on the axis; the error above it is shortened.
    expect(stackBoxes(onAxis ?? [], y, 2, 2)).toEqual([
      { key: "fallback", top: 70, bottom: 100 },
      { key: "error", top: 60, bottom: 68 },
    ]);
  });
});

describe("the latency band and line", () => {
  test("a bucket's band runs from its p50 to its p95, and needs both ends", () => {
    expect(latencyBand(280, 910)).toEqual({ low: 280, high: 910 });
    expect(latencyBand(910, 280)).toEqual({ low: 280, high: 910 });
    expect(latencyBand(null, 910)).toBeNull();
    expect(latencyBand(280, null)).toBeNull();
  });

  test("bands join into runs over adjacent buckets, and an empty bucket breaks a run", () => {
    const y = scaleLinear([0, 1000], [100, 0]);
    const runs = bandRuns(
      [{ low: 200, high: 600 }, { low: 300, high: 500 }, null, { low: 100, high: 400 }, null, null, { low: 0, high: 0 }],
      slot,
      y,
    );
    expect(runs.map((run) => run.length)).toEqual([2, 1, 1]);
    expect(runs[0]?.[1]).toEqual({ left: 10, right: 20, top: 50, bottom: 70 });
    expect(runs[1]?.[0]).toEqual({ left: 30, right: 40, top: 60, bottom: 90 });
    expect(runs[2]?.[0]).toEqual({ left: 60, right: 70, top: 100, bottom: 100 });
    expect(bandRuns([null, null], slot, y)).toEqual([]);
  });

  test("a run's paths step from bucket to bucket, and its fill closes back along the p50 edge", () => {
    const y = scaleLinear([0, 1000], [100, 0]);
    const run =
      bandRuns(
        [
          { low: 200, high: 600 },
          { low: 300, high: 500 },
        ],
        slot,
        y,
      )[0] ?? [];
    expect(bandEdgePath(run)).toBe("M0 40 L10 40 L10 50 L20 50");
    expect(bandFillPath(run)).toBe("M0 40 L10 40 L10 50 L20 50 L20 70 L10 70 L10 80 L0 80 Z");
    expect(bandFillPath([])).toBe("");
  });

  test("the axis covers the highest median and p95, with headroom", () => {
    expect(latencyAxisMax([200, null, 450, 400])).toBeCloseTo(504);
    expect(latencyAxisMax([200, 300, 250, 1000])).toBeCloseTo(1120);
    expect(latencyAxisMax([null, null])).toBe(100);
  });

  test("a line lifts the pen over missing buckets", () => {
    expect(linePath([{ x: 0, y: 10 }, { x: 5, y: 12.345 }, null, { x: 15, y: 8 }, { x: 20, y: 9 }])).toBe("M0 10 L5 12.35 M15 8 L20 9");
    expect(linePath([null, null])).toBe("");
  });
});

describe("layout and the crosshair", () => {
  test("slots divide the width evenly with a centred bar", () => {
    const layout = bandLayout(4, 400, 0.25);
    expect(layout.step).toBe(100);
    expect(layout.bar).toBe(75);
    expect(layout.x(0)).toBe(12.5);
    expect(layout.center(3)).toBe(350);
  });

  test("the bucket under the pointer is clamped to the chart", () => {
    expect(bucketAt(0, 24, 480)).toBe(0);
    expect(bucketAt(479, 24, 480)).toBe(23);
    expect(bucketAt(-30, 24, 480)).toBe(0);
    expect(bucketAt(9999, 24, 480)).toBe(23);
    expect(bucketAt(100, 0, 480)).toBe(0);
  });

  test("arrow keys step the crosshair and stop at the ends; other keys are ignored", () => {
    expect(stepBucket(null, "ArrowLeft", 24)).toBe(23);
    expect(stepBucket(5, "ArrowRight", 24)).toBe(6);
    expect(stepBucket(23, "ArrowRight", 24)).toBe(23);
    expect(stepBucket(0, "ArrowLeft", 24)).toBe(0);
    expect(stepBucket(9, "Home", 24)).toBe(0);
    expect(stepBucket(9, "End", 24)).toBe(23);
    expect(stepBucket(9, "Enter", 24)).toBeNull();
    expect(stepBucket(null, "ArrowRight", 0)).toBeNull();
  });

  test("bars morph from their old height, and grow from nothing when they were empty", () => {
    expect(morphScales([0.5, 0, 0.2], [0.25, 0.4, 0])).toEqual([2, 0.001, 0.001]);
    expect(morphScales([], [0.3])).toEqual([0.001]);
    expect(morphScales([1], [0.01])).toEqual([8]);
  });
});

describe("chart text", () => {
  test("compact axis counts", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(1250)).toBe("1.3k");
    expect(formatCompact(12_000)).toBe("12k");
    expect(formatCompact(2_500_000)).toBe("2.5M");
    expect(formatCompact(null)).toBe("—");
  });

  test("ratios as percentages, with null kept apart from zero", () => {
    expect(formatRatio(0)).toBe("0%");
    expect(formatRatio(0.034)).toBe("3.4%");
    expect(formatRatio(0.25)).toBe("25%");
    expect(formatRatio(null)).toBe("—");
  });

  test("the traffic summary names the volume, the busiest bucket, the errors, the fallbacks and their onset", () => {
    const timeseries = [
      { t: "2026-11-07T10:00:00", requests: 10, errors: 0, fallbacks: 0 },
      { t: "2026-11-07T11:00:00", requests: 30, errors: 2, fallbacks: 3 },
      { t: "2026-11-07T12:00:00", requests: 20, errors: 0, fallbacks: 1 },
      { t: "2026-11-07T13:00:00", requests: 15, errors: 1, fallbacks: 0 },
    ];
    const text = trafficSummary({
      window: "24h",
      requests: 75,
      errors: 3,
      fallbacks: 4,
      fallbacksAnswered: 3,
      p50: 280.4,
      p95: 910,
      timeseries,
    });
    expect(text).toContain("75 requests in the last 24 hours.");
    expect(text).toContain("starting 11:00, had 30 requests");
    expect(text).toContain("3 errors across 2 buckets.");
    expect(text).toContain("The latest run of errors began 13:00.");
    expect(text).toContain("4 requests used a fallback across 2 buckets; 3 answered after it and 1 failed.");
    expect(text).toContain("Median latency 280 ms, p95 910 ms.");
  });

  test("a window with no fallbacks says so, and a single fallback takes the singular", () => {
    const quiet = [{ t: "2026-11-07T10:00:00", requests: 5, errors: 0, fallbacks: 0 }];
    expect(
      trafficSummary({ window: "1h", requests: 5, errors: 0, fallbacks: 0, fallbacksAnswered: 0, p50: null, p95: null, timeseries: quiet }),
    ).toContain("No requests used a fallback.");
    const one = [{ t: "2026-11-07T10:00:00", requests: 5, errors: 0, fallbacks: 1 }];
    expect(
      trafficSummary({ window: "1h", requests: 5, errors: 0, fallbacks: 1, fallbacksAnswered: 1, p50: null, p95: null, timeseries: one }),
    ).toContain("1 request used a fallback across 1 bucket, and all of them were answered.");
  });

  test("the fallback sentence says how many fallbacks were answered and how many failed", () => {
    const timeseries = [{ t: "2026-11-07T10:00:00", requests: 9, errors: 3, fallbacks: 3 }];
    const base = { window: "1h" as const, requests: 9, errors: 3, fallbacks: 3, p50: null, p95: null, timeseries };
    expect(trafficSummary({ ...base, fallbacksAnswered: 0 })).toContain(
      "3 requests used a fallback across 1 bucket, and none of them was answered.",
    );
    expect(trafficSummary({ ...base, fallbacksAnswered: 2 })).toContain(
      "3 requests used a fallback across 1 bucket; 2 answered after it and 1 failed.",
    );
    expect(trafficSummary({ ...base, fallbacksAnswered: 3 })).toContain(
      "3 requests used a fallback across 1 bucket, and all of them were answered.",
    );
  });

  test("an empty window says so plainly", () => {
    expect(
      trafficSummary({ window: "1h", requests: 0, errors: 0, fallbacks: 0, fallbacksAnswered: 0, p50: null, p95: null, timeseries: [] }),
    ).toBe("No requests in the last hour.");
  });
});

describe("log latency bars", () => {
  test("the slowest loaded request fills the bar", () => {
    expect(latencyScaleMax([{ latency_ms: 120 }, { latency_ms: 4000 }])).toBe(4000);
    expect(latencyScaleMax([])).toBe(1);
  });

  test("a square-root curve keeps fast requests visible beside an outlier", () => {
    expect(latencyFraction(4000, 4000)).toBe(1);
    expect(latencyFraction(1000, 4000)).toBeCloseTo(0.5);
    expect(latencyFraction(1, 100_000)).toBe(0.02);
    expect(latencyFraction(0, 4000)).toBe(0);
  });
});
