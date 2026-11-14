// The brand: a line arriving at a station and leaving on two branches, the chosen one
// bright and the fallback beneath it. The wordmark sets the product's own name.

import { cx } from "./cx";

export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={cx("brand-mark", className)} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="6" className="brand-mark-tile" />
      <path d="M8 12l4 4h8.5" className="brand-mark-fallback" />
      <path d="M3.5 12H8l4-4h8.5" className="brand-mark-line" />
      <circle cx="8" cy="12" r="2.6" className="brand-mark-station" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx("wordmark", className)}>
      <span className="wordmark-strong">d</span>
      <span className="wordmark-soft">gateway</span>
    </span>
  );
}
