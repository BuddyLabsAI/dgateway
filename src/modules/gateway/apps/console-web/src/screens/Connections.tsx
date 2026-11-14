import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useApi } from "../app/api-context";
import { hrefFor } from "../app/router";
import { useNow, useResource } from "../app/hooks";
import { isApiError } from "../api/errors";
import type { Provider, ProviderKind, ProviderPatch, Route } from "../api/types";
import {
  CONNECTION_MARK,
  CONNECTION_WORD,
  KIND_LABEL,
  KIND_SENTENCE,
  connectionStatus,
  connectionTitle,
  keySummary,
  lastTestSummary,
  modelsUsing,
  replaceKeyLabel,
  wireTag,
} from "../domain/connections";
import { connectionDraft, validateConnection, type ConnectionDraft, type ConnectionField, type KeyMode } from "../domain/connection-form";
import { presetForProvider, providerVerification, usesDockerHost } from "../domain/provider-presets";
import { CatalogList, useCatalog } from "../ui/catalog";
import { ConnectionFields, DOCKER_HOST_HINT } from "../ui/connection-fields";
import { Button, Segmented, SelectField, Switch, TextField } from "../ui/controls";
import { cx } from "../ui/cx";
import { ConfirmDialog } from "../ui/dialog";
import { Disclosure } from "../ui/disclosure";
import { EmptyState, ErrorState, Flag, LoadingRows, PageHeader, describeError } from "../ui/feedback";
import { Icon } from "../ui/icons";
import { KeyEntry } from "../ui/key-entry";
import { ProviderTestPanel } from "../ui/provider-test";
import { StatusChip } from "../ui/status";
import { useNotify } from "../ui/toaster";

const KIND_OPTIONS: ProviderKind[] = ["openai-compatible", "openai", "openrouter", "systemone", "mock"];

const KEY_OPTIONS: { value: KeyMode; label: string }[] = [
  { value: "stored", label: "Stored key" },
  { value: "env", label: "Environment variable" },
  { value: "none", label: "No key" },
];

const KEY_HELP: Record<KeyMode, string> = {
  env: "The gateway reads this environment variable on its host when it sends a request. The console never sees its value.",
  stored: "The gateway encrypts the key in its database (this needs GATEWAY_SECRET). Afterwards only its last four characters are shown.",
  none: "No key is sent with requests to this provider.",
};

