'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import { drawHeroWires } from './hero-flow-geometry';

const ANSWERS = [
  { key: 'team', value: 'billing', amount: 0.4, meaning: 'probability' },
  { key: 'refund', value: 'yes', amount: 0.89, meaning: 'probability' },
  { key: 'urgency', value: 'score', amount: 0.87, meaning: 'score' },
] as const;

function Status({ step, ok }: { step: 1 | 2; ok: boolean }) {
  return (
    <span className="hf-status" data-result={ok ? 'ok' : 'fail'}>
      <svg className="hf-timer" viewBox="0 0 20 20" aria-hidden="true">
        <circle className="hf-timer-track" cx="10" cy="10" r="8" />
        <circle className="hf-timer-fill" data-hf={`timer-${step}`} cx="10" cy="10" r="8" />
        <circle className="hf-timer-end" data-hf={`timer-end-${step}`} cx="10" cy="10" r="8" />
        <path
          className="hf-timer-icon"
          data-hf={`icon-${step}`}
          d={ok ? 'm6.4 10.2 2.4 2.4 4.8-5' : 'm7 7 6 6m0-6-6 6'}
        />
      </svg>
      <span className="hf-status-text">
        <span className="hf-status-wait" data-hf={`wait-${step}`} aria-hidden="true">
          waiting
        </span>
        <span className="hf-status-label" data-hf={`label-${step}`}>
          {ok ? 'answered' : 'timeout'}
        </span>
      </span>
    </span>
  );
}

