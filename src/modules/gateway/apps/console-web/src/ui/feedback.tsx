// Page structure and states: headers, panels, chips, loading, empty and error states.

import type { ReactNode } from "react";
import type { StationStatus } from "../domain/health";
import { cx } from "./cx";
import { Icon } from "./icons";
import { StationMark } from "./status";
import { isApiError } from "../api/errors";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

/** A titled region. `variant="panel"` draws it as a raised surface with a hairline. */
export function Section({
  title,
  id,
  meta,
  actions,
  children,
  className,
  variant = "plain",
}: {
  title: string;
  id?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  variant?: "plain" | "panel";
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} className={cx("section", variant === "panel" && "panel", className)} aria-labelledby={headingId}>
      <header className="section-head">
        <div className="section-head-text">
          <h2 id={headingId}>{title}</h2>
          {meta ? <p className="section-meta">{meta}</p> : null}
        </div>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export type FlagTone = "ok" | "warn" | "error" | "muted" | "info";

const FLAG_STATUS: Record<FlagTone, StationStatus | null> = { ok: "ok", warn: "degraded", error: "failing", muted: "disabled", info: null };

/** A chip for a state that is not a provider's health, drawn with the same station marks. */
export function Flag({ tone, children, className }: { tone: FlagTone; children: ReactNode; className?: string }) {
  const status = FLAG_STATUS[tone];
  return (
    <span className={cx("chip", `chip--${status ?? "info"}`, className)}>
      {status ? <StationMark status={status} size={11} /> : <span className="chip-dot" aria-hidden="true" />}
      <span>{children}</span>
    </span>
  );
}

export function describeError(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

export function ErrorState({ error, title = "This didn't load", onRetry }: { error: unknown; title?: string; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <p className="state-title">
        <StationMark status="failing" size={14} />
        <span>{title}</span>
      </p>
      <p className="state-body">{describeError(error)}</p>
      {onRetry ? (
        <button type="button" className="btn btn--secondary btn--small" onClick={onRetry}>
          <Icon name="refresh" size={14} />
          <span>Try again</span>
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state--empty">
      <p className="state-title">{title}</p>
      {children ? <p className="state-body">{children}</p> : null}
      {action ? <div className="state-action">{action}</div> : null}
    </div>
  );
}

export function LoadingRows({ rows = 4, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="loading-row" style={{ width: `${88 - (index % 3) * 14}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "error"; title?: string; children: ReactNode }) {
  const status: StationStatus | null = tone === "warn" ? "degraded" : tone === "error" ? "failing" : null;
  return (
    <div className={cx("notice", `notice--${tone}`)} role={tone === "error" ? "alert" : undefined}>
      <span className="notice-mark" aria-hidden="true">
        {status ? <StationMark status={status} size={14} /> : <span className="chip-dot" />}
      </span>
      <div className="notice-text">
        {title ? <p className="notice-title">{title}</p> : null}
        <div className="notice-body">{children}</div>
      </div>
    </div>
  );
}
