import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useApi } from "../app/api-context";
import { hrefFor, navigate } from "../app/router";
import { useResource } from "../app/hooks";
import type { Provider, Route } from "../api/types";
import { MODEL_NAME_PATTERN, validateModelName } from "../domain/catalog";
import { chainSentence, routeChain, stepRole } from "../domain/chain";
import { CONNECTION_WORD, connectionStatus, connectionTitle } from "../domain/connections";
import {
  defaultOutputPriceSentence,
  defaultPriceSentence,
  effectiveOutputPrice,
  effectivePrice,
  formatPricePerM,
  parsePrice,
} from "../domain/cost";
import { chainStations } from "../domain/health";
import { MODEL_INKS, findModel, modelVerdict } from "../domain/models";
import { KNOWN_ANSWER, quoted } from "../domain/known-answer";
import {
  hasIssues,
  newStep,
  pickUpstream,
  stepFromTarget,
  targetFromStep,
  typePrice,
  validateStep,
  type StepDraft,
  type StepIssues,
} from "../domain/model-draft";
import { catalogFilter, catalogOptions, useCatalog } from "../ui/catalog";
import { Combobox } from "../ui/combobox";
import { Button, SelectField, Switch, TextField } from "../ui/controls";
import { cx } from "../ui/cx";
import { ConfirmDialog } from "../ui/dialog";
import { CopyButton, Disclosure } from "../ui/disclosure";
import { EmptyState, ErrorState, Flag, LoadingRows, Section } from "../ui/feedback";
import { Icon } from "../ui/icons";
import { RouteLine, type LineStop } from "../ui/network";
import { StatusChip } from "../ui/status";
import { ProviderTestPanel } from "../ui/provider-test";
import { useNotify } from "../ui/toaster";

interface ModelDraft {
  name: string;
  description: string;
  enabled: boolean;
  steps: StepDraft[];
}

function draftFrom(route: Route): ModelDraft {
  return { name: route.alias, description: route.description, enabled: route.enabled, steps: route.targets.map(stepFromTarget) };
}

/** The fields that matter for "unsaved changes". Row ids and catalog flags are excluded on purpose. */
function comparable(draft: ModelDraft): string {
  return JSON.stringify({
    name: draft.name,
    description: draft.description,
    enabled: draft.enabled,
    steps: draft.steps.map((step) => [step.providerId, step.model, step.price, step.timeoutMs]),
  });
}

export function ModelDetailScreen({ idOrName, focusStep }: { idOrName: string; focusStep: string | null }) {
  const api = useApi();
  const routes = useResource(() => api.listRoutes(), []);
  const providers = useResource(() => api.listProviders(), []);
  const route = routes.data ? findModel(routes.data, idOrName) : undefined;
  const index = route && routes.data ? routes.data.indexOf(route) : 0;

  return (
    <div className="screen">
      <p className="crumb">
        <a href={hrefFor("models")}>
          <Icon name="arrow-right" size={14} className="crumb-back" />
          <span>All models</span>
        </a>
      </p>
      {routes.status === "loading" && !routes.data ? <LoadingRows rows={5} label="Loading the model" /> : null}
      {routes.status === "error" && !routes.data ? (
        <ErrorState error={routes.error} title="The model did not load" onRetry={routes.reload} />
      ) : null}
      {routes.data && !route ? (
        <EmptyState title="No model with that name">
          It may have been deleted or renamed. <a href={hrefFor("models")}>Back to all models</a>.
        </EmptyState>
      ) : null}
      {route && providers.data ? (
        <ModelEditor
          key={route.id}
          route={route}
          routes={routes.data ?? []}
          providers={providers.data}
          taken={(routes.data ?? []).map((candidate) => candidate.alias)}
          ink={index % MODEL_INKS}
          focusStep={focusStep ? Number(focusStep) : null}
          onSaved={(saved) => routes.setData((current) => current?.map((candidate) => (candidate.id === saved.id ? saved : candidate)))}
          onDeleted={() => {
            routes.reload();
            navigate(hrefFor("models"));
          }}
        />
      ) : null}
    </div>
  );
}

