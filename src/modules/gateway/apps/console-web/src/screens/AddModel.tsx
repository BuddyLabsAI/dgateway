import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useApi } from "../app/api-context";
import { hrefFor } from "../app/router";
import { useResource } from "../app/hooks";
import type { PlaygroundRun, Provider, ProviderModel, Route } from "../api/types";
import { validateModelName } from "../domain/catalog";
import { chainSentence, routeChain, stepRole } from "../domain/chain";
import {
  CONNECTION_MARK,
  CONNECTION_WORD,
  KIND_LABEL,
  KIND_SENTENCE,
  connectionStatus,
  connectionTitle,
  keySummary,
  sortConnections,
  titleLookup,
} from "../domain/connections";
import {
  costAt,
  defaultOutputPriceSentence,
  defaultPriceSentence,
  effectiveOutputPrice,
  effectivePrice,
  formatUsd,
  outputPriceSummary,
  parsePrice,
  priceSummary,
} from "../domain/cost";
import { chainStations } from "../domain/health";
import {
  ADD_MODEL_STEPS,
  addModelIssue,
  directTestRequest,
  emptyAddModel,
  furthestStep,
  newStep,
  pickPrimaryUpstream,
  pickUpstream,
  routeFromAddModel,
  takenNames,
  typePrice,
  type AddModelDraft,
  type StepDraft,
} from "../domain/model-draft";
import { equivalentCurl, sampleDecision } from "../domain/playground";
import { runOutcome } from "../domain/test-result";
import { reveal } from "../motion/motion";
import { CatalogList, catalogFilter, catalogOptions, loadCatalogs, useCatalog } from "../ui/catalog";
import { CodeBlock } from "../ui/code";
import { Combobox } from "../ui/combobox";
import { Button, SelectField, TextField } from "../ui/controls";
import { cx } from "../ui/cx";
import { CopyButton } from "../ui/disclosure";
import { ErrorState, Flag, LoadingRows, Notice, PageHeader, describeError } from "../ui/feedback";
import { Icon } from "../ui/icons";
import { KeyEntry } from "../ui/key-entry";
import { RouteLine } from "../ui/network";
import { StationMark, StatusChip } from "../ui/status";
import { Stepper } from "../ui/stepper";
import { TestResult } from "../ui/test-result";
import { useNotify } from "../ui/toaster";

export function AddModelScreen({ connectionId, upstream }: { connectionId: string | null; upstream: string | null }) {
  const api = useApi();
  const routes = useResource(() => api.listRoutes(), []);
  const providers = useResource(() => api.listProviders(), []);
  const settings = useResource(() => api.getSettings(), []);

  return (
    <div className="screen">
      <p className="crumb">
        <a href={hrefFor("models")}>
          <Icon name="arrow-right" size={14} className="crumb-back" />
          <span>All models</span>
        </a>
      </p>
      <PageHeader
        title="Add a model"
        subtitle={
          <>
            A model is the name your apps send as <span className="mono">model</span>. Choose where it runs, name it, add a fallback if you like,
            and try it before you save.
          </>
        }
      />
      {(routes.status === "loading" && !routes.data) || (providers.status === "loading" && !providers.data) ? (
        <LoadingRows rows={5} label="Loading providers" />
      ) : null}
      {routes.status === "error" && !routes.data ? (
        <ErrorState error={routes.error} title="Models did not load" onRetry={routes.reload} />
      ) : null}
      {providers.status === "error" && !providers.data ? (
        <ErrorState error={providers.error} title="Providers did not load" onRetry={providers.reload} />
      ) : null}
      {routes.data && providers.data ? (
        <AddModelFlow
          routes={routes.data}
          initialProviders={providers.data}
          preselect={connectionId}
          upstream={upstream}
          requireKeys={settings.data?.require_client_keys ?? false}
        />
      ) : null}
    </div>
  );
}

function initialState(
  providers: readonly Provider[],
  taken: readonly string[],
  preselect: string | null,
  upstream: string | null,
): { draft: AddModelDraft; step: number } {
  const chosen = preselect ? providers.find((provider) => provider.id === preselect) : undefined;
  if (!chosen) return { draft: emptyAddModel(), step: 0 };
  let draft = emptyAddModel(chosen.id);
  if (connectionStatus(chosen) !== "connected") return { draft, step: 0 };
  if (!upstream) return { draft, step: 1 };
  draft = pickPrimaryUpstream(draft, upstream, undefined, taken);
  return { draft, step: 2 };
}

