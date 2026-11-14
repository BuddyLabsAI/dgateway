import { useState, type FormEvent } from "react";
import { useApi } from "./api-context";
import { session } from "./session";
import { Button, TextField } from "../ui/controls";
import { BrandMark, Wordmark } from "../ui/brand";
import { Icon } from "../ui/icons";
import { Notice, describeError } from "../ui/feedback";
import { isApiError } from "../api/errors";

function signInMessage(error: unknown): string {
  if (isApiError(error) && error.status === 401) {
    return "That token was rejected. Check ADMIN_TOKEN in the environment the gateway runs with.";
  }
  if (isApiError(error) && error.status === 0) return describeError(error);
  return describeError(error);
}

export function SignIn({ notice, mock }: { notice: string | null; mock: boolean }) {
  const api = useApi();
  const [token, setToken] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const candidate = token.trim();
    if (candidate.length === 0) {
      setError("Enter the admin token. It is the ADMIN_TOKEN value the gateway was started with.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.checkToken(candidate);
      session.signIn(candidate);
    } catch (caught) {
      setError(signInMessage(caught));
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="signin-brand">
          <BrandMark size={36} />
          <Wordmark />
        </div>
        <h1>Sign in to the console</h1>
        <p className="signin-lede">
          Enter the admin token. The console keeps it in this tab&rsquo;s session storage until you sign out or close the tab.
        </p>
        {notice ? <Notice tone="warn">{notice}</Notice> : null}
        <form className="signin-form" onSubmit={(event) => void submit(event)} noValidate>
          <TextField
            label="Admin token"
            name="admin-token"
            type={shown ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            error={error}
            mono
            accessory={
              <button type="button" className="field-toggle" onClick={() => setShown((current) => !current)} aria-pressed={shown}>
                <Icon name={shown ? "eye-off" : "eye"} size={14} />
                <span>{shown ? "Hide" : "Show"}</span>
              </button>
            }
          />
          <div className="signin-actions">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Checking the token…" : "Sign in"}
            </Button>
          </div>
        </form>
        {mock ? (
          <p className="signin-foot">Mock mode is on. Any non-empty token works, and nothing is sent to a gateway.</p>
        ) : (
          <p className="signin-foot">The token is checked against GET /admin/api/health before the console opens.</p>
        )}
      </div>
    </div>
  );
}