function ModelEditor({
  route,
  routes,
  providers,
  taken,
  ink,
  focusStep,
  onSaved,
  onDeleted,
}: {
  route: Route;
  /** Every model, for the model a step's test would use when the step has none yet. */
  routes: readonly Route[];
  providers: Provider[];
  taken: string[];
  ink: number;
  focusStep: number | null;
  onSaved: (route: Route) => void;
  onDeleted: () => void;
}) {
  const api = useApi();
  const notify = useNotify();
  const [draft, setDraft] = useState<ModelDraft>(() => draftFrom(route));
  const [nameError, setNameError] = useState<string | null>(null);
  const [stepIssues, setStepIssues] = useState<Record<string, StepIssues>>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const focusRow = useRef<{ rowId: string; control: "up" | "down" } | null>(null);
  const moveButtons = useRef<Map<string, HTMLButtonElement>>(new Map());
  const formRef = useRef<HTMLFormElement>(null);

  const baseline = useMemo(() => comparable(draftFrom(route)), [route]);
  const dirty = comparable(draft) !== baseline;
  const verdict = modelVerdict(route, providers);

  const stations = useMemo<LineStop[]>(() => {
    const targets = draft.steps.map((step) => {
      const timeout = Number(step.timeoutMs.trim());
      return {
        provider_id: step.providerId,
        model: step.model.trim(),
        timeout_ms: step.timeoutMs.trim() && Number.isFinite(timeout) ? timeout : undefined,
      };
    });
    return chainStations(targets, providers).map((station, index) => {
      const step = draft.steps[index];
      const price = step ? parsePrice(step.price) : null;
      const output = step ? parsePrice(step.outputPrice ?? "", "output") : null;
      const notes = [
        price?.ok && price.value !== null ? formatPricePerM(price.value) : null,
        output?.ok && output.value !== null ? formatPricePerM(output.value, "output") : null,
      ].filter((note): note is string => note !== null);
      return { ...station, note: notes.length > 0 ? notes.join(", ") : null };
    });
  }, [draft.steps, providers]);
  const sentence = chainSentence(
    routeChain(
      draft.steps.map((step) => ({ provider_id: step.providerId, model: step.model.trim() })),
      providers,
    ),
  );

  useEffect(() => {
    const pending = focusRow.current;
    if (!pending) return;
    focusRow.current = null;
    const other = pending.control === "up" ? "down" : "up";
    const primary = moveButtons.current.get(`${pending.rowId}:${pending.control}`);
    const alternate = moveButtons.current.get(`${pending.rowId}:${other}`);
    if (primary && !primary.disabled) primary.focus();
    else if (alternate && !alternate.disabled) alternate.focus();
  });

  useEffect(() => {
    if (!focusStep) return;
    const row = formRef.current?.querySelector<HTMLElement>(`[data-step="${focusStep}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.querySelector<HTMLInputElement>("input[data-price]")?.focus();
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSteps = (update: (steps: StepDraft[]) => StepDraft[]): void => {
    setDraft((current) => ({ ...current, steps: update(current.steps) }));
    setStepIssues({});
  };

  const updateStep = (rowId: string, update: (step: StepDraft) => StepDraft): void =>
    setSteps((steps) => steps.map((step) => (step.rowId === rowId ? update(step) : step)));

  const move = (index: number, delta: number, rowId: string): void => {
    const target = index + delta;
    if (target < 0 || target >= draft.steps.length) return;
    setSteps((steps) => {
      const next = [...steps];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      return next;
    });
    focusRow.current = { rowId, control: delta < 0 ? "up" : "down" };
  };

  const onRowKey = (event: KeyboardEvent<HTMLLIElement>, index: number, rowId: string): void => {
    if (!event.altKey) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(index, -1, rowId);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(index, 1, rowId);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    const name = draft.name.trim();
    const nameProblem = validateModelName(
      name,
      taken.filter((alias) => alias !== route.alias),
      route.alias,
    );
    const issues: Record<string, StepIssues> = {};
    for (const step of draft.steps) {
      const found = validateStep(step);
      if (hasIssues(found)) issues[step.rowId] = found;
    }
    setNameError(nameProblem);
    setStepIssues(issues);
    if (nameProblem || Object.keys(issues).length > 0 || draft.steps.length === 0) {
      if (draft.steps.length === 0) setFormError(new Error("Add at least one step, so the model can answer."));
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    setSaving(true);
    try {
      const saved = await api.updateRoute(route.id, {
        alias: name,
        description: draft.description.trim(),
        enabled: draft.enabled,
        targets: draft.steps.map(targetFromStep),
      });
      notify(`Saved ${saved.alias}.`);
      onSaved(saved);
      if (saved.alias !== route.alias) navigate(hrefFor("models", saved.id));
    } catch (error) {
      setFormError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteRoute(route.id);
      notify(`Deleted ${route.alias}.`);
      setDeleteOpen(false);
      onDeleted();
    } catch (error) {
      setDeleteError(error);
    } finally {
      setDeleting(false);
    }
  };

  const typedName = draft.name.trim();

  return (
    <div className="editor">
      <header className="editor-head">
        <div className="editor-head-text">
          <h1 className="editor-title">
            <span className={`line-badge line-badge--lg ink-${ink}`}>
              <span className="line-badge-swatch" aria-hidden="true" />
              <span className="mono">{route.alias}</span>
            </span>
            <CopyButton text={route.alias} label={`Copy the name ${route.alias}`} iconOnly />
          </h1>
          <p className="editor-sub">{route.description || "No description."}</p>
        </div>
        <div className="editor-head-state">
          <StatusChip status={verdict.status}>{verdict.word}</StatusChip>
          {dirty ? <Flag tone="warn">Unsaved changes</Flag> : null}
        </div>
      </header>

      <section className="panel chain-panel" aria-labelledby="chain-title">
        <header className="section-head">
          <div className="section-head-text">
            <h2 id="chain-title">The chain</h2>
            <p className="section-meta">{sentence}</p>
          </div>
        </header>
        <RouteLine stops={stations} ink={ink} size="lg" label="Steps in the order they are tried, first on the left" muted={!draft.enabled} />
        <p className="panel-foot">
          A step on a disabled provider, or one without its key, is skipped: the attempt is logged with the reason and the next step is tried.
          The line updates as you edit, before you save.
        </p>
      </section>

      <form ref={formRef} onSubmit={(event) => void save(event)} noValidate className="form-stack">
        {formError ? <ErrorState error={formError} title="The model was not saved" /> : null}

        <Section
          variant="panel"
          title="Steps, in order"
          id="steps"
          meta="Use the arrow buttons, or hold Alt and press the up or down arrow inside a step, to change the order."
        >
          {draft.steps.length === 0 ? <EmptyState title="No steps">Add a step so requests have somewhere to go.</EmptyState> : null}
          <ol className={`steps ink-${ink}`}>
            {draft.steps.map((step, index) => (
              <li key={step.rowId} className="step" data-step={index + 1} onKeyDown={(event) => onRowKey(event, index, step.rowId)}>
                <span className="step-rail" aria-hidden="true">
                  <span className="step-index mono">{index + 1}</span>
                </span>
                <StepEditor
                  step={step}
                  index={index}
                  routes={routes}
                  providers={providers}
                  issues={stepIssues[step.rowId] ?? {}}
                  onChange={(update) => updateStep(step.rowId, update)}
                />
                <div className="step-actions">
                  <Button
                    variant="quiet"
                    small
                    aria-label={`Move step ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1, step.rowId)}
                    ref={(element: HTMLButtonElement | null) => {
                      if (element) moveButtons.current.set(`${step.rowId}:up`, element);
                    }}
                  >
                    <Icon name="arrow-up" size={14} />
                  </Button>
                  <Button
                    variant="quiet"
                    small
                    aria-label={`Move step ${index + 1} down`}
                    disabled={index === draft.steps.length - 1}
                    onClick={() => move(index, 1, step.rowId)}
                    ref={(element: HTMLButtonElement | null) => {
                      if (element) moveButtons.current.set(`${step.rowId}:down`, element);
                    }}
                  >
                    <Icon name="arrow-down" size={14} />
                  </Button>
                  <Button
                    variant="quiet"
                    small
                    aria-label={`Remove step ${index + 1}`}
                    onClick={() => setSteps((steps) => steps.filter((item) => item.rowId !== step.rowId))}
                  >
                    <Icon name="close" size={14} />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          <div className="row-start">
            <Button variant="secondary" small onClick={() => setSteps((steps) => [...steps, newStep(providers[0]?.id ?? "")])}>
              <Icon name="plus" size={14} />
              <span>{draft.steps.length === 0 ? "Add a step" : "Add a fallback step"}</span>
            </Button>
          </div>
        </Section>

        <Section variant="panel" title="Name" id="name">
          <div className="form-grid">
            <TextField
              label="Name apps send"
              value={draft.name}
              onChange={(event) => {
                setDraft((current) => ({ ...current, name: event.target.value }));
                setNameError(null);
              }}
              error={nameError ?? (typedName && !MODEL_NAME_PATTERN.test(typedName) ? "Use lowercase letters, digits and hyphens." : null)}
              hint={
                <>
                  Apps send <span className="mono">&quot;model&quot;: &quot;{typedName || route.alias}&quot;</span>. Renaming breaks apps that
                  use the old name.
                </>
              }
              mono
              spellCheck={false}
              autoComplete="off"
            />
            <TextField
              label="Description"
              value={draft.description}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              hint="Apps see it on GET /v1/models."
            />
          </div>
          <Switch
            checked={draft.enabled}
            onChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
            label="Enabled"
            description="A disabled model is left off /v1/models, and apps that send it get an error."
          />
        </Section>

        <div className={cx("savebar", dirty && "savebar--sticky")}>
          <Button variant="primary" type="submit" disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
          {dirty ? (
            <Button variant="secondary" onClick={() => setDraft(draftFrom(route))} disabled={saving}>
              Discard changes
            </Button>
          ) : null}
          <a className="btn btn--quiet" href={hrefFor("try", null, { model: route.alias })}>
            Open in Try it
          </a>
          <a className="btn btn--quiet" href={hrefFor("requests", null, { model: route.alias })}>
            View requests
          </a>
          <Button variant="quiet" className="savebar-end" onClick={() => setDeleteOpen(true)}>
            <Icon name="trash" size={14} />
            <span>Delete model</span>
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={deleteOpen}
        title={`Delete ${route.alias}?`}
        body={<p>Apps that send &ldquo;{route.alias}&rdquo; get a not-found error afterwards. The providers themselves are not changed.</p>}
        confirmLabel="Delete model"
        busy={deleting}
        error={deleteError}
        onConfirm={() => void remove()}
        onCancel={() => {
          setDeleteOpen(false);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

function StepEditor({
  step,
  index,
  routes,
  providers,
  issues,
  onChange,
}: {
  step: StepDraft;
  index: number;
  routes: readonly Route[];
  providers: Provider[];
  issues: StepIssues;
  onChange: (update: (step: StepDraft) => StepDraft) => void;
}) {
  const provider = providers.find((candidate) => candidate.id === step.providerId);
  const catalog = useCatalog(step.providerId || null);
  const options = useMemo(() => catalogOptions(catalog.models), [catalog.models]);
  const filter = useMemo(() => catalogFilter(catalog.models), [catalog.models]);
  const [testOpen, setTestOpen] = useState(false);
  const parsed = parsePrice(step.price);
  const resolved = effectivePrice(parsed.ok ? parsed.value : null, provider, step.model.trim(), catalog.models);
  const parsedOutput = parsePrice(step.outputPrice ?? "", "output");
  const resolvedOutput = effectiveOutputPrice(parsedOutput.ok ? parsedOutput.value : null, provider, step.model.trim(), catalog.models);
  const n = index + 1;

  const priceHint =
    step.price.trim().length > 0
      ? step.priceFromCatalog
        ? "Filled in from the catalog. Change it to use your own price."
        : "Your price. Clear it to use the default."
      : defaultPriceSentence(resolved);

  return (
    <div className="step-body">
      <p className="step-role">{stepRole(n)}</p>
      <div className="step-fields">
        <SelectField
          label="Provider"
          value={step.providerId}
          error={issues.provider}
          onChange={(event) => {
            const providerId = event.target.value;
            onChange((current) => ({ ...current, providerId }));
          }}
        >
          {step.providerId && !provider ? <option value={step.providerId}>Removed provider</option> : null}
          <option value="">Choose a provider</option>
          {providers.map((candidate) => {
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
          error={issues.model}
          placeholder={catalog.models[0]?.id ?? "the id this provider expects"}
          emptyText={catalog.models.length === 0 ? "This provider lists no models. Type the id it expects." : undefined}
          onChange={(text) => onChange((current) => ({ ...current, model: text }))}
          onPick={(option) =>
            onChange((current) =>
              pickUpstream(current, option.value, catalog.models.find((model) => model.id === option.value)?.price_per_m_input),
            )
          }
        />
        <TextField
          label="Price, USD per million input tokens"
          value={step.price}
          error={issues.price}
          inputMode="decimal"
          mono
          placeholder={resolved.price === null ? "unpriced" : String(resolved.price)}
          hint={priceHint}
          data-price=""
          onChange={(event) => {
            const price = event.target.value;
            onChange((current) => typePrice(current, price));
          }}
        />
        <TextField
          label="Price, USD per million output tokens"
          value={step.outputPrice ?? ""}
          error={issues.outputPrice}
          inputMode="decimal"
          mono
          placeholder={resolvedOutput.price === null ? "no output price" : String(resolvedOutput.price)}
          hint={(step.outputPrice ?? "").trim().length > 0 ? "Your output price. Clear it to use the default." : defaultOutputPriceSentence(resolvedOutput)}
          onChange={(event) => onChange((current) => ({ ...current, outputPrice: event.target.value }))}
        />
      </div>
      <Disclosure summary="Advanced" defaultOpen={Boolean(issues.timeout) || step.timeoutMs.trim().length > 0}>
        <div className="step-advanced">
          <TextField
            label="Timeout (ms)"
            value={step.timeoutMs}
            error={issues.timeout}
            inputMode="numeric"
            mono
            placeholder={provider ? String(provider.timeout_ms) : "Default"}
            hint={provider ? `Empty uses the provider's ${provider.timeout_ms} ms.` : "Empty uses the provider's timeout."}
            onChange={(event) => {
              const timeoutMs = event.target.value;
              onChange((current) => ({ ...current, timeoutMs }));
            }}
          />
        </div>
      </Disclosure>
      <div className="step-test">
        <Button
          variant="secondary"
          small
          onClick={() => setTestOpen((open) => !open)}
          disabled={!provider}
          aria-expanded={testOpen && !!provider}
        >
          <Icon name="bolt" size={14} />
          <span>Test step {n}</span>
        </Button>
        {testOpen && provider ? null : (
          <span className="field-hint">Choose the model to test, then run it with the provider&apos;s saved settings.</span>
        )}
      </div>
      {provider && testOpen ? (
        <div className="step-test-panel">
          {/* A new provider resets the test: its models and its result are its own. */}
          <ProviderTestPanel
            key={provider.id}
            provider={provider}
            entry={{ at: "step", model: step.model, routes }}
            providers={providers}
            lede={
              <>
                Sends one question with a known answer ({quoted(KNOWN_ANSWER.expected)}) straight to{" "}
                {connectionTitle(provider.name, provider.kind)}, using the model you pick and the provider&apos;s saved settings. You see that the
                model answers and that its answer makes sense.
              </>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
