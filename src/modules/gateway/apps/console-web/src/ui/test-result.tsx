// A test's result in plain words, inline where the test was started: on a Models row, a Providers card, the Add
// provider test step, the Add model test step and a step in the model editor. The verdict first ("✓ Works: it
// answered "billing" (97% sure), the expected answer."), then what was asked, then one line on who answered, with
// the model, the time and the cost. The answer bars, the attempts and the raw trace wait under Details.

import { useEffect, useRef, type ReactNode } from "react";
import { KNOWN_ANSWER } from "../domain/known-answer";
import type { TestOutcome } from "../domain/test-result";
import { reveal } from "../motion/motion";
import { AnswerView } from "./answers";
import { AttemptsTimeline } from "./attempts";
import { cx } from "./cx";
import { Disclosure, JsonBlock } from "./disclosure";

/** What the check asks: the ticket, the question and its options, with the expected one marked. */
export function KnownAnswerAsked() {
  const { question } = KNOWN_ANSWER;
  return (
    <div className="test-asked">
      <p className="test-asked-label">We asked</p>
      <div className="test-asked-body">
        <p className="test-asked-input">&ldquo;{KNOWN_ANSWER.input}&rdquo;</p>
        <p className="test-asked-question">{question.instructions}</p>
        <ul className="test-options" aria-label="The options">
          {question.choices.map((choice) => {
            const expected = choice.value === KNOWN_ANSWER.expected;
            return (
              <li key={choice.value} className={cx("test-option", expected && "is-expected")}>
                <span className="mono test-option-value">{choice.value}</span>
                <span className="test-option-about">{choice.description}</span>
                {expected ? <span className="test-option-tag">expected</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function TestResult({
  outcome,
  reason,
  priceHref,
  actions,
  className,
}: {
  outcome: TestOutcome;
  /** Why this model was tested: "Tested with gpt-6-luna, the model your "luna" uses." */
  reason?: string | null;
  /** Where a price can be set, for an answer that could not be priced. */
  priceHref?: string | null;
  actions?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { verdict } = outcome;

  useEffect(() => {
    reveal(ref.current);
  }, [outcome]);

  return (
    <div className={cx("test-result", `test-result--${verdict.tone}`, className)} ref={ref} role={verdict.tone === "error" ? "alert" : "status"}>
      <div className="test-head">
        <p className="test-verdict">
          <span className="test-verdict-mark" aria-hidden="true">
            {verdict.mark}
          </span>
          <span className="test-verdict-text">{verdict.text}</span>
        </p>
        {actions ? <div className="test-actions">{actions}</div> : null}
      </div>
      {reason ? <p className="test-reason">{reason}</p> : null}
      <KnownAnswerAsked />
      {outcome.meta ? (
        <p className="test-meta">
          <span>{outcome.meta}</span>
          {outcome.unpriced && priceHref ? (
            <a href={priceHref} className="test-meta-link">
              Set a price
            </a>
          ) : null}
        </p>
      ) : null}
      <Disclosure summary="Details" className="test-details">
        {outcome.response ? (
          <div className="answers answers--inline">
            {outcome.response.answers.map((answer, index) => (
              <AnswerView key={`${answer.name}-${index}`} answer={answer} />
            ))}
          </div>
        ) : null}
        <AttemptsTimeline attempts={outcome.attempts} />
        {outcome.trace ? <JsonBlock label="Raw trace" value={outcome.trace} /> : null}
      </Disclosure>
    </div>
  );
}