export function ConnectionsScreen({ focusId }: { focusId: string | null }) {
  const api = useApi();
  const providers = useResource(() => api.listProviders(), []);
  const routes = useResource(() => api.listRoutes(), []);
  // Whether the gateway can store a pasted key, read before any paste so the warning comes first.
  const health = useResource(() => api.health(), []);

  const replace = (updated: Provider): void =>
    providers.setData((current) => current?.map((provider) => (provider.id === updated.id ? updated : provider)));

  return (
    <div className="screen">
      <PageHeader
        title="Providers"
        subtitle="Where decisions are sent: a provider account, a server you run, or the built-in mock. Each one needs to be connected before a model can use it."
        actions={
          <a className="btn btn--secondary btn--small" href={hrefFor("providers", "new")}>
            <Icon name="plus" size={14} />
            <span>Add provider</span>
          </a>
        }
      />

      {providers.status === "loading" && !providers.data ? <LoadingRows rows={5} label="Loading providers" /> : null}
      {providers.status === "error" && !providers.data ? (
        <ErrorState error={providers.error} title="Providers did not load" onRetry={providers.reload} />
      ) : null}
      {providers.data && providers.data.length === 0 ? (
        <EmptyState title="No providers yet">Add one so models have somewhere to send decisions.</EmptyState>
      ) : null}

      {providers.data && providers.data.length > 0 ? (
        <ul className="conn-list">
          {providers.data.map((provider) => (
            <ConnectionCard
              key={provider.id}
              provider={provider}
              providers={providers.data ?? []}
              routes={routes.data ?? []}
              focused={provider.id === focusId}
              secretConfigured={health.data?.secret_configured}
              onChanged={replace}
              onReload={providers.reload}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ConnectionCard({
  provider,
  providers,
  routes,
  focused,
  secretConfigured,
  onChanged,
  onReload,
}: {
  provider: Provider;
  providers: Provider[];
  routes: Route[];
  focused: boolean;
  /** From the health report: false means the gateway cannot store a pasted key. */
  secretConfigured?: boolean;
  onChanged: (provider: Provider) => void;
  onReload: () => void;
}) {
  const api = useApi();
  const notify = useNotify();
  const now = useNow(30_000);
  const status = connectionStatus(provider);
  const title = connectionTitle(provider.name, provider.kind);
  const [keyOpen, setKeyOpen] = useState(focused && status === "needs-key");
  const [browseOpen, setBrowseOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [toggling, setToggling] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const used = modelsUsing(provider.id, routes);
  const last = lastTestSummary(provider.last_test, now);
  const verification = provider.kind === "mock" ? null : providerVerification(provider.last_test);
  const preset = presetForProvider(provider);
  const tag = wireTag(provider);
  const hasKey = provider.key.source === "stored" || (provider.key.source === "env" && provider.key.present);

  useEffect(() => {
    if (!focused) return;
    cardRef.current?.scrollIntoView({ block: "start" });
    cardRef.current?.focus({ preventScroll: true });
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setEnabled = async (enabled: boolean): Promise<void> => {
    setToggling(true);
    try {
      onChanged(await api.updateProvider(provider.id, { enabled }));
      notify(enabled ? `Turned on ${title}.` : `Turned off ${title}. Models skip it until it is on again.`);
    } catch (caught) {
      notify(describeError(caught), "error");
    } finally {
      setToggling(false);
    }
  };

  return (
    <li>
      <article
        className={cx("panel conn-card", status === "disabled" && "conn-card--off")}
        ref={cardRef}
        tabIndex={-1}
        aria-labelledby={`conn-${provider.id}-title`}
      >
        <header className="conn-head">
          <div className="conn-head-text">
            <h2 id={`conn-${provider.id}-title`} className="conn-title">
              {title}
            </h2>
            <p className="conn-meta">
              {provider.kind === "mock" ? (
                "Built in. Free deterministic answers for trying the API."
              ) : (
                <>
                  {preset && preset.title !== title
                    ? `${preset.title} · `
                    : KIND_LABEL[provider.kind] !== title
                      ? `${KIND_LABEL[provider.kind]} · `
                      : null}
                  <span className="mono conn-url">{provider.base_url}</span>
                </>
              )}
            </p>
          </div>
          <div className="conn-head-chips">
            {tag ? (
              <span title={tag.title}>
                <Flag tone="info" className={cx("conn-wire", tag.text === "Synthetic" && "conn-wire--synthetic")}>
                  {tag.text}
                </Flag>
              </span>
            ) : null}
            {verification ? (
              <Flag tone={verification.verified ? "ok" : "info"} className="conn-verified">
                {verification.text}
              </Flag>
            ) : null}
            <StatusChip status={CONNECTION_MARK[status]}>{CONNECTION_WORD[status]}</StatusChip>
          </div>
        </header>

        <dl className="conn-facts">
          <div>
            <dt>Key</dt>
            <dd className={cx(status === "needs-key" && "is-alert")}>{keySummary(provider)}</dd>
          </div>
          <div>
            <dt>Last test</dt>
            <dd className={cx("last-test", last.status === "failing" && "is-alert", last.status === "degraded" && "is-warn")}>
              {last.mark ? (
                <span className={`verdict-mark verdict-mark--${last.status ?? "ok"}`} aria-hidden="true">
                  {last.mark}
                </span>
              ) : null}
              <span>{last.text}</span>
            </dd>
          </div>
          <div>
            <dt>Used by</dt>
            <dd className="conn-used">
              {used.length === 0 ? (
                <span className="muted">No model yet</span>
              ) : (
                used.map((route, index) => (
                  <span key={route.id}>
                    {index > 0 ? ", " : ""}
                    <a href={hrefFor("models", route.id)} className="mono">
                      {route.alias}
                    </a>
                  </span>
                ))
              )}
            </dd>
          </div>
        </dl>

        <div className="conn-actions">
          {status === "needs-key" ? (
            <Button variant="primary" small onClick={() => setKeyOpen((open) => !open)} aria-expanded={keyOpen}>
              <Icon name="key" size={14} />
              <span>Connect</span>
            </Button>
          ) : null}
          {status === "disabled" ? (
            <Button variant="primary" small onClick={() => void setEnabled(true)} disabled={toggling}>
              {toggling ? "Turning on…" : "Turn on"}
            </Button>
          ) : null}
          <Button variant="secondary" small onClick={() => setTestOpen((open) => !open)} aria-expanded={testOpen}>
            <Icon name="bolt" size={14} />
            <span>Test</span>
          </Button>
          <Button variant="secondary" small onClick={() => setBrowseOpen((open) => !open)} aria-expanded={browseOpen}>
            <Icon name="table" size={14} />
            <span>{browseOpen ? "Hide models" : "Browse models"}</span>
          </Button>
          <a className="btn btn--quiet btn--small" href={hrefFor("models", "new", { connection: provider.id })}>
            <Icon name="plus" size={14} />
            <span>Add a model with this</span>
          </a>
          {status !== "needs-key" && hasKey ? (
            <Button variant="quiet" small onClick={() => setKeyOpen((open) => !open)} aria-expanded={keyOpen} className="conn-actions-end">
              Replace key
            </Button>
          ) : null}
        </div>

        {keyOpen ? (
          <div className="conn-section">
            <KeyEntry
              provider={provider}
              replacing={hasKey}
              secretConfigured={secretConfigured}
              onSaved={(updated) => {
                onChanged(updated);
                if (connectionStatus(updated) === "connected") setKeyOpen(false);
              }}
            />
          </div>
        ) : null}

        {testOpen ? (
          <div className="conn-section">
            {/* The gateway records each test as last_test, so the list is read back after one. */}
            <ProviderTestPanel provider={provider} entry={{ at: "card", routes }} providers={providers} onTested={onReload} />
          </div>
        ) : null}

        {browseOpen ? (
          <div className="conn-section">
            <BrowseModels provider={provider} />
          </div>
        ) : null}

        <Disclosure summary="Advanced" className="conn-advanced">
          <ConnectionForm provider={provider} onSaved={onChanged} onDeleted={onReload} />
        </Disclosure>
      </article>
    </li>
  );
}

function BrowseModels({ provider }: { provider: Provider }) {
  const catalog = useCatalog(provider.id);
  return (
    <CatalogList
      catalog={catalog}
      suggested={(provider.model_hints?.length ?? 0) > 0}
      onPick={() => undefined}
      rowAction={(model) => (
        <a
          className="btn btn--secondary btn--small"
          href={hrefFor("models", "new", { connection: provider.id, upstream: model.id })}
          aria-label={`Add a model with ${model.id}`}
        >
          Add model
        </a>
      )}
      emptyHint="This provider lists no models. Add a model and type the id it expects."
    />
  );
}

function ConnectionForm({
  provider,
  onSaved,
  onDeleted,
}: {
  provider: Provider;
  onSaved: (provider: Provider) => void;
  onDeleted?: () => void;
}) {
  const api = useApi();
  const notify = useNotify();
  const [draft, setDraft] = useState<ConnectionDraft>(() => connectionDraft(provider));
  const [errors, setErrors] = useState<Partial<Record<ConnectionField, string>>>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const baseline = useMemo(() => JSON.stringify(connectionDraft(provider)), [provider]);
  const dirty = JSON.stringify(draft) !== baseline;

  useEffect(() => {
    // A saved change elsewhere on the card (a key, the switch) resets the form to match.
    if (!dirty) setDraft(connectionDraft(provider));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const update = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key as ConnectionField];
      return next;
    });
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const result = validateConnection(draft, provider);
    setErrors(result.errors);
    setFormError(null);
    if (!result.write) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    setSaving(true);
    try {
      const patch: ProviderPatch = { ...result.write };
      if (draft.keyMode === "stored" && draft.secret.trim().length === 0 && provider.key.source === "stored") delete patch.key;
      const saved = await api.updateProvider(provider.id, patch);
      notify(`Saved ${connectionTitle(saved.name, saved.kind)}.`);
      setDraft(connectionDraft(saved));
      onSaved(saved);
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
      await api.deleteProvider(provider.id);
      notify(`Deleted ${connectionTitle(provider.name, provider.kind)}.`);
      setDeleteOpen(false);
      onDeleted?.();
    } catch (error) {
      setDeleteError(error);
    } finally {
      setDeleting(false);
    }
  };

  const blocked = isApiError(deleteError) && deleteError.status === 409;

  return (
    <>
      <form ref={formRef} onSubmit={(event) => void save(event)} noValidate className="conn-form">
        {formError ? <ErrorState error={formError} title="The provider was not saved" /> : null}

        <div className="form-grid">
          <TextField
            label="Name"
            value={draft.name}
            onChange={(event) => update("name", event.target.value)}
            error={errors.name}
            hint="Unique and lowercase. Logs and requests show this name."
            mono
            spellCheck={false}
            autoComplete="off"
          />
          <SelectField
            label="Kind"
            value={draft.kind}
            onChange={(event) => update("kind", event.target.value as ProviderKind)}
            hint={KIND_SENTENCE[draft.kind]}
          >
            {KIND_OPTIONS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </SelectField>
        </div>

        <ConnectionFields
          draft={draft}
          errors={errors}
          onChange={update}
          baseUrlHint={usesDockerHost(draft.baseUrl) ? DOCKER_HOST_HINT : undefined}
        />

        <div className="field">
          <div className="field-label">
            <span>Key source</span>
          </div>
          <Segmented label="Key source" options={KEY_OPTIONS} value={draft.keyMode} onChange={(value) => update("keyMode", value)} />
          <p className="field-hint">{KEY_HELP[draft.keyMode]}</p>
        </div>
        {draft.keyMode === "env" ? (
          <TextField
            label="Environment variable"
            value={draft.envVar}
            onChange={(event) => update("envVar", event.target.value)}
            error={errors.envVar}
            mono
            spellCheck={false}
            autoComplete="off"
            accessory={
              provider.key.source === "env" ? (
                provider.key.present ? (
                  <Flag tone="ok">Set on the host</Flag>
                ) : (
                  <Flag tone="error">Not set on the host</Flag>
                )
              ) : null
            }
          />
        ) : null}
        {draft.keyMode === "stored" ? (
          <TextField
            label={provider.key.source === "stored" ? replaceKeyLabel(provider.key.last4) : "Key"}
            type="password"
            value={draft.secret}
            onChange={(event) => update("secret", event.target.value)}
            error={errors.secret}
            autoComplete="off"
            spellCheck={false}
            mono
            hint={provider.key.source === "stored" ? "Leave it empty to keep the stored key." : "Saved encrypted. It is never shown again."}
          />
        ) : null}

        <Switch
          checked={draft.enabled}
          onChange={(checked) => update("enabled", checked)}
          label="Enabled"
          description="A disabled provider is skipped by every model that uses it."
        />

        <div className="conn-form-actions">
          <Button variant="primary" type="submit" disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
          {dirty ? (
            <Button variant="secondary" onClick={() => setDraft(connectionDraft(provider))} disabled={saving}>
              Discard changes
            </Button>
          ) : null}
          {dirty ? <Flag tone="warn">Unsaved changes</Flag> : null}
          <Button variant="quiet" className="savebar-end" onClick={() => setDeleteOpen(true)}>
            <Icon name="trash" size={14} />
            <span>Delete provider</span>
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={deleteOpen}
        title={`Delete ${connectionTitle(provider.name, provider.kind)}?`}
        body={
          blocked ? (
            <>
              <p>{describeError(deleteError)}</p>
              {isApiError(deleteError) && deleteError.routes && deleteError.routes.length > 0 ? (
                <ul aria-label="Models that still use this provider">
                  {deleteError.routes.map((route) => (
                    <li key={route.id}>
                      <a href={hrefFor("models", route.id)}>{route.alias}</a>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p>Remove it from those models first, then delete it again.</p>
            </>
          ) : (
            <p>Models that still use it must be changed first. Its key reference is removed with it.</p>
          )
        }
        confirmLabel="Delete provider"
        busy={deleting}
        error={deleteError && !blocked ? deleteError : null}
        onConfirm={() => void remove()}
        onCancel={() => {
          setDeleteOpen(false);
          setDeleteError(null);
        }}
      />
    </>
  );
}
