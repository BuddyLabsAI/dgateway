// Station marks: the console's status vocabulary. Each status has its own shape, so it reads
// without colour: filled disc (healthy), half disc (degraded), crossed ring (failing), dashed
// ring (disabled). A chip pairs the mark with a word.

import type { ReactNode } from "react";
import { STATUS_WORD, type StationStatus } from "../domain/health";
import { cx } from "./cx";

export function StationMark({ status, size = 12, className }: { status: StationStatus; size?: number; className?: string }) {
  return (
    <svg
      className={cx("station-mark", `station-mark--${status}`, className)}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      {status === "ok" ? <circle cx="6" cy="6" r="4.75" className="sm-fill" /> : null}
      {status === "degraded" ? (
        <>
          <circle cx="6" cy="6" r="4.25" className="sm-ring" />
          <path d="M6 1.75a4.25 4.25 0 0 0 0 8.5z" className="sm-fill" />
        </>
      ) : null}
      {status === "failing" ? (
        <>
          <circle cx="6" cy="6" r="4.25" className="sm-ring" />
          <path d="M4.1 4.1l3.8 3.8M7.9 4.1 4.1 7.9" className="sm-cross" />
        </>
      ) : null}
      {status === "disabled" ? <circle cx="6" cy="6" r="4.25" className="sm-ring sm-ring--dashed" /> : null}
    </svg>
  );
}

export function StatusChip({ status, children, className }: { status: StationStatus; children?: ReactNode; className?: string }) {
  return (
    <span className={cx("chip", `chip--${status}`, className)}>
      <StationMark status={status} size={11} />
      <span>{children ?? STATUS_WORD[status]}</span>
    </span>
  );
}
