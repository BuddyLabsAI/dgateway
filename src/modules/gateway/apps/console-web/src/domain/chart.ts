// Geometry for the hand-built SVG charts: scales, nice ticks, stacked buckets, the latency
// band, line paths with gaps, and which bucket sits under the pointer. No DOM, no effects.

import type { StatsBucket } from "../api/types";

export type Scale = (value: number) => number;

/** A linear map from a domain to a range. A zero-width domain maps everything to the range start. */
export function scaleLinear(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => r0;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** The smallest "nice" number (1, 2, 2.5 or 5 times a power of ten) at or above `value`. */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = NICE_STEPS.find((candidate) => candidate * magnitude >= value - 1e-9) ?? 10;
  return step * magnitude;
}

export interface Ticks {
  max: number;
  step: number;
  values: number[];
}

/** Evenly spaced ticks from zero that end on a nice number covering `max`. */
export function niceTicks(max: number, count = 4): Ticks {
  const safeCount = Math.max(1, Math.floor(count));
  const step = niceCeil(Math.max(max, 1e-9) / safeCount);
  const top = Math.max(step, Math.ceil(max / step - 1e-9) * step);
  const values: number[] = [];
  for (let tick = 0; tick <= top + step / 2; tick += step) values.push(Number(tick.toPrecision(12)));
  return { max: top, step, values };
}

export interface StackSegment {
  key: string;
  value: number;
  /** Bottom and top of the segment, in data units, counted from zero. */
  y0: number;
  y1: number;
}

export interface StackLayer {
  key: string;
  values: readonly number[];
}

/**
 * Stacks layers bucket by bucket, first layer at the bottom. Missing or negative values count
 * as zero, so a segment never hangs below the one under it.
 */
export function stackBuckets(layers: readonly StackLayer[], count: number): StackSegment[][] {
  return Array.from({ length: count }, (_, index) => {
    let floor = 0;
    return layers.map((layer) => {
      const raw = layer.values[index];
      const value = raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : 0;
      const segment = { key: layer.key, value, y0: floor, y1: floor + value };
      floor += value;
      return segment;
    });
  });
}

export interface SegmentBox {
  key: string;
  /** Top and bottom edges in pixels, with the top above the bottom. */
  top: number;
  bottom: number;
}

/**
 * The pixel boxes of one bucket's stacked segments, bottom first. A `fallback` segment is set off from
 * its neighbours: the answered segment below it and the error segment above it are shortened by `gap`
 * pixels, so the panel shows through at both boundaries and each side meets the panel's contrast. A
 * fallback segment keeps its edges and is drawn at least `floor` pixels tall, growing downwards, so a
 * single fallback at a small scale stays visible. Zero-height segments are dropped.
 */
export function stackBoxes(segments: readonly StackSegment[], y: Scale, gap: number, floor: number): SegmentBox[] {
  const boxes = segments.map((segment) => ({ key: segment.key, value: segment.value, top: y(segment.y1), bottom: y(segment.y0) }));
  boxes.forEach((box, index) => {
    if (box.key !== "fallback" || box.value <= 0) return;
    box.bottom = Math.max(box.bottom, box.top + floor);
    const below = boxes[index - 1];
    if (below && below.value > 0) below.top = box.bottom + gap;
    const above = boxes[index + 1];
    if (above && above.value > 0) above.bottom = box.top - gap;
  });
  return boxes.filter((box) => box.value > 0 && box.bottom - box.top > 0).map(({ key, top, bottom }) => ({ key, top, bottom }));
}

export interface TrafficLayers {
  /** Answered requests: the total less the errors. */
  ok: number[];
  /** Answered requests that came after a fallback. */
  fallback: number[];
  /** Answered requests that did not fall back: `ok` less `fallback`. */
  direct: number[];
  error: number[];
  total: number[];
}

/**
 * Splits each bucket into answered and failed requests, and the answered ones that came after a
 * fallback. The API counts errors inside requests, so answered is the difference, never below zero.
 * `fallbacks_answered` is exactly the answered fallbacks, so it is drawn as it is. It is kept within
 * the answered count, so inconsistent input can never draw past the answered part.
 */
export function trafficLayers(buckets: readonly StatsBucket[]): TrafficLayers {
  const rows = buckets.map((bucket) => {
    const total = Math.max(0, bucket.requests);
    const error = Math.max(0, Math.min(bucket.errors, total));
    const ok = total - error;
    const fallback = Math.min(ok, Math.max(0, bucket.fallbacks_answered));
    return { total, error, ok, fallback, direct: ok - fallback };
  });
  return {
    ok: rows.map((row) => row.ok),
    fallback: rows.map((row) => row.fallback),
    direct: rows.map((row) => row.direct),
    error: rows.map((row) => row.error),
    total: rows.map((row) => row.total),
  };
}

