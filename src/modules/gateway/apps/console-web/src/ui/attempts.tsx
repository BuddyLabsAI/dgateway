// The upstream attempts of one request as a timeline, in the order they ran, each segment as
// long as its latency. Failed tries stay visible: a fallback only makes sense next to the
// failure that caused it.

import { useEffect, useRef } from "react";
import type { Attempt } from "../api/types";
import { attemptTimeline, attemptsTotal } from "../domain/answers";
import { formatMs } from "../domain/format";
import { fillBars } from "../motion/motion";
import { cx } from "./cx";
import { StationMark } from "./status";

export function AttemptsTimeline({ attempts }: { attempts: readonly Attempt[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const segments = attemptTimeline(attempts);

  useEffect(() => {
    fillBars(trackRef.current);
  }, [attempts]);

  if (attempts.length === 0) {
    return <p className="field-hint">No upstream attempts were recorded.</p>;
  }

  const failed = attempts.filter((attempt) => !attempt.ok).length;
  return (
    <div className="attempts">
      <p className="attempts-summary">
        {attempts.length === 1 ? "1 attempt" : `${attempts.length} attempts`}
        {failed > 0 ? `, ${failed} failed` : ""} · <span className="mono">{formatMs(attemptsTotal(attempts))}</span> upstream in total
      </p>
      <div className="attempts-track" ref={trackRef} aria-hidden="true">
        {segments.map((segment) => (
          <span
            key={segment.index}
            className={cx("attempt-seg", segment.attempt.ok ? "attempt-seg--ok" : "attempt-seg--fail")}
            style={{ left: `${segment.start * 100}%`, width: `${segment.width * 100}%` }}
          >
            <span className="attempt-seg-n">{segment.index + 1}</span>
          </span>
        ))}
      </div>
      <ol className="attempt-list" aria-label="Upstream attempts, in the order they were made">
        {attempts.map((attempt, index) => (
          <li key={`${index}-${attempt.provider}`} className={cx("attempt", !attempt.ok && "attempt--fail")}>
            <span className="attempt-n mono" aria-hidden="true">
              {index + 1}
            </span>
            <StationMark status={attempt.ok ? "ok" : "failing"} size={11} />
            <span className="attempt-who">
              <span className="mono attempt-provider">{attempt.provider}</span>
              <span className="mono attempt-model">{attempt.model}</span>
            </span>
            <span className="attempt-outcome">{attempt.ok ? "Answered" : (attempt.error ?? "Failed")}</span>
            <span className="attempt-ms mono">{formatMs(attempt.latency_ms)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
