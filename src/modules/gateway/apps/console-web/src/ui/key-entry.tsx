// "Paste your key": saves a connection's key as a stored secret (PATCH key source "stored"). The health
// report says whether this gateway can store one. When it cannot, the paste route is warned about before
// the attempt, and the environment-variable route opens first. A refused paste carries the missing-secret
// code and is explained with the fix. The secret never comes back.

import { useState, type FormEvent } from "react";
import { useApi } from "../app/api-context";
import { isApiError } from "../api/errors";
import type { Provider } from "../api/types";
import { connectionTitle, suggestedEnvVar } from "../domain/connections";
import { ENV_PATTERN } from "../domain/connection-form";
import { isSecretMissing, pasteAdvice } from "../domain/secrets";
import { Button, TextField } from "./controls";
import { Notice, describeError } from "./feedback";
import { useNotify } from "./toaster";

type Mode = "paste" | "env";

export function KeyEntry({
  provider,
  onSaved,
  replacing = false,
  secretConfigured,
}: {
  provider: Provider;
  onSaved: (updated: Provider) => void;
  /** True when a key exists and this replaces it. */
  replacing?: boolean;
  /** From the health report. False means this gateway cannot store a pasted key; unknown (undefined) warns nothing. */
  secretConfigured?: boolean | null;
}) {
  const api = useApi();
  const notify = useNotify();
  const title = connectionTitle(provider.name, provider.kind);
  const advice = pasteAdvice(secretConfigured);
  // The route the owner picked. Until they pick one, the advice decides, so a late health report still applies.
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode: Mode = chosen ?? (advice.envFirst ? "env" : "paste");
  const [secret, setSecret] = useState("");
  const [envVar, setEnvVar] = useState(() => suggestedEnvVar(provider));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretMissing, setSecretMissing] = useState(false);
  const [envSaved, setEnvSaved] = useState<Provider | null>(null);

  const savePasted = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const value = secret.trim();
    if (value.length === 0) {
      setError(`Paste the ${title} key first.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateProvider(provider.id, { key: { source: "stored", value } });
      setSecret("");
      notify(`Saved the ${title} key. From now on only its last four characters are shown.`);
      onSaved(updated);
    } catch (caught) {
      if (isApiError(caught) && isSecretMissing(caught.code)) setSecretMissing(true);
      else setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveEnv = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const name = envVar.trim();
    if (!ENV_PATTERN.test(name)) {
      setError("Enter an environment variable name, such as OPENAI_API_KEY.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateProvider(provider.id, { key: { source: "env", env_var: name } });
      const present = updated.key.source === "env" && updated.key.present;
      notify(present ? `${title} now reads ${name}, which is set.` : `${title} now reads ${name}.`);
      setEnvSaved(present ? null : updated);
      onSaved(updated);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (mode === "env") {
    return (
      <form className="key-entry" onSubmit={(event) => void saveEnv(event)} noValidate>
        <div className="key-entry-row">
          <TextField
            label="Environment variable on the gateway host"
            value={envVar}
            onChange={(event) => {
              setEnvVar(event.target.value);
              setError(null);
            }}
            error={error}
            mono
            spellCheck={false}
            autoComplete="off"
            hint="The gateway reads this variable when it sends a request. The console never sees its value."
          />
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Use this variable"}
          </Button>
        </div>
        {envSaved ? (
          <Notice tone="warn" title={`${envVar.trim()} is not set yet`}>
            Set it in the environment the gateway runs with (for example <span className="mono">.env</span> next to compose.yaml) and restart the
            gateway. The provider shows Connected once the variable is set.
          </Notice>
        ) : null}
        <button type="button" className="link-button" onClick={() => setChosen("paste")}>
          Paste the key instead
        </button>
      </form>
    );
  }

  return (
    <form className="key-entry" onSubmit={(event) => void savePasted(event)} noValidate>
      {advice.warning && !secretMissing ? (
        <Notice tone="warn" title={advice.warning.title}>
          <p>{advice.warning.body}</p>
          <p>
            <button type="button" className="link-button" onClick={() => setChosen("env")}>
              Use an environment variable
            </button>
          </p>
        </Notice>
      ) : null}
      <div className="key-entry-row">
        <TextField
          label={replacing ? `Paste the new ${title} key` : `Paste your ${title} key`}
          type="password"
          value={secret}
          onChange={(event) => {
            setSecret(event.target.value);
            setError(null);
          }}
          error={error}
          mono
          spellCheck={false}
          autoComplete="off"
          hint="Stored encrypted by the gateway. It is never shown again; you will see only its last four characters."
        />
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : replacing ? "Replace key" : "Save key"}
        </Button>
      </div>
      {secretMissing ? (
        <Notice tone="warn" title="This gateway can't store keys yet">
          <p>
            Stored keys are encrypted with <span className="mono">GATEWAY_SECRET</span>, and the gateway was started without it. Set{" "}
            <span className="mono">GATEWAY_SECRET</span> to a long random value in its environment (for example in{" "}
            <span className="mono">.env</span>
            ), restart the gateway, and paste the key again. Keep that value stable: changing it makes stored keys unreadable.
          </p>
          <p>
            Or keep the key in an environment variable instead.{" "}
            <button type="button" className="link-button" onClick={() => setChosen("env")}>
              Use an environment variable
            </button>
          </p>
        </Notice>
      ) : advice.warning ? null : (
        <button type="button" className="link-button" onClick={() => setChosen("env")}>
          Keep the key in an environment variable instead
        </button>
      )}
    </form>
  );
}
