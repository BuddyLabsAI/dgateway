// Wire types for the dgateway API, as published in the API reference, plus the additive
// cost and test-status fields of the API reference. This console keeps its own copy and
// never imports the backend's code. The cost-contract fields are optional here so the console still
// reads a gateway that predates them: a missing field is treated like null. The provider options
// (send_model, auth_header, model_hints, test_model), who served an answer (served_by,
// upstream_model_resolved) and what a provider test reports about the known-answer check are
// optional for the same reason. Answers and usage are OpenAI's Decisions shape, which the public API
// has matched since 2026-11-08.

// ---------- Public decision API ----------

export type DecisionType = "choice" | "predicate" | "score";
export type ChoiceValue = string | boolean | number;

export interface ChoiceOption {
  value: ChoiceValue;
  description: string;
}

export interface LevelOption {
  description: string;
  label?: string;
}

export interface Question {
  name: string;
  type: DecisionType;
  instructions: string;
  choices?: ChoiceOption[];
  levels?: LevelOption[];
}

export interface DecisionRequest {
  model?: string;
  input: string;
  questions: Question[];
}

export type ConfidenceMethod = "upstream" | "normalized-entropy" | "logprobs" | "sampling" | "json";
// "none" when no answer carries a confidence (native predicate-only, or every answer is a refusal).
export type GatewayConfidenceMethod = ConfidenceMethod | "mixed" | "none";

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  latency_ms: number;
  error?: string | null;
}

/** A choice option's probability, in option order, with the option's value and its type. */
export interface ChoiceProbability {
  value: ChoiceValue;
  probability: number;
}

/** A score level's probability, in level order: its zero-based index, and its label when it has one. */
export interface LevelProbability {
  value: number;
  label?: string;
  probability: number;
}

export interface ChoiceAnswer {
  type: "choice";
  name: string;
  /** The chosen option's value, with its type. */
  choice: ChoiceValue;
  probabilities: ChoiceProbability[];
  confidence: number;
  confidence_method: ConfidenceMethod;
}

export interface PredicateAnswer {
  type: "predicate";
  name: string;
  /** The probability of yes; the answer is yes at 0.5 or more. */
  probability: number;
  confidence?: number;
  confidence_method?: ConfidenceMethod;
}

export interface ScoreAnswer {
  type: "score";
  name: string;
  /** The expected zero-based level index. */
  score: number;
  probabilities: LevelProbability[];
  confidence: number;
  confidence_method: ConfidenceMethod;
}

export interface RefusalAnswer {
  type: DecisionType;
  name: string;
  refusal: string;
}

export type Answer = ChoiceAnswer | PredicateAnswer | ScoreAnswer | RefusalAnswer;

/** Token counts as OpenAI reports them, with its details when the upstream gives them. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: Record<string, number>;
  output_tokens_details?: Record<string, number>;
}

/**
 * How a cost was worked out (API reference): billed by the provider (upstream_cost), priced from
 * the upstream's tokens or an estimate, or unpriced.
 */
export type CostBasis = "upstream_cost" | "upstream_tokens" | "estimated_tokens" | "unpriced";

export interface GatewayInfo {
  synthetic?: boolean;
  route: string | null;
  provider: string;
  upstream_model: string;
  /** Who the upstream says served the answer (OpenRouter names the vendor); null when it did not say. */
  served_by?: string | null;
  /** The model id the upstream resolved the requested one to; null when it did not say. */
  upstream_model_resolved?: string | null;
  latency_ms: number;
  attempts: Attempt[];
  confidence_method: GatewayConfidenceMethod;
  /** USD; null when unpriced or on failure. */
  cost_usd?: number | null;
  cost_basis?: CostBasis;
  cost_includes_output?: boolean;
  /** The token count the cost was computed from, reported by the upstream or estimated. */
  tokens?: number | null;
}

export interface DecisionResponse {
  id: string;
  object: "decision";
  created: number;
  model: string;
  answers: Answer[];
  usage: Usage | null;
  gateway: GatewayInfo;
}

/** A route as a conflict names it: its id and its alias. */
export interface RouteRef {
  id: string;
  alias: string;
}

// ---------- Admin API ----------

export type ProviderKind = "openai" | "openrouter" | "systemone" | "openai-compatible" | "mock";
export type WireShape = "openai" | "map" | "chat";
export type SyntheticMethod = "logprobs" | "sampling" | "json";
export type JsonTransport = "auto" | "json_schema" | "prompt";

