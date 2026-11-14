// A model's chain as a sentence with a station mark on each step, so the order and each
// connection's state read together: "● OpenAI gpt-6-luna → then ⊗ OpenRouter openai/…".

import type { Provider } from "../api/types";
import type { ChainStep } from "../domain/chain";
import { configVerdict, type StationStatus } from "../domain/health";
import { StationMark } from "./status";

function stepStatus(step: ChainStep, providers: readonly Provider[]): StationStatus {
  const provider = providers.find((candidate) => candidate.id === step.providerId);
  return provider ? configVerdict(provider).status : "failing";
}

export function ChainText({ steps, providers }: { steps: readonly ChainStep[]; providers: readonly Provider[] }) {
  if (steps.length === 0) return <span className="chain-text chain-text--empty">No steps yet. Apps that send this model get an error.</span>;
  return (
    <span className="chain-text">
      {steps.map((step, index) => (
        <span key={`${step.position}-${step.providerId}`} className="chain-step">
          {index > 0 ? <span className="chain-then"> → then </span> : null}
          <StationMark status={stepStatus(step, providers)} size={10} />
          <span className="chain-who">{step.title}</span> <span className="chain-model mono">{step.model}</span>
        </span>
      ))}
    </span>
  );
}
