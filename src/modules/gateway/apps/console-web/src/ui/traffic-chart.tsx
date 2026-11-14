// The Overview's hero: requests per bucket stacked as answered, answered after a fallback, and
// failed, with each bucket's median latency line over its own p50 to p95 band, sharing one time
// axis. A crosshair and tooltip follow the pointer or the arrow keys; a sentence and a table carry
// the same data for screen readers and for anyone who prefers figures.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { StatsBucket, StatsWindow } from "../api/types";
import { useElementWidth } from "../app/hooks";
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
  niceTicks,
  scaleLinear,
  stackBoxes,
  stackBuckets,
  stepBucket,
  trafficLayers,
} from "../domain/chart";
import { formatUsd } from "../domain/cost";
import { formatClock, formatCompact, formatCount, formatMs, formatRate, formatStamp } from "../domain/format";
import { bucketLabel, latestErrorRun, onsetLabelAlignRight, trafficSummary } from "../domain/overview";
import { crossfade, drawBracket, morphBars } from "../motion/motion";
import { cx } from "./cx";
import { Icon } from "./icons";
import { Ticker } from "./ticker";

const GUTTER = { left: 52, right: 44 };
const TRAFFIC = { top: 30, height: 176 };
const LATENCY = { top: 10, height: 116, axis: 28 };
const TRAFFIC_SVG_HEIGHT = TRAFFIC.top + TRAFFIC.height + 1;
const LATENCY_SVG_HEIGHT = LATENCY.top + LATENCY.height + LATENCY.axis;
// The fallback hatch is a tile of diagonal stripes, in user units. A single fallback is often under a
// pixel tall at the 7d scale, so its segment keeps a visible minimum height; the exact count is in the
// legend, the tooltip and the table.
const HATCH = 6;
const HATCH_FLOOR = 2;
// The fallback segment is set off from the answered blue and from the error red by a gap of the panel
// colour, so each boundary has the panel's contrast on both sides.
const FALLBACK_GAP = 2;

export interface TrafficChartProps {
  buckets: readonly StatsBucket[];
  window: StatsWindow;
  requests: number;
  errors: number;
  fallbacks: number;
  fallbacksAnswered: number;
  p50: number | null;
  p95: number | null;
}

function bucketSpanMs(buckets: readonly StatsBucket[], index: number): number {
  const start = Date.parse(buckets[index]?.t ?? "");
  const next = Date.parse(buckets[index + 1]?.t ?? "");
  const previous = Date.parse(buckets[index - 1]?.t ?? "");
  if (Number.isFinite(next)) return next - start;
  if (Number.isFinite(previous)) return start - previous;
  return 0;
}

function bucketRange(buckets: readonly StatsBucket[], index: number): string {
  const start = Date.parse(buckets[index]?.t ?? "");
  if (!Number.isFinite(start)) return "";
  const span = bucketSpanMs(buckets, index);
  return span > 0 ? `${formatStamp(start)} to ${formatClock(start + span)}` : formatStamp(start);
}

