import type { DecisionRequest } from '../schemas/types';
import {
  CallFailure,
  type CallResult,
  type Charge,
  type DecisionResult,
  type Outcome,
  type Parsed,
  type State,
  type KeyLookup,
} from '../schemas/execution';
import type { Provider, Settings, Log } from '../../management/schemas/types';
import type { Route, Target } from '../../routing/schemas/types';
import {
  eligibility,
  upstreamBody,
  hiddenValues,
  responseWire,
  parseResult,
  initialState,
  reduceAttempt,
  finalize,
  failedOutcome,
  succeededOutcome,
} from '../functions/execution';
import { chargeFor, defaultPriceInput } from '../functions/pricing';
import { customAuthHeader } from '../functions/wire';
export type { DecisionResult, Trace } from '../schemas/execution';
export type DecideDeps = {
  providers: () => Provider[];
  routes: () => Route[];
  settings: () => Settings;
  key: (p: Provider) => string | null;
  call: (
    p: Provider,
    model: string,
    r: DecisionRequest,
    key: string | null,
    timeout: number,
  ) => Promise<CallResult>;
  // Fetches the provider's catalog when a decision needs it and none is cached (see Catalog fetch in the contract).
  // It never throws; absent, nothing is fetched.
  ensureCatalog?: (p: Provider) => Promise<void>;
  // The model's input and output prices (USD per million) in the provider's cached catalog. Reads the cache only.
  catalogPrice: (p: Provider, model: string) => { input: number | null; output: number | null };
  clock: () => number;
  id: (prefix: string) => string;
  log: (entry: Log) => void;
};
type RunContext = { request: DecisionRequest; deps: DecideDeps; providers: Provider[] };

// Gathers the inputs to the price of an answered attempt, then leaves the decision to the pure charge. The defaults
// come from defaultPriceInput, as the models endpoint's default prices do.
function gatherCharge(p: Provider, target: Target, ctx: RunContext, parsed: Parsed): Charge {
  return chargeFor({
    estimatedTokens: parsed.estimatedTokens,
    usage: parsed.usage,
    billed: parsed.billed,
    request: ctx.request,
    target: target.price_per_m_input,
    targetOutput: target.price_per_m_output,
    ...defaultPriceInput(p, target.model, ctx.deps.catalogPrice(p, target.model)),
  });
}

// Reads an upstream answer, keeping the attempt's secrets and redacted field names out of any error excerpt.
function parseFor(
  p: Provider,
  ctx: RunContext,
  body: unknown,
  hidden: { secrets: string[]; fields: string[] },
): Parsed {
  return parseResult(body, ctx.request, responseWire(p), hidden.secrets, hidden.fields);
}

async function invoke(
  p: Provider,
  target: Target,
  ctx: RunContext,
  state: State,
  start: number,
  key: string | null,
): Promise<Outcome> {
  const body = upstreamBody(p, target.model, ctx.request);
  const header = customAuthHeader(p);
  const hidden = hiddenValues(state, key, header);
  try {
    await ctx.deps.ensureCatalog?.(p);
    const result = await ctx.deps.call(
      p,
      target.model,
      ctx.request,
      key,
      target.timeout_ms ?? p.timeout_ms,
    );
    const parsed = parseFor(p, ctx, result.body, hidden);
    return succeededOutcome(
      p.name,
      target.model,
      start,
      ctx.deps.clock(),
      result.request,
      result.body,
      key,
      parsed,
      gatherCharge(p, target, ctx, parsed),
      header,
    );
  } catch (e) {
    return failedOutcome(p.name, target.model, start, ctx.deps.clock(), e, body, key, header);
  }
}

async function attempt(target: Target, ctx: RunContext, state: State): Promise<Outcome> {
  const start = ctx.deps.clock();
  const candidate = ctx.providers.find((p) => p.id === target.provider_id);
  const check = eligibility(candidate, ctx.request);
  const name = candidate?.name ?? target.provider_id;
  if (!check.ok)
    return failedOutcome(
      name,
      target.model,
      start,
      ctx.deps.clock(),
      new CallFailure('limit', check.message),
    );
  const key = lookupKey(check.provider, ctx.deps);
  const authenticated = eligibility(check.provider, ctx.request, key);
  if (!authenticated.ok)
    return failedOutcome(
      name,
      target.model,
      start,
      ctx.deps.clock(),
      new CallFailure('limit', authenticated.message),
    );
  return invoke(authenticated.provider, target, ctx, state, start, key.ok ? key.key : null);
}

function lookupKey(provider: Provider, deps: DecideDeps): KeyLookup {
  try {
    return { ok: true, key: deps.key(provider) };
  } catch {
    return { ok: false };
  }
}

async function runTargets(targets: Target[], ctx: RunContext, state: State): Promise<State> {
  if (state.stop || !targets.length) return state;
  const outcome = await attempt(targets[0], ctx, state);
  return runTargets(targets.slice(1), ctx, reduceAttempt(state, outcome));
}

export async function decide(request: DecisionRequest, deps: DecideDeps): Promise<DecisionResult> {
  const start = deps.clock(),
    settings = deps.settings(),
    providers = deps.providers();
  const initial = initialState(request.model, settings, deps.routes(), providers);
  const state = await runTargets(initial.targets, { request, deps, providers }, initial.state);
  const end = deps.clock();
  const finished = finalize(state, request, settings, {
    start,
    end,
    created: end,
    timestamp: deps.clock(),
    responseId: state.answered ? deps.id('dec') : '',
    logId: deps.id('log'),
  });
  deps.log(finished.log);
  return finished.result;
}
