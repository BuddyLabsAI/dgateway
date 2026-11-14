// price_per_m_input is USD per million input tokens; absent or null means the default price applies.
export type Target = {
  provider_id: string;
  model: string;
  timeout_ms?: number;
  price_per_m_input?: number | null;
  price_per_m_output?: number | null;
};
export type Route = {
  id: string;
  alias: string;
  description: string;
  enabled: boolean;
  targets: Target[];
  created_at: string;
  updated_at: string;
};
