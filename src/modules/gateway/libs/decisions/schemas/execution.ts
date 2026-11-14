import type { Attempt, CostBasis, DecisionResponse, ErrorBody } from './types';
import type { Log } from '../../management/schemas/types';

export type FailureKind = 'network' | 'timeout' | 'http' | 'invalid' | 'limit';

export class CallFailure extends Error {
  constructor(
    public kind: FailureKind,
    message: string,
    public status?: number,
    public raw?: unknown,
  ) {
    super(message);
  }
}

export type CallResult = { body: unknown; request: unknown };
// An upstream answer, read: the answers and usage in this contract's shape, plus what the upstream said about
// itself: the cost it billed in USD, who served the request and the model it resolved. Each is null when the
// upstream did not report it.
export type Parsed = {
  synthetic?: boolean;
  estimatedTokens?: number;
  answers: DecisionResponse['answers'];
  usage: DecisionResponse['usage'];
  confidenceMethod: DecisionResponse['gateway']['confidence_method'];
  billed: number | null;
  servedBy: string | null;
  resolvedModel: string | null;
};
// What the answering attempt costs: the token count the cost is based on, the cost, and its basis.
export type Charge = {
  tokens: number;
  cost_usd: number | null;
  cost_basis: CostBasis;
  cost_includes_output: boolean;
};
export type Answered = { parsed: Parsed; charge: Charge };
export type Outcome = {
  provider: string;
  model: string;
  latency: number;
  request: unknown;
  response: unknown;
  secret: string | null;
  // The custom header the provider's key travelled in, or null for authorization. Its name is redacted too.
  header: string | null;
} & (
  | { ok: true; parsed: Parsed; charge: Charge }
  | { ok: false; kind: FailureKind; message: string; status?: number }
);
export type State = {
  route: string | null;
  attempts: Attempt[];
  secrets: string[];
  // Field names to redact beside the usual credential names: the custom auth headers of the providers tried.
  fields: string[];
  provider: string | null;
  model: string | null;
  upstreamRequest: unknown;
  upstreamResponse: unknown;
  answered: Answered | null;
  error: ErrorBody | null;
  status: number;
  stop: boolean;
};
export type Trace = { attempts: Attempt[]; upstream_request: unknown; upstream_response: unknown };
export type DecisionResult = {
  response: DecisionResponse | null;
  error?: ErrorBody;
  status: number;
  trace: Trace;
};
export type Finalized = { result: DecisionResult; log: Log };

export type KeyLookup = { ok: true; key: string | null } | { ok: false };
