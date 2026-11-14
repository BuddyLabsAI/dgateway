// Code blocks for JSON bodies and the curl command, highlighted from a token stream whose
// text is exactly the source, so what is copied is what is shown.

import type { ReactNode } from "react";
import { tokenizeCurl, tokenizeJson, type CodeTokenKind, type Token } from "../domain/highlight";
import { cx } from "./cx";

export function CodeBlock({
  label,
  text,
  language,
  actions,
  className,
}: {
  label: string;
  text: string;
  language: "json" | "curl";
  actions?: ReactNode;
  className?: string;
}) {
  const tokens: Token<CodeTokenKind>[] = language === "json" ? tokenizeJson(text) : tokenizeCurl(text);
  return (
    <figure className={cx("code-block", className)}>
      <figcaption className="code-head">
        <span className="code-label">{label}</span>
        <span className="code-lang">{language}</span>
        {actions ? <span className="code-actions">{actions}</span> : null}
      </figcaption>
      <pre className="code-pre" tabIndex={0} aria-label={label}>
        <code>
          {tokens.map((token, index) =>
            token.kind === "space" || token.kind === "text" ? (
              token.text
            ) : (
              <span key={index} className={`tok tok-${token.kind}`}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </figure>
  );
}