export interface LatencyBand {
  low: number;
  high: number;
}

/** A bucket's p50 to p95 range. Null when either end is missing, as in a bucket with no requests. */
export function latencyBand(p50: number | null, p95: number | null): LatencyBand | null {
  if (p50 === null || p95 === null || !Number.isFinite(p50) || !Number.isFinite(p95)) return null;
  return { low: Math.min(p50, p95), high: Math.max(p50, p95) };
}

export interface BandStep {
  /** The bucket's slot, left and right, in pixels. */
  left: number;
  right: number;
  /** The p95 edge and the p50 edge of the bucket, in pixels. */
  top: number;
  bottom: number;
}

/**
 * Each bucket's p50 to p95 band as runs of adjacent buckets that have one. A bucket with no band
 * ends the run before it, so a band is never carried across a gap.
 */
export function bandRuns(
  bands: readonly (LatencyBand | null)[],
  slot: (index: number) => { left: number; right: number },
  y: Scale,
): BandStep[][] {
  const runs: BandStep[][] = [];
  let open = false;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    if (!band) {
      open = false;
      continue;
    }
    if (!open) {
      runs.push([]);
      open = true;
    }
    const { left, right } = slot(index);
    runs[runs.length - 1]?.push({ left, right, top: y(band.high), bottom: y(band.low) });
  }
  return runs;
}

/** The p95 edge of one run, stepping from bucket to bucket with each slot's own value. */
export function bandEdgePath(run: readonly BandStep[]): string {
  return run
    .map((step, index) => `${index === 0 ? "M" : "L"}${round(step.left)} ${round(step.top)} L${round(step.right)} ${round(step.top)}`)
    .join(" ");
}

/** The filled band of one run: its p95 edge left to right, then its p50 edge back to the start. */
export function bandFillPath(run: readonly BandStep[]): string {
  if (run.length === 0) return "";
  const back = [...run].reverse().map((step) => `L${round(step.right)} ${round(step.bottom)} L${round(step.left)} ${round(step.bottom)}`);
  return `${bandEdgePath(run)} ${back.join(" ")} Z`;
}

/** The top of the latency axis: covers every bucket's median and p95, with headroom. */
export function latencyAxisMax(values: readonly (number | null)[]): number {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const highest = Math.max(0, ...finite);
  return highest === 0 ? 100 : highest * 1.12;
}

export interface Point {
  x: number;
  y: number;
}

/** An SVG path through the points, lifting the pen over nulls so a gap reads as a gap. */
export function linePath(points: readonly (Point | null)[]): string {
  const parts: string[] = [];
  let penDown = false;
  for (const point of points) {
    if (!point) {
      penDown = false;
      continue;
    }
    parts.push(`${penDown ? "L" : "M"}${round(point.x)} ${round(point.y)}`);
    penDown = true;
  }
  return parts.join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface BandLayout {
  /** Width of one bucket's slot. */
  step: number;
  /** Width of the bar drawn inside the slot. */
  bar: number;
  /** Left edge of the bar in slot `index`. */
  x: (index: number) => number;
  /** Centre of slot `index`. */
  center: (index: number) => number;
}

/** Splits `width` into `count` equal slots with a bar centred in each. */
export function bandLayout(count: number, width: number, gap = 0.28): BandLayout {
  const safeCount = Math.max(1, count);
  const step = width / safeCount;
  const bar = Math.max(1, step * (1 - Math.min(0.9, Math.max(0, gap))));
  return { step, bar, x: (index) => index * step + (step - bar) / 2, center: (index) => index * step + step / 2 };
}

/** The bucket under a horizontal position, clamped to the chart. */
export function bucketAt(x: number, count: number, width: number): number {
  if (count <= 0 || width <= 0) return 0;
  const index = Math.floor((x / width) * count);
  return Math.min(count - 1, Math.max(0, index));
}

/** Arrow keys move the crosshair; Home and End jump to the ends. Null for other keys. */
export function stepBucket(current: number | null, key: string, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  if (key === "ArrowRight") return current === null ? last : Math.min(last, current + 1);
  if (key === "ArrowLeft") return current === null ? last : Math.max(0, current - 1);
  return null;
}

/**
 * The scale each bar starts from when a new window arrives, so bars grow or shrink from their
 * old height to the new one using a transform only. Bars that were empty, or are empty now,
 * start from nothing.
 */
export function morphScales(previous: readonly number[], next: readonly number[]): number[] {
  return next.map((value, index) => {
    const before = previous[index] ?? 0;
    if (value <= 0 || before <= 0) return 0.001;
    return Math.min(8, Math.max(0.001, before / value));
  });
}
