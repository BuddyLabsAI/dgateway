// A decision's answers: the answer first (a choice's value, yes or no, a score's most likely level),
// then its probabilities as bars, a score's place on its rubric, and the confidence with its method.
// Shared by Try it and every one-click test.

import { useEffect, useRef } from "react";
import type { Answer, ChoiceValue } from "../api/types";
import { choiceRows, levelRows, methodLabel, rubric, topLevel, type ProbabilityRow } from "../domain/answers";
import { formatConfidence, formatProbability } from "../domain/format";
import { fillBars, slideIn } from "../motion/motion";
import { cx } from "./cx";
import { Icon } from "./icons";
import { StationMark } from "./status";

export function TypedValue({ value }: { value: ChoiceValue }) {
  const kind = typeof value;
  return (
    <span className="typed">
      <span className="mono typed-value">{kind === "string" ? `"${String(value)}"` : String(value)}</span>
      <span className="typed-tag">{kind}</span>
    </span>
  );
}

function AnswerHead({ name, type, synthetic = false }: { name: string; type: string; synthetic?: boolean }) {
  return (
    <header className="answer-head">
      <h3 className="answer-name mono">{name}</h3>
      {synthetic ? <span className="tag tag--quiet">Synthetic</span> : null}
      <span className="tag tag--quiet">{type}</span>
    </header>
  );
}

export function AnswerView({ answer }: { answer: Answer }) {
  const ref = useRef<HTMLElement>(null);
  const synthetic = "confidence_method" in answer && ["logprobs", "sampling", "json"].includes(answer.confidence_method ?? "");

  useEffect(() => {
    fillBars(Array.from(ref.current?.querySelectorAll<HTMLElement>(".bar-fill, .meter-fill") ?? []));
    const marker = ref.current?.querySelector<HTMLElement>(".rubric-marker");
    if (marker) slideIn(marker, 24);
  }, [answer]);

  if ("refusal" in answer) {
    return (
      <article className="answer answer--refused" ref={ref}>
        <AnswerHead synthetic={synthetic} name={answer.name} type={answer.type} />
        <p className="answer-value">
          <StationMark status="failing" size={16} />
          <span className="verdict">Refused</span>
        </p>
        <p className="answer-meta">{answer.refusal}</p>
      </article>
    );
  }

  if (answer.type === "predicate") {
    const yes = answer.probability >= 0.5;
    return (
      <article className="answer" ref={ref}>
        <AnswerHead synthetic={synthetic} name={answer.name} type="yes or no" />
        <p className="answer-value">
          <span className={cx("verdict", yes ? "verdict--yes" : "verdict--no")}>{yes ? "Yes" : "No"}</span>
          <span className="typed-tag">boolean</span>
        </p>
        <div className="bar-solo">
          <span className="bar-label">Probability of yes</span>
          <span className="bar-track" aria-hidden="true">
            <span
              className="bar-fill bar-fill--chosen"
              style={{ width: `${Math.round(Math.min(1, Math.max(0, answer.probability)) * 100)}%` }}
            />
            <span className="bar-threshold" style={{ left: "50%" }}>
              <span className="bar-threshold-label">0.5</span>
            </span>
          </span>
          <span className="bar-value mono">{formatConfidence(answer.probability)}</span>
        </div>
        <p className="answer-meta">Yes when the probability is at least 0.50.</p>
        {answer.confidence !== undefined ? <Confidence value={answer.confidence} method={answer.confidence_method} /> : null}
      </article>
    );
  }

  if (answer.type === "score") {
    const rows = levelRows(answer.probabilities);
    const scale = rubric(
      rows.map((row) => row.label),
      answer.score,
    );
    const level = topLevel(answer.probabilities);
    const top = rows[level]?.label ?? String(level);
    return (
      <article className="answer" ref={ref}>
        <AnswerHead synthetic={synthetic} name={answer.name} type="score" />
        <p className="answer-value">
          <span className="verdict verdict--level">{top}</span>
          <span className="typed-tag">level {level}</span>
          <span className="answer-score mono">score {answer.score.toFixed(2)}</span>
        </p>
        <div
          className="rubric"
          role="img"
          aria-label={`Score ${answer.score.toFixed(2)} on a scale from ${scale.ticks[0]?.label ?? "0"} to ${scale.ticks[scale.ticks.length - 1]?.label ?? ""}`}
        >
          <span className="rubric-line" />
          <span className="rubric-reach" style={{ transform: `scaleX(${scale.marker})` }} />
          {scale.ticks.map((tick, index) => (
            <span key={tick.label} className="rubric-tick" style={{ left: `${tick.at * 100}%` }}>
              <span
                className={cx(
                  "rubric-label mono",
                  index === 0 && "rubric-label--start",
                  index === scale.ticks.length - 1 && "rubric-label--end",
                )}
              >
                {tick.label}
              </span>
            </span>
          ))}
          <span className="rubric-marker" style={{ left: `${scale.marker * 100}%` }} aria-hidden="true" />
        </div>
        <BarList rows={rows} />
        <Confidence value={answer.confidence} method={answer.confidence_method} />
      </article>
    );
  }

  return (
    <article className="answer" ref={ref}>
      <AnswerHead synthetic={synthetic} name={answer.name} type="choice" />
      <p className="answer-value">
        <TypedValue value={answer.choice} />
      </p>
      <BarList rows={choiceRows(answer.probabilities, answer.choice)} />
      <Confidence value={answer.confidence} method={answer.confidence_method} />
    </article>
  );
}

function BarList({ rows }: { rows: readonly ProbabilityRow[] }) {
  return (
    <ul className="bars">
      {rows.map((row) => (
        <li key={row.label} className={cx("bar-row", row.chosen && "bar-row--chosen")}>
          <span className="bar-label mono">
            {row.chosen ? <Icon name="check" size={12} className="bar-check" /> : null}
            {row.label}
            {row.chosen ? <span className="sr-only"> (answer)</span> : null}
          </span>
          <span className="bar-track" aria-hidden="true">
            <span className={cx("bar-fill", row.chosen && "bar-fill--chosen")} style={{ width: `${Math.round(row.value * 100)}%` }} />
          </span>
          <span className="bar-value mono">{formatProbability(row.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function Confidence({ value, method }: { value: number; method?: string }) {
  return (
    <div className="confidence">
      <span className="confidence-label">Confidence</span>
      <span className="meter" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
      </span>
      <span className="confidence-value mono">{formatConfidence(value)}</span>
      <span className="confidence-method">{methodLabel(method)}</span>
    </div>
  );
}