/**
 * A key as the gateway reads it back. A stored key shows its last four characters only when it has at least 12; a
 * shorter one shows none, so last4 is null.
 */
export type KeyRead = { source: "env"; env_var: string; present: boolean } | { source: "stored"; last4: string | null } | { source: "none" };

export type KeyWrite = { source: "env"; env_var: string } | { source: "stored"; value: string } | { source: "none" };

export interface ProviderLimits {
  max_questions: number;
  max_choices: number;
}

/**
 * A model the owner expects a provider to serve, with its list prices in USD per million input and output
 * tokens. The models endpoint lists hints first, and a hint's prices are the defaults for that model on a
 * hosted SystemOne or OpenAI-compatible provider.
 */
export interface ModelHint {
  id: string;
  price_per_m_input?: number;
  price_per_m_output?: number;
  context?: number;
  description?: string;
}

/**
 * Why a provider test used its model: the one asked for, a model's step on the provider, the provider's test
 * model, its first hint, the cheapest priced model it lists, the first it lists, or the server-configured placeholder.
 */
export type TestModelReason = "requested" | "used_by_route" | "provider_default" | "hint" | "cheapest" | "first_listed" | "server_configured";

/** The last provider test the gateway recorded for a provider. */
export interface ProviderLastTest {
  ok: boolean;
  at: string;
  latency_ms: number;
  model: string;
  error: string | null;
  /** Why that model was tested. Absent or null on a test recorded before the gateway said. */
  model_reason?: TestModelReason | null;
  /** Whether it gave the known answer. Absent or null on a test recorded before the gateway said. */
  matched?: boolean | null;
}

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  path: string;
  wire: WireShape;
  synthetic_methods?: SyntheticMethod[];
  sampling_n?: number;
  json_transport?: JsonTransport;
  /** Chat wire: turn reasoning off on every call. Absent means the kind's default (on for openrouter). */
  disable_reasoning?: boolean;
  enabled: boolean;
  timeout_ms: number;
  limits: ProviderLimits;
  extra_body: Record<string, unknown>;
  key: KeyRead;
  /** Map wire: whether the upstream body names the model. The openai wire always does. */
  send_model?: boolean;
  /** The header that carries the key, in lowercase: "authorization" sends "Bearer <key>", any other the raw key. */
  auth_header?: string;
  model_hints?: ModelHint[];
  /** The model a test uses when none of your models sends this provider one, such as its preset's. Null for none. */
  test_model?: string | null;
  /** Null until the provider has been tested. */
  last_test?: ProviderLastTest | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderWrite {
  name: string;
  kind: ProviderKind;
  base_url: string;
  path: string;
  wire: WireShape;
  synthetic_methods?: SyntheticMethod[];
  sampling_n?: number;
  json_transport?: JsonTransport;
  disable_reasoning?: boolean;
  enabled: boolean;
  timeout_ms: number;
  limits: ProviderLimits;
  extra_body: Record<string, unknown>;
  key: KeyWrite;
  send_model?: boolean;
  auth_header?: string;
  model_hints?: ModelHint[];
  /** Null clears it. */
  test_model?: string | null;
}

export type ProviderPatch = Partial<ProviderWrite>;

/** The trace of one decision: its attempts, and the last attempt's wire bodies (secrets redacted). */
export interface DecisionTrace {
  attempts: Attempt[];
  upstream_request: unknown;
  upstream_response: unknown;
}

/**
 * A provider test: the known-answer check sent to one of the provider's models. The fields after `model` are
 * optional so a gateway that predates them still reads.
 */
export interface ProviderTestResult {
  ok: boolean;
  latency_ms: number;
  model: string;
  model_reason?: TestModelReason;
  /** The model (route) whose step was tested, when that is the reason. */
  model_route?: string | null;
  /** The answer the check expects: "billing". */
  expected?: string;
  /** What the model answered, and its probability; null when it did not answer the question. */
  answer?: ChoiceValue | null;
  probability?: number | null;
  /** Whether the answer is the expected one. */
  matched?: boolean;
  error?: string;
  response?: DecisionResponse;
  trace?: DecisionTrace;
}

