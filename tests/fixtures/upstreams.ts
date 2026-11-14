// Representative upstream protocol captures used by the wire tests.
// openrouter-real.json covers a choice and predicate, a rejected score criteria map, and a documented example.
// openai-live.json contains a request and response with three question types.
// chat-real.json covers chat models and synthetic methods; tests/unit/chat-real.test.ts reads it.
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));

// A SystemOne answer body: answers keyed by question id, usage with input and output tokens and a cost, and who
// served it.
export type SystemOneResponse = {
  model: string;
  provider: string;
  id: string;
  answers: Record<string, Json>;
  usage: Json;
};

export type OpenRouterCapture = {
  captured_2026_11_08_live: {
    request_choice_predicate: Json & { questions: Record<string, Json> };
    response_choice_predicate: SystemOneResponse;
    score_with_keyed_criteria_rejected: {
      status: number;
      error: { message: string; code: number };
    };
  };
  documented_example_openrouter_docs: {
    request_score: Record<string, Json>;
    response: SystemOneResponse;
  };
};

export const openrouter = read('openrouter-real.json') as OpenRouterCapture;

export type OpenAICapture = {
  trace: {
    upstream_request: Json & { model: string; input: string; questions: Json[] };
    upstream_response: { model: string; answers: Json[]; usage: Json };
  };
};

export const openai = read('openai-live.json') as OpenAICapture;

// The documented example answers questions named is_bug, team and urgency, with team's options named account,
// frontend and payments. This gateway names questions q0, q1, ... and options o0, o1, ... in request order, so the
// example is renamed to match a request that asks team (account, frontend, payments), then is_bug, then urgency.
export function documentedInGatewayIds(): SystemOneResponse {
  const { response } = openrouter.documented_example_openrouter_docs;
  const team = response.answers.team as {
    choice: string;
    probabilities: Record<string, number>;
  };
  const options: Record<string, string> = { account: 'o0', frontend: 'o1', payments: 'o2' };
  return {
    ...response,
    answers: {
      q0: {
        ...team,
        choice: options[team.choice],
        probabilities: Object.fromEntries(
          Object.entries(team.probabilities).map(([name, p]) => [options[name], p]),
        ),
      },
      q1: response.answers.is_bug,
      q2: response.answers.urgency,
    },
  };
}
