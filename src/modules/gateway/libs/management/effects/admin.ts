import { GatewayError } from '../../decisions/schemas/types';
import { decide, type DecideDeps } from '../../decisions/effects/decide';
import { authHeaders } from '../../decisions/functions/wire';
import { redact } from '../functions/redact';
import { stats } from '../functions/stats';
import type { LastTest, Provider } from '../schemas/types';
import { Store, id, now, safeEqual } from '../providers/store';
import {
  providerDraft,
  applyProviderKey,
  storedKey,
  uniqueProvider,
  completeProvider,
  routeDraft,
  completeRoute,
  requireUnreferenced,
  mergeSettings,
  playgroundRequest,
  clientName,
  logPage,
  statsWindow,
  mapModels,
  mergeHints,
  modelPlan,
  withDefaultPrices,
  testRequest,
  modelTestInput,
  preferredTestModel,
  listedTestModel,
  missing,
  resource,
  health,
  playgroundResult,
  providerTestResult,
  lastTestRecord,
  catalogParameters,
  catalogFetchDue,
  catalogFetchPlan,
  type CatalogEntry,
  type ModelInfo,
  type ModelPlan,
  type KeyPlan,
} from '../functions/admin';

export class Admin {
  // The catalog fetch each provider has in flight, shared by concurrent decisions, and when its last fetch failed.
  private fetching = new Map<string, Promise<void>>();

  private failedAt = new Map<string, number>();

  // The catalog is shared with the decision path, which reads prices and supported parameters from it. Only this
  // class fills it: through the models endpoint, and through ensureCatalog before a decision that needs it.
  constructor(
    private store: Store,
    private deps: DecideDeps,
    private http: typeof fetch = fetch,
    private catalog: Map<string, CatalogEntry> = new Map(),
  ) {}

  authorize(bearer: string, token: string) {
    if (!safeEqual(bearer, token))
      throw new GatewayError(401, 'authentication_error', 'Invalid or missing admin token');
  }

  routes() {
    return this.store.routes();
  }

  health(started: number) {
    const providers = this.store.providers().map((p) => this.store.publicProvider(p));
    return health(providers, started, this.deps.clock(), this.store.secretConfigured());
  }

  providers() {
    return this.store.providers().map((p) => this.store.publicProvider(p));
  }

  provider(id: string) {
    return resource(this.store.providers(), id);
  }

  route(id: string) {
    return resource(this.store.routes(), id);
  }

  saveProvider(input: unknown, providerId?: string) {
    const old = providerId ? this.provider(providerId) : undefined;
    const draft = providerDraft(input, old);
    const value = applyProviderKey(draft.value, this.prepareKey(draft.plan));
    uniqueProvider(value, old, this.store.providers());
    const p = completeProvider(value, old, old?.id ?? id('prv'), old?.created_at ?? now(), now());
    this.store.putProvider(p);
    return this.store.publicProvider(p);
  }

  private prepareKey(plan: KeyPlan | undefined) {
    if (!plan) return undefined;
    const ciphertext = plan.source === 'stored' ? this.store.encrypt(plan.value) : undefined;
    return storedKey(plan, ciphertext);
  }

  deleteProvider(id: string) {
    this.provider(id);
    requireUnreferenced(id, this.store.routes());
    this.store.deleteProvider(id);
    return { ok: true };
  }

  saveRoute(input: unknown, routeId?: string) {
    const old = routeId ? this.route(routeId) : undefined;
    const draft = routeDraft(input, old, this.store.providers(), this.store.routes());
    const route = completeRoute(draft, old, old?.id ?? id('rte'), old?.created_at ?? now(), now());
    this.store.putRoute(route);
    return route;
  }

  deleteRoute(id: string) {
    this.route(id);
    this.store.deleteRoute(id);
    return { ok: true };
  }

  settings() {
    return this.store.settings();
  }

  updateSettings(input: unknown) {
    const settings = mergeSettings(input, this.settings());
    this.store.setSettings(settings);
    return settings;
  }

  clients() {
    return this.store.clients();
  }

