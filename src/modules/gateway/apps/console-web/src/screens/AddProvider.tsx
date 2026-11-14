import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useApi } from "../app/api-context";
import { hrefFor } from "../app/router";
import { useResource } from "../app/hooks";
import { isApiError } from "../api/errors";
import type { Provider, ProviderPatch, ProviderTestResult } from "../api/types";
import {
  ADD_PROVIDER_STEPS,
  addProviderIssue,
  detailIssues,
  furthestProviderStep,
  keyIssues,
  openingStep,
  providerWrite,
  stepIndex,
  type AddProviderStepId,
} from "../domain/add-provider";
import { connectionTitle, keySummary, KIND_LABEL, REQUEST_FORMAT, replaceKeyLabel, suggestedEnvVar } from "../domain/connections";
import { parseModelHints, presetDraft, withBaseUrl, type ConnectionDraft, type ConnectionField, type KeyMode } from "../domain/connection-form";
import { formatPricePerM } from "../domain/cost";
import { formatContext } from "../domain/format";
import { isLocalHost } from "../domain/hosts";
import {
  NOT_VERIFIED,
  PRESETS,
  PRICES_AS_OF,
  hostOf,
  keySentence,
  kindUsesHints,
  presetById,
  presetPriceLine,
  presetVerification,
  providerVerification,
  usesDockerHost,
  type ProviderPreset,
} from "../domain/provider-presets";
import { isSecretMissing, pasteAdvice } from "../domain/secrets";
import { reveal } from "../motion/motion";
import { ConnectionFields, DOCKER_HOST_HINT } from "../ui/connection-fields";
import { Button, Segmented, TextField } from "../ui/controls";
import { cx } from "../ui/cx";
import { Disclosure } from "../ui/disclosure";
import { ErrorState, Flag, LoadingRows, Notice, PageHeader } from "../ui/feedback";
import { Icon } from "../ui/icons";
import { ProviderTestPanel } from "../ui/provider-test";
import { StationMark } from "../ui/status";
import { Stepper } from "../ui/stepper";
import { useNotify } from "../ui/toaster";

export function AddProviderScreen({ presetId }: { presetId: string | null }) {
  const api = useApi();
  const providers = useResource(() => api.listProviders(), []);
  // Whether the gateway can store a pasted key, read before the key step so its warning comes first.
  const health = useResource(() => api.health(), []);

  return (
    <div className="screen">
      <p className="crumb">
        <a href={hrefFor("providers")}>
          <Icon name="arrow-right" size={14} className="crumb-back" />
          <span>All providers</span>
        </a>
      </p>
      <PageHeader
        title="Add a provider"
        subtitle="Start from a preset. It fills in the address, the request format and where the key goes. You add a name and your key, then test it."
      />
      {providers.status === "loading" && !providers.data ? <LoadingRows rows={5} label="Loading providers" /> : null}
      {providers.status === "error" && !providers.data ? (
        <ErrorState error={providers.error} title="Providers did not load" onRetry={providers.reload} />
      ) : null}
      {providers.data ? (
        <AddProviderFlow providers={providers.data} secretConfigured={health.data?.secret_configured} initialPreset={presetById(presetId)} />
      ) : null}
    </div>
  );
}

const FLOW_TITLES: Record<AddProviderStepId, string> = {
  preset: "Where will decisions go?",
  details: "Check the details",
  key: "Add your key",
  test: "Test it with your key",
};

