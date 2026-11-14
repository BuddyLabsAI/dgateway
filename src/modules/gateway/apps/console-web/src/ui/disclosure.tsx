// Collapsible JSON and copy-to-clipboard. Disclosures are native <details> elements,
// so they work without script and read correctly to assistive technology.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { Button } from "./controls";
import { CodeBlock } from "./code";
import { Icon } from "./icons";
import { prettyJson } from "../domain/json";

export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "quiet",
  iconOnly = false,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  variant?: "quiet" | "secondary";
  /** Draws only the icon; the label stays as the accessible name. */
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button
      variant={variant}
      small
      onClick={() => void copy()}
      aria-live="polite"
      className={cx(copied && "is-copied", iconOnly && "btn--icon")}
      title={iconOnly ? label : undefined}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
      <span className={iconOnly ? "sr-only" : undefined}>{copied ? copiedLabel : label}</span>
    </Button>
  );
}

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details className={cx("disclosure", className)} open={defaultOpen}>
      <summary className="disclosure-summary">
        <Icon name="chevron" size={14} className="disclosure-chevron" />
        <span>{summary}</span>
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function JsonBlock({ label, value, empty = "Nothing captured." }: { label: string; value: unknown; empty?: string }) {
  if (value === undefined || value === null) {
    return (
      <div className="code-empty">
        <span className="code-label">{label}</span>
        <span>{empty}</span>
      </div>
    );
  }
  const text = prettyJson(value);
  return <CodeBlock label={label} text={text} language="json" actions={<CopyButton text={text} />} />;
}