export function TrafficChart({ buckets, window: windowId, requests, errors, fallbacks, fallbacksAnswered, p50, p95 }: TrafficChartProps) {
  const [frameRef, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const trafficRef = useRef<SVGSVGElement>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const bracketRef = useRef<SVGGElement>(null);
  const previousHeights = useRef<number[] | null>(null);
  const shownWindow = useRef<StatsWindow | null>(null);
  const ids = useId();
  const hatchId = `${ids.replace(/[^\w-]/g, "")}-hatch`;

  const count = buckets.length;
  const hasCost = buckets.some((bucket) => bucket.cost_usd !== undefined);
  const plotWidth = Math.max(0, width - GUTTER.left - GUTTER.right);
  const layers = useMemo(() => trafficLayers(buckets), [buckets]);
  const stacks = useMemo(
    () =>
      stackBuckets(
        [
          { key: "answered", values: layers.direct },
          { key: "fallback", values: layers.fallback },
          { key: "error", values: layers.error },
        ],
        count,
      ),
    [layers, count],
  );
  // Requests are whole numbers, so the axis never goes below four, which keeps every tick an integer.
  const yTicks = niceTicks(Math.max(4, ...layers.total), 4);
  const layout = bandLayout(count, plotWidth, 0.32);
  const y = scaleLinear([0, yTicks.max], [TRAFFIC.top + TRAFFIC.height, TRAFFIC.top]);

  const medians = buckets.map((bucket) => bucket.p50_ms);
  const p95s = buckets.map((bucket) => bucket.p95_ms);
  const latencyTicks = niceTicks(latencyAxisMax([...medians, ...p95s]), 3);
  const yLatency = scaleLinear([0, latencyTicks.max], [LATENCY.top + LATENCY.height, LATENCY.top]);

  const slot = (index: number) => ({ left: GUTTER.left + index * layout.step, right: GUTTER.left + (index + 1) * layout.step });

  const bandList = bandRuns(
    buckets.map((bucket) => latencyBand(bucket.p50_ms, bucket.p95_ms)),
    slot,
    yLatency,
  );
  const path = linePath(medians.map((value, index) => (value === null ? null : { x: GUTTER.left + layout.center(index), y: yLatency(value) })));

  const run = latestErrorRun(layers.error);
  const onset = run ? buckets[run.start] : undefined;
  const summary = trafficSummary({ window: windowId, requests, errors, fallbacks, fallbacksAnswered, p50, p95, timeseries: buckets });

  // Each bucket's stacked segments as pixel boxes, bottom first, with the fallback set off by the gap.
  const boxes = stacks.map((segments) => stackBoxes(segments, y, FALLBACK_GAP, HATCH_FLOOR));

  useEffect(() => {
    if (plotWidth <= 0) return;
    const heights = layers.total.map((total) => total / yTicks.max);
    if (shownWindow.current !== windowId) {
      const stacksEls = trafficRef.current?.querySelectorAll(".bar-stack");
      morphBars(stacksEls, morphScales(previousHeights.current ?? [], heights));
      crossfade(lineRef.current);
      drawBracket(bracketRef.current);
      shownWindow.current = windowId;
    }
    previousHeights.current = heights;
    // Animate when the window shown changes; refreshes inside a window update in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId, layers, plotWidth > 0]);

  const pick = (event: PointerEvent<HTMLDivElement>): void => {
    if (count === 0 || plotWidth <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setActive(bucketAt(event.clientX - bounds.left - GUTTER.left, count, plotWidth));
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      setActive(null);
      return;
    }
    const next = stepBucket(active, event.key, count);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  const activeBucket = active === null ? undefined : buckets[active];
  const activeLayers = active === null ? null : { ok: layers.ok[active] ?? 0, error: layers.error[active] ?? 0 };
  const cursorX = active === null ? 0 : GUTTER.left + layout.center(active);
  const tipOnLeft = active !== null && active >= count / 2;
  const announcement =
    activeBucket && activeLayers
      ? `${bucketRange(buckets, active ?? 0)}: ${formatCount(activeBucket.requests)} requests, ${formatCount(activeLayers.error)} errors, ${formatCount(activeBucket.fallbacks)} fallbacks, ${formatCount(activeBucket.fallbacks_answered)} answered after a fallback, median ${formatMs(activeBucket.p50_ms)}, p95 ${formatMs(activeBucket.p95_ms)}.`
      : "";

  return (
    <figure className={cx("tchart", active !== null && "has-active")} aria-labelledby={`${ids}-title`}>
      <figcaption className="tchart-head">
        <h2 id={`${ids}-title`} className="sr-only">
          Requests and latency over time
        </h2>
        <dl className="legend">
          <div className="legend-item legend-item--lead">
            <dt>Requests</dt>
            <dd>
              <Ticker className="legend-value" value={requests} format={(value) => formatCount(Math.round(value))} />
            </dd>
          </div>
          <div className="legend-item">
            <dt>
              <span className="swatch swatch--ok" aria-hidden="true" />
              Answered
            </dt>
            <dd>
              <Ticker
                className="legend-value legend-value--sub"
                value={Math.max(0, requests - errors)}
                format={(value) => formatCount(Math.round(value))}
              />
            </dd>
          </div>
          <div className={cx("legend-item", errors > 0 && "legend-item--alert")}>
            <dt>
              <span className="swatch swatch--error" aria-hidden="true" />
              Errors
            </dt>
            <dd>
              <Ticker className="legend-value legend-value--sub" value={errors} format={(value) => formatCount(Math.round(value))} />
              <span className="legend-note">{formatRate(errors, requests)}</span>
            </dd>
          </div>
          <div className="legend-item">
            <dt>
              <span className="swatch swatch--fallback" aria-hidden="true" />
              Fallbacks
            </dt>
            <dd>
              <Ticker className="legend-value legend-value--sub" value={fallbacks} format={(value) => formatCount(Math.round(value))} />
              <span className="legend-note">{formatCount(fallbacksAnswered)} answered</span>
            </dd>
          </div>
        </dl>
        <button
          type="button"
          className="btn btn--quiet btn--small tchart-toggle"
          aria-expanded={showTable}
          aria-controls={`${ids}-table`}
          onClick={() => setShowTable((current) => !current)}
        >
          <Icon name={showTable ? "chart" : "table"} size={14} />
          <span>{showTable ? "Hide table" : "Show as table"}</span>
        </button>
      </figcaption>

      <div
        ref={frameRef}
        className="tchart-plots"
        tabIndex={0}
        role="group"
        aria-label="Requests and latency by time bucket. Use the left and right arrow keys to read each bucket."
        aria-describedby={`${ids}-summary`}
        onPointerMove={pick}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        {plotWidth > 0 ? (
          <>
            <svg ref={trafficRef} className="tchart-svg" width={width} height={TRAFFIC_SVG_HEIGHT} aria-hidden="true">
              <defs>
                <pattern id={hatchId} width={HATCH} height={HATCH} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect className="hatch-ground" width={HATCH} height={HATCH} />
                  <line className="hatch-stripe" x1={HATCH / 2} y1={0} x2={HATCH / 2} y2={HATCH} />
                </pattern>
              </defs>
              {yTicks.values.map((tick) => (
                <g key={tick}>
                  <line
                    className={cx("grid", tick === 0 && "grid--base")}
                    x1={GUTTER.left}
                    x2={GUTTER.left + plotWidth}
                    y1={y(tick)}
                    y2={y(tick)}
                  />
                  <text className="axis" x={GUTTER.left - 10} y={y(tick)} textAnchor="end" dominantBaseline="middle">
                    {formatCompact(tick)}
                  </text>
                </g>
              ))}
              {boxes.map((segmentBoxes, index) => (
                <g key={buckets[index]?.t ?? index} className={cx("bar-stack", active === index && "is-active")}>
                  {segmentBoxes.map((box) => (
                    <rect
                      key={box.key}
                      className={`bar bar--${box.key}`}
                      x={GUTTER.left + layout.x(index)}
                      width={layout.bar}
                      y={box.top}
                      height={Math.max(1, box.bottom - box.top)}
                      rx={Math.min(2, layout.bar / 4)}
                      fill={box.key === "fallback" ? `url(#${hatchId})` : undefined}
                    />
                  ))}
                </g>
              ))}
              {run && onset ? (
                <>
                  <g ref={bracketRef} className="onset">
                    <path d={`M${GUTTER.left + layout.x(run.start)} ${TRAFFIC.top - 6}v-6H${GUTTER.left + layout.x(run.end) + layout.bar}v6`} />
                  </g>
                  <text
                    className="onset-label"
                    x={onsetLabelAlignRight(run, count) ? GUTTER.left + layout.x(run.end) + layout.bar : GUTTER.left + layout.x(run.start)}
                    y={TRAFFIC.top - 17}
                    textAnchor={onsetLabelAlignRight(run, count) ? "end" : "start"}
                  >
                    Errors since {bucketLabel(onset.t, windowId)}
                  </text>
                </>
              ) : null}
              {active !== null ? (
                <line className="cursor" x1={cursorX} x2={cursorX} y1={TRAFFIC.top - 2} y2={TRAFFIC.top + TRAFFIC.height} />
              ) : null}
              {requests === 0 ? (
                <text className="tchart-empty" x={GUTTER.left + plotWidth / 2} y={TRAFFIC.top + TRAFFIC.height / 2} textAnchor="middle">
                  No requests in this window
                </text>
              ) : null}
            </svg>

            <div className="tchart-sub">
              <span className="tchart-sub-title">Latency</span>
              <span className="legend-inline">
                <span className="swatch swatch--line" aria-hidden="true" />
                Median per bucket
              </span>
              <span className="legend-inline">
                <span className="swatch swatch--band" aria-hidden="true" />
                p50 to p95 per bucket
              </span>
              <span className="legend-figures" title="Across the whole window">
                <span className="legend-figure">
                  p50 <Ticker className="legend-value legend-value--sub" value={p50} format={(value) => formatMs(value)} />
                </span>
                <span className="legend-figure">
                  p95 <Ticker className="legend-value legend-value--sub" value={p95} format={(value) => formatMs(value)} />
                </span>
              </span>
            </div>

            <svg className="tchart-svg" width={width} height={LATENCY_SVG_HEIGHT} aria-hidden="true">
              {latencyTicks.values.map((tick) => (
                <g key={tick}>
                  <line
                    className={cx("grid", tick === 0 && "grid--base")}
                    x1={GUTTER.left}
                    x2={GUTTER.left + plotWidth}
                    y1={yLatency(tick)}
                    y2={yLatency(tick)}
                  />
                  <text className="axis" x={GUTTER.left - 10} y={yLatency(tick)} textAnchor="end" dominantBaseline="middle">
                    {tick === 0 ? "0" : formatMs(tick)}
                  </text>
                </g>
              ))}
              {bandList.map((steps) => (
                <g key={steps[0]?.left ?? 0} className="band">
                  <path className="band-fill" d={bandFillPath(steps)} />
                  <path className="band-edge band-edge--high" d={bandEdgePath(steps)} />
                </g>
              ))}
              <path ref={lineRef} className="latency-line" d={path} />
              {active !== null ? (
                <>
                  <line className="cursor" x1={cursorX} x2={cursorX} y1={LATENCY.top} y2={LATENCY.top + LATENCY.height} />
                  {activeBucket?.p50_ms !== null && activeBucket?.p50_ms !== undefined ? (
                    <circle className="latency-dot" cx={cursorX} cy={yLatency(activeBucket.p50_ms)} r={3.5} />
                  ) : null}
                </>
              ) : null}
              {buckets.map((bucket, index) =>
                index % 4 === 0 ? (
                  <g key={bucket.t}>
                    <line
                      className="tick"
                      x1={GUTTER.left + index * layout.step}
                      x2={GUTTER.left + index * layout.step}
                      y1={LATENCY.top + LATENCY.height}
                      y2={LATENCY.top + LATENCY.height + 4}
                    />
                    <text
                      className="axis"
                      x={GUTTER.left + index * layout.step}
                      y={LATENCY.top + LATENCY.height + 18}
                      textAnchor={index === 0 ? "start" : "middle"}
                    >
                      {bucketLabel(bucket.t, windowId)}
                    </text>
                  </g>
                ) : null,
              )}
            </svg>

            {activeBucket && activeLayers ? (
              <div
                className={cx("tchart-tip", tipOnLeft && "tchart-tip--left")}
                style={{
                  transform: tipOnLeft
                    ? `translate(calc(${cursorX - 14}px - 100%), ${TRAFFIC.top}px)`
                    : `translate(${cursorX + 14}px, ${TRAFFIC.top}px)`,
                }}
                aria-hidden="true"
              >
                <p className="tip-time">{bucketRange(buckets, active ?? 0)}</p>
                <dl className="tip-rows">
                  <div>
                    <dt>Requests</dt>
                    <dd>{formatCount(activeBucket.requests)}</dd>
                  </div>
                  <div>
                    <dt>
                      <span className="swatch swatch--ok" />
                      Answered
                    </dt>
                    <dd>{formatCount(activeLayers.ok)}</dd>
                  </div>
                  <div>
                    <dt>
                      <span className="swatch swatch--error" />
                      Errors
                    </dt>
                    <dd>
                      {formatCount(activeLayers.error)}
                      <span className="tip-note">{formatRate(activeLayers.error, activeBucket.requests)}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <span className="swatch swatch--fallback" />
                      Fallbacks
                    </dt>
                    <dd>
                      {formatCount(activeBucket.fallbacks)}
                      <span className="tip-note">· {formatCount(activeBucket.fallbacks_answered)} answered</span>
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <span className="swatch swatch--line" />
                      Median
                    </dt>
                    <dd>{formatMs(activeBucket.p50_ms)}</dd>
                  </div>
                  <div>
                    <dt>
                      <span className="swatch swatch--band" />
                      p95
                    </dt>
                    <dd>{formatMs(activeBucket.p95_ms)}</dd>
                  </div>
                  {activeBucket.cost_usd !== undefined ? (
                    <div>
                      <dt>Cost</dt>
                      <dd>{formatUsd(activeBucket.cost_usd)}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ) : null}
          </>
        ) : (
          <div className="tchart-placeholder" style={{ height: TRAFFIC_SVG_HEIGHT + LATENCY_SVG_HEIGHT + 32 }} />
        )}
      </div>

      <p id={`${ids}-summary`} className="sr-only">
        {summary}
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <div id={`${ids}-table`} hidden={!showTable} className="tchart-table">
        {showTable ? (
          <table className="sheet sheet--compact">
            <caption className="sr-only">
              Requests, errors, fallbacks, answered fallbacks, median and p95 latency, and cost for each time bucket
            </caption>
            <thead>
              <tr>
                <th scope="col">Bucket start</th>
                <th scope="col" className="num">
                  Requests
                </th>
                <th scope="col" className="num">
                  Errors
                </th>
                <th scope="col" className="num">
                  Error rate
                </th>
                <th scope="col" className="num">
                  Fallbacks
                </th>
                <th scope="col" className="num">
                  Answered after fallback
                </th>
                <th scope="col" className="num">
                  Median
                </th>
                <th scope="col" className="num">
                  p95
                </th>
                {hasCost ? (
                  <th scope="col" className="num">
                    Cost
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket, index) => (
                <tr key={bucket.t}>
                  <th scope="row" className="mono">
                    {formatStamp(Date.parse(bucket.t))}
                  </th>
                  <td className="num">{formatCount(bucket.requests)}</td>
                  <td className={cx("num", (layers.error[index] ?? 0) > 0 && "num--alert")}>{formatCount(layers.error[index] ?? 0)}</td>
                  <td className="num">{formatRate(layers.error[index] ?? 0, bucket.requests)}</td>
                  <td className="num">{formatCount(bucket.fallbacks)}</td>
                  <td className="num">{formatCount(bucket.fallbacks_answered)}</td>
                  <td className="num">{formatMs(bucket.p50_ms)}</td>
                  <td className="num">{formatMs(bucket.p95_ms)}</td>
                  {hasCost ? <td className="num">{formatUsd(bucket.cost_usd)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </figure>
  );
}