  createClient(input: unknown) {
    return this.store.createClient(clientName(input));
  }

  deleteClient(id: string) {
    if (!this.store.deleteClient(id)) missing();
    return { ok: true };
  }

  logs(params: URLSearchParams) {
    return logPage(this.store.allLogs(), params);
  }

  stats(window: string | null) {
    return stats(this.store.allLogs(), statsWindow(window), this.deps.clock());
  }

  async playground(input: unknown) {
    const request = playgroundRequest(input);
    const result = await decide(request, this.deps);
    return playgroundResult(result);
  }

  // Sends the known-answer check to one model of the provider. The model's listing is read only when nothing before
  // it in the order (the model asked for, a route's, the provider's test model, its first hint) applies.
  async test(id: string, input: unknown) {
    const p = this.provider(id);
    const requested = modelTestInput(input);
    const choice =
      preferredTestModel(requested, p, this.store.routes()) ??
      listedTestModel((await this.models(id)).models);
    const start = this.deps.clock();
    const result = await decide(testRequest(p, choice.model), this.deps);
    const end = this.deps.clock();
    this.recordTest(id, lastTestRecord(result, choice, start, end));
    return providerTestResult(choice, start, end, result);
  }

  // Writes the result onto the provider as it is now, since it may have been edited while the test ran.
  // A provider deleted in the meantime has nothing to record on.
  private recordTest(id: string, record: LastTest) {
    const current = this.store.providers().find((p) => p.id === id);
    if (current) this.store.putProvider({ ...current, last_test: record });
  }

  // The default prices are read from the cached catalog after any fetch has refreshed it: the catalog a decision reads,
  // so a first listing and a cached one report the prices a decision is charged.
  async models(id: string): Promise<{ models: ModelInfo[] }> {
    const p = this.provider(id);
    const plan = modelPlan(p, this.catalog.get(id), this.deps.clock());
    const models = 'models' in plan ? plan.models : await this.listModels(p, plan);
    return { models: withDefaultPrices(p, models, this.catalog.get(id)) };
  }

  // Fetches the upstream listing and merges the provider's hints into it. When the listing fails or is slow, the
  // hints alone are the answer (none for a provider without hints).
  private async listModels(p: Provider, plan: Exclude<ModelPlan, { models: ModelInfo[] }>) {
    try {
      const { key, models, parameters } = await this.fetchCatalog(p, plan.url, plan.timeout);
      if (p.kind === 'openrouter')
        this.catalog.set(p.id, { expires: this.deps.clock() + 600000, models, parameters });
      return mergeHints(plan.hints, redact(models, key ? [key] : []) as ModelInfo[]);
    } catch {
      return plan.hints;
    }
  }

  // Fetches and caches a chat-wire OpenRouter provider's catalog before a decision, once: concurrent callers share the
  // fetch in flight, and a failure is remembered so decisions do not retry it for CATALOG_RETRY_MS. Never throws.
  ensureCatalog(p: Provider): Promise<void> {
    const pending = this.fetching.get(p.id);
    if (pending) return pending;
    if (!catalogFetchDue(p, this.catalog.has(p.id), this.failedAt.get(p.id), this.deps.clock()))
      return Promise.resolve();
    const plan = catalogFetchPlan(p);
    const fetch = this.fetchCatalog(p, plan.url, plan.timeout)
      .then(({ models, parameters }) => {
        this.catalog.set(p.id, { expires: this.deps.clock() + 600000, models, parameters });
        this.failedAt.delete(p.id);
      })
      .catch(() => {
        this.failedAt.set(p.id, this.deps.clock());
      })
      .finally(() => this.fetching.delete(p.id));
    this.fetching.set(p.id, fetch);
    return fetch;
  }

  private async fetchCatalog(p: Provider, url: string, timeout: number) {
    const key = this.store.key(p);
    const res = await this.http(url, {
      headers: authHeaders(p.auth_header, key),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error('models failed');
    const body = (await res.json()) as { data?: unknown };
    return { key, models: mapModels(body), parameters: catalogParameters(body) };
  }
}
