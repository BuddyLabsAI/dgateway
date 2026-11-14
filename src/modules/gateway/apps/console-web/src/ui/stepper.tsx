// A step indicator for a guided flow, drawn as a short line of stations: finished steps are filled,
// the current one is ringed in cobalt, later ones are hollow. Finished steps can be reopened. The line
// spreads its steps evenly, however many there are (Add model has six, Add provider four).

import type { CSSProperties } from "react";
import { cx } from "./cx";
import { Icon } from "./icons";

export interface StepperStep {
  id: string;
  label: string;
}

export function Stepper({
  steps,
  current,
  reachable,
  onOpen,
  label,
}: {
  steps: readonly StepperStep[];
  current: number;
  /** The furthest step that can be opened. */
  reachable: number;
  onOpen: (index: number) => void;
  label: string;
}) {
  return (
    <nav aria-label={label} className="stepper">
      <ol style={{ "--steps": steps.length } as CSSProperties}>
        {steps.map((step, index) => {
          const state = index < current ? "done" : index === current ? "current" : "todo";
          const openable = index !== current && index <= reachable;
          return (
            <li key={step.id} className={cx("stepper-step", `stepper-step--${state}`)}>
              <button
                type="button"
                className="stepper-button"
                aria-current={state === "current" ? "step" : undefined}
                disabled={!openable && state !== "current"}
                onClick={() => (openable ? onOpen(index) : undefined)}
              >
                <span className="stepper-mark" aria-hidden="true">
                  {state === "done" ? <Icon name="check" size={12} /> : <span className="stepper-n mono">{index + 1}</span>}
                </span>
                <span className="stepper-label">
                  {step.label}
                  {state === "done" ? <span className="sr-only"> (done)</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