interface TestTry {
  stepIndex: number;
  run: PlaygroundRun | null;
  error: string | null;
}

function AddModelFlow({
  routes,
  initialProviders,
  preselect,
  upstream,
  requireKeys,
}: {
  routes: Route[];
  initialProviders: Provider[];
  preselect: string | null;
  upstream: string | null;
  requireKeys: boolean;
}) {
  const api = useApi();
  const notify = useNotify();
  const taken = useMemo(() => takenNames(routes), [routes]);
  const [providers, setProviders] = useState(initialProviders);
  const initial = useMemo(() => initialState(initialProviders, taken, preselect, upstream), [initialProviders, taken, preselect, upstream]);
  const [draft, setDraft] = useState<AddModelDraft>(initial.draft);
  // Whether the gateway can store a pasted key, read before a paste so its warning comes first.
  const health = useResource(() => api.health(), []);
  // The catalogs of the providers in the draft: an OpenAI or OpenRouter step's price comes from them.
  const draftConnectionIds = [...new Set(draft.steps.map((step) => step.providerId).filter((id) => id.length > 0))];
  const draftCatalogs = useResource(() => loadCatalogs(api, draftConnectionIds), [draftConnectionIds.join(",")]);
  const [current, setCurrent] = useState(initial.step);
  const [attempted, setAttempted] = useState(false);
  const [tests, setTests] = useState<TestTry[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [created, setCreated] = useState<Route | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const stepId = ADD_MODEL_STEPS[current]?.id ?? "connection";
  const issue = addModelIssue(stepId, draft, taken);
  const reachable = created ? current : furthestStep(draft, taken);
  const primary = draft.steps[0];
  const primaryProvider = providers.find((provider) => provider.id === primary?.providerId);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    reveal(panelRef.current);
    headingRef.current?.focus();
  }, [current]);

  // A pick that arrived in the link (Browse models → Add model) gets its catalog price once the
  // catalog loads, as a pick in the list would. Each pick is filled once, so clearing it sticks.
  const primaryCatalog = useCatalog(primary?.providerId || null);
  const filled = useRef(new Set<string>());
  useEffect(() => {
    if (!primary || !primary.model.trim()) return;
    const key = `${primary.providerId}|${primary.model.trim()}`;
    if (filled.current.has(key)) return;
    if (primary.price.trim()) {
      filled.current.add(key);
      return;
    }
    const listed = primaryCatalog.models.find((model) => model.id === primary.model.trim())?.price_per_m_input;
    if (listed === undefined) return;
    filled.current.add(key);
    setDraft((currentDraft) => ({
      ...currentDraft,
      steps: currentDraft.steps.map((step, index) => (index === 0 ? pickUpstream(step, step.model, listed) : step)),
    }));
  }, [primaryCatalog.models, primary]);

  const open = (index: number): void => {
    setAttempted(false);
    setCurrent(index);
  };

  const next = (event?: FormEvent<HTMLFormElement>): void => {
    event?.preventDefault();
    setAttempted(true);
    if (issue) {
      panelRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    open(Math.min(ADD_MODEL_STEPS.length - 1, current + 1));
  };

  const back = (): void => open(Math.max(0, current - 1));

  const setStep = (index: number, update: (step: StepDraft) => StepDraft): void => {
    setDraft((currentDraft) => ({ ...currentDraft, steps: currentDraft.steps.map((step, i) => (i === index ? update(step) : step)) }));
    setTests(null);
  };

  const replaceProvider = (updated: Provider): void => {
    setProviders((list) => list.map((provider) => (provider.id === updated.id ? updated : provider)));
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    const tries: TestTry[] = [];
    try {
      for (const [index, step] of draft.steps.entries()) {
        const request = directTestRequest(step, providers);
        if (!request) continue;
        try {
          const run = await api.runPlayground(request);
          tries.push({ stepIndex: index, run, error: null });
          if (run.response) break;
        } catch (caught) {
          tries.push({ stepIndex: index, run: null, error: describeError(caught) });
        }
      }
      setTests(tries);
    } finally {
      setTesting(false);
    }
  };

  const create = async (): Promise<void> => {
    setCreating(true);
    setCreateError(null);
    try {
      const route = await api.createRoute(routeFromAddModel(draft));
      setCreated(route);
      notify(`Created ${route.alias}.`);
    } catch (caught) {
      setCreateError(caught);
    } finally {
      setCreating(false);
    }
  };

  const stations = chainStations(
    draft.steps.filter((step) => step.providerId).map((step) => ({ provider_id: step.providerId, model: step.model.trim() })),
    providers,
  );

  return (
    <div className="flow">
      <Stepper
        steps={ADD_MODEL_STEPS}
        current={created ? ADD_MODEL_STEPS.length : current}
        reachable={reachable}
        onOpen={open}
        label="Add model steps"
      />

      <div className="flow-grid">
        <div className="panel flow-panel" ref={panelRef}>
          <h2 className="flow-title" tabIndex={-1} ref={headingRef}>
            {created ? `${created.alias} is ready` : FLOW_TITLES[stepId]}
          </h2>

          {created ? (
            <SavedView route={created} requireKeys={requireKeys} />
          ) : (
            <>
              {stepId === "connection" ? (
                <ConnectionStep
                  providers={providers}
                  secretConfigured={health.data?.secret_configured}
                  selected={primary?.providerId ?? ""}
                  onSelect={(providerId) => {
                    setDraft((currentDraft) => ({
                      ...currentDraft,
                      steps: [newStep(providerId), ...currentDraft.steps.slice(1)],
                      name: currentDraft.nameEdited ? currentDraft.name : "",
                    }));
                    setTests(null);
                  }}
                  onProviderChanged={replaceProvider}
                  error={attempted ? issue : null}
                  onNext={next}
                />
              ) : null}

              {stepId === "upstream" && primary && primaryProvider ? (
                <UpstreamStep
                  provider={primaryProvider}
                  step={primary}
                  error={attempted ? issue : null}
                  onPick={(id, price) => {
                    setDraft((currentDraft) => pickPrimaryUpstream(currentDraft, id, price, taken));
                    setTests(null);
                  }}
                  onPrice={(price) => setStep(0, (step) => typePrice(step, price))}
                  onOutputPrice={(outputPrice) => setStep(0, (step) => ({ ...step, outputPrice }))}
                  onNext={next}
                  onBack={back}
                />
              ) : null}

              {stepId === "name" ? (
                <NameStep
                  draft={draft}
                  taken={taken}
                  onName={(name) => setDraft((currentDraft) => ({ ...currentDraft, name, nameEdited: true }))}
                  onDescription={(description) => setDraft((currentDraft) => ({ ...currentDraft, description }))}
                  onNext={next}
                  onBack={back}
                />
              ) : null}

              {stepId === "fallback" ? (
                <FallbackStep
                  draft={draft}
                  providers={providers}
                  error={attempted ? issue : null}
                  onAdd={() => {
                    setDraft((currentDraft) => ({ ...currentDraft, steps: [...currentDraft.steps, newStep()] }));
                    setTests(null);
                  }}
                  onRemove={(index) => {
                    setDraft((currentDraft) => ({ ...currentDraft, steps: currentDraft.steps.filter((_, i) => i !== index) }));
                    setTests(null);
                  }}
                  onChange={setStep}
                  onNext={next}
                  onBack={back}
                />
              ) : null}

              {stepId === "test" ? (
                <TestStep
                  draft={draft}
                  providers={providers}
                  tests={tests}
                  testing={testing}
                  onRun={() => void runTest()}
                  onNext={next}
                  onBack={back}
                />
              ) : null}

              {stepId === "save" ? (
                <SaveStep
                  draft={draft}
                  providers={providers}
                  catalogs={draftCatalogs.data}
                  busy={creating}
                  error={createError}
                  onCreate={() => void create()}
                  onBack={back}
                />
              ) : null}
            </>
          )}
        </div>

        <aside className="panel flow-aside" aria-label="The model so far">
          <h2 className="flow-aside-title">So far</h2>
          <p className="flow-aside-name">
            <span className="flow-aside-label">Apps send</span>
            <span className="mono">{draft.name.trim() ? `"${draft.name.trim()}"` : "a name you choose"}</span>
          </p>
          <RouteLine stops={stations} ink={routes.length % 5} label="The steps so far, first on the left" />
          {stations.length > 0 ? (
            <p className="flow-aside-sentence">
              {chainSentence(
                routeChain(
                  draft.steps.filter((step) => step.providerId).map((step) => ({ provider_id: step.providerId, model: step.model.trim() })),
                  providers,
                ),
              )}
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

const FLOW_TITLES: Record<(typeof ADD_MODEL_STEPS)[number]["id"], string> = {
  connection: "Choose a provider",
  upstream: "Which upstream model?",
  name: "What will apps call it?",
  fallback: "Add a fallback (optional)",
  test: "Try it before you save",
  save: "Save the model",
};

function FlowActions({ children, onBack }: { children: ReactNode; onBack?: () => void }) {
  return (
    <div className="flow-actions">
      {children}
      {onBack ? (
        <Button variant="quiet" onClick={onBack} className="flow-back">
          Back
        </Button>
      ) : null}
    </div>
  );
}

function ConnectionStep({
  providers,
  selected,
  onSelect,
  onProviderChanged,
  secretConfigured,
  error,
  onNext,
}: {
  providers: Provider[];
  selected: string;
  onSelect: (providerId: string) => void;
  onProviderChanged: (provider: Provider) => void;
  /** From the health report: false means the gateway cannot store a pasted key. */
  secretConfigured?: boolean;
  error: string | null;
  onNext: (event?: FormEvent<HTMLFormElement>) => void;
}) {
  const api = useApi();
  const notify = useNotify();
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<unknown>(null);
  const chosen = providers.find((provider) => provider.id === selected);
  const status = chosen ? connectionStatus(chosen) : null;
  // Real providers first and the mock last: the mock is for trying things, not for apps.
  const ordered = [
    ...sortConnections(providers.filter((provider) => provider.kind !== "mock")),
    ...providers.filter((provider) => provider.kind === "mock"),
  ];
  const keyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== "needs-key") return;
    keyRef.current?.scrollIntoView({ block: "nearest" });
    keyRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [selected, status]);

  const enable = async (): Promise<void> => {
    if (!chosen) return;
    setEnabling(true);
    setEnableError(null);
    try {
      const updated = await api.updateProvider(chosen.id, { enabled: true });
      onProviderChanged(updated);
      notify(`Turned on ${connectionTitle(updated.name, updated.kind)}.`);
    } catch (caught) {
      setEnableError(caught);
    } finally {
      setEnabling(false);
    }
  };

  return (
    <>
      <form onSubmit={onNext} noValidate>
        <fieldset className="choice-cards" aria-describedby={error ? "connection-error" : undefined}>
          <legend className="sr-only">Provider</legend>
          {ordered.map((provider) => {
            const providerStatus = connectionStatus(provider);
            return (
              <label
                key={provider.id}
                className={cx("choice-card", provider.id === selected && "is-selected", providerStatus === "disabled" && "is-muted")}
              >
                <input
                  type="radio"
                  name="connection"
                  value={provider.id}
                  checked={provider.id === selected}
                  onChange={() => onSelect(provider.id)}
                  className="choice-card-input"
                />
                <span className="choice-card-head">
                  <span className="choice-card-title">{connectionTitle(provider.name, provider.kind)}</span>
                  <StatusChip status={CONNECTION_MARK[providerStatus]}>{CONNECTION_WORD[providerStatus]}</StatusChip>
                </span>
                <span className="choice-card-meta">
                  {provider.kind === "mock"
                    ? "Built in"
                    : KIND_LABEL[provider.kind] !== connectionTitle(provider.name, provider.kind)
                      ? `${KIND_LABEL[provider.kind]} · ${provider.base_url}`
                      : provider.base_url}
                </span>
                <span className="choice-card-body">{KIND_SENTENCE[provider.kind]}</span>
                <span className="choice-card-foot">{keySummary(provider)}</span>
              </label>
            );
          })}
        </fieldset>
        {error ? (
          <p id="connection-error" className="field-error" role="alert">
            <Icon name="warning" size={14} />
            <span>{error}</span>
          </p>
        ) : null}

        {chosen && status === "connected" ? (
          <FlowActions>
            <Button variant="primary" type="submit">
              Continue with {connectionTitle(chosen.name, chosen.kind)}
            </Button>
          </FlowActions>
        ) : null}
      </form>

      {chosen && status === "needs-key" ? (
        <div className="flow-sub" ref={keyRef}>
          <h3 className="flow-subtitle">
            <StationMark status="failing" size={12} />
            <span>{connectionTitle(chosen.name, chosen.kind)} needs a key</span>
          </h3>
          <KeyEntry provider={chosen} onSaved={onProviderChanged} secretConfigured={secretConfigured} />
          <p className="field-hint flow-skip">
            Or{" "}
            <button type="button" className="link-button" onClick={() => onNext()}>
              continue without a key
            </button>
            : you can still save the model, but it cannot answer until the key is set.
          </p>
        </div>
      ) : null}

      {chosen && status === "disabled" ? (
        <div className="flow-sub">
          <h3 className="flow-subtitle">
            <StationMark status="disabled" size={12} />
            <span>{connectionTitle(chosen.name, chosen.kind)} is turned off</span>
          </h3>
          <p className="field-hint">A disabled provider is skipped. Turn it on to use it, or pick another.</p>
          {enableError ? <p className="field-error">{describeError(enableError)}</p> : null}
          <FlowActions>
            <Button variant="primary" onClick={() => void enable()} disabled={enabling}>
              {enabling ? "Turning on…" : "Turn it on"}
            </Button>
          </FlowActions>
        </div>
      ) : null}
    </>
  );
}

function PriceField({
  step,
  provider,
  catalogModels,
  onPrice,
  onOutputPrice,
  error,
}: {
  step: StepDraft;
  provider: Provider | undefined;
  catalogModels: Parameters<typeof effectivePrice>[3];
  onPrice: (price: string) => void;
  onOutputPrice: (price: string) => void;
  error?: string | null;
}) {
  const parsed = parsePrice(step.price);
  const resolved = effectivePrice(parsed.ok ? parsed.value : null, provider, step.model.trim(), catalogModels);
  const parsedOutput = parsePrice(step.outputPrice ?? "", "output");
  const resolvedOutput = effectiveOutputPrice(parsedOutput.ok ? parsedOutput.value : null, provider, step.model.trim(), catalogModels);
  return (
    <>
    <TextField
      label="Price, USD per million input tokens"
      value={step.price}
      onChange={(event) => onPrice(event.target.value)}
      error={error ?? (parsed.ok ? null : parsed.message)}
      inputMode="decimal"
      mono
      placeholder={resolved.price === null ? "unpriced" : String(resolved.price)}
      hint={
        step.price.trim().length > 0
          ? step.priceFromCatalog
            ? "Filled in from the catalog. Change it if your account pays a different price."
            : "Your price. Clear it to use the default."
          : defaultPriceSentence(resolved)
      }
    />
    <TextField
      label="Price, USD per million output tokens"
      value={step.outputPrice ?? ""}
      onChange={(event) => onOutputPrice(event.target.value)}
      error={parsedOutput.ok ? null : parsedOutput.message}
      inputMode="decimal"
      mono
      placeholder={resolvedOutput.price === null ? "no output price" : String(resolvedOutput.price)}
      hint={(step.outputPrice ?? "").trim().length > 0 ? "Your output price. Clear it to use the default." : defaultOutputPriceSentence(resolvedOutput)}
    />
    </>
  );
}

function UpstreamStep({
  provider,
  step,
  error,
  onPick,
  onPrice,
  onOutputPrice,
  onNext,
  onBack,
}: {
  provider: Provider;
  step: StepDraft;
  error: string | null;
  onPick: (id: string, price: number | undefined) => void;
  onPrice: (price: string) => void;
  onOutputPrice: (price: string) => void;
  onNext: (event?: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}) {
  const catalog = useCatalog(provider.id);
  const hinted = (provider.model_hints?.length ?? 0) > 0;
  return (
    <form onSubmit={onNext} noValidate>
      <p className="flow-lede">
        The models {connectionTitle(provider.name, provider.kind)} offers, with the input price and context size its catalog lists. Pick one, or
        search for an id that is not listed and use it as typed.
        {hinted
          ? " Its suggested models come first, with the list prices saved when it was added; your account may pay a different price."
          : null}
      </p>
      <CatalogList
        catalog={catalog}
        selected={step.model.trim()}
        onPick={(id, model) => onPick(id, model?.price_per_m_input)}
        pickLabel="Choose"
        suggested={hinted}
      />
      {error ? (
        <p className="field-error" role="alert">
          <Icon name="warning" size={14} />
          <span>{error}</span>
        </p>
      ) : null}
      {step.model.trim() ? (
        <div className="flow-chosen">
          <p className="flow-chosen-line">
            <Icon name="check" size={14} />
            <span>
              Chosen: <span className="mono">{step.model.trim()}</span>
            </span>
          </p>
          <PriceField step={step} provider={provider} catalogModels={catalog.models} onPrice={onPrice} onOutputPrice={onOutputPrice} />
        </div>
      ) : null}
      <FlowActions onBack={onBack}>
        <Button variant="primary" type="submit">
          Continue
        </Button>
      </FlowActions>
    </form>
  );
}

function NameStep({
  draft,
  taken,
  onName,
  onDescription,
  onNext,
  onBack,
}: {
  draft: AddModelDraft;
  taken: string[];
  onName: (name: string) => void;
  onDescription: (description: string) => void;
  onNext: (event?: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}) {
  const name = draft.name.trim();
  const problem = validateModelName(draft.name, taken);
  const snippet = JSON.stringify({ model: name || "…", input: "…", questions: ["…"] }, null, 2);
  return (
    <form onSubmit={onNext} noValidate>
      <div className="form-grid">
        <TextField
          label="Name"
          value={draft.name}
          onChange={(event) => onName(event.target.value)}
          error={draft.name.length > 0 || draft.nameEdited ? problem : null}
          hint={problem ? "Lowercase letters, digits and hyphens. It must be unique." : "Looks good. Apps send this name and need not know the providers behind it."}
          mono
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
        <TextField
          label="Description (optional)"
          value={draft.description}
          onChange={(event) => onDescription(event.target.value)}
          hint="Apps see it on GET /v1/models."
        />
      </div>
      <div className="flow-snippet">
        <p className="field-hint">Apps send exactly this in the body of POST /v1/decisions:</p>
        <CodeBlock label="Request body" text={snippet} language="json" />
      </div>
      <FlowActions onBack={onBack}>
        <Button variant="primary" type="submit">
          Continue
        </Button>
      </FlowActions>
    </form>
  );
}

function FallbackStep({
  draft,
  providers,
  error,
  onAdd,
  onRemove,
  onChange,
  onNext,
  onBack,
}: {
  draft: AddModelDraft;
  providers: Provider[];
  error: string | null;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, update: (step: StepDraft) => StepDraft) => void;
  onNext: (event?: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}) {
  const primary = draft.steps[0];
  const primaryProvider = providers.find((provider) => provider.id === primary?.providerId);
  const fallbacks = draft.steps.slice(1);
  return (
    <form onSubmit={onNext} noValidate>
      <p className="flow-lede">
        If {primaryProvider ? connectionTitle(primaryProvider.name, primaryProvider.kind) : "the first step"} fails or times out, the gateway
        tries these next, in order. Pick a different provider so one outage does not take both down.
      </p>
      {fallbacks.length > 0 ? (
        <ol className="flow-fallbacks">
          {fallbacks.map((step, offset) => (
            <FallbackRow
              key={step.rowId}
              step={step}
              position={offset + 2}
              providers={providers}
              onChange={(update) => onChange(offset + 1, update)}
              onRemove={() => onRemove(offset + 1)}
            />
          ))}
        </ol>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          <Icon name="warning" size={14} />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="row-start">
        <Button variant="secondary" small onClick={onAdd}>
          <Icon name="plus" size={14} />
          <span>{fallbacks.length === 0 ? "Add a fallback" : "Add another fallback"}</span>
        </Button>
      </div>
      <FlowActions onBack={onBack}>
        <Button variant="primary" type="submit">
          {fallbacks.length === 0 ? "Continue without a fallback" : "Continue"}
        </Button>
      </FlowActions>
    </form>
  );
}

function FallbackRow({
  step,
  position,
  providers,
  onChange,
  onRemove,
}: {
  step: StepDraft;
  position: number;
  providers: Provider[];
  onChange: (update: (step: StepDraft) => StepDraft) => void;
  onRemove: () => void;
}) {
  const provider = providers.find((candidate) => candidate.id === step.providerId);
  const catalog = useCatalog(step.providerId || null);
  const options = useMemo(() => catalogOptions(catalog.models), [catalog.models]);
  const filter = useMemo(() => catalogFilter(catalog.models), [catalog.models]);
  return (
    <li className="flow-fallback">
      <p className="step-role">
        {stepRole(position)} <span className="muted">(step {position})</span>
      </p>
      <div className="flow-fallback-fields">
        <SelectField
          label="Provider"
          value={step.providerId}
          onChange={(event) => {
            const providerId = event.target.value;
            onChange((current) => ({ ...current, providerId, model: "", price: "", priceFromCatalog: false }));
          }}
        >
          <option value="">Choose a provider</option>
          {sortConnections(providers).map((candidate) => {
            const status = connectionStatus(candidate);
            return (
              <option key={candidate.id} value={candidate.id}>
                {connectionTitle(candidate.name, candidate.kind)}
                {status === "connected" ? "" : ` (${CONNECTION_WORD[status].toLowerCase()})`}
              </option>
            );
          })}
        </SelectField>
        <Combobox
          label="Upstream model"
          value={step.model}
          options={options}
          filter={filter}
          loading={catalog.loading}
          mono
          placeholder={step.providerId ? (catalog.models[0]?.id ?? "the id this provider expects") : "choose a provider first"}
          onChange={(text) => onChange((current) => ({ ...current, model: text }))}
          onPick={(option) =>
            onChange((current) =>
              pickUpstream(current, option.value, catalog.models.find((model) => model.id === option.value)?.price_per_m_input),
            )
          }
        />
        <PriceField
          step={step}
          provider={provider}
          catalogModels={catalog.models}
          onPrice={(price) => onChange((current) => typePrice(current, price))}
          onOutputPrice={(outputPrice) => onChange((current) => ({ ...current, outputPrice }))}
        />
        <Button variant="quiet" small onClick={onRemove} aria-label={`Remove fallback step ${position}`} className="flow-fallback-remove">
          <Icon name="close" size={14} />
        </Button>
      </div>
      {provider && connectionStatus(provider) !== "connected" ? (
        <p className="field-hint">
          <StationMark status={CONNECTION_MARK[connectionStatus(provider)]} size={10} /> {connectionTitle(provider.name, provider.kind)}{" "}
          {connectionStatus(provider) === "needs-key"
            ? "needs a key, so this step is skipped until it has one."
            : "is disabled, so this step is skipped."}
        </p>
      ) : null}
    </li>
  );
}

function TestStep({
  draft,
  providers,
  tests,
  testing,
  onRun,
  onNext,
  onBack,
}: {
  draft: AddModelDraft;
  providers: Provider[];
  tests: TestTry[] | null;
  testing: boolean;
  onRun: () => void;
  onNext: (event?: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}) {
  const titleOf = titleLookup(providers);
  const answered = tests?.find((entry) => entry.run?.response);
  const answeredStep = answered ? draft.steps[answered.stepIndex] : undefined;
  const answeredProvider = providers.find((provider) => provider.id === answeredStep?.providerId);
  const ownPrice = answeredStep ? parsePrice(answeredStep.price) : null;
  const tokens = answered?.run?.response?.gateway.tokens ?? null;
  const charged = answered?.run?.response?.gateway.cost_usd ?? null;
  // A provider that bills its own cost is charged that whatever the step's price, so the price is not compared.
  const billed = answered?.run?.response?.gateway.cost_basis === "upstream_cost";
  const atStepPrice = ownPrice?.ok && ownPrice.value !== null && !billed ? costAt(tokens, ownPrice.value) : null;
  const atYourPrice = atStepPrice !== null && atStepPrice !== charged ? atStepPrice : null;
  const failures = tests?.filter((entry) => entry !== answered) ?? [];

  return (
    <form onSubmit={onNext} noValidate>
      <p className="flow-lede">
        Asks one question with a known answer, so you see that it works, that the answer makes sense, how long it took and what it cost. The
        model is not saved yet, so each step is called directly as <span className="mono">provider::model</span>, in order, until one answers.
      </p>
      <div className="row-start">
        <Button variant={tests ? "secondary" : "primary"} onClick={onRun} disabled={testing}>
          <Icon name="bolt" size={14} />
          <span>{testing ? "Testing…" : tests ? "Test again" : "Run the test"}</span>
        </Button>
      </div>

      {testing ? <LoadingRows rows={3} label="Waiting for the answer" /> : null}

      {!testing && tests ? (
        <div className="flow-test">
          {failures.map((entry) => {
            const step = draft.steps[entry.stepIndex];
            const provider = providers.find((candidate) => candidate.id === step?.providerId);
            return (
              <div key={entry.stepIndex} className="flow-test-try">
                <p className="flow-test-label">
                  Step {entry.stepIndex + 1}: {provider ? connectionTitle(provider.name, provider.kind) : "provider"}{" "}
                  <span className="mono">{step?.model}</span>
                </p>
                {entry.run ? <TestResult outcome={runOutcome(entry.run, titleOf)} /> : <p className="field-error">{entry.error}</p>}
              </div>
            );
          })}
          {answered?.run ? (
            <div className="flow-test-try">
              <p className="flow-test-label">
                Step {answered.stepIndex + 1}: {answeredProvider ? connectionTitle(answeredProvider.name, answeredProvider.kind) : "provider"}{" "}
                <span className="mono">{answeredStep?.model}</span>
              </p>
              <TestResult outcome={runOutcome(answered.run, titleOf)} />
              {atYourPrice !== null ? (
                <p className="field-hint">
                  At the price on this step, this decision costs <span className="mono">{formatUsd(atYourPrice)}</span>. The gateway uses your price
                  once the model is saved.
                </p>
              ) : null}
            </div>
          ) : null}
          {!answered ? (
            <Notice tone="warn" title="No step answered">
              You can still save the model and fix the providers later; apps that send it get an error until a step answers.
            </Notice>
          ) : null}
        </div>
      ) : null}

      <FlowActions onBack={onBack}>
        <Button variant={tests ? "primary" : "secondary"} type="submit">
          {tests ? "Continue" : "Skip the test"}
        </Button>
      </FlowActions>
    </form>
  );
}

function SaveStep({
  draft,
  providers,
  catalogs,
  busy,
  error,
  onCreate,
  onBack,
}: {
  draft: AddModelDraft;
  providers: Provider[];
  /** The catalogs of the draft's connections, by connection id; undefined while they load. */
  catalogs: ReadonlyMap<string, readonly ProviderModel[]> | undefined;
  busy: boolean;
  error: unknown;
  onCreate: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <dl className="facts flow-summary">
        <div>
          <dt>Name</dt>
          <dd className="mono">{draft.name.trim()}</dd>
        </div>
        {draft.description.trim() ? (
          <div>
            <dt>Description</dt>
            <dd>{draft.description.trim()}</dd>
          </div>
        ) : null}
        {draft.steps.map((step, index) => {
          const provider = providers.find((candidate) => candidate.id === step.providerId);
          const parsed = parsePrice(step.price);
          const parsedOutput = parsePrice(step.outputPrice ?? "", "output");
          return (
            <div key={step.rowId}>
              <dt>{stepRole(index + 1)}</dt>
              <dd>
                {provider ? connectionTitle(provider.name, provider.kind) : "provider"} <span className="mono">{step.model.trim()}</span>
                <span className="muted mono">
                  {" "}
                  · {priceSummary(parsed.ok ? parsed.value : null, provider, step.model.trim(), catalogs?.get(step.providerId))}
                  {" "}
                  · {outputPriceSummary(parsedOutput.ok ? parsedOutput.value : null, provider, step.model.trim(), catalogs?.get(step.providerId))}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
      {error ? <ErrorState error={error} title="The model was not created" /> : null}
      <FlowActions onBack={onBack}>
        <Button variant="primary" onClick={onCreate} disabled={busy}>
          {busy ? "Creating…" : "Create model"}
        </Button>
      </FlowActions>
    </div>
  );
}

function SavedView({ route, requireKeys }: { route: Route; requireKeys: boolean }) {
  const origin = typeof window === "undefined" ? "http://127.0.0.1:8790" : window.location.origin;
  const curl = equivalentCurl(sampleDecision(route.alias), origin, requireKeys);
  return (
    <div className="flow-saved">
      <p className="flow-lede">
        <Flag tone="ok">Saved</Flag> Apps can send <span className="mono">&quot;model&quot;: &quot;{route.alias}&quot;</span> now. Here is a
        request to start from:
      </p>
      <CodeBlock label="Example request" text={curl} language="curl" actions={<CopyButton text={curl} label="Copy curl" />} />
      {requireKeys ? (
        <p className="field-hint">
          Apps need a client key. Set <span className="mono">DG_CLIENT_KEY</span> to one from <a href={hrefFor("keys")}>Keys</a>.
        </p>
      ) : null}
      <div className="flow-actions">
        <a className="btn btn--primary" href={hrefFor("try", null, { model: route.alias })}>
          Open in Try it
        </a>
        <a className="btn btn--secondary" href={hrefFor("models", route.id)}>
          View model
        </a>
        <a className="btn btn--quiet" href={hrefFor("models")}>
          All models
        </a>
      </div>
    </div>
  );
}
