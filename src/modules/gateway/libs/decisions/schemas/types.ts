export type ChoiceValue = string | boolean | number;
export type Question = {
  name: string;
  type: 'choice' | 'predicate' | 'score';
  instructions: string;
  choices?: { value: ChoiceValue; description: string }[];
  levels?: { description: string; label?: string }[];
};
export type DecisionRequest = { model?: string; input: string; questions: Question[] };
// One question on the SystemOne map wire. A choice's criteria are its option descriptions keyed by option id (o0,
// o1, ...); a score's are its level descriptions as an ordered list, so index i is level i; a noul (predicate) has
// none.
export type MapWireQuestion = {
  type: 'choice' | 'noul' | 'score';
  instructions: string;
  criteria?: Record<string, string> | string[];
};
// A request body on the map wire: the input as state, and the questions keyed by question id (q0, q1, ...).
export type MapWireRequest = { state: string; questions: Record<string, MapWireQuestion> };
export type Attempt = {
  provider: string;
  model: string;
  ok: boolean;
  latency_ms: number;
  error?: string;
};
// One option's probability in an answer, as OpenAI's Decisions API lists them, in option order: a choice's value with
// its type kept, or a score level's zero-based index with the level's label when it has one.
export type ProbabilityEntry = { value: ChoiceValue; label?: string; probability: number };
// An answer in OpenAI's Decisions shape. A choice has choice (the chosen value), probabilities and confidence; a
// predicate has probability; a score has score (the expected zero-based level index), probabilities and confidence;
// a refused question has refusal. confidence_method is this gateway's addition to a choice or a score.
export type Answer = {
  type: Question['type'];
  name: string;
  choice?: ChoiceValue;
  probability?: number;
  score?: number;
  probabilities?: ProbabilityEntry[];
  confidence?: number;
  confidence_method?: 'upstream' | 'normalized-entropy' | 'logprobs' | 'sampling' | 'json';
  refusal?: string;
};
// Token counts as OpenAI's Decisions API reports them, with its details when the upstream gives them.
export type TokenDetails = Record<string, number>;
export type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: TokenDetails;
  output_tokens_details?: TokenDetails;
} | null;
// How the cost was set. "upstream_cost" is the amount the upstream billed, as it reported it. Otherwise the
// gateway priced the tokens: from the upstream's count or estimated; "unpriced" means no price was known.
export type CostBasis = 'upstream_cost' | 'upstream_tokens' | 'estimated_tokens' | 'unpriced';
export type DecisionResponse = {
  id: string;
  object: 'decision';
  created: number;
  model: string;
  answers: Answer[];
  usage: Usage;
  gateway: {
    route: string | null;
    provider: string;
    upstream_model: string;
    // Who the upstream says served the request (its top-level provider), and the model id it resolved the
    // requested one to (its top-level model). Null when the upstream does not say.
    served_by: string | null;
    upstream_model_resolved: string | null;
    synthetic: boolean;
    latency_ms: number;
    attempts: Attempt[];
    // "none" when no answer carries a confidence (native predicate-only, or every answer is a refusal).
    confidence_method:
      'upstream' | 'normalized-entropy' | 'logprobs' | 'sampling' | 'json' | 'mixed' | 'none';
    // The answering attempt's cost. cost_usd is null when unpriced; tokens is the count it was based on.
    cost_usd: number | null;
    cost_basis: CostBasis;
    cost_includes_output: boolean;
    tokens: number | null;
  };
};
export type GatewayErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'not_found_error'
  | 'upstream_error'
  | 'timeout_error'
  | 'server_error';
export type RouteRef = { id: string; alias: string };
export type ErrorBody = {
  message: string;
  type: GatewayErrorType;
  code?: string;
  // Set on a provider_in_use conflict: the routes that still target the provider.
  routes?: RouteRef[];
};

export class GatewayError extends Error {
  constructor(
    public status: number,
    public type: GatewayErrorType,
    message: string,
    public code?: string,
    public routes?: RouteRef[],
  ) {
    super(message);
  }

  body(): ErrorBody {
    return {
      message: this.message,
      type: this.type,
      ...(this.code ? { code: this.code } : {}),
      ...(this.routes ? { routes: this.routes } : {}),
    };
  }
}
