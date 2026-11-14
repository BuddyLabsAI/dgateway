import { useState, type FormEvent } from "react";
import { useApi } from "../app/api-context";
import { useNow, useResource, type Resource } from "../app/hooks";
import type { ClientKey, CreatedClientKey } from "../api/types";
import { formatRelative } from "../domain/format";
import { Button, Switch, TextField } from "../ui/controls";
import { ConfirmDialog, Dialog } from "../ui/dialog";
import { CopyButton } from "../ui/disclosure";
import { EmptyState, ErrorState, Flag, LoadingRows, Notice, PageHeader, Section, describeError } from "../ui/feedback";
import { useNotify } from "../ui/toaster";

export function KeysScreen() {
  const now = useNow(30_000);
  const api = useApi();
  const clients = useResource(() => api.listClients(), []);
  return (
    <div className="screen">
      <PageHeader
        title="Keys"
        subtitle="Client keys let your apps prove who they are when they call the gateway. A full key is shown once, when it is created."
      />
      <div className="form-stack">
        <RequireKeys keyCount={clients.data?.length ?? null} />
        <ClientKeys now={now} clients={clients} />
      </div>
    </div>
  );
}

function RequireKeys({ keyCount }: { keyCount: number | null }) {
  const api = useApi();
  const notify = useNotify();
  const settings = useResource(() => api.getSettings(), []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const required = settings.data?.require_client_keys ?? false;

  const change = async (checked: boolean): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateSettings({ require_client_keys: checked });
      settings.setData(() => updated);
      notify(checked ? "Apps now need a client key." : "Apps no longer need a client key.");
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section variant="panel" title="Require a key for apps" id="require-keys">
      {settings.status === "loading" && !settings.data ? <LoadingRows rows={1} label="Loading the setting" /> : null}
      {settings.status === "error" && !settings.data ? (
        <ErrorState error={settings.error} title="The setting did not load" onRetry={settings.reload} />
      ) : null}
      {settings.data ? (
        <>
          <Switch
            checked={required}
            disabled={saving}
            onChange={(checked) => void change(checked)}
            label="Apps must send a client key"
            description={
              <>
                When on, <span className="mono">POST /v1/decisions</span> and <span className="mono">GET /v1/models</span> return 401 for any request
                without a valid client key in <span className="mono">Authorization: Bearer …</span>. When off, anyone who can reach the
                gateway can call them. Saved as soon as you switch it.
              </>
            }
          />
          <p className="field-hint">{required ? <Flag tone="ok">Apps need a key</Flag> : <Flag tone="muted">Apps need no key</Flag>}</p>
          {required && keyCount === 0 ? (
            <Notice tone="warn" title="No client keys exist">
              Every app is refused until you create a key below and give it to the app.
            </Notice>
          ) : null}
          {error ? <ErrorState error={error} title="The setting was not saved" /> : null}
        </>
      ) : null}
    </Section>
  );
}

function ClientKeys({ now, clients }: { now: number; clients: Resource<ClientKey[]> }) {
  const api = useApi();
  const notify = useNotify();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [revealed, setRevealed] = useState<CreatedClientKey | null>(null);
  const [revoking, setRevoking] = useState<ClientKey | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<unknown>(null);

  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameError("Give the key a name, such as the app or person who will use it.");
      return;
    }
    setNameError(null);
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createClient(trimmed);
      setRevealed(created);
      setName("");
      clients.reload();
    } catch (caught) {
      setCreateError(caught);
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (): Promise<void> => {
    if (!revoking) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      await api.deleteClient(revoking.id);
      notify(`Revoked ${revoking.name}.`);
      setRevoking(null);
      clients.reload();
    } catch (caught) {
      setRevokeError(caught);
    } finally {
      setRevokeBusy(false);
    }
  };

  return (
    <>
      <Section
        variant="panel"
        title="Client keys"
        id="client-keys"
        meta="One key per app or person, so you can revoke one without touching the others."
      >
        <form className="key-create" onSubmit={(event) => void create(event)} noValidate>
          <TextField
            label="Name for a new key"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
            error={nameError ?? (createError ? describeError(createError) : null)}
            placeholder="Support triage bot"
            autoComplete="off"
          />
          <Button variant="primary" type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create key"}
          </Button>
        </form>

        {clients.status === "loading" && !clients.data ? <LoadingRows rows={2} label="Loading client keys" /> : null}
        {clients.status === "error" && !clients.data ? (
          <ErrorState error={clients.error} title="Client keys did not load" onRetry={clients.reload} />
        ) : null}
        {clients.data && clients.data.length === 0 ? (
          <EmptyState title="No client keys yet">
            Keys are only checked when apps need a key. Create one per app, so each can be revoked on its own.
          </EmptyState>
        ) : null}
        {clients.data && clients.data.length > 0 ? (
          <table className="sheet">
            <caption className="sr-only">Client keys, with the last four characters of each</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Key</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.data.map((client) => (
                <tr key={client.id}>
                  <th scope="row">{client.name}</th>
                  <td className="mono">…{client.key_last4}</td>
                  <td>{formatRelative(Date.parse(client.created_at), now)}</td>
                  <td>{client.last_used_at ? formatRelative(Date.parse(client.last_used_at), now) : <span className="muted">never</span>}</td>
                  <td className="num">
                    <Button variant="quiet" small onClick={() => setRevoking(client)}>
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>

      <Dialog
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title="Copy this key now"
        footer={
          <Button variant="primary" onClick={() => setRevealed(null)}>
            I have stored the key
          </Button>
        }
      >
        {revealed ? (
          <div className="key-reveal-body">
            <Notice tone="warn" title="Shown once">
              This is the only time the full key for <strong>{revealed.name}</strong> is shown. Afterwards the console keeps only its last four
              characters, <span className="mono">…{revealed.key_last4}</span>.
            </Notice>
            <div className="key-reveal">
              <code className="mono key-value" tabIndex={0} aria-label={`Client key for ${revealed.name}`}>
                {revealed.key}
              </code>
              <CopyButton text={revealed.key} label="Copy key" variant="secondary" />
            </div>
            <p className="field-hint">
              Give it to the caller as a bearer token, for example in <span className="mono">DG_CLIENT_KEY</span>. If it is lost, revoke it and
              create a new one.
            </p>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? `Revoke ${revoking.name}?` : "Revoke key?"}
        body={<p>Callers using this key will be refused from their next request. This cannot be undone; create a new key instead.</p>}
        confirmLabel="Revoke key"
        busy={revokeBusy}
        error={revokeError}
        onConfirm={() => void revoke()}
        onCancel={() => {
          setRevoking(null);
          setRevokeError(null);
        }}
      />
    </>
  );
}