function AddProviderFlow({
  providers,
  secretConfigured,
  initialPreset,
}: {
  providers: Provider[];
  secretConfigured?: boolean;
  initialPreset: ProviderPreset | undefined;
}) {
  const api = useApi();
  const notify = useNotify();
  const taken = useMemo(() => providers.map((provider) => provider.name), [providers]);
  const [presetId, setPresetId] = useState<string | null>(initialPreset?.id ?? null);
  const [draft, setDraft] = useState<ConnectionDraft | null>(() => (initialPreset ? presetDraft(initialPreset, taken) : null));
  // While false, send_model follows the address (off for a local host), as the gateway's default does.
  const [sendModelChosen, setSendModelChosen] = useState(false);
  const [keyModeChosen, setKeyModeChosen] = useState(false);
  const [current, setCurrent] = useState(stepIndex(openingStep(initialPreset)));
  const [attempted, setAttempted] = useState(false);
  const [created, setCreated] = useState<Provider | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [secretMissing, setSecretMissing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const preset = presetById(presetId);
  const others = useMemo(() => taken.filter((name) => name !== created?.name), [taken, created]);
  const state = { presetId, draft, createdId: created?.id ?? null };
  const stepId = ADD_PROVIDER_STEPS[current]?.id ?? "preset";
  const issue = addProviderIssue(stepId, state, others);
  const reachable = furthestProviderStep(state, others);
  const advice = pasteAdvice(secretConfigured);
  // The key route the owner picked. Until they pick one, the gateway's secret decides, so a late health report still applies.
  const keyMode: KeyMode = draft && !keyModeChosen && draft.keyMode === "stored" && advice.envFirst ? "env" : (draft?.keyMode ?? "none");

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    reveal(panelRef.current);
    headingRef.current?.focus();
  }, [current]);

  const open = (index: number): void => {
    setAttempted(false);
    setCurrent(index);
  };

  const focusProblem = (): void => {
    panelRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  };

  const next = (event?: FormEvent<HTMLFormElement>): void => {
    event?.preventDefault();
    setAttempted(true);
    if (issue) {
      focusProblem();
      return;
    }
    open(Math.min(ADD_PROVIDER_STEPS.length - 1, current + 1));
  };

  const back = (): void => open(Math.max(0, current - 1));

  const choose = (id: string): void => {
    const chosen = presetById(id);
    if (!chosen || created) return;
    setPresetId(id);
    setDraft(presetDraft(chosen, taken));
    setSendModelChosen(false);
    setKeyModeChosen(false);
    setSecretMissing(false);
  };

  const update = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]): void => {
    setDraft((currentDraft) => (currentDraft ? { ...currentDraft, [key]: value } : currentDraft));
  };

  const saveKey = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!draft) return;
    const effective: ConnectionDraft = {
      ...draft,
      keyMode,
      envVar: draft.envVar.trim() || suggestedEnvVar({ kind: draft.kind, name: draft.name, key: { source: "none" } }),
    };
    setAttempted(true);
    if (Object.keys(keyIssues(effective, created)).length > 0) {
      focusProblem();
      return;
    }
    const write = providerWrite(effective, created);
    if (!write) return;
    setSaving(true);
    setSaveError(null);
    try {
      const patch: ProviderPatch = { ...write };
      if (created && effective.keyMode === "stored" && effective.secret.trim().length === 0) delete patch.key;
      const saved = created ? await api.updateProvider(created.id, patch) : await api.createProvider(write);
      setCreated(saved);
      setDraft({ ...effective, secret: "" });
      setSecretMissing(false);
      notify(created ? `Saved ${connectionTitle(saved.name, saved.kind)}.` : `Added ${connectionTitle(saved.name, saved.kind)}. Now test it.`);
      open(stepIndex("test"));
    } catch (caught) {
      if (isApiError(caught) && isSecretMissing(caught.code)) {
        setSecretMissing(true);
        setKeyModeChosen(true);
        setDraft({ ...effective, keyMode: "env", secret: "" });
      } else {
        setSaveError(caught);
      }
    } finally {
      setSaving(false);
    }
  };

  // The provider as the gateway now has it, so its last test (and verification) shows.
  const refresh = async (): Promise<void> => {
    if (!created) return;
    const list = await api.listProviders();
    const latest = list.find((provider) => provider.id === created.id);
    if (latest) setCreated(latest);
  };

  return (
    <div className="flow">
      <Stepper steps={ADD_PROVIDER_STEPS} current={current} reachable={reachable} onOpen={open} label="Add provider steps" />

      <div className="flow-grid">
        <div className="panel flow-panel" ref={panelRef}>
          <h2 className="flow-title" tabIndex={-1} ref={headingRef}>
            {stepId === "details" && preset ? `${preset.title}: ${FLOW_TITLES.details.toLowerCase()}` : FLOW_TITLES[stepId]}
          </h2>

          {stepId === "preset" ? (
            <PresetStep
              providers={providers}
              selected={presetId}
              locked={created !== null}
              onSelect={choose}
              error={attempted ? issue : null}
              onNext={next}
            />
          ) : null}

          {stepId === "details" && preset && draft ? (
            <DetailsStep
              preset={preset}
              draft={draft}
              errors={attempted ? detailIssues(draft, others) : {}}
              onChange={update}
              onBaseUrl={(baseUrl) =>
                setDraft((currentDraft) => (currentDraft ? withBaseUrl(currentDraft, baseUrl, sendModelChosen) : currentDraft))
              }
              onSendModel={(sendModel) => {
                setSendModelChosen(true);
                update("sendModel", sendModel);
              }}
              onNext={next}
              onBack={back}
            />
          ) : null}

          {stepId === "key" && preset && draft ? (
            <KeyStep
              preset={preset}
              draft={draft}
              mode={keyMode}
              created={created}
              secretConfigured={secretConfigured}
              secretMissing={secretMissing}
              errors={attempted ? keyIssues({ ...draft, keyMode }, created) : {}}
              saving={saving}
              error={saveError}
              onMode={(mode) => {
                setKeyModeChosen(true);
                update("keyMode", mode);
              }}
              onChange={update}
              onSave={(event) => void saveKey(event)}
              onBack={back}
            />
          ) : null}

          {stepId === "test" && preset && created ? <TestStep provider={created} onTested={refresh} onBack={back} /> : null}
        </div>

        <aside className="panel flow-aside" aria-label="The provider so far">
          <h2 className="flow-aside-title">So far</h2>
          <SoFar preset={preset} draft={draft} created={created} keyMode={keyMode} />
        </aside>
      </div>
    </div>
  );
}

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

