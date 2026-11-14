import type { Attempt, CostBasis } from '../../decisions/schemas/types';
export type ProviderKind = 'openai' | 'openrouter' | 'systemone' | 'openai-compatible' | 'mock';
// A stored key's last4 is what reads show of it: its last four characters, or null for a key too short to show any
// (keyTail in functions/admin.ts has the rule).
export type ProviderKey =
  | { source: 'none' }
  | { source: 'env'; env_var: string }
  | { source: 'stored'; ciphertext: string; last4: string | null };
// Why a provider test used the model it did, in the order the gateway looks: the model the caller asked for, the
// model one of the routes sends this provider, the provider's own test model, its first model hint, the cheapest
// priced model it lists, the first model it lists, and last the server-configured placeholder.
export type ModelReason =
  | 'requested'
  | 'used_by_route'
  | 'provider_default'
  | 'hint'
  | 'cheapest'
  | 'first_listed'
  | 'server_configured';
// The result of the last provider test, success or failure. Absent or null until the first test. model_reason is
// why that model was tested, and matched whether it gave the known answer; both read as null on a test recorded
// before they existed.
export type LastTest = {
  ok: boolean;
  at: string;
  latency_ms: number;
  model: string;
  error: string | null;
  model_reason: ModelReason | null;
  matched: boolean | null;
};
// A last test as it may be stored: one recorded before model_reason and matched existed lacks them.
type AddedLastTestField = 'model_reason' | 'matched';
export type StoredLastTest = Omit<LastTest, AddedLastTestField> &
  Partial<Pick<LastTest, AddedLastTestField>>;
// A model the owner expects a provider to serve, with its list prices in USD per million input and output tokens.
// Hints fill in the models endpoint where the upstream lists nothing, and price that model when a route target sets no
// price.
export type ModelHint = {
  id: string;
  price_per_m_input?: number;
  price_per_m_output?: number;
  context?: number;
  description?: string;
};
export type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  path: string;
  wire: 'openai' | 'map' | 'chat';
  synthetic_methods?: ('logprobs' | 'sampling' | 'json')[];
  sampling_n?: number;
  json_transport?: 'auto' | 'json_schema' | 'prompt';
  // Chat wire: send the kind's way of turning reasoning off on every call. Absent means the kind's default (true for
  // openrouter); read it through disablesReasoning.
  disable_reasoning?: boolean;
  enabled: boolean;
  timeout_ms: number;
  limits: { max_questions: number; max_choices: number };
  extra_body: Record<string, unknown>;
  key: ProviderKey;
  // Whether a map-wire body names the upstream model. The openai wire always does. Absent only on a row written
  // before migration 3; read it through sendsModel.
  send_model?: boolean;
  // The header that carries the key, in lowercase: "authorization" sends "Bearer <key>", any other name sends the
  // key as it is. Absent only on a row written before migration 3, which means "authorization".
  auth_header?: string;
  model_hints?: ModelHint[];
  // The model a test uses when no route sends this provider one, such as the one its preset recommends. Absent or
  // null for none.
  test_model?: string | null;
  last_test?: StoredLastTest | null;
  created_at: string;
  updated_at: string;
};
export type Settings = {
  require_client_keys: boolean;
  capture_payloads: boolean;
  default_route: string | null;
};
export type Log = {
  id: string;
  ts: string;
  route: string | null;
  provider: string | null;
  upstream_model: string | null;
  // Who the upstream says served the answer, and the model it resolved; null when it did not say or the request
  // failed.
  served_by: string | null;
  upstream_model_resolved: string | null;
  status: 'ok' | 'error';
  fallback_used: boolean;
  http_status: number;
  latency_ms: number;
  questions: number;
  prompt_tokens: number | null;
  // Cost of the answering attempt. All three are null when the request failed.
  cost_usd: number | null;
  cost_basis: CostBasis | null;
  cost_includes_output?: boolean | null;
  tokens: number | null;
  error: string | null;
  attempts: Attempt[];
  request?: unknown;
  response?: unknown;
};
export type PublicKey =
  | { source: 'none' }
  | { source: 'env'; env_var: string; present: boolean }
  | { source: 'stored'; last4: string | null };
