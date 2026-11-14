import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/screens.css";
import "./styles/flows.css";

import { createRoot } from "react-dom/client";
import { ApiProvider } from "./app/api-context";
import { App } from "./app/App";
import { createConsoleApi } from "./api/create-api";
import { mockMode } from "./app/mode";
import { session } from "./app/session";
import { ToastProvider } from "./ui/toaster";

const mock = mockMode(window.location.search);
if (mock && !session.getToken()) session.signIn("mock-session");

const api = await createConsoleApi({
  mock: mock !== null,
  scenario: mock?.scenario,
  storesKeys: mock?.storesKeys,
  listsModels: mock?.listsModels,
  getToken: () => session.getToken(),
  onUnauthorized: () => session.signOut("Your session ended, or the token changed. Sign in again."),
});

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <ApiProvider api={api}>
    <ToastProvider>
      <App mock={mock !== null} />
    </ToastProvider>
  </ApiProvider>,
);