function PresetStep({
  providers,
  selected,
  locked,
  onSelect,
  error,
  onNext,
}: {
  providers: Provider[];
  selected: string | null;
  /** True once the provider exists: its preset can no longer change. */
  locked: boolean;
  onSelect: (id: string) => void;
  error: string | null;
  onNext: (event?: FormEvent<HTMLFormElement>) => void;
}) {
  const chosen = presetById(selected);
  return (
    <form onSubmit={onNext} noValidate className="preset-form">
      <fieldset className="preset-group" disabled={locked}>
        <legend className="sr-only">Preset</legend>
        <div className="choice-cards preset-cards">
          {PRESETS.map((preset) => {
            const verification = presetVerification(preset, providers);
            return (
              <label key={preset.id} className={cx("choice-card preset-card", preset.id === selected && "is-selected")}>
                <input
                  type="radio"
                  name="preset"
                  value={preset.id}
                  checked={preset.id === selected}
                  onChange={() => onSelect(preset.id)}
                  className="choice-card-input"
                />
                <span className="choice-card-head">
                  <span className="choice-card-title">{preset.title}</span>
                </span>
                <span className="choice-card-meta preset-meta">
                  {KIND_LABEL[preset.kind]} · <span className="mono">{hostOf(preset.baseUrl)}</span>
                </span>
                <span className="choice-card-body">{preset.pick}</span>
                <span className="choice-card-foot">{presetPriceLine(preset)}</span>
                {verification ? (
                  <span className={cx("preset-verification", verification.verified && "is-verified")}>
                    {verification.verified ? <StationMark status="ok" size={10} /> : <span className="chip-dot" aria-hidden="true" />}
                    <span>{verification.text}</span>
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </fieldset>
      {error ? (
        <p className="field-error" role="alert">
          <Icon name="warning" size={14} />
          <span>{error}</span>
        </p>
      ) : null}
      <p className="field-hint">
        Presets marked &ldquo;{NOT_VERIFIED}&rdquo; come from the vendor&apos;s public docs as of {PRICES_AS_OF}. They keep that mark until a
        provider made from one passes a test.
      </p>
      <FlowActions>
        <Button variant="primary" type="submit">
          {chosen ? `Continue with ${chosen.title}` : "Continue"}
        </Button>
      </FlowActions>
    </form>
  );
}

/** A URL that may wrap after each slash rather than in the middle of a word. */
function BreakableUrl({ text }: { text: string }) {
  return (
    <>
      {text.split("/").map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <>
              /<wbr />
            </>
          ) : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function Fact({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "preset-fact-wide" : undefined}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function DetailsStep({
  preset,
  draft,
  errors,
  onChange,
  onBaseUrl,
  onSendModel,
  onNext,
  onBack,
}: {
  preset: ProviderPreset;
  draft: ConnectionDraft;
  errors: Partial<Record<ConnectionField, string>>;
  onChange: <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => void;
  onBaseUrl: (baseUrl: string) => void;
  onSendModel: (sendModel: boolean) => void;
  onNext: (event?: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}) {
  const custom = preset.baseUrl === "";
  const local = isLocalHost(draft.baseUrl);
  const dockerHint = usesDockerHost(draft.baseUrl) ? DOCKER_HOST_HINT : undefined;
  const baseUrlHint = custom
    ? "When the gateway runs in Docker, use host.docker.internal rather than localhost for a server on this machine. Inside a container, localhost is the container itself."
    : dockerHint;
  const advancedOpen = Object.keys(errors).some((field) => field !== "name" && !(custom && field === "baseUrl"));
  return (
    <form onSubmit={onNext} noValidate>
      <p className="flow-lede">
        {preset.pick}{" "}
        {preset.docs ? <a href={preset.docs} target="_blank" rel="noreferrer">{preset.title} docs</a> : null}
      </p>
      {!preset.verified ? (
        <Notice tone="info" title={NOT_VERIFIED}>
          {preset.wire === "chat" ? "Chat models differ in which methods they support. Run the known-answer test to check the configured methods before you route traffic here." : <>These values come from {preset.title}&apos;s public docs as of {PRICES_AS_OF}. Nobody has run them with a real key yet, so the test after the key step is the first proof that they work.</>}
        </Notice>
      ) : null}
      {preset.note ? <p className="field-hint preset-note">{preset.note}</p> : null}

      <div className="form-grid">
        <TextField
          label="Name"
          value={draft.name}
          onChange={(event) => onChange("name", event.target.value)}
          error={errors.name}
          hint="Unique and lowercase. Models, logs and requests show this name."
          mono
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
        {custom ? (
          <TextField
            label="Base URL"
            value={draft.baseUrl}
            onChange={(event) => onBaseUrl(event.target.value)}
            error={errors.baseUrl}
            hint={baseUrlHint}
            placeholder="https://decisions.example.com"
            mono
            spellCheck={false}
            inputMode="url"
            autoComplete="off"
          />
        ) : null}
      </div>

      <dl className="facts preset-facts">
        <Fact label="Address" wide>
          <span className="mono">
            <BreakableUrl text={`${draft.baseUrl || "your base URL"}${draft.path}`} />
          </span>
          {dockerHint && !custom ? <span className="preset-fact-note">{dockerHint}</span> : null}
        </Fact>
        <Fact label="Kind">{KIND_LABEL[draft.kind]}</Fact>
        <Fact label="Request format">{REQUEST_FORMAT[draft.wire].label}</Fact>
        <Fact label="Model id in requests">
          {draft.wire === "openai"
            ? "Always sent"
            : draft.sendModel
              ? "Sent"
              : `Not sent${local ? ": a local server serves the model it loaded" : ""}`}
        </Fact>
        <Fact label="Key goes in">
          <span className="mono">{draft.authHeader === "authorization" ? "Authorization: Bearer …" : `${draft.authHeader}: …`}</span>
        </Fact>
        <Fact label="Key">
          {preset.key === "none" ? "None needed" : preset.key === "optional" ? "Optional" : "Required"}
          {preset.envVar ? <span className="mono preset-fact-env"> · {preset.envVar}</span> : null}
        </Fact>
      </dl>

      <PresetModels preset={preset} draft={draft} />

      <Disclosure summary="Advanced: change any of these" className="conn-advanced" defaultOpen={advancedOpen}>
        <div className="conn-form">
          <ConnectionFields
            draft={draft}
            errors={errors}
            onChange={onChange}
            onBaseUrl={onBaseUrl}
            onSendModel={onSendModel}
            baseUrlHint={baseUrlHint}
            showBaseUrl={!custom}
          />
        </div>
      </Disclosure>

      <FlowActions onBack={onBack}>
        <Button variant="primary" type="submit">
          Continue
        </Button>
      </FlowActions>
    </form>
  );
}

/** The models the preset suggests, with list prices; or where the provider's models come from instead. */
function PresetModels({ preset, draft }: { preset: ProviderPreset; draft: ConnectionDraft }) {
  if (!kindUsesHints(draft.kind)) {
    if (draft.kind === "openrouter") {
      return <p className="field-hint">Models and prices come from OpenRouter&apos;s live catalog once it is added.</p>;
    }
    const hint = preset.hints[0];
    if (!hint) return null;
    return (
      <p className="field-hint">
        Model <span className="mono">{hint.id}</span>, {hint.price === undefined ? "no list price" : formatPricePerM(hint.price)} as of{" "}
        {PRICES_AS_OF}. The gateway prices it from its built-in table.
      </p>
    );
  }
  const parsed = parseModelHints(draft.modelHints);
  if (!parsed.ok) return null;
  if (parsed.value.length === 0) {
    if (draft.kind === "systemone") {
      return (
        <p className="field-hint">
          No suggested models. Type the model id when you add a model, or list the server&apos;s models under Advanced as model hints.
        </p>
      );
    }
    return <p className="field-hint">The server lists its own models once it is added (GET /v1/models).</p>;
  }
  return (
    <div className="preset-models">
      <table className="sheet preset-models-table">
        <caption className="preset-models-caption">
          Suggested models. List prices in USD per million input tokens as of {PRICES_AS_OF}: from the vendor&apos;s docs, or from
          OpenRouter&apos;s catalog where marked unverified. Your account may pay a different price.
        </caption>
        <thead>
          <tr>
            <th scope="col">Model id, as requests send it</th>
            <th scope="col" className="num">
              Price
            </th>
            <th scope="col" className="num">
              Output price
            </th>
            <th scope="col" className="num">
              Context
            </th>
          </tr>
        </thead>
        <tbody>
          {parsed.value.map((hint) => (
            <tr key={hint.id}>
              <th scope="row">
                <span className="mono preset-models-id">{hint.id}</span>
                {hint.description ? <span className="preset-models-about">{hint.description}</span> : null}
              </th>
              <td className="num mono">{hint.price_per_m_input === undefined ? "—" : formatPricePerM(hint.price_per_m_input)}</td>
              <td className="num mono">{hint.price_per_m_output === undefined ? "—" : formatPricePerM(hint.price_per_m_output, "output")}</td>
              <td className="num mono">{hint.context === undefined ? "—" : formatContext(hint.context)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const KEY_LABELS: Record<KeyMode, string> = { stored: "Paste the key", env: "Environment variable", none: "No key" };

function KeyStep({
  preset,
  draft,
  mode,
  created,
  secretConfigured,
  secretMissing,
  errors,
  saving,
  error,
  onMode,
  onChange,
  onSave,
  onBack,
}: {
  preset: ProviderPreset;
  draft: ConnectionDraft;
  mode: KeyMode;
  created: Provider | null;
  secretConfigured?: boolean;
  secretMissing: boolean;
  errors: Partial<Record<ConnectionField, string>>;
  saving: boolean;
  error: unknown;
  onMode: (mode: KeyMode) => void;
  onChange: <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}) {
  const advice = pasteAdvice(secretConfigured);
  const modes: KeyMode[] = preset.key === "required" ? ["stored", "env"] : ["none", "stored", "env"];
  const envPlaceholder = suggestedEnvVar({ kind: draft.kind, name: draft.name, key: { source: "none" } });
  const storedKey = created?.key.source === "stored" ? created.key : null;
  const keptKey = storedKey !== null && mode === "stored";
  return (
    <form onSubmit={onSave} noValidate>
      <p className="flow-lede">{keySentence(preset)}</p>
      <div className="field">
        <div className="field-label">
          <span>Where the key comes from</span>
        </div>
        <Segmented
          label="Where the key comes from"
          options={modes.map((value) => ({ value, label: KEY_LABELS[value] }))}
          value={mode}
          onChange={onMode}
        />
      </div>

      {mode === "stored" ? (
        <>
          {advice.warning && !secretMissing ? (
            <Notice tone="warn" title={advice.warning.title}>
              <p>{advice.warning.body}</p>
            </Notice>
          ) : null}
          <TextField
            label={keptKey ? replaceKeyLabel(storedKey.last4) : `Paste your ${preset.title} key`}
            type="password"
            value={draft.secret}
            onChange={(event) => onChange("secret", event.target.value)}
            error={errors.secret}
            hint={
              keptKey
                ? "Leave it empty to keep the stored key."
                : "Stored encrypted by the gateway. It is never shown again; you will see at most its last four characters."
            }
            mono
            spellCheck={false}
            autoComplete="off"
            className="field--narrow-wide"
          />
        </>
      ) : null}

      {mode === "env" ? (
        <>
          {secretMissing ? (
            <Notice tone="warn" title="This gateway can't store keys yet">
              <p>
                Stored keys are encrypted with <span className="mono">GATEWAY_SECRET</span>, and the gateway was started without it. Keep the
                key in an environment variable instead, or set <span className="mono">GATEWAY_SECRET</span>, restart the gateway, and paste the
                key.
              </p>
            </Notice>
          ) : null}
          <TextField
            label="Environment variable on the gateway host"
            value={draft.envVar}
            placeholder={envPlaceholder}
            onChange={(event) => onChange("envVar", event.target.value)}
            error={errors.envVar}
            hint={
              <>
                The gateway reads it when it sends a request; the console never sees its value. Set it in <span className="mono">.env</span>{" "}
                next to compose.yaml and restart the gateway.
              </>
            }
            mono
            spellCheck={false}
            autoComplete="off"
            className="field--narrow-wide"
          />
        </>
      ) : null}

      {mode === "none" ? <p className="field-hint">No key is sent. Choose another option if the server was started with one.</p> : null}

      {error ? <ErrorState error={error} title={created ? "The provider was not saved" : "The provider was not added"} /> : null}

      <FlowActions onBack={onBack}>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : created ? "Save and test" : "Add provider and test"}
        </Button>
      </FlowActions>
    </form>
  );
}

function TestStep({ provider, onTested, onBack }: { provider: Provider; onTested: () => Promise<void>; onBack: () => void }) {
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const verification = providerVerification(provider.last_test);
  const title = connectionTitle(provider.name, provider.kind);

  return (
    <div>
      <p className="flow-lede">{title} is saved. One test checks the address, the request format and your key together.</p>
      {/* A new provider has no models yet, so no model of yours can lend it one: the picker opens on the gateway's choice. */}
      <ProviderTestPanel provider={provider} entry={{ at: "new" }} onResult={setResult} onTested={() => void onTested()} />

      <p className="flow-verification">
        <Flag tone={verification.verified ? "ok" : "info"}>{verification.text}</Flag>
      </p>
      {result && !result.ok ? (
        <p className="field-hint">
          Check the key, the address and the model id. Go back to change them, or edit them later under Advanced on the provider&apos;s card.
        </p>
      ) : null}

      <FlowActions onBack={onBack}>
        <a
          className={cx("btn", verification.verified ? "btn--primary" : "btn--secondary")}
          href={hrefFor("models", "new", { connection: provider.id })}
        >
          Add a model with {title}
        </a>
        <a className="btn btn--quiet" href={hrefFor("providers", provider.id)}>
          View the provider
        </a>
      </FlowActions>
    </div>
  );
}

function SoFar({
  preset,
  draft,
  created,
  keyMode,
}: {
  preset: ProviderPreset | undefined;
  draft: ConnectionDraft | null;
  created: Provider | null;
  keyMode: KeyMode;
}) {
  if (!preset || !draft) return <p className="flow-aside-sentence">Choose a preset to begin.</p>;
  const verification = created ? providerVerification(created.last_test) : null;
  const planned =
    keyMode === "none"
      ? "No key"
      : keyMode === "env"
        ? draft.envVar.trim() || "an environment variable"
        : draft.secret
          ? "A pasted key"
          : "A key you paste";
  const key = created ? keySummary(created) : planned;
  return (
    <>
      <p className="flow-aside-name">
        <span className="flow-aside-label">Preset</span>
        <span>{preset.title}</span>
      </p>
      <p className="flow-aside-name">
        <span className="flow-aside-label">Apps can call</span>
        <span className="mono">{draft.name.trim() ? `${draft.name.trim()}::<model>` : "a name you choose"}</span>
      </p>
      <p className="flow-aside-name">
        <span className="flow-aside-label">Calls</span>
        <span className="mono flow-aside-url">
          <BreakableUrl text={`${draft.baseUrl || "your base URL"}${draft.path}`} />
        </span>
      </p>
      <p className="flow-aside-name">
        <span className="flow-aside-label">Key</span>
        <span className={cx(!created && keyMode === "env" && "mono")}>{key}</span>
      </p>
      <p className="flow-aside-sentence">
        {verification ? (
          <Flag tone={verification.verified ? "ok" : "info"}>{verification.text}</Flag>
        ) : (
          "Not added yet. The key step adds it."
        )}
      </p>
    </>
  );
}