export interface ProviderModel {
  id: string;
  description?: string;
  /** The catalog's input price, USD per million input tokens. */
  price_per_m_input?: number;
  /** The price the gateway charges when a step sets none, where it has a default (API reference). */
  default_price_per_m_input?: number;
  /** The catalog's (or hint's) output price, USD per million output tokens. */
  price_per_m_output?: number;
  /** The output price the gateway charges when a step sets none, where it has a default. */
  default_price_per_m_output?: number;
  context?: number;
}

export interface RouteTarget {
  provider_id: string;
  model: string;
  timeout_ms?: number;
  /** USD per million input tokens. Null or absent uses the default price for the provider kind. */
  price_per_m_input?: number | null;
  /** USD per million output tokens, resolved on its own. Null or absent uses the provider's default output price. */
  price_per_m_output?: number | null;
}

export interface Route {
  id: string;
  alias: string;
  description: string;
  enabled: boolean;
  targets: RouteTarget[];
  created_at: string;
  updated_at: string;
}

export interface RouteWrite {
  alias: string;
  description: string;
  enabled: boolean;
  targets: RouteTarget[];
}

export interface LogEntry {
  id: string;
  ts: string;
  route: string | null;
  provider: string;
  upstream_model: string;
  /** As in GatewayInfo: who served the answer, and the model it resolved. Null on error. */
  served_by?: string | null;
  upstream_model_resolved?: string | null;
  status: "ok" | "error";
  fallback_used: boolean;
  http_status: number;
  latency_ms: number;
  questions: number;
  prompt_tokens: number | null;
  error: string | null;
  attempts: Attempt[];
  cost_usd?: number | null;
  /** Null on error. */
  cost_basis?: CostBasis | null;
  cost_includes_output?: boolean | null;
  tokens?: number | null;
  request?: unknown;
  response?: unknown;
}

export interface LogPage {
  items: LogEntry[];
  next_before: string | null;
}

export interface LogQuery {
  limit?: number;
  before?: string;
  route?: string;
  provider?: string;
  status?: "ok" | "error";
  /** "used" keeps requests that tried a later target; "none" keeps those that answered first. */
  fallback?: "used" | "none";
}

export type StatsWindow = "1h" | "24h" | "7d";

export interface ProviderStats {
  provider: string;
  requests: number;
  errors: number;
  p50_ms: number | null;
  cost_usd?: number;
  /** Answered requests through this provider that could not be priced. */
  unpriced?: number;
  output_unpriced?: number;
}

export interface RouteStats {
  route: string;
  requests: number;
  errors: number;
  p50_ms: number | null;
  cost_usd?: number;
  /** Answered requests through this model that could not be priced. */
  unpriced?: number;
  output_unpriced?: number;
}

export interface StatsBucket {
  t: string;
  requests: number;
  errors: number;
  p50_ms: number | null;
  /** The bucket's own 95th percentile; null when the bucket has no requests. */
  p95_ms: number | null;
  /** Requests in the bucket that moved on to a later target, including those that then failed. */
  fallbacks: number;
  /** Requests in the bucket that moved on to a later target and were then answered. */
  fallbacks_answered: number;
  /** USD spent on priced requests in the bucket; 0 when there were none. */
  cost_usd?: number;
}

export interface Stats {
  window: StatsWindow;
  requests: number;
  errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
  fallbacks: number;
  fallbacks_answered: number;
  /** USD spent on priced requests in the window; 0 when there were none. */
  cost_usd?: number;
  /** Answered requests in the window that could not be priced. */
  unpriced?: number;
  output_unpriced?: number;
  by_provider: ProviderStats[];
  by_route: RouteStats[];
  timeseries: StatsBucket[];
}

export interface HealthProvider {
  name: string;
  enabled: boolean;
  key_present: boolean;
}

export interface Health {
  ok: boolean;
  version: string;
  uptime_s: number;
  /** Whether the gateway has GATEWAY_SECRET, which stored keys need. Absent on a gateway that predates it. */
  secret_configured?: boolean;
  providers: HealthProvider[];
}

export interface ClientKey {
  id: string;
  name: string;
  key_last4: string;
  created_at: string;
  last_used_at: string | null;
}

export interface CreatedClientKey {
  id: string;
  name: string;
  key: string;
  key_last4: string;
  created_at: string;
}

export interface Settings {
  require_client_keys: boolean;
  capture_payloads: boolean;
  default_route: string;
}

export interface PlaygroundRun {
  response: DecisionResponse | null;
  error?: { message: string; type: string };
  trace: DecisionTrace;
}
