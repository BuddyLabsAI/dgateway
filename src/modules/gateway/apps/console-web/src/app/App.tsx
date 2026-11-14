import { useEffect } from "react";
import { useApi } from "./api-context";
import { ErrorBoundary } from "./ErrorBoundary";
import { SignIn } from "./SignIn";
import { SCREENS, SCREEN_LABELS, hrefFor, useLocation, type Location, type ScreenId } from "./router";
import { session, useSession } from "./session";
import { useResource, useVisibleInterval } from "./hooks";
import { gatewayStatus, readinessFromHealth, type GatewayStatus } from "../domain/overview";
import { formatUptime } from "../domain/format";
import type { StationStatus } from "../domain/health";
import { BrandMark, Wordmark } from "../ui/brand";
import { Icon, type IconName } from "../ui/icons";
import { StationMark } from "../ui/status";
import { OverviewScreen } from "../screens/Overview";
import { ModelsScreen } from "../screens/Models";
import { ModelDetailScreen } from "../screens/ModelDetail";
import { AddModelScreen } from "../screens/AddModel";
import { AddProviderScreen } from "../screens/AddProvider";
import { ConnectionsScreen } from "../screens/Connections";
import { TryItScreen } from "../screens/TryIt";
import { RequestsScreen } from "../screens/Requests";
import { KeysScreen } from "../screens/Keys";
import { SettingsScreen } from "../screens/Settings";

const SCREEN_ICONS: Record<ScreenId, IconName> = {
  overview: "overview",
  models: "routes",
  providers: "providers",
  try: "playground",
  requests: "logs",
  keys: "key",
  settings: "settings",
};

const STATUS_COPY: Record<GatewayStatus, { status: StationStatus; text: string }> = {
  healthy: { status: "ok", text: "Gateway healthy" },
  attention: { status: "degraded", text: "A provider needs a key" },
  unreachable: { status: "failing", text: "Gateway unreachable" },
};

export function App({ mock }: { mock: boolean }) {
  const { token, notice } = useSession();
  if (!token) return <SignIn notice={notice} mock={mock} />;
  return <Console mock={mock} />;
}

function Console({ mock }: { mock: boolean }) {
  const api = useApi();
  const location = useLocation();
  const health = useResource(() => api.health(), []);
  useVisibleInterval(health.reload, 30_000);

  const readiness = readinessFromHealth(health.data?.providers ?? []);
  const status = gatewayStatus(health.status === "error" ? false : health.data ? true : null, readiness);
  const copy = STATUS_COPY[status];

  useEffect(() => {
    document.title = `${SCREEN_LABELS[location.screen]} · dgateway`;
  }, [location.screen]);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="rail" aria-label="Console">
        <a className="brand" href={hrefFor("overview")} aria-label="dgateway, overview">
          <BrandMark size={28} />
          <span className="brand-text">
            <Wordmark />
            <span className="brand-sub">Console</span>
          </span>
        </a>
        <nav aria-label="Screens" className="nav">
          <ul>
            {SCREENS.map((screen) => {
              const current = location.screen === screen;
              return (
                <li key={screen}>
                  <a href={hrefFor(screen)} className="nav-link" aria-current={current ? "page" : undefined}>
                    <Icon name={SCREEN_ICONS[screen]} size={16} className="nav-icon" />
                    <span>{SCREEN_LABELS[screen]}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="rail-foot">
          <div className={`gateway-status gateway-status--${copy.status}`} role="status" aria-live="polite">
            <p className="gateway-line">
              <StationMark status={copy.status} size={12} />
              <span>{copy.text}</span>
            </p>
            {health.data ? (
              <p className="gateway-meta mono">
                v{health.data.version} · up {formatUptime(health.data.uptime_s)}
              </p>
            ) : null}
          </div>
          {mock ? (
            <p className="mock-tag">
              <span className="mock-tag-label">Mock data</span>
              <span>Sample data. Nothing is sent to a gateway.</span>
            </p>
          ) : null}
          <button type="button" className="nav-link nav-link--button" onClick={() => session.signOut()}>
            <Icon name="sign-out" size={16} className="nav-icon" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        <ErrorBoundary key={`${location.screen}:${location.param ?? ""}:${location.query.toString()}`}>
          <ScreenView location={location} />
        </ErrorBoundary>
      </main>
    </div>
  );
}

function ScreenView({ location }: { location: Location }) {
  switch (location.screen) {
    case "overview":
      return <OverviewScreen />;
    case "models":
      if (location.param === "new") {
        return <AddModelScreen connectionId={location.query.get("connection")} upstream={location.query.get("upstream")} />;
      }
      if (location.param) return <ModelDetailScreen idOrName={location.param} focusStep={location.query.get("step")} />;
      return <ModelsScreen />;
    case "providers":
      if (location.param === "new") return <AddProviderScreen presetId={location.query.get("preset")} />;
      return <ConnectionsScreen focusId={location.param} />;
    case "try":
      return <TryItScreen initialModel={location.query.get("model") ?? ""} />;
    case "requests":
      return <RequestsScreen initialModel={location.query.get("model") ?? ""} initialConnection={location.query.get("connection") ?? ""} />;
    case "keys":
      return <KeysScreen />;
    case "settings":
      return <SettingsScreen />;
  }
}
