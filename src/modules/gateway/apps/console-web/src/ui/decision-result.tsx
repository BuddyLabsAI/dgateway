// The result of a one-click decision (the first-run checklist's "Try the mock now"), inline where it
// was sent: who answered (and who served it, when the upstream says) and how fast, the answer itself,
// and what it cost; or, on failure, why, in one sentence, with the attempts collapsed under it. Tests
// show their results with ui/test-result.tsx instead.

import { useEffect, useRef, type ReactNode } from "react";
import type { GatewayInfo, PlaygroundRun } from "../api/types";
import { costLine } from "../domain/cost";
import { formatMs } from "../domain/format";
import { outcomeSentence } from "../domain/outcome";
import { reveal } from "../motion/motion";
import { AnswerView } from "./answers";
import { AttemptsTimeline } from "./attempts";
import { cx } from "./cx";
import { Disclosure } from "./disclosure";
import { Flag } from "./feedback";

type TitleOf = (name: string) => string;

/**
 * "$0.0000042 · 120 tokens, estimated" or "$0.00000177 · 177 tokens, billed by provider", with a way to
 * set a price when the answer was unpriced.
 */
export function CostLine({ gateway, priceHref }: { gateway: GatewayInfo; priceHref?: string | null }) {
  const unpriced = gateway.cost_basis === "unpriced";
  return (
    <p className={cx("cost-line", unpriced && "cost-line--unpriced")}>
      <span className="cost-line-label">Cost</span>
      <span className="mono">{costLine(gateway)}</span>
      {unpriced && priceHref ? (
        <a href={priceHref} className="cost-line-link">
          Set a price
        </a>
      ) : null}
    </p>
  );
}

export function DecisionResult({
  run,
  titleOf,
  priceHref,
  actions,
  className,
}: {
  run: PlaygroundRun;
  titleOf: TitleOf;
  priceHref?: string | null;
  actions?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    reveal(ref.current);
  }, [run]);

  const response = run.response;
  if (!response) {
    const sentence = outcomeSentence(
      { status: "error", attempts: run.trace.attempts, provider: "", error: run.error?.message ?? null },
      titleOf,
    );
    return (
      <div className={cx("decision", "decision--failed", className)} ref={ref} role="alert">
        <p className="decision-head">
          <Flag tone="error">Failed</Flag>
          <span className="decision-sentence">{sentence.replace(/^Failed: /, "")}</span>
        </p>
        {/* The run's error repeats the last attempt's, so the message is said in the sentence and once more in the attempts. */}
        {run.trace.attempts.length > 0 ? (
          <Disclosure summary="Attempts" className="decision-details">
            <AttemptsTimeline attempts={run.trace.attempts} />
          </Disclosure>
        ) : null}
        {actions ? <div className="decision-actions">{actions}</div> : null}
      </div>
    );
  }

  const gateway = response.gateway;
  const sentence = outcomeSentence(
    {
      status: "ok",
      attempts: gateway.attempts,
      provider: gateway.provider,
      error: null,
      served_by: gateway.served_by,
      upstream_model_resolved: gateway.upstream_model_resolved,
    },
    titleOf,
  );
  return (
    <div className={cx("decision", className)} ref={ref}>
      <p className="decision-head">
        <Flag tone={gateway.attempts.length > 1 ? "warn" : "ok"}>{formatMs(gateway.latency_ms)}</Flag>
        <span className="decision-sentence">{sentence}</span>
        {gateway.synthetic ? <Flag tone="warn">Synthetic</Flag> : null}
      </p>
      <div className="answers answers--inline">
        {response.answers.map((answer, index) => (
          <AnswerView key={`${answer.name}-${index}`} answer={answer} />
        ))}
      </div>
      <CostLine gateway={gateway} priceHref={priceHref} />
      {actions ? <div className="decision-actions">{actions}</div> : null}
    </div>
  );
}
