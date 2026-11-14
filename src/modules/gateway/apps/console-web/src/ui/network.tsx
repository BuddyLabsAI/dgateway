// A model drawn as a line through its stations, in fallback order. Each station is a connection:
// its ring takes the model's line ink, the mark inside it is the provider's status, and a
// skipped (disabled) station is joined by a dashed segment because traffic passes it by.

import type { NetworkStation } from "../domain/health";
import { STATUS_WORD } from "../domain/health";
import { stepRole } from "../domain/chain";
import { formatMs } from "../domain/format";
import { cx } from "./cx";
import { StationMark } from "./status";

export interface LineStop extends NetworkStation {
  timeoutMs?: number | null;
  /** A short note under the station, such as its price. */
  note?: string | null;
}

export function RouteLine({
  stops,
  ink,
  size = "md",
  label,
  muted = false,
}: {
  stops: readonly LineStop[];
  ink: number;
  size?: "md" | "lg";
  label: string;
  muted?: boolean;
}) {
  if (stops.length === 0) {
    return <p className="line-empty">No steps yet. Apps that send this model get an error until a step is added.</p>;
  }
  return (
    <ol className={cx("line", `line--${size}`, `ink-${ink}`, muted && "line--muted")} aria-label={label}>
      {stops.map((stop, index) => {
        const next = stops[index + 1];
        const skipped = stop.status === "disabled" || (next !== undefined && next.status === "disabled");
        return (
          <li
            key={`${stop.position}-${stop.providerId}`}
            className={cx("stop", `stop--${stop.status}`, stop.sharedWith > 0 && "stop--interchange")}
          >
            <span className="stop-rail" aria-hidden="true">
              <span className="stop-station">
                <StationMark status={stop.status} size={size === "lg" ? 12 : 10} />
              </span>
              {next ? <span className={cx("stop-track", skipped && "stop-track--skipped")} /> : null}
            </span>
            <span className="stop-text">
              {size === "lg" ? <span className="stop-order">{stepRole(stop.position)}</span> : null}
              <span className="stop-name">{stop.title}</span>
              {stop.model ? (
                <span className="stop-model mono" title={stop.model}>
                  {stop.model}
                </span>
              ) : null}
              <span className={cx("stop-state", `stop-state--${stop.status}`)}>
                {stop.status === "ok" ? STATUS_WORD.ok : stop.reason}
                {stop.timeoutMs !== undefined && stop.timeoutMs !== null ? ` · ${formatMs(stop.timeoutMs)} timeout` : ""}
              </span>
              {stop.note ? <span className="stop-note mono">{stop.note}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
