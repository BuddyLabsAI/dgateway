export type ChoiceValue = string | boolean | number;
export type Question = {
  name: string;
  type: 'choice' | 'score' | 'predicate';
  instructions: string;
  choices?: { value: ChoiceValue; description: string }[];
  levels?: { description: string; label?: string }[];
};
export type DecisionRequest = { model?: string; input: string; questions: Question[] };
// One option's probability, in option order: a choice's value with its type kept, or a score level's zero-based
// index with the level's label when it has one.
export type ProbabilityEntry = { value: ChoiceValue; label?: string; probability: number };
// An answer in OpenAI's Decisions shape. A choice has choice, probabilities and confidence; a predicate has
// probability; a score has score (the expected zero-based level index), probabilities and confidence; a refused
// question has refusal. confidence_method is the gateway's addition to a choice or a score.
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
export type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: Record<string, number>;
  output_tokens_details?: Record<string, number>;
};
export type DecisionResponse = {
  id: string;
  object: 'decision';
  created: number;
  model: string;
  answers: Answer[];
  usage: Usage | null;
  gateway: {
    route: string | null;
    provider: string;
    upstream_model: string;
    // Who the upstream says served the request, and the model id it resolved; null when it does not say.
    served_by: string | null;
    upstream_model_resolved: string | null;
    synthetic: boolean;
    latency_ms: number;
    attempts: {
      provider: string;
      model: string;
      ok: boolean;
      latency_ms: number;
      error?: string;
    }[];
    // "none" when no answer carries a confidence (native predicate-only, or every answer refused).
    confidence_method:
      'upstream' | 'normalized-entropy' | 'logprobs' | 'sampling' | 'json' | 'mixed' | 'none';
    // The answering attempt's cost in USD: null when it is unpriced. cost_basis says how it was set: billed by the
    // upstream, or priced by the gateway from the upstream's tokens or an estimate.
    cost_usd: number | null;
    cost_basis: 'upstream_cost' | 'upstream_tokens' | 'estimated_tokens' | 'unpriced';
    // Whether cost_usd covers output tokens: false when the upstream reported output tokens the gateway has no price
    // for, or no output count at all, so the cost covers input only. Absent from gateways older than output pricing.
    cost_includes_output?: boolean;
    // The token count the cost is based on, from the upstream's usage or estimated from the text sent.
    tokens: number | null;
  };
};

export const authorizationHeaders = (apiKey?: string): Record<string, string> =>
  apiKey ? { authorization: `Bearer ${apiKey}` } : {};

// Gateway error bodies have the shape { error: { message } }.
const errorMessage = (body: unknown) => (body as { error?: { message?: string } }).error?.message;

export class DecisionClient {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private http: typeof fetch = fetch,
  ) {}

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const headers = { 'content-type': 'application/json', ...authorizationHeaders(this.apiKey) };
    const r = await this.http(`${this.baseUrl.replace(/\/$/, '')}/v1/decisions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    const body: unknown = await r.json();
    if (!r.ok) throw new Error(errorMessage(body) ?? `HTTP ${r.status}`);
    return body as DecisionResponse;
  }

  async models() {
    const r = await this.http(`${this.baseUrl.replace(/\/$/, '')}/v1/models`, {
      headers: authorizationHeaders(this.apiKey),
    });
    const body: unknown = await r.json();
    if (!r.ok) throw new Error(errorMessage(body) ?? `HTTP ${r.status}`);
    return body as {
      object: 'list';
      data: { id: string; object: 'model'; owned_by: string; description: string }[];
    };
  }
}