export function HeroFlow() {
  const figure = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = figure.current;
    const stage = root?.querySelector<HTMLElement>('[data-hf-stage]');
    if (!root || !stage) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    let width = 0;
    const redraw = () => {
      width = drawHeroWires(stage).width;
    };
    const resize = new ResizeObserver(() => {
      if (stop || Math.abs(stage.getBoundingClientRect().width - width) < 1) return;
      redraw();
    });
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const begin = () => {
      if (disposed || stop || preference.matches) return;
      import('./hero-flow-motion')
        .then(({ startHeroFlow }) => {
          if (!disposed && !stop && !preference.matches) stop = startHeroFlow(root, stage);
        })
        .catch(() => undefined);
    };
    const onPreference = () => {
      if (!preference.matches) return begin();
      stop?.();
      stop = undefined;
      redraw();
    };
    document.fonts.ready.then(() => {
      if (disposed) return;
      redraw();
      resize.observe(stage);
      begin();
    });
    preference.addEventListener('change', onPreference);
    return () => {
      disposed = true;
      resize.disconnect();
      preference.removeEventListener('change', onPreference);
      stop?.();
    };
  }, []);

  return (
    <figure
      ref={figure}
      className="hero-flow"
      aria-labelledby="hero-flow-caption"
      aria-describedby="hero-flow-summary"
    >
      <figcaption id="hero-flow-caption">
        <span className="hf-station" aria-hidden="true" />
        One request, from your app to an answer
      </figcaption>
      <div className="hf-stage" data-hf-stage>
        <svg className="hf-wires" aria-hidden="true" focusable="false">
          <g className="hf-base">
            <path data-hf="base-out" />
            <path data-hf="base-first" />
            <path data-hf="base-next" />
            <path data-hf="base-spare" />
            <path data-hf="base-answer" />
          </g>
          <g className="hf-lit">
            <path className="hf-lit-trip" data-hf="lit-trip" />
            <path className="hf-lit-out" data-hf="lit-out" />
            <path className="hf-lit-fail" data-hf="lit-fail" />
            <path className="hf-lit-next" data-hf="lit-next" />
            <path className="hf-lit-answer" data-hf="lit-answer" />
          </g>
          <g className="hf-motion">
            <path data-hf="motion-trip" />
            <path data-hf="motion-next" />
            <path data-hf="motion-answer" />
          </g>
          <circle className="hf-pulse" data-hf="pulse-out" data-hf-node="out" r="6" />
          <circle className="hf-pulse" data-hf="pulse-junction" data-hf-node="junction" r="6" />
          <circle className="hf-pulse" data-hf="pulse-entry" data-hf-node="entry" r="6" />
          <circle className="hf-node" data-hf-node="out" r="4.5" />
          <circle className="hf-node hf-node-switch" data-hf-node="junction" r="5.5" />
          <circle className="hf-node" data-hf-node="entry" r="4.5" />
          <circle className="hf-spark" data-hf="spark" r="3.2" />
          <circle className="hf-spark" data-hf="spark" r="2.5" />
          <circle className="hf-spark" data-hf="spark" r="1.8" />
          <g className="hf-packet" data-hf="packet">
            <circle className="hf-packet-halo" r="13" />
            <circle className="hf-packet-ring" r="7" />
            <circle className="hf-packet-core" r="4" />
          </g>
        </svg>

        <div className="hf-card hf-request" data-hf-box="request">
          <span className="hf-glow" data-hf="glow-request" aria-hidden="true" />
          <p className="hf-card-head">
            <span className="hf-station" aria-hidden="true" />
            Your app
          </p>
          <p className="hf-method">
            <code>POST /v1/decisions</code>
          </p>
          <dl className="hf-fields">
            <div>
              <dt>model</dt>
              <dd>
                <code>support</code>
              </dd>
            </div>
            <div>
              <dt>input</dt>
              <dd className="hf-input">
                I got charged twice for my March invoice. Please refund the extra charge.
              </dd>
            </div>
            <div>
              <dt>questions</dt>
              <dd>
                <code>team</code>, <code>refund</code>, <code>urgency</code>
              </dd>
            </div>
          </dl>
        </div>

        <div className="hf-route">
          <p className="hf-route-head">
            Route <code>support</code>
          </p>
          <ol className="hf-steps" aria-label="Steps, tried in order">
            <li className="hf-step" data-hf-box="step-1" data-hf="step-1">
              <span className="hf-glow" data-hf="glow-1" aria-hidden="true" />
              <span className="hf-glow hf-glow-fail" data-hf="fail-1" aria-hidden="true" />
              <span className="hf-step-index" aria-hidden="true">
                1
              </span>
              <span className="hf-step-name">
                <strong>OpenAI</strong>
                <code>gpt-6-luna</code>
              </span>
              <Status step={1} ok={false} />
            </li>
            <li className="hf-step" data-hf-box="step-2">
              <span className="hf-glow hf-glow-ok" data-hf="glow-2" aria-hidden="true" />
              <span className="hf-step-index" aria-hidden="true">
                2
              </span>
              <span className="hf-step-name">
                <strong>TypeSafe</strong>
                <code>jev-1.14</code>
              </span>
              <Status step={2} ok />
            </li>
          </ol>
        </div>

        <div className="hf-card hf-answer" data-hf-box="answer">
          <span className="hf-glow" data-hf="glow-answer" aria-hidden="true" />
          <p className="hf-card-head">
            <span className="hf-station" aria-hidden="true" />
            Answer
            <code className="hf-http" data-hf="http">
              200
            </code>
          </p>
          <ul className="hf-answers">
            {ANSWERS.map(({ key, value, amount, meaning }) => (
              <li key={key} data-kind={meaning}>
                <code className="hf-key">{key}</code>
                <span className="hf-value" data-hf="value">
                  {value}
                </span>
                <span className="hf-bar" aria-hidden="true">
                  {meaning === 'score' ? (
                    <>
                      <i className="hf-ticks" />
                      <i
                        className="hf-marker"
                        data-hf="fill"
                        data-to={amount / 2}
                        style={{ '--to': amount / 2 } as CSSProperties}
                      >
                        <b />
                      </i>
                    </>
                  ) : (
                    <i
                      className="hf-fill"
                      data-hf="fill"
                      data-to={amount}
                      style={{ '--to': amount } as CSSProperties}
                    />
                  )}
                </span>
                <span className="hf-num" data-hf="num" data-to={amount}>
                  <span className="sr-only">{meaning} </span>
                  <span data-hf="digits">{amount.toFixed(2)}</span>
                  {meaning === 'score' && <span className="sr-only"> on a scale from 0 to 2</span>}
                </span>
              </li>
            ))}
          </ul>
          <dl className="hf-meta">
            <div data-hf="meta">
              <dt>Answered by</dt>
              <dd>
                <code>typesafe</code> <span aria-hidden="true">/</span> <code>jev-1.14</code>
              </dd>
            </div>
            <div data-hf="meta">
              <dt>Cost</dt>
              <dd>$0.0000032</dd>
            </div>
            <div data-hf="meta">
              <dt>Attempts</dt>
              <dd>
                <span
                  className="hf-attempt"
                  data-result="fail"
                  data-hf="attempt"
                  aria-hidden="true"
                />
                <span
                  className="hf-attempt"
                  data-result="ok"
                  data-hf="attempt"
                  aria-hidden="true"
                />
                2
              </dd>
            </div>
          </dl>
        </div>

        <span className="hf-tag" data-hf="tag" aria-hidden="true">
          <svg viewBox="0 0 12 12">
            <path d="M6 2v8m-3-3 3 3 3-3" />
          </svg>
          next step
        </span>
      </div>
      <p id="hero-flow-summary" className="sr-only">
        Illustration: your app sends POST /v1/decisions with the route name support. The first step,
        OpenAI gpt-6-luna, times out, so dgateway tries the next step, TypeSafe jev-1.14, which
        answers. The response gives each answer, the provider and model that answered, the cost in
        US dollars and both attempts.
      </p>
    </figure>
  );
}
