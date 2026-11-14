import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useApi } from "../app/api-context";
import { hrefFor } from "../app/router";
import { useResource } from "../app/hooks";
import type { Settings } from "../api/types";
import { chainSentence, routeChain } from "../domain/chain";
import { Button, SelectField, Switch } from "../ui/controls";
import { cx } from "../ui/cx";
import { ErrorState, Flag, LoadingRows, Notice, PageHeader, Section } from "../ui/feedback";
import { useNotify } from "../ui/toaster";

export function SettingsScreen() {
  const api = useApi();
  const notify = useNotify();
  const settings = useResource(() => api.getSettings(), []);
  const routes = useResource(() => api.listRoutes(), []);
  const providers = useResource(() => api.listProviders(), []);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const dirty = useMemo(
    () =>
      draft && settings.data
        ? draft.capture_payloads !== settings.data.capture_payloads || draft.default_route !== settings.data.default_route
        : false,
    [draft, settings.data],
  );

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateSettings({ capture_payloads: draft.capture_payloads, default_route: draft.default_route });
      settings.setData(() => updated);
      notify("Settings saved.");
    } catch (caught) {
      setSaveError(caught);
    } finally {
      setSaving(false);
    }
  };

  const models = routes.data ?? [];
  const aliases = models.map((route) => route.alias);
  const defaultMissing = draft !== null && draft.default_route.length > 0 && routes.data !== undefined && !aliases.includes(draft.default_route);
  const chosen = models.find((route) => route.alias === draft?.default_route);

  return (
    <div className="screen">
      <PageHeader
        title="Settings"
        subtitle={
          <>
            How the gateway behaves for every request. Client keys moved to <a href={hrefFor("keys")}>Keys</a>.
          </>
        }
      />

      {settings.status === "loading" && !draft ? <LoadingRows rows={3} label="Loading settings" /> : null}
      {settings.status === "error" && !draft ? (
        <ErrorState error={settings.error} title="Settings did not load" onRetry={settings.reload} />
      ) : null}

      {draft ? (
        <form onSubmit={(event) => void save(event)} noValidate className="form-stack">
          {saveError ? <ErrorState error={saveError} title="Settings were not saved" /> : null}

          <Section variant="panel" title="Capture payloads" id="payloads">
            <Switch
              checked={draft.capture_payloads}
              onChange={(checked) => setDraft({ ...draft, capture_payloads: checked })}
              label="Store each request and response body"
              description="Useful when a request fails and you need to see exactly what was sent. Turn it off to keep only status, latency, attempts, tokens and cost."
            />
            <Notice
              tone={draft.capture_payloads ? "warn" : "info"}
              title={draft.capture_payloads ? "Bodies are being stored" : "Bodies are not stored"}
            >
              Captured bodies include the full input text and every question, which can hold personal or confidential data. They are kept in the
              gateway&rsquo;s database, where anyone with the admin token can read them.
            </Notice>
          </Section>

          <Section variant="panel" title="Default model" id="default-model">
            <SelectField
              label="Model for requests that name none"
              value={draft.default_route}
              onChange={(event) => setDraft({ ...draft, default_route: event.target.value })}
              hint={
                defaultMissing ? (
                  <Flag tone="error">There is no model named &ldquo;{draft.default_route}&rdquo;</Flag>
                ) : chosen ? (
                  <>
                    A request without <span className="mono">model</span> goes to {chosen.alias}:{" "}
                    {chainSentence(routeChain(chosen.targets, providers.data ?? []))}.
                  </>
                ) : (
                  <>
                    A request without <span className="mono">model</span> uses this model.
                  </>
                )
              }
            >
              {defaultMissing ? <option value={draft.default_route}>{draft.default_route} (missing)</option> : null}
              {aliases.map((alias) => (
                <option key={alias} value={alias}>
                  {alias}
                </option>
              ))}
            </SelectField>
          </Section>

          <div className={cx("savebar", dirty && "savebar--sticky")}>
            <Button variant="primary" type="submit" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
            {dirty ? (
              <Button variant="secondary" onClick={() => setDraft(settings.data ?? null)} disabled={saving}>
                Discard changes
              </Button>
            ) : null}
            {dirty ? <Flag tone="warn">Unsaved changes</Flag> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
